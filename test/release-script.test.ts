import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

// scripts/release.sh against a local bare "origin", with a fake `gh` that
// records what it was asked to do.

const script = path.resolve(__dirname, "../scripts/release.sh");

const gitEnv = {
  ...process.env,
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_AUTHOR_NAME: "t",
  GIT_AUTHOR_EMAIL: "t@e",
  GIT_COMMITTER_NAME: "t",
  GIT_COMMITTER_EMAIL: "t@e",
};

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8", env: gitEnv }).trim();
}

const README = (heading: string) =>
  [
    "# peeps-action",
    "",
    `## ${heading}`,
    "",
    "- Run mode: exports the environment.",
    "  Second line.",
    "",
    "## 1.5.0",
    "",
    "- Older notes.",
    "",
    "## Development",
    "",
  ].join("\n");

async function commit(work: string, version: string, heading: string, message: string) {
  await writeFile(path.join(work, "src/version.ts"), `export const ACTION_VERSION = "${version}";\n`);
  await writeFile(path.join(work, "README.md"), README(heading));
  git(work, "add", "-A");
  git(work, "commit", "-qm", message);
  git(work, "push", "-q", "origin", "HEAD:main");
  return git(work, "rev-parse", "HEAD");
}

/** origin with v1.5.0 and v1 at the first commit, and a fake gh. */
async function setup() {
  const root = await mkdtemp(path.join(tmpdir(), "release-"));
  const origin = path.join(root, "origin.git");
  const work = path.join(root, "work");
  const bin = path.join(root, "bin");
  git(root, "init", "-q", "--bare", origin);
  git(root, "init", "-q", "-b", "main", work);
  git(work, "remote", "add", "origin", origin);
  await mkdir(path.join(work, "src"));
  const base = await commit(work, "1.5.0", "1.5.0 placeholder", "Release 1.5.0");
  git(work, "tag", "-a", "v1.5.0", "-m", "peeps-action v1.5.0");
  git(work, "tag", "-a", "v1", "-m", "peeps-action v1");
  git(work, "push", "-q", "origin", "v1.5.0", "v1");

  await mkdir(bin);
  const gh = path.join(bin, "gh");
  // `gh release view <tag>` succeeds when <root>/released/<tag> exists;
  // `gh release create` records its arguments and the notes it was given.
  await writeFile(
    gh,
    `#!/usr/bin/env bash
set -e
if [ "$1 $2" = "release view" ]; then [ -e "${root}/released/$3" ]; exit; fi
if [ "$1 $2" = "release create" ]; then
  echo "$@" >> "${root}/gh.log"
  while [ $# -gt 0 ]; do
    if [ "$1" = "--notes-file" ]; then cp "$2" "${root}/notes.md"; fi
    shift
  done
  exit 0
fi
echo "unexpected gh $*" >&2; exit 2
`,
  );
  await chmod(gh, 0o755);
  await mkdir(path.join(root, "released"));
  await writeFile(path.join(root, "released/v1.5.0"), "");

  const run = () =>
    spawnSync("bash", [script], {
      cwd: work,
      encoding: "utf8",
      env: { ...gitEnv, PATH: `${bin}:${process.env.PATH}` },
    });
  const remoteTag = (name: string) =>
    git(origin, "for-each-ref", "--format=%(objectname) %(*objectname)", `refs/tags/${name}`);
  const commitOf = (name: string) => remoteTag(name).split(" ")[1] ?? "";
  const ghLog = async () =>
    existsSync(path.join(root, "gh.log")) ? await readFile(path.join(root, "gh.log"), "utf8") : "";
  return { root, origin, work, base, run, remoteTag, commitOf, ghLog };
}

test("a new version is tagged, the major tag moves, and the release carries the README notes", async () => {
  const t = await setup();
  const sha = await commit(t.work, "1.6.0", "1.6.0", "Release 1.6.0");

  const r = t.run();
  assert.equal(r.status, 0, r.stdout + r.stderr);

  assert.equal(t.commitOf("v1.6.0"), sha);
  assert.equal(t.commitOf("v1"), sha);
  assert.equal(git(t.origin, "cat-file", "-t", "v1"), "tag", "v1 stays an annotated tag");
  const message = git(t.origin, "tag", "-l", "--format=%(contents)", "v1.6.0");
  assert.match(message, /^peeps-action v1\.6\.0\n\n- Run mode: exports the environment\.\n {2}Second line\.$/);

  assert.match(await t.ghLog(), /^release create v1\.6\.0 --verify-tag --title v1\.6\.0 --notes-file \S+ --latest=true\n$/);
  assert.equal(
    await readFile(path.join(t.root, "notes.md"), "utf8"),
    "- Run mode: exports the environment.\n  Second line.\n",
  );
});

test("a push that does not change the version does nothing", async () => {
  const t = await setup();
  const before = [t.remoteTag("v1.5.0"), t.remoteTag("v1")];

  const r = t.run();
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.deepEqual([t.remoteTag("v1.5.0"), t.remoteTag("v1")], before);
  assert.equal(await t.ghLog(), "");
});

test("a later commit at an already-released version leaves its tags where they are", async () => {
  const t = await setup();
  const before = [t.remoteTag("v1.5.0"), t.remoteTag("v1")];
  await commit(t.work, "1.5.0", "Unreleased", "Unreleased change");

  const r = t.run();
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.deepEqual([t.remoteTag("v1.5.0"), t.remoteTag("v1")], before);
  assert.equal(await t.ghLog(), "");
});

test("a version with no README section is refused before anything is tagged", async () => {
  const t = await setup();
  await commit(t.work, "1.6.0", "Unreleased", "Bump without notes");

  const r = t.run();
  assert.equal(r.status, 1);
  assert.match(r.stdout, /README\.md has no notes under "## 1\.6\.0"/);
  assert.equal(t.remoteTag("v1.6.0"), "");
  assert.equal(t.commitOf("v1"), t.base);
  assert.equal(await t.ghLog(), "");
});

test("a version older than the newest release is refused", async () => {
  const t = await setup();
  await commit(t.work, "1.4.9", "1.4.9", "Backwards");

  const r = t.run();
  assert.equal(r.status, 1);
  assert.match(r.stdout, /older than the newest release, v1\.5\.0/);
  assert.equal(t.remoteTag("v1.4.9"), "");
  assert.equal(t.commitOf("v1"), t.base);
});

test("a rerun after a partial release moves the major tag and publishes the release", async () => {
  const t = await setup();
  const sha = await commit(t.work, "1.6.0", "1.6.0", "Release 1.6.0");
  git(t.work, "tag", "-a", "v1.6.0", "-m", "peeps-action v1.6.0");
  git(t.work, "push", "-q", "origin", "v1.6.0");
  git(t.work, "tag", "-d", "v1.6.0");

  const r = t.run();
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.equal(t.commitOf("v1.6.0"), sha);
  assert.equal(t.commitOf("v1"), sha);
  assert.match(await t.ghLog(), /^release create v1\.6\.0 /);
});

test("a new major version gets its own major tag and leaves the old one alone", async () => {
  const t = await setup();
  const sha = await commit(t.work, "2.0.0", "2.0.0", "Release 2.0.0");

  const r = t.run();
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.equal(t.commitOf("v2"), sha);
  assert.equal(t.commitOf("v1"), t.base);
});
