/**
 * A repository connected to one project is pinned here: what main sent before the action
 * learned about several batches, through the committed action and real Playwright or pytest.
 * The golden files were recorded from main, so byte-identical holds but for one announce field,
 * asserted below. To record again, on purpose: PEEPS_RECORD_GOLDEN=1.
 *
 * Masked: timestamps, durations, terminal colours, the job's temporary directory, the fake
 * server's port, the attach wrapper's uuid. A Playwright report's `data/` files are named for
 * their contents, so they are compared by count and extension, and pytest's tracebacks by
 * whether they are there, since they change with the Python. Nothing else is, so a lifecycle
 * event or a field moved, added or dropped, or a log line reworded, fails.
 */
import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

import {
  announceOf,
  attachJob,
  eventsByRun,
  fakePeeps,
  pytestAvailable,
  pytestJob,
  reportJob,
  suite,
  suiteFrom,
  type PeepsRequest,
} from "./support/ci-job";

const SUITE = {
  "playwright.config.ts": `import { defineConfig } from "@playwright/test";
export default defineConfig({ testDir: "./tests", outputDir: "./results", workers: 1, retries: 1, timeout: 10000,
  reporter: [["html", { outputFolder: "./report", open: "never" }]] });\n`,
  "tests/shop.spec.ts": `import { test, expect } from "@playwright/test";
test("passes", async ({}, info) => {
  await info.attach("note", { body: "kept in the report", contentType: "text/plain" });
});
test("fails then passes", async ({}, info) => { expect(info.retry).toBe(1); });
test("always fails", async () => { expect(1).toBe(2); });
test.skip("skipped", async () => {});
test.describe.serial("a group", () => {
  test("first fails", async () => { expect(1).toBe(2); });
  test("second never runs", async () => {});
});
`,
};

const golden = (name: string) => path.join(__dirname, "fixtures", "single-project", `${name}.json`);

const PRESENT = new Set(["errorStack", "traceback"]);

function normalized(
  requests: PeepsRequest[],
  output: string,
  code: number | null,
  root: string,
  url: string,
  framework: "playwright" | "pytest",
) {
  const text = (value: string) =>
    value
      .replaceAll(root, "<root>")
      .replaceAll(url, "<peeps>")
      .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g, "<uuid>")
      .replace(/\u001b\[\d+m/g, "");
  const masked = (value: unknown, key = ""): unknown => {
    if (key === "timestamp") return "<time>";
    if (key === "duration") return "<ms>";
    if (framework === "pytest" && PRESENT.has(key)) return "<present>";
    if (typeof value === "string") return text(value);
    if (Array.isArray(value)) return value.map((v) => masked(v));
    if (value && typeof value === "object") {
      return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, masked(v, k)]));
    }
    return value;
  };
  const events = Object.fromEntries(
    [...eventsByRun(requests)].sort(([a], [b]) => a.localeCompare(b)).map(([runId, sent]) => [runId, masked(sent)]),
  );
  const uploaded = requests.flatMap((v) => (v.artifact ? [v.artifact] : []));
  const hashed = (name: string) => framework === "playwright" && name.startsWith("data/");
  return {
    exitCode: code,
    announce: announceOf(requests),
    events,
    eventPosts: requests.filter((v) => v.pathname.endsWith("/events")).length,
    report: {
      files: uploaded.filter((v) => !hashed(v)).sort(),
      hashedFiles: uploaded.filter(hashed).map((v) => path.extname(v)).sort(),
    },
    complete: requests.filter((v) => v.pathname.endsWith("/complete")).map((v) => [v.pathname, JSON.parse(v.text) as unknown]),
    // Whether this machine has Playwright's video encoder isn't this test's business.
    lines: output.split("\n").filter((line) => line.startsWith("[peeps]") && !line.includes("default video")).map(text).sort(),
  };
}

async function pinned(
  t: TestContext,
  name: string,
  root: string,
  job: typeof reportJob,
  framework: "playwright" | "pytest",
) {
  const peeps = await fakePeeps(t);
  const { code, output } = await job(root, peeps.url);
  const actual = normalized(peeps.requests, output, code, root, peeps.url, framework);
  // The one thing a single project's job sends that main's didn't, which Peeps ignores today.
  const announced = actual.announce.reportsEveryBatch;
  delete actual.announce.reportsEveryBatch;
  if (process.env.PEEPS_RECORD_GOLDEN) writeFileSync(golden(name), JSON.stringify(actual, null, 2) + "\n");
  assert.deepEqual(actual, JSON.parse(readFileSync(golden(name), "utf8")));
  assert.equal(announced, true);
}

test("one project in report mode sends exactly what main sent", async (t) =>
  pinned(t, "report", await suite(t, SUITE), reportJob, "playwright"));

test("one project in attach mode sends exactly what main sent", async (t) =>
  pinned(t, "attach", await suite(t, SUITE), attachJob, "playwright"));

test("one project on pytest sends exactly what main sent", pytestAvailable(), async (t) =>
  pinned(t, "pytest", await suiteFrom(t, path.join(__dirname, "fixtures", "pytest-camera")), pytestJob, "pytest"));
