/**
 * The git tools against a real repository: what `git_status` reports for each
 * changed file, and that `git_commit_push` pushes from the detached HEAD
 * `actions/checkout` leaves when Peeps pins the checkout to a sha.
 */
import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, rename, rm, stat, symlink, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import type { RunnerEnv } from "../src/env";
import { changedFilesWithDigests, createToolServer, ToolError } from "../src/tools";

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

test("run_tests reports each test's final attempt with its retry index", async (t) => {
  const { ws } = await repo(t);
  await symlink(path.resolve(__dirname, "../node_modules"), path.join(ws, "node_modules"), "dir");
  await writeFile(
    path.join(ws, "pw.config.ts"),
    'import { defineConfig } from "@playwright/test";\nexport default defineConfig({ testDir: "./pw", retries: 1, workers: 1, outputDir: "./results" });\n',
  );
  // Its own folder: `repo`'s e2e/*.spec.ts are not real specs. No page is
  // needed: the retry index comes from Playwright's own result.
  await mkdir(path.join(ws, "pw"));
  await writeFile(
    path.join(ws, "pw/flaky.spec.ts"),
    'import { test, expect } from "@playwright/test";\n' +
      'test("passes on retry", async ({}, info) => { expect(info.retry).toBe(1); });\n' +
      'test("passes first time", async () => {});\n',
  );
  const env = { workspace: ws, workingDirectory: ws, configPath: "pw.config.ts", platform: "github" } as unknown as RunnerEnv;
  const out = (await createToolServer(env).handlers.run_tests!({ file: "pw/flaky.spec.ts" })) as {
    results: Array<{ title: string; status: string; retry?: number }>;
  };
  assert.deepEqual(
    out.results.map((r) => [r.title, r.status, r.retry]),
    [["passes on retry", "passed", 1], ["passes first time", "passed", 0]],
    JSON.stringify(out).slice(0, 2000),
  );
});

test("run_tests names each result's file repo-relative, and a failed one carries Playwright's error context", async (t) => {
  const { ws } = await repo(t);
  // A monorepo: Playwright runs from app/, and its JSON names files relative
  // to the testDir (`fail.spec.ts`), which says nothing about which spec ran.
  const app = path.join(ws, "app");
  await mkdir(path.join(app, "pw"), { recursive: true });
  await symlink(path.resolve(__dirname, "../node_modules"), path.join(app, "node_modules"), "dir");
  await writeFile(
    path.join(app, "pw.config.ts"),
    'import { defineConfig } from "@playwright/test";\nexport default defineConfig({ testDir: "./pw", workers: 1, outputDir: "./results" });\n',
  );
  await writeFile(
    path.join(app, "pw/login.spec.ts"),
    'import { test, expect } from "@playwright/test";\n' +
      'test("refused", async ({ page }) => {\n' +
      '  await page.setContent("<h1>Sign in</h1><p>affiliation level does not permit</p>");\n' +
      '  await expect(page.getByText("Welcome")).toBeVisible({ timeout: 300 });\n' +
      "});\n" +
      'test("passes", async () => {});\n',
  );
  const env = { workspace: ws, workingDirectory: app, configPath: "pw.config.ts", platform: "github" } as unknown as RunnerEnv;
  const out = (await createToolServer(env).handlers.run_tests!({ file: "app/pw/login.spec.ts" })) as {
    results: Array<{ title: string; status: string; file?: string; errorContext?: string }>;
  };
  const [refused, passes] = out.results;
  assert.equal(refused?.status, "failed", JSON.stringify(out).slice(0, 2000));
  assert.equal(refused?.file, "app/pw/login.spec.ts");
  assert.equal(passes?.file, "app/pw/login.spec.ts");
  // The page as it was at the failure: Playwright's ARIA snapshot.
  assert.match(refused?.errorContext ?? "", /- paragraph: affiliation level does not permit/);
  assert.equal(passes?.status, "passed");
  assert.equal("errorContext" in passes!, false);
});

