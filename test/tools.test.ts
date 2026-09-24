import { test } from "node:test";
import assert from "node:assert/strict";
import { ensureParentDirInside, jail, jailForWrite, makeRedactor, patchPaths } from "../src/tools";

const WS = "/workspace";

test("jail resolves repo-relative paths inside the workspace", () => {
  assert.equal(jail(WS, "tests/a.spec.ts"), "/workspace/tests/a.spec.ts");
  assert.equal(jail(WS, "./tests/a.spec.ts"), "/workspace/tests/a.spec.ts");
  // A leading slash is treated as repo-relative, not as the filesystem root.
  assert.equal(jail(WS, "/tests/a.spec.ts"), "/workspace/tests/a.spec.ts");
  // Backslashes are normalized, so a Windows-style path cannot smuggle a
  // segment past the deny checks below.
  assert.equal(jail(WS, "tests\\a.spec.ts"), "/workspace/tests/a.spec.ts");
});

test("jail refuses paths that escape the workspace", () => {
  for (const bad of [
    "../outside.ts",
    "tests/../../outside.ts",
    "/etc/passwd/../../../etc/passwd",
    "..",
  ]) {
    assert.throws(() => jail(WS, bad), /escapes the workspace/, bad);
  }
});

test("jail refuses the paths that hold secrets or git's own state", () => {
  for (const bad of [
    ".env",
    ".env.local",
    ".env.production",
    "apps/web/.env",
    ".git/config",
    "nested/.git/config",
    "node_modules/pkg/index.js",
    "apps/web/node_modules/pkg/index.js",
  ]) {
    assert.throws(() => jail(WS, bad), /off limits/, bad);
  }
});

test("a file named like an env file but not one is allowed", () => {
  // The deny rule is anchored: `.environment` and `env.ts` are ordinary files.
  assert.equal(jail(WS, ".environment"), "/workspace/.environment");
  assert.equal(jail(WS, "src/env.ts"), "/workspace/src/env.ts");
});

test("jailForWrite additionally refuses workflow files", () => {
  // Peeps promises never to edit workflow files, and a workflow it could
  // rewrite is the easy path from one file write to arbitrary execution.
  assert.throws(
    () => jailForWrite(WS, ".github/workflows/peeps.yml"),
    /workflow files are not writable/,
  );
  // Reading them stays allowed.
  assert.equal(
    jail(WS, ".github/workflows/peeps.yml"),
    "/workspace/.github/workflows/peeps.yml",
  );
  // Everything else under .github is writable.
  assert.equal(
    jailForWrite(WS, ".github/CODEOWNERS"),
    "/workspace/.github/CODEOWNERS",
  );
  // And jailForWrite still enforces everything jail does.
  assert.throws(() => jailForWrite(WS, ".env"), /off limits/);
});

test("the redactor masks environment values that look like secrets", () => {
  const redact = makeRedactor({
    MY_TOKEN: "s3cret-value-long-enough",
    SHORT: "abc",
    PATH: "/usr/bin:/bin",
  });
  assert.equal(redact("leaked s3cret-value-long-enough here"), "leaked [redacted] here");
  // Too short to be worth masking, and masking it would mangle prose.
  assert.equal(redact("abc"), "abc");
  // Allow-listed, because masking it would mangle every path in every result.
  assert.equal(redact("/usr/bin:/bin"), "/usr/bin:/bin");
});

test("the redactor masks the Actions credentials despite the prefix exemption", () => {
  // These three are the reason the blanket GITHUB_/ACTIONS_ skip was a hole:
  // each is a live credential, and the first can mint an OIDC token for any
  // audience at all.
  const redact = makeRedactor({
    ACTIONS_ID_TOKEN_REQUEST_TOKEN: "oidc-request-token-value",
    ACTIONS_RUNTIME_TOKEN: "runtime-token-value",
    GITHUB_TOKEN: "ghs-github-token-value",
    GITHUB_REPOSITORY: "acme/web-application",
  });
  assert.equal(redact("oidc-request-token-value"), "[redacted]");
  assert.equal(redact("runtime-token-value"), "[redacted]");
  assert.equal(redact("ghs-github-token-value"), "[redacted]");
  // Still not masked: it is not a credential and masking it would mangle
  // ordinary output.
  assert.equal(redact("acme/web-application"), "acme/web-application");
});

test("the redactor masks the longest match first", () => {
  // Otherwise a short secret that is a prefix of a longer one leaves the
  // remainder of the longer one visible.
  const redact = makeRedactor({ A: "abcdefgh", B: "abcdefghijkl" });
  assert.equal(redact("abcdefghijkl"), "[redacted]");
});

test("patchPaths reports both sides of a rename", async () => {
  const runGit = (_args: string[]) =>
    Promise.resolve({ stdout: "1\t1\told/name.ts => new/name.ts\n" });
  assert.deepEqual(await patchPaths(runGit, "p.patch"), [
    "old/name.ts",
    "new/name.ts",
  ]);
});

