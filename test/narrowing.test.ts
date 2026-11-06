/**
 * A narrowed pull request run, through the committed action and real Playwright:
 * what ran, and what the reporter sent. Nothing here starts a browser.
 */
import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";

import { prepareCaptureConfig } from "../src/capture-config";
import { readRunnerEnv } from "../src/env";
import { exactGrepFor, isNarrowed } from "../src/narrow";
import { executeAndReport } from "../src/report";
import type { PeepsClient } from "../src/peeps";

const action = path.resolve(__dirname, "../dist/index.js");
const modules = path.resolve(__dirname, "../node_modules");

interface Planned { path: string; titlePath: string; pwProject: string }
interface Sent { type: string; status?: string; error?: string; retry?: number }

const HELPER = `
import { appendFileSync } from "node:fs";
import { test as base } from "@playwright/test";
export const test = base;
export { expect } from "@playwright/test";
test.beforeEach(({}, info) => {
  appendFileSync(process.env.RAN_LOG!, [info.project.name, info.titlePath.join(" > "), info.retry].join("|") + "\\n");
});
`;

async function fixture(t: TestContext, files: Record<string, string>) {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), "peeps-narrow-")));
  t.after(() => rm(root, { recursive: true, force: true }));
  await symlink(modules, path.join(root, "node_modules"), "dir");
  for (const [name, content] of Object.entries(files)) {
    const file = path.join(root, "suite", name);
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, content);
  }
  return root;
}

const key = (v: Planned) => `${v.pwProject}|${v.path}|${v.titlePath}`;

/**
 * Answers an announce as Peeps would. `answer` picks which listed tests are
 * runs and which unmatched, and what else the response says about the batch.
 */
async function fakePeeps(
  t: TestContext,
  answer: (tests: Planned[]) => { runs: Planned[]; unmatched?: Planned[]; narrowed?: boolean; failures?: unknown[] },
) {
  const announces: Array<Record<string, unknown>> = [];
  const completed: string[] = [];
  const completeBodies: string[] = [];
  const sent = new Map<string, Sent[]>();
  const names = new Map<string, string>();
  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    const text = Buffer.concat(chunks).toString();
    let response: unknown = {};
    if (url.pathname === "/api/v1/ci/batches") {
      const input = JSON.parse(text) as { tests: Planned[] };
      announces.push(input as unknown as Record<string, unknown>);
      const { runs, unmatched = [], narrowed, failures = [] } = answer(input.tests);
      response = {
        batches: [{
          projectId: "project", batchId: "batch", batchNumber: 1,
          ...(narrowed === undefined ? {} : { narrowed }),
          runs: runs.map((v, i) => {
            names.set(`run-${i}`, v.titlePath);
            return { ...v, runId: `run-${i}`, credential: { exp: 99, sig: "signature" } };
          }),
          unmatched,
        }],
        failures,
      };
    } else if (url.pathname.endsWith("/complete")) {
      completed.push(url.pathname);
      completeBodies.push(text);
    } else if (url.pathname.endsWith("/events")) {
      const name = names.get(url.pathname.split("/")[4]!) ?? url.pathname;
      sent.set(name, [...(sent.get(name) ?? []), ...(JSON.parse(text) as { events: Sent[] }).events]);
    }
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(response));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise<void>((resolve, reject) => server.close((e) => (e ? reject(e) : resolve()))));
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, announces, completed, completeBodies, sent };
}

async function runAction(root: string, url: string) {
  const env = { ...process.env };
  for (const name of Object.keys(env)) {
    if (/^(?:GITHUB_|GITLAB_|CI_|ACTIONS_|INPUT_|PEEPS_)/.test(name)) delete env[name];
  }
  const ranLog = path.join(root, "ran.log");
  Object.assign(env, {
    GITHUB_WORKSPACE: root, GITHUB_SHA: "0123456789abcdef0123456789abcdef01234567",
    GITHUB_REF: "refs/pull/1/merge", INPUT_MODE: "report", INPUT_FRAMEWORK: "playwright",
    INPUT_CONFIG: "suite/playwright.config.ts", PEEPS_API_URL: url, PEEPS_API_KEY: "fake-test-key",
    RUNNER_TEMP: root, RAN_LOG: ranLog,
  });
  const child = spawn(process.execPath, [action], { cwd: root, env, stdio: ["ignore", "pipe", "pipe"] });
  let output = "";
  child.stdout.on("data", (v: Buffer) => { output += v.toString(); });
  child.stderr.on("data", (v: Buffer) => { output += v.toString(); });
  const timer = setTimeout(() => child.kill("SIGKILL"), 90_000);
  const code = await new Promise<number | null>((resolve, reject) => {
    child.on("error", reject);
    child.on("close", resolve);
  }).finally(() => clearTimeout(timer));
  const log = await readFile(ranLog, "utf8").catch(() => "");
  return { code, output, ran: log.trim().split("\n").filter(Boolean) };
}

