import { afterEach, test } from "node:test";
import assert from "node:assert/strict";
import { readRunnerEnv } from "../src/env";
import { PeepsClient } from "../src/peeps";
import {
  exportDispatchedVariables,
  exportSharedVariables,
  exportWorkflowVariables,
  maskCommands,
} from "../src/shared-variables";

const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
});

function capture(): { lines: string[]; write: (line: string) => void } {
  const lines: string[] = [];
  return { lines, write: (line) => lines.push(line) };
}

async function withConsole<T>(fn: () => Promise<T>): Promise<{ result: T; lines: string[] }> {
  const lines: string[] = [];
  const log = console.log;
  console.log = (line: string) => lines.push(String(line));
  try {
    return { result: await fn(), lines };
  } finally {
    console.log = log;
  }
}

test("masks every value before it sets any, and logs names only", () => {
  const out = capture();
  const current: NodeJS.ProcessEnv = { GITHUB_ACTIONS: "true" };
  const result = exportSharedVariables(
    [
      { key: "E2E_USER_EMAIL", value: "e2e@example.com" },
      { key: "E2E_USER_PASSWORD", value: "s3cret" },
    ],
    { current, write: out.write, source: "Peeps IOS environment dev" },
  );
  assert.deepEqual(result, { set: ["E2E_USER_EMAIL", "E2E_USER_PASSWORD"], kept: [], refused: [] });
  assert.equal(current.E2E_USER_EMAIL, "e2e@example.com");
  assert.equal(current.E2E_USER_PASSWORD, "s3cret");
  assert.deepEqual(out.lines.slice(0, 2), ["::add-mask::e2e@example.com", "::add-mask::s3cret"]);
  // After the masks, no line holds a value.
  for (const line of out.lines.slice(2)) {
    assert.doesNotMatch(line, /s3cret|e2e@example\.com/);
  }
  assert.match(out.lines.join("\n"), /masked: E2E_USER_EMAIL, E2E_USER_PASSWORD/);
});

test("the workflow's own value wins, and is still masked", () => {
  const out = capture();
  const current: NodeJS.ProcessEnv = { GITHUB_ACTIONS: "true", E2E_USER_EMAIL: "mine@example.com" };
  const result = exportSharedVariables([{ key: "E2E_USER_EMAIL", value: "peeps@example.com" }], {
    current,
    write: out.write,
    source: "x",
  });
  assert.deepEqual(result.kept, ["E2E_USER_EMAIL"]);
  assert.equal(current.E2E_USER_EMAIL, "mine@example.com");
  assert.equal(out.lines[0], "::add-mask::peeps@example.com");
});

test("refuses names that change how a program starts, or that Peeps and the CI system own", () => {
  const out = capture();
  const current: NodeJS.ProcessEnv = { GITHUB_ACTIONS: "true" };
  const keys = ["NODE_OPTIONS", "LD_PRELOAD", "BASE_URL", "PEEPS_MODE", "GITHUB_TOKEN", "PATH", "not-a-name", "PYTHONPATH", "PLAYWRIGHT_BROWSERS_PATH", "npm_config_registry", "SHELLOPTS", "PS4", "JDK_JAVA_OPTIONS", "PYTEST_ADDOPTS"];
  const result = exportSharedVariables(
    keys.map((key) => ({ key, value: "evil" })),
    { current, write: out.write, source: "x" },
  );
  assert.deepEqual(result.refused, keys);
  for (const key of keys) assert.equal(current[key], undefined);
  assert.equal(out.lines[0], "::add-mask::evil");
});

test("sets nothing outside GitHub Actions, where nothing can mask it", () => {
  const out = capture();
  const current: NodeJS.ProcessEnv = { GITLAB_CI: "true" };
  const result = exportSharedVariables([{ key: "E2E_USER_PASSWORD", value: "s3cret" }], {
    current,
    write: out.write,
    source: "x",
  });
  assert.deepEqual(result.set, []);
  assert.equal(current.E2E_USER_PASSWORD, undefined);
  assert.doesNotMatch(out.lines.join("\n"), /s3cret/);
});

test("masks a multi-line value whole and line by line, escaped", () => {
  assert.deepEqual(maskCommands("line one\nline%two\n"), [
    "::add-mask::line one%0Aline%25two%0A",
    "::add-mask::line one",
    "::add-mask::line%25two",
  ]);
  assert.deepEqual(maskCommands(""), []);
});

const GITHUB_JOB = {
  GITHUB_ACTIONS: "true",
  GITHUB_REPOSITORY: "acme/mobile",
  GITHUB_SHA: "a".repeat(40),
  GITHUB_REF: "refs/pull/7/merge",
  ACTIONS_ID_TOKEN_REQUEST_URL: "https://token.example/request",
  ACTIONS_ID_TOKEN_REQUEST_TOKEN: "request-token",
  PEEPS_API_URL: "https://dev.peepsai.com",
};

/** Answers the OIDC token request, then `peeps` for every Peeps call; records each Peeps call. */
function answerPeeps(peeps: (url: string, init?: RequestInit) => Response): Array<{ url: string; body: unknown }> {
  const calls: Array<{ url: string; body: unknown }> = [];
  globalThis.fetch = ((input: string | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.startsWith("https://token.example")) {
      return Promise.resolve(new Response(JSON.stringify({ value: "oidc.jwt" }), { status: 200 }));
    }
    calls.push({ url, body: init?.body ? JSON.parse(String(init.body)) : undefined });
    return Promise.resolve(peeps(url, init));
  }) as typeof fetch;
  return calls;
}