test("patchPaths expands git's factored rename form", async () => {
  const runGit = (_args: string[]) =>
    Promise.resolve({ stdout: "2\t0\ttests/{a => b}/spec.ts\n" });
  assert.deepEqual(await patchPaths(runGit, "p.patch"), [
    "tests/a/spec.ts",
    "tests/b/spec.ts",
  ]);
});

test("patchPaths collapses an empty side of a factored rename", async () => {
  const runGit = (_args: string[]) =>
    Promise.resolve({ stdout: "2\t0\ttests/{ => nested}/spec.ts\n" });
  assert.deepEqual(await patchPaths(runGit, "p.patch"), [
    "tests/spec.ts",
    "tests/nested/spec.ts",
  ]);
});

test("patchPaths lists every file and ignores blank lines", async () => {
  const runGit = (_args: string[]) =>
    Promise.resolve({ stdout: "1\t0\ta.ts\n3\t4\tb/c.ts\n\n" });
  assert.deepEqual(await patchPaths(runGit, "p.patch"), ["a.ts", "b/c.ts"]);
});

test("patchPaths refuses a quoted path rather than mis-decode it", async () => {
  // git C-quotes paths with unusual bytes. Guessing at the decoding of a path
  // that is about to be security-checked is worse than refusing it.
  const runGit = (_args: string[]) =>
    Promise.resolve({ stdout: '1\t0\t"tests/odd\\tname.ts"\n' });
  await assert.rejects(() => patchPaths(runGit, "p.patch"), /will not parse/);
});

test("patchPaths surfaces a diff git cannot parse", async () => {
  const runGit = (_args: string[]) =>
    Promise.reject(Object.assign(new Error("boom"), { stderr: "not a patch" }));
  await assert.rejects(() => patchPaths(runGit, "p.patch"), /not a valid diff/);
});

test("a patch touching a denied path is refused by the same jail as write_file", async () => {
  // The composition that matters: patchPaths feeds jailForWrite, so
  // apply_patch and write_file now agree about what is off limits. Before
  // this, `.env` was writable through a diff and refused through write_file.
  const runGit = (_args: string[]) =>
    Promise.resolve({ stdout: "1\t0\t.env.local\n" });
  const touched = await patchPaths(runGit, "p.patch");
  assert.throws(() => touched.forEach((p) => jailForWrite(WS, p)), /off limits/);
});

test("write_file's parent directories are created for a spec in a new folder (PQA-1838)", async () => {
  const { mkdtemp, stat } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const path = await import("node:path");
  const ws = await mkdtemp(path.join(tmpdir(), "peeps-ws-"));
  const abs = jailForWrite(ws, "e2e/auth/nested/sign-in.spec.ts");
  await ensureParentDirInside(ws, abs);
  assert.ok((await stat(path.join(ws, "e2e/auth/nested"))).isDirectory());
  // An existing parent is a no-op.
  await ensureParentDirInside(ws, abs);
});

test("a new folder under a symlink that leaves the workspace is refused and nothing is created outside", async () => {
  const { mkdtemp, symlink, stat } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const path = await import("node:path");
  const ws = await mkdtemp(path.join(tmpdir(), "peeps-ws-"));
  const outside = await mkdtemp(path.join(tmpdir(), "peeps-outside-"));
  await symlink(outside, path.join(ws, "escape"));
  const abs = jailForWrite(ws, "escape/new/dir/x.spec.ts");
  await assert.rejects(ensureParentDirInside(ws, abs), /escapes the workspace/);
  await assert.rejects(stat(path.join(outside, "new")), { code: "ENOENT" });
});

test("an existing parent that is a symlink out of the workspace is refused too", async () => {
  const { mkdtemp, symlink } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const path = await import("node:path");
  const ws = await mkdtemp(path.join(tmpdir(), "peeps-ws-"));
  const outside = await mkdtemp(path.join(tmpdir(), "peeps-outside-"));
  await symlink(outside, path.join(ws, "escape"));
  await assert.rejects(ensureParentDirInside(ws, jailForWrite(ws, "escape/x.spec.ts")), /escapes the workspace/);
});

test("a symlinked folder that stays inside the workspace is allowed", async () => {
  const { mkdtemp, mkdir, symlink, stat } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const path = await import("node:path");
  const ws = await mkdtemp(path.join(tmpdir(), "peeps-ws-"));
  await mkdir(path.join(ws, "real"));
  await symlink(path.join(ws, "real"), path.join(ws, "alias"));
  await ensureParentDirInside(ws, jailForWrite(ws, "alias/sub/x.spec.ts"));
  assert.ok((await stat(path.join(ws, "real/sub"))).isDirectory());
});
