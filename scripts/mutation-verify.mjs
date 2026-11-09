#!/usr/bin/env node
/**
 * Proves a test can fail: breaks the source on purpose, rebuilds `dist/` (the
 * tests run the committed action), and requires the named tests to go red.
 *
 *   node scripts/mutation-verify.mjs test/mutation-plans/<plan>.json
 *
 * A plan is `{ description, mutants: [{ name, file, find, replace, tests }] }`,
 * `find` matching exactly once. Run it on a committed tree with nothing else
 * reading this one: it rewrites files in place. Exits 0 only when every mutant
 * is killed: a test failed while others in its files still passed, so the run
 * loaded and a mutation that only broke the build proves nothing.
 */
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";

const plan = JSON.parse(readFileSync(process.argv[2], "utf8"));
const run = (command, args) => spawnSync(command, args, { encoding: "utf8", maxBuffer: 2 ** 28 });
const build = () => {
  const built = run("npm", ["run", "build"]);
  return built.status === 0;
};

let unkilled = 0;
for (const mutant of plan.mutants) {
  const original = readFileSync(mutant.file, "utf8");
  if (original.split(mutant.find).length !== 2) {
    console.error(`stale anchor (it must match exactly once): ${mutant.name}`);
    process.exit(2);
  }
  writeFileSync(mutant.file, original.replace(mutant.find, () => mutant.replace));
  let verdict = "INCONCLUSIVE: it did not build";
  try {
    if (build()) {
      const tests = run(process.execPath, ["--test", "--import", "tsx", ...mutant.tests]);
      const count = (label) => Number(new RegExp(`^ℹ ${label} (\\d+)$`, "m").exec(tests.stdout)?.[1] ?? 0);
      verdict = count("fail") === 0 ? "SURVIVED" : count("pass") === 0 ? "INCONCLUSIVE: nothing passed" : "killed";
    }
  } finally {
    writeFileSync(mutant.file, original);
  }
  if (verdict !== "killed") unkilled += 1;
  console.log(`${verdict} :: ${mutant.name}`);
}
build();
console.log(`${plan.mutants.length - unkilled}/${plan.mutants.length} killed`);
process.exit(unkilled === 0 ? 0 : 1);
