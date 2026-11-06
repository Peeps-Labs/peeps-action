/**
 * The Appium reporter with one job reaching several projects, each with its own run of a test,
 * and the single-project run it must leave as main sent it (golden recorded from main; to record
 * again, on purpose: PEEPS_RECORD_GOLDEN=1). Drives the reporter with WebdriverIO's own events:
 * this repository has no WebdriverIO, and a real capture would drive a device.
 */
import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { cpSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { executeAppiumAndReport, runAppiumReport } from "../src/appium";
import {
  peepsAfterHook,
  peepsAfterTest,
  PeepsAppiumReporter,
  resetForTests,
  withPeeps,
  type CaptureBrowser,
} from "../src/appium-reporter";
import { readRunnerEnv } from "../src/env";
import { PeepsClient } from "../src/peeps";
import type { PlanEntry } from "../src/reporter";
import { announceOf, eventsByRun, fakePeeps, signatureOf, shape, type PeepsRequest } from "./support/ci-job";

const FIXTURE = path.join(__dirname, "fixtures", "appium");
const MODULES = path.join(__dirname, "..", "node_modules");
const SHA = "0123456789abcdef0123456789abcdef01234567";
const GOLDEN = path.join(__dirname, "fixtures", "single-project", "appium.json");

const SUITE = "mobile/test/specs/shop.spec.ts";
const TESTS = ["Shop › pays", "Shop › declines", "Shop › refunds", "Shop › retries", "Shop › Broken › first", "Shop › Broken › second"];
const slug = (title: string) => title.replace(/\W+/g, "_");

function runsFor(batch: string, titles = TESTS): PlanEntry[] {
  return titles.map((titlePath) => {
    const runId = `${batch}-${slug(titlePath)}`;
    return { runId, path: SUITE, titlePath, pwProject: "", credential: { exp: 99, sig: signatureOf(runId) } };
  });
}

function fakeBrowser(captures: string[]): CaptureBrowser {
  return {
    isMobile: true,
    saveScreenshot: async (file: string) => {
      captures.push(`screenshot ${path.basename(file)}`);
      writeFileSync(file, "PNG!");
    },
    getPageSource: async () => {
      captures.push("page source");
      return '<?xml version="1.0"?><hierarchy><node text="Pay"/></hierarchy>';
    },
    getContext: async () => "NATIVE_APP",
  };
}

async function synchronised(reporter: PeepsAppiumReporter) {
  for (let i = 0; i < 300 && !reporter.isSynchronised; i++) await new Promise((r) => setTimeout(r, 10));
  assert.equal(reporter.isSynchronised, true);
}

const ERROR = { name: "AssertionError", message: "expected Paid", stack: "AssertionError: expected Paid\n    at spec:9:5" };
const HOOK_ERROR = { name: "Error", message: "app did not launch", stack: "Error: app did not launch\n    at spec:1:1" };

/** One worker running the spec: a pass, a failure, `it.skip`, a mocha retry and a failed `beforeEach`. */
async function runSpec(file: string, captures: string[]) {
  const mochaTest = (titles: string[]) => ({ title: titles.at(-1), file, titlePath: () => titles });
  (globalThis as { browser?: unknown }).browser = fakeBrowser(captures);
  const reporter = new PeepsAppiumReporter({});
  reporter.emit("runner:start", { specs: [file] });
  reporter.emit("suite:start", { title: "Shop", file });
  reporter.emit("test:start", { title: "pays", file });
  reporter.emit("test:pass", { title: "pays", file, duration: 812.4 });
  reporter.emit("test:start", { title: "declines", file });
  await peepsAfterTest({}, { test: mochaTest(["Shop", "declines"]) }, { passed: false, error: ERROR });
  reporter.emit("test:fail", { title: "declines", file, duration: 1500, error: ERROR });
  reporter.emit("test:pending", { title: "refunds", file });
  reporter.emit("test:start", { title: "retries", file });
  await peepsAfterTest({}, { test: mochaTest(["Shop", "retries"]) }, { passed: false, error: ERROR });
  reporter.emit("test:retry", { title: "retries", file, duration: 3, error: { message: "flake" } });
  reporter.emit("test:start", { title: "retries", file });
  reporter.emit("test:pass", { title: "retries", file, duration: 10 });
  reporter.emit("suite:start", { title: "Broken", file });
  reporter.emit("test:start", { title: "first", file });
  await peepsAfterHook(
    {},
    { test: { title: '"before each" hook for "first"' }, currentTest: mochaTest(["Shop", "Broken", "first"]) },
    { passed: false, error: HOOK_ERROR },
  );
  reporter.emit("hook:end", { title: '"before each" hook for Broken', parent: "Broken", file, error: HOOK_ERROR });
  reporter.emit("suite:end", { title: "Broken" });
  reporter.emit("suite:end", { title: "Shop" });
  reporter.emit("runner:end", {});
  await synchronised(reporter);
  delete (globalThis as { browser?: unknown }).browser;
}

/** The whole Appium tail for `batches` in a throwaway workspace, a worker running the spec. */
async function appiumJob(
  t: TestContext,
  batches: Array<{ name: string; runs: PlanEntry[] }>,
  worker: (root: string, captures: string[]) => Promise<void>,
) {
  const peeps = await fakePeeps(t);
  const root = mkdtempSync(path.join(tmpdir(), "peeps-appium-overlap-"));
  const suite = path.join(root, "mobile");
  cpSync(FIXTURE, suite, { recursive: true });
  symlinkSync(MODULES, path.join(root, "node_modules"), "dir");
  const env = readRunnerEnv({ GITHUB_WORKSPACE: root, GITHUB_SHA: SHA, "INPUT_WORKING-DIRECTORY": "mobile", PEEPS_API_URL: peeps.url });
  const captures: string[] = [];
  const lines: string[] = [];
  let uploadDir = "";
  const saved = { ...process.env };
  const log = console.log;
  const exitCode = process.exitCode;
  process.env.PEEPS_API_KEY = "test-key";
  console.log = (...args: unknown[]) => void lines.push(args.join(" "));
  t.after(() => {
    console.log = log;
    process.env = saved;
    process.exitCode = exitCode;
    resetForTests();
  });
  try {
    await executeAppiumAndReport(env, new PeepsClient(env), {
      configPath: path.join(suite, "wdio.conf.ts"),
      runs: batches.flatMap((b) => b.runs),
      batches: batches.map((b, n) => ({ batchId: `batch-${b.name}`, batchNumber: n + 1, runIds: b.runs.map((r) => r.runId) })),
      runner: async (_config, extra) => {
        Object.assign(process.env, extra);
        delete process.env.WDIO_WORKER_ID;
        resetForTests();
        uploadDir = path.join(extra.PEEPS_ARTIFACTS_DIR!, "upload");
        await worker(root, captures);
        return 1;
      },
    });
  } finally {
    console.log = log;
  }
  process.exitCode = exitCode;
  return { requests: peeps.requests, captures, lines, uploadDir };
}

const spec = (root: string) => path.join(root, SUITE);

function normalized(requests: PeepsRequest[], lines: string[], captures: string[]) {
  const masked = (value: unknown, key = ""): unknown => {
    if (key === "timestamp") return "<time>";
    if (key === "duration") return "<ms>";
    if (Array.isArray(value)) return value.map((v) => masked(v));
    if (value && typeof value === "object") {
      return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, masked(v, k)]));
    }
    return value;
  };
  return {
    events: Object.fromEntries([...eventsByRun(requests)].sort(([a], [b]) => a.localeCompare(b)).map(([runId, sent]) => [runId, masked(sent)])),
    posts: requests.filter((v) => v.pathname.endsWith("/events")).length,
    uploaded: requests.flatMap((v) => (v.artifact ? [v.artifact] : [])).sort(),
    complete: requests.filter((v) => v.pathname.endsWith("/complete")).map((v) => [v.pathname, JSON.parse(v.text) as unknown]),
    captures,
    lines: lines.filter((line) => line.startsWith("[peeps]")).map((line) => line.replace(/http:\/\/127\.0\.0\.1:\d+/, "<peeps>")).sort(),
  };
}

