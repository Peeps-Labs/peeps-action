/** The collection port: each collector's answer for an attempt, their union, and its tokens. */
import { test } from "node:test";
import assert from "node:assert/strict";

import { browserCollector } from "../src/evidence/browser/collector";
import { evidenceTokens, parseProjectKey, pathToken, tokenOf } from "../src/evidence/hash";
import { unionEvidence, type AttemptEvidence } from "../src/evidence/port";
import { harCollector } from "../src/footprint/collector";

const none: AttemptEvidence = { keys: [], paths: [], partial: [], reasons: [] };
const key = parseProjectKey(Buffer.alloc(32, 3).toString("hex"))!;

test("the HAR collector is a port adapter: its paths, and partial for routes when not whole", () => {
  // No trace attached: the footprint reads unknown, never empty.
  const evidence = harCollector.collect({ attempt: { attachments: [], status: "passed", retry: 0, expectedStatus: "passed" }, use: { baseURL: "http://127.0.0.1:3000" }, origins: [] });
  assert.deepEqual(evidence, { keys: [], paths: [], partial: ["route"], reasons: ["har_incomplete"] });
});

test("the browser collector is a port adapter over a fingerprint index", () => {
  const collector = browserCollector({ scripts: new Map(), sheets: new Map() });
  const evidence = collector.collect({ browser: "webkit", scripts: [], sheets: [], assets: [], covered: [], lost: 0, errors: [], navigations: 0 });
  assert.deepEqual(evidence, { keys: [], paths: [], partial: ["code", "css"], reasons: ["browser_unsupported"] });
});

test("a union keeps every key and path once, and every collector's partial", () => {
  const union = unionEvidence([
    { keys: ["fn:browser:a.ts:f", "file:a.ts"], paths: ["/cart"], partial: [], reasons: [] },
    { ...none, keys: ["file:a.ts"], paths: ["/cart", "/api/items"], partial: ["route"], reasons: ["har_incomplete"] },
    { ...none, partial: ["code", "route"], reasons: ["target_lost"] },
  ]);
  assert.deepEqual(union, {
    keys: ["file:a.ts", "fn:browser:a.ts:f"],
    paths: ["/api/items", "/cart"],
    partial: ["code", "route"],
    // Neither said which layers: every one (PQA-3430).
    layers: ["browser", "server", "worker_thread", "worker_process", "build", "database"],
    reasons: ["har_incomplete", "target_lost"],
  });
});

test("a union's partial holds for the layers its parts said, or every layer when one didn't (PQA-3430)", () => {
  const browser = { ...none, partial: ["code", "css"] as const, layers: ["browser"] as const, reasons: ["coverage_missing"] };
  const server = { ...none, keys: ["fn:server:a.ts:f", "file:a.ts"], partial: [], layers: ["server"] as const, reasons: [] };
  assert.deepEqual(unionEvidence([{ ...browser, partial: [...browser.partial], layers: [...browser.layers] }, { ...server, partial: [], layers: [...server.layers] }]).layers, ["browser"], "a whole part adds no layer");
  assert.deepEqual(unionEvidence([{ ...none, partial: ["code"], layers: ["server"] }, { ...none, partial: ["css"], layers: ["browser"] }]).layers, ["browser", "server"]);
  assert.equal(unionEvidence([{ ...none, keys: ["file:a.ts"] }]).layers, undefined, "nothing partial, no layers");
});

test("an attempt's tokens: its keys matcher-free, its paths path-side, sorted and unique", () => {
  const tokens = evidenceTokens(key, { keys: ["file:a.ts", "fn:browser:a.ts:f"], paths: ["/orders/:id", "/orders/:id"] });
  assert.deepEqual(tokens, [tokenOf(key, "file:a.ts"), tokenOf(key, "fn:browser:a.ts:f"), pathToken(key, "/orders/:id")].sort());
});
