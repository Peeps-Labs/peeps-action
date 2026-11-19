/**
 * `mode: load` refuses in this release, and it refuses before anything else can happen: no
 * customer code is loaded, no request reaches Peeps or GitHub's OIDC endpoint, and no
 * process is spawned (not even git). It runs the committed `dist/index.js`, which is what
 * `uses: Peeps-Labs/peeps-action@v1` runs.
 */
import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer, type Server } from "node:http";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";

const action = path.resolve(__dirname, "../dist/index.js");
const MESSAGE = "::error::Load testing isn't available for this repository yet.";

/** A server that answers 200 to everything and counts what it was asked. */
async function recordingServer(t: TestContext): Promise<{ url: string; hits: string[] }> {
  const hits: string[] = [];
  const server: Server = createServer((req, res) => {
    hits.push(`${req.method} ${req.url}`);
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ value: "token", count: 0 }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, hits };
}

/**
 * A workspace whose every customer entry point writes a marker when loaded: Playwright,
 * its config, the package's main and its lifecycle scripts.
 */
async function boobyTrappedWorkspace(root: string, marker: string): Promise<string> {
  const workspace = path.join(root, "workspace");
  const trap = `require("node:fs").appendFileSync(${JSON.stringify(marker)}, __filename + "\\n");\n`;
  for (const pkg of ["playwright-core", "@playwright/test", "playwright"]) {
    const dir = path.join(workspace, "node_modules", pkg);
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, "package.json"), JSON.stringify({ name: pkg, version: "9.9.9", main: "index.js" }));
    await writeFile(path.join(dir, "index.js"), trap);
    await writeFile(path.join(dir, "cli.js"), trap);
  }
  await writeFile(
    path.join(workspace, "package.json"),
    JSON.stringify({
      name: "customer",
      main: "main.js",
      scripts: { preinstall: `node main.js`, test: `node main.js`, pretest: `node main.js` },
    }),
  );
  await writeFile(path.join(workspace, "main.js"), trap);
  await writeFile(path.join(workspace, "playwright.config.ts"), trap);
  await writeFile(path.join(workspace, "playwright.config.js"), trap);
  await mkdir(path.join(workspace, "peeps", "load"), { recursive: true });
  await writeFile(path.join(workspace, "peeps", "load", "journey.ts"), trap);
  return workspace;
}

/** A `--require` preload that records every child_process call the action makes (O12). */
async function spawnSpy(root: string, log: string): Promise<string> {
  const file = path.join(root, "spawn-spy.cjs");
  await writeFile(
    file,
    `const cp = require("node:child_process");
const fs = require("node:fs");
for (const name of ["spawn", "spawnSync", "exec", "execSync", "execFile", "execFileSync", "fork"]) {
  const original = cp[name];
  cp[name] = function (...args) {
    fs.appendFileSync(${JSON.stringify(log)}, name + " " + JSON.stringify(args[0]) + "\\n");
    return original.apply(this, args);
  };
}
`,
  );
  return file;
}

async function runAction(env: NodeJS.ProcessEnv, cwd: string) {
  const child = spawn(process.execPath, [action], { cwd, env, stdio: ["ignore", "pipe", "pipe"] });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk: Buffer) => (stdout += chunk.toString()));
  child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString()));
  const code = await new Promise<number | null>((resolve) => child.on("close", resolve));
  return { code, stdout, stderr };
}

