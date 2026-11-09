/**
 * `preview: vercel`: on a pull request, test the pull request's own Vercel
 * preview. Vercel's GitHub integration records each deployment as a GitHub
 * deployment (environment "Preview" or "Preview – <project>") and marks it
 * `success` with the deployment's own URL once it is ready. The action waits
 * for the one of the pull request's head commit and sets BASE_URL to it, so
 * the workflow needs no wait step of its own.
 *
 * A job started by `pull_request` is what Peeps counts as the pull request's
 * tests; a job started by Vercel's `deployment_status` event is not. That is
 * why the action waits here instead of being triggered by the deployment.
 * `pull_request_target` is refused: it runs with the base repository's secrets
 * and OIDC, and a fork's preview is the fork's code.
 *
 * Vercel records GitHub deployments only with the project's "deployment_status
 * Events" switch on (Settings > Git), which new projects leave off. Vercel's
 * commit status arrives either way, so a status with no deployment fails fast
 * with that fix instead of timing out.
 */

import { readFileSync } from "node:fs";
import { nameForLog, urlForLog } from "./environment";

export type PreviewProvider = "vercel";

/** The input GitHub passes the token in. Read once, then removed from the environment. */
export const GITHUB_TOKEN_INPUT = "INPUT_GITHUB-TOKEN";

export interface PreviewRequest {
  provider: PreviewProvider;
  /** "owner/repo" */
  repository: string;
  /** The pull request's head commit: what Vercel deployed. */
  sha: string;
  token: string;
  timeoutMs: number;
  apiUrl: string;
  /** `preview-project`: the `<name>` of `Preview – <name>`, for a repository with several Vercel projects. */
  project: string | null;
}

/**
 * The `github-token` input, removed from `env` so test processes, the
 * inventory and agent tools don't inherit it: every child copies the action's
 * environment, and the agent's output redactor leaves `INPUT_` variables
 * alone. Call it before anything spawns. Code running as the same user can
 * still read it from the action process's initial environment
 * (`/proc/<pid>/environ`), as it can the runner's own tokens.
 */
export function takeGithubToken(env: NodeJS.ProcessEnv): string | null {
  const token = env[GITHUB_TOKEN_INPUT]?.trim() || null;
  delete env[GITHUB_TOKEN_INPUT];
  return token;
}

/** What the action reads to decide whether, and where, to wait. */
export function readPreviewRequest(env: NodeJS.ProcessEnv, githubToken: string | null): PreviewRequest | null {
  const provider = env["INPUT_PREVIEW"]?.trim().toLowerCase();
  if (!provider) return null;
  if (provider !== "vercel") throw new Error(`preview: "${nameForLog(provider)}" is not supported (supported: vercel)`);
  if (env.GITHUB_EVENT_NAME === "pull_request_target") {
    throw new Error(
      "preview: vercel does not run on pull_request_target: that event has the base repository's secrets, and a fork's preview runs the fork's code. Use pull_request.",
    );
  }
  if (env.GITHUB_EVENT_NAME !== "pull_request") return null;
  const repository = env.GITHUB_REPOSITORY;
  const head = pullRequestHead(env.GITHUB_EVENT_PATH);
  if (!head || !repository) throw new Error("preview: vercel needs a pull_request event with a head commit");
  if (head.repository && head.repository.toLowerCase() !== repository.toLowerCase()) {
    throw new Error(
      `preview: vercel tests previews of this repository's own branches; this pull request comes from ${nameForLog(head.repository)}.`,
    );
  }
  if (!githubToken) throw new Error("preview: vercel needs the github-token input (it defaults to the job's GITHUB_TOKEN)");
  const timeoutS = Number(env["INPUT_PREVIEW-TIMEOUT"]?.trim() || "600");
  if (!Number.isFinite(timeoutS) || timeoutS <= 0) throw new Error("preview-timeout must be a positive number of seconds");
  return {
    provider: "vercel",
    repository,
    sha: head.sha,
    token: githubToken,
    timeoutMs: timeoutS * 1000,
    apiUrl: (env.GITHUB_API_URL ?? "https://api.github.com").replace(/\/+$/, ""),
    project: env["INPUT_PREVIEW-PROJECT"]?.trim() || null,
  };
}

