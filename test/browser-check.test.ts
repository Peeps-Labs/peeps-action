import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { missingBrowsersMessage, probePlaywright, warnIfBrowsersMissing, type PlaywrightProbe } from "../src/browser-check";

const ROOT = "/ms-playwright";
const probe: PlaywrightProbe = {
  version: "1.60.0",
  browsers: [
    { name: "chromium", executablePath: `${ROOT}/chromium-1200/chrome-linux/chrome` },
    { name: "firefox", executablePath: `${ROOT}/firefox-1500/firefox/firefox` },
    { name: "webkit", executablePath: `${ROOT}/webkit-2300/pw_run.sh` },
  ],
};

test("no message when one of the installed Playwright's browsers is on the runner", () => {
  const exists = (p: string) => p === `${ROOT}/firefox-1500/firefox/firefox`;
  assert.equal(missingBrowsersMessage(probe, { exists, list: () => [] }), null);
});

test("chromium's headless shell at the same revision counts as chromium", () => {
  const exists = (p: string) => p === `${ROOT}/chromium_headless_shell-1200`;
  assert.equal(missingBrowsersMessage(probe, { exists, list: () => ["chromium_headless_shell-1200"] }), null);
});

test("a runner holding another Playwright version's browsers gets a message naming both and the fix", () => {
  // mcr.microsoft.com/playwright:v1.59.1-jammy with @playwright/test 1.60.0.
  const message = missingBrowsersMessage(probe, {
    exists: () => false,
    list: (dir) => (dir === ROOT ? ["chromium-1187", "ffmpeg-1011", "firefox-1490", "webkit-2203", ".links"] : []),
  });
  assert.ok(message);
  assert.match(message, /Playwright 1\.60\.0/);
  assert.match(message, /chromium-1200, firefox-1500, webkit-2300/);
  assert.match(message, /\/ms-playwright has chromium-1187, firefox-1490, webkit-2203/);
  assert.match(message, /mcr\.microsoft\.com\/playwright:v1\.60\.0-jammy/);
  assert.match(message, /npx playwright install --with-deps/);
});

test("an empty or missing browsers folder says so", () => {
  const message = missingBrowsersMessage(probe, { exists: () => false, list: () => [] });
  assert.match(message!, /\/ms-playwright has no Playwright browsers/);
});

test("a probe with no browser paths at all asks nothing", () => {
  assert.equal(missingBrowsersMessage({ version: "1.60.0", browsers: [] }, { exists: () => false, list: () => [] }), null);
});

test("probePlaywright reads the Playwright installed where the tests run", async () => {
  const found = await probePlaywright(path.resolve(__dirname, ".."));
  assert.ok(found);
  assert.equal(found.version, require("@playwright/test/package.json").version);
  assert.deepEqual(found.browsers.map((b) => b.name).sort(), ["chromium", "firefox", "webkit"]);
});

test("probePlaywright follows PLAYWRIGHT_BROWSERS_PATH, so an empty one is reported as missing", async (t) => {
  const empty = await mkdtemp(path.join(tmpdir(), "peeps-browsers-"));
  t.after(() => rm(empty, { recursive: true, force: true }));
  const found = await probePlaywright(path.resolve(__dirname, ".."), { ...process.env, PLAYWRIGHT_BROWSERS_PATH: empty });
  assert.ok(found);
  for (const b of found.browsers) assert.ok(b.executablePath.startsWith(empty), b.executablePath);
  const message = missingBrowsersMessage(found, { exists: existsSync });
  assert.match(message!, new RegExp(`Playwright ${found.version.replace(/\./g, "\\.")}`));
});

test("probePlaywright returns null where no Playwright is installed", async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), "peeps-no-pw-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await mkdir(path.join(dir, "sub"));
  assert.equal(await probePlaywright(path.join(dir, "sub")), null);
});

test("warnIfBrowsersMissing prints a GitHub warning annotation, or a plain line on GitLab, and never throws", async (t) => {
  const empty = await mkdtemp(path.join(tmpdir(), "peeps-browsers-"));
  const previous = process.env.PLAYWRIGHT_BROWSERS_PATH;
  process.env.PLAYWRIGHT_BROWSERS_PATH = empty;
  const lines: string[] = [];
  t.mock.method(console, "log", (line: string) => lines.push(line));
  t.after(async () => {
    if (previous === undefined) delete process.env.PLAYWRIGHT_BROWSERS_PATH;
    else process.env.PLAYWRIGHT_BROWSERS_PATH = previous;
    await rm(empty, { recursive: true, force: true });
  });
  const repo = path.resolve(__dirname, "..");
  await warnIfBrowsersMissing(repo, "github");
  await warnIfBrowsersMissing(repo, "gitlab");
  assert.equal(lines.length, 2);
  assert.match(lines[0]!, /^::warning title=Playwright browsers missing::Playwright \d/);
  assert.match(lines[1]!, /^\[peeps\] warning: Playwright \d/);
});

test("warnIfBrowsersMissing is silent where the browsers are installed, or there is no Playwright", async (t) => {
  const lines: string[] = [];
  t.mock.method(console, "log", (line: string) => lines.push(line));
  const dir = await mkdtemp(path.join(tmpdir(), "peeps-no-pw-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await warnIfBrowsersMissing(dir, "github");
  // This repository's own Playwright, whose chromium CI and setup install.
  await warnIfBrowsersMissing(path.resolve(__dirname, ".."), "github");
  assert.deepEqual(lines, []);
});
