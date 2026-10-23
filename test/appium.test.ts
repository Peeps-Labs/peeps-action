import { test } from "node:test";
import assert from "node:assert/strict";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import {
  appiumRootDir,
  buildAppiumInventoryRequest,
  collectAppium,
  executeAppiumAndReport,
  junitArtifactName,
  lineOf,
  mochaGrepFor,
  specsForRuns,
  tagsOf,
  wdioConfigPath,
} from "../src/appium";
import type { AppiumCollection } from "../src/appium-collect";
import {
  captureEvidence,
  evidenceFileName,
  mochaHooks,
  pageSourceExtension,
  PeepsAppiumReporter,
  peepsAfterHook,
  peepsAfterTest,
  resetForTests,
  withPeeps,
  type AppiumPlanFile,
  type CaptureBrowser,
} from "../src/appium-reporter";
import { readRunnerEnv, type RunnerEnv } from "../src/env";
import { gitBlobSha } from "../src/inventory";
import { PeepsClient } from "../src/peeps";
import { resolveFramework } from "../src/pytest";
import { plannedTestsOf } from "../src/report";
import type { PlanEntry } from "../src/reporter";

type MochaCtor = new (o: object) => { options: { grep: RegExp } };

const FIXTURE = path.join(__dirname, "fixtures", "appium");
const MODULES = path.join(__dirname, "..", "node_modules");
const SHA = "0123456789abcdef0123456789abcdef01234567";

/**
 * A throwaway copy of the fixture as the job's workspace, suite under
 * `mobile/`, with this repository's node_modules (mocha, tsx) where the
 * customer's would be.
 */
function workspace(): { root: string; suite: string } {
  const root = mkdtempSync(path.join(tmpdir(), "peeps-appium-"));
  const suite = path.join(root, "mobile");
  cpSync(FIXTURE, suite, { recursive: true });
  symlinkSync(MODULES, path.join(root, "node_modules"), "dir");
  return { root, suite };
}

function envFor(root: string, extra: Record<string, string> = {}): RunnerEnv {
  return readRunnerEnv({ GITHUB_WORKSPACE: root, GITHUB_SHA: SHA, ...extra });
}

const run = (runId: string, p: string, titlePath: string): PlanEntry => ({
  runId,
  path: p,
  titlePath,
  pwProject: "",
  credential: { exp: 99, sig: `sig-${runId}` },
});

// ---------------------------------------------------------------------------
// Which framework, which config
// ---------------------------------------------------------------------------

test("framework: auto picks appium for a WebdriverIO directory without a Playwright config", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "peeps-fw-"));
  const at = (extra: Record<string, string> = {}) => resolveFramework(envFor(dir, extra));
  assert.equal(at(), "playwright");
  writeFileSync(path.join(dir, "wdio.conf.ts"), "");
  assert.equal(at(), "appium");
  // A Playwright config beside it keeps the Playwright path.
  writeFileSync(path.join(dir, "playwright.config.ts"), "");
  assert.equal(at(), "playwright");
  // Per-platform configs count too, in every module flavour.
  for (const name of ["wdio.android.conf.ts", "wdio.conf.js", "wdio.conf.mjs", "wdio.conf.cjs"]) {
    const d = mkdtempSync(path.join(tmpdir(), "peeps-fw-"));
    writeFileSync(path.join(d, name), "");
    assert.equal(resolveFramework(envFor(d)), "appium", name);
  }
  // A `config` input named like a WebdriverIO config is one; anything else
  // names a Playwright config, as before.
  const empty = mkdtempSync(path.join(tmpdir(), "peeps-fw-"));
  assert.equal(resolveFramework(envFor(empty, { INPUT_CONFIG: "e2e/wdio.ios.conf.ts" })), "appium");
  assert.equal(resolveFramework(envFor(empty, { INPUT_CONFIG: "pw.config.ts" })), "playwright");
  // The input decides outright; pytest detection is unchanged.
  assert.equal(at({ INPUT_FRAMEWORK: "appium" }), "appium");
  const py = mkdtempSync(path.join(tmpdir(), "peeps-fw-"));
  writeFileSync(path.join(py, "pytest.ini"), "[pytest]\n");
  assert.equal(resolveFramework(envFor(py)), "pytest");
  assert.throws(() => at({ INPUT_FRAMEWORK: "detox" }), /use playwright, pytest, appium or auto/);
});

test("the WebdriverIO config: the input, wdio.conf.*, or the only wdio.*.conf.*", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "peeps-cfg-"));
  const env = (extra: Record<string, string> = {}) => envFor(dir, extra);
  assert.throws(() => wdioConfigPath(env()), /no wdio\.conf\.ts/);
  writeFileSync(path.join(dir, "wdio.android.conf.ts"), "");
  assert.equal(wdioConfigPath(env()), path.join(dir, "wdio.android.conf.ts"));
  writeFileSync(path.join(dir, "wdio.ios.conf.ts"), "");
  assert.throws(() => wdioConfigPath(env()), /several WebdriverIO configs .*wdio\.android\.conf\.ts, wdio\.ios\.conf\.ts/);
  assert.equal(wdioConfigPath(env({ INPUT_CONFIG: "wdio.ios.conf.ts" })), path.join(dir, "wdio.ios.conf.ts"));
  writeFileSync(path.join(dir, "wdio.conf.js"), "");
  assert.equal(wdioConfigPath(env()), path.join(dir, "wdio.conf.js"));
  writeFileSync(path.join(dir, "wdio.conf.ts"), "");
  assert.equal(wdioConfigPath(env()), path.join(dir, "wdio.conf.ts"));
});

// ---------------------------------------------------------------------------
// Collection: mocha loads the specs, nothing runs
// ---------------------------------------------------------------------------

