/**
 * A repository connected to several projects whose roots overlap: one job announces to every
 * project holding the test, and each gets its own batch and its own run of it. Every run must
 * hear its test's results under its own credential, or the project reads Error after a job
 * that passed. Through the committed action and real Playwright; nothing starts a browser.
 */
import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { readdir, rm } from "node:fs/promises";
import path from "node:path";

import {
  announceOf,
  attachJob,
  eventsByRun,
  fakePeeps,
  reportDirOf,
  reportJob,
  shape,
  signatureOf,
  suite,
  type BatchSpec,
  type PeepsRequest,
  type Planned,
  type Sent,
} from "./support/ci-job";

const config = (over = "retries: 0") => `import { defineConfig } from "@playwright/test";
export default defineConfig({ testDir: "./tests", outputDir: "./results", workers: 1, timeout: 10000, ${over},
  reporter: [["html", { outputFolder: "./report", open: "never" }]] });\n`;

const SHOP = {
  "playwright.config.ts": config(),
  "tests/shop.spec.ts": `import { test, expect } from "@playwright/test";
test("checkout", async () => {});
test("refund", async () => { expect(1).toBe(2); });
`,
};

const everything = (name: string): BatchSpec => ({ name, picks: () => true });
const titled = (name: string, ...titles: string[]): BatchSpec => ({
  name,
  picks: (v: Planned) => titles.includes(v.titlePath),
});

const postsOf = (requests: PeepsRequest[], runId: string) =>
  requests.filter((v) => v.pathname === `/api/v1/runs/${runId}/events`);

const completedWith = (requests: PeepsRequest[], batch: string) =>
  requests
    .filter((v) => v.pathname === `/api/v1/ci/batches/batch-${batch}/complete`)
    .map((v) => (JSON.parse(v.text) as { reportUploaded: boolean }).reportUploaded);

const uploadedTo = (requests: PeepsRequest[], batch: string) =>
  requests.filter((v) => v.pathname === `/api/v1/ci/batches/batch-${batch}/artifacts`).map((v) => v.artifact).sort();

const PASSED = ["run_start", "test_start", "test_end(passed,0)", "run_end"];
const FAILED = ["run_start", "test_start", "test_end(failed,0)", "run_end"];

for (const [mode, job] of [["report", reportJob], ["attach", attachJob]] as const) {
  test(`${mode}: three batches holding one set of tests each hear every result under their own credential`, async (t) => {
    const root = await suite(t, SHOP);
    const peeps = await fakePeeps(t, { batches: [everything("a"), everything("b"), everything("c")] });
    const { code } = await job(root, peeps.url);
    assert.equal(code, 1, "the job's exit code is the test run's");

    const sent = eventsByRun(peeps.requests);
    for (const name of ["a", "b", "c"]) {
      assert.deepEqual(shape(sent.get(`${name}-checkout`)), PASSED, `${name}'s checkout`);
      assert.deepEqual(shape(sent.get(`${name}-refund`)), FAILED, `${name}'s refund`);
      for (const runId of [`${name}-checkout`, `${name}-refund`]) {
        const posts = postsOf(peeps.requests, runId);
        assert.equal(posts.length, 1, `one POST for ${runId}`);
        assert.equal(posts[0]!.authorization, `Bearer v1.99.${signatureOf(runId)}`);
      }
      assert.ok(uploadedTo(peeps.requests, name).includes("index.html"), `${name} gets the report`);
      assert.deepEqual(completedWith(peeps.requests, name), [true], `${name} is completed once`);
    }
  });
}

test("the announce says this action reports to every batch", async (t) => {
  const root = await suite(t, SHOP);
  for (const job of [reportJob, attachJob]) {
    const peeps = await fakePeeps(t);
    await job(root, peeps.url);
    assert.equal(announceOf(peeps.requests).reportsEveryBatch, true);
  }
});

test("partly overlapping batches in any order: each run hears exactly its test, and an unplanned test reaches none", async (t) => {
  const root = await suite(t, {
    "playwright.config.ts": config(),
    "tests/shop.spec.ts": `import { test } from "@playwright/test";
test("one", async () => {});
test("two", async () => {});
test("three", async () => {});
test("nobody planned this", async () => {});
`,
  });
  const peeps = await fakePeeps(t, {
    batches: [titled("c", "three"), titled("a", "one", "two"), titled("b", "two", "three")],
  });
  const { output } = await reportJob(root, peeps.url);
  const sent = eventsByRun(peeps.requests);
  assert.deepEqual([...sent.keys()].sort(), ["a-one", "a-two", "b-three", "b-two", "c-three"]);
  for (const events of sent.values()) assert.deepEqual(shape(events), PASSED);
  const names = (runId: string) => [...new Set(sent.get(runId)!.flatMap((e) => (e.testName ? [e.testName] : [])))];
  assert.deepEqual(names("a-one"), ["one"]);
  assert.deepEqual(names("a-two"), ["two"]);
  assert.deepEqual(names("b-two"), ["two"]);
  assert.deepEqual(names("b-three"), ["three"]);
  assert.deepEqual(names("c-three"), ["three"]);
  assert.match(output, /\[peeps\] not planned, not reported: .*nobody planned this \(passed\)/);
  assert.match(output, /\[peeps\] reporting 5 planned run\(s\)/, "the log counts runs, not tests");
});

