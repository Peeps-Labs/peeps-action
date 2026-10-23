/**
 * The Appium path of every mode that runs tests: Appium tests driven by
 * WebdriverIO (v9) with mocha, config `wdio.conf.ts` (or .js/.mjs/.cjs).
 *
 * The pytest path's shape, with WebdriverIO's pieces in pytest's places:
 *
 *   inventory  WebdriverIO has no `--list`. `dist/appium-collect.mjs` loads
 *              the spec files WebdriverIO's own ConfigParser names into mocha
 *              (no device session, no hook, no test body) and walks the suite
 *              tree; that goes to `POST /api/v1/ci/inventory` as the
 *              Playwright list shape, `framework: "appium"`, so identity is
 *              `(path, titlePath)` exactly as for Playwright.
 *   report     collect, ask Peeps for a plan, run `wdio` through a wrapper
 *              config that adds the Peeps reporter (`dist/appium-reporter.js`)
 *              and an `afterTest` hook, and upload each failed test's
 *              screenshot and page source.
 *   run        the same, narrowed to the planned spec files, a mocha grep
 *              over the planned titles, and a mocha root hook that skips any
 *              test whose (spec file, title path) is not planned.
 */

import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, readdirSync } from "node:fs";
import { mkdir, mkdtemp, readdir, readFile, stat, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import type { AppiumCollection, CapabilitiesRead } from "./appium-collect";
import {
  repoRelative,
  TITLE_PATH_SEPARATOR,
  type AppiumPlanFile,
  type LocalResultsLine,
  type PeepsWdioOptions,
} from "./appium-reporter";
import type { RunnerEnv } from "./env";
import { gitBlobSha, type PlaywrightList, type PlaywrightSuite } from "./inventory";
import type { PeepsClient } from "./peeps";
import { requestPlan } from "./plan";
import { stagedEvidence, uploadEvidence, WDIO_CONFIG } from "./pytest";
import { plannedTestsOf, type PlannedTest } from "./report";
import type { PlanEntry } from "./reporter";

/** Bundled beside dist/index.js; resolved the same way from src/ (tests) and dist/. */
export const COLLECTOR = path.join(__dirname, "..", "dist", "appium-collect.mjs");
export const APPIUM_REPORTER = path.join(__dirname, "..", "dist", "appium-reporter.js");

const DEFAULT_CONFIGS = ["ts", "mts", "js", "mjs", "cjs", "cts"].map((ext) => `wdio.conf.${ext}`);

/** Collection imports the customer's specs; one that hangs at import must not hold the job. */
const COLLECT_TIMEOUT_MS = 10 * 60 * 1000;
/** The capabilities `wdio run` would open its first session with (`--capabilities`). */
export async function readAppiumCapabilities(env: RunnerEnv, configPath = wdioConfigPath(env)): Promise<CapabilitiesRead> {
  const read = await runCollector<CapabilitiesRead>(env, ["--capabilities", configPath], "reading the WebdriverIO capabilities");
  for (const note of read.notes) console.log(`[peeps] ${note}`);
  return read;
}

/** Files larger than this are skipped with a note, as the other paths do. */
const MAX_UPLOAD_BYTES = 128 * 1024 * 1024;

/**
 * The WebdriverIO config this job runs, absolute: the `config` input, else
 * `wdio.conf.<ext>` in the working directory, else its only `wdio.*.conf.*`.
 */
export function wdioConfigPath(env: RunnerEnv): string {
  if (env.configPath) return path.resolve(env.workingDirectory, env.configPath);
  for (const name of DEFAULT_CONFIGS) {
    const candidate = path.join(env.workingDirectory, name);
    if (existsSync(candidate)) return candidate;
  }
  let names: string[] = [];
  try {
    names = readdirSync(env.workingDirectory).filter((name) => WDIO_CONFIG.test(name)).sort();
  } catch {
    // Reported below.
  }
  if (names.length === 1) return path.join(env.workingDirectory, names[0]!);
  throw new Error(
    names.length > 1
      ? `several WebdriverIO configs in ${env.workingDirectory} (${names.join(", ")}): set \`config\` to the one this job runs`
      : `no wdio.conf.ts (or .js, .mjs, .cjs) in ${env.workingDirectory}: set \`config\` to your WebdriverIO config`,
  );
}

// ---------------------------------------------------------------------------
// Collection
// ---------------------------------------------------------------------------

/**
 * Run `dist/appium-collect.mjs` in its own process, in the working
 * directory, and read the JSON it writes. `what` names it in errors.
 */
async function runCollector<T>(env: RunnerEnv, args: string[], what: string): Promise<T> {
  const scratch = await mkdtemp(path.join(process.env.RUNNER_TEMP ?? tmpdir(), "peeps-collect-"));
  const out = path.join(scratch, "collection.json");
  const { code, output } = await new Promise<{ code: number; output: string }>((resolve, reject) => {
    const child = spawn(process.execPath, [COLLECTOR, ...args, out], {
      cwd: env.workingDirectory,
      env: { ...process.env, CI: "1" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    const keep = (chunk: Buffer) => {
      output = (output + chunk.toString("utf8")).slice(-20_000);
    };
    child.stdout.on("data", keep);
    child.stderr.on("data", keep);
    const timer = setTimeout(() => {
      output += `\n[peeps] ${what} did not finish in ${COLLECT_TIMEOUT_MS / 1000}s`;
      child.kill("SIGKILL");
    }, COLLECT_TIMEOUT_MS);
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(new Error(`could not start the collector: ${error.message}`));
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code: code ?? 1, output });
    });
  });
  if (code !== 0 || !existsSync(out)) {
    throw new Error(`${what} failed (${code}):\n${output.slice(-4000)}`);
  }
  return JSON.parse(await readFile(out, "utf8")) as T;
}

