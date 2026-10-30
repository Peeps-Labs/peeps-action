import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { runnerInfoFor } from "../src/agent";
import type { RunnerEnv } from "../src/env";
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
  assert.deepEqual(info.capabilities, ["commit_paths", "result_files", "error_context"]);
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
  assert.deepEqual(info.capabilities, ["commit_paths"]);
});

test("a job with an unknown framework input claims neither, rather than throwing", async (t) => {
  const ws = await mkdtemp(path.join(tmpdir(), "peeps-agent-"));
  t.after(() => rm(ws, { recursive: true, force: true }));
  const info = await runnerInfoFor({ ...envAt(ws, null), framework: "bogus" } as unknown as RunnerEnv);
  assert.deepEqual(info.capabilities, ["commit_paths"]);
});
