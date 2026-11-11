/**
 * The reach a pull request job sends on its announce. Only on GitHub, only on a
 * `pull_request` event: anything else sends none, and Peeps reads that as everything.
 * Nothing here can fail the job, and no source or patch leaves it.
 */
import path from "node:path";
import type { RunnerEnv } from "../env";
import { readCheckout } from "./checkout";
import { localRepository } from "./git";
import { capReach } from "./limits";
import { runBundled } from "./process";
import type { Reach } from "./types";

export const REACH_BUDGET_MS = 90_000;

const widened = (why: string, base: string | null = null, changedFiles: string[] = []): Reach =>
  capReach({ global: true, why, surfaces: [], reasons: [], changedFiles, changedTestFiles: [], base });

export async function computeReach(
  env: RunnerEnv,
  input: { specFiles: string[] },
  options: { budgetMs?: number; scanner?: string } = {},
): Promise<Reach | undefined> {
  if (env.platform !== "github" || env.eventName !== "pull_request" || !env.sha) return undefined;
  const budgetMs = options.budgetMs ?? REACH_BUDGET_MS;
  const started = Date.now();
  try {
    const repository = await localRepository(env.workspace, started + budgetMs);
    const checkout = await readCheckout(repository, env.sha);
    if (!checkout.ok) return widened(checkout.why);
    const changedFiles = checkout.changes.map((change) => change.path);
    const files = (await repository.git("ls-files", "-z")).split("\0").filter(Boolean);
    const remaining = budgetMs - (Date.now() - started);
    if (remaining <= 0) return widened("timeout", checkout.base, changedFiles);
    const answer = await runBundled<Reach>(
      options.scanner ?? path.join(__dirname, "reach.js"),
      { root: checkout.root, files, changes: checkout.changes, specFiles: input.specFiles, base: checkout.base, deadlineMs: remaining },
      remaining,
    );
    if (answer === "timeout") return widened("timeout", checkout.base, changedFiles);
    if (answer === null) return widened("scan_failed", checkout.base, changedFiles);
    return capReach(answer);
  } catch (error) {
    console.log(`[peeps] could not read what this pull request reaches, so everything runs: ${String(error).slice(0, 300)}`);
    return widened("scan_failed");
  }
}
