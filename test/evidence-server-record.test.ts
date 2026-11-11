/** A recording's invocations: ambient first, then one per spec file; each test holds its file's footprint (PQA-3201 PR 3). */
import { test } from "node:test";
import assert from "node:assert/strict";
import { pathToFileURL } from "node:url";

import { fingerprintBuild } from "../src/evidence/fingerprint/rules";
import type { InvocationCoverage } from "../src/evidence/server/rules";
import { groupsOf, recordServer, specFilter, type Invoke } from "../src/evidence/server/record";
import { BASE, nextBuild } from "./support/next-build";

const build = nextBuild(BASE);
const fingerprint = fingerprintBuild({ files: [...build.keys()], read: (f) => build.get(f) ?? null, sourcePrefix: "" });
const NEXT = "/work/app/.next";
const SSR = `server/chunks/ssr/${BASE.hash}s1.js`;
const at = (suffix: string) => fingerprint.scripts.get(SSR)!.spans.find((s) => s.key?.endsWith(suffix))!;

const ran = (...names: string[]): InvocationCoverage => ({
  started: [1],
  taken: [1],
  covered: [1],
  unreadable: 0,
  problems: [],
  files: [{ result: [{ url: pathToFileURL(`${NEXT}/${SSR}`).href, functions: names.map((n) => ({ functionName: n, ranges: [{ startOffset: at(`:${n}`).start, endOffset: at(`:${n}`).end, count: 1 }] })) }] }],
});

const app = { start: "next start", readyUrl: "http://127.0.0.1:3000", reset: null, cwd: "/work/app", env: {} };

test("ambient, then each spec file once; a test holds the footprint of the invocation it ran in", async () => {
  const seen: string[] = [];
  const ids: Array<{ testId: string; file: string }> = [];
  const coverageFor: Record<string, InvocationCoverage> = { ambient: ran("LoginForm"), "a.spec.ts": ran("onSuccess"), "b.spec.ts": ran("Badge") };
  const invoke: Invoke = async (_app, options, tests) => {
    const exitCode = await tests();
    return { exitCode, coverage: coverageFor[options.kind === "ambient" ? "ambient" : seen.at(-1)!]! };
  };
  const result = await recordServer({
    perRun: 1,
    app,
    specs: ["/work/app/tests/a.spec.ts", "/work/app/tests/b.spec.ts"],
    preload: "/dist/evidence-preload.js",
    coverageDir: "/tmp/cov",
    scripts: fingerprint.scripts,
    nextDir: NEXT,
    runTests: async (files) => {
      const spec = files?.[0] ?? null;
      seen.push(spec === null ? "ambient" : spec.split("/").at(-1)!);
      if (spec?.endsWith("a.spec.ts")) ids.push({ testId: "a1", file: spec }, { testId: "a2", file: spec }, { testId: "a2", file: spec });
      if (spec?.endsWith("b.spec.ts")) ids.push({ testId: "b1", file: spec });
      return spec?.endsWith("b.spec.ts") ? 1 : 0;
    },
    attempts: () => [...ids],
    invoke,
  });
  assert.deepEqual(seen, ["ambient", "a.spec.ts", "b.spec.ts"]);
  assert.equal(result.exitCode, 1);
  assert.ok(result.server.ambient.keys.includes("fn:server:src/app/login/LoginForm.tsx:LoginForm"));
  assert.deepEqual([...result.server.byTest.keys()].sort(), ["a1", "a2", "b1"]);
  assert.ok(result.server.byTest.get("a2")!.keys.includes("fn:server:src/app/login/LoginForm.tsx:onSuccess"));
  assert.ok(result.server.byTest.get("b1")!.keys.includes("fn:server:src/components/common/Badge.tsx:Badge"));
  assert.ok(!result.server.byTest.get("b1")!.keys.includes("fn:server:src/app/login/LoginForm.tsx:onSuccess"));
});

test("a test recorded in another file's invocation is unknown: that invocation's app served more than its file", async () => {
  // A filter that selected too much: a's invocation also ran b's test, whose own invocation then wrote nothing new.
  const ids: Array<{ testId: string; file: string | null }> = [];
  const result = await recordServer({
    perRun: 1,
    app,
    specs: ["/s/a.spec.ts", "/s/b.spec.ts"],
    preload: "/p",
    coverageDir: "/c",
    scripts: fingerprint.scripts,
    nextDir: NEXT,
    runTests: async (files) => {
      const spec = files?.[0] ?? null;
      if (spec === "/s/a.spec.ts") ids.push({ testId: "a1", file: "/s/a.spec.ts" }, { testId: "b1", file: "/s/b.spec.ts" }, { testId: "x1", file: null });
      return 0;
    },
    attempts: () => [...ids],
    invoke: async (_a, _o, tests) => ({ exitCode: await tests(), coverage: ran("Badge") }),
  });
  assert.deepEqual(result.server.byTest.get("a1")!.partial, []);
  for (const id of ["b1", "x1"]) assert.deepEqual([result.server.byTest.get(id)!.partial, result.server.byTest.get(id)!.reasons], [["code"], ["other_invocation"]], id);
});

test("the spec filter selects exactly that file: its path, anchored, every regex character literal", () => {
  const filter = new RegExp(specFilter("/work/app/tests/[id]/a+b.spec.ts"), "gi");
  assert.ok(filter.test("/work/app/tests/[id]/a+b.spec.ts"));
  filter.lastIndex = 0;
  assert.ok(!filter.test("/work/app/tests/[id]/a+b.spec.ts.bak"));
  filter.lastIndex = 0;
  assert.ok(!filter.test("/work/app/tests/i/aab.spec.ts"));
  assert.ok(!/^(.*?):(\d+):?(\d+)?$/.test(specFilter("/w/a.spec.ts")), "never read as a file:line location");
});

