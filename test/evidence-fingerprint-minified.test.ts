/**
 * A production server build is minified per chunk: a module beside a changed one gets new
 * local names, and every App Router route compiles from one Next template (PQA-3494, the
 * `ambient_change` on peeps-bench #52). A function's key and value must survive both, and
 * no real change may hide.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { diffFingerprints, fingerprintBuild, type Fingerprint } from "../src/evidence/fingerprint/rules";
import { serverBuild, type Rename, type ServerModule } from "./support/minified-build";

const VARIANT = [
  "var imp=e.i(10);",
  'let fallback="baseline";',
  "async function variantFor(req,name){let found=(0,imp.headers)(req).get(name);return found??fallback}",
  "function label(v){return v.toUpperCase()}",
  "function pick(first,second){return first(second)}",
  'e.s(["variantFor",0,variantFor,"label",0,label,"pick",0,pick])',
].join("\n");

const variant = (code = VARIANT): ServerModule => ({ id: 68623, source: "turbopack:///[project]/lib/variant.ts", code });

/** The minifier's names in one chunk, and in a chunk beside a changed module. */
const R1: Record<string, Rename> = {
  imp: { to: "t", named: false },
  fallback: "a",
  variantFor: "o",
  req: "n",
  name: "i",
  found: "s",
  label: "l",
  v: "c",
  pick: { to: "u", named: false },
  first: { to: "d", named: false },
  second: { to: "f", named: false },
};
const R2: Record<string, Rename> = {
  imp: { to: "r", named: false },
  fallback: "s",
  variantFor: "a",
  req: "i",
  name: "n",
  found: "o",
  label: "c",
  v: "l",
  pick: { to: "p", named: false },
  first: { to: "h", named: false },
  second: { to: "m", named: false },
};

function route(id: number, path: string, body = "{ok:true}"): ServerModule {
  return {
    id,
    source: `turbopack:///[project]/app${path}/route.ts`,
    code: ["var http=e.i(20);", `async function GET(req){return (0,http.json)(${body})}`, 'e.s(["GET",0,GET])'].join("\n"),
  };
}

/** Next's App Router template, one copy per route, with that route's page and module inlined. */
function template(id: number, path: string, userland: number, status = 200): ServerModule {
  return {
    id,
    source: "turbopack:///[project]/node_modules/next/src/build/templates/app-route.ts",
    code: [
      "var mod=e.i(30);",
      `let routeModule=new mod.AppRouteRouteModule({page:"${path}/route",userland:()=>e.r(${userland})});`,
      `async function handler(req,res){return routeModule.handle(req,res,${status})}`,
      'e.s(["handler",0,handler,"routeModule",0,routeModule])',
    ].join("\n"),
  };
}

const ROUTE_RENAMES: Record<string, Rename> = {
  http: { to: "t", named: false },
  mod: { to: "r", named: false },
  GET: "a",
  req: "n",
  res: "o",
  routeModule: "s",
  handler: "i",
};

function fingerprint(files: Map<string, string>): Fingerprint {
  return fingerprintBuild({ files: [...files.keys()], read: (file) => files.get(file) ?? null, sourcePrefix: "" });
}

function buildFiles(options: { variantB?: Record<string, Rename>; variantCode?: string; routeA?: string; routeC?: boolean; statusA?: number; entries?: boolean } = {}) {
  const chunks: Parameters<typeof serverBuild>[0] = {
    "a.js": { modules: [route(101, "/api/a", options.routeA), template(201, "/api/a", 101, options.statusA), variant()], renames: { ...ROUTE_RENAMES, ...R1 } },
    "b.js": { modules: [route(102, "/api/b"), template(202, "/api/b", 102), variant(options.variantCode)], renames: { ...ROUTE_RENAMES, ...(options.variantB ?? R1) } },
  };
  if (options.routeC) chunks["c.js"] = { modules: [route(103, "/api/c"), template(203, "/api/c", 103)], renames: ROUTE_RENAMES };
  const entries: Record<string, number> = { "server/app/api/a/route.js": 201, "server/app/api/b/route.js": 202 };
  if (options.routeC) entries["server/app/api/c/route.js"] = 203;
  return serverBuild(chunks, options.entries === false ? {} : entries);
}