test("run_tests redacts a secret in a Playwright result's title, error and snippet", async (t) => {
  const { ws } = await repo(t);
  await symlink(path.resolve(__dirname, "../node_modules"), path.join(ws, "node_modules"), "dir");
  const secret = "pw-secret-value-8812";
  process.env.PEEPS_TEST_PW_SECRET = secret;
  t.after(() => delete process.env.PEEPS_TEST_PW_SECRET);
  await writeFile(
    path.join(ws, "pw.config.ts"),
    'import { defineConfig } from "@playwright/test";\nexport default defineConfig({ testDir: "./pw", workers: 1, outputDir: "./results" });\n',
  );
  await mkdir(path.join(ws, "pw"));
  // The value is in the spec itself, so it reaches the title, Playwright's
  // error message and the source snippet.
  await writeFile(
    path.join(ws, "pw/leak.spec.ts"),
    'import { test, expect } from "@playwright/test";\n' +
      `test("logs in with ${secret}", async () => { expect("${secret}").toBe("nope"); });\n`,
  );
  const env = { workspace: ws, workingDirectory: ws, configPath: "pw.config.ts", platform: "github" } as unknown as RunnerEnv;
  const out = (await createToolServer(env).handlers.run_tests!({ file: "pw/leak.spec.ts" })) as {
    results: Array<{ title: string; status: string; error?: string; errorSnippet?: string; errorContext?: string }>;
  };
  const [r] = out.results;
  assert.equal(r?.status, "failed", JSON.stringify(out).slice(0, 2000));
  assert.equal(r?.title, "logs in with [redacted]");
  assert.match(r?.error ?? "", /\[redacted\]/);
  assert.match(r?.errorSnippet ?? "", /\[redacted\]/);
  assert.equal(JSON.stringify(out).includes(secret), false);
});

// ---------------------------------------------------------------------------
// git_commit_push with `paths` (PQA-2695): commit only the listed files
// ---------------------------------------------------------------------------

const TOKEN = "ghs_test_token_value";

/** A detached checkout with a remote, as a pinned heal session sees it. */
async function pinnedCheckout(t: TestContext) {
  const r = await repo(t);
  const bare = await remoteFor(t, r.root, r.ws, TOKEN);
  git(r.ws, "checkout", "-q", "--detach", r.first);
  return { ...r, bare };
}

function filesIn(bare: string, sha: string): string[] {
  return git(bare, "diff-tree", "-r", "--no-commit-id", "--name-only", "--root", sha).split("\n").filter(Boolean).sort();
}

test("git_commit_push with paths commits only those files, leaving test output untouched", async (t) => {
  const { ws, bare, first } = await pinnedCheckout(t);
  await writeFile(path.join(ws, "e2e/a.spec.ts"), "healed\n");
  await mkdir(path.join(ws, "e2e/pages"));
  await writeFile(path.join(ws, "e2e/pages/cart.ts"), "export const cart = 1;\n");
  // What a test run leaves behind when .gitignore does not cover it.
  await mkdir(path.join(ws, "test-results"));
  await writeFile(path.join(ws, "test-results/trace.zip"), "zip");
  await writeFile(path.join(ws, "e2e/old.spec.ts"), "a test run rewrote this\n");

  const result = (await toolsFor(ws).git_commit_push!({
    branch: "peeps/fix-abc1234", message: "Fix", token: TOKEN,
    paths: ["e2e/a.spec.ts", "e2e/pages/cart.ts"],
  })) as { sha: string; committedPaths: string[] };

  assert.deepEqual(result.committedPaths, ["e2e/a.spec.ts", "e2e/pages/cart.ts"]);
  assert.deepEqual(filesIn(bare, result.sha), ["e2e/a.spec.ts", "e2e/pages/cart.ts"]);
  assert.equal(git(bare, "rev-parse", `${result.sha}^`), first);
  // Everything else is still in the working tree, uncommitted and unstaged.
  // (`git` trims its output, so the first line's leading space is gone.)
  assert.deepEqual(
    git(ws, "status", "--porcelain", "--untracked-files=all").split("\n").map((l) => l.trim()).sort(),
    ["?? test-results/trace.zip", "M e2e/old.spec.ts"],
  );
});

test("git_commit_push with paths stages a listed deletion", async (t) => {
  const { ws, bare } = await pinnedCheckout(t);
  await unlink(path.join(ws, "e2e/gone.spec.ts"));
  await writeFile(path.join(ws, "e2e/a.spec.ts"), "healed\n");
  const result = (await toolsFor(ws).git_commit_push!({
    branch: "peeps/fix-abc1234", message: "Fix", token: TOKEN,
    paths: ["e2e/a.spec.ts", "e2e/gone.spec.ts"],
  })) as { sha: string; committedPaths: string[] };
  assert.deepEqual(result.committedPaths, ["e2e/a.spec.ts", "e2e/gone.spec.ts"]);
  assert.throws(() => git(bare, "cat-file", "-e", `${result.sha}:e2e/gone.spec.ts`));
});

