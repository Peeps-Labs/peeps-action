/** When a recorded push gets server evidence (PQA-3201 PR 3). */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { readRunnerEnv } from "../src/env";
import { serverPlanOf } from "../src/report";

function app(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "peeps-plan-"));
  mkdirSync(path.join(dir, ".next"));
  writeFileSync(path.join(dir, "a.spec.ts"), "");
  return dir;
}
const envOf = (dir: string) => readRunnerEnv({ GITHUB_WORKSPACE: dir, "INPUT_APP-START": "npm start", "INPUT_APP-READY-URL": "http://localhost:3000" });
const recorded = [{ collect: { coverage: true } }];

test("a config that shards its suite gets no server evidence: a file's own run would shard it again and skip its tests", () => {
  const dir = app();
  assert.notEqual(serverPlanOf(envOf(dir), recorded, dir, ["a.spec.ts"], null), null);
  assert.equal(serverPlanOf(envOf(dir), recorded, dir, ["a.spec.ts"], { current: 2, total: 2 }), null);
});

test("the plan knows which files git tracks, by real absolute path; outside a repository, none", () => {
  const dir = require("node:fs").realpathSync(app());
  const { execFileSync } = require("node:child_process");
  const git = (...args: string[]) => execFileSync("git", args, { cwd: dir, env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@e", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@e" } });
  assert.equal(serverPlanOf(envOf(dir), recorded, dir, ["a.spec.ts"], null)!.tracked(path.join(dir, "a.spec.ts")), false, "no repository");
  git("init", "-q");
  git("add", "a.spec.ts");
  git("commit", "-qm", "x");
  writeFileSync(path.join(dir, "untracked.js"), "");
  const plan = serverPlanOf(envOf(dir), recorded, dir, ["a.spec.ts"], null)!;
  assert.equal(plan.tracked(path.join(dir, "a.spec.ts")), true);
  assert.equal(plan.tracked(path.join(dir, "untracked.js")), false);
});
