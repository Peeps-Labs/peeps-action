/**
 * Acceptance on loopback (e4 plan v3 §4 step 9): 60 s, 100 users ramped, 200 requests a
 * second, through the whole supervisor. Runs only with LOAD_ACCEPT=1 (load-accept.yml, also
 * under `taskset -c 0,1`); on the real jail when LOAD_JAIL_TESTS=1 too. It asserts the run's
 * invariants and reports the rates and lags it saw, for the PR.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { scheduleStageStarts } from "../src/load/scheduler";
import { FAST, installedWorkspace, invariants, rig, type RigOptions } from "./support/run-supervisor";

const accept = process.env.LOAD_ACCEPT === "1";
const real = process.env.LOAD_JAIL_TESTS === "1";

function plan() {
  // 100 users × 3 requests every 1.5 s: 200 a second at the hold.
  const pacingEveryMs = 1500;
  const stages = [
    { name: "Ramp", kind: "ramp" as const, startMs: 0, durationMs: 20_000, fromUsers: 0, toUsers: 100, plannedStarts: 0 },
    { name: "Hold", kind: "hold" as const, startMs: 20_000, durationMs: 40_000, fromUsers: 100, toUsers: 100, plannedStarts: 0 },
  ];
  scheduleStageStarts({ pacingEveryMs, stages }).forEach((n, i) => (stages[i]!.plannedStarts = n));
  const plannedStarts = stages.reduce((a, s) => a + s.plannedStarts, 0);
  return { protocolVersion: 1, journey: { module: "journeys.ts", export: "three" }, cohort: { kind: "protocol", demand: "users", pacingEveryMs, stages }, durationMs: 60_000, peakUsers: 100, plannedStarts, requests: { perJourneyMax: 3, ceiling: 3 * plannedStarts }, allowedRequests: [], onReduced: "refuse" };
}

test("acceptance: 60 s, 100 users with a ramp, about 200 requests a second, on loopback", { skip: accept ? false : "set LOAD_ACCEPT=1 (load-accept.yml)", timeout: 900_000 }, async (t) => {
  const at: number[] = [];
  const o: RigOptions = {
    plan: plan() as never,
    limits: { maxUsers: 100, requestBudget: 1_000_000 },
    setup: { maxRunMs: 300_000, ttlMs: 10_000, renewEveryMs: 2_000, graceMs: 10_000 },
    respond: (a, res) => {
      at.push(Date.now());
      res.writeHead(200, { "content-type": "text/plain" });
      res.end("ok");
      void a;
    },
    seams: { constants: { ...FAST, turnDeadlineMs: 20_000, stopGraceMs: 10_000, loadedMs: 120_000, checkingDeadlineMs: 60_000 } },
  };
  if (real) {
    const ws = await installedWorkspace();
    t.after(() => rmSync(ws, { recursive: true, force: true }));
    Object.assign(o, { ws, real: true });
  }
  const r = await rig(t, o);
  const res = await r.result;
  assert.equal(res.status, "completed", JSON.stringify({ reason: res.reason, failures: res.failures.slice(0, 3), measurement: res.measurement }));
  invariants(r, res);
  const span = (at.at(-1)! - at[0]!) / 1000;
  const perSecond = new Map<number, number>();
  for (const x of at) perSecond.set(Math.floor((x - at[0]!) / 1000), (perSecond.get(Math.floor((x - at[0]!) / 1000)) ?? 0) + 1);
  const rates = [...perSecond.values()].sort((a, b) => a - b);
  t.diagnostic(`jail ${real ? "real" : "fake"}; arrivals ${at.length} over ${span.toFixed(1)} s; per-second p50 ${rates[Math.floor(rates.length / 2)]}, max ${rates.at(-1)}`);
  t.diagnostic(`measurement ${JSON.stringify(res.measurement)}; debited ${res.journal!.debited}; denied ${JSON.stringify(res.journal!.denied)}; renewals ${res.renewals.sent}`);
});
