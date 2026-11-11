/**
 * Keyed ids under the project's key, from the preflight: what leaves the job in place
 * of a source path, a function name or a route. The key lives in this process's memory
 * only, never on disk or in a log line; the boundary is that the whole CI job is
 * trusted, since Playwright's children inherit this process's environment. Pure.
 *
 * The contract with Peeps (its encoder hashes GitHub's file list the same way), pinned
 * by `test/fixtures/evidence/hash-vectors.json`:
 * - an id is HMAC-SHA256(key, `<kind>\0<value>`), its first 16 bytes in lowercase hex;
 * - a token is `<kind>:<id>` for `fn`, `file`, `css` and `out`; `table:r:<id>` and
 *   `table:w:<id>` both hash under `table`, so a table's two directions share one id;
 * - a route is hashed per segment (8 bytes, `route-segment\0<segment>`), so the server's
 *   segment matcher still meets `/orders/7` with `/orders/:id`. Per segment: split on
 *   `/`, strip `;…`, drop empty segments, decode (an undecodable escape is `:id`), then
 *   classify before lowercasing. A matcher keeps `*` and `**`, writes any `:x` as `:id`,
 *   and reads Next's `[x]`, `[...x]` and `[[...x]]` as `:id`, `*` and `**`; a path's only
 *   marker is an exact `:id`.
 *   Every other segment is lowercased and hashed.
 */
import { createHmac } from "node:crypto";

export const ROUTE_ENCODER_VERSION = 1;
const KEY_BYTES = 32;
const ID_HEX = 32;
const SEGMENT_HEX = 16;
const KINDS = new Set(["fn", "file", "css", "out"]);

/** The project key from lowercase hex or base64url (the two spellings masked), or null unless exactly 32 bytes. */
export function parseProjectKey(text: unknown): Buffer | null {
  if (typeof text !== "string") return null;
  if (/^[0-9a-f]{64}$/.test(text)) return Buffer.from(text, "hex");
  if (!/^[A-Za-z0-9_-]+$/.test(text)) return null;
  const key = Buffer.from(text, "base64url");
  return key.length === KEY_BYTES && key.toString("base64url") === text ? key : null;
}

export function keyedId(key: Buffer, kind: string, value: string): string {
  return createHmac("sha256", key).update(`${kind}\u0000${value}`).digest("hex").slice(0, ID_HEX);
}

export function segmentId(key: Buffer, segment: string): string {
  return createHmac("sha256", key).update(`route-segment\u0000${segment}`).digest("hex").slice(0, SEGMENT_HEX);
}

/** A fingerprint or footprint key (`fn:…`, `file:…`, `css:…`, `out:…`, `route:<matcher>`) as its token. */
export function tokenOf(key: Buffer, plain: string): string {
  // Both directions of a table share one id, so a changed write meets the tests that read it.
  const table = /^(table:[rw]):(.+)$/s.exec(plain);
  if (table) return `${table[1]}:${keyedId(key, "table", table[2]!)}`;
  const colon = plain.indexOf(":");
  const kind = plain.slice(0, colon);
  const rest = plain.slice(colon + 1);
  if (kind === "route") return `route:${encodeMatcher(key, rest)}`;
  if (colon < 1 || !KINDS.has(kind)) throw new Error(`No token kind for ${kind || "an unnamed key"}`);
  return `${kind}:${keyedId(key, kind, rest)}`;
}

/** A route a test requested, as its `route:` token. */
export function pathToken(key: Buffer, path: string): string {
  return `route:${encodePath(key, path)}`;
}

function segmentsOf(route: string): string[] {
  return route
    .split("/")
    .map((raw) => raw.split(";", 1)[0]!)
    .filter((segment) => segment !== "")
    .map((segment) => {
      try {
        return decodeURIComponent(segment);
      } catch {
        return ":id";
      }
    });
}

/** A route matcher, as the server's `segmentsMeet` reads its `want` side. */
export function encodeMatcher(key: Buffer, route: string): string {
  const out = segmentsOf(route).map((segment) => {
    if (segment === "*" || segment === "**") return segment;
    if (/^\[\[\.\.\.[^\]]+\]\]$/.test(segment)) return "**";
    if (/^\[\.\.\.[^\]]+\]$/.test(segment)) return "*";
    // A parameter's name says nothing the matcher needs: every one leaves as `:id`.
    if (segment.startsWith(":") || /^\[[^\]]+\]$/.test(segment)) return ":id";
    return segmentId(key, segment.toLowerCase());
  });
  return `/${out.join("/")}`;
}

/** A requested path, as `segmentsMeet` reads its `have` side. */
export function encodePath(key: Buffer, path: string): string {
  const out = segmentsOf(path).map((segment) => (segment === ":id" ? segment : segmentId(key, segment.toLowerCase())));
  return `/${out.join("/")}`;
}

/** An attempt's evidence as tokens, sorted and unique: its keys, and its paths on the path side. */
export function evidenceTokens(key: Buffer, evidence: { keys: string[]; paths: string[] }): string[] {
  return [...new Set([...evidence.keys.map((k) => tokenOf(key, k)), ...evidence.paths.map((p) => pathToken(key, p))])].sort();
}
