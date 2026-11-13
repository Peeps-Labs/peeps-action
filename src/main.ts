/**
 * The Peeps action — the runner side of Peeps.
 *
 * Modes:
 *   inventory   post `playwright test --list` (pytest: `pytest --collect-only`;
 *               Appium: a mocha load of the WebdriverIO specs) to Peeps (what
 *               the repo's tests are)
 *   run         run the tests Peeps asked for and report them
 *   report      run this workflow's own tests and report them
 *   agent       host tools for a Peeps agent session
 *   attach-start, attach-finish
 *               report the workflow's own Playwright run, its command and
 *               reporters unchanged (`attach.ts`); never fail the job
 *   ci          the default; means `report`. A workflow_dispatch from Peeps
 *               always names its mode explicitly, so there is nothing to
 *               decide from the event here.
 */

import { readRunnerEnv, type RunnerEnv } from "./env";
import { runInventory } from "./inventory";
import { PeepsClient } from "./peeps";
import { runReport } from "./report";
import { runDispatched } from "./run";
import { exportDispatchedVariables, exportWorkflowVariables } from "./shared-variables";
import { runAgent } from "./agent";
import { runAppiumDispatched, runAppiumInventory, runAppiumReport } from "./appium";
import {
  ATTACH_FINISH_DEADLINE_MS,
  ATTACH_START_DEADLINE_MS,
  runAttachFinish,
  runAttachStart,
  runAttachStep,
} from "./attach";
import { warnIfBrowsersMissing } from "./browser-check";
import { PREVIEW_URL_VAR, dispatchedPreviewUrl, headSha, previewBaseUrl, takeGithubToken } from "./preview";
import {
  resolveFramework,
  runPytestDispatched,
  runPytestInventory,
  runPytestReport,
} from "./pytest";

/**
 * Whether this ref is the repository's default branch. Falls back to the old
 * main/master guess only when the event payload did not say.
 */
function onDefaultBranch(env: RunnerEnv): boolean {
  if (env.defaultBranch) return env.ref === `refs/heads/${env.defaultBranch}`;
  return env.ref === "refs/heads/main" || env.ref === "refs/heads/master";
}

async function main(): Promise<void> {
  // First, before anything can spawn: no test process, inventory or agent
  // tool may inherit the repository token (preview.ts).
  const githubToken = takeGithubToken(process.env);
  // The attach steps sit in the customer's own workflow, around their own test step, so
  // nothing in them may fail the job: not even an environment Peeps cannot read.
  const requested = (process.env["INPUT_MODE"] ?? process.env.PEEPS_MODE ?? "").trim();
  if (requested === "attach-start" || requested === "attach-finish") {
    const deadline = Number(process.env.PEEPS_ATTACH_DEADLINE_MS) ||
      (requested === "attach-start" ? ATTACH_START_DEADLINE_MS : ATTACH_FINISH_DEADLINE_MS);
    await runAttachStep(async () => {
      const env = readRunnerEnv();
      if (requested === "attach-start") await runAttachStart(env);
      else await runAttachFinish(env, new PeepsClient(env));
    }, deadline);
    // A request Peeps never answered would otherwise hold the step open.
    process.exit(0);
  }

  const env = readRunnerEnv();
  const peeps = new PeepsClient(env);
  // `ci` means `report`: a push or pull request reports its own run, and on the
  // default branch that run also refreshes the inventory. Peeps names the mode
  // explicitly on every workflow_dispatch it makes.
  const mode = env.mode === "ci" ? "report" : env.mode;
  console.log(
    `[peeps] mode=${mode} repo=${env.repository ?? "?"} sha=${env.sha?.slice(0, 7) ?? "?"} ref=${env.ref ?? "?"} peeps=${env.peepsUrl}`,
  );

  // The environment's "Send to CI" variables, masked, before any test is
  // listed or collected: a run Peeps started names its batch, a run the
  // workflow started its `peeps-environment` input (shared-variables.ts).
  if (mode === "run") await exportDispatchedVariables(env, peeps);
  if (mode === "report") await exportWorkflowVariables(env, peeps);

  // `preview: vercel` on a pull request: test that pull request's own preview.
  const previewUrl = await previewBaseUrl(mode, process.env, githubToken);
  if (previewUrl) process.env.BASE_URL = previewUrl;
  // A job Peeps started (a heal, a run): the checked-out commit's preview, for
  // where Peeps sends no BASE_URL (environment.ts).
  const dispatched = await dispatchedPreviewUrl(mode, process.env, githubToken, () => headSha(env.workspace));
  if (dispatched) process.env[PREVIEW_URL_VAR] = dispatched;

  // A pytest or Appium suite takes its own path through every mode that runs
  // tests; a Playwright one falls through to the switch below, exactly as before.
  const framework = mode === "agent" ? "playwright" : resolveFramework(env);
  if (framework === "pytest" || framework === "appium") {
    console.log(`[peeps] framework=${framework}`);
    const path =
      framework === "pytest"
        ? { inventory: runPytestInventory, report: runPytestReport, run: runPytestDispatched }
        : { inventory: runAppiumInventory, report: runAppiumReport, run: runAppiumDispatched };
    switch (mode) {
      case "inventory":
        await path.inventory(env, peeps);
        return;
      case "report":
        if (onDefaultBranch(env)) {
          await path.inventory(env, peeps).catch((error: unknown) =>
            console.log(`[peeps] inventory skipped: ${String(error)}`),
          );
        }
        await path.report(env, peeps);
        return;
      case "run":
        await path.run(env, peeps);
        return;
      default:
        throw new Error(`unknown mode ${mode}`);
    }
  }

  // Every mode but inventory launches browsers (`--list` launches none).
  // A pytest or Appium agent session never starts Node Playwright, so its
  // browsers are not this check's business.
  const agentFramework = mode === "agent" ? resolveFramework(env) : null;
  if (mode !== "inventory" && agentFramework !== "pytest" && agentFramework !== "appium") {
    await warnIfBrowsersMissing(env.workingDirectory, env.platform);
  }

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
