/**
 * The supervisor over the fake Peeps and the fake jail (e4 plan v3 §3.2 `load-supervisor`).
 * Every assertion is a count or an order, never a duration.
 */
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { appendFileSync } from "node:fs";
import path from "node:path";
import type { Dial } from "../src/load/gate/proxy";
import type { LoadEvent, LoadResult } from "../src/load/supervisor";
import { respond as fixtureRespond } from "./support/e4-fixtures";
import type { PortScript } from "./support/fake-control-port";
import { fakeJail } from "./support/fake-jail";
import { FAST, invariants, rig, smallPlan, WORKLOAD_PATH, type Rig, type RigOptions } from "./support/run-supervisor";

const SCRIPTED = path.resolve(__dirname, "fixtures/load-engine/e4/scripted-executor.js");
const scripted = (env: Record<string, string>): RigOptions["jail"] => ({ command: [process.execPath, SCRIPTED], env });

function why(r: Rig, res: LoadResult): string {
  return JSON.stringify({ status: res.status, reason: res.reason, failures: res.failures.slice(0, 3), checking: res.checking, stderr: r.jails.made[0]?.stderr().slice(-2000) });
}

const onPhase = (phase: "checking" | "measurement", act: (r: Rig) => void) => (e: LoadEvent, r: Rig) => {
  if (e.type === "phase" && e.phase === phase) act(r);
};

