import { test } from "node:test";
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