/** What the suite holds, from `dist/appium-collect.mjs` in its own process. */
export async function collectAppium(env: RunnerEnv, configPath = wdioConfigPath(env)): Promise<AppiumCollection> {
  const collection = await runCollector<AppiumCollection>(env, [configPath], "collecting the WebdriverIO suite");
  for (const note of collection.notes) console.log(`[peeps] ${note}`);
  for (const error of collection.errors) {
    console.log(`[peeps] collection error in ${error.file}:\n${error.message}`);
  }
  return collection;
}

/** `abs` relative to the repository root ("" for the root itself); throws outside it. */
function repoPath(env: RunnerEnv, abs: string): string {
  if (path.resolve(abs) === path.resolve(env.workspace)) return "";
  const rel = repoRelative(env.workspace, abs);
  if (rel === null) throw new Error(`${abs} is outside the repository (${env.workspace})`);
  return rel;
}

/**
 * The repo-relative directory the inventory's paths are relative to: the
 * WebdriverIO rootDir, or the nearest directory above it that holds every
 * spec file (a `specs: ["../shared/**"]` reaches outside it). It is also how
 * far the list proves deletions, so it is never wider than it must be.
 */
export function appiumRootDir(env: RunnerEnv, collection: AppiumCollection): string {
  let root = repoPath(env, collection.rootDir);
  const files = collection.specs.map((file) => repoPath(env, file));
  const holds = (file: string) => root === "" || file.startsWith(`${root}/`);
  while (!files.every(holds)) {
    const parent = path.posix.dirname(root);
    root = parent === "." ? "" : parent;
  }
  return root || ".";
}

/** Playwright's rule: `@word` tokens in any title, without the `@`. */
export function tagsOf(titles: string[]): string[] {
  const tags = new Set<string>();
  for (const title of titles) for (const match of title.matchAll(/(?:^|\s)@([^\s@]+)/g)) tags.add(match[1]!);
  return [...tags];
}

/**
 * The 1-based line a test is declared on, found from its titles as string
 * literals, each searched after the last: mocha records no line. 1 (the
 * file) when a title is computed rather than written.
 */
export function lineOf(source: string, titles: string[]): number {
  let from = 0;
  let found = -1;
  for (const title of titles) {
    let best = -1;
    for (const quote of ["'", '"', "`"]) {
      const index = source.indexOf(`${quote}${title}${quote}`, from);
      if (index !== -1 && (best === -1 || index < best)) best = index;
    }
    if (best === -1) return found === -1 ? 1 : source.slice(0, found).split("\n").length;
    found = best;
    from = best + 1;
  }
  return found === -1 ? 1 : source.slice(0, found).split("\n").length;
}