test("one project on Appium sends exactly what main sent", async (t) => {
  const job = await appiumJob(t, [{ name: "only", runs: runsFor("only") }], (root, captures) => runSpec(spec(root), captures));
  const actual = normalized(job.requests, job.lines, job.captures);
  if (process.env.PEEPS_RECORD_GOLDEN) writeFileSync(GOLDEN, JSON.stringify(actual, null, 2) + "\n");
  assert.deepEqual(actual, JSON.parse(readFileSync(GOLDEN, "utf8")));
});

test("two projects: one worker reports both runs of every test, with one capture and each run's own files", async (t) => {
  const job = await appiumJob(
    t,
    [{ name: "a", runs: runsFor("a") }, { name: "b", runs: runsFor("b") }],
    (root, captures) => runSpec(spec(root), captures),
  );
  const sent = eventsByRun(job.requests);
  const CLOSED_PASS = ["run_start", "test_start", "test_end(passed,undefined)", "run_end"];
  const CLOSED_FAIL = ["run_start", "test_start", "test_end(failed,undefined)", "run_end"];
  for (const name of ["a", "b"]) {
    const of = (title: string) => shape(sent.get(`${name}-${slug(title)}`));
    assert.deepEqual(of("Shop › pays"), CLOSED_PASS);
    assert.deepEqual(of("Shop › declines"), CLOSED_FAIL);
    assert.deepEqual(of("Shop › refunds"), ["run_start", "test_start", "test_end(skipped,undefined)", "run_end"], "it.skip closes every entry");
    assert.deepEqual(of("Shop › retries"), ["run_start", "test_start", "test_end(failed,undefined)", "test_start", "test_end(passed,undefined)", "run_end"]);
    assert.deepEqual(of("Shop › Broken › first"), CLOSED_FAIL, "a failed beforeEach closes every entry");
    assert.deepEqual(of("Shop › Broken › second"), CLOSED_FAIL, "and of the test it never started");
    for (const title of TESTS) {
      const runId = `${name}-${slug(title)}`;
      for (const post of job.requests.filter((v) => v.pathname === `/api/v1/runs/${runId}/events`)) {
        assert.equal(post.authorization, `Bearer v1.99.${signatureOf(runId)}`);
      }
    }
    const declined = sent.get(`${name}-Shop_declines`)!.find((e) => e.type === "test_end") as unknown as {
      attachments: Array<{ name: string; path: string; size: number }>;
    };
    assert.deepEqual(declined.attachments, [
      { name: "screenshot.png", path: `data/${name}-Shop_declines-evidence-screenshot.png`, size: 4 },
      { name: "page-source.xml", path: `data/${name}-Shop_declines-evidence-page-source.xml.dat`, size: 62 },
    ]);
    const uploads = job.requests.filter((v) => v.pathname === `/api/v1/ci/batches/batch-${name}/artifacts`).map((v) => v.artifact);
    assert.ok(uploads.length > 0);
    assert.ok(uploads.every((v) => v!.startsWith(`data/${name}-`)), `batch ${name} holds only its own runs' files: ${uploads.join(", ")}`);
  }
  // The device is driven once per failure; the retried attempt's and the two failures'.
  assert.deepEqual(job.captures, [
    "screenshot a-Shop_declines-evidence-screenshot.png", "page source",
    "screenshot a-Shop_retries-evidence-screenshot.png", "page source",
    "screenshot a-Shop_Broken_first-evidence-screenshot.png", "page source",
  ]);
  // Both runs hold the files, and the retried attempt's are gone from both.
  const staged = readdirSync(job.uploadDir).sort();
  assert.ok(staged.includes("b-Shop_declines-evidence-screenshot.png"), staged.join(", "));
  assert.ok(!staged.some((v) => v.includes("Shop_retries")), staged.join(", "));
  assert.equal(statSync(path.join(job.uploadDir, "b-Shop_declines-evidence-screenshot.png")).size, 4);
  assert.ok(job.lines.some((line) => line.startsWith("[peeps] reporting 12 planned run(s) to ")), "the log counts runs");
});

