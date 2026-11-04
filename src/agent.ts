/**
 * `peeps agent`: host tools for a Peeps agent session.
 *
 * Attach to the session Peeps named in `session-id`, declare the tools this
 * runner offers, then loop: long-poll for a call, execute it locally, post the
 * result. Every call is echoed to the job log so the repository's owners can
 * read exactly what Peeps did. The loop ends when Peeps ends the session
 * (410), when the session's hard cap passes, or on repeated transport errors.
 *
 * With `device-tools: true` on an Appium suite, the runner also offers the
 * `device_*` tools (`device-tools.ts`): Appium and a device session start in
 * the background right after attach, and are stopped when the loop ends, on
 * SIGTERM/SIGINT, or on an error. A signal also stops a `run_tests` still
 * running WebdriverIO and removes its temporary config.
 */

import { execFile } from "node:child_process";
import { realpath } from "node:fs/promises";
import { promisify } from "node:util";
import { stopAppiumRuns } from "./appium";
import { createDeviceTools, type DeviceToolHost, type DeviceToolsDeps } from "./device-tools";
import type { RunnerEnv } from "./env";
import { hideEnvironmentUrls, type PlanEnvironment, planEnvironmentVariables } from "./environment";
import type { PeepsClient } from "./peeps";
import { resolveFramework } from "./pytest";
import { createToolServer, makeRedactor, type ToolHandler } from "./tools";
import { ACTION_VERSION } from "./version";

const execFileAsync = promisify(execFile);

interface Call {
  id: string;
  seq: number;
  tool: string;
  args: Record<string, unknown>;
}

export interface AgentOptions {
  /** For tests: the device tool host's Appium and capabilities. */
  deviceDeps?: Partial<DeviceToolsDeps>;
  /** For tests: whether to install SIGTERM/SIGINT handlers (default true). */
  handleSignals?: boolean;
}

/** The framework, or why it could not be told (an unknown `framework` input). */
function frameworkOf(env: RunnerEnv): string {
  try {
    return resolveFramework(env);
  } catch (error) {
    return `unknown (${error instanceof Error ? error.message : String(error)})`;
  }
}

export async function runAgent(env: RunnerEnv, peeps: PeepsClient, options: AgentOptions = {}): Promise<void> {
  if (!env.sessionId) throw new Error("`session-id` is required in agent mode (Peeps passes it)");
  const server = createToolServer(env);
  const framework = frameworkOf(env);
  let device: DeviceToolHost | null = null;
  if (env.deviceTools) {
    if (framework === "appium") {
      device = createDeviceTools(env, { redact: makeRedactor(process.env), deps: options.deviceDeps });
    } else {
      console.log(`[peeps] device-tools is for Appium suites; this one is ${framework}, so no device tools are offered`);
    }
  }
  const specs = [...server.specs, ...(device?.specs ?? [])];
  const handlers: Record<string, ToolHandler> = { ...server.handlers, ...(device?.handlers ?? {}) };
  const attach = await peeps.post<{ sessionId: string; kind: string; expiresAt: string; environment?: unknown }>(
    `/api/v1/bridge/sessions/${env.sessionId}/attach`,
    {
      tools: specs,
      runnerInfo: {
        ...(await runnerInfoFor(env)),
        framework,
        ...(device ? { deviceTools: device.info() } : {}),
      },
    },
  );
  const expiresAt = new Date(attach.expiresAt).getTime();
  console.log(`[peeps] agent session ${attach.sessionId} (${attach.kind}) attached; ${specs.length} tools; cap ${attach.expiresAt}`);
  // Before anything starts: an environment this action cannot read stops the
  // job here, with no test run and no device session opened.
  const environment = planEnvironmentVariables(attachEnvironment(attach.environment), process.env);
  if (environment.log) console.log(environment.log);
  server.setTestEnv(environment.vars);
  // However the job ends: a run_tests still running WebdriverIO is stopped and
  // its temporary config removed; Appium and the device session are closed.
  const host = device;
  const onSignal = (signal: NodeJS.Signals) => {
    console.log(`[peeps] ${signal}: stopping what the session started`);
    void stopForSignal(host, signal).finally(() => process.exit(signal === "SIGINT" ? 130 : 143));
  };
  const handleSignals = options.handleSignals !== false;
  if (handleSignals) {
    process.once("SIGTERM", onSignal);
    process.once("SIGINT", onSignal);
  }
  host?.start(environment.vars);
  try {
    await serve(env, peeps, handlers, expiresAt, hideEnvironmentUrls(environment.vars));
  } finally {
    if (handleSignals) {
      process.off("SIGTERM", onSignal);
      process.off("SIGINT", onSignal);
    }
    await host?.close("agent session over");
  }
}

