import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chmod, mkdtemp, mkdir, readFile, readdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";

import { prepareCaptureConfig } from "../src/capture-config";
import { readRunnerEnv } from "../src/env";
import { executeAndReport } from "../src/report";
import type { PeepsClient } from "../src/peeps";

const action = path.resolve(__dirname, "../dist/index.js");
const modules = process.env.PEEPS_CAPTURE_TEST_MODULES ?? path.resolve(__dirname, "../node_modules");

interface Request { pathname: string; artifact: string | null; bytes: Buffer }

async function fixture(t: TestContext, use = 'trace: "retain-on-failure",') {
  const root = await mkdtemp(path.join(tmpdir(), "peeps-capture-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const suite = path.join(root, "suite");
  await mkdir(path.join(suite, "specs"), { recursive: true });
  await symlink(modules, path.join(root, "node_modules"), "dir");
  const config = `import { defineConfig } from "@playwright/test";
export default defineConfig({
  testDir: "./specs", outputDir: "./results", globalSetup: "./setup.ts",
  workers: 1, retries: 0, timeout: 10000,
  use: { viewport: { width: 640, height: 360 }, deviceScaleFactor: 2, ${use} }
});\n`;
  await writeFile(path.join(suite, "playwright.config.ts"), config);
  await writeFile(path.join(suite, "setup.ts"), 'export default () => { process.env.PEEPS_CAPTURE_SETUP = "ready"; };\n');
  await writeFile(path.join(suite, "specs/capture.spec.ts"), `
import { test, expect } from "@playwright/test";
test("ambiguous Continue fails", async ({ page }) => {
  expect(process.env.PEEPS_CAPTURE_SETUP).toBe("ready");
  await page.setContent('<form><button>Continue</button></form><dialog open><button>Continue</button></dialog>');
  await page.getByRole("button", { name: "Continue" }).click();
});
test("passing control", async ({ page }) => { await page.setContent("<h1>Passed</h1>"); });
`);
  return { root, suite, config };
}

async function fakePeeps(t: TestContext, dispatched = false) {
  const requests: Request[] = [];
  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    const bytes = Buffer.concat(chunks);
    requests.push({ pathname: url.pathname, artifact: url.searchParams.get("path"), bytes });
    let response: unknown = {};
    if (url.pathname === "/api/v1/ci/batches" || url.pathname.endsWith("/plan")) {
      const input = JSON.parse(bytes.toString()) as { tests: Array<{ path: string; titlePath: string; pwProject: string }> };
      const tests = dispatched ? input.tests.filter((v) => v.titlePath === "ambiguous Continue fails") : input.tests;
      const runs = tests.map((v, i) => ({ ...v, runId: `run-${i}`, credential: { exp: 99, sig: "test-signature" } }));
      const batch = { projectId: "project", batchId: "batch", batchNumber: 1, runs, unmatched: [] };
      response = dispatched ? batch : { batches: [batch] };
    }
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(response));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())));
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, requests };
}

async function runAction(root: string, url: string, extra: NodeJS.ProcessEnv = {}) {
  const env = { ...process.env };
  // Fake CI/auth only. No job credentials from this machine reach the child.
  for (const name of Object.keys(env)) {
    if (/^(?:GITHUB_|GITLAB_|CI_|ACTIONS_|INPUT_|PEEPS_)/.test(name)) delete env[name];
  }
  Object.assign(env, {
    GITHUB_WORKSPACE: root, GITHUB_SHA: "0123456789abcdef0123456789abcdef01234567",
    GITHUB_REF: "refs/heads/capture-test", INPUT_MODE: "report", INPUT_FRAMEWORK: "playwright",
    INPUT_CONFIG: "suite/playwright.config.ts", PEEPS_API_URL: url, PEEPS_API_KEY: "fake-test-key",
    BASE_URL: url, RUNNER_TEMP: root, ...extra,
  });
  const child = spawn(process.execPath, [action], { cwd: root, env, stdio: ["ignore", "pipe", "pipe"] });
  let output = "";
  child.stdout.on("data", (v: Buffer) => { output += v.toString(); });
  child.stderr.on("data", (v: Buffer) => { output += v.toString(); });
  const timer = setTimeout(() => child.kill("SIGKILL"), 60_000);
  try {
    const code = await new Promise<number | null>((resolve, reject) => {
      child.on("error", reject);
      child.on("close", resolve);
    });
    return { code, output };
  } finally { clearTimeout(timer); }
}

