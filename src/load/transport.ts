/**
 * The one hardened HTTPS transport every load request goes over (CW plan §4.4): the claim,
 * renewals and events (`HttpControlPort`), the job's identity token (`oidc.ts`) and the customer
 * install's tarball downloads (`registry-fetch.ts`). Nothing in load mode falls back to Node's
 * global agent.
 *
 *   - It ignores the job's proxy and TLS environment: `HTTPS_PROXY` with `NODE_USE_ENV_PROXY`
 *     applies only to Node's global agent, `NODE_TLS_REJECT_UNAUTHORIZED` is overridden by an
 *     explicit `rejectUnauthorized: true`, and `NODE_EXTRA_CA_CERTS` by an explicit `ca` (the
 *     bundled roots). Every TLS setting is explicit, so none comes from the job's `NODE_OPTIONS`.
 *   - It follows no redirect: a 3xx rejects, and nothing is sent to its `Location`.
 *   - Every request carries the caller's signal; callers bound it with their own deadline.
 *   - Errors are `ControlHttpError`: the operation, a typed code, the HTTP status and at most an
 *     errno code. Never a header, a body, a URL or a token. Headers are set on the request, never
 *     in the options the agent passes on (Node's https debug output prints those).
 *   - The factory refuses to build when Node's own diagnostics would print a request or an answer
 *     (`NODE_DEBUG` naming http, https, net, stream or tls) or write TLS traffic keys
 *     (`--tls-keylog`); `--trace-tls` is turned off on its agents.
 */
import { constants as cryptoConstants } from "node:crypto";
import { validateHeaderValue } from "node:http";
import { Agent, request, type RequestOptions } from "node:https";
import type { LookupFunction } from "node:net";
import { rootCertificates } from "node:tls";
import { debuglog } from "node:util";

export type ControlOp = "claim" | "renew" | "events" | "oidc" | "registry" | "config";
export type ControlFailure =
  /** The connection failed or was reset; `detail` is its errno code. */
  | "network"
  /** The attempt's own deadline passed. */
  | "timeout"
  /** The caller's signal. */
  | "aborted"
  | "redirect"
  /** A 5xx, 408 or 429 (sent again); or, from the OIDC service or the registry, any other non-200 (not). */
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

/** Only tests set these. */
export interface HttpControlSeams {
  /** Trusted roots in place of the bundled ones (a per-test CA). */
  ca?: string[];
  /** Resolves the test names to loopback. */
  lookup?: LookupFunction;
  oidcHosts?: readonly string[];
}

export interface Answer {
  status: number;
  json: unknown;
}

export interface AgentShape {
  keepAlive: boolean;
  maxSockets: number;
  maxFreeSockets?: number;
  scheduling?: "lifo" | "fifo";
}

export interface ControlTransport {
  /** A new agent with the transport's TLS settings; `close()` destroys it. */
  agent(shape: AgentShape): Agent;
  /** One JSON request: a GET without a body, a POST with one. */
  send(op: ControlOp, agent: Agent, target: URL, path: string, bearer: string, body: string | undefined, cap: number, signal: AbortSignal): Promise<Answer>;
  /**
   * A GET whose 200 body streams to `onChunk`, at most `cap` bytes. Anything but a 200 rejects;
   * `onChunk` answering false stops it as `too_large`.
   */
  download(op: ControlOp, agent: Agent, target: URL, path: string, cap: number, signal: AbortSignal, onChunk: (chunk: Buffer) => boolean): Promise<number>;
  /** Closes every agent it made. */
  close(): void;
}

