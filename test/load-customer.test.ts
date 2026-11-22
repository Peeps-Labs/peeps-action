/**
 * The customer load job's local refusals (CW plan §4.3, §6.2): one case per row, in order, each
 * with its exact copy; then the facts as `readJobFacts` gathers them over a temp root.
 */
import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { customerRefusal, loadNodeDir, NOT_PINNED_LINE, PRELOAD_VARS, REFUSAL_COPY, type JobFacts } from "../src/load/customer";
import { pathNodeVersions, readJobFacts } from "../src/load/job-facts";

const SHA = "0123456789abcdef0123456789abcdef01234567";
const SENTINEL = "SENTINEL-value-7f3c";
const COPY = JSON.parse(readFileSync(path.resolve(__dirname, "fixtures/load-job/v1-copy/refusal-copy.json"), "utf8")) as Record<string, string>;

function facts(over: Partial<JobFacts> = {}): JobFacts {
  return {
    github: true,
    oidcUrl: true,
    oidcToken: true,
    actionRef: SHA,
    job: "peeps-load",
    eventName: "workflow_dispatch",
    runAttempt: "1",
    dockerenv: false,
    workspace: "/home/runner/work/shop/shop",
    hostname: "runnervmabc12",
    toolCache: "/opt/hostedtoolcache",
    trustedNodePresent: true,
    pathNodeVersions: ["24.22.3"],
    preloadVars: [],
    grant: "q2Jx7Vf0bH1kR8sTzW4uYg",
    workload: "peeps/load/robots.workload.yaml",
    apiUrl: "https://dev.peepsai.com",
    ...over,
  };
}

const code = (f: Partial<JobFacts>) => customerRefusal(facts(f))?.code ?? null;

test("a well-formed pinned load job is not refused", () => {
  assert.equal(customerRefusal(facts()), null);
});

test("anything not pinned to a commit refuses first, with today's line, with or without id-token", () => {
  for (const actionRef of [null, "v1", "main", "v1.17.0", SHA.toUpperCase(), SHA.slice(1), `${SHA}0`]) {
    for (const oidc of [true, false]) {
      const r = customerRefusal(facts({ actionRef, oidcUrl: oidc, oidcToken: oidc, github: oidc, job: "peeps", runAttempt: "2" }));
      assert.equal(r?.code, "action_not_pinned", String(actionRef));
      assert.equal(`::error::${r?.message}`, NOT_PINNED_LINE);
    }
  }
  assert.equal(NOT_PINNED_LINE, "::error::Load testing isn't available for this repository yet.");
});

test("each row refuses with its code and copy, in order", () => {
  const rows: [Partial<JobFacts>, string, string][] = [
    [{ oidcToken: false }, "not_github", COPY.not_github!],
    [{ oidcUrl: false }, "not_github", COPY.not_github!],
    [{ github: false }, "not_github", COPY.not_github!],
    [{ job: "peeps" }, "job", COPY.job!],
    [{ eventName: "push" }, "job", COPY.job!],
    [{ job: null }, "job", COPY.job!],
    [{ runAttempt: "2" }, "rerun", COPY.rerun!],
    [{ dockerenv: true, hostname: "0123456789ab" }, "fence_unverified", COPY.fence_unverified!.replace("{id}", "0123456789ab")],
    [{ workspace: "/__w/shop/shop", hostname: "my-builder" }, "fence_unverified", COPY.fence_unverified!.replace("{id}", "the job's container")],
    [{ preloadVars: ["NODE_OPTIONS", "LD_PRELOAD"] }, "node_options", COPY.node_options!.replace("{vars}", "NODE_OPTIONS, LD_PRELOAD")],
    [{ trustedNodePresent: false, pathNodeVersions: ["22.12.0"] }, "node_version", COPY.node_version!.replace("{found}", "22.12.0")],
    [{ trustedNodePresent: false, pathNodeVersions: [] }, "node_version", COPY.node_version!.replace("{found}", "no Node")],
    [{ grant: "q2Jx7Vf0bH1kR8sTzW4uY" }, "input", COPY.input!.replace("{name}", "loadGrant")],
    [{ grant: null, workload: null }, "input", COPY.input!.replace("{name}", "loadGrant, loadWorkload")],
    [{ apiUrl: null }, "control_origin", COPY.control_origin!],
    [{ apiUrl: "https://peeps-dev.fly.dev" }, "control_origin", COPY.control_origin!],
  ];
  for (const [over, expected, message] of rows) {
    const r = customerRefusal(facts(over));
    assert.equal(r?.code, expected, JSON.stringify(over));
    assert.equal(r?.message, message, JSON.stringify(over));
    assert.doesNotMatch(r!.message, /\{\w+\}/, "every slot is filled");
  }
});

