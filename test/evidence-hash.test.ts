/**
 * Keyed ids under the project key, and routes encoded per segment so the server's
 * matcher still meets them. `fixtures/evidence/impact-ids.vectors.json` is Peeps' own
 * vectors file (`pr-impact/infrastructure/__fixtures__/`), copied unchanged: the action
 * must give its every answer.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";

import { encodeMatcher, encodePath, keyedId, parseProjectKey, pathToken, segmentId, tokenOf } from "../src/evidence/hash";
import { sourceName } from "../src/evidence/fingerprint/rules";
import { nextEntry } from "../src/reach/adapters/next";

interface Vectors {
  projectKeyHex: string;
  tokens: Array<{ kind: string; value: string; token: string }>;
  routes: Array<{ side: "matcher" | "path"; route: string; encoded: string }>;
  meetRows: Array<{ surface: string; path: string; meets: boolean }>;
  nextManifestRows: Array<{ manifestValue: string; roots: string[]; normalised: string | null; encodedMatcher: string | null }>;
  nextSourceRows: Array<{ file: string; roots: string[]; normalised: string | null; encodedMatcher: string | null; fileToken: string }>;
}

const vectors = JSON.parse(readFileSync(path.join(__dirname, "fixtures/evidence/impact-ids.vectors.json"), "utf8")) as Vectors;
const key = parseProjectKey(vectors.projectKeyHex)!;

/** The server's matcher, `route-match.ts`, as it reads plaintext. */
function segmentsMeet(want: string[], have: string[]): boolean {
  for (let i = 0; i < want.length; i++) {
    const segment = want[i]!;
    if (segment === "**") return true;
    if (segment === "*") return i < have.length;
    if (i >= have.length) return false;
    if (segment.startsWith(":") || have[i] === ":id") continue;
    if (segment.toLowerCase() !== have[i]!.toLowerCase()) return false;
  }
  return want.length === have.length;
}
function routeSegments(route: string): string[] {
  return route
    .split("/")
    .map((raw) => {
      const [bare] = raw.split(";", 1) as [string];
      try {
        return decodeURIComponent(bare);
      } catch {
        return ":id";
      }
    })
    .filter((segment) => segment !== "");
}
const split = (encoded: string) => encoded.split("/").filter((segment) => segment !== "");
const plainMeets = (matcher: string, path: string) => segmentsMeet(routeSegments(matcher), routeSegments(path));
const encodedMeets = (matcher: string, path: string) => segmentsMeet(split(encodeMatcher(key, matcher)), split(encodePath(key, path)));

test("the project key is 32 bytes, as hex or base64url, and nothing else", () => {
  assert.equal(key.length, 32);
  assert.deepEqual(parseProjectKey(key.toString("base64url")), key);
  assert.equal(parseProjectKey("c2hvcnQ"), null);
  assert.equal(parseProjectKey(""), null);
  assert.equal(parseProjectKey(42), null);
  assert.equal(parseProjectKey(`${key.toString("base64url")}!`), null);
  assert.equal(parseProjectKey(vectors.projectKeyHex.slice(2)), null);
});

test("an id is HMAC-SHA256 over kind, a zero byte and the value, 16 bytes in hex", () => {
  const expected = createHmac("sha256", key).update("file\u0000src/app/page.tsx").digest("hex").slice(0, 32);
  assert.equal(keyedId(key, "file", "src/app/page.tsx"), expected);
  assert.equal(segmentId(key, "cart"), createHmac("sha256", key).update("route-segment\u0000cart").digest("hex").slice(0, 16));
});

test("two keys never give the same id", () => {
  const other = parseProjectKey(Buffer.alloc(32, 7).toString("hex"))!;
  assert.notEqual(keyedId(key, "file", "a.ts"), keyedId(other, "file", "a.ts"));
});

test("Peeps' vectors: every token and every encoded route", () => {
  assert.ok(vectors.tokens.length > 0 && vectors.routes.length > 0);
  for (const row of vectors.tokens) assert.equal(tokenOf(key, `${row.kind}:${row.value}`), row.token, `${row.kind} ${row.value}`);
  for (const row of vectors.routes) {
    assert.equal(row.side === "matcher" ? encodeMatcher(key, row.route) : encodePath(key, row.route), row.encoded, `${row.side} ${row.route}`);
  }
});

