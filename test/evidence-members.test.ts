/** Each attempt's records joined into members, and the universe from what the collectors really saw. */
import { test } from "node:test";
import assert from "node:assert/strict";

import type { AttemptFile } from "../src/evidence/browser/worker";
import { fingerprintBuild } from "../src/evidence/fingerprint/rules";
import { membersOf as membersOfAll, type AttemptRecord, type ContextMarker } from "../src/evidence/members";
import { BASE, nextBuild } from "./support/next-build";

const build = nextBuild(BASE);
const fingerprint = fingerprintBuild({ files: [...build.keys()], read: (f) => build.get(f) ?? null, sourcePrefix: "" });
const CHUNK = `http://127.0.0.1:3000/_next/static/chunks/${BASE.hash}c2.js`;
const { spans } = fingerprint.scripts.get(`static/chunks/${BASE.hash}c2.js`)!;
const formatDate = spans.find((s) => s.key?.endsWith(":formatDate"))!;

const coverageFile = (testId: string, retry: number, ran = true, contextId = `${testId}-${retry}`): AttemptFile => ({
  testId,
  retry,
  contextId,
  browser: { name: "chromium", version: "147.0.1" },
  coverage: {
    browser: "chromium",
    scripts: ran ? [{ url: CHUNK, functions: [{ name: "formatDate", start: formatDate.start, end: formatDate.end }] }] : [],
    sheets: [],
    assets: [CHUNK],
    covered: [CHUNK],
    lost: 0,
    errors: [],
    navigations: 0,
  },
});
/** Each coverage file's own context, announced as the worker announces it. */
const membersOf = (records: AttemptRecord[], files: AttemptFile[], fp: typeof fingerprint, collected: { coverage: boolean; har: boolean }, contexts?: ContextMarker[]) =>
  membersOfAll(records, files, fp, collected, contexts ?? files.map(({ testId, retry, contextId }) => ({ testId, retry, contextId })));
const record = (testId: string, runId: string, retry: number, passed: boolean, paths: string[] | null = ["/cart"]): AttemptRecord => ({
  testId,
  runId,
  retry,
  passed,
  har: paths && { paths, complete: true },
});

test("a member per run: its attempts, its coverage keys and its paths", () => {
  const result = membersOf(
    [record("t1", "run-1", 0, false), record("t1", "run-1", 1, true), record("t2", "run-2", 0, true, ["/api"])],
    [coverageFile("t1", 0), coverageFile("t1", 1), coverageFile("t2", 0, false)],
    fingerprint,
    { coverage: true, har: true },
  );
  assert.deepEqual(result.measured, ["code", "css", "route"]);
  assert.deepEqual(result.layers, ["browser"]);
  const one = result.members.find((m) => m.run === "run-1")!;
  assert.deepEqual(one.attempts, [{ retry: 0, passed: false }, { retry: 1, passed: true }]);
  const union = one.evidence.flatMap((e) => e.keys);
  assert.ok(union.includes("fn:browser:src/lib/date.ts:formatDate") && union.includes("file:src/lib/date.ts"));
  assert.deepEqual([...new Set(one.evidence.flatMap((e) => e.paths))], ["/cart"]);
  assert.ok(one.evidence.every((e) => e.partial.length === 0), JSON.stringify(one.evidence));
});

test("loaded files: every source of every script an attempt loaded, run or not", () => {
  const result = membersOf([record("t2", "run-2", 0, true)], [coverageFile("t2", 0, false)], fingerprint, { coverage: true, har: true });
  assert.deepEqual(result.loadedFiles, ["file:src/lib/date.ts"]);
  assert.deepEqual(result.ambient, []);
});

test("an attempt without its coverage file reads partial for code and CSS; without its HAR, for routes", () => {
  const result = membersOf([record("t3", "run-3", 0, true, null)], [], fingerprint, { coverage: true, har: true });
  const [member] = result.members;
  assert.deepEqual([...new Set(member!.evidence.flatMap((e) => e.partial))].sort(), ["code", "css", "route"]);
});

