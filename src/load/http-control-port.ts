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
import { constants as cryptoConstants } from "node:crypto";
import { validateHeaderValue } from "node:http";
import { Agent, request, type RequestOptions } from "node:https";
import type { LookupFunction } from "node:net";
import { rootCertificates } from "node:tls";
import { debuglog } from "node:util";
import { canonical, type ClaimRequest, type ControlPort, type EventsBody } from "./control-port";
import { CLAIM_REFUSALS, EVENTS_REFUSALS, RENEW_REFUSALS } from "./wire";

export const LOAD_OIDC_AUDIENCE = "peeps-load";
/** The claim is retried for this long from the call, then rejects with its last failure. */
export const CLAIM_RETRY_MS = 4_500;
/** One claim attempt, before it is sent again. */
export const CLAIM_ATTEMPT_MS = 2_000;
/** Pause between claim attempts. */
export const CLAIM_PAUSE_MS = 100;
export const CLAIM_ANSWER_MAX_BYTES = 2 * 1024 * 1024;
export const ANSWER_MAX_BYTES = 64 * 1024;
const OIDC_ANSWER_MAX_BYTES = 16 * 1024;
const OIDC_TOKEN_MAX_CHARS = 8 * 1024;
const OIDC_ATTEMPTS = 5;
/**
 * Where GitHub-hosted runners mint OIDC tokens (S0, 2026-11-20: the host is per shard and region,
 * `run-actions-<n>-azure-<region>.actions.githubusercontent.com`). A leading dot matches the
 * name's subdomains, on the default port only; an exact entry matches its host and port.
 */
export const GITHUB_OIDC_HOSTS: readonly string[] = [".actions.githubusercontent.com"];

/**
 * The refusal codes the wire names (wire-v1's `constants.json`, through `wire.ts`). Anything else
 * is reduced to `unknown`, so a refusal that echoes a value can never carry it further.
 */
const REFUSALS: ReadonlySet<string> = new Set([...CLAIM_REFUSALS, ...RENEW_REFUSALS]);
const CLAIM_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const EVENT_REASONS: ReadonlySet<string> = new Set(EVENTS_REFUSALS);

export type ControlOp = "claim" | "renew" | "events" | "oidc" | "config";
export type ControlFailure =
  /** The connection failed or was reset; `detail` is its errno code. */
  | "network"
  /** The attempt's own deadline passed. */
  | "timeout"
  /** The caller's signal. */
  | "aborted"
  | "redirect"
  /** A 5xx, 408 or 429 (sent again); or, from the OIDC service, any other non-200 (not). */
  | "status"
  | "content_type"
  | "too_large"
  /** The body is not JSON, or the OIDC answer carries no usable token. */
  | "malformed"
  /** The port was built with a URL it refuses. */
  | "url"
  /** Node's diagnostics would print a request or write TLS traffic keys. */
  | "diagnostics";

export class ControlHttpError extends Error {
  constructor(
    readonly op: ControlOp,
    readonly code: ControlFailure,
    readonly status?: number,
    readonly detail?: string,
  ) {
    super(`load control ${op}: ${code}${status !== undefined ? ` ${status}` : ""}${detail ? ` (${detail})` : ""}`);
    this.name = "ControlHttpError";
  }

  /** Worth sending the same bytes again. */
  get transient(): boolean {
    if (this.code === "status") return this.status !== undefined && (this.status >= 500 || this.status === 408 || this.status === 429);
    return this.code === "network" || this.code === "timeout";
  }
}

export interface HttpControlPortOptions {
  /** Peeps' origin: https, no credentials, no path. */
  peepsUrl: string;
  /** `ACTIONS_ID_TOKEN_REQUEST_URL` and `ACTIONS_ID_TOKEN_REQUEST_TOKEN`. */
  oidc: { requestUrl: string; requestToken: string };
  userAgent?: string;
}

/** Only tests set these. */
export interface HttpControlSeams {
  /** Trusted roots in place of the bundled ones (a per-test CA). */
  ca?: string[];
  /** Resolves the test names to loopback. */
  lookup?: LookupFunction;
  oidcHosts?: readonly string[];
}

interface Answer {
  status: number;
  json: unknown;
}

const monoNow = () => Number(process.hrtime.bigint()) / 1e6;

