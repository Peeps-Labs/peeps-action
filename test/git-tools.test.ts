/**
 * The git tools against a real repository: what `git_status` reports for each
 * changed file, and that `git_commit_push` pushes from the detached HEAD
 * `actions/checkout` leaves when Peeps pins the checkout to a sha.
 */
import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmod, mkdir, mkdtemp, rename, rm, symlink, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import type { RunnerEnv } from "../src/env";
import { changedFilesWithDigests, createToolServer } from "../src/tools";

// Nothing from this machine's own git configuration (signing, hooks, a
// default branch name) may change what these tests see.
process.env.GIT_CONFIG_GLOBAL = "/dev/null";
process.env.GIT_CONFIG_NOSYSTEM = "1";

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "t",
      GIT_AUTHOR_EMAIL: "t@example.com",
      GIT_COMMITTER_NAME: "t",
      GIT_COMMITTER_EMAIL: "t@example.com",
    },
  }).trim();
}

function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

/** A repository with two commits on main, and its workspace path. */
async function repo(t: TestContext) {
  const root = await mkdtemp(path.join(tmpdir(), "peeps-git-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const ws = path.join(root, "ws");
  await mkdir(ws);
  git(ws, "init", "-q", "-b", "main");
  await mkdir(path.join(ws, "e2e"));
  await writeFile(path.join(ws, "e2e/a.spec.ts"), "a1\n");
  await writeFile(path.join(ws, "e2e/gone.spec.ts"), "gone\n");
  await writeFile(path.join(ws, "e2e/old.spec.ts"), "old\n");
  git(ws, "add", "-A");
  git(ws, "commit", "-q", "-m", "one");
  const first = git(ws, "rev-parse", "HEAD");
  await writeFile(path.join(ws, "e2e/a.spec.ts"), "a2\n");
  git(ws, "commit", "-q", "-am", "two");
  const second = git(ws, "rev-parse", "HEAD");
  return { root, ws, first, second };
}

function toolsFor(ws: string) {
  const env = { workspace: ws, workingDirectory: ws, configPath: null, platform: "github" } as unknown as RunnerEnv;
  return createToolServer(env).handlers;
}

interface StatusFile { path: string; status: string; kind: string; sha256: string | null; from?: string; reason?: string }

test("git_status keeps changedFiles and adds every changed file with the sha256 of its working-tree bytes", async (t) => {
  const { ws } = await repo(t);
  await writeFile(path.join(ws, "e2e/a.spec.ts"), "a3 changed\n");
  // A new file in a new directory: porcelain collapses it to `?? e2e/new/`,
  // but the digests must name the file itself.
  await mkdir(path.join(ws, "e2e/new"));
  await writeFile(path.join(ws, "e2e/new/b.spec.ts"), "brand new\n");
  await unlink(path.join(ws, "e2e/gone.spec.ts"));
  git(ws, "mv", "e2e/old.spec.ts", "e2e/renamed.spec.ts");
  await symlink("a.spec.ts", path.join(ws, "e2e/link.spec.ts"));
  await writeFile(path.join(ws, ".env.local"), "SECRET=1\n");

  const result = (await toolsFor(ws).git_status!({})) as {
    changedFiles: string[];
    files: StatusFile[];
    filesTruncated: boolean;
  };

  // Unchanged for every server that reads only this, including its old
  // quirk: the output is trimmed as a whole, so the FIRST line loses its
  // leading space (` M a` reads `M a`). `files[].status` is exact.
  assert.deepEqual(
    result.changedFiles.map((line) => line.trim()).sort(),
    ["D e2e/gone.spec.ts", "M e2e/a.spec.ts", "?? .env.local", "?? e2e/link.spec.ts", "?? e2e/new/", "R  e2e/old.spec.ts -> e2e/renamed.spec.ts"].sort(),
  );
  assert.equal(result.filesTruncated, false);
  const byPath = new Map(result.files.map((f) => [f.path, f]));
  assert.deepEqual(byPath.get("e2e/a.spec.ts"), { path: "e2e/a.spec.ts", status: " M", kind: "file", sha256: sha256("a3 changed\n") });
  assert.deepEqual(byPath.get("e2e/new/b.spec.ts"), { path: "e2e/new/b.spec.ts", status: "??", kind: "file", sha256: sha256("brand new\n") });
  assert.deepEqual(byPath.get("e2e/gone.spec.ts"), { path: "e2e/gone.spec.ts", status: " D", kind: "deleted", sha256: null });
  assert.deepEqual(byPath.get("e2e/renamed.spec.ts"), {
    path: "e2e/renamed.spec.ts", status: "R ", kind: "file", sha256: sha256("old\n"), from: "e2e/old.spec.ts",
  });
  // A symlink as the last path component is not followed: it could point
  // anywhere on the runner. (A symlinked leading directory: see below.)
  assert.deepEqual(byPath.get("e2e/link.spec.ts"), { path: "e2e/link.spec.ts", status: "??", kind: "symlink", sha256: null });
  // Listed so a changed secret file is visible as a change, never hashed.
  assert.deepEqual(byPath.get(".env.local"), { path: ".env.local", status: "??", kind: "off_limits", sha256: null });
  assert.equal(result.files.length, 6);
});

test("git_status on a clean tree reports no files", async (t) => {
  const { ws } = await repo(t);
  const result = (await toolsFor(ws).git_status!({})) as { changedFiles: string[]; files: StatusFile[] };
  assert.deepEqual(result.changedFiles, []);
  assert.deepEqual(result.files, []);
});

test("git_status lists a path with spaces and unusual bytes exactly", async (t) => {
  const { ws } = await repo(t);
  await writeFile(path.join(ws, "e2e/with space é.spec.ts"), "x\n");
  const result = (await toolsFor(ws).git_status!({})) as { files: StatusFile[] };
  assert.deepEqual(result.files, [
    { path: "e2e/with space é.spec.ts", status: "??", kind: "file", sha256: sha256("x\n") },
  ]);
});

/**
 * A bare repository standing in for GitHub: the push URL the tool builds
 * (with the token in it) is rewritten to the bare repository's path, so the
 * real `git push` runs end to end without the network.
 */
async function remoteFor(t: TestContext, root: string, ws: string, token: string) {
  const bare = path.join(root, "remote.git");
  git(root, "init", "-q", "--bare", bare);
  git(ws, "push", "-q", bare, "main");
  git(ws, "remote", "add", "origin", "https://github.com/acme/shop.git");
  git(ws, "config", `url.${bare}.insteadOf`, `https://x-access-token:${token}@github.com/acme/shop.git`);
  return bare;
}

test("git_commit_push from a detached HEAD pushes a peeps/* branch based on the checked-out sha", async (t) => {
  const { root, ws, first, second } = await repo(t);
  const token = "ghs_test_token_value";
  const bare = await remoteFor(t, root, ws, token);
  // What actions/checkout does with `ref: <sha>`: a detached HEAD, here at a
  // commit that is no longer main's tip.
  git(ws, "checkout", "-q", "--detach", first);
  await writeFile(path.join(ws, "e2e/a.spec.ts"), "healed\n");

  const result = (await toolsFor(ws).git_commit_push!({
    branch: "peeps/fix-abc1234",
    message: "Fix the spec",
    token,
  })) as { branch: string; sha: string };

  assert.equal(result.branch, "peeps/fix-abc1234");
  assert.equal(git(bare, "rev-parse", "refs/heads/peeps/fix-abc1234"), result.sha);
  // Based on the pinned sha, not on main's tip.
  assert.equal(git(bare, "rev-parse", `${result.sha}^`), first);
  assert.notEqual(first, second);
  assert.equal(git(bare, "show", `${result.sha}:e2e/a.spec.ts`), "healed");
  // main is untouched.
  assert.equal(git(bare, "rev-parse", "refs/heads/main"), second);
});

test("git_commit_push replaces an earlier push of the same peeps/* branch", async (t) => {
  const { root, ws, first } = await repo(t);
  const token = "ghs_test_token_value";
  const bare = await remoteFor(t, root, ws, token);
  git(ws, "checkout", "-q", "--detach", first);
  await writeFile(path.join(ws, "e2e/a.spec.ts"), "attempt one\n");
  await toolsFor(ws).git_commit_push!({ branch: "peeps/fix-abc1234", message: "one", token });
  // A retry of the session starts again from the same detached sha.
  git(ws, "checkout", "-q", "--detach", first);
  await writeFile(path.join(ws, "e2e/a.spec.ts"), "attempt two\n");
  const second = (await toolsFor(ws).git_commit_push!({ branch: "peeps/fix-abc1234", message: "two", token })) as { sha: string };
  assert.equal(git(bare, "rev-parse", "refs/heads/peeps/fix-abc1234"), second.sha);
  assert.equal(git(bare, "show", `${second.sha}:e2e/a.spec.ts`), "attempt two");
  assert.equal(git(bare, "rev-parse", `${second.sha}^`), first);
});

test("git_status redacts a path that carries a secret, in files as in changedFiles", async (t) => {
  const { ws } = await repo(t);
  process.env.PEEPS_TEST_FIXTURE_SECRET = "s3cret-fixture-name";
  t.after(() => delete process.env.PEEPS_TEST_FIXTURE_SECRET);
  await writeFile(path.join(ws, "e2e/s3cret-fixture-name.json"), "{}\n");
  const result = (await toolsFor(ws).git_status!({})) as { changedFiles: string[]; files: StatusFile[] };
  assert.deepEqual(result.changedFiles, ["?? e2e/[redacted].json"]);
  assert.deepEqual(result.files.map((f) => f.path), ["e2e/[redacted].json"]);
});

test("git_status stops listing files at 2000 and says so", async (t) => {
  const { ws } = await repo(t);
  await mkdir(path.join(ws, "out"));
  await Promise.all(Array.from({ length: 2001 }, (_, i) => writeFile(path.join(ws, `out/${i}.txt`), `${i}\n`)));
  const result = (await toolsFor(ws).git_status!({})) as { files: StatusFile[]; filesTruncated: boolean };
  assert.equal(result.files.length, 2000);
  assert.equal(result.filesTruncated, true);
});

/** `git` for changedFilesWithDigests, as the tool server runs it. */
function runGitIn(ws: string) {
  return async (args: string[], options: { maxBuffer?: number } = {}) => ({
    stdout: execFileSync("git", args, { cwd: ws, encoding: "utf8", maxBuffer: options.maxBuffer }),
  });
}

test("an unreadable file is listed with no digest and a reason, and git_status still answers", { skip: process.getuid?.() === 0 ? "root can read a mode-000 file" : false }, async (t) => {
  const { ws } = await repo(t);
  const locked = path.join(ws, "e2e/locked.txt");
  await writeFile(locked, "x\n");
  // `repo`'s cleanup removes it: a mode-000 file in a writable folder.
  await chmod(locked, 0o000);
  const result = (await toolsFor(ws).git_status!({})) as { changedFiles: string[]; files: StatusFile[] };
  assert.deepEqual(result.changedFiles, ["?? e2e/locked.txt"]);
  assert.equal(result.files.length, 1);
  assert.equal(result.files[0]!.kind, "file");
  assert.equal(result.files[0]!.sha256, null);
  assert.match(result.files[0]!.reason!, /unreadable/);
});

test("a status listing too big to buffer drops files, never changedFiles", async (t) => {
  const { ws } = await repo(t);
  // Before this field, porcelain collapsed this directory to one line.
  // Listed file by file it is over the listing's 8 MB buffer.
  const big = path.join(ws, "big");
  await mkdir(big);
  const name = "x".repeat(240);
  for (let i = 0; i < 36_000; i += 1000) {
    await Promise.all(Array.from({ length: 1000 }, (_, j) => writeFile(path.join(big, `${name}-${i + j}`), "")));
  }
  const result = (await toolsFor(ws).git_status!({})) as {
    changedFiles: string[]; files?: StatusFile[]; filesTruncated: boolean; filesError?: string;
  };
  assert.deepEqual(result.changedFiles, ["?? big/"]);
  assert.equal(result.files, undefined);
  assert.equal(result.filesTruncated, true);
  assert.match(result.filesError!, /maxBuffer|too large/i);
});

test("a file behind a symlinked directory is never hashed: the symlink is not followed out of the workspace", async (t) => {
  const { root, ws } = await repo(t);
  await mkdir(path.join(ws, "a"));
  await writeFile(path.join(ws, "a/secret.txt"), "tracked\n");
  git(ws, "add", "-A");
  git(ws, "commit", "-q", "-m", "a");
  const outside = path.join(root, "outside");
  await mkdir(outside);
  await writeFile(path.join(outside, "secret.txt"), "hunter2\n");
  await rm(path.join(ws, "a"), { recursive: true });
  await symlink(outside, path.join(ws, "a"), "dir");
  const result = (await toolsFor(ws).git_status!({})) as { files: StatusFile[] };
  const byPath = new Map(result.files.map((f) => [f.path, f]));
  // Git does not look through it either: it reports the file deleted.
  const secret = byPath.get("a/secret.txt")!;
  assert.equal(secret.status, " D");
  assert.equal(secret.kind, "off_limits");
  assert.equal(secret.sha256, null);
  assert.ok(!JSON.stringify(result).includes(createHash("sha256").update("hunter2\n").digest("hex")));
  assert.deepEqual(byPath.get("a"), { path: "a", status: "??", kind: "symlink", sha256: null });
});

test("a symlinked directory inside the workspace is not looked through either", async (t) => {
  const { ws } = await repo(t);
  await mkdir(path.join(ws, "a"));
  await writeFile(path.join(ws, "a/f.txt"), "tracked\n");
  git(ws, "add", "-A");
  git(ws, "commit", "-q", "-m", "a");
  await rename(path.join(ws, "a"), path.join(ws, "b"));
  await symlink("b", path.join(ws, "a"), "dir");
  const result = (await toolsFor(ws).git_status!({})) as { files: StatusFile[] };
  const f = result.files.find((e) => e.path === "a/f.txt")!;
  assert.equal(f.status, " D");
  assert.equal(f.kind, "symlink");
  assert.equal(f.sha256, null);
});

test("a file over the hashing size cap is listed with no digest and a reason", async (t) => {
  const { ws } = await repo(t);
  await writeFile(path.join(ws, "e2e/small.txt"), "12345");
  await writeFile(path.join(ws, "e2e/large.txt"), "123456");
  const { files } = await changedFilesWithDigests(ws, runGitIn(ws), { maxHashBytes: 5 });
  const byPath = new Map(files.map((f) => [f.path, f]));
  assert.equal(byPath.get("e2e/small.txt")!.sha256, sha256("12345"));
  assert.deepEqual(byPath.get("e2e/large.txt"), {
    path: "e2e/large.txt", status: "??", kind: "file", sha256: null, reason: "larger than 5 bytes",
  });
});

test("files past the hashing time budget are listed with no digest and a reason", async (t) => {
  const { ws } = await repo(t);
  await writeFile(path.join(ws, "e2e/one.txt"), "1");
  await writeFile(path.join(ws, "e2e/two.txt"), "2");
  const { files } = await changedFilesWithDigests(ws, runGitIn(ws), { budgetMs: 0 });
  assert.equal(files.length, 2);
  for (const f of files) {
    assert.equal(f.sha256, null);
    assert.equal(f.reason, "time budget for digests spent");
  }
});

test("a nested repository is listed as other, with no digest", async (t) => {
  const { ws } = await repo(t);
  await mkdir(path.join(ws, "vendor/lib"), { recursive: true });
  git(path.join(ws, "vendor/lib"), "init", "-q");
  const result = (await toolsFor(ws).git_status!({})) as { files: StatusFile[] };
  assert.deepEqual(result.files, [{ path: "vendor/lib/", status: "??", kind: "other", sha256: null }]);
});

test("a file turned into a symlink is a type change, reported as a symlink", async (t) => {
  const { ws } = await repo(t);
  await unlink(path.join(ws, "e2e/a.spec.ts"));
  await symlink("old.spec.ts", path.join(ws, "e2e/a.spec.ts"));
  const result = (await toolsFor(ws).git_status!({})) as { files: StatusFile[] };
  assert.deepEqual(result.files, [{ path: "e2e/a.spec.ts", status: " T", kind: "symlink", sha256: null }]);
});

test("a staged copy names its source", async (t) => {
  const { ws } = await repo(t);
  git(ws, "config", "status.renames", "copies");
  const body = Array.from({ length: 50 }, (_, i) => `line ${i}`).join("\n") + "\n";
  await writeFile(path.join(ws, "e2e/a.spec.ts"), body);
  git(ws, "commit", "-q", "-am", "body");
  await writeFile(path.join(ws, "e2e/copy.spec.ts"), body);
  await writeFile(path.join(ws, "e2e/a.spec.ts"), body + "more\n");
  git(ws, "add", "-A");
  const result = (await toolsFor(ws).git_status!({})) as { files: StatusFile[] };
  const copy = result.files.find((f) => f.path === "e2e/copy.spec.ts")!;
  assert.deepEqual(copy, { path: "e2e/copy.spec.ts", status: "C ", kind: "file", sha256: sha256(body), from: "e2e/a.spec.ts" });
});
