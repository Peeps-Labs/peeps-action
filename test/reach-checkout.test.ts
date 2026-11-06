/**
 * Which commit a pull request job tests, and what changed in it, against real
 * repositories: the merge commit GitHub makes, a shallow clone of it, and the
 * checkouts that aren't it.
 */
import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { parseDiff, readCheckout as readWith } from "../src/reach/checkout";
import { localRepository } from "../src/reach/git";

process.env.GIT_CONFIG_GLOBAL = "/dev/null";
process.env.GIT_CONFIG_NOSYSTEM = "1";
process.env.GIT_CONFIG_COUNT = "1";
process.env.GIT_CONFIG_KEY_0 = "protocol.file.allow";
process.env.GIT_CONFIG_VALUE_0 = "always";

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@e.com", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@e.com" },
  }).trim();
}

/** main with `cart.js`, a branch changing line 2, then main moving on; the merge is on `refs/pull`. */
async function pullRequest(t: TestContext) {
  const dir = await realpath(await mkdtemp(path.join(tmpdir(), "peeps-checkout-")));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const origin = path.join(dir, "origin");
  git(dir, "init", "-q", "-b", "main", origin);
  await writeFile(path.join(origin, "cart.js"), "one\ntwo\nthree\n");
  await writeFile(path.join(origin, "other.js"), "a\n");
  git(origin, "add", ".");
  git(origin, "commit", "-qm", "first");
  git(origin, "checkout", "-qb", "change");
  await writeFile(path.join(origin, "cart.js"), "one\nTWO\nthree\n");
  git(origin, "commit", "-qam", "change cart");
  const head = git(origin, "rev-parse", "HEAD");
  git(origin, "checkout", "-q", "main");
  await writeFile(path.join(origin, "other.js"), "b\n");
  git(origin, "commit", "-qam", "main moved");
  const base = git(origin, "rev-parse", "HEAD");
  git(origin, "merge", "-q", "--no-ff", "-m", "merge", "change");
  const merge = git(origin, "rev-parse", "HEAD");
  // Back to main before the merge: the merge commit is reachable only from its own branch.
  git(origin, "branch", "pull-merge", merge);
  git(origin, "reset", "-q", "--hard", base);
  return { dir, origin, merge, base, head };
}

const env = (workspace: string, sha: string) => ({ workspace, sha });
const readCheckout = async (input: { workspace: string; sha: string }) => readWith(await localRepository(input.workspace), input.sha);

test("a full clone of the merge: the base is its first parent, nothing is fetched, and the diff is the pull request's alone", async (t) => {
  const pr = await pullRequest(t);
  const work = path.join(pr.dir, "work");
  git(pr.dir, "clone", "-q", "-b", "pull-merge", pr.origin, work);
  const before = git(work, "rev-list", "--count", "HEAD");
  const out = await readCheckout(env(work, pr.merge));
  assert.ok(out.ok, JSON.stringify(out));
  assert.equal(out.base, pr.base);
  assert.equal(git(work, "rev-list", "--count", "HEAD"), before, "a full clone is not deepened");
  assert.deepEqual(out.changes.map((c) => c.path), ["cart.js"], "other.js moved on the base, so it isn't in this pull request");
  assert.deepEqual(out.changes[0]!.hunks, [{ newStart: 2, newCount: 1, removed: ["two"], added: ["TWO"] }]);
});

test("a shallow clone of the merge is deepened once, and reads the same", async (t) => {
  const pr = await pullRequest(t);
  const work = path.join(pr.dir, "work");
  git(pr.dir, "clone", "-q", "--depth=1", "-b", "pull-merge", `file://${pr.origin}`, work);
  assert.equal(git(work, "rev-list", "--count", "HEAD"), "1", "the clone starts with one commit");
  const out = await readCheckout(env(work, pr.merge));
  assert.ok(out.ok, JSON.stringify(out));
  assert.equal(out.base, pr.base);
  assert.equal(git(work, "rev-list", "--count", "HEAD"), "3", "the merge and its two parents, no more");
  assert.deepEqual(out.changes.map((c) => c.path), ["cart.js"]);
});

test("a shallow clone that can't reach its origin is not a merge we can read", async (t) => {
  const pr = await pullRequest(t);
  const work = path.join(pr.dir, "work");
  git(pr.dir, "clone", "-q", "--depth=1", "-b", "pull-merge", `file://${pr.origin}`, work);
  git(work, "remote", "set-url", "origin", path.join(pr.dir, "gone"));
  assert.deepEqual(await readCheckout(env(work, pr.merge)), { ok: false, why: "not_merge" });
});

test("HEAD not being the job's commit is not_merge", async (t) => {
  const pr = await pullRequest(t);
  const work = path.join(pr.dir, "work");
  git(pr.dir, "clone", "-q", "-b", "pull-merge", pr.origin, work);
  assert.deepEqual(await readCheckout(env(work, pr.base)), { ok: false, why: "not_merge" });
});