test("collection loads every configured spec into mocha without a session, and the inventory is Playwright's list shape", async () => {
  const { root, suite } = workspace();
  const env = envFor(root, { "INPUT_WORKING-DIRECTORY": "mobile" });
  const collection = await collectAppium(env);
  assert.equal(collection.loader, "tsx");
  // No @wdio/config here: the config's own specs/exclude, globbed.
  assert.equal(collection.specsFrom, "config");
  assert.equal(collection.rootDir, suite);
  // The draft spec is excluded by the config.
  assert.deepEqual(
    collection.specs.map((f) => path.relative(suite, f)).sort(),
    ["test/specs/login.spec.ts", "test/specs/webview.spec.ts"],
  );
  assert.deepEqual(collection.errors, []);
  assert.deepEqual(
    collection.tests.map((t) => [path.relative(suite, t.file), t.titlePath.join(" › "), t.pending]),
    [
      ["test/specs/login.spec.ts", "opens without a describe", false],
      ["test/specs/login.spec.ts", "Login › signs in with a valid account @smoke", false],
      ["test/specs/login.spec.ts", "Login › shows an error for a wrong password (and [brackets])", false],
      ["test/specs/login.spec.ts", "Login › Forgot password › sends a reset link", true],
      ["test/specs/webview.spec.ts", "Checkout web view › pays with a card", false],
      ["test/specs/webview.spec.ts", "Checkout web view › shows totals in EUR", false],
    ],
  );

  const request = await buildAppiumInventoryRequest(env, collection);
  assert.equal(request.framework, "appium");
  assert.equal(request.sha, SHA);
  assert.equal(request.rootDir, "mobile");
  assert.deepEqual(request.collectionErrors, []);
  assert.deepEqual(request.list.config, { rootDir: suite, projects: [] });
  const login = request.list.suites[0]!;
  assert.deepEqual(
    { title: login.title, file: login.file, specs: login.specs },
    {
      title: "test/specs/login.spec.ts",
      file: "test/specs/login.spec.ts",
      specs: [{ title: "opens without a describe", file: "test/specs/login.spec.ts", line: 25, tags: [] }],
    },
  );
  const describe = login.suites![0]!;
  assert.equal(describe.title, "Login");
  assert.equal(describe.line, 7);
  assert.deepEqual(describe.specs![0], {
    title: "signs in with a valid account @smoke",
    file: "test/specs/login.spec.ts",
    line: 8,
    tags: ["smoke"],
  });
  assert.equal(describe.suites![0]!.title, "Forgot password");
  // Identity as Peeps reads the list: repo-relative path + ` › ` title path.
  assert.deepEqual(
    plannedTestsOf(request.list, request.rootDir).map((t) => `${t.path} :: ${t.titlePath}`),
    [
      "mobile/test/specs/login.spec.ts :: opens without a describe",
      "mobile/test/specs/login.spec.ts :: Login › signs in with a valid account @smoke",
      "mobile/test/specs/login.spec.ts :: Login › shows an error for a wrong password (and [brackets])",
      "mobile/test/specs/login.spec.ts :: Login › Forgot password › sends a reset link",
      "mobile/test/specs/webview.spec.ts :: Checkout web view › pays with a card",
      "mobile/test/specs/webview.spec.ts :: Checkout web view › shows totals in EUR",
    ],
  );
  const content = readFileSync(path.join(FIXTURE, "test", "specs", "login.spec.ts"));
  assert.deepEqual(request.files[0], {
    path: "mobile/test/specs/login.spec.ts",
    blobSha: gitBlobSha(content),
    content: content.toString("utf8"),
  });
  assert.deepEqual(request.files.map((f) => f.path), ["mobile/test/specs/login.spec.ts", "mobile/test/specs/webview.spec.ts"]);
});

test("a spec that does not load is a collection error, and none of its tests are listed", async () => {
  const { root, suite } = workspace();
  writeFileSync(
    path.join(suite, "test", "specs", "broken.spec.ts"),
    'describe("Half", () => { it("registered before the throw", () => {}); });\nimport "./not-a-module";\n',
  );
  const env = envFor(root, { "INPUT_WORKING-DIRECTORY": "mobile" });
  const collection = await collectAppium(env);
  assert.deepEqual(collection.errors.map((e) => path.relative(suite, e.file)), ["test/specs/broken.spec.ts"]);
  assert.match(collection.errors[0]!.message, /not-a-module/);
  assert.equal(collection.tests.some((t) => t.file.endsWith("broken.spec.ts")), false);
  assert.equal(collection.tests.length, 6);
  const request = await buildAppiumInventoryRequest(env, collection);
  assert.deepEqual(request.collectionErrors, ["test/specs/broken.spec.ts"]);
  assert.equal(request.files.some((f) => f.path.endsWith("broken.spec.ts")), false);
});

test("a describe body that throws leaves the next spec file's title paths untouched", async () => {
  const { root, suite } = workspace();
  // mocha's bdd interface pushes a describe's suite, runs its body and pops
  // it, with no finally: a throwing body leaves it on the stack.
  writeFileSync(
    path.join(suite, "test", "specs", "a-throws.spec.ts"),
    'describe("Broken", () => {\n  it("never listed", () => {});\n  throw new Error("boom in a describe body");\n});\n',
  );
  // Listed first, so the throwing file loads before the healthy one.
  const config = readFileSync(path.join(suite, "wdio.conf.ts"), "utf8").replace(
    'specs: ["./test/specs/**/*.spec.ts"]',
    'specs: ["./test/specs/a-throws.spec.ts", "./test/specs/login.spec.ts"]',
  );
  writeFileSync(path.join(suite, "wdio.conf.ts"), config);
  const env = envFor(root, { "INPUT_WORKING-DIRECTORY": "mobile" });
  const collection = await collectAppium(env);
  assert.deepEqual(collection.errors.map((e) => path.relative(suite, e.file)), ["test/specs/a-throws.spec.ts"]);
  assert.match(collection.errors[0]!.message, /boom in a describe body/);
  assert.deepEqual(
    collection.tests.map((t) => [path.relative(suite, t.file), t.titlePath.join(" › ")]),
    [
      ["test/specs/login.spec.ts", "opens without a describe"],
      ["test/specs/login.spec.ts", "Login › signs in with a valid account @smoke"],
      ["test/specs/login.spec.ts", "Login › shows an error for a wrong password (and [brackets])"],
      ["test/specs/login.spec.ts", "Login › Forgot password › sends a reset link"],
    ],
  );
});

test("the inventory root climbs to hold a spec outside WebdriverIO's rootDir", () => {
  const root = "/w";
  const env = envFor(root);
  const collection = (specs: string[]): AppiumCollection => ({
    rootDir: "/w/apps/mobile",
    specs,
    tests: [],
    errors: [],
    loader: "tsx",
    specsFrom: "config",
    notes: [],
  });
  assert.equal(appiumRootDir(env, collection(["/w/apps/mobile/test/a.spec.ts"])), "apps/mobile");
  assert.equal(appiumRootDir(env, collection(["/w/apps/mobile/a.ts", "/w/apps/shared/b.ts"])), "apps");
  assert.equal(appiumRootDir(env, collection(["/w/apps/mobile/a.ts", "/w/e2e/b.ts"])), ".");
  assert.throws(() => appiumRootDir(env, collection(["/elsewhere/a.ts"])), /outside the repository/);
});

test("lines come from the titles as written; tags from @words", () => {
  const source = 'describe("A", () => {\n  it("x", () => {});\n});\ndescribe(\'B\', () => {\n  it(`x`, () => {});\n  it(`y ${n}`, () => {});\n});\n';
  assert.equal(lineOf(source, ["A", "x"]), 2);
  // The same title under another describe is found after that describe.
  assert.equal(lineOf(source, ["B", "x"]), 5);
  // A computed title falls back to its describe's line; a computed describe to the file.
  assert.equal(lineOf(source, ["B", "y 1"]), 4);
  assert.equal(lineOf(source, ["nowhere"]), 1);
  assert.deepEqual(tagsOf(["Cart @checkout", "adds @smoke @p1", "mail@example.com"]), ["checkout", "smoke", "p1"]);
});

