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