interface Built {
  rootDir: string;
  list: PlaywrightList;
  files: Array<{ path: string; blobSha: string; content: string }>;
  collectionErrors: string[];
}

/**
 * The collection as Playwright's `--list --reporter=json` would have it:
 * one suite per spec file (titled by its path relative to `rootDir`), a
 * nested suite per `describe`, a spec per `it`. Peeps reads it exactly as a
 * Playwright list, so every test's identity is the repo-relative file and
 * the describe chain plus title joined with ` › `.
 */
export async function buildAppiumList(env: RunnerEnv, collection: AppiumCollection): Promise<Built> {
  const rootDir = appiumRootDir(env, collection);
  const prefix = rootDir === "." ? "" : `${rootDir}/`;
  const relativeToRoot = (abs: string) => repoPath(env, abs).slice(prefix.length);
  const sources = new Map<string, string>();
  const files: Built["files"] = [];
  const fileSuites = new Map<string, PlaywrightSuite>();
  for (const test of collection.tests) {
    const file = relativeToRoot(test.file);
    let source = sources.get(test.file);
    if (source === undefined) {
      const bytes = await readFile(test.file);
      source = bytes.toString("utf8");
      sources.set(test.file, source);
      files.push({ path: prefix + file, blobSha: gitBlobSha(bytes), content: source });
    }
    let suite = fileSuites.get(file);
    if (!suite) {
      suite = { title: file, file, line: 0, specs: [], suites: [] };
      fileSuites.set(file, suite);
    }
    const describes = test.titlePath.slice(0, -1);
    for (let depth = 0; depth < describes.length; depth++) {
      const title = describes[depth]!;
      let child: PlaywrightSuite | undefined = suite.suites!.find((s) => s.title === title);
      if (!child) {
        child = { title, file, line: lineOf(source, describes.slice(0, depth + 1)), specs: [], suites: [] };
        suite.suites!.push(child);
      }
      suite = child;
    }
    suite.specs!.push({
      title: test.titlePath[test.titlePath.length - 1] ?? "",
      file,
      line: lineOf(source, test.titlePath),
      tags: tagsOf(test.titlePath),
    });
  }
  const sorted = [...fileSuites.keys()].sort();
  return {
    rootDir,
    list: {
      config: { rootDir: path.join(env.workspace, rootDir === "." ? "" : rootDir), projects: [] },
      suites: sorted.map((file) => fileSuites.get(file)!),
    },
    files: files.sort((a, b) => a.path.localeCompare(b.path)),
    collectionErrors: collection.errors.map((error) => relativeToRoot(error.file)),
  };
}

// ---------------------------------------------------------------------------
// Modes
// ---------------------------------------------------------------------------

/** The body of `POST /api/v1/ci/inventory` for an Appium suite. */
export async function buildAppiumInventoryRequest(env: RunnerEnv, collection: AppiumCollection) {
  if (!env.sha) throw new Error("The commit sha is not set (GITHUB_SHA / CI_COMMIT_SHA)");
  const built = await buildAppiumList(env, collection);
  return {
    sha: env.sha,
    framework: "appium" as const,
    rootDir: built.rootDir,
    list: built.list,
    // Spec files that did not load (relative to rootDir, as the list's
    // files are): present, but unread, so their tests' absence from the list
    // is not their deletion.
    collectionErrors: built.collectionErrors,
    files: built.files,
  };
}

export async function runAppiumInventory(env: RunnerEnv, peeps: PeepsClient): Promise<void> {
  const collection = await collectAppium(env);
  const request = await buildAppiumInventoryRequest(env, collection);
  console.log(
    `[peeps] inventory: ${collection.tests.length} WebdriverIO tests in ${request.files.length} spec files at ${request.sha.slice(0, 7)}`,
  );
  const result = await peeps.post<{ results: unknown[] }>("/api/v1/ci/inventory", request);
  console.log(`[peeps] inventory accepted: ${JSON.stringify(result.results)}`);
}

interface BatchResponse {
  batches: Array<{ batchId: string; batchNumber: number; runs: PlanEntry[]; unmatched: PlannedTest[] }>;
}

