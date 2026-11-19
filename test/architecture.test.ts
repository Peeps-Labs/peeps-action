/**
 * What's allowed to know what: the decisions import no file system, git, Playwright or
 * network, and only a convention's own file names a framework.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";

const root = path.resolve(__dirname, "../src");
const read = (file: string) => readFileSync(path.join(root, file), "utf8");
const IMPURE = /from "(?:node:(?:fs|fs\/promises|child_process|net|http|https|os|zlib)|@playwright\/test)"|\bfetch\(/;

const adapters = readdirSync(path.join(root, "reach/adapters")).map((file) => `reach/adapters/${file}`);
const EVIDENCE = ["evidence/port.ts", "evidence/hash.ts", "evidence/browser/rules.ts", "evidence/fingerprint/rules.ts", "evidence/fingerprint/source-map.ts", "evidence/fingerprint/wire.ts", "evidence/recording.ts", "evidence/codec.ts"];
const LOAD = ["load/plan-input.ts", "load/engine-limits.ts", "load/budget.ts", "load/scheduler.ts", "load/accounting.ts", "load/timing.ts", "load/policy.ts", "load/clock.ts", "load/control-port.ts", "load/frames.ts"];
const PURE = [...EVIDENCE, ...LOAD, "footprint/rules.ts", "footprint/test-trace.ts", "reach/preflight.ts", "reach/limits.ts", "reach/checkout.ts", "reach/match.ts", "reach/scan.ts", "reach/graph.ts", "reach/walk.ts", "reach/text-graph.ts", "reach/parse.ts", "reach/syntax.ts", "reach/convention.ts", ...adapters];

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

/** Every file under src/ that `entry` reaches through relative imports, types included. */
function reached(entry: string): Set<string> {
  const seen = new Set<string>();
  const queue = [entry];
  while (queue.length) {
    const file = queue.pop()!;
    if (seen.has(file)) continue;
    seen.add(file);
    const code = read(file).replace(/\/\*[\s\S]*?\*\/|^\s*\/\/.*$/gm, "");
    for (const match of code.matchAll(/(?:from\s+|import\(|require\()\s*"(\.{1,2}\/[^"]+)"/g)) {
      const base = path.join(path.dirname(file), match[1]!);
      const found = [base, `${base}.ts`, `${base}/index.ts`, base.replace(/\.js$/, ".ts")].find(
        (candidate) => /\.(?:ts|cjs|js)$/.test(candidate) && existsSync(path.join(root, candidate)),
      );
      if (found) queue.push(path.normalize(found));
    }
  }
  return seen;
}

test("the action's own entry reaches nothing in load/: a load run is the engine's own bundle", () => {
  assert.ok(reached("main.ts").size > 20, "the import walk found too little to mean anything");
  for (const entry of ["main.ts", "reporter.ts", "list-projects.ts", "reach/main.ts"]) {
    const files = reached(entry);
    assert.deepEqual([...files].filter((f) => f.startsWith("load/")), [], entry);
  }
});

test("the supervisor never loads customer code: only the executor reaches the loader and Playwright", () => {
  const engine = reached("load/engine.ts");
  for (const file of ["load/loader.ts", "load/transport.ts", "load/executor.ts"]) assert.ok(!engine.has(file), `the engine reaches ${file}`);
  for (const file of engine) assert.doesNotMatch(read(file), /from "(?:@playwright\/test|playwright(?:-core)?|sucrase)"/, file);
  assert.ok(reached("load/executor.ts").has("load/loader.ts"));
});