test("a second capability's attempt is not sent for any entry: two capabilities can't split one test", async (t) => {
  const job = await appiumJob(
    t,
    [{ name: "a", runs: runsFor("a", ["Shop › pays"]) }, { name: "b", runs: runsFor("b", ["Shop › pays"]) }],
    async (root) => {
      const file = spec(root);
      const worker = async (cid: string, outcome: "test:pass" | "test:fail") => {
        process.env.WDIO_WORKER_ID = cid;
        const reporter = new PeepsAppiumReporter({});
        reporter.emit("suite:start", { title: "Shop", file });
        reporter.emit("test:start", { title: "pays", file });
        reporter.emit(outcome, { title: "pays", file, error: { message: "on iOS" } });
        reporter.emit("suite:end", { title: "Shop" });
        reporter.emit("runner:end", {});
        await synchronised(reporter);
      };
      await worker("0-0", "test:pass");
      await worker("1-0", "test:fail");
    },
  );
  const sent = eventsByRun(job.requests);
  const passed = ["run_start", "test_start", "test_end(passed,undefined)", "run_end"];
  assert.deepEqual(shape(sent.get("a-Shop_pays")), passed);
  assert.deepEqual(shape(sent.get("b-Shop_pays")), passed);
  assert.equal(job.lines.filter((l) => /reported by worker 0-0; this attempt \(worker 1-0\) is not sent/.test(l)).length, 1);
});