const build = (options: Parameters<typeof buildFiles>[0] = {}) => fingerprint(buildFiles(options));
const base = build();

test("a module the minifier renamed in a chunk beside a change changes nothing", () => {
  assert.deepEqual(diffFingerprints(base, build({ variantB: R2 })), []);
});

test("a function is keyed by its original name, never the minifier's", () => {
  const minified = new Set([...Object.values(R1), ...Object.values(R2), ...Object.values(ROUTE_RENAMES)].map((r) => (typeof r === "string" ? r : r.to)));
  const names = [...base.entities.keys()].filter((key) => key.startsWith("fn:")).map((key) => key.slice(key.lastIndexOf(":") + 1));
  assert.deepEqual(names.filter((name) => minified.has(name)), []);
  assert.ok(base.entities.has("fn:server:lib/variant.ts:variantFor"));
  assert.ok(base.entities.has("fn:server:lib/variant.ts:label"));
});

test("a function with no original name is keyed by where it starts in its source", () => {
  // `pick` is line 5 of lib/variant.ts: the map names neither it nor its parameters.
  assert.ok(base.entities.has("fn:server:lib/variant.ts:@5:1"));
  assert.ok(![...base.entities.keys()].some((key) => key.endsWith(":anon")));
});

test("a real edit inside a re-minified module is that function, and only it", () => {
  const edited = VARIANT.replace("v.toUpperCase()", "v.toLowerCase()");
  assert.deepEqual(diffFingerprints(base, build({ variantB: R2, variantCode: edited })), ["fn:server:lib/variant.ts:label"]);
});

test("swapping two bindings the map doesn't name is still a change", () => {
  const swapped = VARIANT.replace("return first(second)", "return second(first)");
  assert.deepEqual(diffFingerprints(base, build({ variantCode: swapped })), ["fn:server:lib/variant.ts:@5:1"]);
});

test("a route's change is that route's code, not Next's route template every route shares", () => {
  assert.deepEqual(diffFingerprints(base, build({ routeA: "{ok:false}" })), ["fn:server:app/api/a/route.ts:GET"]);
});

test("a new route adds its own code and its own template copy, nothing of another route's", () => {
  const added = diffFingerprints(base, build({ routeC: true }));
  assert.ok(added.some((key) => key.startsWith("fn:server:app/api/c/route.ts:")));
  assert.ok(added.some((key) => key.endsWith("#server/app/api/c/route.js")));
  // Its entry file, which maps nothing, is its own `out:` entity.
  assert.deepEqual(added.filter((key) => !key.startsWith("fn:server:app/api/c/route.ts:") && !key.endsWith("#server/app/api/c/route.js") && key !== "out:server/app/api/c/route.js"), []);
});

test("a value the build folds into one route's template copy changes that copy, and only it", () => {
  const changed = diffFingerprints(base, build({ statusA: 201 }));
  assert.ok(changed.length > 0);
  assert.deepEqual(changed.filter((key) => !key.endsWith("#server/app/api/a/route.js")), []);
});

test("a template copy no entry names stays one shared entity: a change to any copy is a change to it", () => {
  const unentried = build({ entries: false });
  const shared = [...unentried.entities.keys()].filter((key) => key.includes("build/templates"));
  assert.ok(shared.length > 0);
  assert.ok(shared.every((key) => !key.includes("#")));
  assert.ok(diffFingerprints(unentried, build({ entries: false, statusA: 201 })).some((key) => key.includes("build/templates")));
});

