/**
 * The plan corpus peeps owns (`src/server/load-testing/protocol/__fixtures__/v1/common/`),
 * copied byte for byte into `test/fixtures/load-plans/v1/common/` and pinned by the same root
 * hash peeps' `corpus.test.ts` pins. Editing the copy fails here; a change of meaning is a new
 * `v2/` in peeps. The engine must accept every golden plan with the golden limits, run every
 * schedule vector, and refuse the oversized case.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";

import { engineBudgets } from "../src/load/engine-limits";
import { validatePlanInput, type Limits } from "../src/load/plan-input";
import { Scheduler, scheduleStageStarts, type ScheduleInput } from "../src/load/scheduler";

/** sha256 of `v1/common/MANIFEST`; the same constant as peeps' `corpus.test.ts`. */
const V1_COMMON_ROOT_HASH = "2909d040f280522a925100218d35375fca8f6528fb68a963deb94de092400b14";
/** The peeps commit the copy came from. */
const PEEPS_COMMIT = "cdeebfcc4d4b4c1b048d4f148a7fc5d97f6920ec";

const common = path.resolve(__dirname, "fixtures/load-plans/v1/common");
const sha256 = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
const readJson = <T>(file: string): T => JSON.parse(readFileSync(path.join(common, file), "utf8")) as T;
const limits = readJson<{ ok: true; limits: Limits }>("limits.json").limits;

test("the copy matches peeps' pinned root hash", () => {
  assert.equal(sha256(readFileSync(path.join(common, "MANIFEST"))), V1_COMMON_ROOT_HASH);
});

test("the copy records the peeps commit it came from", () => {
  const source = readFileSync(path.resolve(common, "../SOURCE"), "utf8");
  assert.match(source, new RegExp(`commit:\\s+${PEEPS_COMMIT}`));
  assert.match(source, new RegExp(V1_COMMON_ROOT_HASH));
});

test("MANIFEST lists every file with its sha256, and nothing else", () => {
  const manifest = readFileSync(path.join(common, "MANIFEST"), "utf8")
    .trim()
    .split("\n")
    .map((line) => {
      const [hash, file] = line.split(/\s+/);
      return { hash: hash!, file: file! };
    });
  const files = readdirSync(common).filter((f) => f !== "MANIFEST").sort();
  assert.deepEqual(manifest.map((m) => m.file), files);
  for (const { hash, file } of manifest) assert.equal(sha256(readFileSync(path.join(common, file))), hash, file);
});

for (const name of ["starter", "spec-example", "monorepo"]) {
  test(`the engine accepts the golden ${name} plan with the golden limits`, () => {
    const plan = readJson<unknown>(`${name}.plan.json`);
    const result = validatePlanInput({ plan, limits });
    assert.ok(result.ok, result.ok ? "" : result.errors.join("\n"));
    const budgets = engineBudgets(result.value);
    assert.ok(budgets.measurement.totalRequests <= limits.requestBudget);
    assert.ok(budgets.checking.users <= 5);
  });
}

const vectors = readJson<{ name: string; input: ScheduleInput; expectedStarts: number[] }[]>("schedule-vectors.json");
for (const vector of vectors) {
  test(`schedule vector: ${vector.name}`, () => {
    assert.deepEqual(scheduleStageStarts(vector.input), vector.expectedStarts);
    // Run on time, the scheduler starts exactly the planned starts, in the stage they were due.
    const scheduler = new Scheduler(vector.input, 1_000);
    const perStage = vector.input.stages.map(() => 0);
    const end = vector.input.stages.reduce((sum, s) => sum + s.durationMs, 0);
    for (let now = 0; now < end; now += 1) {
      for (const start of scheduler.poll(now, () => false).starts) perStage[start.stage]! += 1;
    }
    assert.deepEqual(perStage, vector.expectedStarts);
  });
}

test("the oversized case (1,000 users for 10 days) is refused before any schedule is computed", () => {
  // The action never parses YAML: this is the plan oversized.workload.yaml would ask for.
  const refusal = readJson<{ ok: false; errors: { path: string[] }[] }>("oversized.refusal.json");
  assert.equal(refusal.ok, false);
  const days = 240 * 60 * 60 * 1000;
  const starts = 1000 * (days / 1000);
  const plan = {
    protocolVersion: 1,
    journey: { module: "a.ts", export: "f" },
    cohort: {
      kind: "protocol",
      demand: "users",
      pacingEveryMs: 1000,
      stages: [{ name: "Stage 1", kind: "hold", startMs: 0, durationMs: days, fromUsers: 1000, toUsers: 1000, plannedStarts: starts }],
    },
    durationMs: days,
    peakUsers: 1000,
    plannedStarts: starts,
    requests: { perJourneyMax: 20, ceiling: starts * 20 },
    allowedRequests: [],
    onReduced: "refuse",
  };
  const started = Date.now();
  const result = validatePlanInput({ plan, limits: { ...limits, maxUsers: 1000, requestBudget: starts * 20 } });
  assert.equal(result.ok, false);
  assert.ok(!result.ok && result.errors.some((e) => /^plan\.cohort\.stages\[0\]\.durationMs: must be between 1 and 3600000/.test(e)), JSON.stringify(result));
  assert.ok(Date.now() - started < 1_000);
});
