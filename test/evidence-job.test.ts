/** Before the announce: fingerprint the app's build and upload it, or give up quietly. */
import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { gunzipSync } from "node:zlib";

import { parseProjectKey, tokenOf } from "../src/evidence/hash";
import { fingerprintNextDir } from "../src/evidence/fingerprint/read-build";
import { prepareImpact as prepare, type PrepareInput } from "../src/evidence/job";
import type { Collect } from "../src/reach/preflight";
import type { EvidenceTransport } from "../src/evidence/upload";
import { localRepository } from "../src/reach/git";
import { BASE, nextBuild } from "./support/next-build";

/** In this process: the scanner's bundle is `dist/`'s, tested through the action itself. */
const prepareImpact = (input: Omit<PrepareInput, "fingerprint" | "collect"> & { collect: Omit<Collect, "projectId"> }, log: (line: string) => void) =>
  prepare({ ...input, collect: [{ projectId: "p1", ...input.collect }], fingerprint: async (nextDir, prefix) => fingerprintNextDir(nextDir, prefix) }, log).then((r) => r && { ...r, ...r.projects[0]! });

const key = parseProjectKey(Buffer.alloc(32, 5).toString("hex"))!;
const collect = { coverage: true, fingerprint: true, tables: false, key, keyVersion: "V1" };

/** A repository whose app sits in `apps/web`, built, with a merge commit at HEAD as GitHub makes for a pull request. */
async function repository(t: TestContext): Promise<{ root: string; app: string; sha: string; base: string }> {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), "peeps-impact-")));
  t.after(() => rm(root, { recursive: true, force: true }));
  const git = (...args: string[]) => execFileSync("git", args, { cwd: root, encoding: "utf8", env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" } }).trim();
  git("init", "-q", "-b", "main");
  await writeFile(path.join(root, "README.md"), "base\n");
  git("add", "."), git("commit", "-qm", "base");
  const base = git("rev-parse", "HEAD");
  git("checkout", "-qb", "feature");
  await writeFile(path.join(root, "feature.md"), "feature\n");
  git("add", "."), git("commit", "-qm", "feature");
  git("checkout", "-q", "main");
  git("merge", "-q", "--no-ff", "-m", "merge", "feature");
  const app = path.join(root, "apps/web");
  for (const [file, text] of nextBuild(BASE)) {
    await mkdir(path.dirname(path.join(app, ".next", file)), { recursive: true });
    await writeFile(path.join(app, ".next", file), text);
  }
  return { root, app, sha: git("rev-parse", "HEAD"), base };
}

function transport(answer: unknown = { uploadId: "up-1" }): EvidenceTransport & { sent: Array<{ path: string; bytes: Buffer }> } {
  const sent: Array<{ path: string; bytes: Buffer }> = [];
  return {
    sent,
    postBytes: async (p, bytes) => {
      sent.push({ path: p, bytes });
      if (answer instanceof Error) throw answer;
      return answer;
    },
    postJson: async () => ({}),
  };
}

test("a pull request's merge: the build's fingerprint goes up with the base, and the announce cites its receipt", async (t) => {
  const { app, sha, base } = await repository(t);
  const sink = transport();
  const impact = await prepareImpact({ appDir: app, sha, eventName: "pull_request", leg: "chromium", collect, repository: await localRepository(app), transport: sink }, () => {});
  assert.deepEqual(impact?.receipt, { uploadId: "up-1", digest: impact!.receipt.digest });
  assert.equal(impact?.projectId, "p1");
  const query = new URLSearchParams(sink.sent[0]!.path.split("?")[1]);
  assert.equal(query.get("base"), base);
  assert.equal(query.get("keyVersion"), "V1");
  // Sources are repo-relative: the app's directory is part of every file id.
  const bytes = gunzipSync(sink.sent[0]!.bytes).toString("latin1");
  assert.ok(bytes.includes(tokenOf(key, "file:apps/web/src/app/login/LoginForm.tsx")));
});

test("a push records at its own commit, with no base", async (t) => {
  const { app, sha } = await repository(t);
  const sink = transport();
  await prepareImpact({ appDir: app, sha, eventName: "push", leg: "chromium", collect, repository: await localRepository(app), transport: sink }, () => {});
  assert.equal(new URLSearchParams(sink.sent[0]!.path.split("?")[1]).has("base"), false);
});

test("two projects: one fingerprint, hashed and uploaded once for each with its own key", async (t) => {
  const { app, sha } = await repository(t);
  const sink = transport();
  const other = parseProjectKey(Buffer.alloc(32, 6).toString("hex"))!;
  let fingerprints = 0;
  const prepared = await prepare(
    {
      appDir: app, sha, eventName: "push", leg: "chromium", repository: await localRepository(app), transport: sink,
      collect: [{ projectId: "p1", ...collect }, { projectId: "p2", ...collect, key: other }],
      fingerprint: async (nextDir, prefix) => (fingerprints++, fingerprintNextDir(nextDir, prefix)),
    },
    () => {},
  );
  assert.equal(fingerprints, 1);
  assert.deepEqual(prepared?.projects.map((p) => p.projectId), ["p1", "p2"]);
  assert.deepEqual(sink.sent.map((s) => new URLSearchParams(s.path.split("?")[1]).get("projectId")), ["p1", "p2"]);
  const [first, second] = sink.sent.map((s) => gunzipSync(s.bytes).toString("latin1"));
  assert.ok(first!.includes(tokenOf(key, "file:apps/web/src/app/login/LoginForm.tsx")) && second!.includes(tokenOf(other, "file:apps/web/src/app/login/LoginForm.tsx")));
});

test("no impact, and nothing sent, without a build, without the fingerprint asked for, or off the merge", async (t) => {
  const { root, app, sha } = await repository(t);
  const lines: string[] = [];
  const cases = [
    { appDir: root, sha, eventName: "pull_request", collect },
    { appDir: app, sha, eventName: "pull_request", collect: { ...collect, fingerprint: false } },
    { appDir: app, sha: "0".repeat(40), eventName: "pull_request", collect },
  ];
  for (const input of cases) {
    const sink = transport();
    assert.equal(await prepareImpact({ ...input, leg: "chromium", repository: await localRepository(app), transport: sink }, (line) => lines.push(line)), null);
    assert.deepEqual(sink.sent, []);
  }
  assert.ok(lines.every((line) => !line.includes(key.toString("hex"))));
});

test("a refused upload is no impact, and the job goes on", async (t) => {
  const { app, sha } = await repository(t);
  const impact = await prepareImpact({ appDir: app, sha, eventName: "pull_request", leg: "chromium", collect, repository: await localRepository(app), transport: transport(new Error("Peeps → 404")) }, () => {});
  assert.equal(impact, null);
});

test("a build that can't be read is no impact, nothing sent, never a thrown job", async (t) => {
  const { chmod } = await import("node:fs/promises");
  const { app, sha } = await repository(t);
  const server = path.join(app, ".next/server");
  const sink = transport();
  const lines: string[] = [];
  await chmod(server, 0o000);
  let impact;
  try {
    impact = await prepareImpact({ appDir: app, sha, eventName: "push", leg: "chromium", collect, repository: await localRepository(app), transport: sink }, (line) => lines.push(line));
  } finally {
    // Before the repository's own cleanup, which can't remove what it can't read.
    await chmod(server, 0o755);
  }
  assert.equal(impact, null);
  assert.deepEqual(sink.sent, []);
  assert.match(lines.join("\n"), /couldn't be fingerprinted/);
});
