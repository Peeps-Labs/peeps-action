/**
 * How `{plan, limits}` becomes the engine's per-phase budgets, pinned by
 * `test/fixtures/load-engine/limits-mapping.json` (outside the peeps corpus's hash).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";

import { ENGINE_LIMITS, engineBudgets } from "../src/load/engine-limits";
import { validatePlanInput } from "../src/load/plan-input";

const dir = path.resolve(__dirname, "fixtures");
const read = (file: string) => JSON.parse(readFileSync(path.join(dir, file), "utf8")) as unknown;
const mapping = read("load-engine/limits-mapping.json") as {
  cases: { name: string; plan: string | object; limits: object; budgets: unknown }[];
};

for (const c of mapping.cases) {
  test(`limits mapping: ${c.name}`, () => {
    const plan = typeof c.plan === "string" ? read(c.plan) : c.plan;
    const result = validatePlanInput({ plan, limits: c.limits });
    assert.ok(result.ok, result.ok ? "" : result.errors.join("\n"));
    assert.deepEqual(engineBudgets(result.value), c.budgets);
  });
}

test("every phase keeps concurrency at or under its users, and totals within the request budget", () => {
  for (const c of mapping.cases) {
    const budgets = c.budgets as ReturnType<typeof engineBudgets>;
    for (const phase of [budgets.checking, budgets.measurement]) {
      assert.ok(phase.concurrency <= phase.users);
      assert.ok(phase.totalRequests <= (c.limits as { requestBudget: number }).requestBudget);
      assert.ok(phase.ratePerSecond <= ENGINE_LIMITS.maxRatePerSecond);
      assert.ok(phase.burst <= ENGINE_LIMITS.maxBurst);
    }
    assert.ok(budgets.checking.users <= ENGINE_LIMITS.checkingMaxUsers);
    assert.ok(budgets.checking.totalRequests <= ENGINE_LIMITS.checkingDailyRequests);
  }
});

test("the starting values are the spec's §10.3 proposals", () => {
  assert.equal(ENGINE_LIMITS.checkingMaxUsers, 5);
  assert.equal(ENGINE_LIMITS.checkingDailyRequests, 10_000);
  assert.equal(ENGINE_LIMITS.stopGraceMs, 30_000);
  assert.ok(ENGINE_LIMITS.leaseMs >= 30_000 && ENGINE_LIMITS.leaseMs <= 60_000);
});

// ---------------------------------------------------------------- the grant (e4 plan v3 §2.3)

import { runLimits } from "../src/load/engine-limits";
import type { GrantLimits } from "../src/load/control-port";

const starter = () => {
  const r = validatePlanInput({ plan: read("load-plans/v1/common/starter.plan.json"), limits: read("load-plans/v1/common/limits.json") && (read("load-plans/v1/common/limits.json") as { limits: object }).limits });
  assert.ok(r.ok);
  return r.value;
};
const grantLimits = (over: Partial<GrantLimits> = {}): GrantLimits => ({ ...starter().limits, privateOrigins: {}, phases: {}, ...over });

test("phase caps are the componentwise minimum of the engine's and the grant's", () => {
  const base = runLimits(starter(), grantLimits(), { parallel: 4 });
  assert.ok(base.ok);
  const budgets = engineBudgets(starter());
  assert.deepEqual(base.value.checking, { ratePerSecond: budgets.checking.ratePerSecond, burst: budgets.checking.burst, maxUsers: budgets.checking.users, total: budgets.checking.totalRequests });
  const lowered = runLimits(starter(), grantLimits({ phases: { checking: { ratePerSecond: 1, burst: 2 }, measurement: { burst: 3, ratePerSecond: 1e9, maxUsers: 1000 } } }), { parallel: 4 });
  assert.ok(lowered.ok);
  assert.equal(lowered.value.checking.ratePerSecond, 1);
  assert.equal(lowered.value.checking.burst, 2);
  assert.equal(lowered.value.checking.maxUsers, budgets.checking.users, "absent fields keep the engine's");
  assert.equal(lowered.value.measurement.burst, 3);
  assert.equal(lowered.value.measurement.ratePerSecond, budgets.measurement.ratePerSecond, "a higher grant raises nothing");
  assert.equal(lowered.value.measurement.maxUsers, budgets.measurement.users);
  assert.equal(runLimits(starter(), grantLimits({ phases: { measurement: { burst: 0 } } }), { parallel: 4 }).ok, false, "each field validated: a burst of 0 admits nothing");
});

test("onReduced refuse: against the measurement caps, and against the run budget left after Checking's maximum", () => {
  const why = (g: Partial<GrantLimits>) => {
    const r = runLimits(starter(), grantLimits(g), { parallel: 4 });
    return r.ok ? "ok" : r.reason;
  };
  assert.equal(why({}), "ok");
  assert.equal(why({ phases: { measurement: { maxUsers: 1 } } }), "reduced", "fewer users than the plan's peak");
  assert.equal(why({ phases: { measurement: { total: 559 } } }), "reduced", "a measurement total under the plan's ceiling");
  assert.equal(why({ phases: { measurement: { ratePerSecond: 0.5 } } }), "reduced", "a rate under what the plan needs");
  // The starter's ceiling is 560 and Checking may take 40: a budget of 599 leaves 559.
  assert.equal(why({ requestBudget: 600 }), "ok");
  assert.equal(why({ requestBudget: 599 }), "reduced");
});

test("origins: each approved origin maps to the run total, or to the grant's per-origin caps; http is refused", () => {
  const r = runLimits(starter(), grantLimits(), { parallel: 4 });
  assert.ok(r.ok);
  assert.deepEqual(r.value.gate.origins, { "https://staging.example.com": 1200, "https://auth.staging.example.com": 1200 });
  assert.equal(r.value.gate.runTotal, 1200);
  const capped = runLimits(starter(), grantLimits({ originCaps: { "https://staging.example.com": 700 } }), { parallel: 4 });
  assert.ok(capped.ok);
  assert.deepEqual(capped.value.gate.origins, { "https://staging.example.com": 700, "https://auth.staging.example.com": 0 }, "an origin the caps leave out gets none");
  const plain = runLimits(starter(), grantLimits({ allowedOrigins: ["http://staging.example.com"] }), { parallel: 4 });
  assert.deepEqual(plain.ok ? "ok" : plain.reason, "origin_unsupported");
  const priv = runLimits(starter(), grantLimits({ privateOrigins: { "https://staging.example.com": ["10.0.0.0/8"] } }), { parallel: 4 });
  assert.ok(priv.ok);
  assert.deepEqual([...priv.value.approved.values()], [{ host: "staging.example.com", port: 443, privateCidrs: ["10.0.0.0/8"] }, { host: "auth.staging.example.com", port: 443, privateCidrs: [] }]);
});

test("methods and the request policy come from the plan; dials are sized from the users", () => {
  const input = starter();
  const plan = { ...input.plan, allowedRequests: [{ method: "POST" as const, path: "/cart" }] };
  const r = runLimits({ ...input, plan }, grantLimits(), { parallel: 4 });
  assert.ok(r.ok);
  assert.deepEqual([...r.value.gate.methods].sort(), ["GET", "HEAD", "POST"]);
  assert.deepEqual(r.value.policy, { allowedOrigins: ["https://staging.example.com", "https://auth.staging.example.com"], allowedRequests: [{ method: "POST", path: "/cart" }] });
  assert.equal(r.value.gate.maxRequestsPerTurn, input.plan.requests.perJourneyMax);
  assert.equal(r.value.proxy.maxPendingDialsPerTurn, 4);
  assert.equal(r.value.proxy.maxPendingDials, 2 * 4, "min(maxUsers × parallel, 256)");
  const big = runLimits({ plan: { ...input.plan, peakUsers: 200 }, limits: { ...input.limits, maxUsers: 1000 } }, grantLimits({ maxUsers: 1000 }), { parallel: 8 });
  assert.ok(big.ok, big.ok ? "" : big.detail);
  assert.equal(big.value.proxy.maxPendingDials, 256);
});
