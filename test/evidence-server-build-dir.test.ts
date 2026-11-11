/** Next writes to its build directory while it serves (ISR, cached route handlers, fetch cache): a later run must not read it (PQA-3201 PR 3). */
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { settleBuildDir, snapshotBuildDir } from "../src/evidence/server/build-dir";

function build(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "peeps-next-"));
  mkdirSync(path.join(dir, "server/app"), { recursive: true });
  writeFileSync(path.join(dir, "server/app/page.js"), "built");
  writeFileSync(path.join(dir, "server/app/old.html"), "prerendered");
  writeFileSync(path.join(dir, "BUILD_ID"), "x");
  return dir;
}

test("what a run wrote is removed before the next, and an unchanged build is clean", () => {
  const dir = build();
  const snapshot = snapshotBuildDir(dir);
  assert.deepEqual(settleBuildDir(dir, snapshot), { created: [], changed: [] });
  mkdirSync(path.join(dir, "cache/fetch-cache"), { recursive: true });
  writeFileSync(path.join(dir, "cache/fetch-cache/abc"), "{}");
  writeFileSync(path.join(dir, "server/app/orders.html"), "rendered on demand");
  assert.deepEqual(settleBuildDir(dir, snapshot), { created: ["cache/fetch-cache/abc", "server/app/orders.html"], changed: [] });
  assert.ok(!existsSync(path.join(dir, "server/app/orders.html")) && !existsSync(path.join(dir, "cache/fetch-cache/abc")));
  assert.deepEqual(settleBuildDir(dir, snapshot), { created: [], changed: [] });
});

test("a built file a run rewrote is changed (it can't be put back), and one removed is harmless", () => {
  const dir = build();
  const snapshot = snapshotBuildDir(dir);
  writeFileSync(path.join(dir, "server/app/old.html"), "revalidated, longer");
  rmSync(path.join(dir, "BUILD_ID"));
  assert.deepEqual(settleBuildDir(dir, snapshot), { created: [], changed: ["server/app/old.html"] });
  // Same size, newer time: still changed.
  const same = build();
  const before = snapshotBuildDir(same);
  utimesSync(path.join(same, "server/app/page.js"), new Date(), new Date(Date.now() + 5_000));
  assert.deepEqual(settleBuildDir(same, before).changed, ["server/app/page.js"]);
});
