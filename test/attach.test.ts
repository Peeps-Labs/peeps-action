import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, mkdir, readFile, readdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";

import { attachConfigSource } from "../src/attach";
import { htmlReportDir } from "../src/reporter";
import type { FullConfig } from "@playwright/test/reporter";

const action = path.resolve(__dirname, "../dist/index.js");
const modules = process.env.PEEPS_CAPTURE_TEST_MODULES ?? path.resolve(__dirname, "../node_modules");
const cli = path.join(modules, "playwright/cli.js");
const SHA = "0123456789abcdef0123456789abcdef01234567";

interface Request { pathname: string; artifact: string | null; bytes: Buffer }
/** `finish-hang`: plans and takes results, then never answers the report upload. */
type PeepsBehaviour = "ok" | "error" | "hang" | "finish-hang";

/**
 * A customer suite as Kixie's is shaped: a TS config with several reporters of its own, one
 * of them a stand-in for Zephyr that records what it saw, and an HTML report.
 */
async function fixture(t: TestContext) {
  const root = await mkdtemp(path.join(tmpdir(), "peeps-attach-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const suite = path.join(root, "suite");
  await mkdir(path.join(suite, "tests"), { recursive: true });
  await symlink(modules, path.join(root, "node_modules"), "dir");
  const config = `import { defineConfig } from "@playwright/test";
export default defineConfig({
  testDir: "./tests", outputDir: "./results", workers: 1, retries: 0, timeout: 10000,
  reporter: [["list"], ["./zephyr-stand-in.ts", { projectKey: "PHX" }], ["html", { outputFolder: "./report", open: "never" }]],
});\n`;
  await writeFile(path.join(suite, "playwright.config.ts"), config);
  await writeFile(path.join(suite, "zephyr-stand-in.ts"), `
import { writeFileSync } from "node:fs";
import path from "node:path";
export default class ZephyrStandIn {
  private seen: string[] = [];
  constructor(private options: { projectKey: string }) {}
  onTestEnd(test: { title: string }, result: { status: string }) { this.seen.push(test.title + " " + result.status); }
  onEnd(result: { status: string }) {
    writeFileSync(path.join(__dirname, "zephyr-upload.json"),
      JSON.stringify({ projectKey: this.options.projectKey, status: result.status, seen: this.seen.sort() }));
  }
}
`);
  await writeFile(path.join(suite, "tests/shop.spec.ts"), `
import { test, expect } from "@playwright/test";
test("checkout works", async ({ page }) => { await page.setContent("<h1>Paid</h1>"); });
test("refund fails", async ({ page }) => {
  await page.setContent("<h1>Refund</h1>");
  await expect(page.getByRole("heading")).toHaveText("Refunded", { timeout: 500 });
});
`);
  return { root, suite, config };
}

async function fakePeeps(t: TestContext, behaviour: PeepsBehaviour) {
  const requests: Request[] = [];
  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    const bytes = Buffer.concat(chunks);
    requests.push({ pathname: url.pathname, artifact: url.searchParams.get("path"), bytes });
    if (behaviour === "hang") return; // never answers
    if (behaviour === "finish-hang" && (url.pathname.endsWith("/artifacts") || url.pathname.endsWith("/complete"))) return;
    if (behaviour === "error") {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end('{"error":"internal"}');
      return;
    }
    let response: unknown = {};
    if (url.pathname === "/api/v1/ci/batches") {
      const input = JSON.parse(bytes.toString()) as { tests: Array<{ path: string; titlePath: string; pwProject: string }> };
      const runs = input.tests.map((v, i) => ({ ...v, runId: `run-${i}`, credential: { exp: 99, sig: "test-signature" } }));
      response = { batches: [{ projectId: "project", batchId: "batch", batchNumber: 7, runs, unmatched: [] }] };
    }
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(response));
  });
  server.keepAliveTimeout = 1;
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise<void>((resolve) => {
    server.closeAllConnections();
    server.close(() => resolve());
  }));
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, requests };
}

/** The job's environment: fake CI only, nothing from this machine's own CI or Peeps setup. */
function jobEnv(root: string, peepsUrl: string, extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  const env = { ...process.env };
  for (const name of Object.keys(env)) {
    if (/^(?:GITHUB_|GITLAB_|CI_|ACTIONS_|INPUT_|PEEPS_|PLAYWRIGHT_)/.test(name)) delete env[name];
  }
  return {
    ...env,
    CI: "1", GITHUB_WORKSPACE: root, GITHUB_SHA: SHA, GITHUB_REF: "refs/heads/attach-test",
    GITHUB_ENV: path.join(root, "github-env"), RUNNER_TEMP: root,
    PEEPS_API_URL: peepsUrl, PEEPS_API_KEY: "fake-test-key", ...extra,
  };
}

