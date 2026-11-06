/**
 * `peeps report`: run this workflow's Playwright tests and stream the results
 * to Peeps. Steps: list the tests, ask Peeps for a plan (one run per test it
 * knows, with a credential each), run Playwright with the Peeps reporter and
 * an HTML report attached, upload the report (traces, screenshots, videos live
 * in its `data/` folder) to the batch, then tell Peeps the job is done.
 *
 * `peeps run` (Peeps-dispatched) is the same with the test selection coming
 * from Peeps instead of from Playwright's list; it reuses everything below.
 */

import { spawn } from "node:child_process";
import { prepareCaptureConfig } from "./capture-config";
import { mkdtemp, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { RunnerEnv } from "./env";
import { listTests, specFilePayload, specFilesOf, type PlaywrightList, type PlaywrightSuite } from "./inventory";
import {
  answeredNarrowed,
  exactGrepFor,
  isNarrowed,
  MAX_GREP_BYTES,
  selectionDifference,
  withReporterTitles,
  type GrepTarget,
} from "./narrow";
import type { PeepsClient } from "./peeps";
import { workspaceTestsMaySetTrace } from "./footprint/test-sources";
import { computeReach } from "./reach";
import { reachWanted } from "./reach/preflight";
import type { PlanFile } from "./reporter";

export interface PlannedTest {
  path: string;
  titlePath: string;
  pwProject: string;
}

/** Files larger than this are skipped with a note; the report itself stays usable. */
const MAX_UPLOAD_BYTES = 128 * 1024 * 1024;

/** A narrowed run's retries when the customer's config leaves them unset. */
const NARROWED_DEFAULT_RETRIES = 1;

/** Flatten Playwright's list into the identities Peeps keys on. */
export function plannedTestsOf(list: PlaywrightList, rootDir: string): PlannedTest[] {
  return listedTestsOf(list, rootDir).map(({ path, titlePath, pwProject }) => ({ path, titlePath, pwProject }));
}

/** Each test of Playwright's list: its identity, and what `exactGrepFor` needs beside it. */
export function listedTestsOf(list: PlaywrightList, rootDir: string): Array<PlannedTest & GrepTarget> {
  const out: Array<PlannedTest & GrepTarget> = [];
  // Only a `./` prefix is stripped: `.e2e` is a directory name, not a prefix.
  const trimmed = rootDir.trim();
  const root =
    trimmed === "" || trimmed === "." || trimmed === "./"
      ? ""
      : trimmed.replace(/^\.\//, "").replace(/\/+$/, "");
  const walk = (suite: PlaywrightSuite, titles: string[], isFile: boolean) => {
    const next = isFile ? titles : [...titles, suite.title];
    for (const spec of suite.specs ?? []) {
      const file = spec.file.replace(/^\.\//, "");
      const specPath = root === "" ? file : `${root}/${file}`;
      const projects = ((spec as { tests?: Array<{ projectName?: string }> }).tests ?? []).map(
        (t) => t.projectName ?? "",
      );
      for (const pwProject of projects.length ? [...new Set(projects)] : [""]) {
        const specTitles = [...next, spec.title];
        // Playwright's JSON strips each tag's `@`.
        const tags = (spec.tags ?? []).map((tag) => `@${tag}`);
        out.push({ path: specPath, titlePath: specTitles.join(" › "), pwProject, file, titles: specTitles, tags });
      }
    }
    for (const child of suite.suites ?? []) walk(child, next, false);
  };
  for (const suite of list.suites) walk(suite, [], true);
  return out;
}

interface BatchResponse {
  batches: Array<{
    projectId: string;
    batchId: string;
    batchNumber: number;
    runs: PlanFile["runs"];
    unmatched: PlannedTest[];
    /** Peeps cut this batch to the pull request's smoke tests; absent otherwise. */
    narrowed?: boolean;
    /** Record each test's footprint on this run, and the further origins that count as the application's. */
    collectFootprints?: boolean;
    footprintOrigins?: string[];
  }>;
  failures?: unknown[];
}

/** What this job really ran, for a job that sent a reach: Peeps reads `full` as not narrowed. */
export interface Executed {
  mode: "targeted" | "full";
  tests: number;
}

export async function runReport(env: RunnerEnv, peeps: PeepsClient): Promise<void> {
  if (!env.sha) throw new Error("The commit sha is not set (GITHUB_SHA / CI_COMMIT_SHA)");
  const list = await listTests(env);
  const rootDirAbs = list.config.rootDir ?? env.workingDirectory;
  const rootDir = path.relative(env.workspace, rootDirAbs).split(path.sep).join("/") || ".";
  const tests = plannedTestsOf(list, rootDir);
  console.log(`[peeps] report: ${tests.length} tests at ${env.sha.slice(0, 7)} (${env.ref ?? "?"})`);

  const jobUrl = env.runUrl;
  // The spec sources travel with the plan request so a run on a branch pins
  // the blob that executes here, not the default branch's mirror.
  const files = await specFilePayload(env, list);
  const specFiles = specFilesOf(list).map((file) => path.relative(env.workspace, path.join(rootDirAbs, file)).split(path.sep).join("/"));
  const started = Date.now();
  const reach = (await reachWanted(env, peeps)) ? await computeReach(env, { rootDir, specFiles }) : undefined;
  if (reach) console.log(`[peeps] reach in ${Date.now() - started} ms: ${reach.global ? `everything (${reach.why})` : `${reach.surfaces.length} surface(s)`}`);
  const response = await peeps.post<BatchResponse>("/api/v1/ci/batches", {
    sha: env.sha,
    jobUrl,
    baseUrl: process.env.BASE_URL ?? null,
    tests,
    files,
    canNarrow: true,
    ...(reach ? { reach } : {}),
  });
  const runs = response.batches.flatMap((b) => b.runs);
  const unmatched = response.batches.flatMap((b) => b.unmatched);
  console.log(
    `[peeps] planned ${runs.length} run(s) in ${response.batches.length} batch(es); ${unmatched.length} test(s) unknown to Peeps`,
  );
  for (const u of unmatched.slice(0, 10)) console.log(`[peeps]   unknown: ${u.path} › ${u.titlePath}`);

  const batches = response.batches.map((b) => ({ batchId: b.batchId, batchNumber: b.batchNumber }));
  const footprints = response.batches.some((b) => b.collectFootprints === true)
    ? { origins: response.batches.flatMap((b) => b.footprintOrigins ?? []), record: !workspaceTestsMaySetTrace(env.workspace, specFiles) }
    : undefined;
  if (!answeredNarrowed(response)) {
    await executeAndReport(env, peeps, { rootDir, runs, batches, footprints, executed: reach && { mode: "full", tests: tests.length } });
    return;
  }
  const listed = listedTestsOf(list, rootDir);
  const reporterRuns = withReporterTitles(runs, listed);
  if (!isNarrowed(response)) {
    console.log("[peeps] not narrowing, running the full suite: Peeps did not narrow every project's batch");
    await executeAndReport(env, peeps, { rootDir, runs: reporterRuns, batches, ranFullSuite: true, executed: reach && { mode: "full", tests: tests.length } });
    return;
  }
  // An unmatched test has no run to report to, but it is still attempted.
  const selected = [...runs, ...unmatched];
  if (selected.length === 0) {
    console.log("[peeps] narrowed to 0 test(s) for this pull request");
    // Never start Playwright without a selection: with none it runs the whole suite.
    await completeBatches(peeps, batches, reach && { mode: "targeted", tests: 0 });
    return;
  }
  const grep = await verifiedGrep(env, selected, listed, rootDir);
  if (grep === null) {
    await executeAndReport(env, peeps, { rootDir, runs: reporterRuns, batches, ranFullSuite: true, executed: reach && { mode: "full", tests: tests.length } });
    return;
  }
  console.log(`[peeps] narrowed to ${selected.length} test(s) for this pull request`);
  await executeAndReport(env, peeps, { rootDir, runs: reporterRuns, batches, selection: { files: [], grep }, narrowed: true, executed: reach && { mode: "targeted", tests: selected.length } });
}

const named = (tests: Array<{ path: string; titlePath: string }>) =>
  tests.slice(0, 10).map((test) => `${test.path} › ${test.titlePath}`).join("; ");

/**
 * The grep that runs exactly the selected tests, or null when the run must fall
 * back to the full suite, having said why. Playwright itself lists what the grep
 * selects, which answers for anything `exactGrepFor` can't see: what a tag holds,
 * how this Playwright builds the title it matches, a command too long for npx's shell.
 */
async function verifiedGrep(
  env: RunnerEnv,
  selected: PlannedTest[],
  listed: Array<PlannedTest & GrepTarget>,
  rootDir: string,
): Promise<string | null> {
  const fallBack = (why: string) => {
    console.log(`[peeps] not narrowing, running the full suite: ${why}`);
    return null;
  };
  const unlisted = selectionDifference(selected, listed).missing;
  if (unlisted.length > 0) {
    return fallBack(`${unlisted.length} selected test(s) not in Playwright's list: ${named(unlisted)}`);
  }
  const grep = exactGrepFor(selected, listed);
  const bytes = Buffer.byteLength(grep);
  if (bytes > MAX_GREP_BYTES) return fallBack(`its grep is ${bytes} bytes, over the limit of ${MAX_GREP_BYTES}`);
  let found: Array<PlannedTest & GrepTarget>;
  try {
    // `--no-deps`: otherwise a dependency project is listed whole, whatever the grep says. The run keeps its dependencies.
    found = listedTestsOf(await listTests(env, ["--grep", grep, "--no-deps"]), rootDir);
  } catch (error) {
    // Its stderr, if it got that far: the error's own message repeats the whole command.
    const why = (error as { stderr?: string }).stderr || String(error);
    return fallBack(`Playwright could not list the grep's tests: ${why.slice(0, 500)}`);
  }
  const { missing, extra } = selectionDifference(selected, found);
  if (missing.length > 0) return fallBack(`${missing.length} test(s) not selected by its grep: ${named(missing)}`);
  if (extra.length > 0) return fallBack(`${extra.length} other test(s) also selected by its grep: ${named(extra)}`);
  return grep;
}

export async function completeBatches(peeps: PeepsClient, batches: Array<{ batchId: string }>, executed?: Executed): Promise<void> {
  for (const b of batches) {
    try {
      await peeps.post(`/api/v1/ci/batches/${b.batchId}/complete`, { reportUploaded: false, ...(executed ? { executed } : {}) });
    } catch (error) {
      console.log(`[peeps] could not complete batch ${b.batchId}: ${String(error)}`);
    }
  }
}

/**
 * Shared tail of `report` and `run`: write the plan, run Playwright with the
 * Peeps reporter and an HTML report, upload the report, close the batches.
 * `selection` narrows Playwright to the planned tests (`run` mode and a narrowed `report`).
 */
export async function executeAndReport(
  env: RunnerEnv,
  peeps: PeepsClient,
  input: {
    rootDir: string;
    runs: PlanFile["runs"];
    batches: Array<{ batchId: string; batchNumber: number }>;
    selection?: { files: string[]; grep: string };
    /** Run mode: the Peeps environment's variables (`environment.ts`). */
    extraEnv?: Record<string, string>;
    /** Peeps narrowed this pull request run (`narrow.ts`). */
    narrowed?: boolean;
    /** Peeps answered narrowed, and this run fell back: each batch's `complete` says so. */
    ranFullSuite?: boolean;
    /** Peeps asked for each test's footprint on this run (`footprint.ts`). */
    footprints?: NonNullable<PlanFile["footprints"]> & { record: boolean };
    /** This job sent a reach: each batch's `complete` says what it ran. */
    executed?: Executed;
  },
): Promise<void> {
  const scratch = await mkdtemp(path.join(process.env.RUNNER_TEMP ?? tmpdir(), "peeps-"));
  const planFile = path.join(scratch, "plan.json");
  const reportDir = path.join(scratch, "report");
  const plan: PlanFile = { peepsUrl: env.peepsUrl, rootDir: input.rootDir, runs: input.runs };
  if (input.narrowed) plan.narrowed = true;
  if (input.footprints) plan.footprints = { origins: input.footprints.origins };
  await writeFile(planFile, JSON.stringify(plan), { mode: 0o600 });

  const exitCode = await runPlaywright(env, planFile, reportDir, input.selection, input.extraEnv, input.narrowed, input.footprints?.record === true);

  let reportUploaded = false;
  for (const b of input.batches) {
    try {
      const uploaded = await uploadReport(peeps, b.batchId, reportDir);
      reportUploaded = uploaded > 0;
      console.log(`[peeps] uploaded ${uploaded} report file(s) for batch ${b.batchNumber}`);
    } catch (error) {
      console.log(`[peeps] report upload failed for batch ${b.batchId}: ${String(error)}`);
    }
    try {
      await peeps.post(`/api/v1/ci/batches/${b.batchId}/complete`, {
        reportUploaded,
        ...(input.ranFullSuite ? { ranFullSuite: true } : {}),
        ...(input.executed ? { executed: input.executed } : {}),
      });
    } catch (error) {
      console.log(`[peeps] could not complete batch ${b.batchId}: ${String(error)}`);
    }
  }
  console.log(`[peeps] playwright exited with ${exitCode}`);
  if (exitCode !== 0) process.exitCode = exitCode;
}

async function runPlaywright(
  env: RunnerEnv,
  planFile: string,
  reportDir: string,
  selection?: { files: string[]; grep: string },
  extraEnv: Record<string, string> = {},
  narrowed = false,
  collectFootprints = false,
): Promise<number> {
  const reporterPath = path.join(__dirname, "reporter.js");
  const args = ["playwright", "test", `--reporter=${reporterPath},list,html`];
  let capture: Awaited<ReturnType<typeof prepareCaptureConfig>> | undefined;
  try {
    capture = await prepareCaptureConfig(env, {
      ...(narrowed ? { defaultRetries: NARROWED_DEFAULT_RETRIES } : {}),
      ...(collectFootprints ? { collectFootprints } : {}),
    });
  } catch (error) {
    console.warn(`[peeps] screenshot/video defaults could not be applied; using the original config: ${String(error)}`);
  }
  const configPath = capture?.configPath ?? env.configPath;
  if (configPath) args.push("--config", configPath);
  if (selection) {
    // `--grep` before `--`, then the file list. The paths come from Peeps'
    // plan, so without the separator an entry like `--config=whatever.ts`
    // survives the path math unchanged and reaches Playwright as an OPTION
    // rather than a file. Everything after `--` is a positional argument.
    args.push("--grep", selection.grep, "--", ...selection.files);
  }
  try {
    return await new Promise((resolve) => {
      const couldNotStart = (error: unknown) => {
        console.error(`[peeps] could not start Playwright: ${String(error)}`);
        resolve(1);
      };
      try {
        const child = spawn("npx", args, {
          cwd: env.workingDirectory,
          stdio: "inherit",
          env: {
            ...process.env,
            ...extraEnv,
            CI: "1",
            PEEPS_PLAN_FILE: planFile,
            PLAYWRIGHT_HTML_OUTPUT_DIR: reportDir,
            PLAYWRIGHT_HTML_OPEN: "never",
          },
        });
        child.on("error", couldNotStart);
        child.on("close", (code) => resolve(code ?? 1));
      } catch (error) {
        // E2BIG throws here rather than emitting `error`; the batches must still close.
        couldNotStart(error);
      }
    });
  } finally {
    await capture?.cleanup().catch((error: unknown) => {
      console.warn(`[peeps] could not remove temporary capture config: ${String(error)}`);
    });
  }
}

async function* walk(dir: string, rel = ""): AsyncGenerator<{ abs: string; rel: string }> {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const abs = path.join(dir, entry.name);
    const relPath = rel ? `${rel}/${entry.name}` : entry.name;
    if (entry.isDirectory()) yield* walk(abs, relPath);
    else if (entry.isFile()) yield { abs, rel: relPath };
  }
}

/** Upload every file of the HTML report; returns how many landed. */
export async function uploadReport(peeps: PeepsClient, batchId: string, reportDir: string): Promise<number> {
  let uploaded = 0;
  for await (const file of walk(reportDir)) {
    const info = await stat(file.abs);
    if (info.size > MAX_UPLOAD_BYTES) {
      console.log(`[peeps] skipping ${file.rel}: ${info.size} bytes exceeds the upload limit`);
      continue;
    }
    const bytes = await readFile(file.abs);
    try {
      await peeps.postBytes(
        `/api/v1/ci/batches/${batchId}/artifacts?path=${encodeURIComponent(file.rel)}`,
        bytes,
      );
      uploaded += 1;
    } catch (error) {
      // One refused or failed file (Peeps accepts only the report's own
      // shape) must not stop the rest of the report from landing.
      console.log(`[peeps] skipped ${file.rel}: ${String(error).slice(0, 200)}`);
    }
  }
  return uploaded;
}
