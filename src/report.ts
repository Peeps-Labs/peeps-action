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
import { existsSync, realpathSync } from "node:fs";
import { prepareCaptureConfig } from "./capture-config";
import { mkdtemp, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { AppInput, RunnerEnv } from "./env";
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
import { PeepsHttpError, type PeepsClient } from "./peeps";
import { workspaceTestSources } from "./footprint/test-sources";
import type { AttemptFile } from "./evidence/browser/worker";
import { prepareImpact, type PreparedImpact, type PreparedProject } from "./evidence/job";
import { coverageConflictIn } from "./evidence/browser/conflict";
import { membersOf, type AttemptRecord, type ContextMarker, type ServerEvidence } from "./evidence/members";
import { openScratch } from "./evidence/scratch";
import { recordServer, specFilter } from "./evidence/server/record";
import { peepsTransport, uploadEvidence } from "./evidence/upload";
import { computeReach } from "./reach";
import { localRepository } from "./reach/git";
import { announceFieldsOf, negotiateTargetedRuns } from "./reach/preflight";
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
  const negotiated = await negotiateTargetedRuns(env, peeps);
  const computed = negotiated.scan ? await computeReach(env, { specFiles }) : undefined;
  if (computed) console.log(`[peeps] reach in ${Date.now() - started} ms: ${computed.global ? `everything (${computed.why})` : `${computed.surfaces.length} surface(s)`}`);
  const announce = {
    sha: env.sha,
    jobUrl,
    baseUrl: process.env.BASE_URL ?? null,
    tests,
    files,
    ...announceFieldsOf(negotiated),
  };
  // Only when Peeps asked: the head build's fingerprint, whose receipt the announce cites.
  let impact = negotiated.collect
    ? await prepareImpact({
        appDir: env.workingDirectory,
        sha: env.sha,
        eventName: env.eventName,
        leg: process.env.GITHUB_JOB ?? "",
        collect: negotiated.collect,
        repository: await localRepository(env.workspace),
        transport: peepsTransport(env.peepsUrl, () => peeps.token()),
      })
    : null;
  let reach = computed;
  let response: BatchResponse;
  try {
    response = await peeps.post<BatchResponse>("/api/v1/ci/batches", { ...announce, ...(reach ? { reach } : {}), ...(impact ? { impact: { receipts: impact.projects.slice(0, MAX_RECEIPTS).map(({ receipt }) => receipt) } } : {}) });
  } catch (error) {
    // A reach or an impact receipt the server won't take costs that run its narrowing and recording, never the job.
    if ((!reach && !impact) || !(error instanceof PeepsHttpError) || error.status >= 500 || error.status === 401 || error.status === 403) throw error;
    console.log(`[peeps] Peeps refused what this ${reach ? "pull request reaches" : "job recorded"} (${error.status}), so everything runs and nothing is recorded`);
    reach = undefined;
    impact = null;
    response = await peeps.post<BatchResponse>("/api/v1/ci/batches", announce);
  }
  // Each project Peeps took a receipt for: its footprints follow after the run, under its own batch, for its runs.
  const recorded = impact?.projects
    .slice(0, MAX_RECEIPTS)
    .map((project) => ({ project, batch: response.batches.find((b) => b.projectId === project.projectId) }))
    .filter((p): p is { project: PreparedProject; batch: BatchResponse["batches"][number] } => p.batch !== undefined)
    .map(({ project, batch }) => ({ ...project, batchId: batch.batchId, runIds: batch.runs.map((run) => run.runId) }));
  // Fail safe: a suite that may run precise coverage itself resets ours (see `conflict.ts`).
  const conflict = recorded?.some((p) => p.collect.coverage) ? await coverageConflictIn([rootDirAbs, env.workingDirectory]) : null;
  if (conflict) console.log(`[peeps] not recording browser coverage: ${conflict}`);
  const server = recorded && recorded.length > 0 ? serverPlanOf(env, recorded, rootDirAbs, specFilesOf(list)) : null;
  const recording = impact && recorded && recorded.length > 0 ? { impact: { fingerprint: impact.fingerprint, projects: recorded, coverage: conflict === null, ...(server ? { server } : {}) } } : {};
  const runs = response.batches.flatMap((b) => b.runs);
  const unmatched = response.batches.flatMap((b) => b.unmatched);
  console.log(
    `[peeps] planned ${runs.length} run(s) in ${response.batches.length} batch(es); ${unmatched.length} test(s) unknown to Peeps`,
  );
  for (const u of unmatched.slice(0, 10)) console.log(`[peeps]   unknown: ${u.path} › ${u.titlePath}`);

  const batches = response.batches.map((b) => ({ batchId: b.batchId, batchNumber: b.batchNumber }));
  let footprints: { origins: string[]; hiddenRequests: string[]; record: boolean } | undefined;
  // Only a server that negotiated the protocol is trusted to ask: an older one's request isn't recorded.
  if (negotiated.protocol && response.batches.some((b) => b.collectFootprints === true)) {
    const globalSetups = [list.config.globalSetup ?? []].flat().map((file) => path.relative(env.workspace, path.resolve(rootDirAbs, file)).split(path.sep).join("/"));
    const sources = await workspaceTestSources(env.workspace, specFiles, globalSetups);
    for (const { file, why } of sources.reasons.slice(0, 5)) console.log(`[peeps] not recording footprints: ${file}: ${why}`);
    if (sources.reasons.length > 0) console.log("[peeps] so every test here reads unknown, and always runs");
    footprints = { origins: response.batches.flatMap((b) => b.footprintOrigins ?? []), hiddenRequests: sources.hiddenRequests, record: sources.reasons.length === 0 };
  }
  if (!answeredNarrowed(response)) {
    await executeAndReport(env, peeps, { ...recording, rootDir, runs, batches, footprints, executed: reach && { mode: "full", tests: tests.length } });
    return;
  }
  const listed = listedTestsOf(list, rootDir);
  const reporterRuns = withReporterTitles(runs, listed);
  if (!isNarrowed(response)) {
    console.log("[peeps] not narrowing, running the full suite: Peeps did not narrow every project's batch");
    await executeAndReport(env, peeps, { ...recording, rootDir, runs: reporterRuns, batches, ranFullSuite: true, executed: reach && { mode: "full", tests: tests.length } });
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
    await executeAndReport(env, peeps, { ...recording, rootDir, runs: reporterRuns, batches, ranFullSuite: true, executed: reach && { mode: "full", tests: tests.length } });
    return;
  }
  console.log(`[peeps] narrowed to ${selected.length} test(s) for this pull request`);
  await executeAndReport(env, peeps, { ...recording, rootDir, runs: reporterRuns, batches, selection: { files: [], grep }, narrowed: true, executed: reach && { mode: "targeted", tests: selected.length } });
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
    /** Peeps took this job's fingerprint: record what its tests ran (`evidence/`), per project. */
    impact?: { fingerprint: PreparedImpact["fingerprint"]; projects: RecordedProject[]; coverage: boolean; server?: ServerPlan };
  },
): Promise<void> {
  const scratch = await mkdtemp(path.join(process.env.RUNNER_TEMP ?? tmpdir(), "peeps-"));
  const planFile = path.join(scratch, "plan.json");
  const reportDir = path.join(scratch, "report");
  const plan: PlanFile = { peepsUrl: env.peepsUrl, rootDir: input.rootDir, runs: input.runs };
  if (input.narrowed) plan.narrowed = true;
  if (input.footprints) plan.footprints = { origins: input.footprints.origins, hiddenRequests: input.footprints.hiddenRequests };
  const evidence = input.impact ? await openScratch(process.env.RUNNER_TEMP ?? tmpdir()).catch(() => null) : null;
  if (evidence) plan.evidence = { dir: evidence.dir };
  await writeFile(planFile, JSON.stringify(plan), { mode: 0o600 });

  let exitCode: number;
  try {
    const coverage = evidence && input.impact?.coverage && input.impact.projects.some((p) => p.collect.coverage) ? { worker: path.join(__dirname, "evidence-worker.js"), dir: evidence.dir } : undefined;
    const plan = input.impact?.server;
    let server: ServerEvidence | undefined;
    // Only beside browser coverage, which a suite running precise coverage itself refuses (`conflict.ts`).
    if (evidence && plan && !input.selection && coverage !== undefined) {
      // One invocation per spec file, each with the app to itself (PQA-3201 PR 3).
      const blobDir = path.join(scratch, "blobs");
      const recorded = await recordServer({
        app: { ...plan.app, cwd: env.workingDirectory, env: { ...process.env, ...input.extraEnv, CI: "1" } },
        specs: plan.specs,
        preload: path.join(__dirname, "evidence-preload.js"),
        coverageDir: path.join(scratch, "server-coverage"),
        scripts: input.impact!.fingerprint.scripts,
        nextDir: plan.nextDir,
        runTests: (spec, index) =>
          runPlaywright(env, planFile, reportDir, undefined, input.extraEnv, input.narrowed, input.footprints?.record === true, coverage, { spec, blobFile: spec === null ? null : path.join(blobDir, `report-${index}.zip`) }),
        attempts: () => (evidence.read("att-") as AttemptRecord[]).map((record) => ({ testId: record.testId, file: typeof record.file === "string" ? realOr(record.file) : null })),
      });
      exitCode = recorded.exitCode;
      server = recorded.server;
      await mergeReports(env, blobDir, reportDir);
    } else {
      exitCode = await runPlaywright(env, planFile, reportDir, input.selection, input.extraEnv, input.narrowed, input.footprints?.record === true, coverage);
    }
    if (evidence && input.impact) {
      // Evidence never fails a run: whatever goes wrong reading or sending it, Playwright's
      // own exit status stands, and the report and the batches still go up.
      await recordEvidence(env, peeps, input.impact, evidence, { coverage: coverage !== undefined, har: input.footprints?.record === true }, server).catch((error: unknown) => {
        console.log(`[peeps] not recording what this job's tests ran: ${String(error).slice(0, 300)}`);
      });
    }
  } finally {
    // Best effort: a scratch directory that can't be removed fails nothing.
    await evidence?.dispose().catch((error: unknown) => console.log(`[peeps] could not remove the evidence scratch directory: ${String(error).slice(0, 300)}`));
  }

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

/** A project Peeps took a fingerprint for, with the batch and runs the announce gave it. */
type RecordedProject = PreparedProject & { batchId: string; runIds: string[] };

/** One receipt per project, and at most this many per announce (contract §3). */
const MAX_RECEIPTS = 16;

/**
 * After the tests, before the batches complete: each project's footprints up under its
 * batch, its own runs only, keyed with its own key (contract §4). The upload publishes.
 * Any failure records nothing for that project; its staging snapshot is swept by age.
 */
async function recordEvidence(
  env: RunnerEnv,
  peeps: PeepsClient,
  impact: { fingerprint: PreparedImpact["fingerprint"]; projects: RecordedProject[] },
  scratch: { read(prefix: string): unknown[] },
  collected: { coverage: boolean; har: boolean },
  server?: ServerEvidence,
): Promise<void> {
  const records = scratch.read("att-") as AttemptRecord[];
  const coverage = scratch.read("cov-") as AttemptFile[];
  const contexts = scratch.read("ctx-") as ContextMarker[];
  const taints = scratch.read("taint-") as Array<{ testId: string; retry: number }>;
  const transport = peepsTransport(env.peepsUrl, () => peeps.token());
  for (const project of impact.projects) {
    const runs = new Set(project.runIds);
    const own = records.filter((record) => runs.has(record.runId));
    const tests = new Set(own.map((record) => record.testId));
    let job: ReturnType<typeof membersOf>;
    try {
      job = membersOf(
        own,
        coverage.filter((file) => tests.has(file.testId)),
        impact.fingerprint,
        { coverage: collected.coverage && project.collect.coverage, har: collected.har },
        contexts,
        taints,
        server,
      );
    } catch (error) {
      // Evidence never fails a job: this project records nothing, and its batch still completes.
      console.log(`[peeps] not recording what this job's tests ran: its evidence couldn't be read (${String(error).slice(0, 300)})`);
      continue;
    }
    if (job.measured.length === 0) continue;
    const ok = await uploadEvidence(transport, {
      batchId: project.batchId,
      key: project.collect.key,
      layers: job.layers,
      measured: job.measured,
      loadedFiles: job.loadedFiles,
      ambient: job.ambient,
      browser: job.browser,
      members: job.members,
    });
    if (ok) console.log(`[peeps] recorded what ${job.members.length} test(s) ran`);
  }
}

async function runPlaywright(
  env: RunnerEnv,
  planFile: string,
  reportDir: string,
  selection?: { files: string[]; grep: string },
  extraEnv: Record<string, string> = {},
  narrowed = false,
  collectFootprints = false,
  coverage?: { worker: string; dir: string },
  /** One invocation of a server recording: one spec file, or none for ambient; its report as a blob to merge. */
  invocation?: { spec: string | null; blobFile: string | null },
): Promise<number> {
  const reporterPath = path.join(__dirname, "reporter.js");
  const reporters = invocation ? `${reporterPath},list${invocation.blobFile ? ",blob" : ""}` : `${reporterPath},list,html`;
  const args = ["playwright", "test", `--reporter=${reporters}`];
  let capture: Awaited<ReturnType<typeof prepareCaptureConfig>> | undefined;
  try {
    capture = await prepareCaptureConfig(env, {
      ...(narrowed ? { defaultRetries: NARROWED_DEFAULT_RETRIES } : {}),
      ...(collectFootprints ? { collectFootprints } : {}),
      ...(coverage ? { coverage } : {}),
      ...(invocation ? { ownsApp: true } : {}),
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
  // Ambient runs no test, though its global setup and teardown run; a spec runs that one file.
  // No `--` before the filter: Playwright (1.63) ignores file filters after it. It starts with `^`, so it's never read as an option.
  if (invocation) args.push(...(invocation.spec === null ? ["--grep", "(?!)", "--pass-with-no-tests"] : [specFilter(invocation.spec)]));
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
            ...(invocation?.blobFile ? { PLAYWRIGHT_BLOB_OUTPUT_FILE: invocation.blobFile } : {}),
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

/** The file's real path, or the path itself when it can't be resolved. */
function realOr(file: string): string {
  try {
    return realpathSync(file);
  } catch {
    return file;
  }
}

/** A recording's server plan (PQA-3201 PR 3): the app the action owns, and the spec files it runs one at a time. */
export interface ServerPlan {
  app: AppInput;
  /** Absolute real paths, sorted, each once. */
  specs: string[];
  /** The job's `.next`, real path: coverage outside it is the runtime. */
  nextDir: string;
}

/**
 * Server evidence is recorded only when the workflow gave the app to the action
 * (`app-start` and `app-ready-url`), Peeps asked for coverage, and nothing else in the job
 * collects V8 coverage. Anything else: browser evidence only, as before, said once.
 */
export function serverPlanOf(env: RunnerEnv, recorded: Array<{ collect: { coverage: boolean } }>, rootDirAbs: string, specFiles: string[]): ServerPlan | null {
  if (!env.app || !recorded.some((project) => project.collect.coverage)) return null;
  if (process.env.NODE_V8_COVERAGE) {
    console.log("[peeps] not recording server evidence: NODE_V8_COVERAGE is already set in this job");
    return null;
  }
  let nextDir: string;
  try {
    nextDir = realpathSync(path.join(env.workingDirectory, ".next"));
  } catch {
    console.log("[peeps] not recording server evidence: no Next build in the working directory");
    return null;
  }
  const specs = [...new Set(specFiles.map((file) => realOr(path.resolve(rootDirAbs, file))))].sort();
  console.log(`[peeps] recording server evidence: ${specs.length} spec file(s), each with the app to itself, after one ambient run`);
  return { app: env.app, specs, nextDir };
}

/** The invocations' blob reports as the one HTML report the job uploads. */
async function mergeReports(env: RunnerEnv, blobDir: string, reportDir: string): Promise<void> {
  if (!existsSync(blobDir)) return;
  const code = await new Promise<number>((resolve) => {
    const child = spawn("npx", ["playwright", "merge-reports", "--reporter=html", blobDir], {
      cwd: env.workingDirectory,
      stdio: "inherit",
      env: { ...process.env, PLAYWRIGHT_HTML_OUTPUT_DIR: reportDir, PLAYWRIGHT_HTML_OPEN: "never" },
    });
    child.on("error", () => resolve(1));
    child.on("close", (c) => resolve(c ?? 1));
  });
  if (code !== 0) console.log(`[peeps] could not merge the invocations' reports (${code}): the HTML report may be missing`);
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