test("the first matching row wins: a re-run in a container is a re-run; a pin wins over everything", () => {
  assert.equal(code({ runAttempt: "2", dockerenv: true }), "rerun");
  assert.equal(code({ job: "peeps", runAttempt: "2" }), "job");
  assert.equal(code({ oidcToken: false, job: "peeps" }), "not_github");
  assert.equal(code({ dockerenv: true, preloadVars: ["NODE_OPTIONS"] }), "fence_unverified");
  assert.equal(code({ preloadVars: ["NODE_PATH"], trustedNodePresent: false }), "node_options");
  assert.equal(code({ trustedNodePresent: false, grant: null }), "node_version");
  assert.equal(code({ grant: null, apiUrl: null }), "input");
});

test("the input row names the input, never its value", () => {
  for (const [over, name] of [
    [{ grant: `${SENTINEL}` }, "loadGrant"],
    [{ workload: `peeps/${SENTINEL}.workload.yaml` }, "loadWorkload"],
    [{ workload: "peeps/load/../x.workload.yaml" }, "loadWorkload"],
    [{ workload: "/etc/peeps/load/x.workload.yaml" }, "loadWorkload"],
    [{ workload: "peeps/load/x.yaml" }, "loadWorkload"],
    [{ workload: "peeps/load/sub/x.workload.yaml" }, "loadWorkload"],
  ] as [Partial<JobFacts>, string][]) {
    const r = customerRefusal(facts(over));
    assert.equal(r?.code, "input");
    assert.equal(r?.message, COPY.input!.replace("{name}", name));
    assert.ok(!r!.message.includes(SENTINEL));
  }
  assert.equal(code({ workload: "peeps/load/robots.workload.yml" }), null);
});

test("the copy table is the fixture's refusal-copy.json, every code", () => {
  assert.deepEqual({ ...REFUSAL_COPY }, COPY);
});

test("loadNodeDir is computed from the toolcache, never from PATH or the running Node", () => {
  assert.equal(loadNodeDir("/opt/hostedtoolcache", "x64"), "/opt/hostedtoolcache/node/24.22.3/x64");
  assert.equal(loadNodeDir("/opt/hostedtoolcache/", "arm64"), "/opt/hostedtoolcache/node/24.22.3/arm64");
});

// ---------------------------------------------------------------- the facts

function tmp(t: TestContext): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), "peeps-job-facts-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function env(root: string, over: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return {
    GITHUB_ACTIONS: "true",
    GITHUB_WORKSPACE: "/home/runner/work/shop/shop",
    GITHUB_RUN_ID: "18000000001",
    GITHUB_RUN_ATTEMPT: "1",
    GITHUB_JOB: "peeps-load",
    GITHUB_EVENT_NAME: "workflow_dispatch",
    GITHUB_ACTION_REF: SHA,
    ACTIONS_ID_TOKEN_REQUEST_URL: "https://x.actions.githubusercontent.com/idtoken",
    ACTIONS_ID_TOKEN_REQUEST_TOKEN: SENTINEL,
    RUNNER_TOOL_CACHE: path.join(root, "toolcache"),
    PATH: `${path.join(root, "toolcache/node/24.22.3/x64/bin")}:/usr/bin:/bin`,
    "INPUT_LOAD-GRANT": "q2Jx7Vf0bH1kR8sTzW4uYg",
    "INPUT_LOAD-WORKLOAD": "peeps/load/robots.workload.yaml",
    PEEPS_API_URL: "https://dev.peepsai.com",
    ...over,
  };
}

function toolcache(root: string, version = "24.22.3"): string {
  const bin = path.join(root, "toolcache/node", version, "x64/bin");
  mkdirSync(bin, { recursive: true });
  // A node that leaves a marker if it is ever run.
  writeFileSync(path.join(bin, "node"), `#!/bin/sh\ntouch ${path.join(root, "node-ran")}\necho v${version}\n`);
  chmodSync(path.join(bin, "node"), 0o755);
  return bin;
}

test("readJobFacts reads the job's environment and two file system signals, and runs nothing", (t) => {
  const root = tmp(t);
  toolcache(root);
  const f = readJobFacts(env(root), { root, hostname: () => "0123456789ab", arch: "x64" });
  assert.deepEqual(f, {
    github: true, oidcUrl: true, oidcToken: true, actionRef: SHA, job: "peeps-load", eventName: "workflow_dispatch", runAttempt: "1",
    dockerenv: false, workspace: "/home/runner/work/shop/shop", hostname: "0123456789ab", toolCache: path.join(root, "toolcache"),
    trustedNodePresent: true, pathNodeVersions: ["24.22.3"], preloadVars: [], grant: "q2Jx7Vf0bH1kR8sTzW4uYg",
    workload: "peeps/load/robots.workload.yaml", apiUrl: "https://dev.peepsai.com",
  });
  assert.equal(customerRefusal(f), null);
  assert.ok(!JSON.stringify(f).includes(SENTINEL), "the request token is a flag, never kept");
  assert.equal(existsSync(path.join(root, "node-ran")), false);
});