test("git_commit_push with paths leaves out an earlier staged change that is not listed", async (t) => {
  const { ws, bare } = await pinnedCheckout(t);
  await writeFile(path.join(ws, "e2e/old.spec.ts"), "staged by someone else\n");
  git(ws, "add", "e2e/old.spec.ts");
  await writeFile(path.join(ws, "e2e/a.spec.ts"), "healed\n");
  const result = (await toolsFor(ws).git_commit_push!({
    branch: "peeps/fix-abc1234", message: "Fix", token: TOKEN, paths: ["e2e/a.spec.ts"],
  })) as { sha: string; committedPaths: string[] };
  assert.deepEqual(filesIn(bare, result.sha), ["e2e/a.spec.ts"]);
});

test("git_commit_push with paths that hold no change is the same nothing-to-commit refusal", async (t) => {
  const { ws, bare } = await pinnedCheckout(t);
  await writeFile(path.join(ws, "junk.txt"), "test output\n");
  for (const paths of [["e2e/a.spec.ts"], ["e2e/never-existed.spec.ts"]]) {
    await assert.rejects(
      toolsFor(ws).git_commit_push!({ branch: "peeps/fix-abc1234", message: "Fix", token: TOKEN, paths }),
      /nothing to commit/,
    );
  }
  assert.throws(() => git(bare, "rev-parse", "--verify", "-q", "refs/heads/peeps/fix-abc1234"));
});

test("git_commit_push refuses the whole call when any listed path is off limits, before touching anything", async (t) => {
  const { root, ws, bare } = await pinnedCheckout(t);
  const outside = path.join(root, "outside");
  await mkdir(outside);
  await mkdir(path.join(ws, "linked"));
  await rm(path.join(ws, "linked"), { recursive: true });
  await symlink(outside, path.join(ws, "linked"), "dir");
  await symlink("a.spec.ts", path.join(ws, "e2e/alias.spec.ts"));
  await writeFile(path.join(ws, "e2e/a.spec.ts"), "healed\n");
  const head = git(ws, "rev-parse", "HEAD");
  const cases: Array<[unknown, RegExp]> = [
    [["e2e/a.spec.ts", "../outside/x.ts"], /escapes the workspace/],
    [["e2e/a.spec.ts", "linked/x.ts"], /symlink/],
    [["e2e/alias.spec.ts"], /symlink/],
    [["e2e/a.spec.ts", ".git/config"], /off limits/],
    [[".github/workflows/peeps.yml"], /workflow files/],
    [[], /1 to 200/],
    [Array.from({ length: 201 }, (_, i) => `e2e/${i}.ts`), /1 to 200/],
    [["e2e/a.spec.ts", ""], /non-empty strings/],
    ["e2e/a.spec.ts", /array/],
  ];
  for (const [paths, error] of cases) {
    await assert.rejects(
      toolsFor(ws).git_commit_push!({ branch: "peeps/fix-abc1234", message: "Fix", token: TOKEN, paths }),
      error,
      JSON.stringify(paths).slice(0, 80),
    );
  }
  // Refused before the branch was even created.
  assert.equal(git(ws, "rev-parse", "HEAD"), head);
  assert.equal(git(ws, "rev-parse", "--abbrev-ref", "HEAD"), "HEAD");
  assert.equal(git(ws, "diff", "--cached", "--name-only"), "");
  assert.throws(() => git(bare, "rev-parse", "--verify", "-q", "refs/heads/peeps/fix-abc1234"));
});

test("git_commit_push takes listed paths literally, never as patterns", async (t) => {
  const { ws, bare } = await pinnedCheckout(t);
  await writeFile(path.join(ws, "e2e/a.spec.ts"), "healed\n");
  await writeFile(path.join(ws, "e2e/b.spec.ts"), "output\n");
  await assert.rejects(
    toolsFor(ws).git_commit_push!({ branch: "peeps/fix-abc1234", message: "Fix", token: TOKEN, paths: ["e2e/*.spec.ts"] }),
    /nothing to commit/,
  );
  assert.throws(() => git(bare, "rev-parse", "--verify", "-q", "refs/heads/peeps/fix-abc1234"));
});

test("git_commit_push without paths still commits everything, and reports what it committed", async (t) => {
  const { ws, bare } = await pinnedCheckout(t);
  await writeFile(path.join(ws, "e2e/a.spec.ts"), "healed\n");
  await writeFile(path.join(ws, "junk.txt"), "test output\n");
  const result = (await toolsFor(ws).git_commit_push!({ branch: "peeps/fix-abc1234", message: "Fix", token: TOKEN })) as {
    sha: string; committedPaths: string[];
  };
  assert.deepEqual(filesIn(bare, result.sha), ["e2e/a.spec.ts", "junk.txt"]);
  assert.deepEqual(result.committedPaths, ["e2e/a.spec.ts", "junk.txt"]);
});

