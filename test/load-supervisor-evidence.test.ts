/**
 * The supervisor over the fake Peeps and the fake jail (e4 plan v3 §3.2 `load-supervisor`):
 * evidence and hard cancellation.
 * Every assertion is a count or an order, never a duration. The suite is split across files so each
 * stays well inside the per-file test timeout.
 */
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import type { Dial } from "../src/load/gate/proxy";
import { fakeJail } from "./support/fake-jail";
import { FAST, invariants, onPhase, rig, smallPlan, why } from "./support/run-supervisor";

describe("load supervisor: evidence and hard cancel", { concurrency: 4 }, () => {
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

  test("a malformed positive final reply leaves the same batch pending until a real ack", async (t) => {
    const attempts: string[] = [];
    const r = await rig(t, {
      observer: (event, x) => {
        if (event.type !== "claimed") return;
        const events = x.port.events.bind(x.port);
        x.port.events = async (...args: Parameters<typeof events>) => {
          const body = args[2];
          if (body.final) {
            attempts.push(JSON.stringify(body));
            if (attempts.length === 1) return { ok: true };
            if (attempts.length === 2) return { ok: true, replay: false, refused: "budget" };
          }
          return events(...args);
        };
      },
    });
    const res = await r.result;
    assert.equal(attempts.length, 3);
    assert.equal(new Set(attempts).size, 1);
    assert.equal(r.port.posted.filter((p) => p.final && !p.refused).length, 1);
    assert.equal(res.evidence.state, "complete");
  });

  test("an interval acknowledged during settlement cannot strand the final evidence", async (t) => {
    let release: (() => void) | undefined;
    const r = await rig(t, {
      plan: smallPlan({ exportName: "get", users: 1, durationMs: 900, pacingMs: 1000 }),
      seams: { constants: { ...FAST, intervalMs: 500, reportingMs: 1000 } },
      observer: (event, x) => {
        if (event.type === "claimed") {
          const events = x.port.events.bind(x.port);
          x.port.events = (...args) => {
            const ack = events(...args);
            if (args[2].seq !== 1) return ack;
            return new Promise((resolve) => {
              void ack.then((answer) => { release = () => resolve(answer); });
            });
          };
        }
        if (event.type === "terminate") {
          // Deliver the outstanding interval acknowledgement as finish resumes
          // from the settlement race, before it queues the final evidence.
          let remaining = 7;
          const advance = () => {
            if (remaining-- === 0) release?.();
            else queueMicrotask(advance);
          };
          advance();
        }
      },
    });
    const res = await r.result;
    assert.equal(res.status, "completed", why(r, res));
    assert.ok(release, "an interval acknowledgement was held");
    assert.equal(res.closed.state, "acked");
    assert.equal(res.evidence.state, "complete");
    assert.deepEqual(res.final, { watermark: res.closed.debited });
    const accepted = r.port.batches() as { kind: string }[];
    assert.deepEqual(accepted.slice(-4).map(({ kind }) => kind), ["handoffs", "renewals", "summary", "final"]);
  });

  test("a blocked events endpoint: the run still ends within its reporting deadline, final missing", async (t) => {
    const r = await rig(t, { script: { eventsBlocked: true } });
    const res = await r.result;
    assert.equal(res.status, "completed", why(r, res));
    assert.equal(res.gateClosed, true);
    assert.equal(res.final, "missing");
  });

  test("a jail that cannot start: startup_failed, and the failures name the stage, never the error's message", async (t) => {
    const r = await rig(t, { launch: async () => { throw new Error("load jail: no systemd here"); } });
    const res = await r.result;
    assert.equal(res.reason, "startup_failed", why(r, res));
    assert.deepEqual(res.failures, [{ message: "startup_failed: the jail could not start: an unexpected error", location: null }]);
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

  test("a hard cancel's deadline includes a pending probe", async (t) => {
    const hard = new AbortController();
    let probeReturned = false;
    let fallback: NodeJS.Timeout | undefined;
    let release!: () => void;
    const probe = new Promise<void>((resolve) => { release = resolve; });
    const r = await rig(t, {
      hardSignal: hard.signal,
      seams: {
        constants: { ...FAST, hardReportingMs: 50 },
        probe: async () => {
          hard.abort();
          fallback = setTimeout(release, 500);
          await probe;
          probeReturned = true;
          return { passed: true, failures: [], seen: null };
        },
      },
    });
    try {
      const res = await r.result;
      assert.equal(res.status, "cancelled", why(r, res));
      assert.equal(probeReturned, false, "the run returned while the probe was still cleaning up");
      assert.equal(r.port.claims.length, 0);
    } finally {
      clearTimeout(fallback);
      release();
    }
  });

  test("a hard cancel reports pending jail creation dirty and ends a late handle without using it", async (t) => {
    const hard = new AbortController();
    let release!: () => void;
    let ended!: () => void;
    const pending = new Promise<void>((resolve) => { release = resolve; });
    const cleanup = new Promise<void>((resolve) => { ended = resolve; });
    const jails = fakeJail();
    let launchReturned = false;
    let listenLate!: () => Promise<unknown>;
    let fallback: NodeJS.Timeout | undefined;
    const r = await rig(t, {
      hardSignal: hard.signal,
      seams: { constants: { ...FAST, hardReportingMs: 50 } },
      launch: async (spec, options, signal) => {
        const handle = await jails.launch(spec, options, signal);
        listenLate = () => options.listenProxy(path.join(spec.workspace, "late.sock"));
        hard.abort();
        fallback = setTimeout(release, 500);
        await pending;
        launchReturned = true;
        return { ...handle, end: async () => {
          const result = await handle.end();
          ended();
          return result;
        } };
      },
    });
    try {
      const res = await r.result;
      assert.equal(res.status, "cancelled", why(r, res));
      assert.equal(launchReturned, false, "the run did not wait past the budget for jail creation");
      assert.equal(res.cleanup, "dirty");
      assert.equal(res.closed.state, "withheld", "no closed while a late launch is outstanding");
      assert.equal(r.port.renewals.filter((x) => x.fields.state === "closed").length, 0);
      await assert.rejects(listenLate, /proxy is closed/);
    } finally {
      clearTimeout(fallback);
      release();
      await cleanup;
    }
    assert.deepEqual(jails.made[0]!.tickets, [], "no startup ticket was minted after the cutoff");
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