// ---------------------------------------------------------------------------
// Run mode: planned files and a mocha grep
// ---------------------------------------------------------------------------

test("mocha grep matches each planned full title exactly, metacharacters and all", () => {
  const titles = [
    "Login › shows an error for a wrong password (and [brackets])",
    "Login › Forgot password › sends a reset link",
    "costs $5.00 + tax? ^yes|no",
    "multi\nline",
    "Login › Forgot password › sends a reset link",
  ];
  const grep = mochaGrepFor(titles);
  // Duplicates collapse.
  assert.equal(grep.split("sends a reset link").length, 2);
  // mocha builds its RegExp from the string's `.*` match: no line terminator may survive.
  assert.doesNotMatch(grep, /[\n\r\u2028\u2029]/);
  const mocha = createRequire(__filename)("mocha") as MochaCtor & { default?: MochaCtor };
  const Mocha = mocha.default ?? mocha;
  const re = new Mocha({ grep }).options.grep;
  assert.ok(re instanceof RegExp);
  for (const full of [
    "Login shows an error for a wrong password (and [brackets])",
    "Login Forgot password sends a reset link",
    "costs $5.00 + tax? ^yes|no",
    "multi\nline",
  ]) {
    assert.equal(re.test(full), true, full);
  }
  for (const other of [
    "Login shows an error for a wrong password (and [brackets]) again",
    "Signup Login Forgot password sends a reset link",
    "Login shows an error for a wrong password (and brackets)",
    "yes",
  ]) {
    assert.equal(re.test(other), false, other);
  }
});

test("planned runs are matched to collected spec files; a renamed test runs nothing", () => {
  const env = envFor("/w");
  const collection: AppiumCollection = {
    rootDir: "/w/mobile",
    specs: ["/w/mobile/a.spec.ts", "/w/mobile/b.spec.ts"],
    tests: [
      { file: "/w/mobile/a.spec.ts", titlePath: ["A", "one"], pending: false },
      { file: "/w/mobile/b.spec.ts", titlePath: ["B", "two"], pending: false },
    ],
    errors: [],
    loader: "tsx",
    specsFrom: "config",
    notes: [],
  };
  const { specs, matched, unmatched } = specsForRuns(env, collection, [
    run("r1", "mobile/b.spec.ts", "B › two"),
    run("r2", "mobile/a.spec.ts", "A › gone"),
    // A path Peeps sent that collection never found is never run.
    run("r3", "../etc/passwd", "B › two"),
  ]);
  assert.deepEqual(specs, ["/w/mobile/b.spec.ts"]);
  assert.deepEqual(matched.map((r) => r.runId), ["r1"]);
  assert.deepEqual(unmatched.map((r) => r.runId), ["r2", "r3"]);
});

test("run mode executes only planned (file, title path) pairs: a same-titled test in another planned file is skipped, unreported", async () => {
  const peeps = await fakePeeps();
  try {
    const ws = mkdtempSync(path.join(tmpdir(), "peeps-only-planned-"));
    const ran = path.join(ws, "ran.log");
    const a = path.join(ws, "a.spec.js");
    const b = path.join(ws, "b.spec.js");
    const body = (tag: string, fails = false) =>
      `() => { require("node:fs").appendFileSync(${JSON.stringify(ran)}, "${tag}\\n");${fails ? ' throw new Error("unplanned and failing");' : ""} }`;
    writeFileSync(a, `describe("Login", () => {\n  it("works", ${body("a works")});\n});\n`);
    writeFileSync(
      b,
      `describe("Login", () => {\n  beforeEach(${body("b beforeEach")});\n  it("works", ${body("b works", true)});\n  it("other", ${body("b other")});\n});\n`,
    );
    const runs = [run("r-a", "a.spec.js", "Login › works"), run("r-b", "b.spec.js", "Login › other")];
    // As the action writes it in run mode.
    const dir = mkdtempSync(path.join(tmpdir(), "peeps-plan-"));
    const plan: AppiumPlanFile = { peepsUrl: peeps.url, workspace: ws, runs, onlyPlanned: true };
    writeFileSync(path.join(dir, "plan.json"), JSON.stringify(plan));
    process.env.PEEPS_PLAN_FILE = path.join(dir, "plan.json");
    resetForTests();

    // Both files hold a planned test, and the coarse grep matches "Login works" in each.
    const config = withPeeps(
      { mochaOpts: { ui: "bdd" } },
      { specs: [a, b].map((f) => pathToFileURL(f).href), grep: mochaGrepFor(runs.map((r) => r.titlePath)), onlyPlanned: true },
    );
    // What @wdio/mocha-framework does with mochaOpts: load `require` plugins, merge them in, construct mocha.
    const req = createRequire(__filename);
    const { handleRequires } = req("mocha/lib/cli/run-helpers.js") as { handleRequires: (r: string[]) => Promise<object> };
    const mochaOpts = { ...(config.mochaOpts as Record<string, unknown>) };
    Object.assign(mochaOpts, await handleRequires((mochaOpts.require as string[] | undefined) ?? []));
    const MochaModule = req("mocha") as { default?: unknown };
    const Mocha = (MochaModule.default ?? MochaModule) as new (o: object) => {
      addFile(f: string): void;
      reporter(r: unknown): void;
      loadFilesAsync(): Promise<void>;
      run(cb: (failures: number) => void): { on(e: string, cb: (t: { title: string; file?: string }) => void): void };
    };
    const mocha = new Mocha(mochaOpts);
    mocha.reporter(function silent() {});
    mocha.addFile(a);
    mocha.addFile(b);
    await mocha.loadFilesAsync();
    const outcome: string[] = [];
    const failures = await new Promise<number>((resolve) => {
      const runner = mocha.run(resolve);
      for (const [event, label] of [["pass", "passed"], ["fail", "failed"], ["pending", "skipped"]] as const) {
        runner.on(event, (t) => outcome.push(`${path.basename(t.file ?? "?")} ${t.title} ${label}`));
      }
    });
    assert.deepEqual(outcome.sort(), ["a.spec.js works passed", "b.spec.js other passed", "b.spec.js works skipped"]);
    // The unplanned test never ran (nor the customer's beforeEach for it), and is no failure.
    assert.equal(failures, 0);
    assert.deepEqual(readFileSync(ran, "utf8").trim().split("\n"), ["a works", "b beforeEach", "b other"]);

    // The reporter reports nothing for it: it is not planned.
    const reporter = new PeepsAppiumReporter({});
    reporter.emit("suite:start", { title: "Login", file: b });
    reporter.emit("test:pending", { title: "works", file: b });
    reporter.emit("runner:end", {});
    await synchronised(reporter);
    assert.equal(peeps.received.events.size, 0);
  } finally {
    delete process.env.PEEPS_PLAN_FILE;
    resetForTests();
    peeps.close();
  }
});

