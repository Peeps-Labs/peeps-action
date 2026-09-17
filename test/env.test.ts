import { test } from "node:test";
import assert from "node:assert/strict";
import { readDefaultBranch, readRunnerEnv, resolvePeepsUrl } from "../src/env";

test("resolvePeepsUrl accepts https and trims trailing slashes", () => {
  assert.equal(resolvePeepsUrl("https://app.peepsai.com"), "https://app.peepsai.com");
  assert.equal(resolvePeepsUrl("https://app.peepsai.com///"), "https://app.peepsai.com");
});

test("resolvePeepsUrl refuses plaintext to a remote host", () => {
  // This URL receives the OIDC token, every spec file's source and the whole
  // HTML report, so a stray environment variable must not downgrade it.
  assert.throws(() => resolvePeepsUrl("http://app.peepsai.com"), /must use https/);
  assert.throws(() => resolvePeepsUrl("http://169.254.169.254/latest"), /must use https/);
});

test("resolvePeepsUrl allows loopback over http for local development", () => {
  assert.equal(resolvePeepsUrl("http://localhost:3000"), "http://localhost:3000");
  assert.equal(resolvePeepsUrl("http://127.0.0.1:3000"), "http://127.0.0.1:3000");
});

test("resolvePeepsUrl rejects something that is not a URL", () => {
  assert.throws(() => resolvePeepsUrl("app.peepsai.com"), /not a valid URL/);
});

test("working-directory is resolved against the workspace, not the process cwd", () => {
  // The Peeps UI emits a repo-relative value like `tools/e2e`. Leaving it
  // relative only worked while the runner's cwd happened to be the workspace;
  // when it wasn't, Playwright got paths outside its rootDir, ran nothing, and
  // the job still went green.
  const env = readRunnerEnv({
    GITHUB_WORKSPACE: "/workspace",
    "INPUT_WORKING-DIRECTORY": "tools/e2e",
  });
  assert.equal(env.workingDirectory, "/workspace/tools/e2e");
  assert.equal(env.workspace, "/workspace");
});

test("working-directory defaults to the workspace", () => {
  const env = readRunnerEnv({ GITHUB_WORKSPACE: "/workspace" });
  assert.equal(env.workingDirectory, "/workspace");
});

test("an absolute working-directory is left alone", () => {
  const env = readRunnerEnv({
    GITHUB_WORKSPACE: "/workspace",
    "INPUT_WORKING-DIRECTORY": "/elsewhere/e2e",
  });
  assert.equal(env.workingDirectory, "/elsewhere/e2e");
});

test("readRunnerEnv reads its inputs from the environment it was given", () => {
  // It used to take an env argument and then read process.env for every
  // action input, which made the parameter a lie and would have quietly
  // misled any test written against it.
  const env = readRunnerEnv({
    GITHUB_WORKSPACE: "/workspace",
    INPUT_MODE: "inventory",
    "INPUT_SESSION-ID": "session-abc",
    INPUT_CONFIG: "playwright.ci.ts",
  });
  assert.equal(env.mode, "inventory");
  assert.equal(env.sessionId, "session-abc");
  assert.equal(env.configPath, "playwright.ci.ts");
});

test("an empty input reads as absent rather than as an empty string", () => {
  // GitHub sets INPUT_* for every declared input, including the ones the
  // workflow left out, so blank has to mean "not provided".
  const env = readRunnerEnv({ GITHUB_WORKSPACE: "/workspace", INPUT_MODE: "   " });
  assert.equal(env.mode, "ci");
});

test("mode falls back to ci when nothing sets it", () => {
  assert.equal(readRunnerEnv({ GITHUB_WORKSPACE: "/workspace" }).mode, "ci");
});

test("the OIDC context is present only when both halves are", () => {
  const base = { GITHUB_WORKSPACE: "/workspace" };
  assert.equal(readRunnerEnv(base).oidc, null);
  assert.equal(
    readRunnerEnv({ ...base, ACTIONS_ID_TOKEN_REQUEST_URL: "https://x" }).oidc,
    null,
  );
  assert.deepEqual(
    readRunnerEnv({
      ...base,
      ACTIONS_ID_TOKEN_REQUEST_URL: "https://x",
      ACTIONS_ID_TOKEN_REQUEST_TOKEN: "t",
    }).oidc,
    { requestUrl: "https://x", requestToken: "t" },
  );
});

test("readDefaultBranch returns null without a readable event payload", () => {
  assert.equal(readDefaultBranch({}), null);
  assert.equal(readDefaultBranch({ GITHUB_EVENT_PATH: "/nope/missing.json" }), null);
});
