/**
 * Another precise-coverage user resets this collector's counters, and a reset after a
 * page loads drops what ran before it while the final take still succeeds: whole-looking
 * evidence that isn't. That can't be told at run time, so a suite that might do it isn't
 * collected at all.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { coverageConflict, coverageConflictIn } from "../src/evidence/browser/conflict";

test("a suite that starts or takes coverage itself is a conflict", () => {
  for (const text of [
    "await page.coverage.startJSCoverage();",
    "await page.coverage.startCSSCoverage({ resetOnNavigation: false });",
    'await session.send("Profiler.startPreciseCoverage", { callCount: true });',
    "await cdp.send('Profiler.takePreciseCoverage');",
  ]) {
    assert.match(coverageConflict([{ path: "e2e/fixtures.ts", text }], []) ?? "", /e2e\/fixtures\.ts/, text);
  }
});

test("a coverage package for Playwright is a conflict", () => {
  for (const name of ["monocart-reporter", "monocart-coverage-reports", "playwright-test-coverage", "@bgotink/playwright-coverage"]) {
    const pkg = JSON.stringify({ devDependencies: { [name]: "^1.0.0" } });
    assert.match(coverageConflict([], [{ path: "package.json", text: pkg }]) ?? "", new RegExp(name.replace(/[/@]/g, ".")), name);
  }
});

test("an ordinary suite is no conflict", () => {
  const pkg = JSON.stringify({ dependencies: { next: "16" }, devDependencies: { "@playwright/test": "1.59", "@vitest/coverage-v8": "3" } });
  assert.equal(coverageConflict([{ path: "e2e/cart.spec.ts", text: "await page.goto('/cart'); // no coverage here" }], [{ path: "package.json", text: pkg }]), null);
  assert.equal(coverageConflict([], [{ path: "package.json", text: "{ not json" }]), null);
});

test("on disk: the suite's sources and its package files are read, node_modules never", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "peeps-conflict-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, "e2e"), { recursive: true });
  await mkdir(path.join(root, "node_modules/some-lib"), { recursive: true });
  await writeFile(path.join(root, "package.json"), "{}");
  await writeFile(path.join(root, "e2e/cart.spec.ts"), "test('x', async ({ page }) => { await page.goto('/'); });");
  await writeFile(path.join(root, "node_modules/some-lib/index.js"), "page.coverage.startJSCoverage()");
  assert.equal(await coverageConflictIn([root]), null);
  await writeFile(path.join(root, "e2e/fixtures.ts"), "await page.coverage.startJSCoverage();");
  assert.match((await coverageConflictIn([root])) ?? "", /fixtures\.ts/);
});

test("a suite too large to read whole is refused, never assumed clean", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "peeps-conflict-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  for (let i = 0; i < 5; i++) await writeFile(path.join(root, `s${i}.spec.ts`), "test('x', () => {});");
  assert.match((await coverageConflictIn([root], { maxFiles: 3 })) ?? "", /too many/);
});
