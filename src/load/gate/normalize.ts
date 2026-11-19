/**
 * Turns what arrived on a tunnel into the one request the gate may write (plan v3 §5). The
 * request is rebuilt, never forwarded: origin-form only, a fixed set of headers, the body
 * buffered and sent with its own Content-Length, and `Connection: close`. Anything the gate
 * cannot read one way only is refused: absolute-form, Upgrade, Expect, TE, any
 * Transfer-Encoding, trailers, a duplicate Host or Content-Length, and ambiguous paths. The
 * policy is checked against the method and path exactly as they will be written.
 *
 * Pure: no clock, no I/O.
 */
import { isApprovedHostName } from "./ca";

export const MAX_BODY_BYTES = 1024 * 1024;

export const READ_METHODS: ReadonlySet<string> = new Set(["GET", "HEAD", "OPTIONS"]);
const WRITE_METHODS: ReadonlySet<string> = new Set(["POST", "PUT", "PATCH", "DELETE"]);

/** Headers passed on as sent; every other header is dropped unless the policy names it. */
const PASSED_HEADERS: ReadonlySet<string> = new Set([
  "accept",
  "accept-encoding",
  "accept-language",
  "authorization",
  "cache-control",
  "content-type",
  "cookie",
  "if-match",
  "if-modified-since",
  "if-none-match",
  "if-unmodified-since",
  "origin",
  "pragma",
  "range",
  "referer",
  "user-agent",
  "x-requested-with",
]);

/** Headers whose presence means the request cannot be rebuilt one way only. */
const REFUSED_HEADERS: ReadonlySet<string> = new Set(["transfer-encoding", "te", "trailer", "upgrade", "expect", "http2-settings"]);

/** Set by the gate itself, never copied. */
const GATE_HEADERS: ReadonlySet<string> = new Set(["host", "content-length", "connection", "keep-alive", "proxy-connection", "proxy-authorization"]);

export interface AllowedRequest {
  method: "POST" | "PUT" | "PATCH" | "DELETE";
  path: string;
}

export interface RequestPolicy {
  /** Canonical origins, as `canonicalOrigin` writes them. */
  allowedOrigins: readonly string[];
  allowedRequests: readonly AllowedRequest[];
  /** Extra header names (lower-case) the plan lets through. */
  headers?: readonly string[];
}

export interface Authority {
  host: string;
  port: number;
  /** `https://host` (default port) or `https://host:port`, as `URL.origin` writes it. */
  origin: string;
}

export function canonicalOrigin(host: string, port: number): string {
  return port === 443 ? `https://${host}` : `https://${host}:${port}`;
}

/** A CONNECT target: exactly `host:port`, lower-case, an approved-name shape, no address literal. */
export function parseAuthority(target: string): Authority | undefined {
  const m = /^([a-z0-9.-]+):([1-9][0-9]{0,4})$/.exec(target);
  if (!m) return undefined;
  const host = m[1]!;
  const port = Number(m[2]);
  if (port > 65535 || !isApprovedHostName(host)) return undefined;
  return { host, port, origin: canonicalOrigin(host, port) };
}

export interface ArrivedRequest {
  method: string;
  /** The request target exactly as sent. */
  target: string;
  httpVersion: string;
  /** Node's `rawHeaders`: name, value, name, value… */
  rawHeaders: readonly string[];
  body: Buffer;
}

export interface Tunnel {
  authority: Authority;
  /** The SNI the journey sent inside the tunnel. */
  servername: string | undefined;
}

export type Refusal =
  | "version"
  | "form"
  | "method"
  | "path"
  | "header"
  | "host"
  | "length"
  | "too_large"
  | "sni"
  | "origin"
  | "not_allowed";

export type Normalized =
  | { ok: true; method: string; path: string; origin: string; head: string; body: Buffer }
  | { ok: false; reason: Refusal; status: number };

const refuse = (reason: Refusal, status = 400): Normalized => ({ ok: false, reason, status });

export function normalize(req: ArrivedRequest, tunnel: Tunnel, policy: RequestPolicy): Normalized {
  const { authority } = tunnel;
  if (tunnel.servername !== authority.host) return refuse("sni", 421);
  if (!policy.allowedOrigins.includes(authority.origin)) return refuse("origin", 403);
  if (req.httpVersion !== "1.1") return refuse("version", 505);
  if (!READ_METHODS.has(req.method) && !WRITE_METHODS.has(req.method)) return refuse("method", 405);
  if (!req.target.startsWith("/")) return refuse("form");
  const q = req.target.indexOf("?");
  const path = q < 0 ? req.target : req.target.slice(0, q);
  if (!unambiguousPath(path) || !/^[\x21-\x7e]*$/.test(req.target) || req.target.includes("#")) return refuse("path");

  const extra = new Set((policy.headers ?? []).map((h) => h.toLowerCase()));
  const lines: string[] = [];
  let host: string | undefined;
  let length: string | undefined;
  for (let i = 0; i + 1 < req.rawHeaders.length; i += 2) {
    const name = req.rawHeaders[i]!.toLowerCase();
    const value = req.rawHeaders[i + 1]!;
    if (/[\r\n\0]/.test(value)) return refuse("header");
    if (REFUSED_HEADERS.has(name)) return refuse("header");
    if (name === "host") {
      if (host !== undefined) return refuse("host");
      host = value;
      continue;
    }
    if (name === "content-length") {
      if (length !== undefined) return refuse("length");
      length = value;
      continue;
    }
    if (GATE_HEADERS.has(name)) continue;
    if (PASSED_HEADERS.has(name) || extra.has(name)) lines.push(`${name}: ${value}`);
  }
  if (host === undefined || !hostMatches(host, authority)) return refuse("host", 421);
  if (req.body.length > MAX_BODY_BYTES) return refuse("too_large", 413);
  if (length !== undefined && (!/^(0|[1-9][0-9]*)$/.test(length) || Number(length) !== req.body.length)) return refuse("length");
  if (READ_METHODS.has(req.method) && req.body.length > 0) return refuse("length");

  if (!READ_METHODS.has(req.method) && !policy.allowedRequests.some((r) => r.method === req.method && r.path === path)) return refuse("not_allowed", 403);

  const hostLine = authority.port === 443 ? authority.host : `${authority.host}:${authority.port}`;
  const framing = WRITE_METHODS.has(req.method) || req.body.length > 0 ? [`content-length: ${req.body.length}`] : [];
  const head = [`${req.method} ${req.target} HTTP/1.1`, `host: ${hostLine}`, ...lines, ...framing, "connection: close", "", ""].join("\r\n");
  return { ok: true, method: req.method, path, origin: authority.origin, head, body: req.body };
}

function hostMatches(value: string, a: Authority): boolean {
  const v = value.toLowerCase();
  return v === `${a.host}:${a.port}` || (a.port === 443 && v === a.host);
}

/** No empty segment, no dot segment, nothing percent-encoded that a server might read as a separator or dot. */
function unambiguousPath(path: string): boolean {
  if (!path.startsWith("/") || path.includes("\\")) return false;
  if (/%(2f|5c|2e|00)/i.test(path)) return false;
  if (/%(?![0-9a-f]{2})/i.test(path)) return false;
  const segments = path.slice(1).split("/");
  return segments.every((s, i) => (s !== "" || i === segments.length - 1) && s !== "." && s !== "..") && !(path.length > 1 && path.endsWith("//"));
}
