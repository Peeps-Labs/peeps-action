import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { RunnerEnv } from "../src/env";
import {
  ERROR_CONTEXT_MAX_BYTES,
  ERROR_CONTEXT_MAX_READ_BYTES,
  ERROR_CONTEXT_TOTAL_BYTES,
  ensureParentDirInside,
  jail,
  jailForWrite,
  makeRedactor,
  patchPaths,
  playwrightResults,
  readErrorContext,
} from "../src/tools";

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
  // The customer's hooks are theirs: a heal must not change what verifies it.
  assert.throws(() => jailForWrite(WS, ".peeps/run-tests"), /not writable by Peeps/);
  assert.throws(() => jailForWrite(WS, ".peeps"), /not writable by Peeps/);
  // A case-insensitive filesystem would write the same files.
  assert.throws(() => jailForWrite(WS, ".PEEPS/run-tests"), /not writable by Peeps/);
  assert.equal(jail(WS, ".peeps/run-tests"), "/workspace/.peeps/run-tests");
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

// ---------------------------------------------------------------------------
// Playwright run_tests evidence: error-context.md, file, title (PQA-2733/2737)
// ---------------------------------------------------------------------------

/** A real workspace, so realpath checks see real directories. */
async function workspace(t: { after: (fn: () => Promise<void>) => void }) {
  const ws = await realpath(await mkdtemp(path.join(tmpdir(), "peeps-ev-")));
  t.after(() => rm(ws, { recursive: true, force: true }));
  return ws;
}

async function contextFile(dir: string, body: string): Promise<string> {
  await mkdir(dir, { recursive: true });
  const file = path.join(dir, "error-context.md");
  await writeFile(file, body);
  return file;
}

const noRedact = makeRedactor({});

test("readErrorContext cuts mid-character back to the character's start, and says it cut", async (t) => {
  const ws = await workspace(t);
  // "€" is 3 bytes; after a 2-byte prefix, byte 16384 is the third byte of one.
  const body = "xy" + "€".repeat(10_000);
  assert.equal(Buffer.from(body)[ERROR_CONTEXT_MAX_BYTES]! & 0xc0, 0x80, "the cut must land mid-character");
  const read = await readErrorContext(await contextFile(path.join(ws, "r"), body), noRedact, [ws]);
  assert.ok(read !== null);
  assert.equal(read.truncated, true);
  assert.equal(read.text.includes("�"), false);
  // Backed off two bytes to the start of that "€".
  assert.equal(Buffer.byteLength(read.text), ERROR_CONTEXT_MAX_BYTES - 2);
});

test("readErrorContext keeps a short file whole and says it did not cut", async (t) => {
  const ws = await workspace(t);
  const read = await readErrorContext(await contextFile(path.join(ws, "r"), "# Test info\n\n- Name: a\n"), noRedact, [ws]);
  assert.deepEqual(read, { text: "# Test info\n\n- Name: a\n", truncated: false });
});

test("readErrorContext never redacts a partial read: a secret past 32 KB leaves no prefix behind", async (t) => {
  const ws = await workspace(t);
  // 400 lines of a 95-character secret: ~38 KB, so one copy straddles any
  // fixed-size read near 32 KB.
  const secret = "S".repeat(40) + "0123456789".repeat(5) + "abcde";
  assert.equal(secret.length, 95);
  const file = await contextFile(path.join(ws, "r"), Array.from({ length: 400 }, () => secret).join("\n"));
  const read = await readErrorContext(file, makeRedactor({ LAB_SECRET: secret }), [ws]);
  assert.ok(read !== null);
  assert.ok(Buffer.byteLength(read.text) <= ERROR_CONTEXT_MAX_BYTES);
  assert.equal(/[S0-9a-e]{8,}/.test(read.text), false, read.text.slice(-200));
});

test("readErrorContext drops Playwright's Instructions preamble, which is a prompt for another assistant", async (t) => {
  const ws = await workspace(t);
  const body =
    "# Instructions\n\n- Following Playwright test failed.\n- Explain why, be concise.\n\n" +
    "# Test info\n\n- Name: a\n\n# Error details\n\n```yaml\n- paragraph: refused\n```\n";
  const read = await readErrorContext(await contextFile(path.join(ws, "r"), body), noRedact, [ws]);
  assert.equal(read?.text, "# Test info\n\n- Name: a\n\n# Error details\n\n```yaml\n- paragraph: refused\n```\n");
});

test("readErrorContext reads only a regular error-context.md under an allowed root, at most 1 MB", async (t) => {
  const ws = await workspace(t);
  const outside = await workspace(t);
  assert.equal(ERROR_CONTEXT_MAX_READ_BYTES, 1024 * 1024);
  const ok = await contextFile(path.join(ws, "ok"), "- paragraph: hi\n");
  assert.equal((await readErrorContext(ok, noRedact, [ws]))?.text, "- paragraph: hi\n");
  // Over 1 MB: read whole or not at all.
  const big = await contextFile(path.join(ws, "big"), "x".repeat(ERROR_CONTEXT_MAX_READ_BYTES + 1));
  assert.equal(await readErrorContext(big, noRedact, [ws]), null);
  // A symlink, even one named error-context.md pointing at a good file.
  await mkdir(path.join(ws, "link"));
  await symlink(ok, path.join(ws, "link/error-context.md"));
  assert.equal(await readErrorContext(path.join(ws, "link/error-context.md"), noRedact, [ws]), null);
  // Any other name (a spec can attach any path as "error-context").
  await writeFile(path.join(ws, ".env"), "TOKEN=x\n");
  assert.equal(await readErrorContext(path.join(ws, ".env"), noRedact, [ws]), null);
  // Outside every allowed root, then allowed through a project's outputDir.
  const far = await contextFile(path.join(outside, "out"), "- paragraph: far\n");
  assert.equal(await readErrorContext(far, noRedact, [ws]), null);
  assert.equal((await readErrorContext(far, noRedact, [ws, path.join(outside, "out")]))?.text, "- paragraph: far\n");
  // A directory, and a missing file.
  await mkdir(path.join(ws, "dir/error-context.md"), { recursive: true });
  assert.equal(await readErrorContext(path.join(ws, "dir/error-context.md"), noRedact, [ws]), null);
  assert.equal(await readErrorContext(path.join(ws, "missing/error-context.md"), noRedact, [ws]), null);
});