function uploads(requests: Request[], suffix: string) {
  return requests.filter((v) => v.pathname.endsWith("/artifacts") && v.artifact?.endsWith(suffix));
}

function events(requests: Request[]) {
  return requests.filter((v) => v.pathname.endsWith("/events")).flatMap((v) =>
    (JSON.parse(v.bytes.toString()) as { events: Array<{ type: string; status?: string; error?: string }> }).events);
}

for (const mode of ["report", "run"] as const) {
  test(`published ${mode} captures first-failure evidence without changing the test failure`, async (t) => {
    const f = await fixture(t);
    const peeps = await fakePeeps(t, mode === "run");
    const result = await runAction(f.root, peeps.url, {
      INPUT_MODE: mode, "INPUT_SESSION-ID": "batch",
      // GitLab runs the same dist/index.js directly, with PEEPS_* inputs.
      ...(mode === "run" ? { GITLAB_CI: "true", CI_PROJECT_DIR: f.root,
        CI_COMMIT_SHA: "0123456789abcdef0123456789abcdef01234567", CI_PROJECT_PATH: "test/repo",
        PEEPS_MODE: "run", PEEPS_SESSION_ID: "batch", PEEPS_PLAYWRIGHT_CONFIG: "suite/playwright.config.ts",
        PEEPS_ID_TOKEN: "fake-gitlab-id-token" } : {}),
    });
    assert.equal(result.code, 1, result.output);
    const ended = events(peeps.requests).filter((v) => v.type === "test_end");
    assert.equal(ended.filter((v) => v.status === "failed").length, 1, result.output);
    assert.match(ended.find((v) => v.status === "failed")!.error!, /strict mode violation/);
    assert.equal(ended.length, mode === "run" ? 1 : 2, "dispatch selection must not broaden");
    const png = uploads(peeps.requests, ".png");
    assert.equal(png.length, 1, "the failing test must upload its screenshot; passing control must not");
    assert.equal(png[0]!.bytes.subarray(0, 8).toString("hex"), "89504e470d0a1a0a");
    assert.equal(png[0]!.bytes.readUInt32BE(16), 1280, "keep the repository's DPR and viewport");
    assert.equal(png[0]!.bytes.readUInt32BE(20), 720);
    const video = uploads(peeps.requests, ".webm");
    assert.equal(video.length, 1, "the failing attempt must upload video, without retries");
    assert.equal(video[0]!.bytes.subarray(0, 4).toString("hex"), "1a45dfa3");
    assert.equal(uploads(peeps.requests, ".zip").length, 1, "keep existing trace capture");
    const complete = peeps.requests.find((v) => v.pathname.endsWith("/complete"));
    assert.deepEqual(JSON.parse(complete!.bytes.toString()), { reportUploaded: true });
    assert.equal(await readFile(path.join(f.suite, "playwright.config.ts"), "utf8"), f.config);
    assert.ok(!(await readdir(f.suite)).some((v) => v.startsWith(".peeps-capture-")), "remove temporary config after nonzero exit");
    assert.ok((await readdir(path.join(f.suite, "results"))).length > 0, "preserve relative outputDir");
  });
}

test("published action respects explicit off and does not enable tracing", async (t) => {
  const f = await fixture(t, 'screenshot: "off", video: { mode: "off" },');
  const peeps = await fakePeeps(t);
  const result = await runAction(f.root, peeps.url);
  assert.equal(result.code, 1, result.output);
  assert.equal(events(peeps.requests).filter((v) => v.status === "failed").length, 1, result.output);
  assert.equal(uploads(peeps.requests, ".png").length, 0);
  assert.equal(uploads(peeps.requests, ".webm").length, 0);
  assert.equal(uploads(peeps.requests, ".zip").length, 0);
});