/** `path` and `titlePath` of the tests this answer selects. */
const pick = (tests: Planned[], ...wanted: string[]) => {
  const out = tests.filter((v) => wanted.includes(`${v.pwProject}|${v.path}|${v.titlePath}`) || wanted.includes(v.titlePath));
  assert.equal(out.length, wanted.length, `picked ${out.map(key).join(", ")} for ${wanted.join(", ")}`);
  return out;
};

const shape = (events: Sent[] | undefined) =>
  (events ?? []).map((e) => (e.type === "test_end" ? `${e.status}#${e.retry}` : e.type));

// ---------------------------------------------------------------------------
// When to narrow
// ---------------------------------------------------------------------------

test("a response narrows only when every batch says so and no project failed", () => {
  const batch = (narrowed?: unknown) => ({ narrowed, runs: [], unmatched: [] });
  assert.equal(isNarrowed({ batches: [batch(true)], failures: [] }), true);
  assert.equal(isNarrowed({ batches: [batch(true), batch(true)] }), true);
  assert.equal(isNarrowed({ batches: [] , failures: [] }), false, "no batch is no evidence");
  assert.equal(isNarrowed({ batches: [batch()], failures: [] }), false, "an old server strips the field");
  assert.equal(isNarrowed({ batches: [batch(true), batch()], failures: [] }), false, "mixed");
  assert.equal(isNarrowed({ batches: [batch(false)], failures: [] }), false);
  assert.equal(isNarrowed({ batches: [batch("true")], failures: [] }), false, "only the boolean counts");
  assert.equal(
    isNarrowed({ batches: [batch(true)], failures: [{ projectId: "b", error: "batch_failed" }] }),
    false,
    "another project's tests are in no batch, so exact selection would drop them",
  );
});

test("exactGrepFor binds project, file, original titles and complete tags, and ignores case in nothing", () => {
  const listed = (over: { file: string; titles: string[]; tags?: string[]; pwProject?: string }) => ({
    path: `e2e/${over.file}`,
    titlePath: over.titles.join(" › "),
    pwProject: over.pwProject ?? "",
    tags: [],
    ...over,
  });
  const one = listed({ file: "a/x.spec.ts", titles: ["Group", "one"], tags: ["@d", "@two words"], pwProject: "chromium" });
  const two = listed({ file: "b/y.spec.ts", titles: ["two (2) [x]"] });
  const source = exactGrepFor([one, two], [one, two, listed({ file: "c.spec.ts", titles: ["unselected"] })]);
  const delimited = /^\/(.*)\/([gi]*)$/.exec(source);
  assert.ok(delimited, "Playwright reads an undelimited --grep as case-insensitive");
  assert.equal(delimited[2], "");
  const re = new RegExp(delimited[1]!, delimited[2]);
  assert.equal(re.test(" chromium a/x.spec.ts Group one"), true);
  assert.equal(re.test(" chromium a/x.spec.ts Group @d one @two words"), true, "tags sit after each title they belong to");
  assert.equal(re.test(" chromium a/x.spec.ts Group one @other"), false, "a tag this test does not have");
  assert.equal(re.test(" firefox a/x.spec.ts Group one"), false, "another project");
  assert.equal(re.test(" chromium b/y.spec.ts Group one"), false, "another file");
  assert.equal(re.test(" chromium a/x.spec.ts group one"), false, "another title by case");
  assert.equal(re.test(" chromium a/x.spec.ts Group one more"), false, "a longer title");
  assert.equal(re.test("  b/y.spec.ts two (2) [x]"), true, "no project name");
  assert.equal(re.test("  b/y.spec.ts two (2) [y]"), false, "metacharacters are literal");
  assert.equal(re.test("  c.spec.ts unselected"), false);
  // A line terminator would stop Playwright's own `/(.*)/` parse of the pattern.
  const lines = listed({ file: "a.ts", titles: ["two\nlines"] });
  assert.match(exactGrepFor([lines], [lines]), /^\/.*\/$/);
});

// ---------------------------------------------------------------------------
// Exact selection, through real Playwright
// ---------------------------------------------------------------------------

const REPEATED = {
  "helper.ts": HELPER,
  "playwright.config.ts": `import { defineConfig } from "@playwright/test";
export default defineConfig({ retries: 0, workers: 1, reporter: "line", projects: [
  { name: "setup", testDir: "./specs/setup" },
  { name: "one", testDir: "./specs/a", dependencies: ["setup"] },
  { name: "two", testDir: "./specs/b" },
  { name: "both", testDir: "./specs" , testIgnore: /setup/ },
] });\n`,
  "specs/setup/s.spec.ts": `import { test } from "../../helper";\ntest("prepares", async () => {});\n`,
  "specs/a/x.spec.ts": `import { test } from "../../helper";
test("X", async () => {});
test("Y", async () => { throw new Error("a/Y was not selected"); });
test("checkout", async () => {});
test("Checkout", async () => { throw new Error("a/Checkout differs only by case"); });
test("tagged", { tag: "@smoke" }, async () => {});
test.describe("tagged group", { tag: "@team" }, () => {
  test("inner", async () => {});
});
test("(meta) [chars]", async () => {});
`,
  "specs/b/x.spec.ts": `import { test } from "../../helper";
test("X", async () => { throw new Error("b/X was not selected"); });
test("Y", async () => {});
`,
};

