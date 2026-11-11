/**
 * The targeted runs handshake, one request on GitHub, on pushes and pull requests alike.
 * Only a server that answers protocol 2 or later hears that this job can narrow, gets a
 * reach, and gets footprints recorded: an older server, an error, a timeout or any other
 * answer means none of them, and a full run. A scan is for a pull request, and only one
 * whose project has targeted runs switched on pays for it (`scan: true`).
 */
import type { RunnerEnv } from "../env";
import type { PeepsClient } from "../peeps";

export const PREFLIGHT_PATH = "/api/v1/ci/targeted-runs";
export const PREFLIGHT_TIMEOUT_MS = 3000;
/** The protocol this action speaks, sent on the announce whatever later one the server answered. */
export const TARGETED_RUNS_PROTOCOL = 2;

export interface Negotiated {
  /** The server speaks this action's protocol: it may hear `canNarrow`, and footprints are recorded when it asks. */
  protocol: boolean;
  /** Work out what this pull request reaches. */
  scan: boolean;
}

const NONE: Negotiated = { protocol: false, scan: false };

/** What a preflight's answer allows. */
export function readPreflight(answer: unknown): Negotiated {
  if (typeof answer !== "object" || answer === null) return NONE;
  const { scan, protocolVersion } = answer as { scan?: unknown; protocolVersion?: unknown };
  if (typeof protocolVersion !== "number" || !Number.isSafeInteger(protocolVersion) || protocolVersion < TARGETED_RUNS_PROTOCOL) return NONE;
  return { protocol: true, scan: scan === true };
}

/** What the announce says of the handshake: nothing at all without it, as the published action sends. */
export function announceFieldsOf(negotiated: Negotiated): { canNarrow?: true; protocolVersion?: number } {
  return negotiated.protocol ? { canNarrow: true, protocolVersion: TARGETED_RUNS_PROTOCOL } : {};
}

export async function negotiateTargetedRuns(env: Pick<RunnerEnv, "platform" | "eventName">, peeps: Pick<PeepsClient, "get">): Promise<Negotiated> {
  if (env.platform !== "github") return NONE;
  let timer: NodeJS.Timeout | undefined;
  try {
    const answer = await Promise.race([
      peeps.get<unknown>(PREFLIGHT_PATH, AbortSignal.timeout(PREFLIGHT_TIMEOUT_MS)),
      // The token comes first, and its retries aren't under that signal.
      new Promise<null>((resolve) => {
        timer = setTimeout(() => resolve(null), PREFLIGHT_TIMEOUT_MS);
      }),
    ]);
    const negotiated = readPreflight(answer);
    return { ...negotiated, scan: negotiated.scan && env.eventName === "pull_request" };
  } catch {
    return NONE;
  } finally {
    clearTimeout(timer);
  }
}
