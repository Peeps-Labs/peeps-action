/**
 * The pytest (pytest-playwright) path of every mode that runs tests.
 *
 * The Playwright path lists with `playwright test --list`, selects with
 * `--grep` and reports through a Playwright reporter. Here the same three jobs
 * go through pytest itself, with a small plugin shipped in this action
 * (`python/peeps_pytest_plugin.py`):
 *
 *   inventory  `pytest --collect-only`; the plugin writes each collected item
 *              as Peeps' runner contract names it, and that goes to
 *              `POST /api/v1/ci/inventory` with the module sources.
 *   report     collect, ask Peeps for a plan, run the suite, and let the
 *              plugin stream `test_start`/`test_end` for every planned node id.
 *   run        collect, ask Peeps what the dispatched batch holds, and run
 *              exactly those node ids — selected by node id, never by title.
 *
 * pytest-playwright's `--output` directory (traces, screenshots, videos) is
 * uploaded to the batch afterwards, each file named after the run it belongs
 * to.
 *
 * Collection imports the customer's test modules and conftest files, as any
 * pytest collection does; the plugin itself imports nothing of theirs.
 */

import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, realpathSync } from "node:fs";
import { mkdtemp, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { RunnerEnv } from "./env";
import { gitBlobSha } from "./inventory";
import type { PeepsClient } from "./peeps";
import type { PlanEntry } from "./reporter";
import type { PlannedTest } from "./report";

/** Where `peeps_pytest_plugin.py` lives: `<action>/python`, from src/ or dist/. */
export const PLUGIN_DIR = path.join(__dirname, "..", "python");
const PLUGIN = "peeps_pytest_plugin";

/** One collected item, exactly as the plugin writes it (Peeps' runner contract). */
export interface PytestItem {
  nodeId: string;
  /** `item.callspec.params["browser_name"]`: the browser pytest-playwright parametrized it with. */
  browser: string | null;
  /** 1-based. */
  line: number | null;
  markers: string[];
}

export interface PytestCollection {
  /** pytest's rootdir, absolute. Node ids are relative to it. */
  rootDir: string;
  /** The config file collection read (`pytest.ini`, `pyproject.toml`…), absolute; null for none. */
  iniPath?: string | null;
  /** Whether pytest-playwright is loaded, and so whether `--output` exists. */
  playwright: boolean;
  /** The tests this session runs. */
  items: PytestItem[];
  /**
   * Tests `-m`/`-k` deselected (often from the customer's addopts): in the
   * repository, so in the inventory, but never planned or run.
   */
  deselected?: PytestItem[];
  /** Collectors that failed: a module that did not import, a bad parametrize. */
  errors: Array<{ nodeId: string; message: string }>;
}

// ---------------------------------------------------------------------------
// Which framework
// ---------------------------------------------------------------------------

export type Framework = "playwright" | "pytest";

const PLAYWRIGHT_CONFIG = /^playwright(\..+)?\.config\.[cm]?[jt]s$/;

/**
 * The framework this job runs. An explicit `framework` input wins. Otherwise
 * Playwright, unless the working directory has pytest configuration and no
 * Playwright config (and no `config` input, which names a Playwright config):
 * every workflow written before pytest support keeps the path it had.
 */
export function resolveFramework(env: RunnerEnv): Framework {
  const declared = env.framework;
  if (declared === "playwright" || declared === "pytest") return declared;
  if (declared !== null && declared !== "auto") {
    throw new Error(`unknown framework "${declared}": use playwright, pytest or auto`);
  }
  if (env.configPath) return "playwright";
  let names: string[];
  try {
    names = readdirSync(env.workingDirectory);
  } catch {
    return "playwright";
  }
  if (names.some((name) => PLAYWRIGHT_CONFIG.test(name))) return "playwright";
  if (names.includes("pytest.ini") || names.includes("conftest.py")) return "pytest";
  const pyproject = path.join(env.workingDirectory, "pyproject.toml");
  if (
    existsSync(pyproject) &&
    /^\s*\[tool\.pytest(\.ini_options)?\]/m.test(readFileSync(pyproject, "utf8"))
  ) {
    return "pytest";
  }
  return "playwright";
}

// ---------------------------------------------------------------------------
// Identity: mirrors `pytestNodeIdToTest` in Peeps' src/server/repo-backed/test-identity.ts
// ---------------------------------------------------------------------------

export const TITLE_PATH_SEPARATOR = " › ";

/** Where the parameter id starts: the first `[` after the first `::`. */
function splitParameter(nodeId: string): { head: string; parameter: string | null } {
  const open = nodeId.indexOf("[", Math.max(0, nodeId.indexOf("::")));
  if (open === -1 || !nodeId.endsWith("]")) return { head: nodeId, parameter: null };
  return { head: nodeId.slice(0, open), parameter: nodeId.slice(open + 1, -1) };
}

function withoutBrowser(parameter: string, browser: string): string | null {
  if (parameter === browser) return null;
  if (parameter.startsWith(`${browser}-`)) return parameter.slice(browser.length + 1);
  if (parameter.endsWith(`-${browser}`)) return parameter.slice(0, -browser.length - 1);
  return parameter;
}

function normalizeRoot(rootDir: string): string {
  const trimmed = rootDir.trim();
  if (trimmed === "" || trimmed === "." || trimmed === "./") return "";
  return trimmed.replace(/^\.\//, "").replace(/\/+$/, "");
}

/**
 * A node id as the identity Peeps keys on: the module's repo-relative path and
 * the rest of the node id with each `::` spelled ` › `, the browser
 * pytest-playwright added to the parameter id removed. Peeps computes the same
 * thing from the inventory this action posts; the two must agree, which is
 * why this is a line-for-line copy of Peeps' `pytestNodeIdToTest`.
 */
export function pytestNodeIdToTest(
  nodeId: string,
  options: { rootDir?: string; browser?: string | null } = {},
): { path: string; titlePath: string } {
  const { head, parameter } = splitParameter(nodeId);
  const [file, ...scopes] = head.split("::");
  if (!file || scopes.length === 0 || scopes.some((scope) => scope === "")) {
    throw new Error(`not a pytest test node id: ${nodeId}`);
  }
  const kept =
    parameter !== null && options.browser ? withoutBrowser(parameter, options.browser) : parameter;
  const root = normalizeRoot(options.rootDir ?? ".");
  return {
    path: root === "" ? file : `${root}/${file}`,
    titlePath: scopes.join(TITLE_PATH_SEPARATOR) + (kept === null ? "" : `[${kept}]`),
  };
}

function planKey(test: { path: string; titlePath: string; pwProject: string }): string {
  return `${test.pwProject} ${test.path} ${test.titlePath}`;
}

/** Each collected item as Peeps plans it; the browser is the "project". */
export function plannedPytestTests(
  collection: PytestCollection,
  rootDir: string,
): Array<PlannedTest & { nodeId: string }> {
  return collection.items.flatMap((item) => {
    try {
      return [
        {
          ...pytestNodeIdToTest(item.nodeId, { rootDir, browser: item.browser }),
          pwProject: item.browser ?? "",
          nodeId: item.nodeId,
        },
      ];
    } catch {
      // Not a `file::test` item (a plugin's own item type): Peeps cannot name it.
      console.log(`[peeps] not a test node id, not reported: ${item.nodeId}`);
      return [];
    }
  });
}

/**
 * Match Peeps' planned runs back to the node ids that will execute them. A run
 * with no collected node id (the test was renamed or deleted since Peeps
 * planned it) is returned separately; nothing runs for it.
 */
export function nodeIdsForRuns(
  planned: Array<PlannedTest & { nodeId: string }>,
  runs: PlanEntry[],
): { byNodeId: Record<string, PlanEntry>; unmatched: PlanEntry[] } {
  const nodeIdOf = new Map(planned.map((t) => [planKey(t), t.nodeId]));
  const byNodeId: Record<string, PlanEntry> = {};
  const unmatched: PlanEntry[] = [];
  for (const run of runs) {
    const nodeId = nodeIdOf.get(planKey(run));
    if (nodeId === undefined) unmatched.push(run);
    else byNodeId[nodeId] = run;
  }
  return { byNodeId, unmatched };
}

// ---------------------------------------------------------------------------
// Running pytest
// ---------------------------------------------------------------------------

/** The plugin on `PYTHONPATH`, ahead of whatever the job already has there. */
function pytestEnv(extra: Record<string, string>): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, CI: "1", ...extra };
  env.PYTHONPATH = process.env.PYTHONPATH
    ? `${PLUGIN_DIR}${path.delimiter}${process.env.PYTHONPATH}`
    : PLUGIN_DIR;
  if (!("PEEPS_PLAN_FILE" in extra)) delete env.PEEPS_PLAN_FILE;
  if (!("PEEPS_COLLECT_OUT" in extra)) delete env.PEEPS_COLLECT_OUT;
  return env;
}