test("git_commit_push advertises paths in its input schema", () => {
  const env = { workspace: "/w", workingDirectory: "/w", configPath: null, platform: "github" } as unknown as RunnerEnv;
  const spec = createToolServer(env).specs.find((s) => s.name === "git_commit_push")!;
  const props = (spec.inputSchema as { properties: Record<string, unknown>; required: string[] }).properties;
  assert.deepEqual(props.paths, {
    type: "array",
    items: { type: "string" },
    minItems: 1,
    maxItems: 200,
    description: "Optional. Repo-relative paths to commit; nothing else is staged or committed. Omit to commit every change.",
  });
  assert.deepEqual((spec.inputSchema as { required: string[] }).required, ["branch", "message", "token"]);
});

// --- Fix round 1 on #7 ------------------------------------------------------

const BRANCH = "peeps/fix-abc1234";

function noBranch(bare: string) {
  assert.throws(() => git(bare, "rev-parse", "--verify", "-q", `refs/heads/${BRANCH}`));
}

/** A refusal is the tool's own error: no raw git command line, no errno. */
async function refused(call: Promise<unknown>, pattern: RegExp) {
  await assert.rejects(call, (error: unknown) => {
    assert.ok(error instanceof ToolError, `not a ToolError: ${String(error)}`);
    assert.match(error.message, pattern);
    assert.doesNotMatch(error.message, /Command failed|safe\.directory|ENOENT|EACCES/);
    return true;
  });
}

test("a deletion already staged is still committed, not dropped", async (t) => {
  const { ws, bare } = await pinnedCheckout(t);
  git(ws, "rm", "-q", "e2e/gone.spec.ts");
  await writeFile(path.join(ws, "e2e/a.spec.ts"), "healed\n");
  const result = (await toolsFor(ws).git_commit_push!({
    branch: BRANCH, message: "Fix", token: TOKEN, paths: ["e2e/a.spec.ts", "e2e/gone.spec.ts"],
  })) as { sha: string; committedPaths: string[]; skippedPaths: string[] };
  assert.deepEqual(result.committedPaths, ["e2e/a.spec.ts", "e2e/gone.spec.ts"]);
  assert.deepEqual(result.skippedPaths, []);
  assert.deepEqual(filesIn(bare, result.sha), ["e2e/a.spec.ts", "e2e/gone.spec.ts"]);
});

test("a commit hook that stages another file makes the call refuse, and nothing is pushed", async (t) => {
  const { root, ws, bare, first } = await pinnedCheckout(t);
  const hooks = path.join(root, "hooks");
  await mkdir(hooks);
  await writeFile(path.join(hooks, "pre-commit"), "#!/bin/sh\necho hooked > other.txt\ngit add other.txt\n", { mode: 0o755 });
  git(ws, "config", "core.hooksPath", hooks);
  await writeFile(path.join(ws, "e2e/a.spec.ts"), "healed\n");
  await refused(
    toolsFor(ws).git_commit_push!({ branch: BRANCH, message: "Fix", token: TOKEN, paths: ["e2e/a.spec.ts"] }),
    /holds paths that were not listed: other\.txt/,
  );
  noBranch(bare);
  // The commit is undone and nothing this call staged stays staged.
  assert.equal(git(ws, "rev-parse", "HEAD"), first);
  assert.equal(git(ws, "diff", "--cached", "--name-only"), "");
  assert.equal(await readFile(path.join(ws, "e2e/a.spec.ts"), "utf8"), "healed\n");
});

test("a tracked folder replaced by a file of the same name is refused, not pushed with its deletions", async (t) => {
  const { ws, bare } = await pinnedCheckout(t);
  await mkdir(path.join(ws, "e2e/sub"));
  await writeFile(path.join(ws, "e2e/sub/x.ts"), "x\n");
  await writeFile(path.join(ws, "e2e/sub/y.ts"), "y\n");
  git(ws, "add", "-A");
  git(ws, "commit", "-q", "-m", "sub");
  await rm(path.join(ws, "e2e/sub"), { recursive: true });
  await writeFile(path.join(ws, "e2e/sub"), "now a file\n");
  await refused(
    toolsFor(ws).git_commit_push!({ branch: BRANCH, message: "Fix", token: TOKEN, paths: ["e2e/sub"] }),
    /not listed: e2e\/sub\/x\.ts, e2e\/sub\/y\.ts/,
  );
  noBranch(bare);
  assert.equal(git(ws, "diff", "--cached", "--name-only"), "");
});

