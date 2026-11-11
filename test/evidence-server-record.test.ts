/** A recording's invocations: ambient first, then one per spec file; each test holds its file's footprint (PQA-3201 PR 3). */
import { test } from "node:test";
import assert from "node:assert/strict";
import { pathToFileURL } from "node:url";

import { fingerprintBuild } from "../src/evidence/fingerprint/rules";
import type { InvocationCoverage } from "../src/evidence/server/rules";
import { recordServer, specFilter, type Invoke } from "../src/evidence/server/record";
import { BASE, nextBuild } from "./support/next-build";

const build = nextBuild(BASE);
const fingerprint = fingerprintBuild({ files: [...build.keys()], read: (f) => build.get(f) ?? null, sourcePrefix: "" });
const NEXT = "/work/app/.next";
const SSR = `server/chunks/ssr/${BASE.hash}s1.js`;
const at = (suffix: string) => fingerprint.scripts.get(SSR)!.spans.find((s) => s.key?.endsWith(suffix))!;

const ran = (...names: string[]): InvocationCoverage => ({
  started: [1],
  taken: [1],
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
    app,
    specs: ["/work/app/tests/a.spec.ts", "/work/app/tests/b.spec.ts"],
    preload: "/dist/evidence-preload.js",
    coverageDir: "/tmp/cov",
    scripts: fingerprint.scripts,
    nextDir: NEXT,
    runTests: async (spec) => {
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
    app,
    specs: ["/s/a.spec.ts", "/s/b.spec.ts"],
    preload: "/p",
    coverageDir: "/c",
    scripts: fingerprint.scripts,
    nextDir: NEXT,
    runTests: async (spec) => {
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