/** `report`: run this workflow's whole suite and report every planned test. */
export async function runAppiumReport(env: RunnerEnv, peeps: PeepsClient): Promise<void> {
  if (!env.sha) throw new Error("The commit sha is not set (GITHUB_SHA / CI_COMMIT_SHA)");
  const configPath = wdioConfigPath(env);
  const collection = await collectAppium(env, configPath);
  const built = await buildAppiumList(env, collection);
  const tests = plannedTestsOf(built.list, built.rootDir);
  console.log(`[peeps] report: ${tests.length} tests at ${env.sha.slice(0, 7)} (${env.ref ?? "?"})`);
  const response = await peeps.post<BatchResponse>("/api/v1/ci/batches", {
    sha: env.sha,
    jobUrl: env.runUrl,
    baseUrl: process.env.BASE_URL ?? null,
    tests,
    files: built.files,
  });
  const runs = response.batches.flatMap((b) => b.runs);
  const unmatched = response.batches.flatMap((b) => b.unmatched);
  console.log(
    `[peeps] planned ${runs.length} run(s) in ${response.batches.length} batch(es); ${unmatched.length} test(s) unknown to Peeps`,
  );
  for (const u of unmatched.slice(0, 10)) console.log(`[peeps]   unknown: ${u.path} › ${u.titlePath}`);
  await executeAppiumAndReport(env, peeps, {
    configPath,
    runs,
    batches: response.batches.map((b) => ({
      batchId: b.batchId,
      batchNumber: b.batchNumber,
      runIds: b.runs.map((r) => r.runId),
    })),
  });
}

interface Plan {
  batchId: string;
  batchNumber: number;
  runs: PlanEntry[];
}

/**
 * Peeps' planned runs matched to the spec files collection found, by
 * `(path, titlePath)`. A run with no collected test (renamed or deleted since
 * Peeps planned it) is returned separately; nothing runs for it.
 */
export function specsForRuns(
  env: RunnerEnv,
  collection: AppiumCollection,
  runs: PlanEntry[],
): { specs: string[]; matched: PlanEntry[]; unmatched: PlanEntry[] } {
  const fileOf = new Map<string, string>();
  for (const test of collection.tests) {
    const rel = repoRelative(env.workspace, test.file);
    if (rel !== null) fileOf.set(`${rel}\n${test.titlePath.join(TITLE_PATH_SEPARATOR)}`, test.file);
  }
  const specs = new Set<string>();
  const matched: PlanEntry[] = [];
  const unmatched: PlanEntry[] = [];
  for (const run of runs) {
    const file = fileOf.get(`${run.path}\n${run.titlePath}`);
    if (file === undefined) {
      unmatched.push(run);
      continue;
    }
    specs.add(file);
    matched.push(run);
  }
  return { specs: [...specs].sort(), matched, unmatched };
}

function escapeRegex(value: string): string {
  return value
    .replace(/[.*+?^${}()|[\]\\/]/g, "\\$&")
    // mocha turns a grep string into a RegExp from a `.*` match, which stops
    // at a line terminator: spell them as escapes.
    .replace(/\n/g, "\\n")
    .replace(/\r/g, "\\r")
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029");
}

/**
 * mocha's grep matches a test's full title: its describe titles and its own
 * joined by single spaces, nothing else. Each planned title is anchored at
 * both ends, so a title never matches as part of a longer one.
 */
export function mochaGrepFor(titlePaths: string[]): string {
  const alternatives = [...new Set(titlePaths)].map((t) => escapeRegex(t.split(TITLE_PATH_SEPARATOR).join(" ")));
  return `^(?:${alternatives.join("|")})$`;
}

