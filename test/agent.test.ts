import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { runAgent, runnerInfoFor } from "../src/agent";
import type { RunnerEnv } from "../src/env";
import type { PeepsClient } from "../src/peeps";
import { makeRedactor } from "../src/tools";
import { ACTION_VERSION } from "../src/version";

process.env.GIT_CONFIG_GLOBAL = "/dev/null";
process.env.GIT_CONFIG_NOSYSTEM = "1";

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@e", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@e" },
  }).trim();
}

function envAt(workspace: string, sha: string | null): RunnerEnv {
  return {
    workspace,
    workingDirectory: workspace,
    configPath: "playwright.config.ts",
    sha,
    ref: "refs/heads/main",
  } as unknown as RunnerEnv;
}

test("ACTION_VERSION is a plain semver, the form Peeps compares", () => {
  assert.match(ACTION_VERSION, /^\d+\.\d+\.\d+$/);
});

test("runnerInfo reports the checked-out sha, which differs from the workflow sha when the checkout is pinned", async (t) => {
  const ws = await mkdtemp(path.join(tmpdir(), "peeps-agent-"));
  t.after(() => rm(ws, { recursive: true, force: true }));
  git(ws, "init", "-q", "-b", "main");
  await writeFile(path.join(ws, "a.txt"), "1\n");
  git(ws, "add", "-A");
  git(ws, "commit", "-q", "-m", "one");
  const pinned = git(ws, "rev-parse", "HEAD");
  await writeFile(path.join(ws, "a.txt"), "2\n");
  git(ws, "commit", "-q", "-am", "two");
  const workflowSha = git(ws, "rev-parse", "HEAD");
  // actions/checkout with `ref: <pinned sha>`: a detached HEAD at that sha,
  // while GITHUB_SHA stays the sha the workflow itself ran from.
  git(ws, "checkout", "-q", "--detach", pinned);

  const info = await runnerInfoFor(envAt(ws, workflowSha));

  assert.equal(info.checkoutSha, pinned);
  assert.equal(info.sha, workflowSha);
  assert.equal(info.actionVersion, ACTION_VERSION);
  assert.equal(info.ref, "refs/heads/main");
  assert.equal(info.workingDirectory, ws);
  assert.equal(info.configPath, "playwright.config.ts");
  assert.equal(info.node, process.version);
  // PQA-2695: git_commit_push takes `paths`. A Playwright job's run_tests
  // also names each result's file and a failure's error context (PQA-2733).
  // PQA-3033: run_tests carries the environment Peeps names at attach.
  assert.deepEqual(info.capabilities, ["commit_paths", "environment", "result_files", "error_context"]);
});

test("runnerInfo leaves checkoutSha out when the workspace is not a git checkout", async (t) => {
  const ws = await mkdtemp(path.join(tmpdir(), "peeps-agent-"));
  t.after(() => rm(ws, { recursive: true, force: true }));
  const info = await runnerInfoFor(envAt(ws, null));
  assert.equal("checkoutSha" in info, false);
  assert.equal(info.actionVersion, ACTION_VERSION);
});

test("runnerInfo leaves checkoutSha out when the workspace is only a folder inside another repository", async (t) => {
  const outer = await mkdtemp(path.join(tmpdir(), "peeps-agent-"));
  t.after(() => rm(outer, { recursive: true, force: true }));
  git(outer, "init", "-q", "-b", "main");
  await writeFile(path.join(outer, "a.txt"), "1\n");
  git(outer, "add", "-A");
  git(outer, "commit", "-q", "-m", "one");
  const ws = path.join(outer, "_work", "repo");
  await mkdir(ws, { recursive: true });
  const info = await runnerInfoFor(envAt(ws, null));
  // HEAD there is the enclosing repository's, not this checkout's.
  assert.equal("checkoutSha" in info, false);
});

test("a pytest job's runnerInfo claims neither result_files nor error_context", async (t) => {
  const ws = await mkdtemp(path.join(tmpdir(), "peeps-agent-"));
  t.after(() => rm(ws, { recursive: true, force: true }));
  const info = await runnerInfoFor({ ...envAt(ws, null), configPath: null, framework: "pytest" } as unknown as RunnerEnv);
  assert.deepEqual(info.capabilities, ["commit_paths", "environment"]);
});