test("a checkout of the pull request's head, with no second parent, is not_merge", async (t) => {
  const pr = await pullRequest(t);
  const work = path.join(pr.dir, "work");
  git(pr.dir, "clone", "-q", "-b", "change", pr.origin, work);
  assert.deepEqual(await readCheckout(env(work, pr.head)), { ok: false, why: "not_merge" });
});

test("a repository nested below the workspace is not the checkout the paths are relative to", async (t) => {
  const pr = await pullRequest(t);
  const work = path.join(pr.dir, "work");
  git(pr.dir, "clone", "-q", "-b", "pull-merge", pr.origin, work);
  assert.deepEqual(await readCheckout(env(path.join(work, "."), pr.merge)).then((o) => o.ok), true);
  const outside = path.join(pr.dir);
  assert.deepEqual(await readCheckout(env(outside, pr.merge)), { ok: false, why: "not_merge" });
});

test("a step that rewrote a changed file makes the hunks untrustworthy", async (t) => {
  const pr = await pullRequest(t);
  const work = path.join(pr.dir, "work");
  git(pr.dir, "clone", "-q", "-b", "pull-merge", pr.origin, work);
  await writeFile(path.join(work, "cart.js"), "zero\none\nTWO\nthree\n");
  assert.deepEqual(await readCheckout(env(work, pr.merge)), { ok: false, why: "dirty_checkout" });
});

test("parseDiff: hunks in the new tree's coordinates, a removal's position, rename, delete, binary, mode", () => {
  const diff = [
    "diff --git a/a.ts b/a.ts",
    "index 1..2 100644",
    "--- a/a.ts",
    "+++ b/a.ts",
    "@@ -3 +3 @@ function x() {",
    "--- not a header: a removed line starting with two dashes",
    "+++ not a header: an added line starting with two pluses",
    "@@ -9,2 +8,0 @@",
    "-gone one",
    "-gone two",
    "@@ -20,0 +20,2 @@",
    "+new one",
    "+new two",
    "diff --git a/old.ts b/new.ts",
    "similarity index 100%",
    "rename from old.ts",
    "rename to new.ts",
    "diff --git a/del.ts b/del.ts",
    "deleted file mode 100644",
    "index 1..0",
    "--- a/del.ts",
    "+++ /dev/null",
    "@@ -1 +0,0 @@",
    "-bye",
    "diff --git a/img.png b/img.png",
    "index 1..2 100644",
    "Binary files a/img.png and b/img.png differ",
    "diff --git a/run.sh b/run.sh",
    "old mode 100644",
    "new mode 100755",
    "diff --git a/added.ts b/added.ts",
    "new file mode 100644",
    "index 0..1",
    "--- /dev/null",
    "+++ b/added.ts",
    "@@ -0,0 +1 @@",
    "+hello",
    "",
  ].join("\n");
  const out = parseDiff(diff);
  assert.deepEqual(out.map((c) => [c.path, c.status, c.oldPath, c.binary, c.hunks.length]), [
    ["a.ts", "modified", undefined, false, 3],
    ["new.ts", "renamed", "old.ts", false, 0],
    ["del.ts", "deleted", undefined, false, 1],
    ["img.png", "modified", undefined, true, 0],
    ["run.sh", "modified", undefined, false, 0],
    ["added.ts", "added", undefined, false, 1],
  ]);
  assert.deepEqual(out[0]!.hunks, [
    { newStart: 3, newCount: 1, removed: ["-- not a header: a removed line starting with two dashes"], added: ["++ not a header: an added line starting with two pluses"] },
    { newStart: 8, newCount: 0, removed: ["gone one", "gone two"], added: [] },
    { newStart: 20, newCount: 2, removed: [], added: ["new one", "new two"] },
  ]);
});

test("parseDiff refuses a quoted path rather than misreading it", () => {
  assert.throws(() => parseDiff('diff --git "a/tab\\there.ts" "b/tab\\there.ts"\nindex 1..2\n--- "a/tab\\there.ts"\n+++ "b/tab\\there.ts"\n@@ -1 +1 @@\n-a\n+b\n'));
});

test("the identity decision needs nothing but its port: a head checkout reads not_merge with no git at all", async () => {
  const calls: string[] = [];
  const answers: Record<string, string> = {
    "rev-parse --show-toplevel": "/work\n",
    "rev-parse HEAD": "abc\n",
    "rev-parse --is-shallow-repository": "false\n",
  };
  const repository = {
    workspace: "/work",
    git: async (...args: string[]) => {
      calls.push(args.join(" "));
      const answer = answers[args.join(" ")];
      if (answer === undefined) throw new Error("no second parent");
      return answer;
    },
  };
  assert.deepEqual(await readWith(repository, "abc"), { ok: false, why: "not_merge" });
  assert.ok(calls.includes("rev-parse --verify --quiet HEAD^2"));
  assert.ok(!calls.some((c) => c.startsWith("fetch")), "a full clone isn't deepened");
});

test("past its deadline, the repository runs no git", async () => {
  const repository = await localRepository(process.cwd(), Date.now() - 1);
  await assert.rejects(repository.git("rev-parse", "HEAD"), /Out of time/);
});
