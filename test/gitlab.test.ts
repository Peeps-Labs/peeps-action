import { test } from "node:test";
import assert from "node:assert/strict";
import { eventNameForPipelineSource, readRunnerEnv } from "../src/env";
import { PeepsClient } from "../src/peeps";
import { authenticatedPushUrl, jailForWrite, makeRedactor, maskUrlCredentials } from "../src/tools";

/** What GitLab CI/CD sets in a job Peeps started on a branch. */
const GITLAB_JOB = {
  GITLAB_CI: "true",
  CI_PROJECT_DIR: "/builds/peeps-labs-group/rooster-e2e",
  CI_PROJECT_PATH: "peeps-labs-group/rooster-e2e",
  CI_COMMIT_SHA: "b".repeat(40),
  CI_COMMIT_BRANCH: "peeps/fix-x",
  CI_DEFAULT_BRANCH: "main",
  CI_PIPELINE_ID: "2899818430",
  CI_PIPELINE_SOURCE: "api",
  CI_PIPELINE_URL: "https://gitlab.com/peeps-labs-group/rooster-e2e/-/pipelines/2899818430",
  CI_SERVER_URL: "https://gitlab.com",
  PEEPS_MODE: "agent",
  PEEPS_SESSION_ID: "0b7c6a3e-3f0e-4c9a-9d55-6f1a2b3c4d5e",
  PEEPS_WORKING_DIRECTORY: "tools/e2e",
  PEEPS_ID_TOKEN: "eyJ.gitlab.token",
};

test("a GitLab job reads its context from CI_* and its inputs from PEEPS_*", () => {
  const env = readRunnerEnv(GITLAB_JOB);
  assert.equal(env.platform, "gitlab");
  assert.equal(env.mode, "agent");
  assert.equal(env.sessionId, "0b7c6a3e-3f0e-4c9a-9d55-6f1a2b3c4d5e");
  assert.equal(env.repository, "peeps-labs-group/rooster-e2e");
  assert.equal(env.sha, "b".repeat(40));
  assert.equal(env.ref, "refs/heads/peeps/fix-x");
  assert.equal(env.eventName, "workflow_dispatch");
  assert.equal(env.defaultBranch, "main");
  assert.equal(env.runId, "2899818430");
  assert.equal(env.runUrl, GITLAB_JOB.CI_PIPELINE_URL);
  assert.equal(env.serverUrl, "https://gitlab.com");
  assert.equal(env.workspace, "/builds/peeps-labs-group/rooster-e2e");
  assert.equal(env.workingDirectory, "/builds/peeps-labs-group/rooster-e2e/tools/e2e");
  assert.equal(env.idToken, "eyJ.gitlab.token");
  assert.equal(env.oidc, null);
});

test("a GitLab job with no PEEPS_MODE reports, and names a merge request's or tag's ref", () => {
  const { PEEPS_MODE: _m, CI_COMMIT_BRANCH: _b, ...rest } = GITLAB_JOB;
  const mr = readRunnerEnv({
    ...rest,
    CI_PIPELINE_SOURCE: "merge_request_event",
    CI_MERGE_REQUEST_SOURCE_BRANCH_NAME: "feature",
  });
  assert.equal(mr.mode, "ci");
  assert.equal(mr.ref, "refs/heads/feature");
  assert.equal(mr.eventName, "pull_request");
  assert.equal(readRunnerEnv({ ...rest, CI_COMMIT_TAG: "v1" }).ref, "refs/tags/v1");
  assert.equal(readRunnerEnv(rest).ref, null);
});

test("a GitHub job is unchanged, and links its run on its own server", () => {
  const env = readRunnerEnv({
    GITHUB_WORKSPACE: "/workspace",
    GITHUB_REPOSITORY: "acme/app",
    GITHUB_RUN_ID: "42",
    GITHUB_SERVER_URL: "https://github.example.com/",
  });
  assert.equal(env.platform, "github");
  assert.equal(env.runUrl, "https://github.example.com/acme/app/actions/runs/42");
  assert.equal(env.idToken, null);
  assert.equal(readRunnerEnv({ GITHUB_WORKSPACE: "/w" }).runUrl, null);
});

