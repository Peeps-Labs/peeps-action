/**
 * E5's A3 over the fake Peeps and the fake jail (e5 plan §2.4, v2 §2.8 and §4, v3 §2.8 and §4):
 * the release-bearing `closed` renewal, the renewal latency record and `lagP99Ms`, the drain's
 * grace, and the events pump's retries, refusals and splitting. Every assertion is a count or an
 * order, never a duration.
 */
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { appendFileSync, readFileSync } from "node:fs";
import path from "node:path";
import type { Dial } from "../src/load/gate/proxy";
import { nearestRank, splitToFit, SUPERVISOR_CONSTANTS } from "../src/load/supervisor";
import { respond as fixtureRespond } from "./support/e4-fixtures";
import type { PortScript } from "./support/fake-control-port";
import { fakeJail } from "./support/fake-jail";
import { closedInvariants, FAST, invariants, onPhase, rig, smallPlan, why, WORKLOAD_PATH } from "./support/run-supervisor";

describe("load supervisor: closed, latency, drain and the events pump", { concurrency: 4 }, () => {
  // ---------------------------------------------------------------- closed

  test("closed is sent once, after gate_closed and a clean jail end, with the final debit; Peeps acknowledges it", async (t) => {
    const r = await rig(t);
    const res = await r.result;
    assert.equal(res.status, "completed", why(r, res));
    assert.equal(res.cleanup, "clean");
    assert.equal(res.closed.state, "acked", JSON.stringify(res.closed));
    assert.equal(res.closed.attempts, 1);
    assert.ok(res.closed.latencyMs !== null && res.closed.latencyMs >= 0);
    const closed = r.port.renewals.filter((x) => x.fields.state === "closed");
    assert.equal(closed.length, 1);
    assert.equal(closed[0]!.fields.debited, res.journal!.debited);
    assert.deepEqual(res.final, { watermark: closed[0]!.fields.debited });
    assert.equal(r.port.closed!.debited, res.journal!.debited);
    const order = r.events.map((e) => e.type);
    assert.ok(order.indexOf("gate_closed") < order.indexOf("closed"));
    invariants(r, res);
  });

  test("a jail whose cleanup is not proven: no closed is sent", async (t) => {
    const jails = fakeJail();
    const r = await rig(t, {
      launch: async (spec, options, signal) => {
        const handle = await jails.launch(spec, options, signal);
        return { ...handle, end: async () => ({ ...(await handle.end()), clean: false }) };
      },
    });
    const res = await r.result;
    assert.equal(res.status, "completed", why(r, res));
    assert.equal(res.cleanup, "dirty");
    assert.deepEqual(res.closed, { state: "withheld", reason: "dirty", attempts: 0, latencyMs: null });
    assert.equal(r.port.renewals.filter((x) => x.fields.state === "closed").length, 0);
    assert.equal(r.port.closed, undefined);
    invariants(r, res);
  });

  test("a launch that failed is not proof that nothing runs: no closed", async (t) => {
    const r = await rig(t, { launch: async () => { throw new Error("load jail: no systemd here"); } });
    const res = await r.result;
    assert.equal(res.reason, "startup_failed", why(r, res));
    assert.equal(res.cleanup, "dirty");
    assert.equal(res.closed.state, "withheld");
    assert.equal(r.port.closed, undefined);
  });

  test("closed is sent after the lease was lost too, and Peeps accepts it past the lost seq", async (t) => {
    const r = await rig(t, { plan: smallPlan({ exportName: "get", durationMs: 20_000 }), script: { lostAfterMs: 3000 } });
    const res = await r.result;
    assert.equal(res.status, "lease_lost", why(r, res));
    assert.equal(res.closed.state, "acked", JSON.stringify(res.closed));
    closedInvariants(r, res);
    invariants(r, res);
  });

  test("closed skips an abandoned seq: after a hung renewal it goes on the next seq, never on the hung one", async (t) => {
    const r = await rig(t, { plan: smallPlan({ exportName: "get", durationMs: 20_000 }), script: { hangSeq: 3 } });
    const res = await r.result;
    assert.equal(res.status, "lease_lost", why(r, res));
    assert.equal(res.closed.state, "acked", JSON.stringify(res.closed));
    assert.equal(res.closed.seq, 4);
    assert.equal(r.port.closed!.seq, 4);
    invariants(r, res);
  });

  test("the launch never happened: a zero-debit closed", async (t) => {
    const r = await rig(t, { observer: (e, x) => {
      if (e.type === "claimed") appendFileSync(path.join(x.ws, WORKLOAD_PATH), "# edited\n");
    } });
    const res = await r.result;
    assert.equal(res.reason, "checkout_changed", why(r, res));
    assert.equal(res.cleanup, "not_started");
    assert.equal(res.closed.state, "acked");
    assert.equal(res.closed.debited, 0);
    assert.equal(r.port.closed!.debited, 0);
  });

  test("a refused claim sends no closed", async (t) => {
    const r = await rig(t, { script: { claimRefused: "matrix" } });
    const res = await r.result;
    assert.equal(res.closed.state, "none");
    assert.equal(r.port.renewals.length, 0);
  });

  test("a dial that never settles: no gate_closed, so no closed", async (t) => {
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
    assert.equal(res.gateClosed, false, why(r, res));
    assert.deepEqual(res.closed, { state: "withheld", reason: "unsettled", attempts: 0, latencyMs: null });
    assert.equal(r.port.renewals.filter((x) => x.fields.state === "closed").length, 0);
  });

  test("a hung events upload does not delay closed's acknowledgement", async (t) => {
    const r = await rig(t, { script: { eventsBlocked: true } });
    const res = await r.result;
    assert.equal(res.closed.state, "acked", JSON.stringify(res.closed));
    assert.equal(res.closed.attempts, 1);
    assert.equal(res.final, "missing");
    assert.equal(res.evidence.state, "missing");
  });

  test("an unanswered closed is sent again with the same bytes, at a growing pause, until the reporting deadline", async (t) => {
    const r = await rig(t, { script: { closedSilent: true } });
    const res = await r.result;
    assert.equal(res.closed.state, "unanswered", why(r, res));
    const closed = r.port.renewals.filter((x) => x.fields.state === "closed");
    assert.ok(closed.length >= 2, `sent ${closed.length} times`);
    assert.equal(new Set(closed.map((x) => x.body)).size, 1);
    // A 500 ms attempt, then 100, 200, 400… ms pauses: a handful in the 4 s window, never dozens.
    assert.ok(closed.length <= 10, `sent ${closed.length} times`);
    assert.equal(res.closed.attempts, closed.length);
  });

  test("a refused closed is not sent again", async (t) => {
    const r = await rig(t);
    const port = r.port;
    const renew = port.renew.bind(port);
    port.renew = async (claimId, token, body, signal) => (JSON.parse(body).state === "closed" ? { refused: "debited" } : renew(claimId, token, body, signal));
    const res = await r.result;
    assert.deepEqual({ state: res.closed.state, reason: res.closed.reason, attempts: res.closed.attempts }, { state: "refused", reason: "debited", attempts: 1 });
  });

  // ---------------------------------------------------------------- drain

  test("a graceful stop drains for the grant's grace, capped at the turn deadline: a turn in flight for 3.5 s finishes and succeeds", async (t) => {
    const script: PortScript = {};
    let measuring = false;
    const r = await rig(t, {
      plan: smallPlan({ exportName: "get", users: 1, durationMs: 30_000, pacingMs: 1000 }),
      setup: { graceMs: 30_000 },
      script,
      observer: onPhase("measurement", () => (measuring = true)),
      respond: (a, res) => {
        // Peeps asks for the stop as the first measured request arrives: the turn has 3.5 s to go.
        if (measuring) script.stopAfterMs ??= 0;
        setTimeout(() => fixtureRespond(a, res), measuring ? 3_500 : 0);
      },
    });
    const res = await r.result;
    assert.equal(res.status, "stopped", why(r, res));
    assert.equal(res.measurement.started, 1);
    assert.equal(res.measurement.success, 1, "the turn in flight at the stop finished and succeeded");
    assert.equal(res.closed.state, "acked");
    invariants(r, res);
  });

  test("the supervisor has no single stop grace: drain, cohort seal and outcome timeout are apart", () => {
    const code = readFileSync(path.resolve(__dirname, "../src/load/supervisor.ts"), "utf8");
    assert.doesNotMatch(code, /stopGraceMs/);
    assert.equal(SUPERVISOR_CONSTANTS.outcomeTimeoutMs, 5_000);
    assert.match(code, /this\.drainGraceMs = Math\.min\(g\.graceMs, /);
    assert.match(code, /sealCohorts\(planNow, this\.drainGraceMs, force\)/);
  });

  // ---------------------------------------------------------------- latency

  test("every allocated renewal's latency is recorded, sent in the evidence, and summarized nearest-rank", async (t) => {
    const r = await rig(t, { plan: smallPlan({ exportName: "get", durationMs: 4_000 }) });
    const res = await r.result;
    assert.equal(res.status, "completed", why(r, res));
    const sent = new Set(r.port.renewals.filter((x) => x.fields.state !== "closed").map((x) => x.seq));
    assert.deepEqual(res.latency.records.map((x) => x[0]), [...sent].sort((a, b) => a - b), "one record per allocated renewal");
    assert.equal(res.latency.count, sent.size);
    for (const [, attempts, ms, outcome] of res.latency.records) {
      assert.ok(attempts >= 1);
      if (outcome === "held") assert.ok(ms !== null && ms >= 0);
    }
    const values = res.latency.records.map((x) => (x[2] === null ? Infinity : x[2])).sort((a, b) => a - b);
    assert.equal(res.latency.maxMs, Number.isFinite(values.at(-1)!) ? values.at(-1) : null);
    assert.equal(res.latency.p50Ms, nearestRank(values, 0.5));
    const batches = r.port.batches() as { kind: string; records?: unknown[]; first?: number; latency?: { count: number }; eventLoop?: { p99Ms: number } }[];
    const records = batches.filter((b) => b.kind === "renewals").flatMap((b) => b.records!);
    assert.deepEqual(records, res.latency.records);
    const summary = batches.find((b) => b.kind === "summary")!;
    assert.equal(summary.latency!.count, res.latency.count);
    assert.equal(typeof summary.eventLoop!.p99Ms, "number");
    for (const rec of r.port.renewals) assert.ok(Number.isSafeInteger(rec.fields.lagP99Ms) && (rec.fields.lagP99Ms as number) >= 0, "lagP99Ms is a whole number");
  });

  test("an unanswered renewal counts above every answered one", async (t) => {
    const r = await rig(t, { plan: smallPlan({ exportName: "get", durationMs: 20_000 }), script: { hangSeq: 3 } });
    const res = await r.result;
    const hung = res.latency.records.find((x) => x[0] === 3)!;
    assert.equal(hung[2], null);
    assert.ok(hung[1] >= 2, "its retries are counted");
    assert.equal(res.latency.unanswered, 1);
    assert.equal(res.latency.maxMs, null);
  });

  test("nearestRank: p99.9 of 2,400 samples is the 2,398th value", () => {
    const values = Array.from({ length: 2400 }, (_, i) => i + 1);
    assert.equal(nearestRank(values, 0.999), 2398);
    assert.equal(nearestRank(values, 0.5), 1200);
    assert.equal(nearestRank(values, 1), 2400);
    assert.equal(nearestRank([], 0.5), undefined);
  });

  // ---------------------------------------------------------------- the events pump

  test("events answered by a transport failure (a 5xx) are sent again with the same bytes, and the stream still ends", async (t) => {
    const r = await rig(t, { script: { eventsFailures: 3 } });
    const res = await r.result;
    assert.equal(res.status, "completed", why(r, res));
    assert.equal(res.evidence.state, "complete");
    assert.deepEqual(res.final, { watermark: res.journal!.debited });
  });

  test("events that keep failing are retried at a growing pause, not every 50 ms, and the final is missing", async (t) => {
    const r = await rig(t, { script: { eventsFailures: 1_000_000 } });
    const res = await r.result;
    assert.equal(res.evidence.state, "missing");
    // A 4 s window: 100, 200, 400, 800, 1600 ms pauses then 2 s: about 7 sends. At 50 ms it was about 80.
    assert.ok(r.port.eventsCalls <= 15, `events sent ${r.port.eventsCalls} times`);
    assert.equal(res.closed.state, "acked");
  });

  for (const answer of [{ ok: false, reason: "budget" }, { refused: "unknown" }]) {
    test(`a refusal (${JSON.stringify(answer)}) latches the evidence incomplete at that seq, stops the stream, and no final follows`, async (t) => {
      const r = await rig(t, { script: { eventsRefuseFrom: { seq: 2, answer } } });
      const res = await r.result;
      assert.equal(res.status, "completed", why(r, res));
      assert.deepEqual(res.evidence, { state: "incomplete", seq: 2, reason: "reason" in answer ? answer.reason : answer.refused });
      assert.equal(res.final, "missing");
      assert.deepEqual(r.port.posted.map((p) => p.seq), [1, 2], "sent once each, nothing after the hole");
    });
  }

  test("a record that cannot fit a batch latches the evidence incomplete, and no final is sent", async (t) => {
    const r = await rig(t, { seams: { constants: { ...FAST, maxBatchBytes: 600 } } });
    const res = await r.result;
    assert.equal(res.evidence.state, "incomplete");
    assert.equal(res.evidence.reason, "oversized");
    assert.ok(res.evidence.record);
    assert.equal(res.final, "missing");
    assert.ok(r.port.posted.every((p) => !p.final), "no final");
    for (const p of r.port.posted) assert.ok(Buffer.byteLength(p.batch) <= 600);
  });

  test("splitToFit halves records until each part fits, in order, and stops at a record that never fits", () => {
    const fits = (p: Record<string, unknown>) => JSON.stringify(p).length <= 40;
    const records = ["a", "b", "c", "d", "e", "f", "g"];
    const out = splitToFit("k", "r", records, {}, fits);
    assert.equal(out.oversized, undefined);
    assert.ok(out.payloads.length > 1);
    assert.deepEqual(out.payloads.flatMap((p) => p.r as string[]), records);
    assert.deepEqual(out.payloads.map((p) => p.first), out.payloads.reduce<number[]>((acc, p, i) => [...acc, i === 0 ? 0 : acc[i - 1]! + (out.payloads[i - 1]!.r as string[]).length], []));
    const big = splitToFit("k", "r", ["a", "x".repeat(100), "b"], {}, fits);
    assert.equal(big.oversized, 1);
    assert.deepEqual(big.payloads.flatMap((p) => p.r as string[]), ["a"]);
  });

  test("tokens never reach the evidence, the events or the result", async (t) => {
    const r = await rig(t);
    const res = await r.result;
    const all = JSON.stringify(res) + JSON.stringify(r.events) + JSON.stringify(r.port.posted);
    for (const token of [r.port.runToken, r.port.eventsToken]) assert.ok(!all.includes(token), "a token leaked");
  });
});