/**
 * `python -m pytest <args>`, falling back to `python3` where there is no
 * `python` (the Playwright Python image has both; a bare Ubuntu runner only
 * `python3`). `PEEPS_PYTHON` names another interpreter, e.g. a virtualenv's.
 */
function spawnPytest(
  args: string[],
  options: { cwd: string; env: NodeJS.ProcessEnv; capture: boolean },
): Promise<{ code: number; output: string }> {
  const candidates = process.env.PEEPS_PYTHON ? [process.env.PEEPS_PYTHON] : ["python", "python3"];
  const attempt = (index: number): Promise<{ code: number; output: string }> =>
    new Promise((resolve, reject) => {
      const child = spawn(candidates[index]!, ["-m", "pytest", ...args], {
        cwd: options.cwd,
        env: options.env,
        stdio: options.capture ? ["ignore", "pipe", "pipe"] : "inherit",
      });
      let output = "";
      const keep = (chunk: Buffer) => {
        output = (output + chunk.toString("utf8")).slice(-20_000);
      };
      child.stdout?.on("data", keep);
      child.stderr?.on("data", keep);
      child.on("error", (error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT" && index + 1 < candidates.length) {
          resolve(attempt(index + 1));
        } else {
          reject(new Error(`could not start ${candidates[index]}: ${error.message}`));
        }
      });
      child.on("close", (code) => resolve({ code: code ?? 1, output }));
    });
  return attempt(0);
}

