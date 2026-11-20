/**
 * `dist/load.js`: the direct load entry the go-line workflow runs (e5 plan §4 and §7, v2 §4, v3
 * §4). `src/main.ts` never imports it, so the published action's `mode: load` keeps refusing
 * until A5 turns it on.
 *
 * Its inputs are explicit and come from the caller's workflow file, never from the checkout:
 *
 *   PEEPS_URL                       Peeps' origin, written in the workflow file
 *   PEEPS_LOAD_GRANT                the dispatch's grant reference (128 bits, base64url)
 *   PEEPS_LOAD_WORKSPACE            the checkout (GITHUB_WORKSPACE by default; GitHub reserves that name)
 *   PEEPS_LOAD_WORKLOAD             the workload file, relative to the checkout
 *   PEEPS_LOAD_NPM_CACHE            the recipe's npm cache, for the offline pre-claim install
 *   PEEPS_LOAD_SINK_HOSTS           the hosts a grant may name (E5: the harness sink only)
 *   PEEPS_LOAD_CHECK_RUN_ID         `job.check_run_id`
 *   PEEPS_LOAD_ACTION_VERSION       optional: the action's pinned commit, reported with the claim
 *   PEEPS_LOAD_NODE_DIR             optional: setup-node's folder (the running Node's by default)
 *   PEEPS_LOAD_RESULT_FILE          optional: where to write the run's result as JSON
 *   GITHUB_WORKSPACE, GITHUB_RUN_ID, GITHUB_RUN_ATTEMPT, GITHUB_STEP_SUMMARY
 *   ACTIONS_ID_TOKEN_REQUEST_URL and _TOKEN (the job's `id-token: write`)
 *
 * Nothing it writes carries a token: the stdout line, the step summary and the result file hold
 * the result's counts, states and latencies only, and no workflow command is ever printed (not
 * even `add-mask`: a token is never on stdout to need one). It refuses to run with `NODE_DEBUG`
 * set, which Node reads at startup and would print requests with.
 */
import { appendFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { HttpControlPort, type HttpControlPortOptions } from "./http-control-port";
import { loadSignals, type LoadSignals } from "./signals";
import { runLoad, type LoadResult, type LoadRunOptions } from "./supervisor";

export interface LoadInputs {
  peepsUrl: string;
  grantRef: string;
  workspace: string;
  workloadPath: string;
  npmCache: string;
  sinkHosts: string[];
  nodeDir: string;
  actionDir: string;
  actionVersion: string;
  runId: string;
  runAttempt: number;
  checkRunId: number;
  oidc: { requestUrl: string; requestToken: string };
  summaryFile?: string;
  resultFile?: string;
}

const GRANT_REF = /^[A-Za-z0-9_-]{22}$/;
const DIGITS = /^[1-9][0-9]{0,18}$/;
const HOST = /^(?=.{1,253}$)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*$/;
const VERSION = /^[A-Za-z0-9._-]{1,64}$/;

/** The entry's inputs, checked; a problem names the variable, never its value. */
export function readLoadInputs(env: NodeJS.ProcessEnv, actionDir: string, execPath = process.execPath): { ok: true; inputs: LoadInputs } | { ok: false; problem: string } {
  const bad = (problem: string) => ({ ok: false as const, problem });
  if (env.NODE_DEBUG) return bad("NODE_DEBUG");
  const need = (name: string) => {
    const v = env[name];
    return typeof v === "string" && v.length > 0 ? v : undefined;
  };
  const peepsUrl = need("PEEPS_URL");
  if (!peepsUrl) return bad("PEEPS_URL");
  const grantRef = need("PEEPS_LOAD_GRANT");
  if (!grantRef || !GRANT_REF.test(grantRef)) return bad("PEEPS_LOAD_GRANT");
  const requestUrl = need("ACTIONS_ID_TOKEN_REQUEST_URL");
  const requestToken = need("ACTIONS_ID_TOKEN_REQUEST_TOKEN");
  if (!requestUrl || !requestToken) return bad("ACTIONS_ID_TOKEN_REQUEST_URL");
  const workspace = need("PEEPS_LOAD_WORKSPACE") ?? need("GITHUB_WORKSPACE");
  if (!workspace || !path.isAbsolute(workspace)) return bad("PEEPS_LOAD_WORKSPACE");
  const workloadPath = need("PEEPS_LOAD_WORKLOAD");
  if (!workloadPath || path.isAbsolute(workloadPath) || workloadPath.split(/[\\/]/).some((p) => p === ".." || p === "") || workloadPath.length > 1024) return bad("PEEPS_LOAD_WORKLOAD");
  const npmCache = need("PEEPS_LOAD_NPM_CACHE");
  if (!npmCache || !path.isAbsolute(npmCache)) return bad("PEEPS_LOAD_NPM_CACHE");
  const sinkHosts = (env.PEEPS_LOAD_SINK_HOSTS ?? "").split(",").map((h) => h.trim().toLowerCase()).filter(Boolean);
  if (sinkHosts.length === 0 || sinkHosts.length > 20 || !sinkHosts.every((h) => HOST.test(h))) return bad("PEEPS_LOAD_SINK_HOSTS");
  const runId = need("GITHUB_RUN_ID");
  const attempt = need("GITHUB_RUN_ATTEMPT");
  if (!runId || !DIGITS.test(runId) || !attempt || !DIGITS.test(attempt)) return bad("GITHUB_RUN_ID");
  const checkRunId = need("PEEPS_LOAD_CHECK_RUN_ID");
  if (!checkRunId || !DIGITS.test(checkRunId) || !Number.isSafeInteger(Number(checkRunId))) return bad("PEEPS_LOAD_CHECK_RUN_ID");
  const actionVersion = env.PEEPS_LOAD_ACTION_VERSION || "dev";
  if (!VERSION.test(actionVersion)) return bad("PEEPS_LOAD_ACTION_VERSION");
  const nodeDir = env.PEEPS_LOAD_NODE_DIR || path.dirname(path.dirname(execPath));
  if (!path.isAbsolute(nodeDir)) return bad("PEEPS_LOAD_NODE_DIR");
  const resultFile = env.PEEPS_LOAD_RESULT_FILE || undefined;
  if (resultFile !== undefined && !path.isAbsolute(resultFile)) return bad("PEEPS_LOAD_RESULT_FILE");
  return {
    ok: true,
    inputs: {
      peepsUrl,
      grantRef,
      workspace,
      workloadPath,
      npmCache,
      sinkHosts,
      nodeDir,
      actionDir,
      actionVersion,
      runId: `gh-${runId}-${attempt}`.slice(0, 40),
      runAttempt: Number(attempt),
      checkRunId: Number(checkRunId),
      oidc: { requestUrl, requestToken },
      summaryFile: env.GITHUB_STEP_SUMMARY || undefined,
      resultFile,
    },
  };
}

/** What the stdout line and the step summary carry: counts, states and latencies, nothing else. */
export function reportOf(res: LoadResult) {
  const { records: _records, ...latency } = res.latency;
  return {
    status: res.status,
    reason: res.reason,
    claimId: res.claimId,
    gateClosed: res.gateClosed,
    final: res.final,
    closed: res.closed,
    evidence: res.evidence,
    cleanup: res.cleanup,
    renewals: { sent: res.renewals.sent, afterTerminate: res.renewals.afterTerminate },
    latency,
    eventLoop: res.eventLoop,
    checking: { turns: res.checking.turns, success: res.checking.success },
    measurement: res.measurement,
  };
}

const ms = (v: number | null) => (v === null ? "unanswered" : `${v} ms`);

export function stepSummary(res: LoadResult): string {
  const l = res.latency;
  return [
    "## Peeps load run",
    "",
    `Status: **${res.status}** (${res.reason})`,
    "",
    "| Renewals | p50 | p99 | p99.9 | max | unanswered |",
    "| --- | --- | --- | --- | --- | --- |",
    `| ${l.count} | ${ms(l.p50Ms)} | ${ms(l.p99Ms)} | ${ms(l.p999Ms)} | ${ms(l.maxMs)} | ${l.unanswered} |`,
    "",
    `Closed: ${res.closed.state}${res.closed.reason ? ` (${res.closed.reason})` : ""}. Evidence: ${res.evidence.state}. Cleanup: ${res.cleanup}. Event loop p99 ${res.eventLoop.p99Ms} ms, max ${res.eventLoop.maxMs} ms.`,
    "",
  ].join("\n").replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, "");
}

