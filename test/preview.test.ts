import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { readPreviewRequest, waitForVercelPreview, type PreviewRequest } from "../src/preview";

const SHA = "a".repeat(40);

function eventFile(payload: unknown): string {
  const dir = mkdtempSync(path.join(tmpdir(), "peeps-preview-"));
  const file = path.join(dir, "event.json");
  writeFileSync(file, JSON.stringify(payload));
  return file;
}

const prEnv = (extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv => ({
  INPUT_PREVIEW: "vercel",
  "INPUT_GITHUB-TOKEN": "ghs_token",
  GITHUB_EVENT_NAME: "pull_request",
  GITHUB_REPOSITORY: "acme/shop",
  GITHUB_EVENT_PATH: eventFile({ pull_request: { head: { sha: SHA } } }),
  ...extra,
});

test("readPreviewRequest is off without the input", () => {
  assert.equal(readPreviewRequest({ GITHUB_EVENT_NAME: "pull_request" }), null);
});

test("readPreviewRequest waits only on a pull request", () => {
  assert.equal(readPreviewRequest(prEnv({ GITHUB_EVENT_NAME: "push" })), null);
  assert.equal(readPreviewRequest(prEnv({ GITHUB_EVENT_NAME: "workflow_dispatch" })), null);
});

test("readPreviewRequest reads the pull request's head commit, not the merge commit", () => {
  const request = readPreviewRequest(prEnv({ GITHUB_SHA: "b".repeat(40) }));
  assert.equal(request?.sha, SHA);
  assert.equal(request?.repository, "acme/shop");
  assert.equal(request?.timeoutMs, 600_000);
  assert.equal(request?.apiUrl, "https://api.github.com");
});

test("readPreviewRequest refuses an unknown provider and a bad timeout", () => {
  assert.throws(() => readPreviewRequest(prEnv({ INPUT_PREVIEW: "netlify" })), /not supported/);
  assert.throws(() => readPreviewRequest(prEnv({ "INPUT_PREVIEW-TIMEOUT": "soon" })), /positive number/);
});

test("readPreviewRequest needs a token and a head commit", () => {
  assert.throws(
    () => readPreviewRequest(prEnv({ "INPUT_GITHUB-TOKEN": "", GITHUB_TOKEN: undefined })),
    /github-token/,
  );
  assert.throws(() => readPreviewRequest(prEnv({ GITHUB_EVENT_PATH: eventFile({}) })), /head commit/);
});

const request: PreviewRequest = {
  provider: "vercel",
  repository: "acme/shop",
  sha: SHA,
  token: "ghs_token",
  timeoutMs: 30_000,
  apiUrl: "https://api.github.com",
};

/** A fake GitHub answering by path; each answer is a list consumed per call. */
function fakeGitHub(routes: Record<string, unknown[]>) {
  const calls: string[] = [];
  const fetchFn = (async (input: string | URL) => {
    const url = new URL(String(input));
    const key = url.pathname.replace("/repos/acme/shop", "") + url.search;
    calls.push(key);
    const route = Object.keys(routes).find((k) => key.startsWith(k));
    if (!route) return new Response("not found", { status: 404 });
    const answers = routes[route]!;
    const body = answers.length > 1 ? answers.shift() : answers[0];
    return new Response(JSON.stringify(body), { status: 200 });
  }) as typeof fetch;
  return { fetchFn, calls };
}

const instant = { sleep: async () => {}, pollMs: 0 };

test("returns the preview URL once Vercel's deployment succeeds", async () => {
  const { fetchFn } = fakeGitHub({
    "/deployments?": [[{ id: 7, environment: "Preview – shop" }]],
    "/deployments/7/statuses": [
      [{ state: "in_progress" }],
      [{ state: "success", environment_url: "https://shop-git-x-acme.vercel.app" }],
    ],
  });
  const url = await waitForVercelPreview(request, { fetch: fetchFn, ...instant });
  assert.equal(url, "https://shop-git-x-acme.vercel.app");
});

test("ignores production and other environments", async () => {
  const { fetchFn } = fakeGitHub({
    "/deployments?": [
      [
        { id: 1, environment: "Production – shop" },
        { id: 2, environment: "Preview" },
      ],
    ],
    "/deployments/1/statuses": [[{ state: "success", environment_url: "https://prod.example" }]],
    "/deployments/2/statuses": [[{ state: "success", environment_url: "https://preview.example" }]],
  });
  assert.equal(await waitForVercelPreview(request, { fetch: fetchFn, ...instant }), "https://preview.example");
});

test("fails fast when Vercel deployed but recorded no GitHub deployment", async () => {
  const { fetchFn } = fakeGitHub({
    "/deployments?": [[]],
    [`/commits/${SHA}/statuses`]: [[{ context: "Vercel", state: "success" }]],
  });
  await assert.rejects(waitForVercelPreview(request, { fetch: fetchFn, ...instant }), /deployment_status Events/);
});

test("says when the preview deployment failed", async () => {
  const { fetchFn } = fakeGitHub({
    "/deployments?": [[{ id: 7, environment: "Preview" }]],
    "/deployments/7/statuses": [[{ state: "failure", target_url: "https://vercel.com/acme/shop/abc" }]],
  });
  await assert.rejects(waitForVercelPreview(request, { fetch: fetchFn, ...instant }), /deployment of aaaaaaa failed/);
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

test("names the missing permission when GitHub refuses", async () => {
  const { fetchFn } = fakeGitHub({});
  await assert.rejects(waitForVercelPreview(request, { fetch: fetchFn, ...instant }), /deployments: read/);
});