/** On SIGTERM/SIGINT: stop a running wdio (removing its wrapper) and close the device session, together. */
export async function stopForSignal(device: DeviceToolHost | null, signal: NodeJS.Signals): Promise<void> {
  await Promise.allSettled([stopAppiumRuns(), device?.close(signal)]);
}

async function serve(
  env: RunnerEnv,
  peeps: PeepsClient,
  handlers: Record<string, ToolHandler>,
  expiresAt: number,
  /** Hides the session environment's URLs with credentials from the log line (an error may quote one). */
  forLog: (text: string) => string,
): Promise<void> {
  let transportErrors = 0;
  let handled = 0;
  for (;;) {
    if (Date.now() > expiresAt) {
      console.log("[peeps] session cap reached; leaving");
      return;
    }
    let call: Call | null;
    try {
      call = await peeps.getOrNull<{ call: Call }>(`/api/v1/bridge/sessions/${env.sessionId}/calls?wait=25`).then((r) => r?.call ?? null);
      transportErrors = 0;
    } catch (error) {
      const message = String(error);
      if (message.includes("→ 410")) {
        console.log(`[peeps] session ended by Peeps after ${handled} call(s)`);
        return;
      }
      transportErrors += 1;
      console.log(`[peeps] poll failed (${transportErrors}): ${message.slice(0, 200)}`);
      if (transportErrors >= 8) throw new Error("lost contact with Peeps");
      await new Promise((r) => setTimeout(r, 2000 * transportErrors));
      continue;
    }
    if (!call) continue;

    const started = Date.now();
    const handler = handlers[call.tool];
    let outcome: { ok: true; result: unknown } | { ok: false; error: string };
    if (!handler) {
      outcome = { ok: false, error: `unknown tool ${call.tool}` };
    } else {
      try {
        outcome = { ok: true, result: await handler(call.args) };
      } catch (error) {
        outcome = { ok: false, error: error instanceof Error ? error.message : String(error) };
      }
    }
    handled += 1;
    console.log(
      `[peeps] #${call.seq} ${call.tool}(${summarizeArgs(call.args)}) → ${describeOutcome(outcome, forLog)} in ${Date.now() - started} ms`,
    );
    try {
      await peeps.post(`/api/v1/bridge/sessions/${env.sessionId}/calls/${call.id}/result`, outcome);
    } catch (error) {
      console.log(`[peeps] could not deliver result for #${call.seq}: ${String(error).slice(0, 200)}`);
    }
  }
}

/**
 * The Peeps environment the attach answer names, or null when it names none (a
 * run that named none, or a server older than the field: the workflow chooses).
 * Anything else fails the job before a test runs: read as "none", a heal would
 * verify against whatever the workflow points at and report that it passed.
 * The value stays out of the message: Peeps sent it, and this goes to the log.
 * A NUL counts as unreadable: `spawn` refuses one, and its error prints the value.
 */
function attachEnvironment(value: unknown): PlanEnvironment | null {
  if (value === undefined || value === null) return null;
  const { name, baseUrl } = value as Partial<PlanEnvironment>;
  if (
    typeof name === "string" &&
    name &&
    !name.includes("\0") &&
    (baseUrl === null || (typeof baseUrl === "string" && !baseUrl.includes("\0")))
  ) {
    return { name, baseUrl };
  }
  throw new Error("Peeps named an environment this action cannot read; stopping before any test runs");
}

