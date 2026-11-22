/**
 * The HTTP adapter for the supervisor's `ControlPort` (design v3 §6; e5 plan §4, v2 §4, v3 §2.4
 * and §4): claim, renew and events against Peeps' `/api/v1/load/*` routes.
 *
 *   - Transport: `node:https` on its own agents, HTTP/1.1, keep-alive, so renewals ride a warm TLS
 *     connection. Renewals (and the claim, which warms it) share one agent of 2 sockets; events
 *     have their own agent of 1, so a slow upload never holds a renewal's socket.
 *   - It ignores the job's proxy and TLS environment: `HTTPS_PROXY` with `NODE_USE_ENV_PROXY`
 *     applies only to Node's global agent, `NODE_TLS_REJECT_UNAUTHORIZED` is overridden by an
 *     explicit `rejectUnauthorized: true`, and `NODE_EXTRA_CA_CERTS` by an explicit `ca` (the
 *     bundled roots).
 *   - It follows no redirect: a 3xx rejects, and nothing is sent to its `Location`.
 *   - Bodies: the claim is `canonical(body)`; the renew body is the given text, byte for byte;
 *     events are `JSON.stringify(body)`. A retry of the claim sends the same bytes with the same
 *     OIDC token.
 *   - Answers: a 2xx with `application/json` resolves to the parsed JSON for the decoders to
 *     judge; a 4xx resolves only as a refusal (reduced to its enumerated code, `unknown` when it
 *     carries none). A grant's claim id must be a UUID. A 5xx, 408, 429, a network error, a
 *     timeout, a redirect, another content type, a body that does not parse or one past its cap
 *     (2 MiB for the claim, whose answer carries the plan; 64 KiB otherwise) rejects.
 *   - The claim is retried on a transient failure with identical bytes, and only for 4.5 s from
 *     the call (`CLAIM_RETRY_MS`; an answer read past it, by the monotonic clock, is a timeout): the supervisor samples its clocks right before calling, and
 *     anchors the lease there, so an answer read later than that could only be discarded after
 *     consuming the grant (e5 plan v3 §4, minor 1 of the round-2 review).
 *   - The OIDC token (audience `peeps-load`) is minted inside `claim` only, from an
 *     `ACTIONS_ID_TOKEN_REQUEST_URL` that must be https, carry no credentials or explicit port, and be on the GitHub
 *     host set; anything else is refused when the port is built, before the request token goes
 *     anywhere.
 *   - Nothing here prints. Errors are `ControlHttpError`: the operation, a typed code, the HTTP
 *     status and at most an errno code. Never a header, a body, a URL or a token. Headers are set
 *     on the request, never in the options the agent passes on. The port refuses to be built when
 *     Node's own diagnostics would print a request or an answer (`NODE_DEBUG` naming http, https,
 *     net, stream or tls) or write TLS traffic keys (`--tls-keylog`); `--trace-tls` is turned off
 *     on its agents.
 */
import type { Agent } from "node:https";
import { canonical, type ClaimRequest, type ControlPort, type EventsBody } from "./control-port";
import { GITHUB_OIDC_HOSTS, LOAD_OIDC_AUDIENCE, mintOidcToken, oidcRequestUrl } from "./oidc";
import { ControlHttpError, controlTransport, sleep, type Answer, type ControlTransport, type HttpControlSeams } from "./transport";
import { CLAIM_REFUSALS, EVENTS_REFUSALS, RENEW_REFUSALS } from "./wire";

export { ControlHttpError, GITHUB_OIDC_HOSTS, LOAD_OIDC_AUDIENCE };
export type { ControlFailure, ControlOp, HttpControlSeams } from "./transport";

/** The claim is retried for this long from the call, then rejects with its last failure. */
export const CLAIM_RETRY_MS = 4_500;
/** One claim attempt, before it is sent again. */
export const CLAIM_ATTEMPT_MS = 2_000;
/** Pause between claim attempts. */
export const CLAIM_PAUSE_MS = 100;
export const CLAIM_ANSWER_MAX_BYTES = 2 * 1024 * 1024;
export const ANSWER_MAX_BYTES = 64 * 1024;
/**
 * The refusal codes the wire names (wire-v1's `constants.json`, through `wire.ts`). Anything else
 * is reduced to `unknown`, so a refusal that echoes a value can never carry it further.
 */
const REFUSALS: ReadonlySet<string> = new Set([...CLAIM_REFUSALS, ...RENEW_REFUSALS]);
const CLAIM_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const EVENT_REASONS: ReadonlySet<string> = new Set(EVENTS_REFUSALS);

export interface HttpControlPortOptions {
  /** Peeps' origin: https, no credentials, no path. */
  peepsUrl: string;
  /** `ACTIONS_ID_TOKEN_REQUEST_URL` and `ACTIONS_ID_TOKEN_REQUEST_TOKEN`. */
  oidc: { requestUrl: string; requestToken: string };
  userAgent?: string;
}

const monoNow = () => Number(process.hrtime.bigint()) / 1e6;

export class HttpControlPort implements ControlPort {
  private readonly origin: URL;
  private readonly oidcUrl: URL;
  private readonly requestToken: string;
  private readonly transport: ControlTransport;
  private readonly renewAgent: Agent;
  private readonly eventsAgent: Agent;
  private readonly oidcAgent: Agent;