async function spawnNode(args: string[], cwd: string, env: NodeJS.ProcessEnv) {
  const child = spawn(process.execPath, args, { cwd, env, stdio: ["ignore", "pipe", "pipe"] });
  let output = "";
  child.stdout.on("data", (v: Buffer) => { output += v.toString(); });
  child.stderr.on("data", (v: Buffer) => { output += v.toString(); });
  const timer = setTimeout(() => child.kill("SIGKILL"), 90_000);
  try {
    const code = await new Promise<number | null>((resolve, reject) => {
      child.on("error", reject);
      child.on("close", resolve);
    });
    return { code, output };
  } finally { clearTimeout(timer); }
}

/** What GITHUB_ENV carries into the steps after attach-start. */
async function exported(root: string): Promise<Record<string, string>> {
  const text = await readFile(path.join(root, "github-env"), "utf8").catch(() => "");
  return Object.fromEntries(text.split("\n").filter(Boolean).map((line) => {
    const at = line.indexOf("=");
    return [line.slice(0, at), line.slice(at + 1)];
  }));
}

/** The customer's own test step: their command, plus `--config` when attach-start left one. */
async function customerRun(suite: string, env: NodeJS.ProcessEnv, attachConfig?: string) {
  const args = [cli, "test", ...(attachConfig ? ["--config", attachConfig] : [])];
  const result = await spawnNode(args, suite, env);
  const zephyr = JSON.parse(await readFile(path.join(suite, "zephyr-upload.json"), "utf8")) as unknown;
  await rm(path.join(suite, "zephyr-upload.json"));
  return { ...result, zephyr };
}

/** attach-start, the customer's step, attach-finish: the three steps of an attached job. */
async function attachedJob(t: TestContext, behaviour: PeepsBehaviour | "unreachable", extra: NodeJS.ProcessEnv = {}) {
  const f = await fixture(t);
  const peeps = behaviour === "unreachable" ? { url: "http://127.0.0.1:9", requests: [] } : await fakePeeps(t, behaviour);
  const env = jobEnv(f.root, peeps.url, { PEEPS_ATTACH_DEADLINE_MS: "3000", ...extra });

  const baseline = await customerRun(f.suite, env);

  const start = await spawnNode([action], f.root, { ...env, INPUT_MODE: "attach-start", "INPUT_WORKING-DIRECTORY": "suite" });
  const vars = await exported(f.root);
  const stepEnv = { ...env, ...vars };
  const attached = await customerRun(f.suite, stepEnv, vars.PEEPS_ATTACH_CONFIG);
  const finish = await spawnNode([action], f.root, { ...stepEnv, INPUT_MODE: "attach-finish" });
  return { f, peeps, baseline, start, vars, attached, finish };
}

function events(requests: Request[]) {
  return requests.filter((v) => v.pathname.endsWith("/events")).flatMap((v) =>
    (JSON.parse(v.bytes.toString()) as { events: Array<{ type: string; status?: string; testName?: string }> }).events);
}

/** The customer's run must not notice Peeps: same exit code, same Zephyr upload. */
function assertUnchanged(job: Awaited<ReturnType<typeof attachedJob>>) {
  assert.equal(job.baseline.code, 1, job.baseline.output);
  assert.equal(job.attached.code, job.baseline.code, job.attached.output);
  assert.deepEqual(job.attached.zephyr, job.baseline.zephyr);
  assert.deepEqual(job.baseline.zephyr, { projectKey: "PHX", status: "failed", seen: ["checkout works passed", "refund fails failed"] });
  assert.equal(job.start.code, 0, job.start.output);
  assert.equal(job.finish.code, 0, job.finish.output);
}

test("an attached run reports to Peeps beside the customer's own reporters, and their run is unchanged", async (t) => {
  const job = await attachedJob(t, "ok");
  assertUnchanged(job);
  assert.equal(path.dirname(job.vars.PEEPS_ATTACH_CONFIG!), await realpath(job.f.suite), "the wrapper sits beside their config");

  const batch = job.peeps.requests.find((v) => v.pathname === "/api/v1/ci/batches");
  const body = JSON.parse(batch!.bytes.toString()) as { sha: string; tests: unknown[]; files: Array<{ path: string; blobSha: string }> };
  assert.equal(body.sha, SHA);
  assert.deepEqual(body.tests, [
    { path: "suite/tests/shop.spec.ts", titlePath: "checkout works", pwProject: "" },
    { path: "suite/tests/shop.spec.ts", titlePath: "refund fails", pwProject: "" },
  ]);
  assert.deepEqual(body.files.map((v) => v.path), ["suite/tests/shop.spec.ts"]);

  const ended = events(job.peeps.requests).filter((v) => v.type === "test_end");
  assert.deepEqual(ended.map((v) => `${v.testName} ${v.status}`).sort(), ["checkout works passed", "refund fails failed"]);
  assert.equal(events(job.peeps.requests).filter((v) => v.type === "run_end").length, 2);

  const uploads = job.peeps.requests.filter((v) => v.pathname === "/api/v1/ci/batches/batch/artifacts");
  assert.ok(uploads.some((v) => v.artifact === "index.html"), "their HTML report goes to Peeps, from where their config put it");
  const complete = job.peeps.requests.find((v) => v.pathname === "/api/v1/ci/batches/batch/complete");
  assert.deepEqual(JSON.parse(complete!.bytes.toString()), { reportUploaded: true });

  assert.ok(!(await readdir(job.f.suite)).some((v) => v.startsWith(".peeps-attach-")), "attach-finish removes the wrapper");
  assert.equal(await readFile(path.join(job.f.suite, "playwright.config.ts"), "utf8"), job.f.config);
});