export class HttpControlPort implements ControlPort {
  private readonly origin: URL;
  private readonly oidcUrl: URL;
  private readonly requestToken: string;
  private readonly userAgent: string;
  private readonly lookup: LookupFunction | undefined;
  private readonly renewAgent: Agent;
  private readonly eventsAgent: Agent;
  private readonly oidcAgent: Agent;

  constructor(options: HttpControlPortOptions, seams: HttpControlSeams = {}) {
    if (diagnosticsOn()) throw new ControlHttpError("config", "diagnostics");
    this.origin = peepsOrigin(options.peepsUrl);
    this.oidcUrl = oidcRequestUrl(options.oidc.requestUrl, seams.oidcHosts ?? GITHUB_OIDC_HOSTS);
    this.requestToken = options.oidc.requestToken;
    this.userAgent = options.userAgent ?? "peeps-action-load";
    this.lookup = seams.lookup;
    // Every TLS setting explicit, so none comes from the job's `NODE_OPTIONS` (cipher list, versions).
    const tls = {
      ca: seams.ca ?? [...rootCertificates],
      rejectUnauthorized: true,
      minVersion: "TLSv1.2" as const,
      maxVersion: "TLSv1.3" as const,
      ciphers: cryptoConstants.defaultCoreCipherList,
      enableTrace: false,
      ALPNProtocols: ["http/1.1"],
      ...(seams.lookup ? { lookup: seams.lookup } : {}),
    };
    this.renewAgent = new Agent({ ...tls, keepAlive: true, maxSockets: 2, maxFreeSockets: 2, scheduling: "lifo" });
    this.eventsAgent = new Agent({ ...tls, keepAlive: true, maxSockets: 1, maxFreeSockets: 1 });
    this.oidcAgent = new Agent({ ...tls, keepAlive: false, maxSockets: 1 });
  }

  /**
   * Mints the OIDC token, then sends the claim and retries it, identical bytes and the same
   * token, on a transient failure until `CLAIM_RETRY_MS` after the call.
   */
  async claim(body: ClaimRequest, signal: AbortSignal): Promise<unknown> {
    const deadline = monoNow() + CLAIM_RETRY_MS;
    const window = AbortSignal.any([signal, AbortSignal.timeout(CLAIM_RETRY_MS)]);
    const idToken = await this.mint(window, signal);
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
    this.renewAgent.destroy();
    this.eventsAgent.destroy();
    this.oidcAgent.destroy();
  }

  /** The job's OIDC token for `peeps-load`. GitHub's 5xx is retried, bounded by `window`. */
  private async mint(window: AbortSignal, caller: AbortSignal): Promise<string> {
    const url = new URL(this.oidcUrl);
    url.searchParams.set("audience", LOAD_OIDC_AUDIENCE);
    const path = url.pathname + url.search;
    for (let attempt = 1; ; attempt++) {
      try {
        const answer = await this.send("oidc", this.oidcAgent, path, this.requestToken, undefined, OIDC_ANSWER_MAX_BYTES, window, url);
        if (answer.status !== 200) throw new ControlHttpError("oidc", "status", answer.status);
        const value = isObj(answer.json) ? answer.json.value : undefined;
        if (typeof value !== "string" || value.length > OIDC_TOKEN_MAX_CHARS || !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(value)) throw new ControlHttpError("oidc", "malformed");
        return value;
      } catch (error) {
        if (caller.aborted) throw new ControlHttpError("claim", "aborted");
        if (!(error instanceof ControlHttpError) || !error.transient || attempt >= OIDC_ATTEMPTS || window.aborted) throw error;
      }
      await sleep(200 * attempt, window).catch(() => undefined);
    }
  }