test("a gitignored listed path is refused up front and nothing is left staged", async (t) => {
  const { ws, bare } = await pinnedCheckout(t);
  await writeFile(path.join(ws, ".gitignore"), "e2e/helpers/\n");
  await mkdir(path.join(ws, "e2e/helpers"));
  await writeFile(path.join(ws, "e2e/helpers/h.ts"), "h\n");
  await writeFile(path.join(ws, "e2e/a.spec.ts"), "healed\n");
  await refused(
    toolsFor(ws).git_commit_push!({ branch: BRANCH, message: "Fix", token: TOKEN, paths: ["e2e/a.spec.ts", "e2e/helpers/h.ts"] }),
    /ignored by \.gitignore: e2e\/helpers\/h\.ts/,
  );
  noBranch(bare);
  assert.equal(git(ws, "diff", "--cached", "--name-only"), "");
});

test("an absolute path is refused, never re-rooted into the workspace", async (t) => {
  const { ws, bare } = await pinnedCheckout(t);
  await writeFile(path.join(ws, "e2e/a.spec.ts"), "healed\n");
  for (const bad of [path.join(ws, "e2e/a.spec.ts"), "/e2e/a.spec.ts", "\\e2e\\a.spec.ts", "C:\\e2e\\a.spec.ts", "c:/e2e/a.spec.ts"]) {
    await refused(
      toolsFor(ws).git_commit_push!({ branch: BRANCH, message: "Fix", token: TOKEN, paths: [bad] }),
      /absolute/,
    );
  }
  noBranch(bare);
});

test("a dangling symlinked folder is the symlink refusal, not a raw error", async (t) => {
  const { ws, bare } = await pinnedCheckout(t);
  await symlink("/nonexistent-peeps-target", path.join(ws, "linked"), "dir");
  await refused(
    toolsFor(ws).git_commit_push!({ branch: BRANCH, message: "Fix", token: TOKEN, paths: ["linked/x.ts"] }),
    /symlink/,
  );
  noBranch(bare);
});

test("listed paths that are neither present nor tracked are skipped, and said so", async (t) => {
  const { ws, bare } = await pinnedCheckout(t);
  await writeFile(path.join(ws, "e2e/a.spec.ts"), "healed\n");
  const result = (await toolsFor(ws).git_commit_push!({
    branch: BRANCH, message: "Fix", token: TOKEN, paths: ["e2e/a.spec.ts", "e2e/pages/typo.ts"],
  })) as { sha: string; committedPaths: string[]; skippedPaths: string[] };
  assert.deepEqual(result.committedPaths, ["e2e/a.spec.ts"]);
  assert.deepEqual(result.skippedPaths, ["e2e/pages/typo.ts"]);
  assert.deepEqual(filesIn(bare, result.sha), ["e2e/a.spec.ts"]);
});

test("a path differing only in case is never committed under that name", async (t) => {
  const { ws, bare } = await pinnedCheckout(t);
  await writeFile(path.join(ws, "e2e/a.spec.ts"), "healed\n");
  // Case-insensitive filesystems (macOS) refuse it; case-sensitive ones
  // (Linux) find no such file and skip it. Neither commits `E2E/…`.
  try {
    const result = (await toolsFor(ws).git_commit_push!({
      branch: BRANCH, message: "Fix", token: TOKEN, paths: ["E2E/a.spec.ts"],
    })) as { committedPaths: string[] };
    assert.fail(`committed ${JSON.stringify(result.committedPaths)}`);
  } catch (error) {
    assert.ok(error instanceof ToolError, String(error));
    assert.match(error.message, /does not resolve to itself|nothing to commit/);
  }
  noBranch(bare);
});

test("a workspace below the repository's top level reports committedPaths relative to the workspace", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "peeps-git-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const top = path.join(root, "top");
  const ws = path.join(top, "app");
  await mkdir(path.join(ws, "e2e"), { recursive: true });
  git(top, "init", "-q", "-b", "main");
  await writeFile(path.join(ws, "e2e/a.spec.ts"), "a\n");
  git(top, "add", "-A");
  git(top, "commit", "-q", "-m", "one");
  const bare = await remoteFor(t, root, top, TOKEN);
  await writeFile(path.join(ws, "e2e/a.spec.ts"), "healed\n");
  const result = (await toolsFor(ws).git_commit_push!({
    branch: BRANCH, message: "Fix", token: TOKEN, paths: ["e2e/a.spec.ts"],
  })) as { sha: string; committedPaths: string[] };
  assert.deepEqual(result.committedPaths, ["e2e/a.spec.ts"]);
  assert.deepEqual(filesIn(bare, result.sha), ["app/e2e/a.spec.ts"]);
});