test("the planned-only hook is inert outside run mode", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "peeps-plan-"));
  const plan: AppiumPlanFile = { peepsUrl: "http://unused", workspace: "/w", runs: [run("r-a", "a.spec.js", "A › one")] };
  writeFileSync(path.join(dir, "plan.json"), JSON.stringify(plan));
  process.env.PEEPS_PLAN_FILE = path.join(dir, "plan.json");
  resetForTests();
  try {
    let skipped = 0;
    const context = { currentTest: mochaTest(["B", "two"], "/w/b.spec.js"), skip: () => void (skipped += 1) };
    // Report mode (no onlyPlanned in the plan) runs the whole suite.
    mochaHooks.beforeEach.call(context);
    assert.equal(skipped, 0);
    // And the hook is only wired in when asked.
    assert.equal((withPeeps({ mochaOpts: { ui: "bdd" } }, { grep: "x" }).mochaOpts as { require?: unknown }).require, undefined);
    assert.deepEqual(
      (withPeeps({ mochaOpts: { require: ["./setup.ts"] } }, { onlyPlanned: true }).mochaOpts as { require: string[] }).require.slice(0, 1),
      ["./setup.ts"],
    );
  } finally {
    delete process.env.PEEPS_PLAN_FILE;
    resetForTests();
  }
});

// ---------------------------------------------------------------------------
// The wrapper config
// ---------------------------------------------------------------------------

test("withPeeps appends the reporter and hooks to the customer's, and narrows only in run mode", () => {
  const theirs = () => undefined;
  const base = {
    specs: ["./test/**/*.ts"],
    reporters: ["spec", ["junit", { outputDir: "./out" }]],
    afterTest: theirs,
    capabilities: [{ platformName: "Android", "wdio:specs": ["./only.ts"], "wdio:exclude": ["./x.ts"] }],
    mochaOpts: { ui: "bdd", timeout: 1000 },
  };
  const report = withPeeps(base, { junitDir: "/tmp/junit" });
  assert.deepEqual((report.reporters as unknown[]).slice(0, 2), base.reporters);
  assert.equal((report.reporters as unknown[])[2], PeepsAppiumReporter);
  // Theirs is already a junit: a second would write to it.
  assert.equal((report.reporters as unknown[]).length, 3);
  assert.deepEqual(report.afterTest, [theirs, peepsAfterTest]);
  assert.deepEqual(report.afterHook, [peepsAfterHook]);
  assert.equal(report.reporterSyncTimeout, 60_000);
  assert.equal(report.specs, base.specs);
  assert.equal(report.mochaOpts, base.mochaOpts);
  assert.equal(report.capabilities, base.capabilities);

  const run = withPeeps(
    { ...base, reporters: undefined, afterTest: undefined, reporterSyncTimeout: 90_000 },
    { specs: ["file:///w/a.spec.ts"], grep: "^(?:A one)$", junitDir: "/tmp/junit" },
  );
  assert.equal((run.reporters as unknown[])[0], PeepsAppiumReporter);
  const junit = (run.reporters as Array<[string, { outputDir: string; outputFileFormat: (o: { cid: string }) => string }]>)[1]!;
  assert.equal(junit[0], "junit");
  assert.equal(junit[1].outputDir, "/tmp/junit");
  assert.equal(junit[1].outputFileFormat({ cid: "0-1" }), "junit-0-1.xml");
  assert.equal(run.reporterSyncTimeout, 90_000);
  assert.deepEqual(run.specs, ["file:///w/a.spec.ts"]);
  assert.deepEqual(run.exclude, []);
  // Without per-capability lists (agent mode's one file), capability-level
  // specs would win over the given files, so they are dropped.
  assert.deepEqual(run.capabilities, [{ platformName: "Android" }]);
  assert.deepEqual(run.mochaOpts, { ui: "bdd", timeout: 1000, grep: "^(?:A one)$", invert: false });
  assert.throws(() => withPeeps(undefined as never), /must export a `config` object/);
});

test("run mode keeps each capability to its own planned spec files, and leaves out a capability with none", () => {
  const base = {
    specs: ["./test/**/*.ts"],
    exclude: ["./test/**/*.draft.ts"],
    capabilities: [
      { platformName: "Android", "wdio:specs": ["./android/**"], "wdio:exclude": ["./android/x.ts"] },
      { platformName: "iOS", "wdio:specs": ["./ios/**"] },
      { platformName: "Android", "appium:deviceName": "tablet" },
    ],
  };
  const a = "file:///w/android/a.spec.ts";
  const shared = "file:///w/test/shared.spec.ts";
  const config = withPeeps(base, { specs: [a, shared], capabilitySpecs: [[a], [], [shared]], onlyPlanned: true });
  assert.deepEqual(config.specs, [a, shared]);
  assert.deepEqual(config.exclude, []);
  // iOS has no planned spec: it is left out of the run, rather than running Android's.
  assert.deepEqual(config.capabilities, [
    { platformName: "Android", "wdio:specs": [a] },
    { platformName: "Android", "appium:deviceName": "tablet", "wdio:specs": [shared] },
  ]);
  // Lists that do not line up with the config's capabilities are not trusted: the given files run on each.
  const mismatched = withPeeps(base, { specs: [a], capabilitySpecs: [[a]] });
  assert.equal((mismatched.capabilities as unknown[]).length, 3);
  assert.equal((mismatched.capabilities as Array<Record<string, unknown>>).some((c) => "wdio:specs" in c), false);
});

test("collection records each capability's own spec files, as WebdriverIO resolves them", async () => {
  const { root, suite } = workspace();
  const config = readFileSync(path.join(suite, "wdio.conf.ts"), "utf8").replace(
    "capabilities: [\n    {",
    'capabilities: [\n    { platformName: "iOS", "wdio:specs": ["./test/specs/webview.spec.ts"] },\n    {',
  );
  assert.notEqual(config, readFileSync(path.join(suite, "wdio.conf.ts"), "utf8"));
  writeFileSync(path.join(suite, "wdio.conf.ts"), config);
  const env = envFor(root, { "INPUT_WORKING-DIRECTORY": "mobile" });
  const collection = await collectAppium(env);
  assert.deepEqual(
    collection.capabilitySpecs?.map((list) => list.map((f) => path.relative(suite, f)).sort()),
    [["test/specs/webview.spec.ts"], ["test/specs/login.spec.ts", "test/specs/webview.spec.ts"]],
  );

  // Run mode: each capability gets the planned files among its own.
  const plan = [
    run("r-login", "mobile/test/specs/login.spec.ts", "Login › signs in with a valid account @smoke"),
    run("r-web", "mobile/test/specs/webview.spec.ts", "Checkout web view › pays with a card"),
  ];
  const { specs, capabilitySpecs, matched } = specsForRuns(env, collection, plan);
  assert.deepEqual(matched.map((r) => r.runId), ["r-login", "r-web"]);
  assert.deepEqual(specs.map((f) => path.relative(suite, f)), ["test/specs/login.spec.ts", "test/specs/webview.spec.ts"]);
  assert.deepEqual(
    capabilitySpecs?.map((list) => list.map((f) => path.relative(suite, f))),
    [["test/specs/webview.spec.ts"], ["test/specs/login.spec.ts", "test/specs/webview.spec.ts"]],
  );
  // Only the login spec planned: iOS has nothing to run.
  assert.deepEqual(specsForRuns(env, collection, [plan[0]!]).capabilitySpecs?.map((list) => list.length), [0, 1]);
});

