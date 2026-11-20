/**
 * The supervisor over the fake Peeps and the fake jail (e4 plan v3 §3.2 `load-supervisor`):
 * the run end to end, how it terminates, and stops.
 * Every assertion is a count or an order, never a duration. The suite is split across files so each
 * stays well inside the per-file test timeout.
 */
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import type { Dial } from "../src/load/gate/proxy";
import { respond as fixtureRespond } from "./support/e4-fixtures";
import type { PortScript } from "./support/fake-control-port";
import { invariants, onPhase, rig, smallPlan, waitDraining, why } from "./support/run-supervisor";

describe("load supervisor: end to end, termination and stops", { concurrency: 4 }, () => {
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
    assert.equal(res.closed.state, "acked");
    assert.equal(res.evidence.state, "complete");
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
    assert.equal(r.port.renewals.filter((x) => x.seq > 3 && x.fields.state !== "closed").length, 0);
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
    assert.equal(res.closed.state, "acked", "one closed after gate_closed, once the draining renewals stop");
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
});