function configArgs(env: RunnerEnv): string[] {
  return env.configPath ? ["-c", env.configPath] : [];
}

/** What pytest collects here, as the plugin reports it. */
export async function collectPytest(env: RunnerEnv): Promise<PytestCollection> {
  const scratch = await mkdtemp(path.join(process.env.RUNNER_TEMP ?? tmpdir(), "peeps-collect-"));
  const out = path.join(scratch, "collection.json");
  const { code, output } = await spawnPytest(
    ["--collect-only", "-q", "-p", PLUGIN, ...configArgs(env)],
    { cwd: env.workingDirectory, env: pytestEnv({ PEEPS_COLLECT_OUT: out }), capture: true },
  );
  // 0: collected. 5: nothing to collect. 2: interrupted by collection errors,
  // which the plugin records per module; everything else still collected.
  if (![0, 2, 5].includes(code) || !existsSync(out)) {
    throw new Error(`pytest --collect-only exited with ${code}:\n${output.slice(-4000)}`);
  }
  const collection = JSON.parse(await readFile(out, "utf8")) as PytestCollection;
  for (const error of collection.errors) {
    console.log(`[peeps] collection error in ${error.nodeId}:\n${error.message}`);
  }
  return collection;
}

/**
 * `abs` relative to the repository root. pytest reports real paths, and a
 * workspace reached through a symlink (macOS's `/var` is one) would otherwise
 * come out as `../../private/…`; a path outside the repository is refused.
 */
function repoRelative(env: RunnerEnv, abs: string): string {
  let workspace = env.workspace;
  try {
    workspace = realpathSync(workspace);
  } catch {
    // Missing workspace: compare as given.
  }
  const rel = path.relative(workspace, abs).split(path.sep).join("/");
  if (rel === ".." || rel.startsWith("../") || path.isAbsolute(rel)) {
    throw new Error(`${abs} is outside the repository (${env.workspace})`);
  }
  return rel;
}

/** pytest's rootdir, relative to the repository root ("." for the root). */
export function repoRootDir(env: RunnerEnv, collection: PytestCollection): string {
  return repoRelative(env, collection.rootDir) || ".";
}

/** Every module the collection names, as Peeps wants it: repo-relative path, blob sha, contents. */
export async function moduleFilePayload(env: RunnerEnv, collection: PytestCollection) {
  const modules = new Set(
    [...collection.items, ...(collection.deselected ?? [])].map((item) => item.nodeId.split("::")[0]!),
  );
  const files = [];
  for (const file of [...modules].sort()) {
    const abs = path.join(collection.rootDir, file);
    const bytes = await readFile(abs);
    files.push({
      path: repoRelative(env, abs),
      blobSha: gitBlobSha(bytes),
      content: bytes.toString("utf8"),
    });
  }
  return files;
}

