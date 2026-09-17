/**
 * The Peeps action — the runner side of Peeps.
 *
 * Modes:
 *   inventory   post `playwright test --list` to Peeps (what the repo's tests are)
 *   run         run the tests Peeps asked for and report them
 *   report      run this workflow's own tests and report them
 *   agent       host tools for a Peeps agent session
 *   ci          the default; means `report`. A workflow_dispatch from Peeps
 *               always names its mode explicitly, so there is nothing to
 *               decide from the event here.
 */

import { readRunnerEnv, type RunnerEnv } from "./env";
import { runInventory } from "./inventory";
import { PeepsClient } from "./peeps";
import { runReport } from "./report";
import { runDispatched } from "./run";
import { runAgent } from "./agent";

/**
 * Whether this ref is the repository's default branch. Falls back to the old
 * main/master guess only when the event payload did not say.
 */
function onDefaultBranch(env: RunnerEnv): boolean {
  if (env.defaultBranch) return env.ref === `refs/heads/${env.defaultBranch}`;
  return env.ref === "refs/heads/main" || env.ref === "refs/heads/master";
}

async function main(): Promise<void> {
  const env = readRunnerEnv();
  const peeps = new PeepsClient(env);
  // `ci` means `report`: a push or pull request reports its own run, and on the
  // default branch that run also refreshes the inventory. Peeps names the mode
  // explicitly on every workflow_dispatch it makes.
  const mode = env.mode === "ci" ? "report" : env.mode;
  console.log(
    `[peeps] mode=${mode} repo=${env.repository ?? "?"} sha=${env.sha?.slice(0, 7) ?? "?"} ref=${env.ref ?? "?"} peeps=${env.peepsUrl}`,
  );

  switch (mode) {
    case "inventory":
      await runInventory(env, peeps);
      return;
    case "report":
      // A run on the default branch is also the freshest inventory there is.
      // The branch comes from the event payload rather than being guessed:
      // hardcoding main/master silently skipped this for every repository that
      // uses anything else, and Peeps mirrors only the default branch, so those
      // customers never got a runner-side inventory at all.
      if (onDefaultBranch(env)) {
        await runInventory(env, peeps).catch((error: unknown) =>
          console.log(`[peeps] inventory skipped: ${String(error)}`),
        );
      }
      await runReport(env, peeps);
      return;
    case "run":
      await runDispatched(env, peeps);
      return;
    case "agent":
      await runAgent(env, peeps);
      return;
    default:
      throw new Error(`unknown mode ${mode}`);
  }
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`::error::${message}`);
  process.exit(1);
});
