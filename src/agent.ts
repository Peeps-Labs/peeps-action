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
 * SIGTERM/SIGINT, or on an error.
 */

import { createDeviceTools, type DeviceToolHost, type DeviceToolsDeps } from "./device-tools";
import type { RunnerEnv } from "./env";
import type { PeepsClient } from "./peeps";
import { resolveFramework } from "./pytest";
import { createToolServer, makeRedactor, type ToolHandler } from "./tools";

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
  const attach = await peeps.post<{ sessionId: string; kind: string; expiresAt: string }>(
    `/api/v1/bridge/sessions/${env.sessionId}/attach`,
    {
      tools: specs,
      runnerInfo: {
        workingDirectory: env.workingDirectory,
        configPath: env.configPath,
        framework,
        node: process.version,
        sha: env.sha,
        ref: env.ref,
        ...(device ? { deviceTools: device.info() } : {}),
      },
    },
  );
  const expiresAt = new Date(attach.expiresAt).getTime();
  console.log(`[peeps] agent session ${attach.sessionId} (${attach.kind}) attached; ${specs.length} tools; cap ${attach.expiresAt}`);
  if (!device) return serve(env, peeps, handlers, expiresAt);

  // Stop Appium and the device session however the job ends.
  const host = device;
  const onSignal = (signal: NodeJS.Signals) => {
    console.log(`[peeps] ${signal}: closing the device session`);
    void host.close(signal).finally(() => process.exit(signal === "SIGINT" ? 130 : 143));
  };
  const handleSignals = options.handleSignals !== false;
  if (handleSignals) {
    process.once("SIGTERM", onSignal);
    process.once("SIGINT", onSignal);
  }
  host.start();
  try {
    await serve(env, peeps, handlers, expiresAt);
  } finally {
    if (handleSignals) {
      process.off("SIGTERM", onSignal);
      process.off("SIGINT", onSignal);
    }
    await host.close("agent session over");
  }
}

async function serve(
  env: RunnerEnv,
  peeps: PeepsClient,
  handlers: Record<string, ToolHandler>,
  expiresAt: number,
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
      `[peeps] #${call.seq} ${call.tool}(${summarizeArgs(call.args)}) → ${describeOutcome(outcome)} in ${Date.now() - started} ms`,
    );
    try {
      await peeps.post(`/api/v1/bridge/sessions/${env.sessionId}/calls/${call.id}/result`, outcome);
    } catch (error) {
      console.log(`[peeps] could not deliver result for #${call.seq}: ${String(error).slice(0, 200)}`);
    }
  }
}

/** "ok", or the error: a thrown one, or a tool result that says `isError` (device tools). */
function describeOutcome(outcome: { ok: true; result: unknown } | { ok: false; error: string }): string {
  if (!outcome.ok) return `error: ${outcome.error.slice(0, 120)}`;
  const result = outcome.result as { isError?: unknown; content?: Array<{ type?: unknown; text?: unknown }> } | null;
  if (result?.isError === true) {
    const first = result.content?.find((part) => part.type === "text")?.text;
    return `error: ${String(first ?? "").slice(0, 120)}`;
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