/** Builds the transport. Throws `ControlHttpError("config", "diagnostics")` when Node would print what it sends. */
export function controlTransport(seams: HttpControlSeams = {}, userAgent = "peeps-action-load"): ControlTransport {
  if (diagnosticsOn()) throw new ControlHttpError("config", "diagnostics");
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
  const agents: Agent[] = [];
  const lookup = seams.lookup;

  return {
    agent(shape) {
      const agent = new Agent({ ...tls, ...shape });
      agents.push(agent);
      return agent;
    },

    send(op, agent, target, path, bearer, body, cap, signal) {
      return new Promise<Answer>((resolve, reject) => {
        if (signal.aborted) return reject(abortError(op, signal));
        let settled = false;
        let renewRefusalStatus: number | undefined;
        const headers: Record<string, string> = { accept: "application/json", authorization: `Bearer ${bearer}`, "user-agent": userAgent };
        if (body !== undefined) {
          headers["content-type"] = "application/json";
          headers["content-length"] = String(Buffer.byteLength(body));
        }
        try {
          for (const [name, value] of Object.entries(headers)) validateHeaderValue(name, value);
        } catch {
          return reject(new ControlHttpError(op, "malformed"));
        }
        const req = request(requestOptions(agent, target, path, body === undefined ? "GET" : "POST", lookup));
        const finish = (error: ControlHttpError | undefined, answer?: Answer) => {
          if (settled) return;
          settled = true;
          signal.removeEventListener("abort", onAbort);
          if (error) {
            req.destroy();
            // A permanent renewal 4xx still denies the renewal if its body cannot be read.
            // Keep explicit cancellation and failures before response headers on the error path.
            if (renewRefusalStatus !== undefined && error.code !== "aborted") {
              resolve({ status: renewRefusalStatus, json: undefined });
            } else {
              reject(error);
            }
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
          if (op === "renew" && status >= 400 && status < 500) renewRefusalStatus = status;
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
    },

    download(op, agent, target, path, cap, signal, onChunk) {
      return new Promise<number>((resolve, reject) => {
        if (signal.aborted) return reject(abortError(op, signal));
        let settled = false;
        const headers: Record<string, string> = { accept: "application/octet-stream", "user-agent": userAgent };
        const req = request(requestOptions(agent, target, path, "GET", lookup));
        const finish = (error: ControlHttpError | undefined, size = 0) => {
          if (settled) return;
          settled = true;
          signal.removeEventListener("abort", onAbort);
          if (error) {
            req.destroy();
            reject(error);
          } else resolve(size);
        };
        const onAbort = () => finish(abortError(op, signal));
        signal.addEventListener("abort", onAbort, { once: true });
        req.on("error", (e: NodeJS.ErrnoException) => finish(new ControlHttpError(op, "network", undefined, errnoCode(e))));
        req.on("response", (res) => {
          const status = res.statusCode ?? 0;
          if (status >= 300 && status < 400) return finish(new ControlHttpError(op, "redirect", status));
          if (status !== 200) return finish(new ControlHttpError(op, "status", status));
          const declared = Number(res.headers["content-length"]);
          if (Number.isFinite(declared) && declared > cap) return finish(new ControlHttpError(op, "too_large", status));
          let size = 0;
          res.on("data", (chunk: Buffer) => {
            if (settled) return;
            size += chunk.length;
            if (size > cap || !onChunk(chunk)) return finish(new ControlHttpError(op, "too_large", status));
          });
          res.on("error", (e: NodeJS.ErrnoException) => finish(new ControlHttpError(op, "network", status, errnoCode(e))));
          res.on("close", () => {
            if (!res.complete) finish(new ControlHttpError(op, "network", status, "ECONNRESET"));
          });
          res.on("end", () => finish(undefined, size));
        });
        for (const [name, value] of Object.entries(headers)) req.setHeader(name, value);
        req.end();
      });
    },

    close() {
      for (const agent of agents) agent.destroy();
    },
  };
}

function requestOptions(agent: Agent, target: URL, path: string, method: "GET" | "POST", lookup: LookupFunction | undefined): RequestOptions {
  return {
    agent,
    protocol: "https:",
    hostname: target.hostname,
    port: target.port || 443,
    servername: target.hostname,
    path,
    method,
    rejectUnauthorized: true,
    ...(lookup ? { lookup } : {}),
  };
}

/** `NODE_DEBUG` is read once, at startup, as `debuglog` reads it; `--tls-keylog` from either source. */
export function diagnosticsOn(): boolean {
  if (["http", "https", "net", "stream", "tls"].some((section) => debuglog(section).enabled)) return true;
  const nodeOptions = (process.env.NODE_OPTIONS ?? "").replace(/["\\]/g, "");
  return [nodeOptions, ...process.execArgv].some((arg) => /--tls[-_]keylog\b/.test(arg));
}

function errnoCode(e: NodeJS.ErrnoException): string | undefined {
  return typeof e.code === "string" && /^[A-Z][A-Z0-9_]{1,63}$/.test(e.code) ? e.code : undefined;
}

const domExceptionName = Object.getOwnPropertyDescriptor(DOMException.prototype, "name")!.get!;

export function abortError(op: ControlOp, signal: AbortSignal): ControlHttpError {
  // The reason is the caller's. The built-in getter checks the brand itself, so no own property,
  // getter or Proxy trap of the reason runs; anything else is an abort.
  try {
    if (domExceptionName.call(signal.reason) === "TimeoutError") return new ControlHttpError(op, "timeout");
  } catch {
    // Not a DOMException.
  }
  return new ControlHttpError(op, "aborted");
}

export function sleep(ms: number, signal: AbortSignal): Promise<void> {
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