type Spec = { title: string; line: number; status: string; context?: string };

/** Playwright's JSON report for one spec file, as `run_tests` parses it. */
function report(rootDir: string | undefined, specFile: string, specs: Spec[], outputDir?: string) {
  return {
    config: { ...(rootDir === undefined ? {} : { rootDir }), projects: outputDir ? [{ outputDir }] : [] },
    suites: [{
      title: specFile,
      file: specFile,
      specs: specs.map((s) => ({
        title: s.title,
        file: specFile,
        line: s.line,
        tests: [{
          results: [{
            status: s.status,
            retry: 0,
            ...(s.status === "failed" ? { error: { message: `Error in ${s.title}`, snippet: `> ${s.line} | ${s.title}` } } : {}),
            attachments: s.context ? [{ name: "error-context", path: s.context, contentType: "text/markdown" }] : [],
          }],
        }],
      })),
    }],
  };
}

function envFor(ws: string): RunnerEnv {
  return { workspace: ws, workingDirectory: ws } as unknown as RunnerEnv;
}

test("errorContext has a budget across the whole result: 40 failures stay far under the server's 512 KB", async (t) => {
  const ws = await workspace(t);
  const specs: Spec[] = [];
  for (let i = 0; i < 40; i++) {
    // Each context is over the 16 KB cap, as a real page's snapshot often is.
    const ctx = await contextFile(path.join(ws, "results", `t${i}`), `- paragraph: "row ${i}"\n`.repeat(1200));
    specs.push({ title: `case ${i}`, line: i + 2, status: "failed", context: ctx });
  }
  const results = (await playwrightResults(report(path.join(ws, "e2e"), "a.spec.ts", specs), envFor(ws), noRedact))!;
  assert.equal(ERROR_CONTEXT_TOTAL_BYTES, 128 * 1024);
  assert.equal(results.length, 40);
  assert.ok(results.every((r) => r.status === "failed" && r.file === "e2e/a.spec.ts"));
  assert.ok(Buffer.byteLength(JSON.stringify(results)) < 512 * 1024, String(Buffer.byteLength(JSON.stringify(results))));
  const carried = results.filter((r) => r.errorContext !== undefined);
  const total = carried.reduce((n, r) => n + Buffer.byteLength(r.errorContext!), 0);
  assert.ok(total <= ERROR_CONTEXT_TOTAL_BYTES, String(total));
  assert.ok(carried.length >= 7, String(carried.length));
  assert.ok(carried.every((r) => r.errorContextTruncated === true));
  // Every failure past the budget says its context was left out.
  const omitted = results.filter((r) => r.errorContext === undefined);
  assert.equal(carried.length + omitted.length, 40);
  assert.ok(omitted.length > 0 && omitted.every((r) => r.errorContextOmitted === true));
  assert.equal(results[0]!.errorContext !== undefined, true);
});

test("a redacted title says so and keeps its line; file is never redacted", async (t) => {
  const ws = await workspace(t);
  // Not a secret, but redacted all the same: any env value of 8+ characters.
  const redact = makeRedactor({ APP_ENV: "production" });
  const results = (await playwrightResults(
    report(path.join(ws, "tests/production"), "smoke.spec.ts", [
      { title: "shows the production banner", line: 3, status: "passed" },
      { title: "loads", line: 7, status: "passed" },
    ]),
    envFor(ws),
    redact,
  ))!;
  assert.deepEqual(
    results.map((r) => ({ title: r.title, file: r.file, line: r.line, titleRedacted: r.titleRedacted })),
    [
      { title: "shows the [redacted] banner", file: "tests/production/smoke.spec.ts", line: 3, titleRedacted: true },
      { title: "loads", file: "tests/production/smoke.spec.ts", line: 7, titleRedacted: undefined },
    ],
  );
  assert.equal("titleRedacted" in results[1]!, false);
});

test("file is left out for a spec outside the workspace, and when the report names no rootDir", async (t) => {
  const ws = await workspace(t);
  const outside = await workspace(t);
  const spec = [{ title: "a", line: 1, status: "passed" }];
  const far = (await playwrightResults(report(outside, "a.spec.ts", spec), envFor(ws), noRedact))!;
  assert.equal("file" in far[0]!, false);
  const noRoot = (await playwrightResults(report(undefined, "a.spec.ts", spec), envFor(ws), noRedact))!;
  assert.equal("file" in noRoot[0]!, false);
  assert.equal(noRoot[0]!.line, 1);
});

test("a failure's context under a project's outputDir outside the workspace is read", async (t) => {
  const ws = await workspace(t);
  const out = await workspace(t);
  const ctx = await contextFile(path.join(out, "t0"), "- paragraph: far\n");
  const results = (await playwrightResults(
    report(ws, "a.spec.ts", [{ title: "a", line: 1, status: "failed", context: ctx }], out),
    envFor(ws),
    noRedact,
  ))!;
  assert.equal(results[0]!.errorContext, "- paragraph: far\n");
  assert.equal(results[0]!.errorContextTruncated, false);
});
