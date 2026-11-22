/**
 * `dist/load.js`, the direct load entry the go-line workflow runs (e5 plan §4, v2 §4, v3 §2.4 and
 * §4): its inputs, what it writes, and that nothing of it reaches the published action's
 * `dist/index.js`, which hands `mode: load` to `mainCustomerLoad` only (load-handoff.test.ts).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { mainLoad, readLoadInputs } from "../src/load/main";
import type { LoadRunOptions } from "../src/load/supervisor";
import { rig } from "./support/run-supervisor";

const DIST = path.resolve(__dirname, "../dist");
const SENTINEL = "tok-SENTINEL-4f1c9a";
const GRANT = "AbCdEfGhIjKlMnOpQrStUv";

function env(over: Record<string, string | undefined> = {}): NodeJS.ProcessEnv {
  return {
    PEEPS_URL: "https://peeps-dev.example.com",
    PEEPS_LOAD_GRANT: GRANT,
    ACTIONS_ID_TOKEN_REQUEST_URL: "https://pipelines.actions.githubusercontent.com/abc/idtoken?api-version=2.0",
    ACTIONS_ID_TOKEN_REQUEST_TOKEN: SENTINEL,
    GITHUB_WORKSPACE: "/home/runner/work/fixture/fixture",
    PEEPS_LOAD_WORKLOAD: "peeps/load/golive.workload.yaml",
    PEEPS_LOAD_NPM_CACHE: "/home/runner/work/fixture/fixture/.peeps-load/npm-cache",
    PEEPS_LOAD_SINK_HOSTS: "sink.peeps-harness.example.com",
    GITHUB_RUN_ID: "18000000001",
    GITHUB_RUN_ATTEMPT: "1",
    PEEPS_LOAD_CHECK_RUN_ID: "52000000001",
    ...over,
  };
}

test("the entry's inputs: each one checked, a problem named by its variable, never its value", () => {
  const ok = readLoadInputs(env(), DIST, "/opt/hostedtoolcache/node/24.22.3/x64/bin/node");
  assert.ok(ok.ok);
  assert.equal(ok.inputs.runId, "gh-18000000001-1");
  assert.equal(ok.inputs.nodeDir, "/opt/hostedtoolcache/node/24.22.3/x64");
  assert.deepEqual(ok.inputs.scope, { kind: "harness", sinkHosts: ["sink.peeps-harness.example.com"] });
  assert.deepEqual(ok.inputs.install, { mode: "offline", cache: env().PEEPS_LOAD_NPM_CACHE });
  assert.equal(ok.inputs.checkRunId, 52000000001);
  assert.equal(ok.inputs.workspace, "/home/runner/work/fixture/fixture");
  const app = readLoadInputs(env({ PEEPS_LOAD_WORKSPACE: "/home/runner/work/fixture/fixture/app" }), DIST);
  assert.ok(app.ok && app.inputs.workspace === "/home/runner/work/fixture/fixture/app");
  const cases: [Record<string, string | undefined>, string][] = [
    [{ NODE_DEBUG: "fs" }, "NODE_DEBUG"],
    [{ PEEPS_URL: undefined }, "PEEPS_URL"],
    [{ PEEPS_LOAD_GRANT: "short" }, "PEEPS_LOAD_GRANT"],
    [{ PEEPS_LOAD_GRANT: `${GRANT}x` }, "PEEPS_LOAD_GRANT"],
    [{ ACTIONS_ID_TOKEN_REQUEST_TOKEN: undefined }, "ACTIONS_ID_TOKEN_REQUEST_URL"],
    [{ GITHUB_WORKSPACE: "relative" }, "PEEPS_LOAD_WORKSPACE"],
    [{ PEEPS_LOAD_WORKSPACE: "relative" }, "PEEPS_LOAD_WORKSPACE"],
    [{ PEEPS_LOAD_WORKLOAD: "../outside.yaml" }, "PEEPS_LOAD_WORKLOAD"],
    [{ PEEPS_LOAD_WORKLOAD: "/etc/passwd" }, "PEEPS_LOAD_WORKLOAD"],
    [{ PEEPS_LOAD_NPM_CACHE: "cache" }, "PEEPS_LOAD_NPM_CACHE"],
    [{ PEEPS_LOAD_SINK_HOSTS: "" }, "PEEPS_LOAD_SINK_HOSTS"],
    [{ PEEPS_LOAD_SINK_HOSTS: "https://sink.example.com" }, "PEEPS_LOAD_SINK_HOSTS"],
    [{ GITHUB_RUN_ATTEMPT: "x" }, "GITHUB_RUN_ID"],
    [{ PEEPS_LOAD_CHECK_RUN_ID: "0" }, "PEEPS_LOAD_CHECK_RUN_ID"],
    [{ PEEPS_LOAD_ACTION_VERSION: "has space" }, "PEEPS_LOAD_ACTION_VERSION"],
    [{ PEEPS_LOAD_RESULT_FILE: "result.json" }, "PEEPS_LOAD_RESULT_FILE"],
  ];
  for (const [over, problem] of cases) assert.deepEqual(readLoadInputs(env(over), DIST), { ok: false, problem }, JSON.stringify(over));
});

test("mainLoad runs the supervisor with the harness hosts, the grant and the recipe cache, and writes no token anywhere", async (t) => {
  const r = await rig(t);
  const res = await r.result;
  const dir = mkdtempSync(path.join(os.tmpdir(), "peeps-load-entry-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const lines: string[] = [];
  let given: LoadRunOptions | undefined;
  const summary = path.join(dir, "summary.md");
  const result = path.join(dir, "result.json");
  const code = await mainLoad(env({ GITHUB_STEP_SUMMARY: summary, PEEPS_LOAD_RESULT_FILE: result }), {
    run: async (o) => {
      given = o;
      return res;
    },
    write: (line) => lines.push(line),
    signals: () => ({ signal: new AbortController().signal, hard: new AbortController().signal, received: [], dispose: () => undefined }),
  }, DIST);
  assert.equal(res.status, "completed");
  assert.equal(code, 0);
  assert.equal(given!.grantRef, GRANT);
  assert.deepEqual(given!.harnessHosts, ["sink.peeps-harness.example.com"]);
  assert.deepEqual(given!.install, { mode: "offline", cache: env().PEEPS_LOAD_NPM_CACHE });
  assert.equal(given!.actionDir, DIST);
  assert.equal(lines.length, 1);
  const report = JSON.parse(lines[0]!);
  assert.equal(report.status, res.status);
  assert.equal(report.latency.count, res.latency.count);
  assert.equal(report.latency.records, undefined, "the stdout line carries the summary, not every record");
  assert.match(readFileSync(summary, "utf8"), /\| Renewals \| p50 \| p99 \| p99\.9 \| max \| unanswered \|/);
  assert.deepEqual(JSON.parse(readFileSync(result, "utf8")).latency.records, res.latency.records);
  const written = lines.join("\n") + readFileSync(summary, "utf8") + readFileSync(result, "utf8");
  for (const secret of [SENTINEL, r.port.runToken, r.port.eventsToken]) assert.ok(!written.includes(secret), "a token was written");
  assert.doesNotMatch(written, /::(?:add-mask|set-output|warning|error)/);
});

test("the entry reduces a startup exception to a fixed diagnostic", async () => {
  const lines: string[] = [];
  const code = await mainLoad(env(), {
    run: async () => { throw new Error(`${SENTINEL}\n::error::untrusted detail`); },
    write: (line) => lines.push(line),
  }, DIST);
  assert.equal(code, 1);
  assert.deepEqual(lines, ['{"failed":"run_or_report"}']);
});

test("a report write error emits a fixed diagnostic and preserves the result artifact", async (t) => {
  const r = await rig(t);
  const res = await r.result;
  const dir = mkdtempSync(path.join(os.tmpdir(), "peeps-load-entry-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const lines: string[] = [];
  const result = path.join(dir, "result.json");
  const summary = path.join(dir, SENTINEL, "\n::error::untrusted path");
  const code = await mainLoad(env({ GITHUB_STEP_SUMMARY: summary, PEEPS_LOAD_RESULT_FILE: result }), {
    run: async () => res,
    write: (line) => lines.push(line),
  }, DIST);
  assert.equal(code, 1);
  assert.deepEqual(lines, ['{"failed":"run_or_report"}']);
  assert.deepEqual(JSON.parse(readFileSync(result, "utf8")), res);
});

test("a completed measurement fails the go-line job when shutdown proof or final evidence is missing", async (t) => {
  const r = await rig(t);
  const res = await r.result;
  assert.equal(res.status, "completed");
  for (const broken of [
    { ...res, closed: { state: "unanswered", attempts: 1, latencyMs: null } } as const,
    { ...res, evidence: { state: "missing" }, final: "missing" } as const,
    { ...res, cleanup: "dirty" } as const,
  ]) {
    const lines: string[] = [];
    const code = await mainLoad(env(), { run: async () => broken, write: (line) => lines.push(line) }, DIST);
    assert.equal(code, 1);
    assert.equal(JSON.parse(lines[0]!).status, "completed", "preserve the measurement result for diagnosis");
  }
});

function runBundle(e: NodeJS.ProcessEnv): Promise<{ code: number | null; out: string }> {
  return new Promise((resolve) => {
    execFile(process.execPath, [path.join(DIST, "load.js")], { env: { PATH: process.env.PATH, ...e }, timeout: 20_000 }, (error, stdout, stderr) => {
      resolve({ code: error ? (error as { code?: number }).code ?? null : 0, out: stdout + stderr });
    });
  });
}

test("dist/load.js refuses missing inputs, NODE_DEBUG and an OIDC URL off GitHub's hosts, before any request, and prints no token", async () => {
  const missing = await runBundle({ ACTIONS_ID_TOKEN_REQUEST_TOKEN: SENTINEL });
  assert.equal(missing.code, 2);
  assert.deepEqual(JSON.parse(missing.out.trim()), { refused: "input", input: "PEEPS_URL" });
  const debug = await runBundle(env({ NODE_DEBUG: "https" }));
  assert.equal(debug.code, 2);
  assert.deepEqual(JSON.parse(debug.out.trim()), { refused: "input", input: "NODE_DEBUG" });
  const offHost = await runBundle(env({ ACTIONS_ID_TOKEN_REQUEST_URL: "https://attacker.example.com/idtoken" }));
  assert.equal(offHost.code, 2);
  assert.deepEqual(JSON.parse(offHost.out.trim()), { refused: "port", code: "url" });
  for (const r of [missing, debug, offHost]) assert.ok(!r.out.includes(SENTINEL));
});

test("the bundles: dist/load.js prints no add-mask, and none of the load entry is in dist/index.js", () => {
  const load = readFileSync(path.join(DIST, "load.js"), "utf8");
  assert.doesNotMatch(load, /add-mask/);
  assert.match(load, /PEEPS_LOAD_GRANT/);
  const index = readFileSync(path.join(DIST, "index.js"), "utf8");
  for (const marker of ["PEEPS_LOAD_GRANT", "/api/v1/load/", "peeps-load", "HttpControlPort", "beginClosed", "runLoad"]) assert.ok(!index.includes(marker), `dist/index.js holds ${marker}`);
  const pkg = JSON.parse(readFileSync(path.resolve(__dirname, "../package.json"), "utf8")) as { scripts: { build: string } };
  assert.match(pkg.scripts.build, /esbuild src\/load\/main\.ts --bundle [^&]*--outfile=dist\/load\.js/);
});