test("a planned test no capability runs is not run", () => {
  const env = envFor("/w");
  const collection: AppiumCollection = {
    rootDir: "/w/mobile",
    specs: ["/w/mobile/a.spec.ts", "/w/mobile/orphan.spec.ts"],
    capabilitySpecs: [["/w/mobile/a.spec.ts"]],
    tests: [
      { file: "/w/mobile/a.spec.ts", titlePath: ["A", "one"], pending: false },
      { file: "/w/mobile/orphan.spec.ts", titlePath: ["O", "two"], pending: false },
    ],
    errors: [],
    loader: "tsx",
    specsFrom: "config",
    notes: [],
  };
  const result = specsForRuns(env, collection, [run("r1", "mobile/a.spec.ts", "A › one"), run("r2", "mobile/orphan.spec.ts", "O › two")]);
  assert.deepEqual(result.matched.map((r) => r.runId), ["r1"]);
  assert.deepEqual(result.unmatched.map((r) => r.runId), ["r2"]);
  assert.deepEqual(result.specs, ["/w/mobile/a.spec.ts"]);
});

// ---------------------------------------------------------------------------
// Evidence
// ---------------------------------------------------------------------------

test("evidence files are named as the pytest plugin names them; xml and html travel as .dat", () => {
  assert.equal(evidenceFileName("run-1", "screenshot.png"), "run-1-evidence-screenshot.png");
  assert.equal(evidenceFileName("run-1", "page-source.xml"), "run-1-evidence-page-source.xml.dat");
  assert.equal(evidenceFileName("run-1", "page-source.html"), "run-1-evidence-page-source.html.dat");
  assert.equal(evidenceFileName("run-1", "logs/logcat.txt"), "run-1-evidence-logs-logcat.txt");
  assert.equal(pageSourceExtension('<?xml version="1.0"?><hierarchy/>', "NATIVE_APP"), "xml");
  assert.equal(pageSourceExtension("<AppiumAUT><XCUIElementTypeApplication/></AppiumAUT>", null), "xml");
  assert.equal(pageSourceExtension("<html><body/></html>", "WEBVIEW_com.example"), "html");
  assert.equal(pageSourceExtension('<?xml version="1.0"?><x/>', "WEBVIEW_com.example"), "html");
  assert.equal(pageSourceExtension("<!DOCTYPE html><html>", null), "html");
  assert.equal(pageSourceExtension("<root/>", "NATIVE_APP"), "xml");
});

function fakeBrowser(over: Partial<CaptureBrowser> & { context?: string } = {}): CaptureBrowser {
  return {
    isMobile: true,
    saveScreenshot: async (file: string) => writeFileSync(file, "PNG!"),
    getPageSource: async () => '<?xml version="1.0"?><hierarchy><node text="Pay"/></hierarchy>',
    getContext: async () => over.context ?? "NATIVE_APP",
    ...over,
  };
}

interface Received {
  events: Map<string, Array<Record<string, unknown>>>;
  auth: Set<string>;
  artifacts: string[];
  bodies: Map<string, string>;
  completed: Array<{ batchId: string; body: unknown }>;
}

async function fakePeeps(): Promise<{ url: string; received: Received; close: () => void }> {
  const received: Received = { events: new Map(), auth: new Set(), artifacts: [], bodies: new Map(), completed: [] };
  const read = (req: IncomingMessage) =>
    new Promise<string>((resolve) => {
      let data = "";
      req.on("data", (c: Buffer) => (data += c.toString("utf8")));
      req.on("end", () => resolve(data));
    });
  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://x");
    const text = await read(req);
    const events = url.pathname.match(/^\/api\/v1\/runs\/([^/]+)\/events$/);
    if (events) {
      received.auth.add(req.headers.authorization ?? "");
      const list = received.events.get(events[1]!) ?? [];
      list.push(...(JSON.parse(text) as { events: Array<Record<string, unknown>> }).events);
      received.events.set(events[1]!, list);
    }
    const complete = url.pathname.match(/^\/api\/v1\/ci\/batches\/([^/]+)\/complete$/);
    if (complete) received.completed.push({ batchId: complete[1]!, body: JSON.parse(text) });
    if (url.pathname.endsWith("/artifacts")) {
      received.artifacts.push(url.searchParams.get("path") ?? "");
      received.bodies.set(url.searchParams.get("path") ?? "", text);
    }
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end("{}");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return { url: `http://127.0.0.1:${port}`, received, close: () => server.close() };
}

/** Point this process at a plan, as the action does a worker. */
function usePlan(peepsUrl: string, runs: PlanEntry[], workspaceDir = "/w"): string {
  const dir = mkdtempSync(path.join(tmpdir(), "peeps-plan-"));
  const plan: AppiumPlanFile = { peepsUrl, workspace: workspaceDir, runs };
  writeFileSync(path.join(dir, "plan.json"), JSON.stringify(plan));
  mkdirSync(path.join(dir, "evidence"));
  process.env.PEEPS_PLAN_FILE = path.join(dir, "plan.json");
  process.env.PEEPS_ARTIFACTS_DIR = path.join(dir, "evidence");
  resetForTests();
  return dir;
}

async function synchronised(reporter: PeepsAppiumReporter): Promise<void> {
  for (let i = 0; i < 200 && !reporter.isSynchronised; i++) await new Promise((r) => setTimeout(r, 10));
  assert.equal(reporter.isSynchronised, true);
}

const SPEC = "/w/mobile/test/specs/checkout.spec.ts";
const mochaTest = (titles: string[], file = SPEC) => ({ title: titles.at(-1), file, titlePath: () => titles });