test("committedPaths is capped at 200, with committedPathsTruncated", async (t) => {
  const { ws, bare } = await pinnedCheckout(t);
  await mkdir(path.join(ws, "out"));
  await Promise.all(Array.from({ length: 205 }, (_, i) => writeFile(path.join(ws, `out/${i}.txt`), `${i}\n`)));
  const result = (await toolsFor(ws).git_commit_push!({ branch: BRANCH, message: "Fix", token: TOKEN })) as {
    sha: string; committedPaths: string[]; committedPathsTruncated: boolean;
  };
  assert.equal(result.committedPaths.length, 200);
  assert.equal(result.committedPathsTruncated, true);
  assert.equal(filesIn(bare, result.sha).length, 205);
});

// --- Round 2 on #7 ----------------------------------------------------------

test("a post-commit hook that makes its own commit is undone too, back to the base", async (t) => {
  const { root, ws, bare, first } = await pinnedCheckout(t);
  const hooks = path.join(root, "hooks");
  await mkdir(hooks);
  await writeFile(
    path.join(hooks, "post-commit"),
    '#!/bin/sh\n[ -n "$PEEPS_TEST_IN_HOOK" ] && exit 0\necho extra > extra.txt\ngit add extra.txt\nPEEPS_TEST_IN_HOOK=1 git commit -q -m extra\n',
    { mode: 0o755 },
  );
  git(ws, "config", "core.hooksPath", hooks);
  await writeFile(path.join(ws, "e2e/a.spec.ts"), "healed\n");
  await refused(
    toolsFor(ws).git_commit_push!({ branch: BRANCH, message: "Fix", token: TOKEN, paths: ["e2e/a.spec.ts"] }),
    /commit hook made another commit|not listed: extra\.txt/,
  );
  noBranch(bare);
  // Neither the call's commit nor the hook's is left behind.
  assert.equal(git(ws, "rev-parse", "HEAD"), first);
  assert.equal(git(ws, "diff", "--cached", "--name-only"), "");
  assert.equal(await readFile(path.join(ws, "e2e/a.spec.ts"), "utf8"), "healed\n");
});

test("a commit hook that fails without output gets a clear refusal", async (t) => {
  const { root, ws, bare, first } = await pinnedCheckout(t);
  const hooks = path.join(root, "hooks");
  await mkdir(hooks);
  await writeFile(path.join(hooks, "pre-commit"), "#!/bin/sh\nexit 1\n", { mode: 0o755 });
  git(ws, "config", "core.hooksPath", hooks);
  await writeFile(path.join(ws, "e2e/a.spec.ts"), "healed\n");
  await refused(
    toolsFor(ws).git_commit_push!({ branch: BRANCH, message: "Fix", token: TOKEN, paths: ["e2e/a.spec.ts"] }),
    /git commit refused: no output from git or a commit hook \(a hook such as pre-commit may have failed\)/,
  );
  noBranch(bare);
  assert.equal(git(ws, "rev-parse", "HEAD"), first);
  assert.equal(git(ws, "diff", "--cached", "--name-only"), "");
});

test("a rename listed by both its paths commits the deletion and the addition", async (t) => {
  const { ws, bare } = await pinnedCheckout(t);
  await rename(path.join(ws, "e2e/old.spec.ts"), path.join(ws, "e2e/renamed.spec.ts"));
  const result = (await toolsFor(ws).git_commit_push!({
    branch: BRANCH, message: "Rename", token: TOKEN, paths: ["e2e/old.spec.ts", "e2e/renamed.spec.ts"],
  })) as { sha: string; committedPaths: string[]; skippedPaths: string[] };
  assert.deepEqual([...result.committedPaths].sort(), ["e2e/old.spec.ts", "e2e/renamed.spec.ts"]);
  assert.deepEqual(result.skippedPaths, []);
  assert.equal(git(bare, "show", `${result.sha}:e2e/renamed.spec.ts`), "old");
  assert.throws(() => git(bare, "cat-file", "-e", `${result.sha}:e2e/old.spec.ts`));
});