test("once a run changed the build directory, every later run's footprint is unknown: it may have served what that one wrote", async () => {
  const ids: Array<{ testId: string; file: string | null }> = [];
  const settled = [{ created: [], changed: [] }, { created: ["server/app/x.html"], changed: [] }, { created: [], changed: ["server/app/old.html"] }, { created: [], changed: [] }];
  let call = 0;
  const result = await recordServer({
    perRun: 1,
    app,
    specs: ["/s/a.spec.ts", "/s/b.spec.ts", "/s/c.spec.ts"],
    preload: "/p",
    coverageDir: "/c",
    scripts: fingerprint.scripts,
    nextDir: NEXT,
    runTests: async (files) => {
      const spec = files?.[0] ?? null;
      if (spec) ids.push({ testId: spec.slice(3, 4), file: spec });
      return 0;
    },
    attempts: () => [...ids],
    invoke: async (_a, _o, tests) => ({ exitCode: await tests(), coverage: ran("Badge") }),
    buildDir: { snapshot: () => undefined, settle: () => settled[call++]! },
  });
  // ambient clean; a's run only created (removed): b clean; b's run rewrote a built file: c unknown.
  assert.deepEqual(["a", "b", "c"].map((id) => result.server.byTest.get(id)!.reasons), [[], [], ["build_dir_changed"]]);
  assert.deepEqual(result.server.ambient.reasons, []);
});

test("the preload is the action's, never the app's: its own code doesn't make a run unknown", async () => {
  const preload = "/runner/_actions/peeps-action/dist/evidence-preload.js";
  const withPreload: InvocationCoverage = { ...ran("Badge"), files: [...ran("Badge").files, { result: [{ url: pathToFileURL(preload).href, functions: [{ functionName: "take", ranges: [{ startOffset: 3, endOffset: 40, count: 1 }] }] }] }] };
  const ids: Array<{ testId: string; file: string | null }> = [];
  const result = await recordServer({
    perRun: 1,
    app,
    specs: ["/s/a.spec.ts"],
    preload,
    coverageDir: "/c",
    scripts: fingerprint.scripts,
    nextDir: NEXT,
    runTests: async (files) => (files && ids.push({ testId: "a", file: files[0]! }), 0),
    attempts: () => [...ids],
    invoke: async (_a, _o, tests) => ({ exitCode: await tests(), coverage: withPreload }),
    buildDir: { snapshot: () => undefined, settle: () => ({ created: [], changed: [] }) },
  });
  assert.deepEqual([result.server.ambient.reasons, result.server.byTest.get("a")!.reasons], [[], []]);
});

test("files go into runs of a fixed size, in order", () => {
  assert.deepEqual(groupsOf(["a", "b", "c", "d", "e"], 2), [["a", "b"], ["c", "d"], ["e"]]);
  assert.deepEqual(groupsOf(["a", "b"], 1), [["a"], ["b"]]);
});

test("two files per run: both files' tests hold that run's footprint, and only theirs", async () => {
  const ids: Array<{ testId: string; file: string | null }> = [];
  const seen: string[][] = [];
  const coverageFor = [ran("onSuccess"), ran("Badge")];
  let call = 0;
  const result = await recordServer({
    app,
    specs: ["/s/a.spec.ts", "/s/b.spec.ts", "/s/c.spec.ts"],
    perRun: 2,
    preload: "/p",
    coverageDir: "/c",
    scripts: fingerprint.scripts,
    nextDir: NEXT,
    runTests: async (files) => {
      if (files) {
        seen.push(files);
        for (const file of files) ids.push({ testId: file.slice(3, 4), file });
      }
      return 0;
    },
    attempts: () => [...ids],
    invoke: async (_a, options, tests) => ({ exitCode: await tests(), coverage: options.kind === "ambient" ? ran() : coverageFor[call++]! }),
    buildDir: { snapshot: () => undefined, settle: () => ({ created: [], changed: [] }) },
  });
  assert.deepEqual(seen, [["/s/a.spec.ts", "/s/b.spec.ts"], ["/s/c.spec.ts"]]);
  const has = (id: string, suffix: string) => result.server.byTest.get(id)!.keys.some((k) => k.endsWith(suffix));
  assert.ok(has("a", ":onSuccess") && has("b", ":onSuccess") && !has("a", ":Badge"));
  assert.ok(has("c", ":Badge") && !has("c", ":onSuccess"));
});

test("a run's coverage is mapped while the next run's tests run, never while its app starts", async () => {
  const order: string[] = [];
  const ids: Array<{ testId: string; file: string | null }> = [];
  await recordServer({
    perRun: 1,
    app,
    specs: ["/s/a.spec.ts", "/s/b.spec.ts"],
    preload: "/p",
    coverageDir: "/c",
    scripts: fingerprint.scripts,
    nextDir: NEXT,
    runTests: async (files) => {
      if (files) ids.push({ testId: files[0]!, file: files[0]! });
      order.push(`tests ${files?.[0] ?? "ambient"}`);
      await new Promise((r) => setTimeout(r, 50));
      return 0;
    },
    attempts: () => [...ids],
    invoke: async (_a, options, tests) => {
      options.whileStarting?.();
      order.push(`started ${options.kind}`);
      const exitCode = await tests();
      return { exitCode, read: () => (order.push("mapped"), ran("Badge")) };
    },
    buildDir: { snapshot: () => undefined, settle: () => ({ created: [], changed: [] }) },
  });
  // ambient's map waits for a's tests, a's for b's; b's after the last run.
  assert.deepEqual(order, ["started ambient", "tests ambient", "started spec", "tests /s/a.spec.ts", "mapped", "started spec", "tests /s/b.spec.ts", "mapped", "mapped"]);
});