// ---------------------------------------------------------------------------
// Modes
// ---------------------------------------------------------------------------

/** The body of `POST /api/v1/ci/inventory` for a pytest suite. */
export async function buildPytestInventoryRequest(env: RunnerEnv, collection: PytestCollection) {
  if (!env.sha) throw new Error("GITHUB_SHA is not set");
  return {
    sha: env.sha,
    framework: "pytest" as const,
    // Node ids are relative to pytest's rootdir; Peeps joins them onto this.
    rootDir: repoRootDir(env, collection),
    // Deselected tests too: they exist, and Peeps must not read their absence
    // from a module it received in full as their removal.
    items: [...collection.items, ...(collection.deselected ?? [])],
    // A module that failed to collect is present but unread: Peeps must not
    // take its tests' absence from `items` as their deletion.
    collectionErrors: collection.errors.map((error) => error.nodeId),
    files: await moduleFilePayload(env, collection),
  };
}

export async function runPytestInventory(env: RunnerEnv, peeps: PeepsClient): Promise<void> {
  const collection = await collectPytest(env);
  const request = await buildPytestInventoryRequest(env, collection);
  console.log(
    `[peeps] inventory: ${collection.items.length} pytest items in ${request.files.length} modules at ${request.sha.slice(0, 7)}`,
  );
  const result = await peeps.post<{ results: unknown[] }>("/api/v1/ci/inventory", request);
  console.log(`[peeps] inventory accepted: ${JSON.stringify(result.results)}`);
}

interface BatchResponse {
  batches: Array<{
    batchId: string;
    batchNumber: number;
    runs: PlanEntry[];
    unmatched: PlannedTest[];
  }>;
}

/** `report`: run this workflow's whole suite and report every planned test. */
export async function runPytestReport(env: RunnerEnv, peeps: PeepsClient): Promise<void> {
  if (!env.sha) throw new Error("GITHUB_SHA is not set");
  const collection = await collectPytest(env);
  const rootDir = repoRootDir(env, collection);
  const planned = plannedPytestTests(collection, rootDir);
  console.log(`[peeps] report: ${planned.length} tests at ${env.sha.slice(0, 7)} (${env.ref ?? "?"})`);
  const jobUrl =
    env.repository && env.runId ? `https://github.com/${env.repository}/actions/runs/${env.runId}` : null;
  const response = await peeps.post<BatchResponse>("/api/v1/ci/batches", {
    sha: env.sha,
    jobUrl,
    baseUrl: process.env.BASE_URL ?? null,
    tests: planned.map(({ path: p, titlePath, pwProject }) => ({ path: p, titlePath, pwProject })),
    files: await moduleFilePayload(env, collection),
  });
  const runs = response.batches.flatMap((b) => b.runs);
  const unmatched = response.batches.flatMap((b) => b.unmatched);
  console.log(
    `[peeps] planned ${runs.length} run(s) in ${response.batches.length} batch(es); ${unmatched.length} test(s) unknown to Peeps`,
  );
  for (const u of unmatched.slice(0, 10)) console.log(`[peeps]   unknown: ${u.path} › ${u.titlePath}`);
  const { byNodeId } = nodeIdsForRuns(planned, runs);
  await executePytestAndReport(env, peeps, {
    collection,
    byNodeId,
    batches: response.batches.map((b) => ({ batchId: b.batchId, batchNumber: b.batchNumber })),
  });
}

interface Plan {
  batchId: string;
  batchNumber: number;
  runs: PlanEntry[];
}

