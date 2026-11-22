/**
 * The published action's `mode: load` entry, `mainCustomerLoad` (CW plan §4.3–§4.5, §6.2): what
 * it hands the supervisor, what it prints for each kind of refusal, and that it reads no
 * `PEEPS_LOAD_*` variable.
 */
import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { NOT_PINNED_LINE, REFUSAL_COPY } from "../src/load/customer";
import { mainCustomerLoad, readCustomerInputs, type CustomerEntryDeps } from "../src/load/main";
import type { IdentityRead } from "../src/load/oidc";
import type { LoadRunOptions } from "../src/load/supervisor";
import { rig } from "./support/run-supervisor";

const DIST = path.resolve(__dirname, "../dist");
const SHA = "0123456789abcdef0123456789abcdef01234567";
const SENTINEL = "tok-SENTINEL-c71e0a";
const GRANT = "q2Jx7Vf0bH1kR8sTzW4uYg";

function toolCache(t: TestContext): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), "peeps-load-tc-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  mkdirSync(path.join(dir, "node", "24.22.3", "x64", "bin"), { recursive: true });
  return dir;
}

function env(tc: string, over: Record<string, string | undefined> = {}): NodeJS.ProcessEnv {
  return {
    GITHUB_ACTIONS: "true",
    GITHUB_ACTION_REF: SHA,
    GITHUB_JOB: "peeps-load",
    GITHUB_EVENT_NAME: "workflow_dispatch",
    GITHUB_WORKSPACE: "/home/runner/work/shop/shop",
    GITHUB_RUN_ID: "18000000001",
    GITHUB_RUN_ATTEMPT: "1",
    RUNNER_TOOL_CACHE: tc,
    PATH: `${tc}/node/22.11.0/x64/bin:/usr/bin`,
    ACTIONS_ID_TOKEN_REQUEST_URL: "https://pipelines.actions.githubusercontent.com/abc/idtoken?api-version=2.0",
    ACTIONS_ID_TOKEN_REQUEST_TOKEN: SENTINEL,
    "INPUT_LOAD-GRANT": GRANT,
    "INPUT_LOAD-WORKLOAD": "peeps/load/robots.workload.yaml",
    PEEPS_API_URL: "https://dev.peepsai.com",
    ...over,
  };
}

const FACTS = { root: "/nonexistent-root", arch: "x64", hostname: () => "runnervm" };
const OK_ID: IdentityRead = { ok: true, checkRunId: 52000000001, runAttempt: 1 };

interface Seen {
  out: string[];
  err: string[];
  given?: LoadRunOptions;
  identityCalls: number;
}

function deps(seen: Seen, id: IdentityRead = OK_ID, run?: CustomerEntryDeps["run"]): CustomerEntryDeps {
  return {
    facts: FACTS,
    write: (l) => seen.out.push(l),
    error: (l) => seen.err.push(l),
    identity: async () => {
      seen.identityCalls++;
      return id;
    },
    run: run ?? (async () => { throw new Error("not reached"); }),
    signals: () => ({ signal: new AbortController().signal, hard: new AbortController().signal, received: [], dispose: () => undefined }),
  };
}

const fresh = (): Seen => ({ out: [], err: [], identityCalls: 0 });

test("a pinned job runs the supervisor on the toolcache's Node, the token's identity, the download install and no harness list", async (t) => {
  const tc = toolCache(t);
  const r = await rig(t);
  const res = await r.result;
  const seen = fresh();
  const code = await mainCustomerLoad(env(tc), deps(seen, OK_ID, async (o) => {
    seen.given = o;
    return res;
  }), DIST);
  assert.equal(code, 0);
  const g = seen.given!;
  assert.equal(g.nodeDir, `${tc}/node/24.22.3/x64`);
  assert.equal(g.checkRunId, 52000000001);
  assert.equal(g.runAttempt, 1);
  assert.equal(g.actionVersion, SHA);
  assert.deepEqual(g.install, { mode: "fetch" });
  assert.equal(g.harnessHosts, undefined);
  assert.equal(g.grantRef, GRANT);
  assert.equal(g.workloadPath, "peeps/load/robots.workload.yaml");
  assert.equal(g.workspace, "/home/runner/work/shop/shop");
  assert.equal(g.actionDir, DIST);
  assert.equal(seen.identityCalls, 1);
  assert.deepEqual(seen.err, []);
  assert.equal(JSON.parse(seen.out[0]!).status, "completed");
  assert.ok(!seen.out.join("\n").includes(SENTINEL));
});