test("the reporter streams each planned test's events, with a failure's evidence on its test_end", async () => {
  const peeps = await fakePeeps();
  try {
    const runs = [
      run("r-pass", "mobile/test/specs/checkout.spec.ts", "Checkout › pays"),
      run("r-fail", "mobile/test/specs/checkout.spec.ts", "Checkout › Card › declines"),
      run("r-skip", "mobile/test/specs/checkout.spec.ts", "Checkout › refunds"),
      run("r-flaky", "mobile/test/specs/checkout.spec.ts", "Checkout › retries"),
    ];
    const dir = usePlan(peeps.url, runs);
    const reporter = new PeepsAppiumReporter({});
    const error = { name: "AssertionError", message: "expected Paid\nreceived Declined", stack: "AssertionError: expected Paid\n    at Context.<anonymous> (checkout.spec.ts:9:5)" };
    reporter.emit("runner:start", { specs: [SPEC] });
    reporter.emit("suite:start", { title: "Checkout", file: SPEC });
    reporter.emit("test:start", { title: "pays", file: SPEC });
    reporter.emit("test:pass", { title: "pays", file: SPEC, duration: 812.4 });
    reporter.emit("test:end", { title: "pays", file: SPEC });
    reporter.emit("suite:start", { title: "Card", file: SPEC });
    reporter.emit("test:start", { title: "declines", file: SPEC });
    // The afterTest hook runs inside the test, before mocha reports the failure.
    (globalThis as { browser?: unknown }).browser = fakeBrowser({ context: "WEBVIEW_com.example.shop", getPageSource: async () => "<html><body>Declined</body></html>" });
    await peepsAfterTest({}, { test: mochaTest(["Checkout", "Card", "declines"]) }, { passed: false, error });
    reporter.emit("test:fail", { title: "declines", file: SPEC, duration: 1500, error });
    reporter.emit("suite:end", { title: "Card" });
    // An unplanned test is logged and otherwise ignored.
    reporter.emit("test:start", { title: "not planned", file: SPEC });
    reporter.emit("test:pass", { title: "not planned", file: SPEC });
    // `it.skip`: pending without a start.
    reporter.emit("test:pending", { title: "refunds", file: SPEC });
    // A retried attempt: a failed test_end without evidence, its capture discarded.
    reporter.emit("test:start", { title: "retries", file: SPEC });
    await peepsAfterTest({}, { test: mochaTest(["Checkout", "retries"]) }, { passed: false, error: new Error("flake") });
    reporter.emit("test:retry", { title: "retries", file: SPEC, error: { message: "flake" } });
    reporter.emit("test:start", { title: "retries", file: SPEC });
    reporter.emit("test:pass", { title: "retries", file: SPEC, duration: 10 });
    reporter.emit("suite:end", { title: "Checkout" });
    reporter.emit("runner:end", {});
    await synchronised(reporter);

    const types = (runId: string) => (peeps.received.events.get(runId) ?? []).map((e) => [e.type, e.status]);
    assert.deepEqual(types("r-pass"), [["run_start", undefined], ["test_start", undefined], ["test_end", "passed"], ["run_end", undefined]]);
    assert.deepEqual(types("r-skip"), [["run_start", undefined], ["test_start", undefined], ["test_end", "skipped"], ["run_end", undefined]]);
    assert.deepEqual(types("r-flaky"), [
      ["run_start", undefined],
      ["test_start", undefined],
      ["test_end", "failed"],
      ["test_start", undefined],
      ["test_end", "passed"],
      ["run_end", undefined],
    ]);
    assert.equal(peeps.received.events.size, 4);
    assert.ok(peeps.received.auth.has("Bearer v1.99.sig-r-fail"));
    const pass = peeps.received.events.get("r-pass")![2]!;
    assert.equal(pass.testName, "pays");
    assert.equal(pass.duration, 812);
    assert.deepEqual(Object.keys(pass).sort(), ["duration", "status", "testName", "timestamp", "type"]);
    const retried = peeps.received.events.get("r-flaky")!;
    assert.equal(retried[2]!.error, "flake");
    assert.equal("attachments" in retried[2]!, false);
    assert.equal("failure" in retried[4]!, false);

    const failed = peeps.received.events.get("r-fail")![2]!;
    assert.deepEqual(failed, {
      type: "test_end",
      timestamp: failed.timestamp,
      testName: "declines",
      status: "failed",
      duration: 1500,
      error: "expected Paid\nreceived Declined",
      errorStack: error.stack,
      failure: { phase: "call", exceptionType: "AssertionError", message: "expected Paid\nreceived Declined", traceback: error.stack },
      attachments: [
        { name: "screenshot.png", path: "data/r-fail-evidence-screenshot.png", size: 4 },
        { name: "page-source.html", path: "data/r-fail-evidence-page-source.html.dat", size: 34 },
      ],
      properties: [{ name: "context", value: "WEBVIEW_com.example.shop" }],
    });
    // Staged for upload exactly where the action looks; the retried attempt's are gone.
    assert.deepEqual(readdirSync(path.join(dir, "evidence", "upload")).sort(), [
      "r-fail-evidence-page-source.html.dat",
      "r-fail-evidence-screenshot.png",
    ]);
  } finally {
    delete (globalThis as { browser?: unknown }).browser;
    peeps.close();
  }
});

test("a failed beforeEach fails every planned test below its suite at setup, with that screen", async () => {
  const peeps = await fakePeeps();
  try {
    const p = "mobile/test/specs/checkout.spec.ts";
    usePlan(peeps.url, [
      run("r-a", p, "Checkout › Card › first"),
      run("r-b", p, "Checkout › Card › Nested › second"),
      run("r-c", p, "Checkout › Other › third"),
    ]);
    const reporter = new PeepsAppiumReporter({});
    const error = { name: "Error", message: "app did not launch", stack: "Error: app did not launch\n    at Context.<anonymous>" };
    reporter.emit("suite:start", { title: "Checkout", file: SPEC });
    reporter.emit("suite:start", { title: "Card", file: SPEC });
    reporter.emit("test:start", { title: "first", file: SPEC });
    (globalThis as { browser?: unknown }).browser = fakeBrowser();
    await peepsAfterHook(
      {},
      { test: { title: '"before each" hook for "first"' }, currentTest: mochaTest(["Checkout", "Card", "first"]) },
      { passed: false, error },
    );
    reporter.emit("hook:end", { title: '"before each" hook for Card', parent: "Card", file: SPEC, error });
    reporter.emit("suite:end", { title: "Card" });
    reporter.emit("suite:end", { title: "Checkout" });
    reporter.emit("runner:end", {});
    await synchronised(reporter);
    const end = (runId: string) => peeps.received.events.get(runId)?.find((e) => e.type === "test_end");
    const first = end("r-a")!;
    assert.equal(first.status, "failed");
    assert.equal(first.error, '"before each" hook for Card failed: app did not launch');
    assert.deepEqual(first.failure, { phase: "setup", exceptionType: "Error", message: "app did not launch", traceback: error.stack });
    assert.deepEqual((first.attachments as Array<{ name: string }>).map((a) => a.name), ["screenshot.png", "page-source.xml"]);
    // Never started by mocha, still reported, under the hook's suite only.
    assert.deepEqual(
      (peeps.received.events.get("r-b") ?? []).map((e) => e.type),
      ["run_start", "test_start", "test_end", "run_end"],
    );
    assert.equal(end("r-b")!.testName, "second");
    assert.equal("attachments" in end("r-b")!, false);
    assert.equal(peeps.received.events.has("r-c"), false);
  } finally {
    delete (globalThis as { browser?: unknown }).browser;
    peeps.close();
  }
});