test("a retry reaches every run: each attempt once, and each run closes after the last", async (t) => {
  const root = await suite(t, {
    "playwright.config.ts": config("retries: 1"),
    "tests/shop.spec.ts": `import { test, expect } from "@playwright/test";
test("flaky", async ({}, info) => { expect(info.retry).toBe(1); });
`,
  });
  const peeps = await fakePeeps(t, { batches: [everything("a"), everything("b")] });
  const { code } = await reportJob(root, peeps.url);
  assert.equal(code, 0, "flaky is not a failed run");
  const expected = ["run_start", "test_start", "test_end(failed,0)", "test_start", "test_end(passed,1)", "run_end"];
  const sent = eventsByRun(peeps.requests);
  assert.deepEqual(shape(sent.get("a-flaky")), expected);
  assert.deepEqual(shape(sent.get("b-flaky")), expected);
});

/** What single-batch reporting sends, with the run's name and the clock taken out. */
function comparable(sent: Map<string, Sent[]>, batch: string) {
  return Object.fromEntries(
    [...sent]
      .filter(([runId]) => runId.startsWith(`${batch}-`))
      .map(([runId, events]) => [
        runId.slice(batch.length + 1),
        events.map(({ timestamp: _t, duration: _d, errorStack: _s, ...event }) => event),
      ]),
  );
}

for (const [what, files] of [
  ["a serial group", {
    "playwright.config.ts": config("retries: 1"),
    "tests/shop.spec.ts": `import { test, expect } from "@playwright/test";
test.describe.serial("group", () => {
  test("first", async () => { expect(1).toBe(2); });
  test("second", async () => {});
});
`,
  }],
  ["a skipped test", {
    "playwright.config.ts": config(),
    "tests/shop.spec.ts": `import { test } from "@playwright/test";
test.skip("skipped", async () => {});
test("conditional", async () => { test.skip(true, "not here"); });
`,
  }],
  ["a run stopped early", {
    "playwright.config.ts": config("retries: 0, maxFailures: 1"),
    "tests/shop.spec.ts": `import { test, expect } from "@playwright/test";
test("fails", async () => { expect(1).toBe(2); });
test("never starts", async () => {});
`,
  }],
] as const) {
  test(`${what}: every sibling hears what a single batch hears`, async (t) => {
    const root = await suite(t, files);
    const alone = await fakePeeps(t, { batches: [everything("x")] });
    await reportJob(root, alone.url);
    const together = await fakePeeps(t, { batches: [everything("x"), everything("y")] });
    await reportJob(root, together.url);

    const expected = comparable(eventsByRun(alone.requests), "x");
    assert.ok(Object.keys(expected).length > 0, "the suite reported something");
    const sent = eventsByRun(together.requests);
    assert.deepEqual(comparable(sent, "x"), expected);
    assert.deepEqual(comparable(sent, "y"), expected);
  });
}

for (const refusal of [401, 429] as const) {
  test(`one sibling answered ${refusal} costs the other nothing`, async (t) => {
    const root = await suite(t, SHOP);
    const peeps = await fakePeeps(t, {
      batches: [everything("a"), everything("b")],
      refuseEvents: (runId) => (runId.startsWith("a-") ? refusal : null),
    });
    const { code, output } = await reportJob(root, peeps.url);
    assert.equal(code, 1);
    const sent = eventsByRun(peeps.requests);
    assert.deepEqual(shape(sent.get("b-checkout")), PASSED);
    assert.deepEqual(shape(sent.get("b-refund")), FAILED);
    assert.equal(postsOf(peeps.requests, "a-checkout").length, refusal === 401 ? 1 : 3, "a 401 is final, a 429 retried");
    if (refusal === 401) assert.match(output, /\[peeps\] events for a-checkout rejected: 401/);
    assert.deepEqual(completedWith(peeps.requests, "a"), [true]);
    assert.deepEqual(completedWith(peeps.requests, "b"), [true]);
  });
}

test("a report upload that throws for one batch costs the other nothing, and doesn't lend it the other's flag", async (t) => {
  const root = await suite(t, SHOP);
  let removed = false;
  const peeps = await fakePeeps(t, {
    batches: [everything("first"), everything("second")],
    // Pulls the report out from under the upload, so the next file's read throws.
    onArtifact: async (batchId, artifact) => {
      if (batchId !== "batch-second" || removed) return;
      removed = true;
      const report = await reportDirOf(root);
      for (const name of await readdir(report, { recursive: true })) {
        if (name !== artifact) await rm(path.join(report, name), { recursive: true, force: true });
      }
    },
  });
  const { code, output } = await reportJob(root, peeps.url);
  assert.equal(code, 1);
  assert.match(output, /\[peeps\] report upload failed for batch batch-second/);
  assert.deepEqual(completedWith(peeps.requests, "first"), [true]);
  assert.deepEqual(completedWith(peeps.requests, "second"), [false], "it has no report of its own");
});

test("attach: events from before the plan arrived replay to every entry", async (t) => {
  const root = await suite(t, SHOP);
  const peeps = await fakePeeps(t, { batches: [everything("a"), everything("b")], planDelayMs: 1500 });
  const { code } = await attachJob(root, peeps.url);
  assert.equal(code, 1, "the customer's run keeps its exit code");
  const sent = eventsByRun(peeps.requests);
  for (const name of ["a", "b"]) {
    assert.deepEqual(shape(sent.get(`${name}-checkout`)), PASSED);
    assert.deepEqual(shape(sent.get(`${name}-refund`)), FAILED);
  }
  const first = sent.get("a-refund")!.map((e) => e.timestamp);
  assert.deepEqual(sent.get("b-refund")!.map((e) => e.timestamp), first, "each keeps when it happened");
});
