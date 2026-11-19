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
const PURE = [...EVIDENCE, "footprint/rules.ts", "footprint/test-trace.ts", "reach/preflight.ts", "reach/limits.ts", "reach/checkout.ts", "reach/match.ts", "reach/scan.ts", "reach/graph.ts", "reach/walk.ts", "reach/text-graph.ts", "reach/parse.ts", "reach/syntax.ts", "reach/convention.ts", ...adapters];

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