/** `run`: Peeps dispatched this job for one batch; run exactly its tests, by node id. */
export async function runPytestDispatched(env: RunnerEnv, peeps: PeepsClient): Promise<void> {
  if (!env.sessionId) throw new Error("`session-id` is required in run mode (Peeps passes it)");
  const collection = await collectPytest(env);
  const rootDir = repoRootDir(env, collection);
  const planned = plannedPytestTests(collection, rootDir);
  // The collected tests go with the plan request, as the Playwright path's
  // list does: Peeps expands its plan to one run per browser really run here.
  const plan = await peeps.post<Plan>(`/api/v1/ci/batches/${env.sessionId}/plan`, {
    tests: planned.map(({ path: p, titlePath, pwProject }) => ({ path: p, titlePath, pwProject })).slice(0, 2000),
  });
  console.log(`[peeps] run: batch ${plan.batchNumber} holds ${plan.runs.length} run(s)`);
  const { byNodeId, unmatched } = nodeIdsForRuns(planned, plan.runs);
  for (const run of unmatched.slice(0, 10)) {
    console.log(`[peeps]   not collected here, not run: ${run.path} › ${run.titlePath}`);
  }
  const nodeIds = Object.keys(byNodeId);
  if (nodeIds.length === 0) {
    // Never start pytest without node ids: with none it runs the whole suite.
    await peeps.post(`/api/v1/ci/batches/${plan.batchId}/complete`, { reportUploaded: false });
    if (plan.runs.length > 0) {
      throw new Error(`none of the ${plan.runs.length} planned test(s) were collected at this commit`);
    }
    return;
  }
  await executePytestAndReport(env, peeps, {
    collection,
    byNodeId,
    batches: [{ batchId: plan.batchId, batchNumber: plan.batchNumber }],
    nodeIds,
  });
}

/**
 * Node ids are relative to pytest's rootdir, but pytest resolves its
 * arguments against the directory it runs in; turn each into an argument
 * that names the same node from `cwd`.
 */
export function nodeIdArgument(nodeId: string, rootDirAbs: string, cwd: string): string {
  const separator = nodeId.indexOf("::");
  const file = separator === -1 ? nodeId : nodeId.slice(0, separator);
  const rest = separator === -1 ? "" : nodeId.slice(separator);
  let from = cwd;
  try {
    from = realpathSync(cwd);
  } catch {
    // As given.
  }
  const relative = path.relative(from, path.join(rootDirAbs, file)).split(path.sep).join("/");
  return relative + rest;
}

/**
 * Shared tail of `report` and `run`: write the plan for the plugin, run
 * pytest, upload pytest-playwright's output, close the batches.
 */
export async function executePytestAndReport(
  env: RunnerEnv,
  peeps: PeepsClient,
  input: {
    collection: PytestCollection;
    byNodeId: Record<string, PlanEntry>;
    batches: Array<{ batchId: string; batchNumber: number }>;
    /** Run only these (run mode); omitted runs the whole suite (report mode). */
    nodeIds?: string[];
  },
): Promise<void> {
  const scratch = await mkdtemp(path.join(process.env.RUNNER_TEMP ?? tmpdir(), "peeps-"));
  const planFile = path.join(scratch, "plan.json");
  const resultsFile = path.join(scratch, "results.json");
  const outputDir = path.join(scratch, "output");
  const runs = Object.fromEntries(
    Object.entries(input.byNodeId).map(([nodeId, run]) => [
      nodeId,
      { runId: run.runId, credential: run.credential },
    ]),
  );
  await writeFile(planFile, JSON.stringify({ peepsUrl: env.peepsUrl, runs }), { mode: 0o600 });

  // `--rootdir` pinned to what collection found: node ids are relative to it,
  // and explicit node-id arguments under a nested pytest config would
  // otherwise move it, renaming every test away from its plan entry.
  // The config file too, for the same reason: a nested `pytest.ini` beside the
  // selected modules would otherwise become the config, and stop pytest
  // loading the conftest files above it.
  const config = env.configPath
    ? configArgs(env)
    : input.collection.iniPath
      ? ["-c", input.collection.iniPath]
      : [];
  const args = ["-p", PLUGIN, "--rootdir", input.collection.rootDir, ...config];
  // `--output` is pytest-playwright's option; plain pytest would refuse it.
  if (input.collection.playwright) args.push("--output", outputDir);
  if (input.nodeIds) {
    // After `--`, so a node id can never be read as an option.
    args.push(
      "--",
      ...input.nodeIds.map((id) => nodeIdArgument(id, input.collection.rootDir, env.workingDirectory)),
    );
  }
  // A pytest that cannot even start still has its batches closed below, so no
  // planned run is left waiting for a job that is already over.
  const code = await spawnPytest(args, {
    cwd: env.workingDirectory,
    env: pytestEnv({ PEEPS_PLAN_FILE: planFile, PEEPS_RESULTS_OUT: resultsFile }),
    capture: false,
  }).then(
    (result) => result.code,
    (error: unknown) => {
      console.log(`[peeps] ${String(error)}`);
      return 1;
    },
  );

  const runIdByOutputDir = await readOutputDirs(resultsFile, input.byNodeId);
  for (const b of input.batches) {
    try {
      const uploaded = await uploadOutput(peeps, b.batchId, outputDir, runIdByOutputDir);
      console.log(`[peeps] uploaded ${uploaded} artifact file(s) for batch ${b.batchNumber}`);
    } catch (error) {
      console.log(`[peeps] artifact upload failed for batch ${b.batchId}: ${String(error)}`);
    }
    try {
      // `reportUploaded` stamps the batch's Playwright HTML report
      // (`index.html`) as every run's artifact link. pytest writes no such
      // report, so the link would 404: the artifacts are in the batch's
      // `data/`, named by run, and nothing links them yet.
      await peeps.post(`/api/v1/ci/batches/${b.batchId}/complete`, { reportUploaded: false });
    } catch (error) {
      console.log(`[peeps] could not complete batch ${b.batchId}: ${String(error)}`);
    }
  }
  console.log(`[peeps] pytest exited with ${code}`);
  if (code !== 0) process.exitCode = code;
}

