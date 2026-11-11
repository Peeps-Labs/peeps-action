/**
 * The targeted runs handshake, one request on GitHub, on pushes and pull requests alike.
 * Only a server that answers protocol 2 or later hears that this job can narrow, gets a
 * reach, and gets footprints recorded: an older server, an error, a timeout or any other
 * answer means none of them, and a full run. A scan is for a pull request, and only one
 * whose project has targeted runs switched on pays for it (`scan: true`).
 */
import type { RunnerEnv } from "../env";
import { parseProjectKey } from "../evidence/hash";
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
  /**
   * Record what this job's tests run (PQA-3201 PR 2): only for the projects Peeps asks
   * for, each with its own key. Keys stay in this process's memory; the whole CI job is
   * trusted with them, since Playwright's children inherit this process's environment.
   */
  collect?: Collect[];
}

export interface Collect {
  projectId: string;
  coverage: boolean;
  fingerprint: boolean;
  key: Buffer;
  keyVersion: string;
}

const NONE: Negotiated = { protocol: false, scan: false };

/** What a preflight's answer allows. */
export function readPreflight(answer: unknown): Negotiated {
  if (typeof answer !== "object" || answer === null) return NONE;
  const { scan, protocolVersion } = answer as { scan?: unknown; protocolVersion?: unknown };
  if (typeof protocolVersion !== "number" || !Number.isSafeInteger(protocolVersion) || protocolVersion < TARGETED_RUNS_PROTOCOL) return NONE;
  const { projects } = answer as { projects?: unknown };
  const collect = (Array.isArray(projects) ? projects : []).map(readCollect).filter((c): c is Collect => c !== null);
  return { protocol: true, scan: scan === true, ...(collect.length > 0 ? { collect } : {}) };
}

/** A project's `collect` (contract §1): its key is 64 lowercase hex characters. */
function readCollect(project: unknown): Collect | null {
  if (typeof project !== "object" || project === null) return null;
  const { projectId, collect } = project as { projectId?: unknown; collect?: unknown };
  if (typeof projectId !== "string" || projectId === "" || typeof collect !== "object" || collect === null) return null;
  const { coverage, fingerprint, key, keyVersion } = collect as Record<string, unknown>;
  const parsed = typeof key === "string" && /^[0-9a-f]{64}$/.test(key) ? parseProjectKey(key) : null;
  if (!parsed || typeof keyVersion !== "string" || !/^V[1-9][0-9]*$/.test(keyVersion)) return null;
  if (coverage !== true && fingerprint !== true) return null;
  return { projectId, coverage: coverage === true, fingerprint: fingerprint === true, key: parsed, keyVersion };
}

/** GitHub hides a masked value wherever the job's log would print it. */
const addMask = (line: string) => console.log(line);

/** What the announce says of the handshake: nothing at all without it, as the published action sends. */
export function announceFieldsOf(negotiated: Negotiated): { canNarrow?: true; protocolVersion?: number } {
  return negotiated.protocol ? { canNarrow: true, protocolVersion: TARGETED_RUNS_PROTOCOL } : {};
}

export async function negotiateTargetedRuns(
  env: Pick<RunnerEnv, "platform" | "eventName">,
  peeps: Pick<PeepsClient, "get">,
  log: (line: string) => void = addMask,
): Promise<Negotiated> {
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
    // Before anything else can print it, in either spelling Peeps or this action uses.
    for (const { key } of negotiated.collect ?? []) for (const text of [key.toString("hex"), key.toString("base64url")]) log(`::add-mask::${text}`);
    return { ...negotiated, scan: negotiated.scan && env.eventName === "pull_request" };
  } catch {
    return NONE;
  } finally {
    clearTimeout(timer);
  }
}
