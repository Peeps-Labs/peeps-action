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