test("Peeps' meet rows: encoded routes meet exactly as plaintext does", () => {
  assert.ok(vectors.meetRows.length >= 30);
  for (const row of vectors.meetRows) {
    assert.equal(plainMeets(row.surface, row.path), row.meets, `plaintext ${row.surface} ~ ${row.path}`);
    assert.equal(encodedMeets(row.surface, row.path), row.meets, `encoded ${row.surface} ~ ${row.path}`);
  }
});

test("Next's markers are matcher-side only: plaintext reads them as literals", () => {
  assert.equal(encodedMeets("/orders/[id]", "/orders/7"), true);
  assert.equal(encodedMeets("/docs/[...slug]", "/docs/a/b"), true);
  assert.equal(encodedMeets("/docs/[...slug]", "/docs"), false);
  assert.equal(encodedMeets("/docs/[[...slug]]", "/docs"), true);
  assert.equal(encodedMeets("/orders/7", "/orders/:ID"), false);
  assert.equal(encodedMeets("/orders/7", "/orders/:id"), true);
  assert.equal(encodeMatcher(key, "/:orgSlug/[id]"), "/:id/:id");
});

test("a manifest's built file and its source meet the same route (Y2, Z1)", () => {
  for (const row of vectors.nextManifestRows) {
    const normalised = nextEntry(row.manifestValue, row.roots);
    assert.equal(normalised === null ? null : encodeMatcher(key, normalised), row.encodedMatcher, row.manifestValue);
  }
  for (const row of vectors.nextSourceRows) {
    const normalised = nextEntry(row.file, row.roots);
    assert.equal(normalised === null ? null : encodeMatcher(key, normalised), row.encodedMatcher, row.file);
    assert.equal(tokenOf(key, `file:${row.file}`), row.fileToken, row.file);
  }
  // The mistake Z1 rules out: the build side with the app's repo root reads nothing.
  assert.equal(nextEntry("app/(shop)/cart/page.js", ["apps/web"]), null);
  assert.equal(nextEntry("app/(shop)/cart/page.js", [""]), nextEntry("apps/web/app/(shop)/cart/page.tsx", ["apps/web"]));
});

test("one source file gives one file token from Turbopack, webpack, a map-relative path and GitHub", () => {
  const github = tokenOf(key, "file:apps/web/src/components/Cart.tsx");
  assert.equal(tokenOf(key, `file:${sourceName("turbopack:///[project]/src/components/Cart.tsx", "static/chunks/a.js.map", "apps/web")}`), github);
  assert.equal(tokenOf(key, `file:${sourceName("webpack://_N_E/./src/components/Cart.tsx", "static/chunks/a.js.map", "apps/web")}`), github);
  assert.equal(tokenOf(key, `file:${sourceName("../../../src/components/Cart.tsx", "server/app/page.js.map", "apps/web")}`), github);
});

test("a token holds no plaintext of its key, and a requested path is a path-side route", () => {
  for (const plain of ["fn:browser:src/app/page.tsx:Home", "file:src/app/page.tsx", "css:src/app/globals.css", "out:server/app/index.html", "route:/cart/checkout"]) {
    const token = tokenOf(key, plain);
    assert.match(token, /^(?:fn|file|css|out|route):/);
    for (const word of ["page", "Home", "globals", "index", "cart", "checkout"]) assert.doesNotMatch(token, new RegExp(word, "i"));
  }
  assert.equal(pathToken(key, "/orders/:id"), `route:/${segmentId(key, "orders")}/:id`);
  assert.throws(() => tokenOf(key, "pkg:left-pad"));
});

test("a table's read and write share one id; only the prefix says which", () => {
  const read = tokenOf(key, "table:r:orders");
  const write = tokenOf(key, "table:w:orders");
  assert.equal(read.slice("table:r:".length), write.slice("table:w:".length));
  assert.equal(read, `table:r:${keyedId(key, "table", "orders")}`);
  assert.notEqual(tokenOf(key, "table:w:order_items").slice(8), write.slice(8));
});
