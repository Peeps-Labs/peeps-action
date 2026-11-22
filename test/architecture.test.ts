/**
 * What's allowed to know what: the decisions import no file system, git, Playwright or
 * network, and only a convention's own file names a framework.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

const root = path.resolve(__dirname, "../src");
const read = (file: string) => readFileSync(path.join(root, file), "utf8");
const IMPURE = /from "(?:node:(?:fs|fs\/promises|child_process|net|http|https|os|zlib)|@playwright\/test)"|\bfetch\(/;

const adapters = readdirSync(path.join(root, "reach/adapters")).map((file) => `reach/adapters/${file}`);
const EVIDENCE = ["evidence/port.ts", "evidence/hash.ts", "evidence/browser/rules.ts", "evidence/fingerprint/rules.ts", "evidence/fingerprint/source-map.ts", "evidence/fingerprint/wire.ts", "evidence/recording.ts", "evidence/codec.ts"];
const PURE = [...EVIDENCE, "footprint/rules.ts", "footprint/test-trace.ts", "reach/preflight.ts", "reach/limits.ts", "reach/checkout.ts", "reach/match.ts", "reach/scan.ts", "reach/graph.ts", "reach/walk.ts", "reach/text-graph.ts", "reach/parse.ts", "reach/syntax.ts", "reach/convention.ts", "load/customer.ts", "load/control-origin.ts", ...adapters];

for (const file of PURE) {
  test(`${file} touches no file system, git, Playwright or network`, () => {
    const code = read(file).replace(/\/\*[\s\S]*?\*\/|^\s*\/\/.*$/gm, "");
    const hits = code.split("\n").filter((line) => IMPURE.test(line) && !line.includes('"\\b') && !line.includes("FETCH ="));
    assert.deepEqual(hits, []);
  });
}

for (const file of ["reach/scan.ts", "reach/walk.ts", "reach/graph.ts", "reach/text-graph.ts", "reach/index.ts", "reach/checkout.ts"]) {
  test(`${file} names no framework`, () => {
    const code = read(file).replace(/\/\*[\s\S]*?\*\/|^\s*\/\/.*$/gm, "");
    assert.deepEqual(code.split("\n").filter((line) => /\b(?:Next|next\.config|express|trpc|trigger|router|procedure|createCaller)\b/.test(line) && !line.includes("./adapters")), []);
  });
}

test("the footprint's decisions name no reporter", () => {
  assert.doesNotMatch(read("footprint/rules.ts"), /@playwright|from "\.\.\/reporter"/);
});

test("the action's own process never loads the parser: a fingerprint is the scanner's work", () => {
  for (const file of ["evidence/job.ts", "evidence/upload.ts", "evidence/recording.ts", "evidence/hash.ts", "evidence/codec.ts", "evidence/port.ts", "evidence/fingerprint/wire.ts", "reach/preflight.ts", "report.ts"]) {
    const values = read(file).split("\n").filter((line) => /^import (?!type )/.test(line));
    assert.deepEqual(values.filter((line) => /"typescript"|fingerprint\/(?:rules|read-build)"/.test(line)), [], file);
  }
});

test("the load supervisor sends closed only through the lease's beginClosed, loads no customer code, and nothing outside it names its seams", () => {
  const code = read("load/supervisor.ts").replace(/\/\*[\s\S]*?\*\/|^\s*\/\/.*$/gm, "");
  assert.equal(code.match(/state: "closed"/g)?.length, 1, "one place builds a closed renewal");
  assert.equal(code.match(/\.beginClosed\(/g)?.length, 1, "and allocates it through the lease");
  assert.doesNotMatch(code, /\bimport\(|\brequire\(/, "no dynamic import: customer code runs only in the jail");
  assert.match(code, /from "\.\/control-port"/);
  const named = (dir: string): string[] =>
    readdirSync(path.join(root, dir), { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? named(path.join(dir, e.name)) : /\.ts$/.test(e.name) && /\bLoadSeams\b/.test(read(path.join(dir, e.name))) ? [path.join(dir, e.name)] : []));
  assert.deepEqual(named("."), ["load/supervisor.ts"]);
});

test("main.ts names the load code only as the file load.js, through one createRequire, and the bundle holds none of it", () => {
  const code = read("main.ts").replace(/\/\*[\s\S]*?\*\/|^\s*\/\/.*$/gm, "");
  assert.doesNotMatch(code, /load\/supervisor|load\/main|runLoad|mainLoad\b|from "\.\/load\//, "no static import of the load code");
  assert.equal(code.match(/createRequire\(/g)?.length, 1);
  assert.equal(code.match(/"load\.js"/g)?.length, 1);
  const index = readFileSync(path.resolve(__dirname, "../dist/index.js"), "utf8");
  for (const name of ["runLoad", "offlinePreinstall", "fetchPreinstall", "beginClosed", "HttpControlPort", "customerRefusal", "readJobIdentity", "PEEPS_LOAD_GRANT"]) assert.ok(!index.includes(name), `dist/index.js holds ${name}`);
});

test("the customer refusals read no environment and import none of the run's machinery", () => {
  for (const file of ["load/customer.ts", "load/control-origin.ts"]) {
    const code = read(file).replace(/\/\*[\s\S]*?\*\/|^\s*\/\/.*$/gm, "");
    assert.doesNotMatch(code, /process\.env/, file);
    assert.doesNotMatch(code, /from "\.\/(?:supervisor|jail|http-control-port|transport|oidc|install|registry-fetch)"/, file);
  }
});

test("the download phase reaches the registry only through the shared transport", () => {
  const code = read("load/registry-fetch.ts");
  assert.doesNotMatch(code, /"node:(?:https|http|net|tls)"/);
  assert.match(code, /from "\.\/transport"/);
});

test("nothing in src imports from test", () => {
  const files = (readdirSync(root, { recursive: true }) as string[]).filter((f) => /\.[cm]?[jt]s$/.test(f));
  for (const file of files) assert.doesNotMatch(read(file), /from "(?:\.\.\/)+test\//, file);
});
