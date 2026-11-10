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