test("selecting a/X and b/Y admits neither b/X nor a/Y, nor the same file under another project; a project's testDir differing from rootDir binds", async (t) => {
  const root = await fixture(t, REPEATED);
  const peeps = await fakePeeps(t, (tests) => ({
    narrowed: true,
    runs: pick(tests,
      "one|suite/specs/a/x.spec.ts|X",
      "two|suite/specs/b/x.spec.ts|Y",
      "one|suite/specs/a/x.spec.ts|checkout",
      "one|suite/specs/a/x.spec.ts|tagged",
      "one|suite/specs/a/x.spec.ts|tagged group › inner",
    ),
    unmatched: pick(tests, "one|suite/specs/a/x.spec.ts|(meta) [chars]"),
  }));
  const result = await runAction(root, peeps.url);
  assert.equal(result.code, 0, result.output);
  assert.equal(peeps.announces[0]!.canNarrow, true);
  assert.deepEqual(result.ran.map((v) => v.replace(/\|0$/, "")).sort(), [
    "one|specs/a/x.spec.ts > (meta) [chars]",
    "one|specs/a/x.spec.ts > X",
    "one|specs/a/x.spec.ts > checkout",
    "one|specs/a/x.spec.ts > tagged",
    "one|specs/a/x.spec.ts > tagged group > inner",
    "setup|specs/setup/s.spec.ts > prepares",
    "two|specs/b/x.spec.ts > Y",
  ].sort());
  // An unmatched test runs and is reported to no one.
  assert.equal(peeps.sent.has("(meta) [chars]"), false);
  assert.deepEqual(shape(peeps.sent.get("X")), ["run_start", "test_start", "passed#0", "run_end"]);
  assert.deepEqual(peeps.completed, ["/api/v1/ci/batches/batch/complete"]);
  assert.deepEqual(peeps.completeBodies, ['{"reportUploaded":true}'], "it narrowed: nothing to say");
});

test("binding holds with no project name, a top-level testDir as rootDir, and a project outside it", async (t) => {
  const root = await fixture(t, {
    "helper.ts": HELPER,
    "playwright.config.ts": `import { defineConfig } from "@playwright/test";
export default defineConfig({ testDir: "./specs", retries: 0, workers: 1, reporter: "line", projects: [
  { },
  { name: "out", testDir: "./other" },
] });\n`,
    "specs/x.spec.ts": `import { test } from "../helper";\ntest("kept", async () => {});\ntest("dropped", async () => { throw new Error("not selected"); });\n`,
    "other/z.spec.ts": `import { test } from "../helper";\ntest("kept", async () => {});\ntest("dropped", async () => { throw new Error("not selected"); });\n`,
  });
  const peeps = await fakePeeps(t, (tests) => ({
    narrowed: true,
    runs: tests.filter((v) => v.titlePath === "kept"),
  }));
  const result = await runAction(root, peeps.url);
  assert.equal(result.code, 0, result.output);
  assert.deepEqual(result.ran.sort(), ["|x.spec.ts > kept|0", "out|../other/z.spec.ts > kept|0"].sort());
});

test("complete tag values and a literal separator in a title select their test; a title merely ending like a tag is not admitted", async (t) => {
  const root = await fixture(t, {
    "helper.ts": HELPER,
    "playwright.config.ts": outcomesConfig("retries: 0"),
    "specs/t.spec.ts": `import { test } from "../helper";
test("spaced tag", { tag: "@two words" }, async () => {});
test.describe("spaced group", { tag: "@team a" }, () => {
  test("inner", { tag: ["@two words", "@plain"] }, async () => {});
});
test("first › second", async () => {});
test("X", async () => {});
test("X @wip", async () => { throw new Error("paused, not selected"); });
test("spaced tag @two", async () => { throw new Error("not selected"); });
`,
  });
  const peeps = await fakePeeps(t, (tests) => ({
    narrowed: true,
    runs: pick(tests, "spaced tag", "spaced group › inner", "first › second", "X"),
  }));
  const result = await runAction(root, peeps.url);
  assert.equal(result.code, 0, result.output);
  assert.deepEqual(result.ran.sort(), [
    "|t.spec.ts > X|0",
    "|t.spec.ts > first › second|0",
    "|t.spec.ts > spaced group > inner|0",
    "|t.spec.ts > spaced tag|0",
  ]);
});