/**
 * What the runner tells Peeps about itself when it attaches.
 *
 * `sha` is the sha the workflow ran from (GITHUB_SHA / CI_COMMIT_SHA). When
 * Peeps pins the checkout (`actions/checkout` with `ref: <sha>`), the tree the
 * tools read and test is a different commit, so `checkoutSha` reports it:
 * `git rev-parse HEAD` in the workspace, left out when that fails or when the
 * workspace is not itself the repository's top level. Peeps
 * states a result as "verified at <sha>" only when `checkoutSha` is the sha it
 * asked for. `actionVersion` tells Peeps which of these fields, and which
 * tool behaviours, this runner has; `capabilities` names the tool behaviours
 * outright. A server that predates either field
 * ignores it.
 */
export async function runnerInfoFor(env: RunnerEnv): Promise<Record<string, unknown>> {
  const info: Record<string, unknown> = {
    workingDirectory: env.workingDirectory,
    configPath: env.configPath,
    node: process.version,
    sha: env.sha,
    ref: env.ref,
    actionVersion: ACTION_VERSION,
    // What this runner's tools can do beyond the basics, so Peeps need not
    // infer it from the version. `commit_paths`: git_commit_push takes
    // `paths` and commits only those files (PQA-2695). On a Playwright job,
    // `result_files`: each run_tests result's `file` is the repo-relative spec
    // it came from (PQA-2733); `error_context`: a failed one carries
    // Playwright's error-context.md as `errorContext` (PQA-2737). `environment`:
    // run_tests applies the environment the attach answer names (PQA-3033),
    // as do Appium's run_tests and the device session's capabilities.
    capabilities: ["commit_paths", "environment", ...(playwrightJob(env) ? ["result_files", "error_context"] : [])],
  };
  try {
    // `-c safe.directory`: inside the Playwright container the checkout is
    // owned by another uid, and git refuses it without this (see tools.ts).
    const { stdout } = await execFileAsync(
      "git",
      ["-c", `safe.directory=${env.workspace}`, "rev-parse", "--show-toplevel", "HEAD"],
      { cwd: env.workspace },
    );
    const [toplevel = "", sha = ""] = stdout.trim().split("\n");
    // Only the workspace's own repository: a workspace that is merely a
    // folder inside another checkout (a self-hosted runner's `_work` inside a
    // repository) would otherwise report that repository's HEAD.
    const [realTop, realWorkspace] = await Promise.all([realpath(toplevel), realpath(env.workspace)]);
    if (realTop === realWorkspace && /^[0-9a-f]{40}([0-9a-f]{24})?$/.test(sha)) info.checkoutSha = sha;
  } catch {
    // Not a git checkout, or git is missing: Peeps reads "not reported".
  }
  return info;
}

/** "ok", or the error: a thrown one, or a tool result that says `isError` (device tools). */
function describeOutcome(
  outcome: { ok: true; result: unknown } | { ok: false; error: string },
  forLog: (text: string) => string = (text) => text,
): string {
  if (!outcome.ok) return `error: ${forLog(outcome.error).slice(0, 120)}`;
  const result = outcome.result as { isError?: unknown; content?: Array<{ type?: unknown; text?: unknown }> } | null;
  if (result?.isError === true) {
    const first = result.content?.find((part) => part.type === "text")?.text;
    return `error: ${forLog(String(first ?? "")).slice(0, 120)}`;
  }
  return "ok";
}

/** Arguments for the job log, without the ones that carry secrets or bulk: a token, file contents, a patch, typed text. */
export function summarizeArgs(args: Record<string, unknown>): string {
  return Object.entries(args)
    .filter(([k]) => k !== "token" && k !== "content" && k !== "patch" && k !== "text")
    .map(([k, v]) => `${k}=${JSON.stringify(v).slice(0, 60)}`)
    .join(", ");
}

function playwrightJob(env: RunnerEnv): boolean {
  try {
    return resolveFramework(env) === "playwright";
  } catch {
    // An unknown framework input fails the job elsewhere; claim nothing here.
    return false;
  }
}