/** `run`: Peeps dispatched this job for one batch; run exactly its tests. */
export async function runAppiumDispatched(env: RunnerEnv, peeps: PeepsClient): Promise<void> {
  if (!env.sessionId) throw new Error("`session-id` is required in run mode (Peeps passes it)");
  const configPath = wdioConfigPath(env);
  const collection = await collectAppium(env, configPath);
  const built = await buildAppiumList(env, collection);
  // Peeps accepts at most 2000 entries in one plan request.
  const plan = await requestPlan<Plan>(peeps, env.sessionId, {
    tests: plannedTestsOf(built.list, built.rootDir).slice(0, 2000),
  });
  if (!plan) return;
  console.log(`[peeps] run: batch ${plan.batchNumber} holds ${plan.runs.length} run(s)`);
  const { specs, matched, unmatched } = specsForRuns(env, collection, plan.runs);
  for (const run of unmatched.slice(0, 10)) {
    console.log(`[peeps]   not collected here, not run: ${run.path} › ${run.titlePath}`);
  }
  if (matched.length === 0) {
    // Never start wdio without a selection: with none it runs the whole suite.
    await peeps.post(`/api/v1/ci/batches/${plan.batchId}/complete`, { reportUploaded: false });
    if (plan.runs.length > 0) {
      throw new Error(`none of the ${plan.runs.length} planned test(s) were collected at this commit`);
    }
    return;
  }
  await executeAppiumAndReport(env, peeps, {
    configPath,
    runs: matched,
    batches: [{ batchId: plan.batchId, batchNumber: plan.batchNumber }],
    selection: { specs, grep: mochaGrepFor(matched.map((r) => r.titlePath)) },
  });
}

// ---------------------------------------------------------------------------
// Running WebdriverIO
// ---------------------------------------------------------------------------

/** Whether `name` is installed where Node would find it from `from`. */
function hasPackage(name: string, from: string): boolean {
  for (let dir = from; ; dir = path.dirname(dir)) {
    if (existsSync(path.join(dir, "node_modules", name, "package.json"))) return true;
    if (path.dirname(dir) === dir) return false;
  }
}

/**
 * The config WebdriverIO runs: a module beside the customer's (so its
 * relative paths and `rootDir` hold) that imports it and exports
 * `withPeeps(config, options)`. TypeScript configs get an `.mts` wrapper,
 * which WebdriverIO loads with tsx as it would theirs; JavaScript an `.mjs`.
 */
export async function writeWrapperConfig(
  configPath: string,
  options: PeepsWdioOptions,
): Promise<{ configPath: string; cleanup: () => Promise<void> }> {
  const ts = /\.[cm]?ts$/.test(configPath);
  const wrapper = path.join(path.dirname(configPath), `.peeps-${randomUUID()}.wdio.conf.${ts ? "mts" : "mjs"}`);
  const source = [
    "// Written by peeps-action for this run and removed after it; never committed.",
    'import { createRequire } from "node:module";',
    `import * as loaded from ${JSON.stringify(pathToFileURL(configPath).href)};`,
    "const require = createRequire(import.meta.url);",
    `const { withPeeps } = require(${JSON.stringify(APPIUM_REPORTER)});`,
    "const base = loaded.config ?? loaded.default?.config;",
    `export const config = withPeeps(base, ${JSON.stringify(options)});`,
    "",
  ].join("\n");
  await writeFile(wrapper, source, { flag: "wx", mode: 0o600 });
  return { configPath: wrapper, cleanup: () => unlink(wrapper) };
}

function runWdio(env: RunnerEnv, configPath: string, extraEnv: Record<string, string>): Promise<number> {
  return new Promise((resolve) => {
    const child = spawn("npx", ["wdio", "run", configPath], {
      cwd: env.workingDirectory,
      stdio: "inherit",
      env: { ...process.env, CI: "1", ...extraEnv },
    });
    child.on("error", (error) => {
      console.error(`[peeps] could not start WebdriverIO: ${String(error)}`);
      resolve(1);
    });
    child.on("close", (code) => resolve(code ?? 1));
  });
}

/**
 * Shared tail of `report` and `run`: write the plan, run WebdriverIO through
 * the wrapper config, upload the evidence and JUnit files, close the batches.
 */
