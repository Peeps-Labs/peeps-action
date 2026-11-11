/** Spike 2's change table on a small Next build: each change gives exactly its entities, and a rebuild none. */
import { test } from "node:test";
import assert from "node:assert/strict";

import { decodeMappings } from "../src/evidence/fingerprint/source-map";
import { diffFingerprints, fingerprintBuild, sourceName, type Fingerprint } from "../src/evidence/fingerprint/rules";
import { BASE, encodeMappings, nextBuild, type BuildSource } from "./support/next-build";

function fingerprint(change: Partial<BuildSource> = {}, sourcePrefix = ""): Fingerprint {
  const files = nextBuild({ ...BASE, ...change });
  return fingerprintBuild({ files: [...files.keys()], read: (file) => files.get(file) ?? null, sourcePrefix });
}

const base = fingerprint();
const changed = (change: Partial<BuildSource>) => diffFingerprints(base, fingerprint(change)).sort();

test("source maps decode to absolute segments", () => {
  const lines = [[[0, 0, 0, 0], [6, 0, 0, 6]], [], [[2, 1, 4, 3]]] as Array<Array<[number, number, number, number]>>;
  assert.deepEqual(decodeMappings(encodeMappings(lines)), lines);
});

test("a rebuild, with a new build id and renamed chunks, changes nothing", () => {
  assert.deepEqual(changed({ buildId: "build-two", hash: "e5f6a7b8" }), []);
});

test("modules regrouped in a chunk change nothing: functions have no ordinal", () => {
  assert.deepEqual(changed({ reordered: true, hash: "e5f6a7b8" }), []);
});

test("(a) a line inside a client component's function: its client copy and its SSR copy", () => {
  assert.deepEqual(changed({ loginOnSuccess: "sessionStorage.setItem('token-v2', response.token);" }), [
    "fn:browser:src/app/login/LoginForm.tsx:onSuccess",
    "fn:server:src/app/login/LoginForm.tsx:onSuccess",
  ]);
});

test("(b) a heading in a server component: its function", () => {
  assert.deepEqual(changed({ ssoHeading: "Single sign-on" }), ["fn:server:src/app/sso/page.tsx:SSOPage"]);
});

test("(b′) the same page prerendered: the function, its outputs and the prerender manifest", () => {
  const before = fingerprint({ ssoStatic: true });
  assert.deepEqual(diffFingerprints(before, fingerprint({ ssoStatic: true, ssoHeading: "Single sign-on" })).sort(), [
    "fn:server:src/app/sso/page.tsx:SSOPage",
    "out:prerender-manifest.json",
    "out:server/app/sso.html",
    "out:server/app/sso.rsc",
  ]);
});

test("(c) a value in a CSS module: that stylesheet section", () => {
  assert.deepEqual(changed({ badgeColor: "#166534" }), ["css:src/components/common/Badge.module.css"]);
});

test("(c2) a new class used by its component: the section, the component and the class map, client and SSR", () => {
  assert.deepEqual(changed({ badgeSpike: true }), [
    "css:src/components/common/Badge.module.css",
    "fn:browser:src/components/common/Badge.module.css:[project]/src/components/common/Badge.module.css [client] (css module)",
    "fn:browser:src/components/common/Badge.tsx:Badge",
    "fn:server:src/components/common/Badge.module.css:[project]/src/components/common/Badge.module.css [ssr] (css module)",
    "fn:server:src/components/common/Badge.tsx:Badge",
  ]);
});

test("a function's key is its majority source, never a neighbour's", () => {
  const keys = [...base.entities.keys()].filter((key) => key.startsWith("fn:browser:"));
  assert.ok(keys.includes("fn:browser:src/lib/date.ts:formatDate"));
  // The chunk's wrapper has no source of its own: scaffolding, never an entity.
  assert.ok(keys.every((key) => !key.includes("<unmapped>")));
});

test("routes come from the app manifest's built file, normalised with the empty root", () => {
  assert.ok(base.entities.has("route:/sso"));
});

test("the Next runtime in the traces, and routing, are global", () => {
  assert.deepEqual(base.global, ["file:node_modules/next/dist/server/runtime.js", "out:routes-manifest.json"]);
});

test("built scripts index their functions by offset, for coverage", () => {
  const { spans } = base.scripts.get("static/chunks/a1b2c3d4c2.js")!;
  // The module's factory runs the module's own top-level code, so it is the module's too.
  assert.deepEqual(spans.map((span) => span.key), ["fn:browser:src/lib/date.ts:turbopack:///[project]/src/lib/date.ts", "fn:browser:src/lib/date.ts:formatDate"]);
  const text = nextBuild(BASE).get("static/chunks/a1b2c3d4c2.js")!;
  assert.match(text.slice(spans[1]!.start, spans[1]!.end), /^function formatDate\(date\)/);
});