describe("load supervisor", { concurrency: 4 }, () => {
  test("a run end to end: Checking passes, measurement completes, the gate closes, the stream ends", async (t) => {
    const r = await rig(t);
    const res = await r.result;
    assert.equal(res.status, "completed", why(r, res));
    assert.equal(res.checking.turns, 2);
    assert.equal(res.checking.success, 2);
    assert.deepEqual(res.checking.responded, [1, 1]);
    assert.ok(res.measurement.success >= 1);
    assert.equal(res.measurement.failure, 0);
    assert.equal(res.gateClosed, true);
    assert.deepEqual(res.final, { watermark: res.journal!.debited });
    assert.equal(res.journal!.debited, r.sink.arrivals.length, "every debit reached the target");
    assert.ok(r.port.renewals.some((x) => x.fields.state === "running"));
    const order = r.events.map((e) => e.type);
    assert.ok(order.indexOf("terminate") < order.indexOf("gate_closed"));
    assert.equal(res.cleanup, "clean");
    const batches = r.port.batches() as { kind: string }[];
    assert.equal(batches.at(-1)!.kind, "final");
    assert.ok(batches.some((b) => b.kind === "summary"));
    invariants(r, res);
  });

  // ---------------------------------------------------------------- termination

  test("a silent Peeps: the lease runs out, renewing stops, and nothing is debited after", async (t) => {
    const r = await rig(t, { exportName: "three", plan: smallPlan({ exportName: "three", durationMs: 20_000, perJourneyMax: 3 }), script: { silentAfterMs: 2500 } });
    const res = await r.result;
    assert.equal(res.status, "lease_lost", why(r, res));
    assert.equal(res.renewals.afterTerminate, 0);
    invariants(r, res);
  });

  test("the wall clock alone jumps past the lease: lease lost", async (t) => {
    const r = await rig(t, { plan: smallPlan({ exportName: "get", durationMs: 20_000 }), observer: onPhase("measurement", (x) => (x.seam.wallShift = 600_000)) });
    const res = await r.result;
    assert.equal(res.status, "lease_lost", why(r, res));
    assert.equal(res.measurement.failure, 0);
    invariants(r, res);
  });

  test("the monotonic clock alone jumps past the lease: lease lost", async (t) => {
    const r = await rig(t, { plan: smallPlan({ exportName: "get", durationMs: 20_000 }), observer: onPhase("measurement", (x) => (x.seam.monoShift = 600_000)) });
    const res = await r.result;
    assert.equal(res.status, "lease_lost", why(r, res));
    invariants(r, res);
  });

  test("the monotonic clock steps back while Peeps goes silent: the wall clock still ends the lease", async (t) => {
    const script: PortScript = {};
    const r = await rig(t, {
      plan: smallPlan({ exportName: "get", durationMs: 20_000 }),
      script,
      observer: onPhase("measurement", (x) => {
        script.silentAfterMs = 0;
        // Back far enough that the monotonic clock alone would not end the 3 s lease within the run,
        // never below zero: CLOCK_MONOTONIC counts from boot, and a freshly booted runner is only
        // minutes old (-10 min read below zero on CI, which ended the run executor_exit instead).
        x.seam.monoShift = -Math.min(60_000, Number(process.hrtime.bigint()) / 1e6 - 1);
      }),
    });
    const res = await r.result;
    assert.equal(res.status, "lease_lost", why(r, res));
    invariants(r, res);
  });

  test("Peeps answers lease lost: the run ends lease_lost and stops renewing", async (t) => {
    const r = await rig(t, { plan: smallPlan({ exportName: "get", durationMs: 20_000 }), script: { lostAfterMs: 3000 } });
    const res = await r.result;
    assert.equal(res.status, "lease_lost", why(r, res));
    assert.equal(res.renewals.afterTerminate, 0);
    invariants(r, res);
  });

  test("a hung renew: its retries carry the same bytes, no later seq is sent, and the lease runs out", async (t) => {
    const r = await rig(t, { plan: smallPlan({ exportName: "get", durationMs: 20_000 }), script: { hangSeq: 3 } });
    const res = await r.result;
    assert.equal(res.status, "lease_lost", why(r, res));
    const third = r.port.renewals.filter((x) => x.seq === 3);
    assert.ok(third.length >= 2, "retried");
    assert.equal(new Set(third.map((x) => x.body)).size, 1, "identical bytes");
    assert.equal(r.port.renewals.filter((x) => x.seq > 3).length, 0);
    invariants(r, res);
  });

  test("the run's hard end: the run ends with no debit after it, never completed", async (t) => {
    const r = await rig(t, { plan: smallPlan({ exportName: "get", durationMs: 30_000 }), setup: { maxRunMs: 6_000 } });
    const res = await r.result;
    assert.ok(res.reason === "run_end" || res.reason === "lease_lost", why(r, res));
    invariants(r, res);
  });

  test("a turn still busy at the grace end is closed there: completed, with that turn unanswered", async (t) => {
    let scripts = 0;
    const r = await rig(t, {
      // The third /script is the measured turn due at 2 s: its deadline (2 s + 4.5 s) is well past the grace end (3 s + 1.5 s).
      plan: smallPlan({ exportName: "script", users: 1, durationMs: 3000, perJourneyMax: 3 }),
      respond: (a, res) => {
        if (new URL(a.url, "https://x").pathname !== "/script") return fixtureRespond(a, res);
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ step: ++scripts === 3 ? "hang" : "done" }));
      },
    });
    const res = await r.result;
    assert.equal(res.status, "completed", why(r, res));
    assert.equal(res.measurement.started - (res.measurement.success + res.measurement.failure + res.measurement.timeout + res.measurement.cancelled), 1, "one turn had no outcome");
    invariants(r, res);
  });

  // ---------------------------------------------------------------- stops

  test("a graceful stop in measurement: no new turn, the busy ones finish, stopped, renewals drain", async (t) => {
    const r = await rig(t, { plan: smallPlan({ exportName: "get", durationMs: 30_000 }), script: { stopAfterMs: 4_000 } });
    const res = await r.result;
    assert.equal(res.status, "stopped", why(r, res));
    const stopAt = r.events.findIndex((e) => e.type === "renewal" && r.port.renewals.length > 0);
    assert.ok(stopAt >= 0);
    invariants(r, res);
  });

  test("Stop now while the lease is live: stopped at once", async (t) => {
    const r = await rig(t, { plan: smallPlan({ exportName: "get", durationMs: 30_000 }), script: { stopAfterMs: 4_000, stopMode: "now" } });
    const res = await r.result;
    assert.equal(res.status, "stopped", why(r, res));
    invariants(r, res);
  });

  test("a graceful stop before measurement: the run does not start", async (t) => {
    const r = await rig(t, { plan: smallPlan({ exportName: "get", durationMs: 30_000 }), script: { stopAfterMs: 0 }, jail: { installMs: 2_000 } });
    const res = await r.result;
    assert.equal(res.status, "didnt_start", why(r, res));
    assert.equal(res.checking.turns, 0);
    assert.equal(res.measurement.started, 0);
    assert.deepEqual(r.jails.made[0]!.tickets.map((x) => x.kind), ["start"], "no launch ticket after the stop");
    invariants(r, res);
  });

  test("cancellation: cancelled, and renewals go on as draining until the gate settles", async (t) => {
    const ac = new AbortController();
    let release!: () => void;
    const parked = new Promise<void>((resolve) => (release = resolve));
    let parking = false;
    const r = await rig(t, {
      signal: ac.signal,
      plan: smallPlan({ exportName: "get", durationMs: 30_000 }),
      // Once measurement runs, a dial parks and ignores its abort: the gate cannot settle until it is released.
      dial: (inner: Dial): Dial => async (o, signal, pin, ready) => {
        if (!parking) return inner(o, signal, pin, ready);
        ac.abort();
        await parked;
        return inner(o, new AbortController().signal, pin, ready);
      },
      observer: (e, x) => {
        if (e.type === "phase" && e.phase === "measurement") parking = true;
        if (e.type === "terminate") void waitDraining(x).then(release);
      },
    });
    const res = await r.result;
    assert.equal(res.status, "cancelled", why(r, res));
    assert.ok(res.renewals.afterTerminate >= 1, "renewed while draining");
    assert.ok(r.port.renewals.some((x) => x.fields.state === "draining"));
    assert.equal(res.gateClosed, true);
    assert.deepEqual(res.final, { watermark: res.journal!.debited });
    invariants(r, res);
  });

  test("a gate that never settles: no gate_closed, and the final watermark is missing past the deadline", async (t) => {
    const ac = new AbortController();
    let parking = false;
    const r = await rig(t, {
      signal: ac.signal,
      plan: smallPlan({ exportName: "get", durationMs: 30_000 }),
      dial: (inner: Dial): Dial => async (o, signal, pin, ready) => {
        if (!parking) return inner(o, signal, pin, ready);
        ac.abort();
        return new Promise<never>(() => undefined);
      },
      observer: onPhase("measurement", () => (parking = true)),
    });
    const res = await r.result;
    assert.equal(res.status, "cancelled", why(r, res));
    assert.equal(res.gateClosed, false);
    assert.equal(res.final, "missing");
    assert.equal(r.events.filter((e) => e.type === "gate_closed").length, 0);
    invariants(r, res);
  });

  // ---------------------------------------------------------------- malformed replies

  test("a renew reply with only a bad ceiling keeps the old grant, which runs out: lease lost", async (t) => {
    const r = await rig(t, { plan: smallPlan({ exportName: "get", durationMs: 20_000 }), script: { mangle: (x, seq) => (seq >= 2 ? { ...x, ceiling: "lots" } : x) } });
    const res = await r.result;
    assert.equal(res.status, "lease_lost", why(r, res));
    assert.ok(r.events.some((e) => e.type === "renewal" && e.decision === "rejected"));
    invariants(r, res);
  });

  test("an unreadable stop fails closed: lease lost", async (t) => {
    const r = await rig(t, { plan: smallPlan({ exportName: "get", durationMs: 20_000 }), script: { mangle: (x, seq) => (seq >= 3 ? { ...x, stop: { mode: "later" } } : x) } });
    const res = await r.result;
    assert.equal(res.status, "lease_lost", why(r, res));
    invariants(r, res);
  });

  test("replies for another claim are ignored: nothing is applied and the lease runs out", async (t) => {
    const r = await rig(t, { plan: smallPlan({ exportName: "get", durationMs: 20_000 }), script: { mangle: (x, seq) => (seq >= 2 ? { ...x, claimId: "someone-else" } : x) } });
    const res = await r.result;
    assert.equal(res.status, "lease_lost", why(r, res));
    assert.ok(r.events.some((e) => e.type === "renewal" && e.decision === "ignored"));
    // Paced: an answer that comes back at once is not asked for again in a tight loop.
    assert.ok(r.port.renewals.length <= 100, `renew was sent ${r.port.renewals.length} times`);
    invariants(r, res);
  });

  test("a renew that fails at once is retried at a pace, not in a tight loop, until the lease runs out", async (t) => {
    let calls = 0;
    const r = await rig(t, {
      plan: smallPlan({ exportName: "get", durationMs: 20_000 }),
      observer: onPhase("measurement", (x) => {
        x.port.renew = async () => {
          calls += 1;
          throw new Error("connect ECONNREFUSED");
        };
      }),
    });
    const res = await r.result;
    assert.equal(res.status, "lease_lost", why(r, res));
    assert.ok(calls >= 2, "retried");
    assert.ok(calls <= 100, `renew was sent ${calls} times`);
    invariants(r, res);
  });

  test("immediate ignored renewals leave the event loop live for cancellation", async (t) => {
    const soft = new AbortController();
    const hard = new AbortController();
    let timerRan = false;
    let ignored = 0;
    let timerRanAtTerminate = false;
    const r = await rig(t, {
      signal: soft.signal,
      hardSignal: hard.signal,
      script: { mangle: (reply) => ({ ...reply, claimId: "unrelated" }) },
      observer: (e) => {
        if (e.type === "terminate") timerRanAtTerminate = timerRan;
        if (e.type !== "renewal" || e.decision !== "ignored") return;
        if (++ignored === 1) setTimeout(() => {
          timerRan = true;
          hard.abort();
        }, 0);
        if (ignored === 10) {
          // Bound the regression run without waiting for a lease or accumulating attempts.
          soft.abort();
          hard.abort();
        }
      },
    });
    const res = await r.result;
    assert.equal(res.status, "cancelled", why(r, res));
    assert.ok(timerRanAtTerminate, "the cancellation timer ran while the retry was pending");
    assert.equal(ignored, 1);
  });

  // ---------------------------------------------------------------- startup

  test("a run cancelled before it starts: cancelled, nothing probed, installed or claimed", async (t) => {
    let probes = 0;
    let installs = 0;
    const r = await rig(t, {
      signal: AbortSignal.abort(),
      seams: {
        probe: async () => { probes++; return { passed: true, failures: [], seen: null }; },
        preinstall: async () => { installs++; throw new Error("unexpected install"); },
      },
    });
    const res = await r.result;
    assert.equal(res.status, "cancelled", why(r, res));
    assert.equal(probes, 0);
    assert.equal(installs, 0);
    assert.equal(r.port.claims.length, 0);
    assert.equal(res.cleanup, "not_started");
  });

  test("a failed fence probe: nothing is claimed", async (t) => {
    const r = await rig(t, { seams: { probe: async () => ({ passed: false, failures: ["egress"], seen: null }) } });
    const res = await r.result;
    assert.equal(res.status, "didnt_start");
    assert.equal(res.reason, "fence_unverified");
    assert.equal(r.port.claims.length, 0);
    assert.equal(r.jails.made.length, 0);
  });

  test("a refused claim: no jail starts", async (t) => {
    const r = await rig(t, { script: { claimRefused: "matrix" } });
    const res = await r.result;
    assert.equal(res.status, "didnt_start");
    assert.equal(res.reason, "claim_matrix");
    assert.equal(r.jails.made.length, 0);
    assert.equal(r.port.renewals.length, 0);
  });

  test("the checkout differs from what Peeps expects: the claim is refused binding", async (t) => {
    const r = await rig(t, { afterBinding: (ws) => appendFileSync(path.join(ws, "journeys.ts"), "\n// changed\n") });
    const res = await r.result;
    assert.equal(res.reason, "claim_binding", why(r, res));
    assert.equal(r.jails.made.length, 0);
  });

  test("the workload changes between the claim and prepare: checkout_changed, no jail", async (t) => {
    const r = await rig(t, {
      observer: (e, x) => {
        if (e.type === "claimed") appendFileSync(path.join(x.ws, WORKLOAD_PATH), "# edited\n");
      },
    });
    const res = await r.result;
    assert.equal(res.status, "didnt_start");
    assert.equal(res.reason, "checkout_changed", why(r, res));
    assert.equal(r.jails.made.length, 0);
    assert.equal(res.renewals.afterTerminate, 0);
  });

  test("the lease runs out while the jail starts: no ticket is minted, lease lost", async (t) => {
    const r = await rig(t, { script: { silentAfterMs: 0 }, jail: { readyDelayMs: 6_000 } });
    const res = await r.result;
    assert.equal(res.status, "lease_lost", why(r, res));
    assert.equal(r.jails.made[0]?.tickets.length ?? 0, 0, "no ticket after the lease ran out");
    assert.equal(r.sink.arrivals.length, 0);
  });

  test("the lease runs out during the install: no launch ticket", async (t) => {
    const r = await rig(t, { script: { silentAfterMs: 0 }, jail: { installMs: 6_000 } });
    const res = await r.result;
    assert.equal(res.status, "lease_lost", why(r, res));
    assert.deepEqual(r.jails.made[0]!.tickets.map((x) => x.kind), ["start"]);
  });

  test("the control channel closes during startup: the run does not start", async (t) => {
    const r = await rig(t, { jail: { eofAfterReadyMs: 0, installMs: 500 } });
    const res = await r.result;
    assert.equal(res.status, "failed", why(r, res));
    assert.equal(r.sink.arrivals.length, 0);
  });

  test("an executor that does not load in time: loaded_timeout", async (t) => {
    const r = await rig(t, { jail: scripted({ PEEPS_SCRIPT: "mute" }), seams: { constants: { loadedMs: 1500 } as never } });
    const res = await r.result;
    assert.equal(res.reason, "loaded_timeout", why(r, res));
  });

  test("a fatal at load: didn't start, with the message sanitized", async (t) => {
    const r = await rig(t, { jail: scripted({ PEEPS_SCRIPT: "fatal" }) });
    const res = await r.result;
    assert.equal(res.status, "didnt_start");
    assert.equal(res.reason, "executor_journey", why(r, res));
    assert.equal(res.failures.length, 1);
    assert.doesNotMatch(res.failures[0]!.message, /::/);
  });

  // ---------------------------------------------------------------- Checking is a barrier

  for (const clock of ["wall", "monotonic"] as const) {
    test(`Checking cuts a verified dial at the turn deadline when only the ${clock} clock expires`, async (t) => {
      let shifted = false;
      const r = await rig(t, {
        jail: scripted({}),
        plan: smallPlan({ exportName: "get", users: 1 }),
        setup: { ttlMs: 6000 },
        seams: { constants: { ...FAST, checkingDeadlineMs: 2000 } },
        dial: (inner) => async (...args) => {
          const upstream = await inner(...args);
          if (!shifted) {
            shifted = true;
            if (clock === "wall") r.seam.wallShift = 2500;
            else r.seam.monoShift = 2500;
          }
          return upstream;
        },
      });
      const res = await r.result;
      assert.equal(res.reason, "checking_failed", why(r, res));
      assert.equal(res.journal!.cut.turn_deadline, 1);
      assert.deepEqual(res.handoffs!.unattempted, [1]);
      assert.equal(r.sink.stats.requestBytes, 0);
    });
  }

  test("Checking: turns that report success but sent nothing do not pass", async (t) => {
    const r = await rig(t, { jail: scripted({ PEEPS_SCRIPT: "silent" }) });
    const res = await r.result;
    assert.equal(res.status, "didnt_start");
    assert.equal(res.reason, "checking_failed", why(r, res));
    assert.equal(res.checking.success, 2);
    assert.deepEqual(res.checking.responded, [0, 0]);
    assert.equal(res.measurement.started, 0);
  });

  test("Checking: a journey whose requests the gate refuses does not pass", async (t) => {
    const r = await rig(t, { exportName: "notAllowed", plan: smallPlan({ exportName: "notAllowed" }) });
    const res = await r.result;
    assert.equal(res.reason, "checking_failed", why(r, res));
    assert.equal(r.sink.arrivals.length, 0);
    assert.equal(res.measurement.started, 0);
  });

  test("Checking: a failing journey does not pass", async (t) => {
    const r = await rig(t, { exportName: "throwsUnreadable", plan: smallPlan({ exportName: "throwsUnreadable" }) });
    const res = await r.result;
    assert.equal(res.reason, "checking_failed", why(r, res));
    assert.equal(res.checking.failure, 2);
  });

  test("a scripted executor that makes its own request passes Checking and completes", async (t) => {
    const r = await rig(t, { jail: scripted({ PEEPS_SCRIPT: "request" }) });
    const res = await r.result;
    assert.equal(res.status, "completed", why(r, res));
    assert.equal(res.playwright, "0.0.0-scripted");
    invariants(r, res);
  });

  // ---------------------------------------------------------------- executor misbehaviour

  test("duplicate outcomes are counted and change nothing", async (t) => {
    const r = await rig(t, { jail: scripted({ PEEPS_SCRIPT: "request", PEEPS_DUP: "1" }) });
    const res = await r.result;
    assert.equal(res.status, "completed", why(r, res));
    assert.equal(res.duplicateOutcomes, res.checking.turns + res.measurement.started);
    invariants(r, res);
  });

  test("the executor exits mid-run: executor_exit", async (t) => {
    const r = await rig(t, { plan: smallPlan({ exportName: "get", durationMs: 20_000 }), jail: scripted({ PEEPS_SCRIPT: "request", PEEPS_EXIT_AFTER: "4" }) });
    const res = await r.result;
    assert.equal(res.reason, "executor_exit", why(r, res));
    assert.equal(res.status, "failed");
    invariants(r, res);
  });

  test("a frame only init may send: executor_protocol", async (t) => {
    const r = await rig(t, { plan: smallPlan({ exportName: "get", durationMs: 20_000 }), jail: scripted({ PEEPS_SCRIPT: "request", PEEPS_BAD_AFTER: "3" }) });
    const res = await r.result;
    assert.equal(res.reason, "executor_protocol", why(r, res));
    invariants(r, res);
  });

  test("an oversized frame: executor_protocol", async (t) => {
    const r = await rig(t, { plan: smallPlan({ exportName: "get", durationMs: 20_000 }), jail: scripted({ PEEPS_SCRIPT: "request", PEEPS_BIG_AFTER: "3" }) });
    const res = await r.result;
    assert.equal(res.reason, "executor_protocol", why(r, res));
    invariants(r, res);
  });

  test("an executor that ignores cancel: executor_unresponsive after the turn's deadline and grace", async (t) => {
    const r = await rig(t, { plan: smallPlan({ exportName: "get", durationMs: 20_000 }), jail: scripted({ PEEPS_SCRIPT: "request", PEEPS_IGNORE_AFTER: "3" }) });
    const res = await r.result;
    assert.equal(res.reason, "executor_unresponsive", why(r, res));
    invariants(r, res);
  });

  // ---------------------------------------------------------------- evidence

  test("lost acks: the batch is sent again with the same bytes, and the stream still ends", async (t) => {
    const r = await rig(t, { script: { ackLost: [1, 2, 3] } });
    const res = await r.result;
    assert.equal(res.status, "completed", why(r, res));
    assert.deepEqual(res.final, { watermark: res.journal!.debited });
    for (const seq of [1, 2, 3]) {
      const sent = r.port.posted.filter((p) => p.seq === seq);
      if (sent.length === 0) continue;
      assert.ok(sent.length >= 2, `seq ${seq} sent again`);
      assert.equal(new Set(sent.map((p) => p.payloadHash + p.batch)).size, 1, `seq ${seq} identical`);
    }
    const seqs = r.port.batches().length;
    assert.equal(seqs, Math.max(...r.port.posted.map((p) => p.seq)));
  });

  test("a conflicting replay stops the stream: nothing more is sent and the final is missing", async (t) => {
    const r = await rig(t, { script: { conflictSeq: 1 } });
    const res = await r.result;
    assert.equal(res.status, "completed", why(r, res));
    assert.equal(res.final, "missing");
    assert.deepEqual([...new Set(r.port.posted.map((p) => p.seq))], [1]);
  });

  test("an events answer that does not decode is no answer: the batch is sent again and the stream goes on", async (t) => {
    let garbled = 0;
    const r = await rig(t, {
      observer: onPhase("checking", (x) => {
        const events = x.port.events.bind(x.port);
        x.port.events = async (...args: Parameters<typeof events>) => {
          const answer = await events(...args);
          return garbled++ < 2 ? null : answer;
        };
      }),
    });
    const res = await r.result;
    assert.equal(res.status, "completed", why(r, res));
    assert.equal(garbled > 2, true, "the stream went on after the undecodable answers");
    assert.notEqual(res.final, "missing");
  });

  test("a blocked events endpoint: the run still ends within its reporting deadline, final missing", async (t) => {
    const r = await rig(t, { script: { eventsBlocked: true } });
    const res = await r.result;
    assert.equal(res.status, "completed", why(r, res));
    assert.equal(res.gateClosed, true);
    assert.equal(res.final, "missing");
  });

  test("a jail that cannot start: startup_failed, and its reason is in the failures", async (t) => {
    const r = await rig(t, { launch: async () => { throw new Error("load jail: no systemd here"); } });
    const res = await r.result;
    assert.equal(res.reason, "startup_failed", why(r, res));
    assert.deepEqual(res.failures, [{ message: "load jail: no systemd here", location: null }]);
  });

  test("a hard cancel (SIGTERM) mid-measurement: cancelled, no draining renewal, the gate closes and the final goes, cleanup clean", async (t) => {
    const soft = new AbortController();
    const hard = new AbortController();
    const r = await rig(t, {
      signal: soft.signal,
      hardSignal: hard.signal,
      plan: smallPlan({ exportName: "get", durationMs: 30_000 }),
      observer: (e) => {
        if (e.type === "phase" && e.phase === "measurement") setTimeout(() => {
          soft.abort();
          hard.abort();
        }, 1_000);
      },
    });
    const res = await r.result;
    assert.equal(res.status, "cancelled", JSON.stringify({ reason: res.reason }));
    assert.equal(res.renewals.afterTerminate, 0, "no draining after a hard cancel");
    assert.equal(r.port.renewals.filter((x) => x.fields.state === "draining").length, 0);
    assert.equal(res.cleanup, "clean");
    assert.equal(res.gateClosed, true);
    assert.notEqual(res.final, "missing");
    invariants(r, res);
  });

  test("a hard cancel while the gate cannot settle: no draining renewal, where a soft cancel sends them", async (t) => {
    const soft = new AbortController();
    const hard = new AbortController();
    let parking = false;
    const r = await rig(t, {
      signal: soft.signal,
      hardSignal: hard.signal,
      plan: smallPlan({ exportName: "get", durationMs: 30_000 }),
      // A dial that ignores its abort: the gate cannot settle, so a soft cancel would renew as
      // draining to the reporting deadline (the two cancellation cases above).
      dial: (inner: Dial): Dial => async (o, signal, pin, ready) => {
        if (!parking) return inner(o, signal, pin, ready);
        soft.abort();
        hard.abort();
        return new Promise<never>(() => undefined);
      },
      observer: onPhase("measurement", () => (parking = true)),
    });
    const res = await r.result;
    assert.equal(res.status, "cancelled", why(r, res));
    assert.equal(res.renewals.afterTerminate, 0, "no draining after a hard cancel");
    assert.equal(r.port.renewals.filter((x) => x.fields.state === "draining").length, 0);
    assert.equal(res.gateClosed, false);
    invariants(r, res);
  });

  test("a hard cancel bounds the result even when jail cleanup is still pending", async (t) => {
    const hard = new AbortController();
    let release!: () => void;
    const cleanup = new Promise<void>((resolve) => { release = resolve; });
    let cleanupStarted = false;
    let fallback: NodeJS.Timeout | undefined;
    const r = await rig(t, {
      hardSignal: hard.signal,
      seams: {
        constants: { ...FAST, hardReportingMs: 100 },
        launch: async (spec, options, signal) => {
          const handle = await fakeJail().launch(spec, options, signal);
          return { ...handle, end: async () => {
            const result = handle.end();
            cleanupStarted = true;
            fallback ??= setTimeout(release, 1000);
            await cleanup;
            return result;
          } };
        },
      },
      observer: onPhase("measurement", () => hard.abort()),
    });
    try {
      const res = await r.result;
      assert.equal(res.status, "cancelled", why(r, res));
      assert.ok(cleanupStarted, "termination requested jail cleanup");
      assert.equal(res.cleanup, "dirty", "the run reported before the held cleanup completed");
    } finally {
      clearTimeout(fallback);
      release();
    }
  });

  test("a hard cancel during a soft cancel's reporting cuts the reporting short", async (t) => {
    const soft = new AbortController();
    const hard = new AbortController();
    let hardAt = 0;
    const r = await rig(t, {
      signal: soft.signal,
      hardSignal: hard.signal,
      plan: smallPlan({ exportName: "get", durationMs: 30_000 }),
      // Evidence never gets through, so only the deadline ends the reporting: a minute, unless cut.
      script: { eventsBlocked: true },
      seams: { constants: { ...FAST, reportingMs: 60_000 } },
      observer: (e) => {
        if (e.type === "phase" && e.phase === "measurement") setTimeout(() => soft.abort(), 500);
        if (e.type === "terminate") setTimeout(() => {
          hardAt = Date.now();
          hard.abort();
        }, 500);
      },
    });
    const res = await r.result;
    const after = Date.now() - hardAt;
    assert.equal(res.status, "cancelled");
    assert.equal(res.final, "missing");
    assert.ok(after < 15_000, `reporting went on ${after} ms after the hard cancel`);
  });
});

/** Resolves once Peeps has seen a draining renewal. */
async function waitDraining(r: Rig): Promise<void> {
  for (let i = 0; i < 200; i++) {
    if (r.port.renewals.some((x) => x.fields.state === "draining" && x.answered)) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