test("a spec that does not load fails a narrowed Playwright job, whichever tests were selected", async (t) => {
  const root = await fixture(t, {
    "helper.ts": HELPER,
    "playwright.config.ts": outcomesConfig("retries: 0"),
    "specs/ok.spec.ts": `import { test } from "../helper";\ntest("fine", async () => {});\n`,
    "specs/broken.spec.ts": `import "./not-a-module";\n`,
  });
  const peeps = await fakePeeps(t, (tests) => ({ narrowed: true, runs: tests }));
  const result = await runAction(root, peeps.url);
  assert.notEqual(result.code, 0, result.output);
  assert.match(result.output, /not-a-module/);
});

test("an empty narrowed plan runs nothing and closes its batch", async (t) => {
  const root = await fixture(t, REPEATED);
  const peeps = await fakePeeps(t, () => ({ narrowed: true, runs: [] }));
  const result = await runAction(root, peeps.url);
  assert.equal(result.code, 0, result.output);
  assert.deepEqual(result.ran, []);
  assert.deepEqual(peeps.completed, ["/api/v1/ci/batches/batch/complete"]);
  assert.equal(peeps.sent.size, 0);
});

// ---------------------------------------------------------------------------
// A run that was not narrowed changes in nothing
// ---------------------------------------------------------------------------

const OUTCOMES = `import { test, expect } from "../helper";
test("skips", async () => { test.skip(); });
test.skip("declared skip", async () => {});
test("expected failure", async () => { test.fail(); expect(1).toBe(2); });
test("unexpected pass", async () => { test.fail(); });
test("flaky", async ({}, info) => { expect(info.retry).toBe(1); });
`;

const outcomesConfig = (retries: string) => `import { defineConfig } from "@playwright/test";
export default defineConfig({ testDir: "./specs", workers: 1, reporter: "line", ${retries} });\n`;

for (const [name, extra] of [
  ["an old server's answer", {}],
  ["a mixed answer", { narrowed: false }],
  ["another project's failure", { narrowed: true, failures: [{ projectId: "b", error: "batch_failed" }] }],
] as Array<[string, { narrowed?: boolean; failures?: unknown[] }]>) {
  test(`${name} runs the whole suite as today, reporter included`, async (t) => {
    const root = await fixture(t, {
      "helper.ts": HELPER,
      "playwright.config.ts": outcomesConfig("retries: 1"),
      "specs/o.spec.ts": OUTCOMES,
    });
    const peeps = await fakePeeps(t, (tests) => ({ ...extra, runs: tests.filter((v) => v.titlePath !== "flaky") }));
    const result = await runAction(root, peeps.url);
    assert.equal(result.code, 1, result.output);
    assert.equal(result.ran.filter((v) => v.includes("> flaky|")).length, 2, "the unplanned test still ran");
    // Today's reporter: a skip with a retry left never closes; a test.fail() sends its raw status.
    assert.deepEqual(shape(peeps.sent.get("skips")), ["run_start", "test_start", "skipped#0"]);
    assert.deepEqual(shape(peeps.sent.get("expected failure")), ["run_start", "test_start", "failed#0"]);
    assert.deepEqual(shape(peeps.sent.get("unexpected pass")), ["run_start", "test_start", "passed#0", "run_end", "test_start", "passed#1", "run_end"]);
    // A batch said narrowed and everything ran: that is the one case here the server must hear about.
    assert.deepEqual(peeps.completeBodies, [extra.narrowed === true ? '{"reportUploaded":true,"ranFullSuite":true}' : '{"reportUploaded":true}']);
  });
}

test("with no retries in the config and no narrowing, no retry is added", async (t) => {
  const root = await fixture(t, {
    "helper.ts": HELPER,
    "playwright.config.ts": outcomesConfig(""),
    "specs/o.spec.ts": OUTCOMES,
  });
  const peeps = await fakePeeps(t, (tests) => ({ runs: tests }));
  const result = await runAction(root, peeps.url);
  assert.equal(result.code, 1, result.output);
  assert.deepEqual(shape(peeps.sent.get("flaky")), ["run_start", "test_start", "failed#0", "run_end"]);
  assert.deepEqual(peeps.completeBodies, ['{"reportUploaded":true}']);
});

test("the capture wrapper says nothing about retries unless asked", async (t) => {
  const root = await fixture(t, { "playwright.config.ts": outcomesConfig("") });
  const env = readRunnerEnv({ GITHUB_WORKSPACE: root, GITHUB_SHA: "0".repeat(40), INPUT_CONFIG: "suite/playwright.config.ts", "INPUT_WORKING-DIRECTORY": "." });
  const plain = await prepareCaptureConfig(env);
  assert.doesNotMatch(await readFile(plain.configPath, "utf8"), /retries/);
  await plain.cleanup();
  const narrowed = await prepareCaptureConfig(env, { defaultRetries: 1 });
  assert.match(await readFile(narrowed.configPath, "utf8"), /config\.retries === undefined \? \{ retries: 1 \}/);
  await narrowed.cleanup();
});