test("a run the workflow started asks for its peeps-environment's variables and exports them", async () => {
  const env = readRunnerEnv({ ...GITHUB_JOB, "INPUT_PEEPS-ENVIRONMENT": "dev", "INPUT_PEEPS-PROJECT": "IOS" });
  assert.deepEqual(env.sharedVariablesFrom, { environment: "dev", project: "IOS" });
  const calls = answerPeeps(
    () =>
      new Response(
        JSON.stringify({ project: "IOS", environment: "dev", variables: [{ key: "SHARED_TEST_VAR_A", value: "v-a" }] }),
        { status: 200 },
      ),
  );
  const previous = process.env.GITHUB_ACTIONS;
  process.env.GITHUB_ACTIONS = "true";
  try {
    const { lines } = await withConsole(() => exportWorkflowVariables(env, new PeepsClient(env)));
    assert.equal(calls.length, 1);
    assert.equal(calls[0]!.url, "https://dev.peepsai.com/api/v1/ci/environment-variables");
    assert.deepEqual(calls[0]!.body, { environment: "dev", project: "IOS" });
    assert.equal(process.env.SHARED_TEST_VAR_A, "v-a");
    assert.equal(lines[0], "::add-mask::v-a");
    assert.match(lines.join("\n"), /Peeps IOS environment dev, masked: SHARED_TEST_VAR_A/);
  } finally {
    delete process.env.SHARED_TEST_VAR_A;
    if (previous === undefined) delete process.env.GITHUB_ACTIONS;
    else process.env.GITHUB_ACTIONS = previous;
  }
});

test("a run the workflow started without peeps-environment asks Peeps for nothing", async () => {
  const env = readRunnerEnv(GITHUB_JOB);
  assert.equal(env.sharedVariablesFrom, null);
  const calls = answerPeeps(() => new Response("{}", { status: 200 }));
  await exportWorkflowVariables(env, new PeepsClient(env));
  assert.equal(calls.length, 0);
});

test("a refused request warns and the job goes on", async () => {
  const env = readRunnerEnv({ ...GITHUB_JOB, "INPUT_PEEPS-ENVIRONMENT": "staging" });
  answerPeeps(() => new Response(JSON.stringify({ error: "environment_not_found" }), { status: 404 }));
  const { lines } = await withConsole(() => exportWorkflowVariables(env, new PeepsClient(env)));
  assert.match(lines.join("\n"), /::warning::Could not get the variables of Peeps environment staging/);
});

test("a run Peeps started asks for its batch's variables and exports them", async () => {
  const env = readRunnerEnv({ ...GITHUB_JOB, INPUT_MODE: "run", "INPUT_SESSION-ID": "batch-1" });
  const calls = answerPeeps(
    () =>
      new Response(
        JSON.stringify({ project: "IOS", environment: "dev", variables: [{ key: "SHARED_TEST_VAR_B", value: "v-b" }] }),
        { status: 200 },
      ),
  );
  const previous = process.env.GITHUB_ACTIONS;
  process.env.GITHUB_ACTIONS = "true";
  try {
    const { lines } = await withConsole(() => exportDispatchedVariables(env, new PeepsClient(env)));
    assert.equal(calls.length, 1);
    assert.equal(calls[0]!.url, "https://dev.peepsai.com/api/v1/ci/environment-variables");
    assert.deepEqual(calls[0]!.body, { batchId: "batch-1" });
    assert.equal(process.env.SHARED_TEST_VAR_B, "v-b");
    assert.equal(lines[0], "::add-mask::v-b");
  } finally {
    delete process.env.SHARED_TEST_VAR_B;
    if (previous === undefined) delete process.env.GITHUB_ACTIONS;
    else process.env.GITHUB_ACTIONS = previous;
  }
});

test("a run Peeps started with nothing to send says so without a warning", async () => {
  const env = readRunnerEnv({ ...GITHUB_JOB, INPUT_MODE: "run", "INPUT_SESSION-ID": "batch-1" });
  answerPeeps(() => new Response(JSON.stringify({ error: "environment_not_found" }), { status: 404 }));
  const { lines } = await withConsole(() => exportDispatchedVariables(env, new PeepsClient(env)));
  assert.doesNotMatch(lines.join("\n"), /::warning::/);
  assert.match(lines.join("\n"), /no variables from Peeps for this run/);

  answerPeeps(() => new Response(JSON.stringify({ error: "internal" }), { status: 500 }));
  const failed = await withConsole(() => exportDispatchedVariables(env, new PeepsClient(env)));
  assert.match(failed.lines.join("\n"), /::warning::Could not get the variables of this run's Peeps environment/);
});

test("peeps-environment is ignored on GitLab", async () => {
  const env = {
    ...readRunnerEnv({ ...GITHUB_JOB }),
    platform: "gitlab" as const,
    sharedVariablesFrom: { environment: "dev", project: null },
  };
  const calls = answerPeeps(() => new Response("{}", { status: 200 }));
  const { lines } = await withConsole(() => exportWorkflowVariables(env, new PeepsClient(env)));
  await exportDispatchedVariables({ ...env, sessionId: "batch-1" }, new PeepsClient(env));
  assert.equal(calls.length, 0);
  assert.match(lines.join("\n"), /ignored outside GitHub Actions/);
});
