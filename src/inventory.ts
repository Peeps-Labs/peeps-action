/**
 * `peeps inventory`: what Playwright itself says this repository's tests are.
 *
 * Runs `playwright test --list --reporter=json` with the customer's config,
 * reads every spec file the list names, computes each file's git blob sha
 * (so Peeps can match it to the commit without a second fetch), and posts the
 * lot to Peeps. Peeps turns it into test cases; nothing here decides anything.
 */

import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import type { RunnerEnv } from "./env";
import type { PeepsClient } from "./peeps";

const execFileAsync = promisify(execFile);

export interface PlaywrightList {
  config: { rootDir?: string; projects?: Array<{ name: string }> };
  suites: PlaywrightSuite[];
}
export interface PlaywrightSuite {
  title: string;
  file?: string;
  line?: number;
  specs?: Array<{ title: string; file: string; line: number; id?: string; tags?: string[] }>;
  suites?: PlaywrightSuite[];
}

/** git's blob object id for these bytes: sha1("blob <len>\0" + bytes). */
export function gitBlobSha(content: Buffer): string {
  return createHash("sha1")
    .update(`blob ${content.length}\0`)
    .update(content)
    .digest("hex");
}

/** Every spec file the list mentions, relative to Playwright's rootDir. */
export function specFilesOf(list: PlaywrightList): string[] {
  const files = new Set<string>();
  const walk = (suite: PlaywrightSuite) => {
    for (const spec of suite.specs ?? []) files.add(spec.file);
    for (const child of suite.suites ?? []) walk(child);
  };
  for (const suite of list.suites) walk(suite);
  return [...files].sort();
}

export async function listTests(env: RunnerEnv): Promise<PlaywrightList> {
  const args = ["playwright", "test", "--list", "--reporter=json"];
  if (env.configPath) args.push("--config", env.configPath);
  const { stdout } = await execFileAsync("npx", args, {
    cwd: env.workingDirectory,
    maxBuffer: 64 * 1024 * 1024,
    env: { ...process.env, CI: "1" },
  });
  return JSON.parse(stdout) as PlaywrightList;
}

/**
 * Every spec file the list mentions, as Peeps wants it: repo-relative path,
 * git blob sha and contents. Shared by inventory and by report mode, where
 * runs pin the exact blob that executed.
 */
export async function specFilePayload(env: RunnerEnv, list: PlaywrightList) {
  const rootDirAbs = list.config.rootDir ?? env.workingDirectory;
  const files = [];
  for (const file of specFilesOf(list)) {
    const abs = path.join(rootDirAbs, file);
    const bytes = await readFile(abs);
    files.push({
      path: path.relative(env.workspace, abs).split(path.sep).join("/"),
      blobSha: gitBlobSha(bytes),
      content: bytes.toString("utf8"),
    });
  }
  return files;
}

export async function buildInventoryRequest(env: RunnerEnv, list: PlaywrightList) {
  if (!env.sha) throw new Error("GITHUB_SHA is not set");
  const rootDirAbs = list.config.rootDir ?? env.workingDirectory;
  // Playwright reports files relative to rootDir; Peeps wants them relative to
  // the repository root, so it can match the tree at this commit.
  const rootDir = path.relative(env.workspace, rootDirAbs).split(path.sep).join("/") || ".";
  const files = await specFilePayload(env, list);
  return { sha: env.sha, rootDir, list, files };
}

export async function runInventory(env: RunnerEnv, peeps: PeepsClient): Promise<void> {
  const list = await listTests(env);
  const request = await buildInventoryRequest(env, list);
  const specs = request.files.length;
  const tests = specFilesOf(list).length ? countSpecs(list) : 0;
  console.log(`[peeps] inventory: ${tests} tests in ${specs} spec files at ${request.sha.slice(0, 7)}`);
  const result = await peeps.post<{ results: unknown[] }>("/api/v1/ci/inventory", request);
  console.log(`[peeps] inventory accepted: ${JSON.stringify(result.results)}`);
}

function countSpecs(list: PlaywrightList): number {
  let n = 0;
  const walk = (suite: PlaywrightSuite) => {
    n += suite.specs?.length ?? 0;
    for (const child of suite.suites ?? []) walk(child);
  };
  for (const suite of list.suites) walk(suite);
  return n;
}