test("the inputs come from PEEPS_API_URL and the job, never from PEEPS_LOAD_* variables", (t) => {
  const tc = toolCache(t);
  const harness = {
    PEEPS_URL: "https://attacker.example.com",
    PEEPS_LOAD_GRANT: "AbCdEfGhIjKlMnOpQrStUv",
    PEEPS_LOAD_WORKLOAD: "peeps/load/other.workload.yaml",
    PEEPS_LOAD_NPM_CACHE: "/tmp/cache",
    PEEPS_LOAD_SINK_HOSTS: "sink.example.com",
    PEEPS_LOAD_CHECK_RUN_ID: "1",
    PEEPS_LOAD_NODE_DIR: "/usr/local",
    PEEPS_LOAD_ACTION_VERSION: "dev",
    PEEPS_LOAD_WORKSPACE: "/elsewhere",
    PEEPS_LOAD_RESULT_FILE: "/tmp/result.json",
  };
  const plain = readCustomerInputs(env(tc), DIST, FACTS);
  const withHarness = readCustomerInputs(env(tc, harness), DIST, FACTS);
  assert.ok(plain.ok && withHarness.ok);
  assert.deepEqual(withHarness, plain);
  assert.equal(plain.inputs.peepsUrl, "https://dev.peepsai.com");
  assert.equal(plain.inputs.resultFile, undefined);
  assert.deepEqual(plain.inputs.scope, { kind: "customer" });
  const slash = readCustomerInputs(env(tc, { PEEPS_API_URL: "https://app.peepsai.com/" }), DIST, FACTS);
  assert.ok(slash.ok && slash.inputs.peepsUrl === "https://app.peepsai.com", "one trailing slash is dropped");
});

test("an unpinned ref prints today's line alone, on stderr: no title, no JSON, no summary, no identity", async (t) => {
  const tc = toolCache(t);
  const dir = mkdtempSync(path.join(os.tmpdir(), "peeps-load-sum-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const summary = path.join(dir, "summary.md");
  for (const ref of ["v1", undefined]) {
    const seen = fresh();
    const code = await mainCustomerLoad(env(tc, { GITHUB_ACTION_REF: ref, GITHUB_STEP_SUMMARY: summary }), deps(seen), DIST);
    assert.equal(code, 1);
    assert.deepEqual(seen.err, [NOT_PINNED_LINE]);
    assert.deepEqual(seen.out, []);
    assert.equal(seen.identityCalls, 0);
  }
  assert.throws(() => readFileSync(summary), /ENOENT/);
});

test("a local refusal prints one titled ::error line, the copy in the summary and {refused}, before the identity is read", async (t) => {
  const tc = toolCache(t);
  const dir = mkdtempSync(path.join(os.tmpdir(), "peeps-load-sum-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const cases: [Record<string, string | undefined>, keyof typeof REFUSAL_COPY, string][] = [
    [{ ACTIONS_ID_TOKEN_REQUEST_TOKEN: undefined }, "not_github", REFUSAL_COPY.not_github],
    [{ GITHUB_JOB: "peeps" }, "job", REFUSAL_COPY.job],
    [{ GITHUB_RUN_ATTEMPT: "2" }, "rerun", REFUSAL_COPY.rerun],
    [{ GITHUB_WORKSPACE: "/__w/shop/shop" }, "fence_unverified", REFUSAL_COPY.fence_unverified.replace("{id}", "the job's container")],
    [{ NODE_OPTIONS: `--require ${SENTINEL}` }, "node_options", REFUSAL_COPY.node_options.replace("{vars}", "NODE_OPTIONS")],
    [{ RUNNER_TOOL_CACHE: "/nonexistent-tc", PATH: "/nonexistent-tc/node/22.11.0/x64/bin" }, "node_version", REFUSAL_COPY.node_version.replace("{found}", "22.11.0")],
    [{ "INPUT_LOAD-GRANT": SENTINEL }, "input", REFUSAL_COPY.input.replace("{name}", "loadGrant")],
    [{ PEEPS_API_URL: undefined }, "control_origin", REFUSAL_COPY.control_origin],
    [{ PEEPS_API_URL: "https://attacker.example.com" }, "control_origin", REFUSAL_COPY.control_origin],
  ];
  for (const [over, code, message] of cases) {
    const summary = path.join(dir, `${code}-${Math.random().toString(36).slice(2)}.md`);
    const seen = fresh();
    assert.equal(await mainCustomerLoad(env(tc, { ...over, GITHUB_STEP_SUMMARY: summary }), deps(seen), DIST), 1);
    assert.deepEqual(seen.err, [`::error title=Peeps load run::${message}`], code);
    assert.deepEqual(seen.out, [JSON.stringify({ refused: code })]);
    assert.equal(readFileSync(summary, "utf8"), `## Peeps load run\n\n${message}\n`);
    assert.equal(seen.identityCalls, 0, code);
    assert.ok(!(seen.err.join("") + seen.out.join("")).includes(SENTINEL), code);
  }
});

test("the identity's refusals print their copy; a failed mint is a failure line; neither runs the supervisor", async (t) => {
  const tc = toolCache(t);
  for (const [id, err, out] of [
    [{ ok: false, refused: "identity" }, [`::error title=Peeps load run::${REFUSAL_COPY.identity}`], ['{"refused":"identity"}']],
    [{ ok: false, refused: "self_hosted" }, [`::error title=Peeps load run::${REFUSAL_COPY.self_hosted}`], ['{"refused":"self_hosted"}']],
    [{ ok: false, failed: "oidc" }, [], ['{"failed":"oidc"}']],
  ] as const) {
    const seen = fresh();
    assert.equal(await mainCustomerLoad(env(tc), deps(seen, id), DIST), 1);
    assert.deepEqual(seen.err, err);
    assert.deepEqual(seen.out, out);
  }
});
