/**
 * The test-local assertion id V2 compares (CW plan §4.6): its vectors, and its two stated limits.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { assertionIdOf } from "./helpers/assertion-id";

const raw = readFileSync(path.resolve(__dirname, "fixtures/load-customer/assertion-ids.json"), "utf8");
const fixture = JSON.parse(raw.slice(raw.indexOf("\n") + 1)) as { vectors: { location: string; id: string | null }[] };

test("the vectors' first line marks them provisional", () => {
  assert.equal(raw.split("\n")[0], "status: provisional");
});

test("every vector", () => {
  for (const { location, id } of fixture.vectors) assert.equal(assertionIdOf(location), id, location);
});

test("the id is as1_ and the first 32 hex of sha256 over as1, the path and the line", () => {
  assert.equal(assertionIdOf("robots.ts:12"), `as1_${createHash("sha256").update("as1\nrobots.ts\n12").digest("hex").slice(0, 32)}`);
});

test("limit (a): a line, not an assertion; limit (b): the column is dropped", () => {
  assert.equal(assertionIdOf("robots.ts:12:5"), assertionIdOf("robots.ts:12:40"));
  assert.equal(assertionIdOf("robots.ts:12:5"), assertionIdOf("robots.ts:12"));
  assert.notEqual(assertionIdOf("robots.ts:12"), assertionIdOf("robots.ts:13"));
});

test("an absolute path, a .. or empty segment, or a line that isn't a positive integer has no id", () => {
  for (const location of ["/abs/robots.ts:12", "C:/robots.ts:12", "../robots.ts:12", "a/./b.ts:3", "a//b.ts:3", "robots.ts:0", "robots.ts:012", "robots.ts", ""]) assert.equal(assertionIdOf(location), null, location);
});
