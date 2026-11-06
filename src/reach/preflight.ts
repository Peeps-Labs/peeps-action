/**
 * Whether this job should scan at all: only a project with targeted runs switched on
 * pays for it. One request, on a pull request job on GitHub only. An older server, an
 * error, a timeout or anything but `scan: true` means no scan, and today's run.
 */
import type { RunnerEnv } from "../env";
import type { PeepsClient } from "../peeps";

export const PREFLIGHT_PATH = "/api/v1/ci/targeted-runs";
export const PREFLIGHT_TIMEOUT_MS = 3000;

export async function reachWanted(env: Pick<RunnerEnv, "platform" | "eventName">, peeps: Pick<PeepsClient, "get">): Promise<boolean> {
  if (env.platform !== "github" || env.eventName !== "pull_request") return false;
  let timer: NodeJS.Timeout | undefined;
  try {
    const answer = await Promise.race([
      peeps.get<{ scan?: unknown }>(PREFLIGHT_PATH, AbortSignal.timeout(PREFLIGHT_TIMEOUT_MS)),
      // The token comes first, and its retries aren't under that signal.
      new Promise<null>((resolve) => {
        timer = setTimeout(() => resolve(null), PREFLIGHT_TIMEOUT_MS);
      }),
    ]);
    return answer?.scan === true;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}
