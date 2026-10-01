/**
 * Everything the action learns from its environment: action inputs (GitHub
 * passes `with:` values as `INPUT_<NAME>`), the CI context, and how the job
 * proves who it is to Peeps.
 *
 * Two CI systems, one shape. On GitHub Actions the context is `GITHUB_*` and
 * the identity is an OIDC token requested from the endpoint a job with
 * `id-token: write` gets. On GitLab CI/CD (`GITLAB_CI=true`) the context is
 * `CI_*`, the inputs are the `PEEPS_*` variables (GitLab variable names cannot
 * hold a hyphen, and Peeps starts pipelines with `PEEPS_MODE` and
 * `PEEPS_SESSION_ID`), and the identity is the ID token the job's `id_tokens:`
 * block puts in `PEEPS_ID_TOKEN`. Nothing after `readRunnerEnv` knows which.
 */

import { readFileSync } from "node:fs";
import path from "node:path";

export type CiPlatform = "github" | "gitlab";

export interface RunnerEnv {
  platform: CiPlatform;
  mode: string;
  sessionId: string | null;
  configPath: string | null;
  /** `playwright`, `pytest` or `auto`; null when not given (auto). */
  framework: string | null;
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
  /** The run's page on the CI system: a workflow run, or a GitLab pipeline. */
  runUrl: string | null;
  /** The git host's origin, e.g. https://github.com or https://gitlab.example.com. */
  serverUrl: string;
  workspace: string;
  /** GitHub: where to request an OIDC token. */
  oidc: { requestUrl: string; requestToken: string } | null;
  /** GitLab: the ID token the job was issued for Peeps' audience. */
  idToken: string | null;
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

/** GitLab's pipeline source as the GitHub event name Peeps reasons in. */
export function eventNameForPipelineSource(source: string | undefined): string | null {
  switch (source) {
    case undefined:
    case "":
      return null;
    case "push":
      return "push";
    case "merge_request_event":
      return "pull_request";
    case "schedule":
      return "schedule";
    case "api":
    case "trigger":
    case "web":
    case "pipeline":
    case "parent_pipeline":
      return "workflow_dispatch";
    default:
      return source;
  }
}

/** A non-empty variable, trimmed; null otherwise. */
function variable(env: NodeJS.ProcessEnv, name: string): string | null {
  const value = env[name];
  return value && value.trim() !== "" ? value.trim() : null;
}

/** The runner environment inside a GitLab CI/CD job. */
export function readGitLabRunnerEnv(env: NodeJS.ProcessEnv): RunnerEnv {
  const workspace = env.CI_PROJECT_DIR ?? process.cwd();
  const workingDirectory = variable(env, "PEEPS_WORKING_DIRECTORY");
  // A merge request pipeline has no CI_COMMIT_BRANCH; its ref name is the
  // source branch. A tag pipeline has neither and is named by its tag.
  const branch = env.CI_COMMIT_BRANCH ?? env.CI_MERGE_REQUEST_SOURCE_BRANCH_NAME;
  const ref = branch
    ? `refs/heads/${branch}`
    : env.CI_COMMIT_TAG
      ? `refs/tags/${env.CI_COMMIT_TAG}`
      : null;
  return {
    platform: "gitlab",
    mode: variable(env, "PEEPS_MODE") ?? "ci",
    sessionId: variable(env, "PEEPS_SESSION_ID"),
    configPath: variable(env, "PEEPS_PLAYWRIGHT_CONFIG"),
    framework: variable(env, "PEEPS_FRAMEWORK"),
    peepsUrl: resolvePeepsUrl(env.PEEPS_API_URL ?? "https://app.peepsai.com"),
    workingDirectory: workingDirectory
      ? path.resolve(workspace, workingDirectory)
      : workspace,
    repository: env.CI_PROJECT_PATH ?? null,
    sha: env.CI_COMMIT_SHA ?? null,
    ref,
    eventName: eventNameForPipelineSource(env.CI_PIPELINE_SOURCE),
    defaultBranch: variable(env, "CI_DEFAULT_BRANCH"),
    runId: env.CI_PIPELINE_ID ?? null,
    runUrl: env.CI_PIPELINE_URL ?? null,
    serverUrl: (env.CI_SERVER_URL ?? "https://gitlab.com").replace(/\/+$/, ""),
    workspace,
    oidc: null,
    idToken: variable(env, "PEEPS_ID_TOKEN"),
  };
}

export function readRunnerEnv(env: NodeJS.ProcessEnv = process.env): RunnerEnv {
  if (env.GITLAB_CI === "true") return readGitLabRunnerEnv(env);
  const requestUrl = env.ACTIONS_ID_TOKEN_REQUEST_URL;
  const requestToken = env.ACTIONS_ID_TOKEN_REQUEST_TOKEN;
  const workspace = env.GITHUB_WORKSPACE ?? process.cwd();
  // Resolved against the workspace, not inherited as-is: a repo-relative value
  // like `tools/e2e` is what the Peeps UI emits and what anyone would write by
  // hand, and leaving it relative only works while the runner's cwd happens to
  // be the workspace. When it isn't, Playwright is handed paths outside its
  // rootDir, runs nothing, and the job still goes green.
  const workingDirectory =
    input(env, "working-directory") ?? variable(env, "PEEPS_WORKING_DIRECTORY");
  const serverUrl = (env.GITHUB_SERVER_URL ?? "https://github.com").replace(/\/+$/, "");
  const repository = env.GITHUB_REPOSITORY ?? null;
  const runId = env.GITHUB_RUN_ID ?? null;
  return {
    platform: "github",
    mode: input(env, "mode") ?? env.PEEPS_MODE ?? "ci",
    sessionId: input(env, "session-id") ?? env.PEEPS_SESSION_ID ?? null,
    configPath: input(env, "config") ?? env.PEEPS_PLAYWRIGHT_CONFIG ?? null,
    framework: input(env, "framework") ?? env.PEEPS_FRAMEWORK ?? null,
    peepsUrl: resolvePeepsUrl(env.PEEPS_API_URL ?? "https://app.peepsai.com"),
    workingDirectory: workingDirectory
      ? path.resolve(workspace, workingDirectory)
      : workspace,
    repository,
    sha: env.GITHUB_SHA ?? null,
    ref: env.GITHUB_REF ?? null,
    eventName: env.GITHUB_EVENT_NAME ?? null,
    defaultBranch: readDefaultBranch(env),
    runId,
    runUrl: repository && runId ? `${serverUrl}/${repository}/actions/runs/${runId}` : null,
    serverUrl,
    workspace,
    oidc: requestUrl && requestToken ? { requestUrl, requestToken } : null,
    idToken: null,
  };
}
