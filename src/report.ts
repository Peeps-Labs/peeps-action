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
import { mkdtemp, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { RunnerEnv } from "./env";
import { listTests, specFilePayload, type PlaywrightList, type PlaywrightSuite } from "./inventory";
import type { PeepsClient } from "./peeps";
import type { PlanFile } from "./reporter";

export interface PlannedTest {
  path: string;
  titlePath: string;
  pwProject: string;
}

/** Files larger than this are skipped with a note; the report itself stays usable. */
const MAX_UPLOAD_BYTES = 128 * 1024 * 1024;

/** Flatten Playwright's list into the identities Peeps keys on. */
export function plannedTestsOf(list: PlaywrightList, rootDir: string): PlannedTest[] {
  const out: PlannedTest[] = [];
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
        out.push({ path: specPath, titlePath: [...next, spec.title].join(" › "), pwProject });
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
  }>;
}

export async function runReport(env: RunnerEnv, peeps: PeepsClient): Promise<void> {
  if (!env.sha) throw new Error("GITHUB_SHA is not set");
  const list = await listTests(env);
  const rootDirAbs = list.config.rootDir ?? env.workingDirectory;
  const rootDir = path.relative(env.workspace, rootDirAbs).split(path.sep).join("/") || ".";
  const tests = plannedTestsOf(list, rootDir);
  console.log(`[peeps] report: ${tests.length} tests at ${env.sha.slice(0, 7)} (${env.ref ?? "?"})`);

  const jobUrl =
    env.repository && env.runId
      ? `https://github.com/${env.repository}/actions/runs/${env.runId}`
      : null;
  // The spec sources travel with the plan request so a run on a branch pins
  // the blob that executes here, not the default branch's mirror.
  const files = await specFilePayload(env, list);
  const response = await peeps.post<BatchResponse>("/api/v1/ci/batches", {
    sha: env.sha,
    jobUrl,
    baseUrl: process.env.BASE_URL ?? null,
    tests,
    files,
  });
  const runs = response.batches.flatMap((b) => b.runs);
  const unmatched = response.batches.flatMap((b) => b.unmatched);
  console.log(
    `[peeps] planned ${runs.length} run(s) in ${response.batches.length} batch(es); ${unmatched.length} test(s) unknown to Peeps`,
  );
  for (const u of unmatched.slice(0, 10)) console.log(`[peeps]   unknown: ${u.path} › ${u.titlePath}`);

  await executeAndReport(env, peeps, {
    rootDir,
    runs,
    batches: response.batches.map((b) => ({ batchId: b.batchId, batchNumber: b.batchNumber })),
  });
}

/**
 * Shared tail of `report` and `run`: write the plan, run Playwright with the
 * Peeps reporter and an HTML report, upload the report, close the batches.
 * `selection` narrows Playwright to the planned tests (`run` mode).
 */
export async function executeAndReport(
  env: RunnerEnv,
  peeps: PeepsClient,
  input: {
    rootDir: string;
    runs: PlanFile["runs"];
    batches: Array<{ batchId: string; batchNumber: number }>;
    selection?: { files: string[]; grep: string };
  },
): Promise<void> {
  const scratch = await mkdtemp(path.join(process.env.RUNNER_TEMP ?? tmpdir(), "peeps-"));
  const planFile = path.join(scratch, "plan.json");
  const reportDir = path.join(scratch, "report");
  const plan: PlanFile = { peepsUrl: env.peepsUrl, rootDir: input.rootDir, runs: input.runs };
  await writeFile(planFile, JSON.stringify(plan), { mode: 0o600 });

  const exitCode = await runPlaywright(env, planFile, reportDir, input.selection);

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
      await peeps.post(`/api/v1/ci/batches/${b.batchId}/complete`, { reportUploaded });
    } catch (error) {
      console.log(`[peeps] could not complete batch ${b.batchId}: ${String(error)}`);
    }
  }
  console.log(`[peeps] playwright exited with ${exitCode}`);
  if (exitCode !== 0) process.exitCode = exitCode;
}

function runPlaywright(
  env: RunnerEnv,
  planFile: string,
  reportDir: string,
  selection?: { files: string[]; grep: string },
): Promise<number> {
  const reporterPath = path.join(__dirname, "reporter.js");
  const args = ["playwright", "test", `--reporter=${reporterPath},list,html`];
  if (env.configPath) args.push("--config", env.configPath);
  if (selection) {
    // `--grep` before `--`, then the file list. The paths come from Peeps'
    // plan, so without the separator an entry like `--config=whatever.ts`
    // survives the path math unchanged and reaches Playwright as an OPTION
    // rather than a file. Everything after `--` is a positional argument.
    args.push("--grep", selection.grep, "--", ...selection.files);
  }
  return new Promise((resolve) => {
    const child = spawn("npx", args, {
      cwd: env.workingDirectory,
      stdio: "inherit",
      env: {
        ...process.env,
        CI: "1",
        PEEPS_PLAN_FILE: planFile,
        PLAYWRIGHT_HTML_OUTPUT_DIR: reportDir,
        PLAYWRIGHT_HTML_OPEN: "never",
      },
    });
    child.on("close", (code) => resolve(code ?? 1));
  });
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
async function uploadReport(peeps: PeepsClient, batchId: string, reportDir: string): Promise<number> {
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
