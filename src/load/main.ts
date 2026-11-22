/**
 * `dist/load.js`: the two load entries.
 *
 * `mainCustomerLoad` is the published action's `mode: load` (CW plan §2, §4.3–§4.5):
 * `dist/index.js` hands off to it, never to `mainLoad`. It reads only the job's own GitHub
 * variables, the two inputs and `PEEPS_API_URL`; never a `PEEPS_LOAD_*` variable. Its refusals
 * run before any network, then the job's identity comes from its own OIDC token, then the run
 * installs with the verified download phase and no harness hosts.
 *
 * `mainLoad` is the direct entry the go-line workflow runs (`node dist/load.js`, e5 plan §4 and
 * §7, v2 §4, v3 §4). Its inputs are explicit and come from the caller's workflow file, never from
 * the checkout:
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
 * Nothing either writes carries a token: the stdout line, the step summary and the result file
 * hold the result's counts, states and latencies only. The harness entry prints no workflow
 * command; the customer entry prints one `::error` line for a refusal, with fixed copy and
 * bounded slots only. The harness entry refuses to run with `NODE_DEBUG` set, which Node reads at
 * startup and would print requests with; the customer entry refuses it as `node_options`.
 */
import { appendFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { customerRefusal, IDENTITY_FAILED_COPY, loadNodeDir, NOT_PINNED_LINE, refusal, RUN_REFUSAL_COPY, type CustomerRefusal } from "./customer";
import { loadControlOrigin } from "./control-origin";
import { HttpControlPort, type HttpControlPortOptions } from "./http-control-port";
import { readJobFacts, type JobFactsDeps } from "./job-facts";
import { readJobIdentity, type IdentityRead } from "./oidc";
import { loadSignals, type LoadSignals } from "./signals";
import { runLoad, sanitize, type LoadInstall, type LoadResult, type LoadRunOptions } from "./supervisor";

export interface LoadInputs {
  peepsUrl: string;
  grantRef: string;
  workspace: string;
  workloadPath: string;
  /** Harness: the recipe's npm cache. Customer: the verified download, then offline. */
  install: LoadInstall;
  /** Harness: a grant may name only the sink hosts. Customer: Peeps' own grant check. */
  scope: { kind: "harness"; sinkHosts: string[] } | { kind: "customer" };
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
      install: { mode: "offline", cache: npmCache },
      scope: { kind: "harness", sinkHosts },
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

export interface CustomerEntryDeps extends LoadEntryDeps {
  /** Where the `::error` line goes (stderr by default, as today's refusal). */
  error?: (line: string) => void;
  /** The job's identity (tests: without a token endpoint). */
  identity?: (oidc: LoadInputs["oidc"], env: NodeJS.ProcessEnv) => Promise<IdentityRead>;
  /** `readJobFacts`' seams (tests: no `/.dockerenv` lookup on the test host, a fake toolcache arch). */
  facts?: JobFactsDeps;
}

/** Runs one load run from the environment. Resolves to the exit code: 0 when it completed. */
export async function mainLoad(env: NodeJS.ProcessEnv = process.env, deps: LoadEntryDeps = {}, actionDir = __dirname): Promise<number> {
  const write = deps.write ?? ((line: string) => void process.stdout.write(`${line}\n`));
  const read = readLoadInputs(env, actionDir);
  if (!read.ok) {
    write(JSON.stringify({ refused: "input", input: read.problem }));
    return 2;
  }
  return runFromInputs(read.inputs, deps, write);
}

/**
 * The customer job's inputs (CW plan §4.5): the refusals of `customerRefusal`, then the values
 * they checked. The check-run id and the attempt come later, from the job's token.
 */
export function readCustomerInputs(env: NodeJS.ProcessEnv, actionDir: string, facts: JobFactsDeps = {}): { ok: true; inputs: Omit<LoadInputs, "checkRunId" | "runAttempt"> } | { ok: false; refusal: CustomerRefusal } {
  const f = readJobFacts(env, facts);
  const refused = customerRefusal(f);
  if (refused) return { ok: false, refusal: refused };
  const origin = loadControlOrigin(f.apiUrl ?? undefined);
  if (!origin.ok) return { ok: false, refusal: refusal("control_origin") };
  return {
    ok: true,
    inputs: {
      peepsUrl: origin.origin,
      grantRef: f.grant!,
      workspace: f.workspace!,
      workloadPath: f.workload!,
      install: { mode: "fetch" },
      scope: { kind: "customer" },
      nodeDir: loadNodeDir(f.toolCache!, facts.arch ?? process.arch),
      actionDir,
      actionVersion: f.actionRef!,
      runId: `gh-${env.GITHUB_RUN_ID}-${f.runAttempt}`.slice(0, 40),
      oidc: { requestUrl: env.ACTIONS_ID_TOKEN_REQUEST_URL!, requestToken: env.ACTIONS_ID_TOKEN_REQUEST_TOKEN! },
      summaryFile: env.GITHUB_STEP_SUMMARY || undefined,
    },
  };
}

/**
 * The published action's `mode: load`. A ref that isn't a commit prints today's line alone, byte
 * for byte; any other refusal prints one titled `::error` line, the copy in the step summary and
 * `{"refused":"<code>"}`. A token that couldn't be minted is a failure, not a refusal.
 */
export async function mainCustomerLoad(env: NodeJS.ProcessEnv = process.env, deps: CustomerEntryDeps = {}, actionDir = __dirname): Promise<number> {
  const write = deps.write ?? ((line: string) => void process.stdout.write(`${line}\n`));
  const error = deps.error ?? ((line: string) => void process.stderr.write(`${line}\n`));
  const read = readCustomerInputs(env, actionDir, deps.facts);
  const titled = (copy: string, summaryText: string) => {
    error(`::error title=Peeps load run::${copy}`);
    const summary = env.GITHUB_STEP_SUMMARY;
    if (summary) {
      try {
        appendFileSync(summary, summaryText);
      } catch {
        // The refusal is already on the log; a summary that can't be written changes nothing.
      }
    }
  };
  const refuse = (r: CustomerRefusal) => {
    if (r.code === "action_not_pinned") {
      error(NOT_PINNED_LINE);
      return 1;
    }
    titled(r.message, `## Peeps load run\n\n${r.message}\n`);
    write(JSON.stringify({ refused: r.code }));
    return 1;
  };
  if (!read.ok) return refuse(read.refusal);
  const id = await (deps.identity ?? ((oidc, e) => readJobIdentity(oidc, e)))(read.inputs.oidc, env);
  if (!id.ok) {
    if ("failed" in id) {
      titled(IDENTITY_FAILED_COPY, `## Peeps load run\n\n${IDENTITY_FAILED_COPY}\n`);
      write(JSON.stringify({ failed: "oidc" }));
      return 1;
    }
    return refuse(refusal(id.refused));
  }
  // A run that didn't start: one titled line with fixed copy for the reasons that have it, then
  // the cause on plain lines (it may hold lockfile text, so never inside the `::error` line).
  const explain = (res: LoadResult) => {
    if (res.status !== "didnt_start") return;
    const copy = (RUN_REFUSAL_COPY as Record<string, string>)[res.reason];
    if (copy) titled(copy, `\n${copy}\n`);
    for (const line of failureLines(res.failures)) error(line);
  };
  return runFromInputs({ ...read.inputs, checkRunId: id.checkRunId, runAttempt: id.runAttempt }, deps, write, explain);
}

const FAILURE_LINES = 20;
const FAILURE_LINE_CHARS = 300;

/** A result's failures as log lines: `peeps load: ` first, no control character, `::` or `##[`, at most 20 of 300 characters. */
export function failureLines(failures: LoadResult["failures"]): string[] {
  const out: string[] = [];
  for (const f of failures) {
    for (const raw of f.message.split(/\r?\n|\r/)) {
      const line = (sanitize(raw, FAILURE_LINE_CHARS) ?? "").replaceAll("##[", "## [").trim();
      if (!line) continue;
      if (out.length === FAILURE_LINES) return out;
      out.push(`peeps load: ${line}`);
    }
  }
  return out;
}

/** Both entries from the port onwards: the run, the result file, the summary and the stdout line. */
async function runFromInputs(i: LoadInputs, deps: LoadEntryDeps, write: (line: string) => void, explain?: (res: LoadResult) => void): Promise<number> {
  let port: HttpControlPort;
  try {
    port = (deps.makePort ?? ((o) => new HttpControlPort(o)))({ peepsUrl: i.peepsUrl, oidc: i.oidc, userAgent: `peeps-action-load/${i.actionVersion}` });
  } catch (error) {
    const code = typeof (error as { code?: unknown }).code === "string" ? (error as { code: string }).code : "config";
    write(JSON.stringify({ refused: "port", code }));
    return 2;
  }
  let signals: LoadSignals | undefined;
  try {
    signals = (deps.signals ?? loadSignals)();
    const res = await (deps.run ?? runLoad)({
      runId: i.runId,
      workspace: i.workspace,
      workloadPath: i.workloadPath,
      nodeDir: i.nodeDir,
      actionDir: i.actionDir,
      port,
      grantRef: i.grantRef,
      install: i.install,
      ...(i.scope.kind === "harness" ? { harnessHosts: i.scope.sinkHosts } : {}),
      actionVersion: i.actionVersion,
      runAttempt: i.runAttempt,
      checkRunId: i.checkRunId,
      signal: signals.signal,
      hardSignal: signals.hard,
    });
    if (i.resultFile) writeFileSync(i.resultFile, `${JSON.stringify(res)}\n`, { mode: 0o600 });
    if (i.summaryFile) {
      try {
        appendFileSync(i.summaryFile, stepSummary(res));
      } catch {
        // Best effort: the log's titled line and cause, and the report, still follow.
      }
    }
    explain?.(res);
    write(JSON.stringify(reportOf(res)));
    return res.status === "completed" &&
      res.cleanup === "clean" &&
      res.closed.state === "acked" &&
      res.evidence.state === "complete" &&
      res.final !== "missing" &&
      res.final.watermark === res.closed.debited ? 0 : 1;
  } catch {
    write('{"failed":"run_or_report"}');
    return 1;
  } finally {
    signals?.dispose();
    port.close();
  }
}

if (require.main === module) {
  void mainLoad().then((code) => {
    process.exitCode = code;
  });
}