  private send(op: ControlOp, agent: Agent, path: string, bearer: string, body: string | undefined, cap: number, signal: AbortSignal, target: URL = this.origin): Promise<Answer> {
    return new Promise<Answer>((resolve, reject) => {
      if (signal.aborted) return reject(abortError(op, signal));
      let settled = false;
      const headers: Record<string, string> = { accept: "application/json", authorization: `Bearer ${bearer}`, "user-agent": this.userAgent };
      if (body !== undefined) {
        headers["content-type"] = "application/json";
        headers["content-length"] = String(Buffer.byteLength(body));
      }
      // A token no header can carry is refused here, before the agent opens or takes a socket.
      try {
        for (const [name, value] of Object.entries(headers)) validateHeaderValue(name, value);
      } catch {
        return reject(new ControlHttpError(op, "malformed"));
      }
      const options: RequestOptions = {
        agent,
        protocol: "https:",
        hostname: target.hostname,
        port: target.port || 443,
        servername: target.hostname,
        path,
        method: body === undefined ? "GET" : "POST",
        rejectUnauthorized: true,
        ...(this.lookup ? { lookup: this.lookup } : {}),
      };
      const req = request(options);
      const finish = (error: ControlHttpError | undefined, answer?: Answer) => {
        if (settled) return;
        settled = true;
        signal.removeEventListener("abort", onAbort);
        if (error) {
          req.destroy();
          reject(error);
        } else resolve(answer!);
      };
      const onAbort = () => finish(abortError(op, signal));
      signal.addEventListener("abort", onAbort, { once: true });
      req.on("error", (e: NodeJS.ErrnoException) => finish(new ControlHttpError(op, "network", undefined, errnoCode(e))));
      req.on("response", (res) => {
        const status = res.statusCode ?? 0;
        if (status >= 300 && status < 400) return finish(new ControlHttpError(op, "redirect", status));
        if (status >= 500 || status === 408 || status === 429) return finish(new ControlHttpError(op, "status", status));
        if (status < 200) return finish(new ControlHttpError(op, "status", status));
        if (!/^application\/json\s*(;|$)/i.test(String(res.headers["content-type"] ?? ""))) return finish(new ControlHttpError(op, "content_type", status));
        const declared = Number(res.headers["content-length"]);
        if (Number.isFinite(declared) && declared > cap) return finish(new ControlHttpError(op, "too_large", status));
        const chunks: Buffer[] = [];
        let size = 0;
        res.on("data", (chunk: Buffer) => {
          size += chunk.length;
          if (size > cap) return finish(new ControlHttpError(op, "too_large", status));
          chunks.push(chunk);
        });
        res.on("error", (e: NodeJS.ErrnoException) => finish(new ControlHttpError(op, "network", status, errnoCode(e))));
        res.on("close", () => {
          if (!res.complete) finish(new ControlHttpError(op, "network", status, "ECONNRESET"));
        });
        res.on("end", () => {
          let json: unknown;
          try {
            json = JSON.parse(Buffer.concat(chunks).toString("utf8"));
          } catch {
            return finish(new ControlHttpError(op, "malformed", status));
          }
          finish(undefined, { status, json });
        });
      });
      // On the request, never in `options`: the agent hands its options to `createConnection`, and
      // Node's https debug output prints them.
      for (const [name, value] of Object.entries(headers)) req.setHeader(name, value);
      req.end(body);
    });
  }
}

/** `NODE_DEBUG` is read once, at startup, as `debuglog` reads it; `--tls-keylog` from either source. */
function diagnosticsOn(): boolean {
  if (["http", "https", "net", "stream", "tls"].some((section) => debuglog(section).enabled)) return true;
  const nodeOptions = (process.env.NODE_OPTIONS ?? "").replace(/["\\]/g, "");
  return [nodeOptions, ...process.execArgv].some((arg) => /--tls[-_]keylog\b/.test(arg));
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

function oidcRequestUrl(raw: string, hosts: readonly string[]): URL {
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

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);

/** A refusal is its enumerated code and nothing else; a 4xx that names none is `unknown`. */
function reduceRefusal(answer: Answer): unknown {
  const json = answer.json;
  if (isObj(json) && "refused" in json) return { refused: typeof json.refused === "string" && REFUSALS.has(json.refused) ? json.refused : "unknown" };
  return answer.status < 300 ? json : { refused: "unknown" };
}

function errnoCode(e: NodeJS.ErrnoException): string | undefined {
  return typeof e.code === "string" && /^[A-Z][A-Z0-9_]{1,63}$/.test(e.code) ? e.code : undefined;
}

const domExceptionName = Object.getOwnPropertyDescriptor(DOMException.prototype, "name")!.get!;

function abortError(op: ControlOp, signal: AbortSignal): ControlHttpError {
  // The reason is the caller's. The built-in getter checks the brand itself, so no own property,
  // getter or Proxy trap of the reason runs; anything else is an abort.
  try {
    if (domExceptionName.call(signal.reason) === "TimeoutError") return new ControlHttpError(op, "timeout");
  } catch {
    // Not a DOMException.
  }
  return new ControlHttpError(op, "aborted");
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(signal.reason);
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal.reason);
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal.addEventListener("abort", onAbort, { once: true });
  });
}