  constructor(options: HttpControlPortOptions, seams: HttpControlSeams = {}) {
    // The transport first: it refuses Node diagnostics before any URL is read.
    const transport = controlTransport(seams, options.userAgent ?? "peeps-action-load");
    this.origin = peepsOrigin(options.peepsUrl);
    this.oidcUrl = oidcRequestUrl(options.oidc.requestUrl, seams.oidcHosts ?? GITHUB_OIDC_HOSTS);
    this.requestToken = options.oidc.requestToken;
    this.transport = transport;
    this.renewAgent = transport.agent({ keepAlive: true, maxSockets: 2, maxFreeSockets: 2, scheduling: "lifo" });
    this.eventsAgent = transport.agent({ keepAlive: true, maxSockets: 1, maxFreeSockets: 1 });
    this.oidcAgent = transport.agent({ keepAlive: false, maxSockets: 1 });
  }

  /**
   * Mints the OIDC token, then sends the claim and retries it, identical bytes and the same
   * token, on a transient failure until `CLAIM_RETRY_MS` after the call.
   */
  async claim(body: ClaimRequest, signal: AbortSignal): Promise<unknown> {
    const deadline = monoNow() + CLAIM_RETRY_MS;
    const window = AbortSignal.any([signal, AbortSignal.timeout(CLAIM_RETRY_MS)]);
    const idToken = await mintOidcToken(this.transport, this.oidcAgent, this.oidcUrl, this.requestToken, LOAD_OIDC_AUDIENCE, window, signal, "claim");
    const bytes = canonical(body);
    let last: ControlHttpError | undefined;
    for (;;) {
      const left = deadline - monoNow();
      if (left <= 0) throw last ?? new ControlHttpError("claim", "timeout");
      const cutByWindow = left < CLAIM_ATTEMPT_MS;
      const attempt = AbortSignal.any([signal, AbortSignal.timeout(Math.max(1, Math.ceil(Math.min(left, CLAIM_ATTEMPT_MS))))]);
      try {
        const answer = await this.send("claim", this.renewAgent, "/api/v1/load/claims", idToken, bytes, CLAIM_ANSWER_MAX_BYTES, attempt);
        // Read after the window: the timer had not fired yet, but the supervisor's lease is anchored
        // at the call, so this answer is late however it decodes, and that is the failure reported.
        if (monoNow() >= deadline) {
          last = new ControlHttpError("claim", "timeout");
          continue;
        }
        const reply = reduceRefusal(answer);
        if (isObj(reply) && !("refused" in reply) && !(typeof reply.claimId === "string" && CLAIM_ID.test(reply.claimId))) throw new ControlHttpError("claim", "malformed", answer.status);
        return reply;
      } catch (error) {
        if (!(error instanceof ControlHttpError) || !error.transient || signal.aborted) throw signal.aborted ? new ControlHttpError("claim", "aborted") : error;
        // An attempt the window cut short says less than the failure before it.
        if (!(last && cutByWindow && error.code === "timeout")) last = error;
      }
      const pause = Math.min(CLAIM_PAUSE_MS, deadline - monoNow());
      if (pause > 0) await sleep(pause, signal).catch(() => undefined);
    }
  }

  async renew(claimId: string, runToken: string, body: string, signal: AbortSignal): Promise<unknown> {
    const answer = await this.send("renew", this.renewAgent, claimPath(claimId, "renew"), runToken, body, ANSWER_MAX_BYTES, signal);
    return reduceRefusal(answer);
  }

  async events(claimId: string, eventsToken: string, body: EventsBody, signal: AbortSignal): Promise<unknown> {
    const answer = await this.send("events", this.eventsAgent, claimPath(claimId, "events"), eventsToken, JSON.stringify(body), ANSWER_MAX_BYTES, signal);
    const json = answer.json;
    if (isObj(json) && json.ok === true && answer.status < 300) {
      // P1's acknowledgement is `{ok: true, replay: boolean}`; anything else delivers nothing.
      if ("refused" in json || "reason" in json || typeof json.replay !== "boolean") throw new ControlHttpError("events", "malformed", answer.status);
      return { ok: true, replay: json.replay };
    }
    if (isObj(json) && json.ok === false) return { ok: false, reason: typeof json.reason === "string" && EVENT_REASONS.has(json.reason) ? json.reason : "unknown" };
    return reduceRefusal(answer);
  }

  /** Closes the kept-alive sockets. */
  close(): void {
    this.transport.close();
  }

  private send(op: "claim" | "renew" | "events", agent: Agent, path: string, bearer: string, body: string, cap: number, signal: AbortSignal): Promise<Answer> {
    return this.transport.send(op, agent, this.origin, path, bearer, body, cap, signal);
  }
}

function claimPath(claimId: string, op: "renew" | "events"): string {
  try {
    return `/api/v1/load/claims/${encodeURIComponent(claimId)}/${op}`;
  } catch {
    // A lone surrogate: `encodeURIComponent` throws a `URIError`.
    throw new ControlHttpError(op, "malformed");
  }
}

function peepsOrigin(raw: string): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new ControlHttpError("config", "url", undefined, "PEEPS_URL");
  }
  if (url.protocol !== "https:" || url.username || url.password || (url.pathname !== "/" && url.pathname !== "") || url.search || url.hash) throw new ControlHttpError("config", "url", undefined, "PEEPS_URL");
  return url;
}

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);

/** A refusal is its enumerated code and nothing else; a 4xx that names none is `unknown`. */
function reduceRefusal(answer: Answer): unknown {
  const json = answer.json;
  if (isObj(json) && "refused" in json) return { refused: typeof json.refused === "string" && REFUSALS.has(json.refused) ? json.refused : "unknown" };
  return answer.status < 300 ? json : { refused: "unknown" };
}