test("a template copy belongs to its route's entry, with no source a footprint could hold", () => {
  const copies = [...base.entities.keys()].filter((key) => key.includes("build/templates"));
  assert.ok(copies.length > 0);
  assert.ok(copies.every((key) => key.endsWith("#server/app/api/a/route.js") || key.endsWith("#server/app/api/b/route.js")));
  assert.deepEqual([...base.files.values()].filter((file) => file.includes("build/templates")), []);
  const code = buildFiles().get("server/chunks/a.js")!;
  const handler = base.scripts.get("server/chunks/a.js")!.spans.find((span) => code.slice(span.start).startsWith("async function i(n,o)"));
  assert.ok(handler, "the template's handler is indexed for coverage");
  assert.equal(handler.source, null);
  assert.match(handler.key ?? "", /^fn:server:node_modules\/next\/src\/build\/templates\/app-route\.ts:handler#server\/app\/api\/a\/route\.js$/);
});

/** One module in one chunk, the map naming nothing and carrying no source text: every binding by its place. */
function bare(code: string): Fingerprint {
  return fingerprint(serverBuild({ "a.js": { modules: [{ id: 1, source: "turbopack:///[project]/lib/x.ts", code }], renames: {} } }));
}

test("two bindings the map gives one original name stay two: modules hoisted into one scope", () => {
  const before = 'let first@value="a";let second@value="b";\nfunction join(){return first+second}\ne.s(["join",0,join])';
  const after = before.replace("return first+second", "return second+first");
  assert.notDeepEqual(diffFingerprints(bare(before), bare(after)), []);
});

test("two nested functions with one name stay two: swapping their bodies is a change", () => {
  const before = "function o@one(x){function a@read(){return 1}return a()+x}\nfunction t@two(x,y){function a@read(){return 2}return a()+x+y}\ne.s([\"one\",0,o,\"two\",0,t])";
  const after = before.replace("return 1", "return 3").replace("return 2", "return 1").replace("return 3", "return 2");
  assert.notDeepEqual(diffFingerprints(bare(before), bare(after)), []);
});

test("a destructured shorthand keeps the property it reads", () => {
  assert.notDeepEqual(diffFingerprints(bare("function read(o){const {foo}=o;return foo}"), bare("function read(o){const {bar}=o;return bar}")), []);
  assert.notDeepEqual(diffFingerprints(bare("function read(o){const {foo=1}=o;return foo}"), bare("function read(o){const {bar=1}=o;return bar}")), []);
});

test("a chunk with a direct eval or with keeps its names as built: eval can read them", () => {
  assert.notDeepEqual(diffFingerprints(bare('function f(a){return eval("a")}'), bare('function f(b){return eval("a")}')), []);
  assert.notDeepEqual(diffFingerprints(bare("function f(a,o){with(o){return a}}"), bare("function f(b,o){with(o){return a}}")), []);
});

test("a map with no source text and no names: every function by its place, a rebuild still changes nothing", () => {
  const strip = (files: Map<string, string>) =>
    new Map([...files].map(([file, text]) => [file, file.endsWith(".map") ? JSON.stringify({ ...JSON.parse(text), names: [], sourcesContent: undefined }) : text]));
  const a = fingerprint(strip(buildFiles()));
  assert.deepEqual(diffFingerprints(a, fingerprint(strip(buildFiles({ variantB: R2 })))), []);
  const edited = VARIANT.replace("v.toUpperCase()", "v.toLowerCase()");
  assert.deepEqual(diffFingerprints(a, fingerprint(strip(buildFiles({ variantB: R2, variantCode: edited })))), ["fn:server:lib/variant.ts:@4:1"]);
});

test("a chunk the checker can't read is one entity, never a lost fingerprint", () => {
  const files = buildFiles();
  // Valid JavaScript nested deeper than the checker's recursion: the chunk falls back whole.
  const deep = "x=" + "[".repeat(20000) + "]".repeat(20000) + ";";
  files.set("server/chunks/deep.js", `${deep}\n//# sourceMappingURL=deep.js.map`);
  files.set("server/chunks/deep.js.map", JSON.stringify({ version: 3, sources: ["turbopack:///[project]/lib/deep.ts"], names: [], mappings: "AAAA" }));
  const fp = fingerprint(files);
  assert.equal(fp.scripts.get("server/chunks/deep.js")?.whole, "out:server/chunks/deep.js");
  assert.ok(fp.entities.has("fn:server:lib/variant.ts:label"));
});
