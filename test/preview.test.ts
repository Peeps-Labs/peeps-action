import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  GITHUB_TOKEN_INPUT,
  previewBaseUrl,
  readPreviewRequest,
  takeGithubToken,
  waitForVercelPreview,
  type PreviewRequest,
} from "../src/preview";

const SHA = "a".repeat(40);
const VERCEL = { login: "vercel[bot]" };

function eventFile(payload: unknown): string {
  const dir = mkdtempSync(path.join(tmpdir(), "peeps-preview-"));
  const file = path.join(dir, "event.json");
  writeFileSync(file, JSON.stringify(payload));
  return file;
}

const prEnv = (extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv => ({
  INPUT_PREVIEW: "vercel",
  GITHUB_EVENT_NAME: "pull_request",
  GITHUB_REPOSITORY: "acme/shop",
  GITHUB_EVENT_PATH: eventFile({ pull_request: { head: { sha: SHA, repo: { full_name: "acme/shop" } } } }),
  ...extra,
});

test("takeGithubToken removes the input from the environment children inherit", () => {
  const env: NodeJS.ProcessEnv = { [GITHUB_TOKEN_INPUT]: "ghs_token", OTHER: "x" };
  assert.equal(takeGithubToken(env), "ghs_token");
  assert.equal(env[GITHUB_TOKEN_INPUT], undefined);
  assert.equal(env.OTHER, "x");
  assert.equal(takeGithubToken({}), null);
});

test("readPreviewRequest is off without the input", () => {
  assert.equal(readPreviewRequest({ GITHUB_EVENT_NAME: "pull_request" }, "t"), null);
});

test("readPreviewRequest waits only on a pull request", () => {
  assert.equal(readPreviewRequest(prEnv({ GITHUB_EVENT_NAME: "push" }), "t"), null);
  assert.equal(readPreviewRequest(prEnv({ GITHUB_EVENT_NAME: "workflow_dispatch" }), "t"), null);
});

test("readPreviewRequest refuses pull_request_target and a fork's pull request", () => {
  assert.throws(() => readPreviewRequest(prEnv({ GITHUB_EVENT_NAME: "pull_request_target" }), "t"), /pull_request_target/);
  const fork = eventFile({ pull_request: { head: { sha: SHA, repo: { full_name: "mallory/shop" } } } });
  assert.throws(() => readPreviewRequest(prEnv({ GITHUB_EVENT_PATH: fork }), "t"), /comes from mallory\/shop/);
});

test("readPreviewRequest reads the pull request's head commit, not the merge commit", () => {
  const request = readPreviewRequest(prEnv({ GITHUB_SHA: "b".repeat(40), "INPUT_PREVIEW-PROJECT": "web" }), "t");
  assert.equal(request?.sha, SHA);
  assert.equal(request?.repository, "acme/shop");
  assert.equal(request?.timeoutMs, 600_000);
  assert.equal(request?.apiUrl, "https://api.github.com");
  assert.equal(request?.project, "web");
});

test("readPreviewRequest refuses an unknown provider and a bad timeout", () => {
  assert.throws(() => readPreviewRequest(prEnv({ INPUT_PREVIEW: "netlify" }), "t"), /not supported/);
  assert.throws(() => readPreviewRequest(prEnv({ "INPUT_PREVIEW-TIMEOUT": "soon" }), "t"), /positive number/);
});

test("readPreviewRequest needs a token and a head commit", () => {
  assert.throws(() => readPreviewRequest(prEnv(), null), /github-token/);
  assert.throws(() => readPreviewRequest(prEnv({ GITHUB_EVENT_PATH: eventFile({}) }), "t"), /head commit/);
});

const request: PreviewRequest = {
  provider: "vercel",
  repository: "acme/shop",
  sha: SHA,
  token: "ghs_token",
  timeoutMs: 30_000,
  apiUrl: "https://api.github.com",
  project: null,
};

/** A fake GitHub answering by path; each answer is a list consumed per call. */
function fakeGitHub(routes: Record<string, unknown[]>, headers: Record<string, string> = {}, status = 404) {
  const calls: string[] = [];
  const fetchFn = (async (input: string | URL) => {
    const url = new URL(String(input));
    const key = url.pathname.replace("/repos/acme/shop", "") + url.search;
    calls.push(key);
    const route = Object.keys(routes).find((k) => key.startsWith(k));
    // Commit statuses default to none, so a test names them only when they matter.
    if (!route && key.startsWith("/commits/") && Object.keys(routes).length > 0) {
      return new Response("[]", { status: 200 });
    }
    if (!route) return new Response("refused", { status, headers });
    const answers = routes[route]!;
    const body = answers.length > 1 ? answers.shift() : answers[0];
    return new Response(JSON.stringify(body), { status: 200 });
  }) as typeof fetch;
  return { fetchFn, calls };
}

const instant = { sleep: async () => {}, pollMs: 0 };

test("returns the preview URL once Vercel's deployment succeeds", async () => {
  const { fetchFn } = fakeGitHub({
    "/deployments?": [[{ id: 7, environment: "Preview – shop", creator: VERCEL }]],
    "/deployments/7/statuses": [
      [{ state: "in_progress" }],
      [{ state: "success", environment_url: "https://shop-git-x-acme.vercel.app" }, { state: "in_progress" }],
    ],
  });
  const url = await waitForVercelPreview(request, { fetch: fetchFn, ...instant });
  assert.equal(url, "https://shop-git-x-acme.vercel.app");
});

test("ignores production, other environments and deployments Vercel did not make", async () => {
  const { fetchFn } = fakeGitHub({
    "/deployments?": [
      [
        { id: 1, environment: "Production", creator: VERCEL },
        { id: 3, environment: "Preview", creator: { login: "someone-else" } },
        { id: 2, environment: "Preview", creator: VERCEL },
      ],
    ],
    "/deployments/1/statuses": [[{ state: "success", environment_url: "https://prod.example" }]],
    "/deployments/3/statuses": [[{ state: "success", environment_url: "https://attacker.example" }]],
    "/deployments/2/statuses": [[{ state: "success", environment_url: "https://preview.example" }]],
  });
  assert.equal(await waitForVercelPreview(request, { fetch: fetchFn, ...instant }), "https://preview.example");
});

test("an inactive deployment that succeeded is still this commit's preview", async () => {
  const { fetchFn } = fakeGitHub({
    "/deployments?": [[{ id: 7, environment: "Preview", creator: VERCEL }]],
    "/deployments/7/statuses": [
      [
        { state: "inactive" },
        { state: "success", environment_url: "https://shop-abc.vercel.app" },
      ],
    ],
  });
  assert.equal(await waitForVercelPreview(request, { fetch: fetchFn, ...instant }), "https://shop-abc.vercel.app");
});

test("an older failed deployment does not fail the job while a redeploy builds", async () => {
  const { fetchFn } = fakeGitHub({
    "/deployments?": [
      [
        { id: 5, environment: "Preview", creator: VERCEL },
        { id: 9, environment: "Preview", creator: VERCEL },
      ],
    ],
    "/deployments/5/statuses": [[{ state: "failure", target_url: "https://vercel.com/acme/shop/old" }]],
    "/deployments/9/statuses": [
      [{ state: "in_progress" }],
      [{ state: "success", environment_url: "https://shop-new.vercel.app" }],
    ],
  });
  assert.equal(await waitForVercelPreview(request, { fetch: fetchFn, ...instant }), "https://shop-new.vercel.app");
});

test("fails when every deployment of the commit failed", async () => {
  const { fetchFn } = fakeGitHub({
    "/deployments?": [[{ id: 7, environment: "Preview", creator: VERCEL }]],
    "/deployments/7/statuses": [[{ state: "failure", target_url: "https://vercel.com/acme/shop/abc" }]],
  });
  await assert.rejects(waitForVercelPreview(request, { fetch: fetchFn, ...instant }), /deployment of aaaaaaa failed/);
});

test("with several Vercel projects, asks for preview-project, and then tests that one", async () => {
  const routes = () => ({
    "/deployments?": [
      [
        { id: 1, environment: "Preview – web", creator: VERCEL },
        { id: 2, environment: "Preview – docs", creator: VERCEL },
      ],
    ],
    "/deployments/1/statuses": [[{ state: "success", environment_url: "https://web.vercel.app" }]],
    "/deployments/2/statuses": [[{ state: "success", environment_url: "https://docs.vercel.app" }]],
  });
  await assert.rejects(
    waitForVercelPreview(request, { fetch: fakeGitHub(routes()).fetchFn, ...instant }),
    /2 projects \(web, docs\)\. Name the one to test with preview-project/,
  );
  assert.equal(
    await waitForVercelPreview({ ...request, project: "docs" }, { fetch: fakeGitHub(routes()).fetchFn, ...instant }),
    "https://docs.vercel.app",
  );
});

test("fails fast when Vercel deployed but recorded no GitHub deployment", async () => {
  const { fetchFn } = fakeGitHub({
    "/deployments?": [[]],
    [`/commits/${SHA}/statuses`]: [[{ context: "Vercel – shop", state: "success" }]],
  });
  await assert.rejects(waitForVercelPreview(request, { fetch: fetchFn, ...instant }), /deployment_status Events/);
});

test("times out when no preview arrives", async () => {
  let clock = 0;
  const { fetchFn } = fakeGitHub({ "/deployments?": [[]], [`/commits/${SHA}/statuses`]: [[]] });
  await assert.rejects(
    waitForVercelPreview(request, {
      fetch: fetchFn,
      pollMs: 10_000,
      now: () => clock,
      sleep: async (ms) => {
        clock += ms;
      },
    }),
    /No successful Vercel preview of aaaaaaa after 30s/,
  );
});

test("names the missing permission when GitHub refuses, and a rate limit as that", async () => {
  await assert.rejects(waitForVercelPreview(request, { fetch: fakeGitHub({}, {}, 403).fetchFn, ...instant }), /deployments: read/);
  await assert.rejects(
    waitForVercelPreview(request, { fetch: fakeGitHub({}, { "x-ratelimit-remaining": "0" }, 403).fetchFn, ...instant }),
    /rate limit/,
  );
  // GitHub's secondary rate limit leaves requests remaining and says when to retry.
  await assert.rejects(
    waitForVercelPreview(request, {
      fetch: fakeGitHub({}, { "x-ratelimit-remaining": "4000", "retry-after": "60" }, 403).fetchFn,
      ...instant,
    }),
    /rate limit/,
  );
});

test("a named project waits for its own deployment despite another project's status", async () => {
  let clock = 0;
  const { fetchFn } = fakeGitHub({
    "/deployments?": [[{ id: 2, environment: "Preview – docs", creator: VERCEL }]],
    "/deployments/2/statuses": [[{ state: "success", environment_url: "https://docs.vercel.app" }]],
    [`/commits/${SHA}/statuses`]: [[{ context: "Vercel – docs", state: "success" }]],
  });
  await assert.rejects(
    waitForVercelPreview(
      { ...request, project: "web" },
      { fetch: fetchFn, pollMs: 10_000, now: () => clock, sleep: async (ms) => void (clock += ms) },
    ),
    (error: Error) => {
      assert.doesNotMatch(error.message, /deployment_status Events/);
      assert.match(error.message, /for web after 30s\. This commit has previews of: docs; check preview-project/);
      return true;
    },
  );
});

test("a named project's own status with no deployment means deployment events are off", async () => {
  const { fetchFn } = fakeGitHub({
    "/deployments?": [[]],
    [`/commits/${SHA}/statuses`]: [[{ context: "Vercel – web", state: "success" }]],
  });
  await assert.rejects(
    waitForVercelPreview({ ...request, project: "web" }, { fetch: fetchFn, ...instant }),
    /no GitHub deployment for web.*deployment_status Events/,
  );
});

test("unnamed, a second project's status stops a first project's ready preview", async () => {
  const { fetchFn } = fakeGitHub({
    "/deployments?": [[{ id: 1, environment: "Preview – web", creator: VERCEL }]],
    "/deployments/1/statuses": [[{ state: "success", environment_url: "https://web.vercel.app" }]],
    [`/commits/${SHA}/statuses`]: [
      [
        { context: "Vercel – web", state: "success" },
        { context: "Vercel – docs", state: "pending" },
      ],
    ],
  });
  await assert.rejects(waitForVercelPreview(request, { fetch: fetchFn, ...instant }), /Name the one to test with preview-project/);
});

test("refuses a preview URL that is not https or carries credentials", async () => {
  for (const bad of ["http://shop.vercel.app", "https://user:pw@shop.vercel.app", "javascript:alert(1)"]) {
    const { fetchFn } = fakeGitHub({
      "/deployments?": [[{ id: 7, environment: "Preview", creator: VERCEL }]],
      "/deployments/7/statuses": [[{ state: "success", environment_url: bad }]],
    });
    await assert.rejects(waitForVercelPreview(request, { fetch: fetchFn, ...instant }), /no https URL/);
  }
});

test("keeps workflow commands out of an error built from GitHub's answer", async () => {
  const { fetchFn } = fakeGitHub({
    "/deployments?": [[{ id: 7, environment: "Preview – x\n::error::injected ##[warning]y", creator: VERCEL }]],
    [`/deployments/7/statuses`]: [[{ state: "failure", target_url: "https://vercel.com/a?token=secret" }]],
  });
  await assert.rejects(waitForVercelPreview(request, { fetch: fetchFn, ...instant }), (error: Error) => {
    assert.ok(!error.message.includes("\n"));
    assert.ok(!error.message.includes("##["));
    assert.ok(!error.message.includes("token=secret"));
    return true;
  });
});

test("previewBaseUrl sets nothing outside report mode or over the workflow's BASE_URL", async () => {
  const quiet = () => {};
  assert.equal(await previewBaseUrl("run", prEnv(), "t", instant, quiet), null);
  assert.equal(await previewBaseUrl("report", prEnv({ BASE_URL: "https://mine.example" }), "t", instant, quiet), null);
  assert.equal(await previewBaseUrl("report", prEnv({ INPUT_PREVIEW: "" }), "t", instant, quiet), null);
});

test("previewBaseUrl returns the pull request's preview in report mode", async () => {
  const { fetchFn } = fakeGitHub({
    "/deployments?": [[{ id: 7, environment: "Preview", creator: VERCEL }]],
    "/deployments/7/statuses": [[{ state: "success", environment_url: "https://shop-abc.vercel.app" }]],
  });
  const lines: string[] = [];
  const url = await previewBaseUrl("report", prEnv(), "t", { fetch: fetchFn, ...instant }, (l) => lines.push(l));
  assert.equal(url, "https://shop-abc.vercel.app");
  assert.match(lines.join("\n"), /BASE_URL https:\/\/shop-abc\.vercel\.app \(Vercel preview of aaaaaaa\)/);
});