export async function executeAppiumAndReport(
  env: RunnerEnv,
  peeps: PeepsClient,
  input: {
    configPath: string;
    runs: PlanEntry[];
    /** `runIds`: the runs a batch holds; omitted with a single batch, which holds every run. */
    batches: Array<{ batchId: string; batchNumber: number; runIds?: string[] }>;
    /** Run mode: only these spec files (absolute), this mocha grep, and only the planned (file, title path) pairs. */
    selection?: { specs: string[]; grep: string };
    /** For tests: run this instead of `npx wdio run <config>`. */
    runner?: (configPath: string, extraEnv: Record<string, string>) => Promise<number>;
  },
): Promise<void> {
  const scratch = await mkdtemp(path.join(process.env.RUNNER_TEMP ?? tmpdir(), "peeps-"));
  const planFile = path.join(scratch, "plan.json");
  const artifactsDir = path.join(scratch, "evidence");
  await mkdir(artifactsDir);
  const plan: AppiumPlanFile = { peepsUrl: env.peepsUrl, workspace: env.workspace, runs: input.runs };
  // Run mode: the grep matches titles only; the root hook holds it to the planned (file, title path) pairs.
  if (input.selection) plan.onlyPlanned = true;
  await writeFile(planFile, JSON.stringify(plan), { mode: 0o600 });
  const junitDir = hasPackage("@wdio/junit-reporter", path.dirname(input.configPath)) ? path.join(scratch, "junit") : null;
  const options: PeepsWdioOptions = { junitDir };
  if (input.selection) {
    // As file URLs: WebdriverIO globs a plain path, and `[id].spec.ts` is a glob.
    options.specs = input.selection.specs.map((file) => pathToFileURL(file).href);
    options.grep = input.selection.grep;
    options.onlyPlanned = true;
  }

  // A run that cannot even start still has its batches closed below, so no
  // planned run is left waiting for a job that is already over.
  let code = 1;
  let wrapper: Awaited<ReturnType<typeof writeWrapperConfig>> | undefined;
  try {
    wrapper = await writeWrapperConfig(input.configPath, options);
    const extraEnv = { PEEPS_PLAN_FILE: planFile, PEEPS_ARTIFACTS_DIR: artifactsDir };
    code = await (input.runner ?? ((config, extra) => runWdio(env, config, extra)))(wrapper.configPath, extraEnv);
  } catch (error) {
    console.log(`[peeps] could not run WebdriverIO: ${String(error)}`);
  } finally {
    await wrapper?.cleanup().catch((error: unknown) => {
      console.warn(`[peeps] could not remove the temporary wdio config: ${String(error)}`);
    });
  }

  const byRunId = Object.fromEntries(input.runs.map((run) => [run.runId, run]));
  const evidence = await stagedEvidence(path.join(artifactsDir, "upload"), byRunId);
  for (const b of input.batches) {
    const mine = evidence.filter((file) => input.batches.length === 1 || (b.runIds ?? []).includes(file.runId));
    if (mine.length > 0) {
      const uploaded = await uploadEvidence(peeps, b.batchId, mine);
      console.log(`[peeps] uploaded ${uploaded} test attachment(s) for batch ${b.batchNumber}`);
    }
    if (junitDir) await uploadJunit(peeps, b.batchId, junitDir);
    try {
      // No HTML report: the evidence is in the batch's `data/`, named by run.
      await peeps.post(`/api/v1/ci/batches/${b.batchId}/complete`, { reportUploaded: false });
    } catch (error) {
      console.log(`[peeps] could not complete batch ${b.batchId}: ${String(error)}`);
    }
  }
  console.log(`[peeps] wdio exited with ${code}`);
  if (code !== 0) process.exitCode = code;
}

/** `junit-<cid>.xml` as `data/junit-<cid>.xml.dat`: xml is not a `data/` type. */
export function junitArtifactName(file: string): string {
  return `data/${file.replace(/[^A-Za-z0-9._-]/g, "_")}.dat`;
}

async function uploadJunit(peeps: PeepsClient, batchId: string, junitDir: string): Promise<void> {
  let names: string[];
  try {
    names = (await readdir(junitDir)).filter((name) => name.endsWith(".xml")).sort();
  } catch {
    return;
  }
  let uploaded = 0;
  for (const name of names) {
    const file = path.join(junitDir, name);
    try {
      if ((await stat(file)).size > MAX_UPLOAD_BYTES) continue;
      await peeps.postBytes(
        `/api/v1/ci/batches/${batchId}/artifacts?path=${encodeURIComponent(junitArtifactName(name))}`,
        await readFile(file),
      );
      uploaded += 1;
    } catch (error) {
      console.log(`[peeps] skipped ${name}: ${String(error).slice(0, 200)}`);
    }
  }
  if (uploaded > 0) console.log(`[peeps] uploaded ${uploaded} JUnit file(s)`);
}

// ---------------------------------------------------------------------------
// Agent mode: `run_tests` for an Appium suite
// ---------------------------------------------------------------------------

