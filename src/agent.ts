/**
 * `peeps agent`: host tools for a Peeps agent session.
 *
 * Attach to the session Peeps named in `session-id`, declare the tools this
 * runner offers, then loop: long-poll for a call, execute it locally, post the
 * result. Every call is echoed to the job log so the repository's owners can
 * read exactly what Peeps did. The loop ends when Peeps ends the session
 * (410), when the session's hard cap passes, or on repeated transport errors.
 */

import { execFile } from "node:child_process";
import { realpath } from "node:fs/promises";
import { promisify } from "node:util";
import type { RunnerEnv } from "./env";
import type { PeepsClient } from "./peeps";
import { createToolServer } from "./tools";
import { ACTION_VERSION } from "./version";

const execFileAsync = promisify(execFile);

interface Call {
  id: string;
  seq: number;
  tool: string;
  args: Record<string, unknown>;
}

export async function runAgent(env: RunnerEnv, peeps: PeepsClient): Promise<void> {
  if (!env.sessionId) throw new Error("`session-id` is required in agent mode (Peeps passes it)");
  const server = createToolServer(env);
  const attach = await peeps.post<{ sessionId: string; kind: string; expiresAt: string }>(
    `/api/v1/bridge/sessions/${env.sessionId}/attach`,
    {
      tools: server.specs,
      runnerInfo: await runnerInfoFor(env),
    },
  );
  const expiresAt = new Date(attach.expiresAt).getTime();
  console.log(`[peeps] agent session ${attach.sessionId} (${attach.kind}) attached; ${server.specs.length} tools; cap ${attach.expiresAt}`);

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
    const handler = server.handlers[call.tool];
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
      `[peeps] #${call.seq} ${call.tool}(${summarizeArgs(call.args)}) → ${outcome.ok ? "ok" : `error: ${outcome.error.slice(0, 120)}`} in ${Date.now() - started} ms`,
    );
    try {
      await peeps.post(`/api/v1/bridge/sessions/${env.sessionId}/calls/${call.id}/result`, outcome);
    } catch (error) {
      console.log(`[peeps] could not deliver result for #${call.seq}: ${String(error).slice(0, 200)}`);
    }
  }
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
 * tool behaviours, this runner has. A server that predates either field
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

function summarizeArgs(args: Record<string, unknown>): string {
  return Object.entries(args)
    .filter(([k]) => k !== "token" && k !== "content" && k !== "patch")
    .map(([k, v]) => `${k}=${JSON.stringify(v).slice(0, 60)}`)
    .join(", ");
}