for (const behaviour of ["unreachable", "error", "hang"] as const) {
  test(`with Peeps ${behaviour === "error" ? "answering 500" : behaviour}, the customer's run and Zephyr upload are exactly as without Peeps`, async (t) => {
    const job = await attachedJob(t, behaviour);
    assertUnchanged(job);
    assert.match(job.attached.output, /\[peeps\] attach: could not plan this run with Peeps/);
    assert.equal(events(job.peeps.requests).length, 0);
    assert.match(job.finish.output, /planned nothing with Peeps/);
    assert.ok(!(await readdir(job.f.suite)).some((v) => v.startsWith(".peeps-attach-")));
  });
}

test("an attach step never fails the job, even on an environment it cannot read", async (t) => {
  const f = await fixture(t);
  const env = jobEnv(f.root, "http://not-loopback.example");
  for (const mode of ["attach-start", "attach-finish"]) {
    const result = await spawnNode([action], f.root, { ...env, INPUT_MODE: mode, PEEPS_ATTACH_DIR: path.join(f.root, "missing") });
    assert.equal(result.code, 0, result.output);
    assert.match(result.output, /::warning::Peeps could not report this run: PEEPS_API_URL must use https/);
  }
});

test("attach-finish without attach-start does nothing", async (t) => {
  const f = await fixture(t);
  const result = await spawnNode([action], f.root, { ...jobEnv(f.root, "https://peeps.test"), INPUT_MODE: "attach-finish" });
  assert.equal(result.code, 0, result.output);
  assert.match(result.output, /attach-start did not run/);
});

test("the wrapper keeps every reporter the customer configured and adds Peeps last", () => {
  const source = attachConfigSource({ original: "/repo/playwright.config.ts", esm: false, reporterPath: "/action/reporter.js", stateDir: "/tmp/state" });
  assert.match(source, /require\("\/repo\/playwright\.config\.ts"\)/);
  assert.match(source, /reporter: \[\.\.\.reporters, \["\/action\/reporter\.js", \{ attachDir: "\/tmp\/state" \}\]\]/);
  assert.match(source, /return \{ default: withPeeps \}/);
  const esm = attachConfigSource({ original: "/repo/playwright.config.mjs", esm: true, reporterPath: "/action/reporter.js", stateDir: "/tmp/state" });
  assert.match(esm, /import \* as loaded from "file:\/\/\/repo\/playwright\.config\.mjs"/);
  assert.match(esm, /export default withPeeps/);
});

test("a Peeps that stops answering during attach-finish cannot hold the job", async (t) => {
  const job = await attachedJob(t, "finish-hang");
  assertUnchanged(job);
  assert.equal(events(job.peeps.requests).filter((v) => v.type === "test_end").length, 2);
  assert.match(job.finish.output, /::warning::Peeps could not report this run: gave up after 3s/);
});

test("the HTML report is found where Playwright puts it: the environment override first", (t) => {
  const config = {
    configFile: "/repo/e2e/playwright.config.ts", rootDir: "/repo/e2e/tests",
    reporter: [["list"], ["html", { outputFolder: "./report" }]],
  } as unknown as FullConfig;
  const saved = process.env.PLAYWRIGHT_HTML_OUTPUT_DIR;
  t.after(() => {
    if (saved === undefined) delete process.env.PLAYWRIGHT_HTML_OUTPUT_DIR;
    else process.env.PLAYWRIGHT_HTML_OUTPUT_DIR = saved;
  });
  delete process.env.PLAYWRIGHT_HTML_OUTPUT_DIR;
  assert.equal(htmlReportDir(config), "/repo/e2e/report");
  process.env.PLAYWRIGHT_HTML_OUTPUT_DIR = "/tmp/elsewhere";
  assert.equal(htmlReportDir(config), "/tmp/elsewhere");
  assert.equal(htmlReportDir({ ...config, reporter: [["list"]] } as unknown as FullConfig), null);
});