function pullRequestHead(eventPath: string | undefined): { sha: string; repository: string | null } | null {
  if (!eventPath) return null;
  try {
    const payload = JSON.parse(readFileSync(eventPath, "utf8")) as {
      pull_request?: { head?: { sha?: unknown; repo?: { full_name?: unknown } | null } };
    };
    const head = payload.pull_request?.head;
    const sha = head?.sha;
    if (typeof sha !== "string" || !/^[0-9a-f]{40}$/.test(sha)) return null;
    const repository = head?.repo?.full_name;
    return { sha, repository: typeof repository === "string" ? repository : null };
  } catch {
    return null;
  }
}

interface Deployment {
  id: number;
  environment: string;
  creator?: { login?: string } | null;
}
interface DeploymentStatus {
  state: string;
  environment_url?: string | null;
  target_url?: string | null;
}
interface CommitStatus {
  context: string;
  state: string;
}

/** Vercel's GitHub App records its deployments; anyone else's are not Vercel's preview. */
const VERCEL_BOT = "vercel[bot]";
const PREVIEW_PREFIX = "Preview – ";

/**
 * Whether a commit status is Vercel's, and for `project` when one is named:
 * Vercel posts "Vercel" for a repository with one project and
 * "Vercel – <project>" for each project of a monorepo.
 */
function isVercelContextFor(context: string, project: string | null): boolean {
  if (project === null) return context === "Vercel" || context.startsWith("Vercel – ");
  return context === `Vercel – ${project}`;
}

/** The Vercel project a preview environment names, or "" for the plain "Preview". */
function previewProject(d: Deployment): string | null {
  if (d.creator?.login !== VERCEL_BOT) return null;
  if (d.environment === "Preview") return "";
  return d.environment.startsWith(PREVIEW_PREFIX) ? d.environment.slice(PREVIEW_PREFIX.length) : null;
}

/**
 * The deployment's URL, when it is one a browser should be pointed at: https
 * and no credentials. Anything else is refused rather than set as BASE_URL.
 */
function previewUrl(raw: string | null | undefined): string | null {
  if (!raw || raw.includes("@")) return null;
  try {
    return new URL(raw).protocol === "https:" ? raw : null;
  } catch {
    return null;
  }
}

/** A deployment's verdict from its statuses, newest first. */
type Verdict = { kind: "ready"; url: string } | { kind: "pending" } | { kind: "failed"; detail: string };

function verdictOf(statuses: DeploymentStatus[]): Verdict {
  const latest = statuses[0];
  if (!latest) return { kind: "pending" };
  // GitHub marks an older successful deployment of the same environment
  // `inactive` when a newer one succeeds (another pull request's preview, a
  // redeploy). Its URL still serves this commit, so an earlier success counts.
  const success =
    latest.state === "success" || latest.state === "inactive"
      ? statuses.find((s) => s.state === "success")
      : undefined;
  if (success) {
    const raw = success.environment_url || success.target_url;
    const url = previewUrl(raw);
    return url
      ? { kind: "ready", url }
      : { kind: "failed", detail: `has no https URL to test: ${urlForLog(raw ?? "")}` };
  }
  if (latest.state === "failure" || latest.state === "error") {
    return { kind: "failed", detail: `failed: ${urlForLog(latest.target_url ?? "")}` };
  }
  return { kind: "pending" };
}

export interface WaitDeps {
  fetch?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  pollMs?: number;
}

