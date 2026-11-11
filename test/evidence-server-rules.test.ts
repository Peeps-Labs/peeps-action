/** One invocation's server coverage onto the fingerprint's keys (PQA-3201 PR 3), and when it can't be read whole. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { pathToFileURL } from "node:url";

import { fingerprintBuild } from "../src/evidence/fingerprint/rules";
import { serverFootprint, type InvocationCoverage, type V8Script } from "../src/evidence/server/rules";
import { BASE, nextBuild } from "./support/next-build";

const build = nextBuild(BASE);
const fingerprint = fingerprintBuild({ files: [...build.keys()], read: (f) => build.get(f) ?? null, sourcePrefix: "" });
const NEXT = "/work/app/.next";
const SSR = `server/chunks/ssr/${BASE.hash}s1.js`;
const url = (rel: string) => pathToFileURL(`${NEXT}/${rel}`).href;
const span = (file: string, suffix: string) => fingerprint.scripts.get(file)!.spans.find((s) => s.key?.endsWith(suffix))!;
const onSuccess = span(SSR, ":onSuccess");
const badge = span(SSR, ":Badge");

const fn = (name: string, start: number, end: number, count = 1) => ({ functionName: name, ranges: [{ startOffset: start, endOffset: end, count }] });
const script = (rel: string, functions: V8Script["functions"]): V8Script => ({ url: url(rel), functions });
const invocation = (scripts: V8Script[], over: Partial<InvocationCoverage> = {}): InvocationCoverage => ({
  started: [101],
  taken: [101],
  covered: [101],
  files: [{ result: scripts }],
  unreadable: 0,
  problems: [],
  ...over,
});

test("a server function that ran: its key and its file's; every source of the script is loaded", () => {
  const result = serverFootprint(invocation([script(SSR, [fn("", 0, 900), fn("onSuccess", onSuccess.start, onSuccess.end), fn("Badge", badge.start, badge.end, 0)])]), fingerprint.scripts, NEXT);
  assert.deepEqual(result.keys, ["file:src/app/login/LoginForm.tsx", "fn:server:src/app/login/LoginForm.tsx:onSuccess"]);
  assert.deepEqual(result.loaded, ["file:src/app/login/LoginForm.tsx", "file:src/components/common/Badge.module.css", "file:src/components/common/Badge.tsx"]);
  assert.deepEqual([result.partial, result.reasons], [[], []]);
});

test("functions ran in any take of any process count: each take resets V8's counters", () => {
  const first = { result: [script(SSR, [fn("onSuccess", onSuccess.start, onSuccess.end, 0)])] };
  const second = { result: [script(SSR, [fn("onSuccess", onSuccess.start, onSuccess.end, 2)])] };
  const result = serverFootprint(invocation([], { started: [101, 102], taken: [101, 102], covered: [101, 102], files: [first, second] }), fingerprint.scripts, NEXT);
  assert.ok(result.keys.includes("fn:server:src/app/login/LoginForm.tsx:onSuccess"));
  assert.deepEqual(result.partial, []);
});

test("what isn't the job's own build is the runtime: neither keyed nor partial", () => {
  const elsewhere = { url: "file:///work/app/node_modules/next/dist/server/next.js", functions: [fn("start", 10, 20)] };
  const internal = { url: "node:internal/main", functions: [fn("run", 1, 2)] };
  const sibling = { url: pathToFileURL(`/work/app/.next-other/${SSR}`).href, functions: [fn("onSuccess", onSuccess.start, onSuccess.end)] };
  const result = serverFootprint(invocation([elsewhere, internal]), fingerprint.scripts, NEXT);
  assert.deepEqual([result.keys, result.loaded, result.partial], [[], [], []]);
  // Another directory of the app, tracked, that no fingerprint names: no one's, never partial.
  const beside = serverFootprint(invocation([sibling]), fingerprint.scripts, NEXT, new Set(), () => true);
  assert.deepEqual([beside.keys, beside.reasons], [[], []]);
});

test("a script whose whole is its key: the key, run or loaded", () => {
  const manifest = "server/app/sso/page_client-reference-manifest.js";
  const result = serverFootprint(invocation([script(manifest, [fn("anon", 5, 9)])]), fingerprint.scripts, NEXT);
  assert.deepEqual([result.keys, result.loaded], [[`out:${manifest}`], [`out:${manifest}`]]);
});

test("a whole script whose only code is its top level still ran: its key", () => {
  const manifest = "server/app/sso/page_client-reference-manifest.js";
  const result = serverFootprint(invocation([script(manifest, [fn("", 0, 120)])]), fingerprint.scripts, NEXT);
  assert.deepEqual(result.keys, [`out:${manifest}`]);
});

test("chunk scaffolding runs and is no one's code", () => {
  const page = "server/app/sso/page.js";
  const scaffold = fingerprint.scripts.get(page)!.spans.find((s) => s.key === null)!;
  const result = serverFootprint(invocation([script(page, [fn("", scaffold.start, scaffold.end)])]), fingerprint.scripts, NEXT);
  assert.deepEqual([result.keys, result.partial], [[], []]);
});

const partialOf = (over: Partial<InvocationCoverage>, scripts: V8Script[] = []) => {
  const result = serverFootprint(invocation(scripts, over), fingerprint.scripts, NEXT);
  return [result.partial, result.reasons];
};

test("unknown is partial: no process, a process whose coverage wasn't taken, an unreadable file", () => {
  assert.deepEqual(partialOf({ started: [], taken: [], files: [] }), [["code"], ["no_process"]]);
  assert.deepEqual(partialOf({ started: [101, 102], taken: [101] }), [["code"], ["not_taken", "no_coverage"]]);
  assert.deepEqual(partialOf({ unreadable: 1 }), [["code"], ["unreadable"]]);
});

test("a ran function in the build that no key names is partial, as is a built script the fingerprint doesn't index", () => {
  assert.deepEqual(partialOf({}, [script(SSR, [fn("ghost", 1, 3)])]), [["code"], ["unmapped"]]);
  assert.deepEqual(partialOf({}, [script("server/chunks/unknown.js", [fn("x", 1, 3)])]), [["code"], ["unmapped"]]);
});

test("what went wrong around the app (a reset, readiness, an early exit) is partial and named", () => {
  assert.deepEqual(partialOf({ problems: ["not_ready", "reset_failed"] }), [["code"], ["not_ready", "reset_failed"]]);
});

test("workspace code the server ran outside the build: a fingerprinted source holds its file; anything else is no one's (a change to it runs everything)", () => {
  const ran = (rel: string) => ({ url: pathToFileURL(`/work/app/${rel}`).href, functions: [fn("handle", 3, 40)] });
  const sources = new Set(["app/src/lib/csp.ts", "app/src/app/api/me/route.ts"]);
  // A custom server running source the build also bundles, and next.config's own import.
  const custom = serverFootprint(invocation([ran("src/app/api/me/route.ts"), ran("src/lib/csp.ts")]), fingerprint.scripts, NEXT, sources);
  assert.deepEqual([custom.keys, custom.loaded, custom.partial], [["file:app/src/app/api/me/route.ts", "file:app/src/lib/csp.ts"], ["file:app/src/app/api/me/route.ts", "file:app/src/lib/csp.ts"], []]);
  // Tracked, not fingerprinted: no key, and nothing partial.
  const other = serverFootprint(invocation([ran("next.config.compiled.js"), ran("server/socket.js"), ran("node_modules/pg/lib/client.js")]), fingerprint.scripts, NEXT, sources, () => true);
  assert.deepEqual([other.keys, other.partial], [[], []]);
  // Loaded, nothing ran: loaded only.
  const idle = serverFootprint(invocation([{ url: pathToFileURL("/work/app/src/lib/csp.ts").href, functions: [fn("idle", 3, 40, 0)] }]), fingerprint.scripts, NEXT, sources);
  assert.deepEqual([idle.keys, idle.loaded], [[], ["file:app/src/lib/csp.ts"]]);
});

test("a monorepo sibling the server ran is held by its file too: sources are repo-relative, wherever the app sits", () => {
  const sibling = { url: pathToFileURL("/work/packages/shared/index.ts").href, functions: [fn("share", 3, 40)] };
  const result = serverFootprint(invocation([sibling]), fingerprint.scripts, NEXT, new Set(["packages/shared/index.ts"]));
  assert.deepEqual([result.keys, result.partial], [["file:packages/shared/index.ts"], []]);
});

test("a process whose take wrote no coverage file is partial, whatever its marker says (an app that stopped coverage itself)", () => {
  assert.deepEqual(partialOf({ started: [101, 102], taken: [101, 102], covered: [101] }), [["code"], ["no_coverage"]]);
});

test("code the server ran that git doesn't track and the fingerprint doesn't name (a compiled custom server's dist/) is unknown: partial", () => {
  const ran = (abs: string) => ({ url: pathToFileURL(abs).href, functions: [fn("handle", 3, 40)] });
  const tracked = (file: string) => file === "/work/app/server/socket.ts";
  const sources = new Set(["app/src/lib/auth.ts"]);
  const compiled = serverFootprint(invocation([ran("/work/app/dist/src/lib/auth.js")]), fingerprint.scripts, NEXT, sources, tracked);
  assert.deepEqual([compiled.keys, compiled.reasons], [[], ["outside_build"]]);
  // Tracked, not fingerprinted: a change to it is a file no entity accounts for, which runs everything.
  const socket = serverFootprint(invocation([ran("/work/app/server/socket.ts")]), fingerprint.scripts, NEXT, sources, tracked);
  assert.deepEqual([socket.keys, socket.reasons], [[], []]);
  // Next compiles its own config next to it, untracked: a config change runs everything anyway.
  const config = serverFootprint(invocation([ran("/work/app/next.config.compiled.js"), ran("/work/app/next.config.mjs")]), fingerprint.scripts, NEXT, sources, tracked);
  assert.deepEqual(config.reasons, []);
});

test("a built script the fingerprint doesn't index ran, even only its top level: unmapped", () => {
  assert.deepEqual(partialOf({}, [script("server/chunks/late.js", [fn("", 0, 50)])]), [["code"], ["unmapped"]]);
});