test("a monorepo app's sources are repo-relative", () => {
  const nested = fingerprint({}, "apps/web");
  assert.ok(nested.entities.has("fn:browser:apps/web/src/lib/date.ts:formatDate"));
});

test("source names, from Turbopack, webpack and a map-relative path", () => {
  assert.equal(sourceName("turbopack:///[project]/src/a.tsx", "static/chunks/x.js.map", ""), "src/a.tsx");
  assert.equal(sourceName("webpack://_N_E/./src/a.tsx", "static/chunks/x.js.map", ""), "src/a.tsx");
  assert.equal(sourceName("webpack://_N_E/./src/a.tsx", "static/chunks/x.js.map", "apps/web"), "apps/web/src/a.tsx");
  assert.equal(sourceName("../../../src/a.tsx", "server/app/page.js.map", "apps/web"), "apps/web/src/a.tsx");
  // A map's sources are URLs: a dynamic route's brackets and a route group's parentheses arrive encoded,
  // and git names the file as it is (PQA-3201 PR 3, Umami's [websiteId] and (compat) handlers).
  assert.equal(sourceName("turbopack:///[project]/src/app/api/websites/%5BwebsiteId%5D/route.ts", "server/chunks/x.js.map", ""), "src/app/api/websites/[websiteId]/route.ts");
  assert.equal(sourceName("webpack://_N_E/./src/app/%28compat%29/page.tsx", "static/chunks/x.js.map", ""), "src/app/(compat)/page.tsx");
  assert.equal(sourceName("turbopack:///[project]/src/a%ZZ.ts", "server/chunks/x.js.map", ""), "src/a%ZZ.ts", "an invalid escape stays as it is");
  // Server chunks' maps name sources relative to themselves, encoded the same way.
  assert.equal(sourceName("../../../../src/app/api/websites/%5BwebsiteId%5D/route.ts", "server/chunks/ssr/x.js.map", ""), "src/app/api/websites/[websiteId]/route.ts");
  assert.equal(sourceName("turbopack:///[project]/./src/a.tsx", "static/chunks/x.js.map", ""), "src/a.tsx");
});

test("a .next directory on disk reads as the same fingerprint, its caches skipped", async (t) => {
  const { mkdtemp, mkdir, rm, writeFile } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const path = await import("node:path");
  const { fingerprintNextDir } = await import("../src/evidence/fingerprint/read-build");
  const app = await mkdtemp(path.join(tmpdir(), "peeps-fp-"));
  t.after(() => rm(app, { recursive: true, force: true }));
  const files = nextBuild(BASE);
  files.set("cache/webpack/stale.js", "function stale() {}");
  for (const [file, text] of files) {
    await mkdir(path.dirname(path.join(app, ".next", file)), { recursive: true });
    await writeFile(path.join(app, ".next", file), text);
  }
  await mkdir(path.join(app, "node_modules/next/dist/server"), { recursive: true });
  await writeFile(path.join(app, "node_modules/next/dist/server/runtime.js"), "runtime");
  const onDisk = fingerprintNextDir(path.join(app, ".next"), "");
  assert.deepEqual(diffFingerprints(base, onDisk).filter((key) => key !== "file:node_modules/next/dist/server/runtime.js"), []);
  assert.notEqual(onDisk.entities.get("file:node_modules/next/dist/server/runtime.js"), "missing");
  assert.ok([...onDisk.scripts.keys()].every((file) => !file.startsWith("cache/")));
});

test("a fingerprint crosses the scanner's process as JSON unchanged", async () => {
  const { fromWire, toWire } = await import("../src/evidence/fingerprint/wire");
  const back = fromWire(JSON.parse(JSON.stringify(toWire(base))));
  assert.deepEqual(diffFingerprints(base, back), []);
  assert.deepEqual([back.files, back.global, back.scripts, back.sheets], [base.files, base.global, base.scripts, base.sheets]);
});

test("a class static block is a function of its module, where V8 starts it", async () => {
  const { chunk } = await import("./support/next-build");
  const code = "class Context {\n  static {\n    Context.ready = true;\n  }\n}\n__turbopack_context__.s({ Context });";
  const built = chunk([{ source: "turbopack:///[project]/src/context.ts", code }], "s.js.map");
  const files = new Map([["static/chunks/s.js", built.code], ["static/chunks/s.js.map", built.map]]);
  const fp = fingerprintBuild({ files: [...files.keys()], read: (f) => files.get(f) ?? null, sourcePrefix: "" });
  const block = fp.scripts.get("static/chunks/s.js")!.spans.find((s) => built.code.slice(s.start).startsWith("static {"));
  assert.ok(block, "the static block has a span");
  assert.match(block!.key ?? "", /^fn:browser:src\/context\.ts:/);
});
