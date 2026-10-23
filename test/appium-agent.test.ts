/**
 * Agent mode for an Appium suite: `run_tests` through WebdriverIO, and the
 * reporter's local-results mode it reads them from.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { mochaGrepFromRegex, runAppiumTests, type WdioRunner } from "../src/appium";
import {
  localRunId,
  PeepsAppiumReporter,
  peepsAfterTest,
  resetForTests,
  type AppiumPlanFile,
  type CaptureBrowser,
  type LocalResultsLine,
} from "../src/appium-reporter";
import { readRunnerEnv } from "../src/env";
import { createToolServer } from "../src/tools";

const FIXTURE = path.join(__dirname, "fixtures", "appium");
const MODULES = path.join(__dirname, "..", "node_modules");
const SHA = "0123456789abcdef0123456789abcdef01234567";

function workspace(): { root: string; suite: string } {
  const root = mkdtempSync(path.join(tmpdir(), "peeps-appium-agent-"));
  const suite = path.join(root, "mobile");
  cpSync(FIXTURE, suite, { recursive: true });
  symlinkSync(MODULES, path.join(root, "node_modules"), "dir");
  return { root, suite };
}

function fakeBrowser(over: Partial<CaptureBrowser> = {}): CaptureBrowser {
  return {
    isMobile: true,
    saveScreenshot: async (file: string) => writeFileSync(file, "PNG!"),
    getPageSource: async () => '<?xml version="1.0"?><hierarchy><node text="Sign in"/></hierarchy>',
    getContext: async () => "NATIVE_APP",
    ...over,
  };
}

const LOGIN = (suite: string) => path.join(suite, "test", "specs", "login.spec.ts");

/**
 * What one WebdriverIO worker does with the wrapper config: the reporter
 * sees a passing and a failing test, and the afterTest hook captures the
 * failed one's screen. Driven through the src module (the wrapper loads the
 * same code from dist/).
 */
interface WorkerModule {
  Reporter: new (options: unknown) => { emit(event: string, payload?: Record<string, unknown>): void };
  afterTest: typeof peepsAfterTest;
}

const SRC_WORKER: WorkerModule = { Reporter: PeepsAppiumReporter, afterTest: peepsAfterTest };

async function simulateWorker(spec: string, extra: Record<string, string>, worker = SRC_WORKER): Promise<void> {
  process.env.PEEPS_PLAN_FILE = extra.PEEPS_PLAN_FILE;
  process.env.PEEPS_ARTIFACTS_DIR = extra.PEEPS_ARTIFACTS_DIR;
  resetForTests();
  const reporter = new worker.Reporter({});
  const error = { name: "Error", message: "element (~signIn) still not displayed after 10000ms", stack: "Error: element (~signIn) still not displayed\n    at Context.<anonymous> (login.spec.ts:12:7)" };
  reporter.emit("runner:start", { specs: [spec] });
  reporter.emit("suite:start", { title: "Login", file: spec });
  reporter.emit("test:start", { title: "signs in with a valid account @smoke", file: spec });
  reporter.emit("test:pass", { title: "signs in with a valid account @smoke", file: spec, duration: 900 });
  reporter.emit("suite:start", { title: "Forgot password", file: spec });
  reporter.emit("test:start", { title: "sends a reset link", file: spec });
  (globalThis as { browser?: unknown }).browser = fakeBrowser();
  await worker.afterTest(
    {},
    { test: { title: "sends a reset link", file: spec, titlePath: () => ["Login", "Forgot password", "sends a reset link"] } },
    { passed: false, error },
  );
  delete (globalThis as { browser?: unknown }).browser;
  reporter.emit("test:fail", { title: "sends a reset link", file: spec, duration: 10_000, error });
  reporter.emit("suite:end", { title: "Forgot password" });
  reporter.emit("suite:end", { title: "Login" });
  reporter.emit("runner:end", {});
  delete process.env.PEEPS_PLAN_FILE;
  delete process.env.PEEPS_ARTIFACTS_DIR;
}

