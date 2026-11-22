/**
 * The job's GitHub OIDC token (CW plan §4.4): minted over the shared transport, from an
 * `ACTIONS_ID_TOKEN_REQUEST_URL` on GitHub's host set.
 *
 * `HttpControlPort.claim` mints one for audience `peeps-load` and sends it with the claim. The
 * customer entry mints one more, earlier, for audience `peeps-load-identity`, never `peeps-load`,
 * so it can't serve as a claim if it leaked: it reads the job's check-run id, run attempt and
 * runner kind from it, then drops it. Its signature is not checked here: it came from GitHub's
 * endpoint over the checked TLS host, and Peeps verifies the claim's own token.
 */
import type { Agent } from "node:https";
import { ControlHttpError, controlTransport, sleep, type ControlOp, type ControlTransport, type HttpControlSeams } from "./transport";

export const LOAD_OIDC_AUDIENCE = "peeps-load";
export const LOAD_IDENTITY_AUDIENCE = "peeps-load-identity";
const OIDC_ANSWER_MAX_BYTES = 16 * 1024;
const OIDC_TOKEN_MAX_CHARS = 8 * 1024;
const OIDC_ATTEMPTS = 5;
/** The payload's decoded size cap. */
const CLAIMS_MAX_BYTES = 16 * 1024;
/** How long the identity read may take, retries included. */
const IDENTITY_MS = 30_000;
/**
 * Where GitHub-hosted runners mint OIDC tokens (S0, 2026-11-20: the host is per shard and region,
 * `run-actions-<n>-azure-<region>.actions.githubusercontent.com`). A leading dot matches the
 * name's subdomains, on the default port only; an exact entry matches its host and port.
 */
export const GITHUB_OIDC_HOSTS: readonly string[] = [".actions.githubusercontent.com"];

/** The request URL, refused unless https, without credentials or a fragment, on the host set. */
export function oidcRequestUrl(raw: string, hosts: readonly string[] = GITHUB_OIDC_HOSTS): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new ControlHttpError("config", "url", undefined, "ACTIONS_ID_TOKEN_REQUEST_URL");
  }
  const host = url.hostname.toLowerCase();
  // No explicit port on a suffix rule (S0): `URL` drops the default 443, so any port left is another one.
  const allowed = hosts.some((h) => (h.startsWith(".") ? url.port === "" && host.endsWith(h) && host.length > h.length : url.host.toLowerCase() === h));
  if (url.protocol !== "https:" || url.username || url.password || url.hash || !allowed) throw new ControlHttpError("config", "url", undefined, "ACTIONS_ID_TOKEN_REQUEST_URL");
  return url;
}

/**
 * The job's OIDC token for `audience`. GitHub's 5xx is retried, bounded by `window`; the caller's
 * own abort ends it as `abortOp`'s abort.
 */
export async function mintOidcToken(t: ControlTransport, agent: Agent, oidcUrl: URL, requestToken: string, audience: string, window: AbortSignal, caller: AbortSignal = window, abortOp: ControlOp = "oidc"): Promise<string> {
  const url = new URL(oidcUrl);
  url.searchParams.set("audience", audience);
  const path = url.pathname + url.search;
  for (let attempt = 1; ; attempt++) {
    try {
      const answer = await t.send("oidc", agent, url, path, requestToken, undefined, OIDC_ANSWER_MAX_BYTES, window);
      if (answer.status !== 200) throw new ControlHttpError("oidc", "status", answer.status);
      const value = isObj(answer.json) ? answer.json.value : undefined;
      if (typeof value !== "string" || value.length > OIDC_TOKEN_MAX_CHARS || !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(value)) throw new ControlHttpError("oidc", "malformed");
      return value;
    } catch (error) {
      if (caller.aborted) throw new ControlHttpError(abortOp, "aborted");
      if (!(error instanceof ControlHttpError) || !error.transient || attempt >= OIDC_ATTEMPTS || window.aborted) throw error;
    }
    await sleep(200 * attempt, window).catch(() => undefined);
  }
}