export interface LoadEntryDeps {
  run?: (o: LoadRunOptions) => Promise<LoadResult>;
  makePort?: (o: HttpControlPortOptions) => HttpControlPort;
  signals?: () => LoadSignals;
  write?: (line: string) => void;
}

/** Runs one load run from the environment. Resolves to the exit code: 0 when it completed. */
export async function mainLoad(env: NodeJS.ProcessEnv = process.env, deps: LoadEntryDeps = {}, actionDir = __dirname): Promise<number> {
  const write = deps.write ?? ((line: string) => void process.stdout.write(`${line}\n`));
  const read = readLoadInputs(env, actionDir);
  if (!read.ok) {
    write(JSON.stringify({ refused: "input", input: read.problem }));
    return 2;
  }
  const i = read.inputs;
  let port: HttpControlPort;
  try {
    port = (deps.makePort ?? ((o) => new HttpControlPort(o)))({ peepsUrl: i.peepsUrl, oidc: i.oidc, userAgent: `peeps-action-load/${i.actionVersion}` });
  } catch (error) {
    const code = typeof (error as { code?: unknown }).code === "string" ? (error as { code: string }).code : "config";
    write(JSON.stringify({ refused: "port", code }));
    return 2;
  }
  const signals = (deps.signals ?? loadSignals)();
  try {
    const res = await (deps.run ?? runLoad)({
      runId: i.runId,
      workspace: i.workspace,
      workloadPath: i.workloadPath,
      nodeDir: i.nodeDir,
      actionDir: i.actionDir,
      port,
      grantRef: i.grantRef,
      npmCache: i.npmCache,
      harnessHosts: i.sinkHosts,
      actionVersion: i.actionVersion,
      runAttempt: i.runAttempt,
      checkRunId: i.checkRunId,
      signal: signals.signal,
      hardSignal: signals.hard,
    });
    write(JSON.stringify(reportOf(res)));
    if (i.summaryFile) appendFileSync(i.summaryFile, stepSummary(res));
    if (i.resultFile) writeFileSync(i.resultFile, `${JSON.stringify(res)}\n`, { mode: 0o644 });
    return res.status === "completed" ? 0 : 1;
  } finally {
    signals.dispose();
    port.close();
  }
}

if (require.main === module) {
  void mainLoad().then((code) => {
    process.exitCode = code;
  });
}