/** pytest-playwright's per-test directory name → the Peeps run that test reported to. */
async function readOutputDirs(
  resultsFile: string,
  byNodeId: Record<string, PlanEntry>,
): Promise<Map<string, string>> {
  const map = new Map<string, string>();
  try {
    const results = JSON.parse(await readFile(resultsFile, "utf8")) as {
      outputDirs?: Record<string, string>;
    };
    for (const [nodeId, dir] of Object.entries(results.outputDirs ?? {})) {
      const run = byNodeId[nodeId];
      if (run) map.set(path.basename(dir), run.runId);
    }
  } catch {
    // No results file: pytest died before its session finished. The files
    // still upload, just without a run in their names.
  }
  return map;
}

/** Files larger than this are skipped with a note, as the Playwright path does. */
const MAX_UPLOAD_BYTES = 128 * 1024 * 1024;

/**
 * The batch-relative name one output file is stored under. Peeps stores a
 * customer runner's files only in the Playwright report's own shape, and
 * attachments there live flat under `data/`; so `<test dir>/trace.zip`
 * becomes `data/<runId>-trace.zip`, and a file of no planned test keeps its
 * path, flattened.
 */
export function artifactName(rel: string, runIdByOutputDir: Map<string, string>): string {
  const [dir, ...rest] = rel.split("/");
  const runId = rest.length > 0 ? runIdByOutputDir.get(dir!) : undefined;
  const flat = (runId ? [runId, ...rest] : [dir!, ...rest]).join("-").replace(/[^A-Za-z0-9._-]/g, "_");
  if (flat.length <= 200) return `data/${flat}`;
  const ext = path.extname(flat);
  return `data/${createHash("sha1").update(rel).digest("hex")}${ext}`;
}

async function* walkOutput(dir: string, rel = ""): AsyncGenerator<{ abs: string; rel: string }> {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const abs = path.join(dir, entry.name);
    const relPath = rel ? `${rel}/${entry.name}` : entry.name;
    if (entry.isDirectory()) yield* walkOutput(abs, relPath);
    else if (entry.isFile()) yield { abs, rel: relPath };
  }
}

async function uploadOutput(
  peeps: PeepsClient,
  batchId: string,
  outputDir: string,
  runIdByOutputDir: Map<string, string>,
): Promise<number> {
  let uploaded = 0;
  for await (const file of walkOutput(outputDir)) {
    const info = await stat(file.abs);
    if (info.size > MAX_UPLOAD_BYTES) {
      console.log(`[peeps] skipping ${file.rel}: ${info.size} bytes exceeds the upload limit`);
      continue;
    }
    const name = artifactName(file.rel, runIdByOutputDir);
    try {
      await peeps.postBytes(
        `/api/v1/ci/batches/${batchId}/artifacts?path=${encodeURIComponent(name)}`,
        await readFile(file.abs),
      );
      uploaded += 1;
    } catch (error) {
      console.log(`[peeps] skipped ${file.rel}: ${String(error).slice(0, 200)}`);
    }
  }
  return uploaded;
}
