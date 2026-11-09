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
 *
 * Vercel records GitHub deployments only with the project's "deployment_status
 * Events" switch on (Settings > Git), which new projects leave off. Vercel's
 * commit status arrives either way, so a status with no deployment fails fast
 * with that fix instead of timing out.
 */

import { readFileSync } from "node:fs";

export type PreviewProvider = "vercel";

export interface PreviewRequest {
  provider: PreviewProvider;
  /** "owner/repo" */
  repository: string;
  /** The pull request's head commit: what Vercel deployed. */
  sha: string;
  token: string;
  timeoutMs: number;
  apiUrl: string;
}

/** What the action reads to decide whether, and where, to wait. */
export function readPreviewRequest(env: NodeJS.ProcessEnv): PreviewRequest | null {
  const provider = env["INPUT_PREVIEW"]?.trim().toLowerCase();
  if (!provider) return null;
  if (provider !== "vercel") throw new Error(`preview: "${provider}" is not supported (supported: vercel)`);
  if (env.GITHUB_EVENT_NAME !== "pull_request" && env.GITHUB_EVENT_NAME !== "pull_request_target") return null;
  const sha = pullRequestHeadSha(env.GITHUB_EVENT_PATH);
  const repository = env.GITHUB_REPOSITORY;
  const token = env["INPUT_GITHUB-TOKEN"]?.trim() || env.GITHUB_TOKEN;
  if (!sha || !repository) throw new Error("preview: vercel needs a pull_request event with a head commit");
  if (!token) throw new Error("preview: vercel needs the github-token input (it defaults to the job's GITHUB_TOKEN)");
  const timeoutS = Number(env["INPUT_PREVIEW-TIMEOUT"]?.trim() || "600");
  if (!Number.isFinite(timeoutS) || timeoutS <= 0) throw new Error("preview-timeout must be a positive number of seconds");
  return {
    provider: "vercel",
    repository,
    sha,
    token,
    timeoutMs: timeoutS * 1000,
    apiUrl: (env.GITHUB_API_URL ?? "https://api.github.com").replace(/\/+$/, ""),
  };
}

function pullRequestHeadSha(eventPath: string | undefined): string | null {
  if (!eventPath) return null;
  try {
    const payload = JSON.parse(readFileSync(eventPath, "utf8")) as {
      pull_request?: { head?: { sha?: unknown } };
    };
    const sha = payload.pull_request?.head?.sha;
    return typeof sha === "string" && /^[0-9a-f]{40}$/.test(sha) ? sha : null;
  } catch {
    return null;
  }
}

interface Deployment {
  id: number;
  environment: string;
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

const isVercelPreview = (environment: string) =>
  environment === "Preview" || environment.startsWith("Preview – ");

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
    if (res.status === 403 || res.status === 404) {
      throw new Error(
        `GitHub refused ${path} (${res.status}). Give the job \`deployments: read\` and \`statuses: read\` in its permissions.`,
      );
    }
    if (!res.ok) throw new Error(`GitHub ${path}: ${res.status} ${(await res.text()).slice(0, 300)}`);
    return (await res.json()) as T;
  };

  const deadline = now() + request.timeoutMs;
  for (;;) {
    const deployments = (await github<Deployment[]>(`/deployments?sha=${request.sha}&per_page=100`)).filter((d) =>
      isVercelPreview(d.environment),
    );
    for (const deployment of deployments) {
      const [latest] = await github<DeploymentStatus[]>(`/deployments/${deployment.id}/statuses?per_page=1`);
      if (!latest) continue;
      if (latest.state === "success") {
        const url = latest.environment_url || latest.target_url;
        if (url) return url;
      }
      if (latest.state === "failure" || latest.state === "error") {
        throw new Error(`Vercel's ${deployment.environment} deployment of ${short} failed: ${latest.target_url ?? ""}`);
      }
    }
    if (deployments.length === 0) {
      const statuses = await github<CommitStatus[]>(`/commits/${request.sha}/statuses?per_page=100`);
      if (statuses.some((s) => s.context === "Vercel" && s.state === "success")) {
        throw new Error(
          `Vercel deployed ${short} but recorded no GitHub deployment, so there is no preview URL to test. ` +
            'Turn on "deployment_status Events" in the Vercel project (Settings > Git) and push again.',
        );
      }
    }
    if (now() >= deadline) {
      throw new Error(`No successful Vercel preview of ${short} after ${Math.round(request.timeoutMs / 1000)}s`);
    }
    await sleep(pollMs);
  }
}
