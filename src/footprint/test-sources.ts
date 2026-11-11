/** Asks the scanner's process what specs may do (`test-trace.ts`). Past its budget, or failing, it can't tell. */
import path from "node:path";
import { runBundled } from "../reach/process";
import type { TestSources } from "./test-trace";

const BUDGET_MS = 20_000;

export async function workspaceTestSources(
  workspace: string,
  specs: string[],
  globalSetups: string[],
  options: { budgetMs?: number; scanner?: string } = {},
): Promise<TestSources> {
  const answer = await runBundled<TestSources>(
    options.scanner ?? path.join(__dirname, "reach.js"),
    { kind: "testSources", root: workspace, specs, globalSetups, deadlineMs: options.budgetMs ?? BUDGET_MS },
    options.budgetMs ?? BUDGET_MS,
  ).catch(() => null);
  if (answer && answer !== "timeout") return answer;
  return { reasons: [{ file: "the suite", why: answer === "timeout" ? "took too long to read" : "couldn't be read" }], hiddenRequests: specs };
}
