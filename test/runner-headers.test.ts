import { test } from "node:test";
import assert from "node:assert/strict";
import { readRunnerEnv } from "../src/env";
import { PeepsClient, runnerHeaders } from "../src/peeps";

test("names the runner and who hosts it, as the runner set them", () => {
  assert.deepEqual(runnerHeaders({ RUNNER_NAME: "alex-MacBook-Pro", RUNNER_ENVIRONMENT: "self-hosted" }), {
    "X-Peeps-Runner-Name": "alex-MacBook-Pro",
    "X-Peeps-Runner-Environment": "self-hosted",
  });
});

test("sends nothing the runner did not set", () => {
  assert.deepEqual(runnerHeaders({}), {});
  assert.deepEqual(runnerHeaders({ RUNNER_NAME: "  ", RUNNER_ENVIRONMENT: "github-hosted" }), {
    "X-Peeps-Runner-Environment": "github-hosted",
  });
});

test("keeps a name a header can carry: printable ASCII, 64 characters at most", () => {
  const headers = runnerHeaders({ RUNNER_NAME: `Jörg’s Mac\n${"x".repeat(100)}` });
  const name = headers["X-Peeps-Runner-Name"]!;
  assert.match(name, /^[\x20-\x7e]+$/);
  assert.equal(name.length, 64);
  assert.ok(name.startsWith("Jrgs Mac"));
});

test("every request to Peeps carries the runner headers", async () => {
  const saved = { name: process.env.RUNNER_NAME, hosting: process.env.RUNNER_ENVIRONMENT, fetch: globalThis.fetch };
  process.env.RUNNER_NAME = "team-mini";
  process.env.RUNNER_ENVIRONMENT = "self-hosted";
  const seen: Headers[] = [];
  globalThis.fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
    seen.push(new Headers(init?.headers));
    return new Response("{}", { status: 200 });
  }) as typeof fetch;
  try {
    const client = new PeepsClient(
      readRunnerEnv({
        GITLAB_CI: "true",
        CI_PROJECT_DIR: "/builds/x",
        CI_PROJECT_PATH: "x/y",
        CI_COMMIT_SHA: "b".repeat(40),
        CI_PIPELINE_ID: "1",
        CI_SERVER_URL: "https://gitlab.com",
        PEEPS_ID_TOKEN: "eyJ.gitlab.token",
      }),
    );
    await client.get("/a");
    await client.getOrNull("/b");
    await client.post("/c", {});
    await client.postBytes("/d", Buffer.from("x"));
    assert.equal(seen.length, 4);
    for (const headers of seen) {
      assert.equal(headers.get("x-peeps-runner-name"), "team-mini");
      assert.equal(headers.get("x-peeps-runner-environment"), "self-hosted");
    }
  } finally {
    globalThis.fetch = saved.fetch;
    if (saved.name === undefined) delete process.env.RUNNER_NAME;
    else process.env.RUNNER_NAME = saved.name;
    if (saved.hosting === undefined) delete process.env.RUNNER_ENVIRONMENT;
    else process.env.RUNNER_ENVIRONMENT = saved.hosting;
  }
});