test("a job with an unknown framework input claims neither, rather than throwing", async (t) => {
  const ws = await mkdtemp(path.join(tmpdir(), "peeps-agent-"));
  t.after(() => rm(ws, { recursive: true, force: true }));
  const info = await runnerInfoFor({ ...envAt(ws, null), framework: "bogus" } as unknown as RunnerEnv);
  assert.deepEqual(info.capabilities, ["commit_paths", "environment"]);
});

// ---------------------------------------------------------------------------
// The environment Peeps names at attach (PQA-3033)
// ---------------------------------------------------------------------------

const STAGING_URL = "https://staging.example.com";
const TITLE = `test_production_banner_on_${STAGING_URL}`;

/** A pytest job whose `.peeps/run-tests` prints the environment it was started with. */
async function hookJob(t: { after: (fn: () => Promise<void>) => void }): Promise<RunnerEnv> {
  const ws = await mkdtemp(path.join(tmpdir(), "peeps-agent-"));
  t.after(() => rm(ws, { recursive: true, force: true }));
  await mkdir(path.join(ws, ".peeps"));
  await mkdir(path.join(ws, "tests"));
  await writeFile(
    path.join(ws, ".peeps/run-tests"),
    `#!/bin/sh\nprintf '<testsuite><testcase classname="tests.test_a" name="${TITLE}" file="tests/test_a.py"/></testsuite>' > "$1"\n` +
      `echo "BASE_URL=$BASE_URL"\necho "PEEPS_BASE_URL=$PEEPS_BASE_URL"\necho "PEEPS_ENVIRONMENT=$PEEPS_ENVIRONMENT"\n`,
  );
  await chmod(path.join(ws, ".peeps/run-tests"), 0o755);
  await writeFile(path.join(ws, "tests/test_a.py"), "def test_a(): pass\n");
  git(ws, "init", "-q", "-b", "main");
  git(ws, "add", "-A");
  git(ws, "commit", "-q", "-m", "init");
  return { workspace: ws, workingDirectory: ws, configPath: null, framework: "pytest", platform: "github", sessionId: "s1" } as unknown as RunnerEnv;
}

interface RunResult {
  ok: boolean;
  result: { outputTail: string; results: Array<{ title: string; titleRedacted?: boolean }> };
}

/** A session that attaches with `answer`, asks for one run_tests, then ends. */
function sessionAnswering(answer: Record<string, unknown>) {
  const delivered: RunResult[] = [];
  let polls = 0;
  const peeps = {
    post: async (route: string, body: unknown) => {
      if (route.endsWith("/attach")) {
        return { sessionId: "s1", kind: "heal", expiresAt: new Date(Date.now() + 60_000).toISOString(), ...answer };
      }
      delivered.push(body as RunResult);
      return {};
    },
    getOrNull: async () => {
      polls += 1;
      if (polls > 1) throw new Error("GET calls → 410");
      return { call: { id: "c1", seq: 1, tool: "run_tests", args: { file: "tests/test_a.py" } } };
    },
  } as unknown as PeepsClient;
  return { peeps, delivered, polls: () => polls };
}

/** Runs with no `BASE_URL` of the workflow's, or with `workflow`'s. */
function workflowBaseUrl(t: { after: (fn: () => void) => void }, workflow?: string) {
  const previous = process.env.BASE_URL;
  if (workflow) process.env.BASE_URL = workflow;
  else delete process.env.BASE_URL;
  t.after(() => {
    if (previous === undefined) delete process.env.BASE_URL;
    else process.env.BASE_URL = previous;
  });
}

test("an attach answer with an environment reaches run_tests' process, and the log says so once", async (t) => {
  workflowBaseUrl(t);
  const lines = t.mock.method(console, "log", () => {});
  const session = sessionAnswering({ environment: { name: "production", baseUrl: STAGING_URL } });
  await runAgent(await hookJob(t), session.peeps);
  const out = session.delivered[0]!;
  assert.equal(out.ok, true, JSON.stringify(out));
  assert.match(out.result.outputTail, new RegExp(`^BASE_URL=${STAGING_URL}$`, "m"));
  assert.match(out.result.outputTail, new RegExp(`^PEEPS_BASE_URL=${STAGING_URL}$`, "m"));
  assert.match(out.result.outputTail, /^PEEPS_ENVIRONMENT=production$/m);
  const said = lines.mock.calls.map((c) => String(c.arguments[0])).filter((l) => l.startsWith("[peeps] environment"));
  assert.deepEqual(said, [`[peeps] environment production, BASE_URL ${STAGING_URL}`]);
});