/** A pytest repository whose `.peeps/run-tests` sources a sibling and writes the JUnit. */
async function hookRepo(
  t: TestContext,
  hook = `#!/bin/sh\n. "$(dirname "$0")/lib.sh"\njunit "$1"\necho customer-hook\n`,
) {
  const root = await mkdtemp(path.join(tmpdir(), "peeps-hook-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const ws = path.join(root, "ws");
  await mkdir(path.join(ws, ".peeps"), { recursive: true });
  await mkdir(path.join(ws, "tests"));
  git(ws, "init", "-q", "-b", "main");
  await writeFile(
    path.join(ws, ".peeps/lib.sh"),
    `junit() { printf '<testsuite><testcase classname="tests.test_a" name="test_a" file="tests/test_a.py"/></testsuite>' > "$1"; }\n`,
  );
  await writeFile(path.join(ws, ".peeps/run-tests"), hook);
  await chmod(path.join(ws, ".peeps/run-tests"), 0o755);
  await writeFile(path.join(ws, "tests/test_a.py"), "def test_a(): pass\n");
  git(ws, "add", "-A");
  git(ws, "commit", "-q", "-m", "init");
  git(ws, "remote", "add", "origin", "https://example.invalid/acme/app.git");
  const env = { workspace: ws, workingDirectory: ws, configPath: null, framework: "pytest", platform: "github" } as unknown as RunnerEnv;
  return { root, ws, tools: createToolServer(env).handlers };
}

interface HookRun { ranWith: string; results: Array<{ title: string; status: string }> | null; outputTail: string }

test("run_tests runs the commit's own .peeps/run-tests, siblings included", async (t) => {
  const { tools } = await hookRepo(t);
  const out = (await tools.run_tests!({ file: "tests/test_a.py", test: "test_a" })) as HookRun;
  assert.equal(out.ranWith, ".peeps/run-tests");
  assert.match(out.outputTail, /customer-hook/);
  assert.deepEqual(out.results?.map((r) => [r.title, r.status]), [["test_a", "passed"]]);
});

test("grep redacts an env value in a match's path", async (t) => {
  const { ws } = await repo(t);
  process.env.PEEPS_TEST_GREP_SITE = "production";
  t.after(() => delete process.env.PEEPS_TEST_GREP_SITE);
  await mkdir(path.join(ws, "e2e/production"), { recursive: true });
  await writeFile(path.join(ws, "e2e/production/a.spec.ts"), "needle\n");
  const out = (await toolsFor(ws).grep!({ pattern: "needle" })) as { matches: Array<{ path: string }> };
  assert.deepEqual(out.matches.map((m) => m.path), ["e2e/[redacted]/a.spec.ts"]);
});

test("a pytest title or file the redactor changed says so", async (t) => {
  process.env.PEEPS_TEST_LAB_SITE = "production";
  t.after(() => delete process.env.PEEPS_TEST_LAB_SITE);
  const { tools } = await hookRepo(
    t,
    `#!/bin/sh\nprintf '<testsuite><testcase classname="tests.test_a" name="test_production_banner" file="tests/production/test_a.py" line="4"/><testcase classname="tests.test_a" name="test_a" file="tests/test_a.py"/></testsuite>' > "$1"\n`,
  );
  const out = (await tools.run_tests!({ file: "tests/test_a.py" })) as {
    results: Array<{ title: string; file: string; line?: number; titleRedacted?: boolean; fileRedacted?: boolean }>;
  };
  assert.deepEqual(out.results.map((r) => [r.title, r.file, r.line, r.titleRedacted, r.fileRedacted]), [
    ["test_[redacted]_banner", "tests/[redacted]/test_a.py", 4, true, true],
    ["test_a", "tests/test_a.py", undefined, undefined, undefined],
  ]);
  assert.equal("titleRedacted" in out.results[1]!, false);
  assert.equal("fileRedacted" in out.results[1]!, false);
});

test("a hook rewritten through a symlink and committed by a failed push never runs", async (t) => {
  const { root, ws, tools } = await hookRepo(t);
  const marker = path.join(root, "agent-ran");
  const patch = "diff --git a/alias b/alias\nnew file mode 120000\nindex 0000000..1111111\n--- /dev/null\n+++ b/alias\n@@ -0,0 +1 @@\n+.peeps\n\\ No newline at end of file\n";
  await tools.apply_patch!({ patch });
  await tools.write_file!({ path: "alias/run-tests", content: `#!/bin/sh\ntouch '${marker}'\n` });
  // The push fails on its bad token, but git_commit_push has committed by then,
  // so HEAD now holds the agent's hook.
  await assert.rejects(tools.git_commit_push!({ branch: "peeps/x", message: "m", token: "bogus" }));
  assert.notEqual(git(ws, "log", "-1", "--format=%s"), "init");
  const out = (await tools.run_tests!({ file: "tests/test_a.py", test: "test_a" })) as HookRun;
  assert.equal(out.results, null);
  assert.match(out.outputTail, /differs from the commit under test/);
  await assert.rejects(stat(marker));
});

test("git_commit_push never lists .peeps/, in any case, so a heal cannot commit the hook that verifies it", async (t) => {
  const { ws, bare } = await pinnedCheckout(t);
  await writeFile(path.join(ws, "e2e/a.spec.ts"), "healed\n");
  for (const listed of [".peeps/run-tests", ".PEEPS/run-tests", ".peeps/lib.sh"]) {
    await refused(
      toolsFor(ws).git_commit_push!({ branch: BRANCH, message: "Fix", token: TOKEN, paths: ["e2e/a.spec.ts", listed] }),
      /\.peeps\/ holds your own hooks/,
    );
  }
  noBranch(bare);
  assert.equal(git(ws, "diff", "--cached", "--name-only"), "");
});

test("a .peeps/run-tests changed in the checkout and listed for commit is refused, and run_tests still will not run it", async (t) => {
  const { root, ws, tools } = await hookRepo(t);
  const marker = path.join(root, "agent-ran");
  const head = git(ws, "rev-parse", "HEAD");
  // However the hook was changed (a test run, a symlinked path), listing it
  // is refused before anything is staged or committed.
  await writeFile(path.join(ws, ".peeps/run-tests"), `#!/bin/sh\ntouch '${marker}'\n`);
  await assert.rejects(
    tools.git_commit_push!({ branch: "peeps/x", message: "m", token: "bogus", paths: [".peeps/run-tests"] }),
    /\.peeps\/ holds your own hooks/,
  );
  assert.equal(git(ws, "rev-parse", "HEAD"), head);
  assert.equal(git(ws, "diff", "--cached", "--name-only"), "");
  // #8's rule holds: the checkout's hook differs from the commit's, so it never runs.
  const out = (await tools.run_tests!({ file: "tests/test_a.py", test: "test_a" })) as HookRun;
  assert.equal(out.results, null);
  assert.match(out.outputTail, /differs from the commit under test/);
  await assert.rejects(stat(marker));
});

test("a real hook that starts a lab run and prints peeps:pending comes back pending", async (t) => {
  // The commit under test is the checkout's HEAD when the job starts.
  const { tools } = await hookRepo(t, `#!/bin/sh\necho "queued $2"\necho "peeps:pending https://lab.example/runs/7"\n`);
  const out = (await tools.run_tests!({ file: "tests/test_a.py", test: "test_a" })) as HookRun & {
    pending: boolean;
    pendingNote: string | null;
  };
  assert.equal(out.ranWith, ".peeps/run-tests");
  assert.equal(out.pending, true);
  assert.equal(out.pendingNote, "https://lab.example/runs/7");
  assert.equal(out.results, null);
  assert.match(out.outputTail, /queued tests\/test_a\.py::test_a/);
});

// ---------------------------------------------------------------------------
// A Python suite and a model-written diff (repo bench, pytest API heals)
// ---------------------------------------------------------------------------

test("grep reads a pytest suite's Python and config files", async (t) => {
  const { ws } = await repo(t);
  await mkdir(path.join(ws, "tests/api"), { recursive: true });
  await writeFile(path.join(ws, "tests/api/test_orders.py"), "assert created.status_code == 201\n");
  await writeFile(path.join(ws, "pytest.ini"), "[pytest]\nstatus_code_marker = 1\n");
  await writeFile(path.join(ws, "pyproject.toml"), "[tool.pytest.ini_options]\n");
  const out = (await toolsFor(ws).grep!({ pattern: "status_code|ini_options" })) as {
    matches: Array<{ path: string; line: number }>;
  };
  assert.deepEqual(out.matches.map((m) => m.path).sort(), ["pyproject.toml", "pytest.ini", "tests/api/test_orders.py"]);
});

test("apply_patch takes a model's diff with miscounted hunks and no final newline", async (t) => {
  const { ws } = await repo(t);
  await writeFile(path.join(ws, "e2e/a.spec.ts"), "one\ntwo\nthree\nfour\n");
  git(ws, "add", "-A");
  git(ws, "commit", "-q", "-m", "four lines");
  // The header claims 6 lines where the hunk has 3, and the last line has no
  // newline: git apply calls both a corrupt patch.
  const patch = "--- a/e2e/a.spec.ts\n+++ b/e2e/a.spec.ts\n@@ -1,6 +1,7 @@\n one\n+inserted\n two\n three";
  await toolsFor(ws).apply_patch!({ patch });
  assert.equal(await readFile(path.join(ws, "e2e/a.spec.ts"), "utf8"), "one\ninserted\ntwo\nthree\nfour\n");
});