test("GitLab pipeline sources read as the GitHub events Peeps reasons in", () => {
  assert.equal(eventNameForPipelineSource("push"), "push");
  assert.equal(eventNameForPipelineSource("schedule"), "schedule");
  assert.equal(eventNameForPipelineSource("web"), "workflow_dispatch");
  assert.equal(eventNameForPipelineSource("chat"), "chat");
  assert.equal(eventNameForPipelineSource(undefined), null);
});

test("a GitLab job authenticates with its ID token, needing no request", async () => {
  const client = new PeepsClient(readRunnerEnv(GITLAB_JOB));
  assert.equal(await client.token(), "eyJ.gitlab.token");
});

test("a GitLab job without an ID token says how to add one", async () => {
  const { PEEPS_ID_TOKEN: _t, ...rest } = GITLAB_JOB;
  const saved = process.env.PEEPS_API_KEY;
  delete process.env.PEEPS_API_KEY;
  try {
    await assert.rejects(new PeepsClient(readRunnerEnv(rest)).token(), /id_tokens: \{ PEEPS_ID_TOKEN/);
  } finally {
    if (saved !== undefined) process.env.PEEPS_API_KEY = saved;
  }
});

test("a push goes to the checkout's own remote with Peeps' token in each provider's form", () => {
  assert.equal(
    authenticatedPushUrl("https://gitlab-ci-token:job@gitlab.com/peeps-labs-group/rooster-e2e.git\n", "glpat-x", "gitlab"),
    "https://oauth2:glpat-x@gitlab.com/peeps-labs-group/rooster-e2e.git",
  );
  assert.equal(
    authenticatedPushUrl("https://github.com/acme/app", "ghs_x", "github"),
    "https://x-access-token:ghs_x@github.com/acme/app",
  );
  assert.throws(() => authenticatedPushUrl("git@gitlab.com:g/p.git", "t", "gitlab"), /not an https remote/);
});

test("git's error output never shows a URL's credentials", () => {
  assert.equal(
    maskUrlCredentials("fatal: unable to access 'https://oauth2:glpat-x@gitlab.com/g/p.git/'"),
    "fatal: unable to access 'https://***@gitlab.com/g/p.git/'",
  );
});

test("GitLab's CI configuration is not writable by Peeps", () => {
  for (const path of [".gitlab-ci.yml", "ci/peeps.gitlab-ci.yml", ".gitlab/ci/test.yml", ".gitlab"]) {
    assert.throws(() => jailForWrite("/ws", path), /not writable by Peeps/, path);
  }
  process.env.PEEPS_CI_CONFIG_PATH = "./build/pipeline.yml";
  try {
    assert.throws(() => jailForWrite("/ws", "build/pipeline.yml"), /not writable/);
  } finally {
    delete process.env.PEEPS_CI_CONFIG_PATH;
  }
  assert.equal(jailForWrite("/ws", "e2e/a.spec.ts"), "/ws/e2e/a.spec.ts");
});

test("the redactor masks GitLab's job credentials despite the CI_ exemption", () => {
  const redact = makeRedactor({
    CI_JOB_TOKEN: "glcbt-64_jobtokenvalue",
    CI_REPOSITORY_URL: "https://gitlab-ci-token:glcbt-64_jobtokenvalue@gitlab.com/g/p.git",
    CI_PROJECT_PATH: "peeps-labs-group/rooster-e2e",
    PEEPS_ID_TOKEN: "eyJhbGciOi.payload.sig",
  });
  const out = redact(
    "token glcbt-64_jobtokenvalue id eyJhbGciOi.payload.sig in peeps-labs-group/rooster-e2e",
  );
  assert.equal(out, "token [redacted] id [redacted] in peeps-labs-group/rooster-e2e");
});