/** A wdio run whose output is captured, for `run_tests`. */
export type WdioRunner = (
  configPath: string,
  extraEnv: Record<string, string>,
) => Promise<{ code: number; stdout: string; stderr: string }>;

/** One test of a `run_tests` result: Playwright's entry, plus what an Appium failure leaves. */
export interface AgentTestResult {
  /** Describe titles and the test's own, joined with ` › `: the inventory's `titlePath`. */
  title: string;
  /** Repo-relative. */
  file: string;
  line: number;
  status: string;
  error?: string;
  errorStack?: string;
  /** The failure's screenshot and page source, on the runner (absolute paths). */
  evidence?: Array<{ name: string; path: string; size: number }>;
  /** The page source the test failed on, redacted and capped. */
  pageSource?: string;
  pageSourceTruncated?: boolean;
}

export interface AgentRunTestsResult {
  exitCode: number;
  durationMs: number;
  results: AgentTestResult[] | null;
  stderr: string;
  stdoutTail?: string;
}

/** As long as Playwright's `run_tests` may run. */
const AGENT_RUN_TIMEOUT_MS = 10 * 60 * 1000;
/** Page source inlined per failed test, and for how many tests at most. */
const AGENT_PAGE_SOURCE_CHARS = 20_000;
const AGENT_PAGE_SOURCE_TESTS = 3;

/**
 * The agent's grep is a regular expression already (Peeps sends the same
 * `titleGrep` it sends Playwright, which matches mocha's full title too).
 * mocha builds its RegExp from a `.*` match of the string, which stops at a
 * line terminator, so those are spelled as escapes, as `mochaGrepFor` does.
 */
export function mochaGrepFromRegex(grep: string): string {
  return grep
    .replace(/\n/g, "\\n")
    .replace(/\r/g, "\\r")
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029");
}

function runWdioCaptured(env: RunnerEnv, configPath: string, extraEnv: Record<string, string>): ReturnType<WdioRunner> {
  return new Promise((resolve) => {
    const child = spawn("npx", ["wdio", "run", configPath], {
      cwd: env.workingDirectory,
      env: { ...process.env, CI: "1", ...extraEnv },
      stdio: ["ignore", "pipe", "pipe"],
      // Its own process group, so a timeout also stops the Appium service it started.
      detached: true,
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d: Buffer) => (stdout = (stdout + d.toString("utf8")).slice(-200_000)));
    child.stderr.on("data", (d: Buffer) => (stderr = (stderr + d.toString("utf8")).slice(-200_000)));
    const timer = setTimeout(() => {
      stderr += `\n[peeps] wdio did not finish in ${AGENT_RUN_TIMEOUT_MS / 1000}s and was stopped`;
      try {
        process.kill(-child.pid!, "SIGKILL");
      } catch {
        child.kill("SIGKILL");
      }
    }, AGENT_RUN_TIMEOUT_MS);
    child.on("error", (error) => {
      clearTimeout(timer);
      resolve({ code: 1, stdout, stderr: `${stderr}\ncould not start WebdriverIO: ${error.message}` });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code: code ?? 1, stdout, stderr });
    });
  });
}

/** Every test the local-results reporter recorded, with its last attempt's events. */
async function readLocalResults(resultsDir: string): Promise<LocalResultsLine[]> {
  let names: string[];
  try {
    names = (await readdir(resultsDir)).filter((name) => name.endsWith(".jsonl")).sort();
  } catch {
    return [];
  }
  const byRunId = new Map<string, LocalResultsLine>();
  for (const name of names) {
    for (const raw of (await readFile(path.join(resultsDir, name), "utf8")).split("\n")) {
      if (!raw.trim()) continue;
      let line: LocalResultsLine;
      try {
        line = JSON.parse(raw) as LocalResultsLine;
      } catch {
        continue;
      }
      const seen = byRunId.get(line.runId);
      if (seen) seen.events.push(...line.events);
      else byRunId.set(line.runId, { ...line, events: [...line.events] });
    }
  }
  return [...byRunId.values()];
}