test("what wasn't collected isn't claimed measured: no HAR, no route", () => {
  const result = membersOf([record("t1", "run-1", 0, true, null)], [coverageFile("t1", 0)], fingerprint, { coverage: true, har: false });
  assert.deepEqual(result.measured, ["code", "css"]);
  assert.ok(result.members[0]!.evidence.every((e) => !e.partial.includes("route")));
  const none = membersOf([record("t1", "run-1", 0, true)], [], fingerprint, { coverage: false, har: true });
  assert.deepEqual([none.measured, none.loadedFiles], [["route"], []]);
});

test("the browser that recorded: one name and version, or null when legs differ", () => {
  const result = membersOf([record("t1", "run-1", 0, true)], [coverageFile("t1", 0)], fingerprint, { coverage: true, har: true });
  assert.deepEqual(result.browser, { name: "chromium", version: "147.0.1" });
  const mixed = membersOf([record("t1", "run-1", 0, true), record("t2", "run-2", 0, true)], [coverageFile("t1", 0), { ...coverageFile("t2", 0), browser: { name: "chromium", version: "148.0.0" } }], fingerprint, { coverage: true, har: true });
  assert.equal(mixed.browser, null);
});

test("an attempt that opened two contexts is whole only with both contexts' final records", () => {
  const both = membersOf([record("t1", "run-1", 0, true)], [coverageFile("t1", 0, true, "c1"), coverageFile("t1", 0, true, "c2")], fingerprint, { coverage: true, har: true });
  assert.ok(both.members[0]!.evidence.every((e) => e.partial.length === 0));
  const markers = [{ testId: "t1", retry: 0, contextId: "c1" }, { testId: "t1", retry: 0, contextId: "c2" }];
  const one = membersOf([record("t1", "run-1", 0, true)], [coverageFile("t1", 0, true, "c1")], fingerprint, { coverage: true, har: true }, markers);
  const partial = one.members[0]!.evidence.filter((e) => e.partial.length > 0);
  assert.deepEqual(partial.map((e) => [e.partial, e.reasons]), [[["code", "css"], ["context_unfinished"]]]);
});

test("a tainted attempt (a context marker that never landed) is partial, whatever records did land", () => {
  const result = membersOfAll([record("t1", "run-1", 0, true)], [coverageFile("t1", 0, true, "c1")], fingerprint, { coverage: true, har: true }, [{ testId: "t1", retry: 0, contextId: "c1" }], [{ testId: "t1", retry: 0 }]);
  const partial = result.members[0]!.evidence.filter((e) => e.partial.length > 0);
  assert.deepEqual(partial.map((e) => e.reasons), [["marker_failed"]]);
});

test("loaded files are only ever file: keys, and ambient stays empty (contract §4)", () => {
  const result = membersOf([record("t1", "run-1", 0, true), record("t2", "run-2", 0, true)], [coverageFile("t1", 0), coverageFile("t2", 0, false)], fingerprint, { coverage: true, har: true });
  assert.ok(result.loadedFiles.length > 0);
  assert.ok(result.loadedFiles.every((key) => key.startsWith("file:")), result.loadedFiles.join(", "));
  assert.deepEqual(result.ambient, []);
});

// PQA-3201 PR 3: each spec file's invocation owned the app, so its server footprint is each of its tests'.
const serverFp = (keys: string[], loaded: string[] = [], reasons: string[] = []) => ({ keys, loaded, partial: reasons.length > 0 ? (["code"] as const).slice() : [], reasons });
const AMBIENT = serverFp(["file:src/app/api/heartbeat/route.ts", "fn:server:src/app/api/heartbeat/route.ts:GET"], ["file:src/app/api/heartbeat/route.ts", "file:src/lib/db.ts"]);