test("the reporter's local mode records every test it sees, keyed by a stable local run id", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "peeps-local-"));
  const plan: AppiumPlanFile = { peepsUrl: "http://unused", workspace: "/w", runs: [], resultsDir: path.join(dir, "results") };
  writeFileSync(path.join(dir, "plan.json"), JSON.stringify(plan));
  mkdirSync(path.join(dir, "evidence"));
  const spec = "/w/mobile/test/specs/login.spec.ts";
  await simulateWorker(spec, { PEEPS_PLAN_FILE: path.join(dir, "plan.json"), PEEPS_ARTIFACTS_DIR: path.join(dir, "evidence") });

  const files = readdirSync(path.join(dir, "results"));
  assert.deepEqual(files, [`events-${process.pid}.jsonl`]);
  const lines = readFileSync(path.join(dir, "results", files[0]!), "utf8").trim().split("\n").map((l) => JSON.parse(l) as LocalResultsLine);
  assert.deepEqual(lines.map((l) => [l.path, l.titlePath]), [
    ["mobile/test/specs/login.spec.ts", "Login › signs in with a valid account @smoke"],
    ["mobile/test/specs/login.spec.ts", "Login › Forgot password › sends a reset link"],
  ]);
  const failedId = localRunId("mobile/test/specs/login.spec.ts", "Login › Forgot password › sends a reset link");
  assert.equal(lines[1]!.runId, failedId);
  assert.match(failedId, /^local-[0-9a-f]{16}$/);
  const end = lines[1]!.events.find((e) => e.type === "test_end")!;
  assert.equal(end.status, "failed");
  assert.deepEqual(end.attachments?.map((a) => a.name), ["screenshot.png", "page-source.xml"]);
  assert.deepEqual(readdirSync(path.join(dir, "evidence", "upload")).sort(), [
    `${failedId}-evidence-page-source.xml.dat`,
    `${failedId}-evidence-screenshot.png`,
  ]);
});

test("the agent's grep reaches mocha as a regex, with line terminators spelled as escapes", () => {
  // The server's titleGrep is already a regex; it passes through unchanged.
  const grep = "(?:^| )Login signs in with a valid account @smoke(?: @[^ ]+)*$";
  assert.equal(mochaGrepFromRegex(grep), grep);
  // mocha builds its RegExp from a `.*` match, which stops at a newline.
  assert.equal(mochaGrepFromRegex("a\nb\r\u2028c\u2029"), "a\\nb\\r\\u2028c\\u2029");
});