/** The claims the customer entry reads. GitHub sends every one as a JSON string (S0). */
export interface JobClaims {
  checkRunId: string;
  runId: string;
  runAttempt: string;
  runnerEnvironment: string;
  eventName: string;
  repositoryId: string;
}

/** The token's payload, read as strings only; null when it is not three base64url parts or a claim is missing or not a string. */
export function decodeJobClaims(token: string): JobClaims | null {
  const parts = token.split(".");
  if (parts.length !== 3 || !parts.every((p) => /^[A-Za-z0-9_-]+$/.test(p))) return null;
  const payload = parts[1]!;
  // base64url: four characters carry three bytes.
  if (Math.floor((payload.length * 3) / 4) > CLAIMS_MAX_BYTES) return null;
  let claims: unknown;
  try {
    claims = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
  } catch {
    return null;
  }
  if (!isObj(claims)) return null;
  const read = (name: string) => (typeof claims[name] === "string" ? (claims[name] as string) : null);
  const out = {
    checkRunId: read("check_run_id"),
    runId: read("run_id"),
    runAttempt: read("run_attempt"),
    runnerEnvironment: read("runner_environment"),
    eventName: read("event_name"),
    repositoryId: read("repository_id"),
  };
  return Object.values(out).every((v) => v !== null) ? (out as JobClaims) : null;
}

export type IdentityRead =
  | { ok: true; checkRunId: number; runAttempt: number }
  | { ok: false; refused: "identity" | "self_hosted" }
  /** The token could not be minted at all: nothing to compare. */
  | { ok: false; failed: "oidc" };

const CHECK_RUN_ID = /^[1-9]\d{0,18}$/;

/** The identity a decoded token names, compared with the job's own environment. */
export function identityOf(claims: JobClaims | null, env: NodeJS.ProcessEnv): IdentityRead {
  if (!claims) return { ok: false, refused: "identity" };
  const checkRunId = Number(claims.checkRunId);
  if (!CHECK_RUN_ID.test(claims.checkRunId) || !Number.isSafeInteger(checkRunId)) return { ok: false, refused: "identity" };
  if (claims.runId !== env.GITHUB_RUN_ID || claims.runAttempt !== env.GITHUB_RUN_ATTEMPT) return { ok: false, refused: "identity" };
  if (claims.eventName !== "workflow_dispatch") return { ok: false, refused: "identity" };
  if (claims.runnerEnvironment !== "github-hosted") return { ok: false, refused: "self_hosted" };
  return { ok: true, checkRunId, runAttempt: Number(claims.runAttempt) };
}

/**
 * Mints one token for `peeps-load-identity`, reads it, drops it. A URL off GitHub's hosts or a
 * failed mint is `failed: oidc`; a token that doesn't name this run is `identity`; a self-hosted
 * runner is `self_hosted`.
 */
export async function readJobIdentity(oidc: { requestUrl: string; requestToken: string }, env: NodeJS.ProcessEnv, seams: HttpControlSeams = {}, signal?: AbortSignal): Promise<IdentityRead> {
  let t: ControlTransport | undefined;
  try {
    const url = oidcRequestUrl(oidc.requestUrl, seams.oidcHosts ?? GITHUB_OIDC_HOSTS);
    t = controlTransport(seams);
    const agent = t.agent({ keepAlive: false, maxSockets: 1 });
    const window = AbortSignal.any([AbortSignal.timeout(IDENTITY_MS), ...(signal ? [signal] : [])]);
    const token = await mintOidcToken(t, agent, url, oidc.requestToken, LOAD_IDENTITY_AUDIENCE, window);
    return identityOf(decodeJobClaims(token), env);
  } catch {
    return { ok: false, failed: "oidc" };
  } finally {
    t?.close();
  }
}

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);