/**
 * `run_tests` for an Appium suite: `npx wdio run` through the same wrapper
 * config `run` uses, narrowed to one spec file and, when given, the agent's
 * grep. The reporter records results locally (no Peeps runs exist for an
 * agent's run), and they come back in the Playwright `run_tests` shape, so a
 * heal or generate agent reads them unchanged: `title` is the title path
 * Peeps matches the target against, `status` is passed, failed or skipped.
 */
export async function runAppiumTests(
  env: RunnerEnv,
  input: { file: string; grep?: string },
  options: { redact?: (text: string) => string; runner?: WdioRunner } = {},
): Promise<AgentRunTestsResult> {
  const redact = options.redact ?? ((text: string) => text);
  const configPath = wdioConfigPath(env);
  const scratch = await mkdtemp(path.join(process.env.RUNNER_TEMP ?? tmpdir(), "peeps-agent-run-"));
  const planFile = path.join(scratch, "plan.json");
  const artifactsDir = path.join(scratch, "evidence");
  const resultsDir = path.join(scratch, "results");
  await mkdir(artifactsDir);
  const plan: AppiumPlanFile = { peepsUrl: env.peepsUrl, workspace: env.workspace, runs: [], resultsDir };
  await writeFile(planFile, JSON.stringify(plan), { mode: 0o600 });
  const wdioOptions: PeepsWdioOptions = {
    junitDir: null,
    // As a file URL: WebdriverIO globs a plain path, and `[id].spec.ts` is a glob.
    specs: [pathToFileURL(input.file).href],
  };
  if (input.grep) wdioOptions.grep = mochaGrepFromRegex(input.grep);

  const started = Date.now();
  let run = { code: 1, stdout: "", stderr: "" };
  let wrapper: Awaited<ReturnType<typeof writeWrapperConfig>> | undefined;
  try {
    wrapper = await writeWrapperConfig(configPath, wdioOptions);
    const extraEnv = { PEEPS_PLAN_FILE: planFile, PEEPS_ARTIFACTS_DIR: artifactsDir };
    run = await (options.runner ?? ((config, extra) => runWdioCaptured(env, config, extra)))(wrapper.configPath, extraEnv);
  } catch (error) {
    run = { ...run, stderr: `could not run WebdriverIO: ${String(error)}` };
  } finally {
    await wrapper?.cleanup().catch(() => undefined);
  }

  const sources = new Map<string, string | null>();
  const sourceOf = async (rel: string) => {
    if (!sources.has(rel)) sources.set(rel, await readFile(path.join(env.workspace, rel), "utf8").catch(() => null));
    return sources.get(rel) ?? null;
  };
  const results: AgentTestResult[] = [];
  let inlined = 0;
  for (const line of await readLocalResults(resultsDir)) {
    const end = line.events.filter((event) => event.type === "test_end").at(-1);
    if (!end) continue;
    const titles = line.titlePath.split(TITLE_PATH_SEPARATOR);
    const source = await sourceOf(line.path);
    const result: AgentTestResult = {
      title: line.titlePath,
      file: line.path,
      line: source === null ? 1 : lineOf(source, titles),
      status: end.status ?? "unknown",
    };
    if (end.error) result.error = redact(end.error.slice(0, 2000));
    if (end.errorStack) result.errorStack = redact(end.errorStack.slice(0, 4000));
    if (end.attachments?.length) {
      result.evidence = end.attachments.map((a) => ({
        name: a.name,
        path: path.join(artifactsDir, "upload", path.basename(a.path)),
        size: a.size,
      }));
      const pageSource = result.evidence.find((e) => e.name.startsWith("page-source"));
      if (pageSource && inlined < AGENT_PAGE_SOURCE_TESTS) {
        const text = await readFile(pageSource.path, "utf8").catch(() => null);
        if (text !== null) {
          inlined += 1;
          result.pageSource = redact(text.slice(0, AGENT_PAGE_SOURCE_CHARS));
          if (text.length > AGENT_PAGE_SOURCE_CHARS) result.pageSourceTruncated = true;
        }
      }
    }
    results.push(result);
  }
  const outcome: AgentRunTestsResult = {
    exitCode: run.code,
    durationMs: Date.now() - started,
    results,
    stderr: redact(run.stderr.slice(-8000)),
  };
  if (run.code !== 0 || results.length === 0) outcome.stdoutTail = redact(run.stdout.slice(-4000));
  return outcome;
}
