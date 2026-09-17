/**
 * Everything the action learns from its environment: action inputs (GitHub
 * passes `with:` values as `INPUT_<NAME>`), the GitHub Actions context, and the
 * OIDC request endpoint a job with `id-token: write` gets.
 */

import { readFileSync } from "node:fs";
import path from "node:path";

export interface RunnerEnv {
  mode: string;
  sessionId: string | null;
  configPath: string | null;
  peepsUrl: string;
  /** Absolute: resolved against the workspace, never left relative. */
  workingDirectory: string;
  /** "owner/repo" */
  repository: string | null;
  sha: string | null;
  ref: string | null;
  eventName: string | null;
  /** The repository's real default branch, from the event payload. */
  defaultBranch: string | null;
  runId: string | null;
  workspace: string;
  oidc: { requestUrl: string; requestToken: string } | null;
}

/**
 * The repository's default branch, read from the webhook payload GitHub writes
 * to `GITHUB_EVENT_PATH`.
 *
 * There is no environment variable for this, and guessing `main` or `master` is
 * wrong for every repository that uses anything else. Returns null when the
 * payload is absent or unreadable, so callers keep a fallback.
 */
export function readDefaultBranch(env: NodeJS.ProcessEnv): string | null {
  const file = env.GITHUB_EVENT_PATH;
  if (!file) return null;
  try {
    const payload = JSON.parse(readFileSync(file, "utf8")) as {
      repository?: { default_branch?: unknown };
    };
    const branch = payload.repository?.default_branch;
    return typeof branch === "string" && branch !== "" ? branch : null;
  } catch {
    return null;
  }
}

/**
 * GitHub passes `with:` inputs as `INPUT_<NAME>`: uppercased, spaces become
 * underscores, hyphens are KEPT (`session-id` → `INPUT_SESSION-ID`).
 *
 * Reads the passed environment rather than `process.env` directly, so that
 * `readRunnerEnv(fakeEnv)` really is driven by `fakeEnv`. It used to read
 * `process.env` here, which made the parameter a lie for every input and would
 * have quietly misled any test written against it.
 */
function input(env: NodeJS.ProcessEnv, name: string): string | null {
  const value = env[`INPUT_${name.toUpperCase().replace(/ /g, "_")}`];
  return value && value.trim() !== "" ? value.trim() : null;
}

/**
 * Where results, spec sources and the HTML report get sent, so it must not be
 * silently downgraded to plaintext or pointed at an arbitrary host by a stray
 * environment variable. Loopback over http is allowed for Peeps' own local
 * development; everything else must be https.
 */
export function resolvePeepsUrl(raw: string): string {
  const trimmed = raw.replace(/\/+$/, "");
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    throw new Error(`PEEPS_API_URL is not a valid URL: ${trimmed}`);
  }
  const loopback =
    url.hostname === "localhost" ||
    url.hostname === "127.0.0.1" ||
    url.hostname === "[::1]";
  if (url.protocol !== "https:" && !loopback) {
    throw new Error(
      `PEEPS_API_URL must use https (got ${url.protocol.replace(":", "")}): ${trimmed}`,
    );
  }
  return trimmed;
}

export function readRunnerEnv(env: NodeJS.ProcessEnv = process.env): RunnerEnv {
  const requestUrl = env.ACTIONS_ID_TOKEN_REQUEST_URL;
  const requestToken = env.ACTIONS_ID_TOKEN_REQUEST_TOKEN;
  const workspace = env.GITHUB_WORKSPACE ?? process.cwd();
  // Resolved against the workspace, not inherited as-is: a repo-relative value
  // like `tools/e2e` is what the Peeps UI emits and what anyone would write by
  // hand, and leaving it relative only works while the runner's cwd happens to
  // be the workspace. When it isn't, Playwright is handed paths outside its
  // rootDir, runs nothing, and the job still goes green.
  const workingDirectory = input(env, "working-directory");
  return {
    mode: input(env, "mode") ?? env.PEEPS_MODE ?? "ci",
    sessionId: input(env, "session-id") ?? env.PEEPS_SESSION_ID ?? null,
    configPath: input(env, "config") ?? env.PEEPS_PLAYWRIGHT_CONFIG ?? null,
    peepsUrl: resolvePeepsUrl(env.PEEPS_API_URL ?? "https://app.peepsai.com"),
    workingDirectory: workingDirectory
      ? path.resolve(workspace, workingDirectory)
      : workspace,
    repository: env.GITHUB_REPOSITORY ?? null,
    sha: env.GITHUB_SHA ?? null,
    ref: env.GITHUB_REF ?? null,
    eventName: env.GITHUB_EVENT_NAME ?? null,
    defaultBranch: readDefaultBranch(env),
    runId: env.GITHUB_RUN_ID ?? null,
    workspace,
    oidc: requestUrl && requestToken ? { requestUrl, requestToken } : null,
  };
}
