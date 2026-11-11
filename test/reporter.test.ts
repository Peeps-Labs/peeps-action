import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { FullConfig, Suite, TestCase, TestResult } from "@playwright/test/reporter";

import PeepsCiReporter, { type PlanFile } from "../src/reporter";

/** Just enough of Playwright's TestCase for the reporter's identity math. */
function fakeTest(rootDir: string, retries: number): TestCase {
  return {
    title: "checkout works",
    retries,
    expectedStatus: "passed",
    location: { file: path.join(rootDir, "shop.spec.ts"), line: 1, column: 1 },
    titlePath: () => ["", "chromium", "shop.spec.ts", "checkout works"],
    parent: { project: () => ({ name: "chromium" }) },
  } as unknown as TestCase;
}

function fakeResult(retry: number, status: TestResult["status"]): TestResult {
  return {
    retry,
    status,
    duration: 12.4,
    errors: status === "passed" ? [] : [{ message: "boom", stack: "at x" }],
  } as unknown as TestResult;
}

test("every test_end carries the attempt's retry index, so Peeps can tell a pass after a retry from a clean one", async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), "peeps-reporter-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const plan: PlanFile = {
    peepsUrl: "https://peeps.test",
    rootDir: "e2e",
    runs: [{
      runId: "run-1", path: "e2e/shop.spec.ts", titlePath: "checkout works", pwProject: "chromium",
      credential: { exp: 1, sig: "s" },
    }],
  };
  const planFile = path.join(dir, "plan.json");
  await writeFile(planFile, JSON.stringify(plan));
  process.env.PEEPS_PLAN_FILE = planFile;

  const bodies: Array<{ events: Array<Record<string, unknown>> }> = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (_url: string, init: { body: string }) => {
    bodies.push(JSON.parse(init.body));
    return new Response("{}", { status: 200 });
  }) as unknown as typeof fetch;
  t.after(() => {
    globalThis.fetch = realFetch;
    delete process.env.PEEPS_PLAN_FILE;
  });

  const reporter = new PeepsCiReporter();
  const rootDir = path.join(dir, "e2e");
  reporter.onBegin({ rootDir } as FullConfig, {} as Suite);
  const spec = fakeTest(rootDir, 1);
  reporter.onTestBegin(spec);
  reporter.onTestEnd(spec, fakeResult(0, "failed"));
  reporter.onTestBegin(spec);
  reporter.onTestEnd(spec, fakeResult(1, "passed"));
  await reporter.onEnd();

  const events = bodies.flatMap((b) => b.events);
  assert.deepEqual(
    events.map((e) => [e.type, e.status, e.retry]),
    [
      ["run_start", undefined, undefined],
      ["test_start", undefined, undefined],
      ["test_end", "failed", 0],
      ["test_start", undefined, undefined],
      ["test_end", "passed", 1],
      ["run_end", undefined, undefined],
    ],
  );
});

/** A reporter on a one-test plan, and what it has sent. */
async function reporterFor(t: TestContext, narrowed: boolean) {
  const dir = await mkdtemp(path.join(tmpdir(), "peeps-reporter-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const plan: PlanFile = {
    peepsUrl: "https://peeps.test",
    rootDir: "e2e",
    runs: [{
      runId: "run-1", path: "e2e/shop.spec.ts", titlePath: "checkout works", pwProject: "chromium",
      credential: { exp: 1, sig: "s" },
    }],
    ...(narrowed ? { narrowed } : {}),
  };
  const planFile = path.join(dir, "plan.json");
  await writeFile(planFile, JSON.stringify(plan));
  process.env.PEEPS_PLAN_FILE = planFile;
  const sent: Array<Record<string, unknown>> = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (_url: string, init: { body: string }) => {
    sent.push(...(JSON.parse(init.body) as { events: Array<Record<string, unknown>> }).events);
    return new Response("{}", { status: 200 });
  }) as unknown as typeof fetch;
  t.after(() => {
    globalThis.fetch = realFetch;
    delete process.env.PEEPS_PLAN_FILE;
  });
  const reporter = new PeepsCiReporter();
  const rootDir = path.join(dir, "e2e");
  reporter.onBegin({ rootDir } as FullConfig, {} as Suite);
  return { reporter, spec: fakeTest(rootDir, 1), types: () => sent.map((e) => (e.type === "test_end" ? e.status : e.type)) };
}

test("narrowed: an interrupted attempt is the last, though a retry is left (maxFailures, a global timeout)", async (t) => {
  const { reporter, spec, types } = await reporterFor(t, true);
  reporter.onTestBegin(spec);
  reporter.onTestEnd(spec, fakeResult(0, "interrupted"));
  await reporter.onEnd();
  assert.deepEqual(types(), ["run_start", "test_start", "interrupted", "run_end"]);
});

test("narrowed: a retry the run stopped before reaching closes at the end, on the attempt it has", async (t) => {
  const { reporter, spec, types } = await reporterFor(t, true);
  reporter.onTestBegin(spec);
  reporter.onTestEnd(spec, fakeResult(0, "failed"));
  await reporter.onEnd();
  assert.deepEqual(types(), ["run_start", "test_start", "failed", "run_end"]);
});

test("narrowed: a retry that does run keeps the run open until it ends, and closes once", async (t) => {
  const { reporter, spec, types } = await reporterFor(t, true);
  reporter.onTestBegin(spec);
  reporter.onTestEnd(spec, fakeResult(0, "failed"));
  reporter.onTestBegin(spec);
  reporter.onTestEnd(spec, fakeResult(1, "passed"));
  await reporter.onEnd();
  assert.deepEqual(types(), ["run_start", "test_start", "failed", "test_start", "passed", "run_end"]);
});

test("narrowed: an attempt with no end at all stays open, because nothing says how it finished", async (t) => {
  const { reporter, spec, types } = await reporterFor(t, true);
  reporter.onTestBegin(spec);
  await reporter.onEnd();
  assert.deepEqual(types(), ["run_start", "test_start"]);
});

test("not narrowed: a retry that never ran and an interrupted attempt leave the run open, as today", async (t) => {
  const { reporter, spec, types } = await reporterFor(t, false);
  reporter.onTestBegin(spec);
  reporter.onTestEnd(spec, fakeResult(0, "interrupted"));
  await reporter.onEnd();
  assert.deepEqual(types(), ["run_start", "test_start", "interrupted"]);
});