// Exercise the generated config through the real Playwright loader/fixtures,
// not an import of our own defaults helper or a source-text assertion.
async function checkConfig(t: TestContext, opts: {
  filename?: string; source?: string; modulePackage?: boolean; configInput?: string;
}) {
  const f = await fixture(t);
  await rm(path.join(f.suite, "playwright.config.ts"));
  if (opts.modulePackage) await writeFile(path.join(f.suite, "package.json"), '{"type":"module"}');
  if (opts.filename) await writeFile(path.join(f.suite, opts.filename), opts.source!);
  await writeFile(path.join(f.suite, "specs/capture.spec.ts"), `
import { test, expect } from "@playwright/test";
test("inherited defaults", async ({ screenshot, video }, info) => {
  if (info.project.name === "off") {
    expect(screenshot).toBe("off");
    expect(video).toEqual({ mode: "off", size: { width: 320, height: 240 } });
  } else {
    expect(screenshot).toBe("only-on-failure");
    expect(video).toBe("retain-on-failure");
  }
  expect(info.project.use.baseURL).toBe("http://config-preserved.invalid");
});
`);
  await writeFile(path.join(f.suite, "specs/override.spec.ts"), `
import { test, expect } from "@playwright/test";
test.use({ screenshot: { mode: "off", fullPage: true }, video: "off" });
test("test.use wins over defaults", async ({ screenshot, video }) => {
  expect(screenshot).toEqual({ mode: "off", fullPage: true }); expect(video).toBe("off");
});
`);
  const env = readRunnerEnv({ GITHUB_WORKSPACE: f.root, INPUT_CONFIG: opts.configInput ?? "suite" });
  const capture = await prepareCaptureConfig(env);
  t.after(() => capture.cleanup().catch((error: NodeJS.ErrnoException) => {
    if (error.code !== "ENOENT") throw error;
  }));
  const cli = path.join(modules, "playwright/cli.js");
  const child = spawn(process.execPath, [cli, "test", "--config", capture.configPath, "--reporter=json"], {
    cwd: f.root, env: { ...process.env, CI: "1" }, stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "", stderr = "";
  child.stdout.on("data", (v: Buffer) => { stdout += v.toString(); });
  child.stderr.on("data", (v: Buffer) => { stderr += v.toString(); });
  const code = await new Promise<number | null>((resolve, reject) => { child.on("close", resolve); child.on("error", reject); });
  assert.equal(code, 0, stdout + stderr);
  const report = JSON.parse(stdout) as { config: { rootDir: string; projects: Array<{ name: string }> }; stats: { expected: number } };
  assert.equal(report.config.rootDir, path.join(await realpath(f.root), "suite/specs"));
  assert.deepEqual(report.config.projects.map((v) => v.name), ["inherited", "off"]);
  assert.equal(report.stats.expected, 4, "preserve configured projects and test-level override");
}

const compatibilityConfig = `{
  testDir: "./specs", outputDir: "./results", workers: 1,
  use: { baseURL: "http://config-preserved.invalid", screenshot: undefined, video: undefined },
  projects: [{ name: "inherited" }, { name: "off", use: {
    screenshot: "off", video: { mode: "off", size: { width: 320, height: 240 } }
  }}],
  default: { testDir: "wrong-directory" }
}`;

for (const variant of [
  { filename: "playwright.config.ts", source: `export default ${compatibilityConfig};` },
  { filename: "playwright.config.js", source: `module.exports = ${compatibilityConfig.replace(/,\n  default:[^\n]+/, "")};` },
  { filename: "playwright.config.cts", source: `export default ${compatibilityConfig};` },
  { filename: "playwright.config.cjs", source: `exports.default = ${compatibilityConfig};` },
  { filename: "playwright.config.cjs", source: `module.exports = Promise.resolve(${compatibilityConfig.replace(/,\n  default:[^\n]+/, "")});` },
  { filename: "playwright.config.cjs", source: `exports.default = Promise.resolve(${compatibilityConfig});` },
  { filename: "playwright.config.mjs", source: `export default Promise.resolve(${compatibilityConfig});` },
  { filename: "playwright.config.mjs", source: `await Promise.resolve(); export default ${compatibilityConfig};` },
  { filename: "playwright.config.mts", source: `await Promise.resolve(); export default ${compatibilityConfig};` },
  { filename: "playwright.config.ts", source: `export default ${compatibilityConfig};`, modulePackage: true },
]) {
  test(`config directory discovery preserves ${variant.filename}${variant.modulePackage ? " in ESM package" : ""} and overrides`, async (t) => {
    await checkConfig(t, variant);
  });
}

test("implicit discovery uses the working directory and removes its wrapper", async (t) => {
  const f = await fixture(t);
  const peeps = await fakePeeps(t);
  const result = await runAction(f.root, peeps.url, { INPUT_CONFIG: "", "INPUT_WORKING-DIRECTORY": "suite" });
  assert.equal(result.code, 1, result.output);
  assert.equal(uploads(peeps.requests, ".png").length, 1, result.output);
  assert.ok(!(await readdir(f.suite)).some((v) => v.startsWith(".peeps-capture-")));
});

test("a config directory without a config receives defaults without changing its test root", async (t) => {
  const f = await fixture(t);
  await rm(path.join(f.suite, "playwright.config.ts"));
  // No config to set globalSetup: remove that assertion from the fixture.
  const spec = path.join(f.suite, "specs/capture.spec.ts");
  await writeFile(spec, (await readFile(spec, "utf8")).replace('  expect(process.env.PEEPS_CAPTURE_SETUP).toBe("ready");', ""));
  const peeps = await fakePeeps(t);
  const result = await runAction(f.root, peeps.url, { INPUT_CONFIG: "suite" });
  assert.equal(result.code, 1, result.output);
  assert.equal(uploads(peeps.requests, ".png").length, 1, result.output);
  assert.equal(uploads(peeps.requests, ".webm").length, 1);
  assert.equal(uploads(peeps.requests, ".zip").length, 0, "do not add trace recording");
});

test("fail-then-pass retry retains first-attempt evidence and final outcome", async (t) => {
  const f = await fixture(t);
  await writeFile(path.join(f.suite, "playwright.config.ts"), f.config.replace("retries: 0", "retries: 1"));
  await writeFile(path.join(f.suite, "specs/capture.spec.ts"), `
import { test, expect } from "@playwright/test";
test("flaky control", async ({ page }, info) => {
  await page.setContent("<h1>First attempt evidence</h1>"); expect(info.retry).toBe(1);
});
`);
  const peeps = await fakePeeps(t);
  const result = await runAction(f.root, peeps.url);
  assert.equal(result.code, 0, result.output);
  assert.deepEqual(events(peeps.requests).filter((v) => v.type === "test_end").map((v) => v.status), ["failed", "passed"]);
  assert.equal(events(peeps.requests).filter((v) => v.type === "run_end").length, 1);
  assert.equal(uploads(peeps.requests, ".png").length, 1);
  assert.equal(uploads(peeps.requests, ".webm").length, 1);
});

test("read-only config directory warns and executes the unchanged config", async (t) => {
  const f = await fixture(t);
  await writeFile(path.join(f.suite, "playwright.config.ts"), f.config.replace('outputDir: "./results"', 'outputDir: "../results"'));
  await chmod(f.suite, 0o555);
  const peeps = await fakePeeps(t);
  let result;
  try { result = await runAction(f.root, peeps.url); }
  finally { await chmod(f.suite, 0o755); }
  assert.equal(result.code, 1, result.output);
  assert.match(result.output, /screenshot\/video defaults could not be applied/);
  assert.match(events(peeps.requests).find((v) => v.status === "failed")!.error!, /strict mode violation/);
  assert.equal(uploads(peeps.requests, ".png").length, 0);
  assert.equal(uploads(peeps.requests, ".webm").length, 0);
  assert.deepEqual(JSON.parse(peeps.requests.find((v) => v.pathname.endsWith("/complete"))!.bytes.toString()), { reportUploaded: true });
});

test("invalid original config/use fails through Playwright rather than being replaced by defaults", async (t) => {
  const f = await fixture(t);
  for (const source of ['module.exports = null;', 'module.exports = { use: null };']) {
    await writeFile(path.join(f.suite, "invalid.cjs"), source);
    const capture = await prepareCaptureConfig(readRunnerEnv({ GITHUB_WORKSPACE: f.root, INPUT_CONFIG: "suite/invalid.cjs" }));
    try {
      const cli = path.join(modules, "playwright/cli.js");
      const child = spawn(process.execPath, [cli, "test", "--list", "--config", capture.configPath], {
        cwd: f.root, stdio: ["ignore", "pipe", "pipe"],
      });
      let output = "";
      child.stdout.on("data", (v: Buffer) => { output += v.toString(); });
      child.stderr.on("data", (v: Buffer) => { output += v.toString(); });
      const code = await new Promise<number | null>((resolve, reject) => { child.on("close", resolve); child.on("error", reject); });
      assert.equal(code, 1, output);
      assert.match(output, /Playwright config/);
    } finally { await capture.cleanup(); }
  }
});

test("spawn failure removes temporary config, completes the batch and fails the job", async (t) => {
  const f = await fixture(t);
  const oldPath = process.env.PATH, oldExitCode = process.exitCode;
  const completed: unknown[] = [];
  const client = {
    post: async (url: string, body: unknown) => { completed.push({ url, body }); return {}; },
    postBytes: async () => { throw new Error("no uploads expected when Playwright cannot start"); },
  } as unknown as PeepsClient;
  try {
    process.env.PATH = f.root; // No npx; this must hit ChildProcess's error event.
    await executeAndReport(readRunnerEnv({ GITHUB_WORKSPACE: f.root, INPUT_CONFIG: "suite/playwright.config.ts" }), client, {
      rootDir: "suite/specs", runs: [], batches: [{ batchId: "batch", batchNumber: 1 }],
    });
    assert.equal(process.exitCode, 1);
    assert.deepEqual(completed, [{ url: "/api/v1/ci/batches/batch/complete", body: { reportUploaded: false } }]);
    assert.ok(!(await readdir(f.suite)).some((v) => v.startsWith(".peeps-capture-")));
  } finally { process.env.PATH = oldPath; process.exitCode = oldExitCode; }
});

test("execution-time config error remains failed and completes the planned batch", async (t) => {
  const f = await fixture(t);
  // Inventory succeeds; config loading fails only when the action executes.
  await writeFile(path.join(f.suite, "playwright.config.ts"), `
if (process.env.PEEPS_PLAN_FILE) throw new Error("execution config failure");
${f.config}`);
  const peeps = await fakePeeps(t);
  const result = await runAction(f.root, peeps.url);
  assert.equal(result.code, 1, result.output);
  assert.match(result.output, /execution config failure/);
  assert.deepEqual(JSON.parse(peeps.requests.find((v) => v.pathname.endsWith("/complete"))!.bytes.toString()), { reportUploaded: false });
  assert.ok(!(await readdir(f.suite)).some((v) => v.startsWith(".peeps-capture-")));
});

test("missing FFmpeg preserves system-browser outcomes and screenshot evidence with a warning", async (t) => {
  const executable = (require(path.join(modules, "playwright-core")) as typeof import("playwright-core")).chromium.executablePath();
  const f = await fixture(t, `launchOptions: { executablePath: ${JSON.stringify(executable)} },`);
  const emptyCache = path.join(f.root, "empty-browser-cache");
  await mkdir(emptyCache);
  const peeps = await fakePeeps(t);
  const result = await runAction(f.root, peeps.url, { PLAYWRIGHT_BROWSERS_PATH: emptyCache });
  assert.equal(result.code, 1, result.output);
  const ended = events(peeps.requests).filter((v) => v.type === "test_end");
  assert.deepEqual(ended.map((v) => v.status), ["failed", "passed"], result.output);
  assert.match(ended[0]!.error!, /strict mode violation/);
  assert.equal(uploads(peeps.requests, ".png").length, 1);
  assert.equal(uploads(peeps.requests, ".webm").length, 0);
  assert.match(result.output, /default video disabled.*playwright install ffmpeg/);
});
