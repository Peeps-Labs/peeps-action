import { afterEach, test } from "node:test";
import assert from "node:assert/strict";
import { readRunnerEnv } from "../src/env";
import { PeepsClient, PeepsHttpError } from "../src/peeps";
import { requestPlan } from "../src/plan";

const JOB = {
  GITLAB_CI: "true",
  CI_PROJECT_DIR: "/builds/peeps-labs-group/rooster-e2e",
  CI_PROJECT_PATH: "peeps-labs-group/rooster-e2e",
  CI_COMMIT_SHA: "b".repeat(40),
  CI_COMMIT_BRANCH: "main",
  CI_DEFAULT_BRANCH: "main",
  CI_PIPELINE_ID: "2907262176",
  CI_PIPELINE_SOURCE: "api",
  CI_SERVER_URL: "https://gitlab.com",
  PEEPS_MODE: "run",
  PEEPS_SESSION_ID: "a6395ffe-748e-475e-a2e1-f6703d938d68",
  PEEPS_ID_TOKEN: "eyJ.gitlab.token",
  PEEPS_API_URL: "https://dev.peepsai.com",
};

const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
});

function answer(status: number, body: unknown): void {
  globalThis.fetch = (() =>
    Promise.resolve(
      new Response(JSON.stringify(body), {
        status,
        headers: { "Content-Type": "application/json" },
      }),
    )) as typeof fetch;
}

const client = () => new PeepsClient(readRunnerEnv(JOB));

test("a batch Peeps closed before the job started is nothing to run, not a failure", async () => {
  answer(409, { error: "batch_closed", message: "cancelled" });
  const logged: string[] = [];
  const log = console.log;
  console.log = (line: string) => logged.push(line);
  try {
    assert.equal(await requestPlan(client(), JOB.PEEPS_SESSION_ID, { tests: [] }), null);
  } finally {
    console.log = log;
  }
  assert.match(logged.join("\n"), /closed this batch before the job started/);
});

test("the plan comes back as Peeps sent it", async () => {
  answer(200, { batchId: "b-1", batchNumber: 4, runs: [] });
  assert.deepEqual(await requestPlan(client(), JOB.PEEPS_SESSION_ID, { tests: [] }), {
    batchId: "b-1",
    batchNumber: 4,
    runs: [],
  });
});

test("any other refusal still fails the job, with what Peeps said", async () => {
  answer(404, { error: "batch_not_found" });
  await assert.rejects(requestPlan(client(), JOB.PEEPS_SESSION_ID, { tests: [] }), (error: unknown) => {
    assert.ok(error instanceof PeepsHttpError);
    assert.equal(error.status, 404);
    assert.equal(error.code, "batch_not_found");
    assert.match(error.message, /\/plan → 404: \{"error":"batch_not_found"\}/);
    return true;
  });
  // A 409 that is not this one is a conflict to report, not to swallow.
  answer(409, { error: "something_else" });
  await assert.rejects(requestPlan(client(), JOB.PEEPS_SESSION_ID, { tests: [] }), /409/);
});

test("a non-JSON body has no error code", () => {
  assert.equal(new PeepsHttpError("/x", 502, "<html>bad gateway</html>").code, null);
});