async function setUp(t: TestContext) {
  const root = await mkdtemp(path.join(tmpdir(), "peeps-load-refusal-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const marker = path.join(root, "customer-code-ran");
  const spawns = path.join(root, "spawns");
  const workspace = await boobyTrappedWorkspace(root, marker);
  const spy = await spawnSpy(root, spawns);
  const peeps = await recordingServer(t);
  const oidc = await recordingServer(t);
  const env: NodeJS.ProcessEnv = {
    PATH: process.env.PATH,
    HOME: root,
    NODE_OPTIONS: `--require ${spy}`,
    GITHUB_ACTIONS: "true",
    GITHUB_WORKSPACE: workspace,
    GITHUB_REPOSITORY: "acme/shop",
    GITHUB_SHA: "0123456789abcdef0123456789abcdef01234567",
    GITHUB_REF: "refs/heads/main",
    GITHUB_EVENT_NAME: "workflow_dispatch",
    PEEPS_API_URL: peeps.url,
    ACTIONS_ID_TOKEN_REQUEST_URL: `${oidc.url}/token?audience=x`,
    ACTIONS_ID_TOKEN_REQUEST_TOKEN: "request-token",
    "INPUT_GITHUB-TOKEN": "ghs_repository_token",
    "INPUT_SESSION-ID": "session-1",
    "INPUT_PEEPS-ENVIRONMENT": "staging",
  };
  return { root, marker, spawns, workspace, spy, peeps, oidc, env };
}

/** The same job as GitLab CI/CD runs it: no GitHub variables, an ID token, PEEPS_MODE. */
function gitlab(s: Awaited<ReturnType<typeof setUp>>): NodeJS.ProcessEnv {
  return {
    PATH: s.env.PATH,
    HOME: s.root,
    NODE_OPTIONS: s.env.NODE_OPTIONS,
    GITLAB_CI: "true",
    CI_PROJECT_DIR: s.workspace,
    CI_PROJECT_PATH: "acme/shop",
    CI_COMMIT_SHA: "0123456789abcdef0123456789abcdef01234567",
    CI_COMMIT_BRANCH: "main",
    CI_PIPELINE_SOURCE: "api",
    CI_SERVER_URL: "https://gitlab.example.com",
    PEEPS_API_URL: s.env.PEEPS_API_URL,
    PEEPS_ID_TOKEN: "id-token",
  };
}

type Setup = Awaited<ReturnType<typeof setUp>>;

for (const [name, envOf] of [
  ["the mode input", (s: Setup) => ({ ...s.env, INPUT_MODE: "load" })],
  ["the mode input with whitespace", (s: Setup) => ({ ...s.env, INPUT_MODE: "  load\n" })],
  ["PEEPS_MODE on GitHub with no mode input", (s: Setup) => ({ ...s.env, PEEPS_MODE: "load" })],
  // GitHub passes an input left blank as an empty INPUT_MODE; dispatch then reads PEEPS_MODE.
  ["PEEPS_MODE on GitHub with a blank mode input", (s: Setup) => ({ ...s.env, INPUT_MODE: "  ", PEEPS_MODE: "load" })],
  ["PEEPS_MODE on GitLab", (s: Setup) => ({ ...gitlab(s), PEEPS_MODE: "load" })],
] as const) {
  test(`mode: load from ${name} refuses before any customer code, request or process`, async (t) => {
    const s = await setUp(t);
    const result = await runAction(envOf(s), s.workspace);

    assert.equal(result.code, 1, `stdout: ${result.stdout}\nstderr: ${result.stderr}`);
    assert.equal(result.stderr.trim(), MESSAGE);
    // Nothing after the refusal, and no `[peeps] mode=` line before it.
    assert.equal(result.stdout, "");
    assert.equal(existsSync(s.marker), false, "customer code ran");
    assert.deepEqual(s.peeps.hits, [], "Peeps was asked something");
    assert.deepEqual(s.oidc.hits, [], "an OIDC token was requested");
    assert.equal(existsSync(s.spawns) ? await readFile(s.spawns, "utf8") : "", "", "a process was spawned");
  });
}

test("the spawn spy itself records spawns, so its silence above means something", async (t) => {
  const s = await setUp(t);
  const child = spawn(process.execPath, ["-e", `require("node:child_process").spawnSync(process.execPath, ["-e", ""])`], {
    env: s.env,
    stdio: "ignore",
  });
  await new Promise((resolve) => child.on("close", resolve));
  assert.match(await readFile(s.spawns, "utf8"), /^spawnSync /);
});

test("another mode in the same trapped workspace does reach out, so the traps are live", async (t) => {
  const s = await setUp(t);
  const result = await runAction({ ...s.env, INPUT_MODE: "inventory" }, s.workspace);
  assert.notEqual(result.stderr.trim(), MESSAGE);
  const reached = s.peeps.hits.length + s.oidc.hits.length + (existsSync(s.spawns) ? 1 : 0) + (existsSync(s.marker) ? 1 : 0);
  assert.ok(reached > 0, `inventory touched nothing: ${result.stdout}${result.stderr}`);
});

/** Did the action go on to do another mode's work (reach Peeps or OIDC, spawn, load code)? */
async function reachedOut(s: Setup, result: { stdout: string; stderr: string }) {
  const reached = s.peeps.hits.length + s.oidc.hits.length + (existsSync(s.spawns) ? 1 : 0) + (existsSync(s.marker) ? 1 : 0);
  assert.ok(reached > 0, `the other mode touched nothing: ${result.stdout}${result.stderr}`);
}

for (const [name, envOf] of [
  // GitLab dispatch reads only PEEPS_MODE: a stray INPUT_MODE must not abort its mode.
  ["a stray INPUT_MODE=load on GitLab", (s: Setup) => ({ ...gitlab(s), INPUT_MODE: "load", PEEPS_MODE: "inventory" })],
  // On GitHub the mode input wins over PEEPS_MODE.
  ["PEEPS_MODE=load under a GitHub mode input", (s: Setup) => ({ ...s.env, INPUT_MODE: "inventory", PEEPS_MODE: "load" })],
] as const) {
  test(`${name} runs the mode dispatch would run, not the refusal`, async (t) => {
    const s = await setUp(t);
    const result = await runAction(envOf(s), s.workspace);
    assert.notEqual(result.stderr.trim(), MESSAGE);
    assert.match(result.stdout, /\[peeps\] mode=inventory/);
    await reachedOut(s, result);
  });
}
