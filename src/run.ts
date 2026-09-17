/**
 * `peeps run`: Peeps dispatched this workflow with `sessionId = <batchId>`.
 * Ask Peeps what the batch holds (which also binds this job to it), run just
 * those tests, and report exactly as `report` does.
 */

import path from "node:path";
import type { RunnerEnv } from "./env";
import { listTests } from "./inventory";
import type { PeepsClient } from "./peeps";
import type { PlanFile } from "./reporter";
import { executeAndReport, plannedTestsOf } from "./report";

interface Plan {
  batchId: string;
  batchNumber: number;
  runs: PlanFile["runs"];
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Playwright's `--grep` matches a space-joined title path (project, file,
 * describes, title) with the tags declared through `{ tag: … }` appended.
 * Anchor each planned test at the end past any such tags, preceded by a space
 * or the start, so titles never match as substrings of longer ones.
 */
export function grepFor(titlePaths: string[]): string {
  const alternatives = [...new Set(titlePaths)].map(
    (t) => escapeRegex(t.split(" › ").join(" ")) + "(?: @[^ ]+)*$",
  );
  return `(?:^| )(?:${alternatives.join("|")})`;
}

export async function runDispatched(env: RunnerEnv, peeps: PeepsClient): Promise<void> {
  if (!env.sessionId) throw new Error("`session-id` is required in run mode (Peeps passes it)");

  // rootDir from Playwright's own list, so file arguments and the reporter's
  // identity math agree with the customer's config. The list also goes to
  // Peeps with the plan request: Peeps planned one run per test, but only
  // the runner knows which Playwright projects each test runs under, and
  // the plan comes back with one run per project.
  const list = await listTests(env);
  const rootDirAbs = list.config.rootDir ?? env.workingDirectory;
  const rootDir = path.relative(env.workspace, rootDirAbs).split(path.sep).join("/") || ".";
  // Peeps accepts at most 2000 entries in one plan request.
  const plan = await peeps.post<Plan>(`/api/v1/ci/batches/${env.sessionId}/plan`, {
    tests: plannedTestsOf(list, rootDir).slice(0, 2000),
  });
  console.log(`[peeps] run: batch ${plan.batchNumber} holds ${plan.runs.length} run(s)`);
  if (plan.runs.length === 0) {
    await peeps.post(`/api/v1/ci/batches/${plan.batchId}/complete`, { reportUploaded: false });
    return;
  }

  // Repo-relative spec paths → paths relative to the working directory.
  const files = [...new Set(plan.runs.map((r) => r.path))].map((p) =>
    path.relative(env.workingDirectory, path.join(env.workspace, p)).split(path.sep).join("/"),
  );
  await executeAndReport(env, peeps, {
    rootDir,
    runs: plan.runs,
    batches: [{ batchId: plan.batchId, batchNumber: plan.batchNumber }],
    selection: { files, grep: grepFor(plan.runs.map((r) => r.titlePath)) },
  });
}