test("a container: /.dockerenv under the root, or a /__w/ workspace", (t) => {
  const root = tmp(t);
  toolcache(root);
  writeFileSync(path.join(root, ".dockerenv"), "");
  assert.equal(customerRefusal(readJobFacts(env(root), { root, hostname: () => "0123456789ab", arch: "x64" }))?.message, COPY.fence_unverified!.replace("{id}", "0123456789ab"));
  const plain = tmp(t);
  toolcache(plain);
  assert.equal(customerRefusal(readJobFacts(env(plain, { GITHUB_WORKSPACE: "/__w/shop/shop" }), { root: plain, hostname: () => "builder", arch: "x64" }))?.code, "fence_unverified");
});

test("GitHub's own variables decide not_github: a relative workspace or a run id that isn't a number", (t) => {
  const root = tmp(t);
  toolcache(root);
  for (const over of [{ GITHUB_ACTIONS: undefined }, { GITHUB_WORKSPACE: "work" }, { GITHUB_RUN_ID: "x" }, { ACTIONS_ID_TOKEN_REQUEST_TOKEN: "" }]) {
    assert.equal(customerRefusal(readJobFacts(env(root, over), { root, arch: "x64" }))?.code, "not_github", JSON.stringify(over));
  }
});

test("each loader variable set alone is named, never its value; all six empty, as the job sets them, is not refused", (t) => {
  const root = tmp(t);
  toolcache(root);
  for (const name of PRELOAD_VARS) {
    const r = customerRefusal(readJobFacts(env(root, { [name]: SENTINEL }), { root, arch: "x64" }));
    assert.equal(r?.code, "node_options", name);
    assert.equal(r?.message, COPY.node_options!.replace("{vars}", name));
    assert.ok(!r!.message.includes(SENTINEL));
  }
  const blanks = Object.fromEntries(PRELOAD_VARS.map((n) => [n, ""]));
  assert.equal(customerRefusal(readJobFacts(env(root, blanks), { root, arch: "x64" })), null);
});

test("node_version: names the toolcache versions on PATH, read as text; 24.22.3 present is enough", (t) => {
  const root = tmp(t);
  const bin22 = toolcache(root, "22.12.0");
  const f = readJobFacts(env(root, { PATH: `${bin22}:/usr/bin` }), { root, arch: "x64" });
  assert.equal(customerRefusal(f)?.message, COPY.node_version!.replace("{found}", "22.12.0"));
  toolcache(root, "24.22.3");
  assert.equal(customerRefusal(readJobFacts(env(root, { PATH: `${bin22}:/usr/bin` }), { root, arch: "x64" })), null, "the job runs on the hash-checked 24.22.3 whatever PATH holds");
  assert.equal(existsSync(path.join(root, "node-ran")), false, "nothing on PATH was run");
});

test("pathNodeVersions drops entries that aren't a version, keeps at most five, and carries no newline or workflow command", () => {
  const tc = "/opt/hostedtoolcache";
  const entry = (v: string) => `${tc}/node/${v}/x64/bin`;
  assert.deepEqual(pathNodeVersions([entry("22.12.0"), entry("22.12.0\n::error::x"), entry("1.2.3::warning"), entry("1.2"), "/usr/bin", `${tc}/node/20.1.0/arm64/bin`].join(":"), tc, "x64"), ["22.12.0"]);
  const six = ["1.0.0", "2.0.0", "3.0.0", "4.0.0", "5.0.0", "6.0.0"].map(entry).join(":");
  assert.deepEqual(pathNodeVersions(six, tc, "x64"), ["1.0.0", "2.0.0", "3.0.0", "4.0.0", "5.0.0"]);
  assert.deepEqual(pathNodeVersions(`${entry("22.12.0")}/:${entry("22.12.0")}`, `${tc}/`, "x64"), ["22.12.0"]);
});

test("the inputs are GitHub's INPUT_LOAD-GRANT and INPUT_LOAD-WORKLOAD, trimmed; PEEPS_LOAD_* is never read", (t) => {
  const root = tmp(t);
  toolcache(root);
  const f = readJobFacts(env(root, { "INPUT_LOAD-GRANT": "  q2Jx7Vf0bH1kR8sTzW4uYg\n", "INPUT_LOAD-WORKLOAD": undefined, PEEPS_LOAD_WORKLOAD: "peeps/load/robots.workload.yaml", PEEPS_LOAD_GRANT: "x" }), { root, arch: "x64" });
  assert.equal(f.grant, "q2Jx7Vf0bH1kR8sTzW4uYg");
  assert.equal(f.workload, null);
});
