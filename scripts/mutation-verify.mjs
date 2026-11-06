#!/usr/bin/env node
/**
 * Mutation verification: prove a test can fail. Applies each mutant of a plan to the
 * source, rebuilds `dist/` when the mutant says the tests read it, runs the tests that
 * claim to cover it, and requires a failing test. The same plan shape as the Peeps
 * repository's `scripts/mutation-plans/`; there, `docs/MUTATION_TESTING.md` says why.
 *
 *   node scripts/mutation-verify.mjs scripts/mutation-plans/<plan>.json [--filter <substring>]
 *
 * Exit 0: every mutant killed. 1: one survived, or was inconclusive (the run failed
 * with no failing test, so it proves nothing). 2: a stale anchor, or a test failing
 * on the unmutated tree. Restores on every exit; run nothing else on this tree meanwhile.
 */
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";

const [planPath, flag, filter] = process.argv.slice(2);
const plan = JSON.parse(readFileSync(planPath, "utf8"));
const mutants = plan.mutants.filter((m) => flag !== "--filter" || m.name.includes(filter));

const build = () => spawnSync("npm", ["run", "build", "--silent"], { stdio: "ignore" }).status === 0;

function run(tests) {
  const out = spawnSync(process.execPath, ["--test", "--test-concurrency=1", "--import", "tsx", ...tests], { encoding: "utf8", maxBuffer: 1 << 28, timeout: 600_000 });
  const text = `${out.stdout}${out.stderr}`;
  const failed = Number(/^ℹ fail (\d+)/m.exec(text)?.[1] ?? 0);
  // A file that couldn't load counts as one failing test: that proves nothing.
  const unloaded = /SyntaxError|Cannot find module|ERR_MODULE_NOT_FOUND|Transform failed/.test(text);
  return { failed, unloaded, status: out.status };
}

let original = null;
let originalFile = null;
const restore = () => {
  if (originalFile) writeFileSync(originalFile, original);
  originalFile = null;
};
for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) {
  process.on(signal, () => {
    restore();
    process.exit(2);
  });
}

for (const mutant of mutants) {
  const text = readFileSync(mutant.file, "utf8");
  const count = text.split(mutant.find).length - 1;
  if (count !== 1) {
    console.error(`stale anchor (${count} matches) in ${mutant.file}: ${mutant.name}`);
    process.exit(2);
  }
}
if (!build()) {
  console.error("the unmutated tree doesn't build");
  process.exit(2);
}
for (const tests of new Set(mutants.map((m) => JSON.stringify(m.tests)))) {
  const baseline = run(JSON.parse(tests));
  if (baseline.status !== 0) {
    console.error(`a test fails on the unmutated tree: ${tests}`);
    process.exit(2);
  }
}

let bad = 0;
for (const mutant of mutants) {
  original = readFileSync(mutant.file, "utf8");
  originalFile = mutant.file;
  try {
    writeFileSync(mutant.file, original.replace(mutant.find, () => mutant.replace));
    if (mutant.build && !build()) {
      console.log(`INCONCLUSIVE  ${mutant.name}: it doesn't build`);
      bad++;
      continue;
    }
    const result = run(mutant.tests);
    const verdict = result.failed > 0 && !result.unloaded ? "killed" : result.status === 0 ? "SURVIVED" : "INCONCLUSIVE";
    if (verdict !== "killed") bad++;
    console.log(`${verdict.padEnd(12)}  ${mutant.name}`);
  } finally {
    restore();
  }
}
if (mutants.some((m) => m.build)) build();
console.log(`${mutants.length - bad} of ${mutants.length} killed`);
process.exit(bad === 0 ? 0 : 1);
