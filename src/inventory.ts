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
import { existsSync, readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import type { RunnerEnv } from "./env";
import { jsonReportTarget } from "./playwright-json";
import type { PeepsClient } from "./peeps";

const execFileAsync = promisify(execFile);

export interface PlaywrightList {
  config: { rootDir?: string; projects?: Array<{ name: string; dependencies?: string[]; teardown?: string }>; globalSetup?: string | string[] | null; shard?: { current: number; total: number } | null };
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

/**
 * The test files themselves, relative to rootDir: Playwright's file suites, which its file
 * filters select. A file only setup or teardown projects run is left out: Playwright runs
 * those around every dependent file, and alone a teardown has no setup to clean up after.
 */
export function testFilesOf(list: PlaywrightList): string[] {
  const support = new Set((list.config.projects ?? []).flatMap((p) => [...(p.dependencies ?? []), ...(p.teardown ? [p.teardown] : [])]));
  const projectsOf = (suite: PlaywrightSuite): string[] => [
    ...(suite.specs ?? []).flatMap((spec) => ((spec as { tests?: Array<{ projectName?: string }> }).tests ?? []).map((t) => t.projectName ?? "")),
    ...(suite.suites ?? []).flatMap(projectsOf),
  ];
  return [
    ...new Set(
      list.suites.flatMap((suite) => {
        const projects = projectsOf(suite);
        return suite.file && !(projects.length > 0 && projects.every((p) => support.has(p))) ? [suite.file] : [];
      }),
    ),
  ].sort();
}

/** The projects reporter (`list-projects.ts`): bundled beside this file, or its source in tests. */
function projectsReporter(): string | null {
  for (const name of ["list-projects.js", "list-projects.ts"]) {
    const file = path.join(__dirname, name);
    if (existsSync(file)) return file;
  }
  return null;
}

export async function listTests(env: RunnerEnv, extraArgs: string[] = []): Promise<PlaywrightList> {
  const projects = projectsReporter();
  const args = ["playwright", "test", "--list", `--reporter=json${projects ? `,${projects}` : ""}`, ...extraArgs];
  if (env.configPath) args.push("--config", env.configPath);
  const target = await jsonReportTarget();
  const projectsFile = path.join(path.dirname(target.env.PLAYWRIGHT_JSON_OUTPUT_FILE!), "projects.json");
  try {
    const { stdout } = await execFileAsync("npx", args, {
      cwd: env.workingDirectory,
      maxBuffer: 64 * 1024 * 1024,
      env: { ...process.env, CI: "1", ...target.env, PEEPS_PROJECTS_FILE: projectsFile },
    });
    const list = (await target.read(stdout)) as PlaywrightList | null;
    if (!list) throw new Error("playwright test --list wrote no JSON report");
    return withProjectLinks(list, projectsFile);
  } finally {
    await target.cleanup();
  }
}

/** The JSON report's projects, with the dependencies and teardown it leaves out. */
function withProjectLinks(list: PlaywrightList, file: string): PlaywrightList {
  let links: Array<{ name: string; dependencies?: string[]; teardown?: string }>;
  try {
    links = JSON.parse(readFileSync(file, "utf8")) as typeof links;
  } catch {
    return list;
  }
  const byName = new Map(links.map((link) => [link.name, link]));
  const projects = (list.config.projects ?? []).map((project) => {
    const link = byName.get(project.name);
    return link ? { ...project, dependencies: link.dependencies ?? [], ...(link.teardown ? { teardown: link.teardown } : {}) } : project;
  });
  return { ...list, config: { ...list.config, projects } };
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
  if (!env.sha) throw new Error("The commit sha is not set (GITHUB_SHA / CI_COMMIT_SHA)");
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