test("a capture that fails is listed as omitted, and never fails the test", async () => {
  const peeps = await fakePeeps();
  try {
    const file = "/w/mobile/a.spec.ts";
    const dir = usePlan(peeps.url, [run("r-1", "mobile/a.spec.ts", "A › b")]);
    const reporter = new PeepsAppiumReporter({});
    reporter.emit("suite:start", { title: "A", file });
    reporter.emit("test:start", { title: "b", file });
    await captureEvidence("r-1", fakeBrowser({
      saveScreenshot: async () => {
        throw new Error("session deleted\nmore");
      },
    }));
    // A passing test, or one without a plan entry, captures nothing.
    (globalThis as { browser?: unknown }).browser = fakeBrowser();
    await peepsAfterTest({}, { test: mochaTest(["A", "b"], file) }, { passed: true });
    await peepsAfterTest({}, { test: mochaTest(["A", "other"], file) }, { passed: false, error: new Error("x") });
    reporter.emit("test:fail", { title: "b", file, error: { message: "boom" } });
    await synchronised(reporter);
    const end = peeps.received.events.get("r-1")!.find((e) => e.type === "test_end")!;
    assert.deepEqual(end.attachmentsOmitted, [{ name: "screenshot.png", reason: "capture failed: session deleted" }]);
    assert.deepEqual(end.attachments, [{ name: "page-source.xml", path: "data/r-1-evidence-page-source.xml.dat", size: 62 }]);
    // No exception type, no stack: still a failure, with what there is.
    assert.deepEqual(end.failure, { phase: "call", exceptionType: null, message: "boom", traceback: "boom" });
    assert.deepEqual(readdirSync(path.join(dir, "evidence", "upload")), ["r-1-evidence-page-source.xml.dat"]);
  } finally {
    delete (globalThis as { browser?: unknown }).browser;
    peeps.close();
  }
});

test("each run is reported by one worker: a second capability's attempt is logged, not sent", async () => {
  const peeps = await fakePeeps();
  const workerId = process.env.WDIO_WORKER_ID;
  const logs: string[] = [];
  const log = console.log;
  try {
    const file = "/w/mobile/a.spec.ts";
    usePlan(peeps.url, [run("r-1", "mobile/a.spec.ts", "A › one")]);
    const worker = (cid: string, outcome: "test:pass" | "test:fail") => {
      process.env.WDIO_WORKER_ID = cid;
      const reporter = new PeepsAppiumReporter({});
      reporter.emit("suite:start", { title: "A", file });
      reporter.emit("test:start", { title: "one", file });
      reporter.emit(outcome, { title: "one", file, error: { message: "on iOS" } });
      reporter.emit("suite:end", { title: "A" });
      reporter.emit("runner:end", {});
      return reporter;
    };
    console.log = (...args: unknown[]) => void logs.push(args.join(" "));
    const android = worker("0-0", "test:pass");
    const ios = worker("1-0", "test:fail");
    console.log = log;
    await synchronised(android);
    await synchronised(ios);
    const sent = peeps.received.events.get("r-1")!;
    assert.deepEqual(sent.map((e) => [e.type, e.status]), [["run_start", undefined], ["test_start", undefined], ["test_end", "passed"], ["run_end", undefined]]);
    assert.ok(logs.some((l) => /A › one: reported by worker 0-0; this attempt \(worker 1-0\) is not sent/.test(l)), logs.join("\n"));
  } finally {
    console.log = log;
    if (workerId === undefined) delete process.env.WDIO_WORKER_ID;
    else process.env.WDIO_WORKER_ID = workerId;
    peeps.close();
  }
});

test("a specFileRetries retry on the same worker continues the run: the last attempt closes it, a test that passed is not re-sent", async () => {
  const peeps = await fakePeeps();
  const workerId = process.env.WDIO_WORKER_ID;
  try {
    const file = "/w/mobile/a.spec.ts";
    const dir = usePlan(peeps.url, [run("r-flaky", "mobile/a.spec.ts", "A › flaky"), run("r-steady", "mobile/a.spec.ts", "A › steady")]);
    // The worker loads the wrapper config, so withPeeps sees specFileRetries there.
    withPeeps({ specFileRetries: 1 });
    process.env.WDIO_WORKER_ID = "0-0";
    const attempt = async (flaky: "test:pass" | "test:fail") => {
      const reporter = new PeepsAppiumReporter({});
      reporter.emit("suite:start", { title: "A", file });
      reporter.emit("test:start", { title: "steady", file });
      reporter.emit("test:pass", { title: "steady", file, duration: 5 });
      reporter.emit("test:start", { title: "flaky", file });
      if (flaky === "test:fail") {
        (globalThis as { browser?: unknown }).browser = fakeBrowser();
        await peepsAfterTest({}, { test: mochaTest(["A", "flaky"], file) }, { passed: false, error: new Error("flake") });
        delete (globalThis as { browser?: unknown }).browser;
      }
      reporter.emit(flaky, { title: "flaky", file, duration: 7, error: { message: "flake" } });
      reporter.emit("suite:end", { title: "A" });
      reporter.emit("runner:end", {});
      await synchronised(reporter);
    };
    // First attempt: the spec file fails, and WebdriverIO will retry it (same cid).
    await attempt("test:fail");
    // The failed attempt's capture is discarded, as a mocha retry's is.
    assert.deepEqual(readdirSync(path.join(dir, "evidence", "upload")), []);
    await attempt("test:pass");
    const types = (runId: string) => (peeps.received.events.get(runId) ?? []).map((e) => [e.type, e.status]);
    assert.deepEqual(types("r-flaky"), [
      ["run_start", undefined],
      ["test_start", undefined],
      ["test_end", "failed"],
      ["test_start", undefined],
      ["test_end", "passed"],
      ["run_end", undefined],
    ]);
    const retried = peeps.received.events.get("r-flaky")![2]!;
    assert.equal("attachments" in retried, false);
    assert.equal(retried.error, "flake");
    // Passed in the first attempt: closed then, the retry's rerun is not sent.
    assert.deepEqual(types("r-steady"), [["run_start", undefined], ["test_start", undefined], ["test_end", "passed"], ["run_end", undefined]]);
  } finally {
    delete (globalThis as { browser?: unknown }).browser;
    if (workerId === undefined) delete process.env.WDIO_WORKER_ID;
    else process.env.WDIO_WORKER_ID = workerId;
    resetForTests();
    peeps.close();
  }
});