/** Waits for the preview of `request.sha` and returns its URL. */
export async function waitForVercelPreview(request: PreviewRequest, deps: WaitDeps = {}): Promise<string> {
  const doFetch = deps.fetch ?? fetch;
  const sleep = deps.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  const now = deps.now ?? Date.now;
  const pollMs = deps.pollMs ?? 10_000;
  const short = request.sha.slice(0, 7);

  const github = async <T>(path: string): Promise<T> => {
    const res = await doFetch(`${request.apiUrl}/repos/${request.repository}${path}`, {
      headers: {
        authorization: `Bearer ${request.token}`,
        accept: "application/vnd.github+json",
        "x-github-api-version": "2022-11-28",
      },
    });
    if (
      (res.status === 403 || res.status === 429) &&
      (res.headers.get("x-ratelimit-remaining") === "0" || res.headers.has("retry-after"))
    ) {
      throw new Error(`GitHub's API rate limit ran out while waiting for the Vercel preview of ${short}`);
    }
    if (res.status === 403 || res.status === 404) {
      throw new Error(
        `GitHub refused ${path} (${res.status}). Give the job \`deployments: read\` and \`statuses: read\` in its permissions.`,
      );
    }
    if (!res.ok) throw new Error(`GitHub ${path}: ${res.status} ${nameForLog((await res.text()).slice(0, 300))}`);
    return (await res.json()) as T;
  };

  const deadline = now() + request.timeoutMs;
  for (;;) {
    const all = await github<Deployment[]>(`/deployments?sha=${request.sha}&per_page=100`);
    const previews = all
      .map((d) => ({ d, project: previewProject(d) }))
      .filter((p): p is { d: Deployment; project: string } => p.project !== null);
    const projects = [...new Set(previews.map((p) => p.project))];
    if (request.project === null && projects.length > 1) {
      throw new Error(
        `This commit has Vercel previews of ${projects.length} projects (${projects.map((p) => nameForLog(p) || "Preview").join(", ")}). Name the one to test with preview-project.`,
      );
    }
    // Newest first: a redeploy after a failure is the one that counts.
    const candidates = previews
      .filter((p) => request.project === null || p.project === request.project)
      .sort((a, b) => b.d.id - a.d.id);

    const failures: string[] = [];
    for (const { d } of candidates) {
      const verdict = verdictOf(await github<DeploymentStatus[]>(`/deployments/${d.id}/statuses?per_page=20`));
      if (verdict.kind === "ready") {
        // Unnamed, one project's preview can be ready before another
        // project's deployment appears: Vercel's commit statuses, one per
        // project, say whether there is more than one.
        if (request.project === null) {
          const statuses = await github<CommitStatus[]>(`/commits/${request.sha}/statuses?per_page=100`);
          const contexts = [...new Set(statuses.map((s) => s.context).filter((c) => isVercelContextFor(c, null)))];
          if (contexts.length > 1) {
            throw new Error(
              `This commit has Vercel previews of ${contexts.length} projects (${contexts.map((c) => nameForLog(c)).join(", ")}). Name the one to test with preview-project.`,
            );
          }
        }
        return verdict.url;
      }
      if (verdict.kind === "pending") {
        failures.length = 0;
        break;
      }
      failures.push(`${nameForLog(d.environment)} deployment of ${short} ${verdict.detail}`);
    }
    // Fail only when every deployment of this commit has failed: one still
    // building may yet succeed.
    if (candidates.length > 0 && failures.length === candidates.length) {
      throw new Error(`Vercel's ${failures[0]}`);
    }
    if (candidates.length === 0) {
      const statuses = await github<CommitStatus[]>(`/commits/${request.sha}/statuses?per_page=100`);
      if (statuses.some((s) => s.state === "success" && isVercelContextFor(s.context, request.project))) {
        throw new Error(
          `Vercel deployed ${short} but recorded no GitHub deployment${request.project ? ` for ${nameForLog(request.project)}` : ""}, so there is no preview URL to test. ` +
            'Turn on "deployment_status Events" in the Vercel project (Settings > Git) and push again.',
        );
      }
    }
    if (now() >= deadline) {
      const others = request.project && projects.length > 0
        ? ` This commit has previews of: ${projects.map((p) => nameForLog(p) || "Preview").join(", ")}; check preview-project.`
        : "";
      throw new Error(`No successful Vercel preview of ${short}${request.project ? ` for ${nameForLog(request.project)}` : ""} after ${Math.round(request.timeoutMs / 1000)}s.${others}`);
    }
    await sleep(pollMs);
  }
}

/**
 * BASE_URL for this job from `preview`, or null to leave it alone: only in
 * report mode, and never over a BASE_URL the workflow set itself (as a Peeps
 * environment's never wins over it either, environment.ts).
 */
export async function previewBaseUrl(
  mode: string,
  env: NodeJS.ProcessEnv,
  githubToken: string | null,
  deps: WaitDeps = {},
  log: (line: string) => void = console.log,
): Promise<string | null> {
  if (mode !== "report" || env.BASE_URL) return null;
  const request = readPreviewRequest(env, githubToken);
  if (!request) return null;
  log(`[peeps] waiting for the Vercel preview of ${request.sha.slice(0, 7)}`);
  const url = await waitForVercelPreview(request, deps);
  log(`[peeps] BASE_URL ${urlForLog(url)} (Vercel preview of ${request.sha.slice(0, 7)})`);
  return url;
}
