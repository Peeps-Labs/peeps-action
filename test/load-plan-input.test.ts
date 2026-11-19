/**
 * The engine's input check: `{plan, limits}` in peeps' shape, refused on anything unknown,
 * out of range, inconsistent or escaping the repository. The pinned peeps corpus is checked
 * in `load-corpus.test.ts`; these use the action's own hand-written plan.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";

import { isCanonicalOrigin, isContainedModulePath, validatePlanInput, type PlanInput } from "../src/load/plan-input";

const dir = path.resolve(__dirname, "fixtures/load-engine");
const read = (file: string) => JSON.parse(readFileSync(path.join(dir, file), "utf8")) as unknown;
const good = (): PlanInput => ({ plan: read("plan.json"), limits: read("limits.json") }) as PlanInput;

function refused(mutate: (input: PlanInput & Record<string, unknown>) => void): string[] {
  const input = good() as PlanInput & Record<string, unknown>;
  mutate(input);
  const result = validatePlanInput(input);
  assert.equal(result.ok, false, "expected a refusal");
  return result.ok ? [] : result.errors;
}

test("the hand-written plan and limits are accepted, as a copy", () => {
  const input = good();
  const result = validatePlanInput(input);
  assert.ok(result.ok, result.ok ? "" : result.errors.join("\n"));
  assert.deepEqual(result.value, input);
  assert.notEqual(result.value.plan, input.plan);
});

for (const [name, mutate, expected] of [
  ["an unknown top-level field", (i: any) => (i.grant = {}), /^input\.grant: is not a known field/],
  ["an unknown plan field", (i: any) => (i.plan.env = "staging"), /^plan\.env: is not a known field/],
  ["an unknown stage field", (i: any) => (i.plan.cohort.stages[1].weight = 2), /stages\[1\]\.weight: is not a known field/],
  ["an unknown limits field", (i: any) => (i.limits.ratePerSecond = 9), /^limits\.ratePerSecond: is not a known field/],
  ["a missing field", (i: any) => delete i.plan.requests, /^plan\.requests: is missing/],
  ["protocol 2", (i: any) => (i.plan.protocolVersion = 2), /^plan\.protocolVersion: must be 1/],
  ["another reduction policy", (i: any) => (i.plan.onReduced = "continue"), /^plan\.onReduced/],
  ["a browser cohort", (i: any) => (i.plan.cohort.kind = "browser"), /^plan\.cohort\.kind/],
  ["pacing under a second", (i: any) => (i.plan.cohort.pacingEveryMs = 999), /pacingEveryMs: must be between 1000/],
  ["a fractional duration", (i: any) => (i.plan.cohort.stages[0].durationMs = 20000.5), /stages\[0\]\.durationMs: must be a whole number/],
  ["too many users", (i: any) => (i.plan.cohort.stages[1].toUsers = 1001), /toUsers: must be between 0 and 1000/],
  ["a hold that changes users", (i: any) => (i.plan.cohort.stages[1].toUsers = 3), /stages\[1\]: a hold keeps the same number of users/],
  ["a gap between stages", (i: any) => (i.plan.cohort.stages[2].startMs = 80001), /stages\[2\]\.startMs: must be 80000/],
  ["a total duration that is not the stages'", (i: any) => (i.plan.durationMs = 99000), /^plan\.durationMs: must be the stages' total, 100000/],
  ["a peak that is not the stages'", (i: any) => (i.plan.peakUsers = 5), /^plan\.peakUsers: must be the stages' peak, 4/],
  ["planned starts that do not add up", (i: any) => (i.plan.plannedStarts = 61), /^plan\.plannedStarts: must be the stages' total, 60/],
  [
    "a stage's planned starts that are not the schedule's",
    (i: any) => {
      i.plan.cohort.stages[1].plannedStarts = 49;
      i.plan.plannedStarts = 61;
      i.plan.requests.ceiling = 1220;
      i.limits.requestBudget = 1220;
    },
    /stages\[1\]\.plannedStarts: must be 48, what the schedule produces/,
  ],
  ["a ceiling that is not starts × per journey", (i: any) => (i.plan.requests.ceiling = 1199), /^plan\.requests\.ceiling: must be plannedStarts × perJourneyMax/],
  ["a GET in the allowed requests", (i: any) => (i.plan.allowedRequests[0].method = "GET"), /allowedRequests\[0\]\.method/],
  ["an allowed request with a query", (i: any) => (i.plan.allowedRequests[0].path = "/auth/token?x=1"), /allowedRequests\[0\]\.path/],
  ["an allowed request listed twice", (i: any) => i.plan.allowedRequests.push({ method: "POST", path: "/auth/token" }), /allowedRequests\[1\]: is listed twice/],
  ["a bare host as an origin", (i: any) => (i.limits.allowedOrigins = ["staging.example.com"]), /allowedOrigins\[0\]: must be an exact origin/],
  ["an origin with a path", (i: any) => (i.limits.allowedOrigins = ["https://staging.example.com/"]), /allowedOrigins\[0\]: must be an exact origin/],
  ["an origin in capitals", (i: any) => (i.limits.allowedOrigins = ["https://Staging.example.com"]), /allowedOrigins\[0\]/],
  ["an origin with a user", (i: any) => (i.limits.allowedOrigins = ["https://u@staging.example.com"]), /allowedOrigins\[0\]/],
  ["an origin listed twice", (i: any) => (i.limits.allowedOrigins = ["https://a.example.com", "https://a.example.com"]), /allowedOrigins\[1\]: is listed twice/],
  ["no origin", (i: any) => (i.limits.allowedOrigins = []), /allowedOrigins: must hold 1 to 20 entries/],
  ["more users than the environment allows", (i: any) => (i.limits.maxUsers = 3), /^plan\.peakUsers: is more than the environment allows \(3\)/],
  ["a ceiling over the request budget", (i: any) => (i.limits.requestBudget = 1199), /^plan\.requests\.ceiling: is more than the environment's request budget/],
  ["an export that is not a name", (i: any) => (i.plan.journey.export = "default()"), /^plan\.journey\.export: must be an export name/],
] as const) {
  test(`refuses ${name}`, () => {
    const errors = refused(mutate as (i: PlanInput & Record<string, unknown>) => void);
    assert.ok(errors.some((e) => (expected as RegExp).test(e)), errors.join("\n"));
  });
}

for (const module of ["../secrets.ts", "/etc/passwd", "a/../../b.ts", "a/./b.ts", "a//b.ts", "a\\b.ts", "C:/x.ts", "~/x.ts", "x\0.ts", ""]) {
  test(`refuses a journey module ${JSON.stringify(module)} that could leave the repository`, () => {
    assert.equal(isContainedModulePath(module), false);
    const errors = refused((i) => (i.plan.journey.module = module));
    assert.ok(errors.some((e) => e.startsWith("plan.journey.module")), errors.join("\n"));
  });
}

test("a nested repository-relative module is fine", () => {
  assert.equal(isContainedModulePath("tools/e2e/src/journeys/checkout-quote.ts"), true);
  assert.equal(isContainedModulePath(".config/journey.ts"), true);
});

test("origins are exact", () => {
  assert.equal(isCanonicalOrigin("https://staging.example.com"), true);
  assert.equal(isCanonicalOrigin("http://127.0.0.1:3200"), true);
  assert.equal(isCanonicalOrigin("https://staging.example.com:443"), false);
  assert.equal(isCanonicalOrigin("ftp://staging.example.com"), false);
  assert.equal(isCanonicalOrigin("not a url"), false);
});

test("something that is not an object is refused, not thrown", () => {
  for (const raw of [null, [], "plan", 3]) {
    const result = validatePlanInput(raw);
    assert.equal(result.ok, false);
  }
});

test("more than 20 stages and more than 60 min are refused", () => {
  const stages = Array.from({ length: 21 }, (_, n) => ({
    name: `S${n}`, kind: "hold", startMs: n * 1000, durationMs: 1000, fromUsers: 1, toUsers: 1, plannedStarts: 1,
  }));
  assert.ok(refused((i) => (i.plan.cohort.stages = stages as never)).some((e) => /stages: must hold 1 to 20/.test(e)));
  const long = refused((i) => {
    i.plan.cohort.stages = [{ name: "Long", kind: "hold", startMs: 0, durationMs: 3_600_001, fromUsers: 1, toUsers: 1, plannedStarts: 3601 }];
  });
  assert.ok(long.some((e) => /durationMs: must be between 1 and 3600000/.test(e)), long.join("\n"));
});