// ---------------------------------------------------------------------------
// The reporter on a narrowed run, and the default retry
// ---------------------------------------------------------------------------

test("narrowed, with the config's retries unset: one retry, skips close, test.fail() sends its expected outcome", async (t) => {
  const root = await fixture(t, {
    "helper.ts": HELPER,
    "playwright.config.ts": outcomesConfig(""),
    "specs/o.spec.ts": OUTCOMES,
  });
  const peeps = await fakePeeps(t, (tests) => ({ narrowed: true, runs: tests }));
  const result = await runAction(root, peeps.url);
  assert.equal(result.code, 1, "an unexpected pass still fails the job, as Playwright says\n" + result.output);
  assert.deepEqual(shape(peeps.sent.get("flaky")), ["run_start", "test_start", "failed#0", "test_start", "passed#1", "run_end"]);
  // A skip closes at once though a retry is left: Playwright will not run it again.
  assert.deepEqual(shape(peeps.sent.get("skips")), ["run_start", "test_start", "skipped#0", "run_end"]);
  assert.deepEqual(shape(peeps.sent.get("declared skip")), ["run_start", "test_start", "skipped#0", "run_end"]);
  // Failing as expected is a pass, with no failure text beside it.
  const expected = peeps.sent.get("expected failure");
  assert.deepEqual(shape(expected), ["run_start", "test_start", "passed#0", "run_end"]);
  assert.equal(expected!.find((e) => e.type === "test_end")!.error, undefined);
  // Passing when it should fail is a failure, retried as Playwright retries it.
  const unexpected = peeps.sent.get("unexpected pass");
  assert.deepEqual(shape(unexpected), ["run_start", "test_start", "failed#0", "test_start", "failed#1", "run_end"]);
  assert.match(unexpected!.find((e) => e.type === "test_end")!.error!, /Expected to fail, but passed/);
});

test("narrowed, a skip at retries 0 closes too, and the config's own retries stand", async (t) => {
  const root = await fixture(t, {
    "helper.ts": HELPER,
    "playwright.config.ts": outcomesConfig("retries: 0"),
    "specs/o.spec.ts": OUTCOMES,
  });
  const peeps = await fakePeeps(t, (tests) => ({ narrowed: true, runs: tests }));
  await runAction(root, peeps.url);
  assert.deepEqual(shape(peeps.sent.get("skips")), ["run_start", "test_start", "skipped#0", "run_end"]);
  assert.deepEqual(shape(peeps.sent.get("flaky")), ["run_start", "test_start", "failed#0", "run_end"]);
});

const SERIAL = `import { test, expect } from "../helper";
test.describe.serial("group", () => {
  test("first", async ({}, info) => { expect(info.retry >= Number(process.env.FIRST_PASSES_AT ?? 0)).toBe(true); });
  test("middle", async () => { throw new Error("not selected"); });
  test("last", async () => {});
});
`;

test("a serial prerequisite that keeps failing: selected tests keep their order, and the dependant closes as skipped on its last attempt", async (t) => {
  const root = await fixture(t, {
    "helper.ts": HELPER,
    "playwright.config.ts": outcomesConfig(""),
    "specs/s.spec.ts": SERIAL.replace('Number(process.env.FIRST_PASSES_AT ?? 0)', "99"),
  });
  const peeps = await fakePeeps(t, (tests) => ({ narrowed: true, runs: pick(tests, "group › first", "group › last") }));
  const result = await runAction(root, peeps.url);
  assert.equal(result.code, 1, result.output);
  assert.deepEqual(result.ran, ["|s.spec.ts > group > first|0", "|s.spec.ts > group > first|1"]);
  assert.deepEqual(shape(peeps.sent.get("group › first")), ["run_start", "test_start", "failed#0", "test_start", "failed#1", "run_end"]);
  // A serial skip with a retry left is NOT final: Playwright retries the whole group.
  const last = shape(peeps.sent.get("group › last"));
  assert.deepEqual(last.filter((v) => v.startsWith("skipped") || v === "run_end"), ["skipped#0", "skipped#1", "run_end"]);
});

test("a serial prerequisite that passes on retry: the dependant's early skip does not close it", async (t) => {
  const root = await fixture(t, {
    "helper.ts": HELPER,
    "playwright.config.ts": outcomesConfig(""),
    "specs/s.spec.ts": SERIAL.replace('Number(process.env.FIRST_PASSES_AT ?? 0)', "1"),
  });
  const peeps = await fakePeeps(t, (tests) => ({ narrowed: true, runs: pick(tests, "group › first", "group › last") }));
  const result = await runAction(root, peeps.url);
  assert.equal(result.code, 0, result.output);
  assert.deepEqual(result.ran, [
    "|s.spec.ts > group > first|0",
    "|s.spec.ts > group > first|1",
    "|s.spec.ts > group > last|1",
  ]);
  const last = shape(peeps.sent.get("group › last"));
  assert.deepEqual(last.filter((v) => v !== "run_start" && v !== "test_start"), ["skipped#0", "passed#1", "run_end"]);
});