test("a spec file retry continues both runs, and closing the first doesn't stop the next being closed", async (t) => {
  const job = await appiumJob(
    t,
    [{ name: "a", runs: runsFor("a", ["Shop › pays", "Shop › refunds"]) }, { name: "b", runs: runsFor("b", ["Shop › pays", "Shop › refunds"]) }],
    async (root, captures) => {
      const file = spec(root);
      withPeeps({ specFileRetries: 1 });
      process.env.WDIO_WORKER_ID = "0-0";
      (globalThis as { browser?: unknown }).browser = fakeBrowser(captures);
      const attempt = async (pays: "test:pass" | "test:fail") => {
        const reporter = new PeepsAppiumReporter({});
        reporter.emit("suite:start", { title: "Shop", file });
        reporter.emit("test:pending", { title: "refunds", file });
        reporter.emit("test:start", { title: "pays", file });
        reporter.emit(pays, { title: "pays", file, error: { message: "flake" } });
        reporter.emit("suite:end", { title: "Shop" });
        reporter.emit("runner:end", {});
        await synchronised(reporter);
      };
      await attempt("test:fail");
      await attempt("test:pass");
      delete (globalThis as { browser?: unknown }).browser;
    },
  );
  const sent = eventsByRun(job.requests);
  for (const name of ["a", "b"]) {
    assert.deepEqual(shape(sent.get(`${name}-Shop_pays`)), ["run_start", "test_start", "test_end(failed,undefined)", "test_start", "test_end(passed,undefined)", "run_end"]);
    assert.deepEqual(shape(sent.get(`${name}-Shop_refunds`)), ["run_start", "test_start", "test_end(skipped,undefined)", "run_end"], "closed once, by the first attempt");
  }
});

test("a sibling's file that can't be copied is listed as omitted on its run alone", async (t) => {
  const titles = ["Shop › declines"];
  const job = await appiumJob(
    t,
    [{ name: "a", runs: runsFor("a", titles) }, { name: "b", runs: runsFor("b", titles) }],
    async (root, captures) => {
      // A directory where the copy would go.
      mkdirSync(path.join(process.env.PEEPS_ARTIFACTS_DIR!, "upload", "b-Shop_declines-evidence-screenshot.png"), { recursive: true });
      await runSpec(spec(root), captures);
    },
  );
  const end = (name: string) =>
    eventsByRun(job.requests).get(`${name}-Shop_declines`)!.find((e) => e.type === "test_end") as unknown as {
      attachments: Array<{ name: string }>;
      attachmentsOmitted?: Array<{ name: string; reason: string }>;
    };
  assert.deepEqual(end("a").attachments.map((v) => v.name), ["screenshot.png", "page-source.xml"]);
  assert.equal(end("a").attachmentsOmitted, undefined);
  assert.deepEqual(end("b").attachments.map((v) => v.name), ["page-source.xml"]);
  assert.equal(end("b").attachmentsOmitted?.[0]?.name, "screenshot.png");
  assert.match(end("b").attachmentsOmitted![0]!.reason, /^capture failed: /);
});

test("the announce says this action reports to every batch", async (t) => {
  const peeps = await fakePeeps(t);
  const root = mkdtempSync(path.join(tmpdir(), "peeps-appium-announce-"));
  const suite = path.join(root, "mobile");
  cpSync(FIXTURE, suite, { recursive: true });
  symlinkSync(MODULES, path.join(root, "node_modules"), "dir");
  const env = readRunnerEnv({ GITHUB_WORKSPACE: root, GITHUB_SHA: SHA, "INPUT_WORKING-DIRECTORY": "mobile", PEEPS_API_URL: peeps.url });
  const savedKey = process.env.PEEPS_API_KEY;
  const exitCode = process.exitCode;
  process.env.PEEPS_API_KEY = "test-key";
  t.after(() => {
    process.exitCode = exitCode;
    if (savedKey === undefined) delete process.env.PEEPS_API_KEY;
    else process.env.PEEPS_API_KEY = savedKey;
  });
  // No WebdriverIO here, so nothing runs; the announce has gone by then.
  await runAppiumReport(env, new PeepsClient(env));
  process.exitCode = exitCode;
  assert.equal(announceOf(peeps.requests).reportsEveryBatch, true);
});