test("with specFileRetries, the last attempt's failure closes the run", async () => {
  const peeps = await fakePeeps();
  const workerId = process.env.WDIO_WORKER_ID;
  try {
    const file = "/w/mobile/a.spec.ts";
    usePlan(peeps.url, [run("r-bad", "mobile/a.spec.ts", "A › bad")]);
    withPeeps({ specFileRetries: 1 });
    process.env.WDIO_WORKER_ID = "0-3";
    for (let i = 0; i < 2; i++) {
      const reporter = new PeepsAppiumReporter({});
      reporter.emit("suite:start", { title: "A", file });
      reporter.emit("test:start", { title: "bad", file });
      reporter.emit("test:fail", { title: "bad", file, error: { message: `attempt ${i + 1}` } });
      reporter.emit("runner:end", {});
      await synchronised(reporter);
    }
    const sent = peeps.received.events.get("r-bad")!;
    assert.deepEqual(sent.map((e) => [e.type, e.status, e.error]), [
      ["run_start", undefined, undefined],
      ["test_start", undefined, undefined],
      ["test_end", "failed", "attempt 1"],
      ["test_start", undefined, undefined],
      ["test_end", "failed", "attempt 2"],
      ["run_end", undefined, undefined],
    ]);
  } finally {
    if (workerId === undefined) delete process.env.WDIO_WORKER_ID;
    else process.env.WDIO_WORKER_ID = workerId;
    resetForTests();
    peeps.close();
  }
});

// ---------------------------------------------------------------------------
// The shared tail: wrapper, uploads, batches
// ---------------------------------------------------------------------------

test("a run writes a wrapper beside the config, uploads what the workers staged, and closes the batch", async () => {
  const peeps = await fakePeeps();
  process.env.PEEPS_API_KEY = "test-key";
  const exitCode = process.exitCode;
  try {
    const { root, suite } = workspace();
    const env = envFor(root, { "INPUT_WORKING-DIRECTORY": "mobile", PEEPS_API_URL: peeps.url });
    const runs = [run("r-1", "mobile/test/specs/login.spec.ts", "Login › signs in with a valid account @smoke")];
    let seen: { wrapper: string; config: Record<string, unknown>; env: Record<string, string> } | undefined;
    await executeAppiumAndReport(env, new PeepsClient(env), {
      configPath: path.join(suite, "wdio.conf.ts"),
      runs,
      batches: [{ batchId: "b-1", batchNumber: 1 }],
      selection: { specs: [path.join(suite, "test", "specs", "login.spec.ts")], grep: mochaGrepFor([runs[0]!.titlePath]) },
      runner: async (wrapper, extra) => {
        // What WebdriverIO would load: the wrapper, importing the customer's TS config.
        const loaded = (await import(pathToFileURL(wrapper).href)) as { config: Record<string, unknown> };
        seen = { wrapper, config: loaded.config, env: extra };
        const plan = JSON.parse(readFileSync(extra.PEEPS_PLAN_FILE!, "utf8")) as AppiumPlanFile;
        assert.equal(plan.workspace, root);
        assert.deepEqual(plan.runs, runs);
        assert.equal(plan.onlyPlanned, true);
        // A worker staged a capture, and one for a run this job does not hold.
        const upload = path.join(extra.PEEPS_ARTIFACTS_DIR!, "upload");
        mkdirSync(upload);
        writeFileSync(path.join(upload, "r-1-evidence-screenshot.png"), "PNG!");
        writeFileSync(path.join(upload, "r-9-evidence-screenshot.png"), "PNG!");
        return 1;
      },
    });
    assert.ok(seen);
    assert.equal(path.dirname(seen.wrapper), suite);
    assert.match(path.basename(seen.wrapper), /^\.peeps-[0-9a-f-]+\.wdio\.conf\.mts$/);
    // Removed afterwards; the customer's config untouched.
    assert.equal(existsSync(seen.wrapper), false);
    assert.equal(readFileSync(path.join(suite, "wdio.conf.ts"), "utf8"), readFileSync(path.join(FIXTURE, "wdio.conf.ts"), "utf8"));
    // The customer's config, with the planned spec as a file URL and the grep.
    const config = seen.config;
    assert.equal(config.port, 4723);
    assert.deepEqual(config.specs, [pathToFileURL(path.join(suite, "test", "specs", "login.spec.ts")).href]);
    // The grep, and the root hook that holds it to the planned (file, title path) pairs.
    assert.deepEqual(config.mochaOpts, {
      ui: "bdd",
      timeout: 60_000,
      grep: "^(?:Login signs in with a valid account @smoke)$",
      invert: false,
      require: [path.join(__dirname, "..", "dist", "appium-reporter.js")],
    });
    assert.equal((config.reporters as unknown[])[0], "spec");
    assert.equal(typeof (config.reporters as unknown[])[1], "function");
    assert.deepEqual(peeps.received.artifacts, ["data/r-1-evidence-screenshot.png"]);
    assert.equal(peeps.received.bodies.get("data/r-1-evidence-screenshot.png"), "PNG!");
    assert.deepEqual(peeps.received.completed, [{ batchId: "b-1", body: { reportUploaded: false } }]);
    // A failing suite fails the job, as it would without Peeps.
    assert.equal(process.exitCode, 1);
  } finally {
    process.exitCode = exitCode;
    peeps.close();
  }
});

test("a WebdriverIO that cannot start still closes its batches and fails the job", async () => {
  const peeps = await fakePeeps();
  process.env.PEEPS_API_KEY = "test-key";
  const exitCode = process.exitCode;
  try {
    const root = mkdtempSync(path.join(tmpdir(), "peeps-appium-"));
    const env = envFor(root, { PEEPS_API_URL: peeps.url });
    await executeAppiumAndReport(env, new PeepsClient(env), {
      // The directory does not exist: the wrapper cannot even be written.
      configPath: path.join(root, "missing", "wdio.conf.js"),
      runs: [],
      batches: [{ batchId: "b-2", batchNumber: 2 }],
    });
    assert.equal(process.exitCode, 1);
    assert.deepEqual(peeps.received.completed, [{ batchId: "b-2", body: { reportUploaded: false } }]);
  } finally {
    process.exitCode = exitCode;
    peeps.close();
  }
});

test("JUnit files travel as .dat under data/", () => {
  assert.equal(junitArtifactName("junit-0-0.xml"), "data/junit-0-0.xml.dat");
  assert.equal(junitArtifactName("junit 0/1.xml"), "data/junit_0_1.xml.dat");
});