// ---------------------------------------------------------------------------
// A narrowing that can't be trusted falls back to the full run
// ---------------------------------------------------------------------------

/** The tests of a fixture where `kept` is selected and `other`, not selected, fails. */
const FALLBACK = (specs: string) => ({
  "helper.ts": HELPER,
  "playwright.config.ts": outcomesConfig(""),
  "specs/t.spec.ts": `import { test } from "../helper";\n${specs}
test("other", async () => { throw new Error("not selected"); });\n`,
});

/** What every fallback looks like: the whole suite as today, no default retry, the batch closed. */
function assertFullRun(result: { code: number | null; output: string; ran: string[] }, peeps: { completed: string[]; completeBodies: string[] }) {
  assert.match(result.output, /\[peeps\] not narrowing, running the full suite: /);
  assert.doesNotMatch(result.output, /narrowed to \d+ test/, "only a narrowing that held says so");
  assert.ok(result.ran.includes("|t.spec.ts > other|0"), result.output);
  assert.equal(result.ran.filter((v) => v.includes("> other|")).length, 1, "no default retry");
  assert.deepEqual(peeps.completed, ["/api/v1/ci/batches/batch/complete"]);
  assert.deepEqual(peeps.completeBodies, ['{"reportUploaded":true,"ranFullSuite":true}'], "the server hears it ran everything");
}

test("a selection too large for one argument runs the full suite instead of failing the job", async (t) => {
  const root = await fixture(t, FALLBACK(
    `for (let i = 0; i < 400; i++) test(\`selected \${i} \${"x".repeat(200)}\`, async () => {});`,
  ));
  const peeps = await fakePeeps(t, (tests) => ({ narrowed: true, runs: tests.filter((v) => v.titlePath !== "other") }));
  const result = await runAction(root, peeps.url);
  assertFullRun(result, peeps);
  assert.match(result.output, /grep is \d+ bytes/);
});

test("a spawn that throws still closes the batches: the job goes red, not unreported", async (t) => {
  const root = await fixture(t, { "playwright.config.ts": outcomesConfig("") });
  const env = readRunnerEnv({ GITHUB_WORKSPACE: root, GITHUB_SHA: "0".repeat(40), INPUT_CONFIG: "suite/playwright.config.ts", RUNNER_TEMP: root });
  const posts: string[] = [];
  const peeps = { post: async (p: string) => { posts.push(p); return {}; }, postBytes: async () => {} } as unknown as PeepsClient;
  const exitCode = process.exitCode;
  t.after(() => { process.exitCode = exitCode; });
  // Past every system's argument limit, so spawn throws E2BIG where it is called.
  await executeAndReport(env, peeps, {
    rootDir: "suite",
    runs: [],
    batches: [{ batchId: "batch", batchNumber: 1 }],
    selection: { files: [], grep: "x".repeat(8 * 1024 * 1024) },
  });
  assert.deepEqual(posts, ["/api/v1/ci/batches/batch/complete"]);
  assert.equal(process.exitCode, 1);
});

test("a selected test whose grep would not select it runs the full suite: a describe tag holding a double space", async (t) => {
  const root = await fixture(t, FALLBACK(
    `test.describe("group", { tag: "@team  a" }, () => { test("kept", async () => {}); });\ntest("also", async () => {});`,
  ));
  const peeps = await fakePeeps(t, (tests) => ({ narrowed: true, runs: pick(tests, "group › kept", "also") }));
  const result = await runAction(root, peeps.url);
  assertFullRun(result, peeps);
  assert.ok(result.ran.includes("|t.spec.ts > group > kept|0"), "the selected test ran too");
  assert.match(result.output, /not selected by its grep/);
});

for (const [name, specs] of [
  ["a title ending like its tag", `test("kept", { tag: "@wip" }, async () => {});\ntest("kept @wip", async () => {});`],
  ["a describe starting like its tag", `test("kept", { tag: "@team" }, async () => {});\ntest.describe("@team foo", () => { test("kept", async () => {}); });`],
] as Array<[string, string]>) {
  test(`a grep that also admits ${name} runs the full suite`, async (t) => {
    const root = await fixture(t, FALLBACK(specs));
    const peeps = await fakePeeps(t, (tests) => ({ narrowed: true, runs: pick(tests, "|suite/specs/t.spec.ts|kept") }));
    const result = await runAction(root, peeps.url);
    assertFullRun(result, peeps);
    assert.match(result.output, /also selected by its grep/);
  });
}