test("the workflow's BASE_URL wins over the environment's", async (t) => {
  workflowBaseUrl(t, "https://pr-12.preview.example.com");
  t.mock.method(console, "log", () => {});
  const session = sessionAnswering({ environment: { name: "staging", baseUrl: STAGING_URL } });
  await runAgent(await hookJob(t), session.peeps);
  const { outputTail } = session.delivered[0]!.result;
  assert.match(outputTail, /^BASE_URL=https:\/\/pr-12\.preview\.example\.com$/m);
  assert.match(outputTail, new RegExp(`^PEEPS_BASE_URL=${STAGING_URL}$`, "m"));
});

test("an environment with no BASE_URL names itself and sets no URL", async (t) => {
  workflowBaseUrl(t);
  t.mock.method(console, "log", () => {});
  const session = sessionAnswering({ environment: { name: "production", baseUrl: null } });
  await runAgent(await hookJob(t), session.peeps);
  const { outputTail } = session.delivered[0]!.result;
  assert.match(outputTail, /^BASE_URL=$/m);
  assert.match(outputTail, /^PEEPS_BASE_URL=$/m);
  assert.match(outputTail, /^PEEPS_ENVIRONMENT=production$/m);
});

for (const [label, answer] of [
  ["no field, an older server", {}],
  ["null, a run that named none", { environment: null }],
] as const) {
  test(`an attach answer with ${label} changes nothing`, async (t) => {
    workflowBaseUrl(t);
    const lines = t.mock.method(console, "log", () => {});
    const session = sessionAnswering(answer);
    await runAgent(await hookJob(t), session.peeps);
    const { outputTail } = session.delivered[0]!.result;
    assert.match(outputTail, /^BASE_URL=$/m);
    assert.match(outputTail, /^PEEPS_BASE_URL=$/m);
    assert.match(outputTail, /^PEEPS_ENVIRONMENT=$/m);
    const said = lines.mock.calls.map((c) => String(c.arguments[0]));
    assert.equal(said.some((l) => l.startsWith("[peeps] environment")), false);
  });
}

test("the environment stays out of the action's own process.env, so its values are never masked", async (t) => {
  workflowBaseUrl(t);
  t.mock.method(console, "log", () => {});
  const before = { ...process.env };
  const session = sessionAnswering({ environment: { name: "production", baseUrl: STAGING_URL } });
  await runAgent(await hookJob(t), session.peeps);
  const out = session.delivered[0]!.result;
  assert.equal(out.results[0]!.title, TITLE);
  assert.equal("titleRedacted" in out.results[0]!, false);
  assert.match(out.outputTail, /PEEPS_ENVIRONMENT=production/);
  // createToolServer builds its redactor before attach, so the title alone
  // would not catch a write made after: ask the environment itself too.
  assert.deepEqual({ ...process.env }, before);
  assert.equal(makeRedactor(process.env)(TITLE), TITLE);
});

for (const environment of ["staging", 7, 0, "", true, false, [], {}, { name: "staging" }, { baseUrl: STAGING_URL }, { name: "", baseUrl: null }, { name: 7, baseUrl: null }, { name: "staging", baseUrl: 7 }]) {
  test(`an unreadable environment (${JSON.stringify(environment)}) stops the job before any test runs`, async (t) => {
    workflowBaseUrl(t);
    t.mock.method(console, "log", () => {});
    const session = sessionAnswering({ environment });
    await assert.rejects(runAgent(await hookJob(t), session.peeps), /environment/);
    assert.equal(session.polls(), 0);
    assert.deepEqual(session.delivered, []);
  });
}

// A NUL can't go in a process's environment: `spawn` would refuse it, and its
// error prints the value, credentials and all.
for (const environment of [
  { name: "staging", baseUrl: "https://user:SECRET@qa.example.com/\u0000" },
  { name: "stag\u0000ing", baseUrl: null },
]) {
  test(`a NUL in an environment stops the job, and the message doesn't echo it (${JSON.stringify(environment)})`, async (t) => {
    workflowBaseUrl(t);
    t.mock.method(console, "log", () => {});
    const session = sessionAnswering({ environment });
    await assert.rejects(runAgent(await hookJob(t), session.peeps), (err: Error) => {
      assert.match(err.message, /environment/);
      assert.doesNotMatch(err.message, /SECRET|stag\u0000ing/);
      return true;
    });
    assert.equal(session.polls(), 0);
    assert.deepEqual(session.delivered, []);
  });
}