test("server evidence: each test holds its invocation's footprint; ambient and loaded files fill the universe", () => {
  const result = membersOfAll(
    [record("t1", "run-1", 0, true), record("t2", "run-2", 0, true)],
    [],
    fingerprint,
    { coverage: false, har: false },
    [],
    [],
    {
      ambient: AMBIENT,
      byTest: new Map([
        ["t1", serverFp(["file:src/app/api/me/route.ts", "fn:server:src/app/api/me/route.ts:GET"], ["file:src/app/api/me/route.ts"])],
        ["t2", serverFp([], ["file:src/app/api/segments/route.ts"])],
      ]),
    },
  );
  assert.deepEqual(result.layers, ["server"]);
  assert.deepEqual(result.measured, ["code"]);
  assert.deepEqual(result.ambient, ["file:src/app/api/heartbeat/route.ts", "fn:server:src/app/api/heartbeat/route.ts:GET"]);
  assert.deepEqual(result.loadedFiles, ["file:src/app/api/heartbeat/route.ts", "file:src/app/api/me/route.ts", "file:src/app/api/segments/route.ts", "file:src/lib/db.ts"]);
  const one = result.members.find((m) => m.run === "run-1")!;
  assert.deepEqual(one.evidence.flatMap((e) => e.keys).sort(), ["file:src/app/api/me/route.ts", "fn:server:src/app/api/me/route.ts:GET"]);
  assert.ok(result.members.every((m) => m.evidence.every((e) => e.partial.length === 0)));
});

test("server evidence beside browser coverage: both layers, code measured once", () => {
  const result = membersOfAll([record("t1", "run-1", 0, true)], [coverageFile("t1", 0)], fingerprint, { coverage: true, har: false }, [{ testId: "t1", retry: 0, contextId: "t1-0" }], [], { ambient: AMBIENT, byTest: new Map([["t1", serverFp([])]]) });
  assert.deepEqual([result.layers, result.measured], [["browser", "server"], ["code", "css"]]);
});

test("a test whose invocation left no server footprint, or whose own is partial, reads partial for code", () => {
  const result = membersOfAll([record("t1", "run-1", 0, true), record("t2", "run-2", 0, true)], [], fingerprint, { coverage: false, har: false }, [], [], {
    ambient: AMBIENT,
    byTest: new Map([["t2", serverFp(["file:a.ts"], [], ["not_taken"])]]),
  });
  const of = (run: string) => result.members.find((m) => m.run === run)!.evidence;
  assert.deepEqual([of("run-1").flatMap((e) => e.partial), of("run-1").flatMap((e) => e.reasons)], [["code"], ["server_missing"]]);
  assert.deepEqual([of("run-2").flatMap((e) => e.partial), of("run-2").flatMap((e) => e.reasons)], [["code"], ["server_not_taken"]]);
});

test("a partial ambient invocation leaves every test partial for code: what every test shares is unknown", () => {
  const result = membersOfAll([record("t1", "run-1", 0, true)], [], fingerprint, { coverage: false, har: false }, [], [], {
    ambient: serverFp([], [], ["not_ready"]),
    byTest: new Map([["t1", serverFp(["file:a.ts"])]]),
  });
  const evidence = result.members[0]!.evidence;
  assert.ok(evidence.some((e) => e.partial.includes("code") && e.reasons.includes("ambient_not_ready")), JSON.stringify(evidence));
});

test("no server evidence without browser coverage: code is never claimed measured for a layer nobody measured", () => {
  // HAR on, browser coverage refused (a suite running precise coverage itself): routes only, as before.
  const result = membersOfAll([record("t1", "run-1", 0, true)], [], fingerprint, { coverage: false, har: true }, [], [], { ambient: AMBIENT, byTest: new Map([["t1", serverFp(["file:a.ts"])]]) });
  assert.deepEqual([result.layers, result.measured, result.ambient], [["browser"], ["route"], []]);
  assert.ok(result.members[0]!.evidence.every((e) => e.keys.length === 0));
});

test("each collector's partial names its layer: the browser's, the server's, ambient's (PQA-3430)", () => {
  const result = membersOfAll([record("t1", "run-1", 0, true, null), record("t2", "run-2", 0, true, null)], [], fingerprint, { coverage: true, har: false }, [], [], {
    ambient: serverFp([], [], ["not_ready"]),
    byTest: new Map([["t1", serverFp(["file:a.ts"])], ["t2", serverFp([], [], ["not_taken"])]]),
  });
  const layersOf = (run: string, reason: string) => result.members.find((m) => m.run === run)!.evidence.find((e) => e.reasons.includes(reason))!.layers;
  assert.deepEqual(layersOf("run-1", "coverage_missing"), ["browser"]);
  assert.deepEqual(layersOf("run-2", "server_not_taken"), ["server"]);
  assert.deepEqual(layersOf("run-1", "ambient_not_ready"), ["server"]);
});