test("a listing that fails with the grep runs the full suite", async (t) => {
  const root = await fixture(t, {
    ...FALLBACK(`test("kept", async () => {});`),
    "playwright.config.ts": `import { defineConfig } from "@playwright/test";
if (process.argv.includes("--list") && process.argv.includes("--grep")) throw new Error("this version reads no such grep");
export default defineConfig({ testDir: "./specs", workers: 1, reporter: "line" });\n`,
  });
  const peeps = await fakePeeps(t, (tests) => ({ narrowed: true, runs: pick(tests, "kept") }));
  const result = await runAction(root, peeps.url);
  assertFullRun(result, peeps);
  assert.match(result.output, /this version reads no such grep/);
});

for (const [name, answer] of [
  ["a run", { runs: [{ path: "suite/specs/gone.spec.ts", titlePath: "gone", pwProject: "" }] }],
  ["an unmatched test", { runs: [], unmatched: [{ path: "suite/specs/gone.spec.ts", titlePath: "gone", pwProject: "" }] }],
] as Array<[string, { runs: Planned[]; unmatched?: Planned[] }]>) {
  test(`nothing selected can run, as ${name}: the full suite runs and the job isn't failed by narrowing`, async (t) => {
    const root = await fixture(t, {
      "helper.ts": HELPER,
      "playwright.config.ts": outcomesConfig(""),
      "specs/t.spec.ts": `import { test } from "../helper";\ntest("other", async () => {});\n`,
    });
    const peeps = await fakePeeps(t, () => ({ narrowed: true, ...answer }));
    const result = await runAction(root, peeps.url);
    assert.equal(result.code, 0, result.output);
    assertFullRun(result, peeps);
    assert.match(result.output, /not in Playwright's list/);
  });
}

test("one selected test missing from the list runs the full suite, so none is dropped without a word", async (t) => {
  const root = await fixture(t, FALLBACK(`test("kept", async () => {});`));
  const peeps = await fakePeeps(t, (tests) => ({
    narrowed: true,
    runs: [...pick(tests, "kept"), { path: "suite/specs/gone.spec.ts", titlePath: "gone", pwProject: "" }],
  }));
  const result = await runAction(root, peeps.url);
  assertFullRun(result, peeps);
  assert.ok(result.ran.includes("|t.spec.ts > kept|0"));
});

test("what a fallback reports: planned tests with today's events, the rest logged and sent nowhere, the job red from a test nobody selected", async (t) => {
  const root = await fixture(t, {
    "helper.ts": HELPER,
    "playwright.config.ts": outcomesConfig(""),
    "specs/t.spec.ts": `import { test, expect } from "../helper";
test.describe("group", { tag: "@team  a" }, () => {
  test("kept", async () => {});
  test("expected failure", async () => { test.fail(); expect(1).toBe(2); });
  test("skips", async () => { test.skip(); });
});
test("added", async () => {});
test("other", async () => { throw new Error("not selected"); });
`,
  });
  const peeps = await fakePeeps(t, (tests) => ({
    narrowed: true,
    runs: pick(tests, "group › kept", "group › expected failure", "group › skips"),
    unmatched: pick(tests, "added"),
  }));
  const result = await runAction(root, peeps.url);
  assert.equal(result.code, 1, result.output);
  assertFullRun(result, peeps);
  assert.ok(result.ran.includes("|t.spec.ts > added|0"), "an unmatched test still runs");
  assert.deepEqual([...peeps.sent.keys()].sort(), ["group › expected failure", "group › kept", "group › skips"]);
  assert.deepEqual(shape(peeps.sent.get("group › kept")), ["run_start", "test_start", "passed#0", "run_end"]);
  // Not a narrowed run: raw statuses, exactly what this reporter sends without Peeps narrowing.
  assert.deepEqual(shape(peeps.sent.get("group › expected failure")), ["run_start", "test_start", "failed#0", "run_end"]);
  assert.deepEqual(shape(peeps.sent.get("group › skips")), ["run_start", "test_start", "skipped#0", "run_end"]);
  assert.match(result.output, /not planned, not reported: .*other \(failed\)/);
  assert.match(result.output, /not planned, not reported: .*added \(passed\)/);
});

test("a narrowed run whose capture wrapper can't be written still narrows, on the original config, with no default retry", async (t) => {
  if (process.getuid?.() === 0) return t.skip("root writes to a read-only directory");
  const root = await fixture(t, {
    "helper.ts": HELPER,
    "playwright.config.ts": `import { defineConfig } from "@playwright/test";
export default defineConfig({ testDir: "./specs", outputDir: "../out", workers: 1, reporter: "line" });\n`,
    "specs/t.spec.ts": `import { test } from "../helper";
test("kept", async () => { throw new Error("fails once"); });
test("other", async () => { throw new Error("not selected"); });
`,
  });
  const suite = path.join(root, "suite");
  const peeps = await fakePeeps(t, (tests) => ({ narrowed: true, runs: pick(tests, "kept") }));
  await chmod(suite, 0o555);
  const result = await runAction(root, peeps.url).finally(() => chmod(suite, 0o755));
  assert.match(result.output, /defaults could not be applied; using the original config/);
  assert.deepEqual(result.ran, ["|t.spec.ts > kept|0"]);
  assert.deepEqual(shape(peeps.sent.get("kept")), ["run_start", "test_start", "failed#0", "run_end"]);
  assert.deepEqual(peeps.completeBodies, ['{"reportUploaded":true}'], "it narrowed, so it did not run the full suite");
});

test("narrowed, maxFailures stops the run: the attempt it interrupts closes, though a retry was left", async (t) => {
  const root = await fixture(t, {
    "helper.ts": HELPER,
    "playwright.config.ts": outcomesConfig("retries: 1, maxFailures: 1, workers: 2"),
    "specs/a.spec.ts": `import { test } from "../helper";\ntest("fails", async () => { throw new Error("boom"); });\n`,
    "specs/b.spec.ts": `import { test } from "../helper";\ntest("hangs", async () => { await new Promise(() => {}); });\n`,
  });
  const peeps = await fakePeeps(t, (tests) => ({ narrowed: true, runs: tests }));
  await runAction(root, peeps.url);
  assert.deepEqual(shape(peeps.sent.get("fails")), ["run_start", "test_start", "failed#0", "test_start", "failed#1", "run_end"]);
  assert.deepEqual(shape(peeps.sent.get("hangs")), ["run_start", "test_start", "interrupted#0", "run_end"]);
});

test("narrowed, a global timeout ends the run: the test in flight gets an end only if Playwright is still shutting down, and then closes; else its run stays open and reads as unfinished", async (t) => {
  const root = await fixture(t, {
    "helper.ts": HELPER,
    "playwright.config.ts": outcomesConfig("retries: 2, globalTimeout: 3000"),
    "specs/t.spec.ts": `import { test } from "../helper";
test("hangs", async () => { await new Promise(() => {}); });
`,
  });
  const peeps = await fakePeeps(t, (tests) => ({ narrowed: true, runs: tests }));
  await runAction(root, peeps.url);
  const sent = shape(peeps.sent.get("hangs"));
  assert.ok(sent.at(-1) === "test_start" || sent.at(-1) === "run_end", sent.join(", "));
});

// ---------------------------------------------------------------------------
// An anonymous describe: the announce says ` › title`, the reporter `title`
// ---------------------------------------------------------------------------

const ANONYMOUS = {
  "helper.ts": HELPER,
  "playwright.config.ts": outcomesConfig(""),
  "specs/t.spec.ts": `import { test } from "../helper";
test.describe(() => {
  test("plain", async () => {});
  test.describe("named", () => { test("deep", async () => {}); });
});
test("other", async () => {});
`,
};

test("narrowed, a selected test in an anonymous describe runs and reports", async (t) => {
  const root = await fixture(t, ANONYMOUS);
  const peeps = await fakePeeps(t, (tests) => ({ narrowed: true, runs: pick(tests, " › plain", " › named › deep") }));
  const result = await runAction(root, peeps.url);
  assert.equal(result.code, 0, result.output);
  assert.deepEqual(result.ran.sort(), ["|t.spec.ts > named > deep|0", "|t.spec.ts > plain|0"]);
  assert.deepEqual(shape(peeps.sent.get(" › plain")), ["run_start", "test_start", "passed#0", "run_end"]);
  assert.deepEqual(shape(peeps.sent.get(" › named › deep")), ["run_start", "test_start", "passed#0", "run_end"]);
});

test("on a fallback too, a selected test in an anonymous describe reports", async (t) => {
  const root = await fixture(t, ANONYMOUS);
  const peeps = await fakePeeps(t, (tests) => ({
    narrowed: true,
    runs: [...pick(tests, " › plain"), { path: "suite/specs/gone.spec.ts", titlePath: "gone", pwProject: "" }],
  }));
  const result = await runAction(root, peeps.url);
  assert.ok(result.ran.includes("|t.spec.ts > other|0"), result.output);
  assert.deepEqual(shape(peeps.sent.get(" › plain")), ["run_start", "test_start", "passed#0", "run_end"]);
});

test("not narrowed, an anonymous describe announces and fails to report exactly as today", async (t) => {
  const root = await fixture(t, ANONYMOUS);
  const peeps = await fakePeeps(t, (tests) => ({ runs: tests }));
  const result = await runAction(root, peeps.url);
  assert.equal(result.code, 0, result.output);
  const announced = (peeps.announces[0]!.tests as Planned[]).map((v) => v.titlePath).sort();
  assert.deepEqual(announced, [" › named › deep", " › plain", "other"]);
  assert.deepEqual([...peeps.sent.keys()], ["other"]);
});