test("run_tests on an Appium suite runs wdio on that one spec through the wrapper and returns Playwright's result shape", async () => {
  const { root, suite } = workspace();
  const env = readRunnerEnv({ GITHUB_WORKSPACE: root, GITHUB_SHA: SHA, "INPUT_WORKING-DIRECTORY": "mobile", INPUT_FRAMEWORK: "appium" });
  let seen: { wrapper: string; config: Record<string, unknown> } | undefined;
  const runner: WdioRunner = async (wrapper, extra) => {
    const loaded = (await import(pathToFileURL(wrapper).href)) as { config: Record<string, unknown> };
    seen = { wrapper, config: loaded.config };
    const plan = JSON.parse(readFileSync(extra.PEEPS_PLAN_FILE!, "utf8")) as AppiumPlanFile;
    assert.equal(plan.workspace, root);
    assert.deepEqual(plan.runs, []);
    assert.ok(plan.resultsDir);
    // The reporter and hook as WebdriverIO gets them: dist/appium-reporter.js, through the wrapper.
    const reporters = loaded.config.reporters as unknown[];
    const hooks = loaded.config.afterTest as Array<typeof peepsAfterTest>;
    await simulateWorker(LOGIN(suite), extra, {
      Reporter: reporters[reporters.length - 1] as WorkerModule["Reporter"],
      afterTest: hooks[hooks.length - 1]!,
    });
    return { code: 1, stdout: "[0-0] FAILED in Android - file:///…/login.spec.ts\nSpec Files: 0 passed, 1 failed", stderr: "" };
  };
  const result = await runAppiumTests(env, { file: LOGIN(suite), grep: "(?:^| )Login(?: @[^ ]+)*" }, { runner });

  assert.ok(seen);
  assert.equal(path.dirname(seen.wrapper), suite);
  assert.equal(existsSync(seen.wrapper), false);
  assert.deepEqual(seen.config.specs, [pathToFileURL(LOGIN(suite)).href]);
  assert.deepEqual(seen.config.mochaOpts, { ui: "bdd", timeout: 60_000, grep: "(?:^| )Login(?: @[^ ]+)*", invert: false });

  assert.equal(result.exitCode, 1);
  assert.equal(typeof result.durationMs, "number");
  assert.ok(result.results);
  assert.deepEqual(
    result.results.map((r) => ({ title: r.title, file: r.file, line: r.line, status: r.status })),
    [
      { title: "Login › signs in with a valid account @smoke", file: "mobile/test/specs/login.spec.ts", line: 8, status: "passed" },
      { title: "Login › Forgot password › sends a reset link", file: "mobile/test/specs/login.spec.ts", line: 19, status: "failed" },
    ],
  );
  const failed = result.results[1]!;
  assert.equal(failed.error, "element (~signIn) still not displayed after 10000ms");
  assert.match(failed.errorStack!, /login\.spec\.ts:12:7/);
  assert.deepEqual(failed.evidence?.map((e) => e.name), ["screenshot.png", "page-source.xml"]);
  for (const file of failed.evidence ?? []) {
    assert.ok(path.isAbsolute(file.path) && existsSync(file.path), file.path);
  }
  assert.equal(failed.pageSource, '<?xml version="1.0"?><hierarchy><node text="Sign in"/></hierarchy>');
  assert.equal("evidence" in result.results[0]!, false);
  // The run failed, so the tail of WebdriverIO's output comes back too.
  assert.match(result.stdoutTail ?? "", /1 failed/);
});

test("run_tests on an Appium suite with no grep runs the whole spec, and a wdio that cannot start says why", async () => {
  const { root, suite } = workspace();
  const env = readRunnerEnv({ GITHUB_WORKSPACE: root, "INPUT_WORKING-DIRECTORY": "mobile" });
  let mochaOpts: unknown;
  const result = await runAppiumTests(env, { file: LOGIN(suite) }, {
    runner: async (wrapper) => {
      mochaOpts = ((await import(pathToFileURL(wrapper).href)) as { config: Record<string, unknown> }).config.mochaOpts;
      return { code: 1, stdout: "", stderr: "sh: 1: wdio: not found" };
    },
    redact: (t) => t.replace("wdio", "[redacted]"),
  });
  assert.deepEqual(mochaOpts, { ui: "bdd", timeout: 60_000 });
  assert.deepEqual(result.results, []);
  assert.equal(result.stderr, "sh: 1: [redacted]: not found");
});

test("run_tests dispatches by framework: an Appium repository goes to wdio, not playwright", async () => {
  const { root, suite } = workspace();
  const env = readRunnerEnv({ GITHUB_WORKSPACE: root, "INPUT_WORKING-DIRECTORY": "mobile" });
  let ran: string | undefined;
  const server = createToolServer(env, {
    appiumRunner: async (wrapper) => {
      ran = wrapper;
      return { code: 0, stdout: "", stderr: "" };
    },
  });
  const result = (await server.handlers.run_tests!({ file: "mobile/test/specs/login.spec.ts" })) as { exitCode: number; results: unknown[] };
  assert.ok(ran && /\.peeps-[0-9a-f-]+\.wdio\.conf\.mts$/.test(ran));
  assert.equal(path.dirname(ran), suite);
  assert.equal(result.exitCode, 0);
  assert.deepEqual(result.results, []);
  // Still jailed to the workspace.
  await assert.rejects(server.handlers.run_tests!({ file: "../elsewhere.spec.ts" }), /escapes the workspace/);
});
