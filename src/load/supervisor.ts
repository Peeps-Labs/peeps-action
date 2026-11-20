/**
 * The supervisor (design v3 §3, §5; e4 plan v3 §2.3): one load run, end to end, against a
 * `ControlPort`. It never imports customer code and is trusted for every count and time.
 *
 *   probe → pre-claim install → claim (cancellation armed first; the lease starts on
 *   acceptance) → prepare (inputs and tree digest bound to the claim; gate, CA, journal and proxy
 *   built; `gate.applyLease` at construction; the jail started with no turn open) → start ticket
 *   (minted and sent in one synchronous step) → launch ticket → `init` → Checking (a barrier on
 *   per-turn gate evidence) → measurement → one terminal `terminate(reason)` → draining renewals
 *   until the gate has settled, then a local `gate_closed` → ordered evidence, with a finite
 *   deadline, beside the proof that the jail is empty → the release-bearing `closed` renewal →
 *   teardown.
 *
 * `closed` (e5 plan §2.4, v2 §4) is sent once, and only after settlement: the proxy has closed
 * every upstream, no renewal is outstanding, no request is in flight, and the jail ended with its
 * cgroup proven empty (or no launch was ever attempted). It carries the same final debit as the
 * evidence's final watermark, and is retried with identical bytes until a matching receipt or the
 * reporting deadline. Its answer reopens nothing. Without that proof no `closed` is sent, and
 * Peeps releases on the job's completion instead.
 *
 * The evidence also carries every renewal's latency (first send to the applied answer), the
 * event loop's delay, and each renewal reports the scheduler's p99 start lag (`lagP99Ms`) over
 * the last interval. The evidence stream drops a batch only on `{ok: true}`; a transport failure
 * is retried with the same bytes after a growing pause; any refusal, or a record that cannot fit
 * a batch, latches the evidence `incomplete`, and no final follows.
 */
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { monitorEventLoopDelay } from "node:perf_hooks";
import os from "node:os";
import path from "node:path";
import { CUT_REASONS, DENY_REASONS, Accounting, requestDelta, zeroCounts, type IntervalRecord, type CohortRecord } from "./accounting";
import { sharedClocks } from "./clocks";
import { decodeClaimReply, decodeClosedReceipt, decodeRenewReply, planHashOf, renewBody, type Binding, type ClaimRequest, type ControlPort, type Grant, type RenewFields, type RenewState } from "./control-port";
import { DIALS_PER_TURN, ENGINE_LIMITS, OUTSTANDING_PER_TURN, runLimits, type EngineConstants, type RunLimits } from "./engine-limits";
import { Gate, type Clocks } from "./gate/admission";
import { createRunCa } from "./gate/ca";
import { encodeHandoffs, Journal, type JournalSnapshot } from "./gate/journal";
import { GateProxy, makeDial, type Dial, type DialSeams } from "./gate/proxy";
import { batchHash } from "./gate/reconcile";
import { checkoutHead, InstallRefused, offlinePreinstall, treeDigest, trustedToolchain, type InstallDigests } from "./install";
import { NoTicket, probe as realProbe, startJail, TicketRefused, type JailHandle, type ProbeReport, type StartJailOptions } from "./jail";
import type { CtlFrame, Ticket } from "./jail/ctl";
import type { JailSpec } from "./jail/spec";
import { RunnerLease, type ClaimGrant } from "./lease";
import { validatePlanInput, type Plan } from "./plan-input";
import { Scheduler } from "./scheduler";

export interface SupervisorConstants {
  /** From `init` to `loaded`. */
  loadedMs: number;
  /** Settlement and the evidence flush, after terminate. */
  reportingMs: number;
  /** The same after a hard cancel: inside the runner's 2.5 s from SIGTERM to SIGKILL. */
  hardReportingMs: number;
  /** Interval length for accounting and evidence. */
  intervalMs: number;
  /** The measurement tick. */
  tickMs: number;
  /** One renew attempt, before it is sent again (identical bytes). */
  renewAttemptMs: number;
  /** After a turn's deadline, how long its outcome may take before the executor is unresponsive. */
  outcomeTimeoutMs: number;
  /** Largest evidence batch, in bytes (P1: 256 KiB of UTF-8). */
  maxBatchBytes: number;
  /** Largest encoded events body, in bytes (P1: 300 KiB). */
  maxEventsBodyBytes: number;
  /** The first pause before an evidence batch or the closed renewal is sent again; it doubles to the max. */
  retryMs: number;
  retryMaxMs: number;
}

export const SUPERVISOR_CONSTANTS: SupervisorConstants = {
  loadedMs: 60_000,
  reportingMs: 10_000,
  hardReportingMs: 2_000,
  intervalMs: 10_000,
  tickMs: 50,
  renewAttemptMs: 1_000,
  outcomeTimeoutMs: 5_000,
  maxBatchBytes: 256 * 1024,
  maxEventsBodyBytes: 300 * 1024,
  retryMs: 100,
  retryMaxMs: 2_000,
};

export interface LoadRunOptions {
  /** Names the jail's unit: lowercase letters, digits and dashes. */
  runId: string;
  /** The checkout. */
  workspace: string;
  /** The workload file, relative to the checkout. */
  workloadPath: string;
  /** setup-node's toolcache folder: the trusted Node and npm. */
  nodeDir: string;
  /** The action's dist folder. */
  actionDir: string;
  port: ControlPort;
  /** The dispatch's grant reference, sent with the claim. */
  grantRef?: string;
  /** The recipe's npm cache, for the offline pre-claim install. Without it the real install refuses. */
  npmCache?: string;
  /** When set, every origin the grant allows must be on one of these hosts (E5's harness: the sink only). */
  harnessHosts?: string[];
  actionVersion?: string;
  runAttempt?: number;
  checkRunId?: number;
  signal?: AbortSignal;
  /** A hard cancel (the runner's SIGTERM, 2.5 s before its SIGKILL): cancels, resets every upstream, skips the draining renewals and shortens the reporting. */
  hardSignal?: AbortSignal;
  observer?: (event: LoadEvent) => void;
}

/** Only this file and test/ name it. */
export interface LoadSeams {
  clocks?: () => Clocks;
  /** Starts the jail (the fake jail in tests). */
  launch?: (spec: JailSpec, options: StartJailOptions, signal?: AbortSignal) => Promise<JailHandle>;
  probe?: () => Promise<ProbeReport>;
  /** The pre-claim install (tests without the pinned toolchain): the digests it leaves. */
  preinstall?: (workspace: string) => Promise<InstallDigests>;
  dialSeams?: DialSeams;
  dial?: Dial;
  seqHeader?: string;
  constants?: Partial<SupervisorConstants> & Partial<EngineConstants>;
  /** The executor's command and install, as the jail sees them (tests: the fake jail's own). */
  command?: string[];
  /** Hands the run's journal to a test once it exists (load-freeze snapshots it at its boundary). */
  onJournal?: (journal: Journal) => void;
}

type LoadPhase = RenewFields["phase"];

export type LoadStatus = "completed" | "stopped" | "cancelled" | "lease_lost" | "didnt_start" | "failed";

export type LoadEvent =
  | { type: "claimed"; claimId: string }
  | { type: "renewal"; seq: number; state: RenewState; decision: string }
  | { type: "phase"; phase: "checking" | "measurement" }
  | { type: "turn"; turn: number; slot: number; phase: "checking" | "measurement" }
  | { type: "outcome"; turn: number; kind: string }
  | { type: "terminate"; reason: string; status: LoadStatus }
  | { type: "gate_closed"; debited: number }
  | { type: "closed"; seq: number; outcome: ClosedOutcome["state"] }
  | { type: "snapshot"; at: "terminate"; handoffs: { debited: number; unattempted: number[] }; journal: JournalSnapshot; monoMs: number; leaseMonoUntil: number };

/** What became of the release-bearing `closed` renewal. */
export interface ClosedOutcome {
  /** `acked`: a matching receipt came back; `withheld`: settlement was not proven, so none was sent. */
  state: "acked" | "refused" | "unanswered" | "withheld" | "none";
  /** Why it was withheld or refused. */
  reason?: string;
  seq?: number;
  /** The final debit it carried: the evidence's final watermark too. */
  debited?: number;
  attempts: number;
  /** First send to the receipt, on the monotonic clock. */
  latencyMs: number | null;
}

/**
 * Every renewal allocated, in seq order, as `[seq, attempts, ms, outcome, firstSendAtMs,
 * answerAppliedAtMs, phase]`: `ms` runs from its
 * first send to the answer applied (retries included, on the monotonic clock), null when no
 * answer was applied (a rejected reply is never applied). The two wall-clock stamps (UTC ms)
 * place each renewal against a deploy's timestamps and the result's `measurementWindow`.
 * Percentiles are nearest-rank over every renewal, an unanswered one counted
 * above any answered one (null when the rank lands on it).
 */
export interface RenewalLatency {
  records: [seq: number, attempts: number, ms: number | null, outcome: string,
    firstSendAtMs: number, answerAppliedAtMs: number | null, phase: LoadPhase][];
  count: number;
  unanswered: number;
  p50Ms: number | null;
  p99Ms: number | null;
  p999Ms: number | null;
  maxMs: number | null;
}

/** `complete`: the final was acknowledged with no hole before it. */
export interface EvidenceState {
  state: "complete" | "incomplete" | "missing";
  /** The first seq Peeps did not accept, when it refused one. */
  seq?: number;
  reason?: string;
  /** The record that could not fit a batch: its kind and index. */
  record?: { kind: string; index: number };
}

export interface LoadResult {
  status: LoadStatus;
  reason: string;
  claimId: string | null;
  playwright: string | null;
  checking: { turns: number; success: number; failure: number; timeout: number; cancelled: number; responded: number[] };
  measurement: { started: number; missed: number; success: number; failure: number; timeout: number; cancelled: number };
  /** UTC bounds of the measurement before drain. Null when measurement never started. */
  measurementWindow: { startedAtMs: number; endedAtMs: number } | null;
  journal: JournalSnapshot | null;
  handoffs: { debited: number; unattempted: number[] } | null;
  /** The gate settled and the local marker was written. */
  gateClosed: boolean;
  /** The evidence stream's final watermark, or missing when the deadline passed first. */
  final: { watermark: number } | "missing";
  renewals: { sent: number; states: RenewState[]; afterTerminate: number };
  latency: RenewalLatency;
  /** The event loop's delay over the run, from `monitorEventLoopDelay`. */
  eventLoop: { p99Ms: number; maxMs: number };
  closed: ClosedOutcome;
  evidence: EvidenceState;
  cleanup: "clean" | "dirty" | "not_started";
  duplicateOutcomes: number;
  failures: { message: string; location: string | null }[];
}

class Refused extends Error {
  constructor(readonly status: LoadStatus, readonly reason: string, detail?: string) {
    super(`${reason}${detail ? `: ${detail}` : ""}`);
  }
}

/** One run, end to end. Never throws: every way it ends is a `LoadResult`. */
export async function runLoad(o: LoadRunOptions, s: LoadSeams = {}): Promise<LoadResult> {
  return new LoadRun(o, s).run();
}

const sha256Of = (file: string) => createHash("sha256").update(readFileSync(file)).digest("hex");

/** The binding a claim is made for and prepare checks again: checkout, lock digests, tree, workload. */
export async function bindingOf(workspace: string, workloadPath: string, tree?: string, signal?: AbortSignal): Promise<Binding> {
  signal?.throwIfAborted();
  const lock = path.join(workspace, "package-lock.json");
  const hidden = path.join(workspace, "node_modules/.package-lock.json");
  return {
    checkoutSha: checkoutHead(workspace),
    lockDigests: { "package-lock.json": existsSync(lock) ? sha256Of(lock) : "", "node_modules/.package-lock.json": existsSync(hidden) ? sha256Of(hidden) : "" },
    treeDigest: tree ?? (await treeDigest(workspace, signal)),
    workload: { path: workloadPath, digest: sha256Of(path.resolve(workspace, workloadPath)) },
  };
}

const sameBinding = (a: Binding, b: Binding) => JSON.stringify(sortKeys(a)) === JSON.stringify(sortKeys(b));
function sortKeys(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(sortKeys);
  if (v && typeof v === "object") return Object.fromEntries(Object.keys(v).sort().map((k) => [k, sortKeys((v as Record<string, unknown>)[k])]));
  return v;
}

/** Executor text, for the log and the evidence: printable, bounded, never a workflow command. */
export function sanitize(text: string | undefined, max = 500): string | null {
  if (text === undefined) return null;
  return text.replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g, "").replace(/::/g, ": :").slice(0, max);
}

interface TurnState {
  turn: number;
  slot: number;
  phase: "checking" | "measurement";
  startMono: number;
  deadlineWall: number;
  deadlineReached: boolean;
  outcome?: string;
  timers: NodeJS.Timeout[];
  accountingId: string;
}

class LoadRun {
  private readonly clocks: () => Clocks;
  private readonly k: SupervisorConstants;
  private readonly engine: EngineConstants;
  private readonly internal = new AbortController();
  private readonly signal: AbortSignal;
  private readonly emit: (e: LoadEvent) => void;

  private claimId: string | null = null;
  private grant: Grant | undefined;
  private lease: RunnerLease | undefined;
  private gate: Gate | undefined;
  private journal: Journal | undefined;
  private proxy: GateProxy | undefined;
  private jail: JailHandle | undefined;
  private limits: RunLimits | undefined;
  private plan: Plan | undefined;
  private runEndMono = Number.POSITIVE_INFINITY;
  private runEndWall = Number.POSITIVE_INFINITY;
  private caDir: string | undefined;

  /** Latches. */
  private reason: string | undefined;
  private status: LoadStatus | undefined;
  private expiryObserved = false;
  private stopNowLive = false;
  private gracefulStop = false;
  private phase: LoadPhase = "starting";

  private renewController = new AbortController();
  private renewing = false;
  private renewInFlight: Promise<void> | undefined;
  private renewTimer: NodeJS.Timeout | undefined;
  private renewState: RenewState = "running";
  private readonly renewals = { sent: 0, states: [] as RenewState[], afterTerminate: 0 };
  private watchTimer: NodeJS.Timeout | undefined;
  private tickTimer: NodeJS.Timeout | undefined;
  private graceEnd: Clocks | undefined;
  /** The drain's own end, before `alignDrain` brings it forward to a lease Peeps capped. */
  private drainLimit: Clocks | undefined;
  /** The end of the last lease applied (`grantNow` reads -Infinity once the lease is lost). */
  private leaseUntil: Clocks | undefined;
  /** How long a drain may take: the grant's grace, never longer than a measured turn's deadline (also how long a cohort waits to be sealed). */
  private drainGraceMs = 0;
  /** Per allocated renewal: its attempts, the ms from first send to the applied answer, and the outcome. */
  private readonly latency = new Map<number, {
    attempts: number; ms: number | null; outcome: string;
    firstSendAtMs: number; answerAppliedAtMs: number | null; phase: LoadPhase;
  }>();
  /** Measured starts' lag behind their due tick, on the plan's clock, for `lagP99Ms`. */
  private readonly startLags: { atMs: number; lagMs: number }[] = [];
  private readonly loopDelay = monitorEventLoopDelay({ resolution: 10 });
  private closedOutcome: ClosedOutcome = { state: "none", attempts: 0, latencyMs: null };
  private readonly closedCancel = new AbortController();

  private readonly credentials = new Map<string, number>();
  private readonly turns = new Map<number, TurnState>();
  private readonly busySlots = new Map<number, TurnState>();
  private duplicateOutcomes = 0;
  private readonly failures: LoadResult["failures"] = [];
  private playwright: string | null = null;
  private readonly checking = { turns: 0, success: 0, failure: 0, timeout: 0, cancelled: 0, responded: [] as number[] };
  private readonly measurement = { started: 0, missed: 0, success: 0, failure: 0, timeout: 0, cancelled: 0 };
  private accounting: Accounting;
  private measureStartMono = 0;
  private measureStartWall: number | undefined;
  private measureEndWall: number | undefined;
  private scheduler: Scheduler | undefined;
  private lastSnapshot: JournalSnapshot | undefined;

  private terminated: Promise<void>;
  private resolveTerminated!: () => void;
  private proxyClosed: Promise<void> | undefined;
  private jailEnded: Promise<{ clean: boolean }> | undefined;
  private jailLaunchPending = false;
  /** The launch was attempted: from then on only an ended, clean jail proves nothing of this run is left. */
  private launchCalled = false;
  private gateClosed = false;
  private outcomeWaiters = new Set<() => void>();
  private hard = false;
  private hardTimer: NodeJS.Timeout | undefined;
  private resolveHardLimit!: () => void;
  private readonly hardLimit = new Promise<void>((resolve) => { this.resolveHardLimit = resolve; });

  // Evidence: one ordered stream, one batch in flight.
  private readonly streamId = randomUUID();
  private evidenceSeq = 0;
  private readonly evidenceQueue: { body: { streamId: string; seq: number; payloadHash: string; batch: string; final?: { watermark: number } } }[] = [];
  private evidenceRunning: Promise<void> | undefined;
  private evidenceStopped = false;
  private readonly evidenceCancel = new AbortController();
  private incomplete: Omit<EvidenceState, "state"> | undefined;
  private finalSent: { watermark: number } | undefined;

  constructor(private readonly o: LoadRunOptions, private readonly s: LoadSeams) {
    this.clocks = s.clocks ?? sharedClocks;
    this.k = { ...SUPERVISOR_CONSTANTS, ...pick(s.constants, Object.keys(SUPERVISOR_CONSTANTS)) } as SupervisorConstants;
    this.engine = { ...ENGINE_LIMITS, ...pick(s.constants, Object.keys(ENGINE_LIMITS)) } as EngineConstants;
    this.signal = o.signal ? AbortSignal.any([o.signal, this.internal.signal]) : this.internal.signal;
    this.emit = (e) => {
      try {
        o.observer?.(e);
      } catch {
        // An observer never changes the run.
      }
    };
    this.accounting = new Accounting(this.k.intervalMs);
    this.terminated = new Promise((resolve) => (this.resolveTerminated = resolve));
  }

  async run(): Promise<LoadResult> {
    const onAbort = () => this.terminate("cancelled");
    // An abort that came before the run never fires the listener.
    if (this.signal.aborted) onAbort();
    else this.signal.addEventListener("abort", onAbort, { once: true });
    const onHard = () => this.hardCancel();
    if (this.o.hardSignal?.aborted) onHard();
    else this.o.hardSignal?.addEventListener("abort", onHard, { once: true });
    this.loopDelay.enable();
    try {
      await Promise.race([this.execute(), this.hardLimit]);
      await this.terminated;
      return await this.finish();
    } finally {
      this.loopDelay.disable();
      clearTimeout(this.hardTimer);
      this.signal.removeEventListener("abort", onAbort);
      this.o.hardSignal?.removeEventListener("abort", onHard);
    }
  }

  private async execute(): Promise<void> {
    try {
      this.throwIfDone();
      const report = await (this.s.probe ? this.s.probe() : this.realProbe());
      this.throwIfDone();
      if (!report.passed) throw new Refused("didnt_start", "fence_unverified", report.failures.join("; "));
      const digests = await (this.s.preinstall ? this.s.preinstall(this.o.workspace) : this.realPreinstall());
      const binding = await bindingOf(this.o.workspace, this.o.workloadPath, digests.tree, this.signal);
      this.throwIfDone();
      await this.claim(binding, report);
      await this.prepare(binding);
      await this.startup();
      await this.runChecking();
      await this.runMeasurement();
    } catch (error) {
      if (error instanceof Refused) this.terminate(error.reason, error.status);
      else if (error instanceof NoTicket) this.terminate("didnt_start", "didnt_start");
      else if (error instanceof TicketRefused) this.terminate(error.reason === "stale_ticket" ? "didnt_start" : "executor_protocol", error.reason === "stale_ticket" ? "didnt_start" : "failed");
      else if (this.reason === undefined) this.terminate("startup_failed", "failed", (error as Error).message);
    }
  }

  private throwIfDone(): void {
    if (this.reason !== undefined) throw new Refused(this.status ?? "failed", this.reason);
  }

  private async realProbe(): Promise<ProbeReport> {
    const node = path.join(this.o.nodeDir, "bin", "node");
    return realProbe(
      { node, nodeDir: this.o.nodeDir, actionDir: this.o.actionDir, outer: path.join(this.o.actionDir, "load-outer.js"), init: path.join(this.o.actionDir, "load-init.js"), workspace: this.o.workspace, executorUid: process.getuid!(), executorGid: process.getgid!(), env: {}, limits: { maxRunMs: 60_000, memoryMax: "512M", tasksMax: 64, cpuQuotaPercent: 100 } },
      `${this.o.runId}-probe`.slice(0, 40),
      this.signal,
    );
  }

  /** Offline, from the recipe's npm cache, with no network interface (e5 plan v3 §2.10). */
  private async realPreinstall(): Promise<InstallDigests> {
    this.signal.throwIfAborted();
    if (!this.o.npmCache) throw new Refused("didnt_start", "install_unsupported", "no recipe npm cache");
    const scratch = mkdtempSync(path.join(os.tmpdir(), "peeps-load-install-"));
    try {
      return await offlinePreinstall(this.o.workspace, trustedToolchain(this.o.nodeDir, this.o.workspace), scratch, { cache: this.o.npmCache, uid: process.getuid!(), gid: process.getgid!() }, undefined, this.signal);
    } catch (error) {
      // A checkout or toolchain refused before npm ran is unsupported; npm or the cache failing is install_failed.
      throw new Refused("didnt_start", error instanceof InstallRefused ? "install_unsupported" : "install_failed", (error as Error).message);
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  }

  // ---------------------------------------------------------------- claim and the lease controller

  private async claim(binding: Binding, report: ProbeReport): Promise<void> {
    const body: ClaimRequest = {
      protocol: 1,
      ...(this.o.grantRef !== undefined ? { grantRef: this.o.grantRef } : {}),
      actionVersion: this.o.actionVersion ?? "0.0.0",
      idempotencyKey: randomUUID(),
      runAttempt: this.o.runAttempt ?? 1,
      checkRunId: this.o.checkRunId ?? 0,
      fence: { kind: "netns", probe: { passed: report.passed, failures: report.failures } },
      ...binding,
    };
    const sent = this.clocks();
    const raw = await this.o.port.claim(body, this.signal);
    const received = this.clocks();
    this.throwIfDone();
    const reply = decodeClaimReply(raw);
    if (!reply.ok) throw new Refused("didnt_start", `claim_${reply.refused}`);
    const g = reply.grant;
    this.grant = g;
    this.claimId = g.claimId;
    const claimGrant: ClaimGrant = { binding: { claimId: g.claimId, epoch: g.epoch, planHash: g.planHash }, nonce: g.lease.nonce, renewEveryMs: g.lease.renewEveryMs, ttlMs: g.lease.ttlMs, ceiling: g.lease.ceiling, leaseUntilServerMs: g.lease.leaseUntilServerMs, serverNowMs: g.lease.serverNowMs };
    this.lease = new RunnerLease(claimGrant, sent, received);
    // Anchor both local clocks conservatively to when the claim was sent.
    const hardRemainingMs = g.hardEndServerMs - g.lease.serverNowMs;
    this.runEndMono = sent.monoMs + hardRemainingMs;
    this.runEndWall = sent.wallMs + hardRemainingMs;
    this.emit({ type: "claimed", claimId: g.claimId });
    if (this.lease.lost) throw new Refused("lease_lost", "lease_lost");
    this.renewing = true;
    this.scheduleRenew(sent.monoMs, received.monoMs);
    this.armWatch();
  }

  private scheduleRenew(prevSendMono: number, prevAnswerMono: number): void {
    if (!this.renewing || !this.lease) return;
    const at = this.lease.nextSendAt(prevSendMono, prevAnswerMono);
    const delay = Math.max(0, at - this.clocks().monoMs);
    this.renewTimer = setTimeout(() => {
      this.renewTimer = undefined;
      this.renewInFlight = this.renewOnce().catch(() => undefined).finally(() => (this.renewInFlight = undefined));
    }, delay);
  }

  private renewFields(seq: number, nonce: string) {
    const gate = this.gate;
    return renewBody({
      epoch: this.grant!.epoch,
      seq,
      nonce,
      phase: this.phase,
      debited: gate?.admitted ?? 0,
      unresolved: gate?.unresolved ?? 0,
      inFlight: gate?.inFlight ?? 0,
      state: this.renewState,
      lagP99Ms: this.lagP99Ms(),
    });
  }

  /** The p99 (nearest rank) of measured starts' lag behind their due tick over the last interval, in whole ms. */
  private lagP99Ms(): number {
    if (this.phase !== "measurement" || this.startLags.length === 0) return 0;
    const since = this.clocks().monoMs - this.measureStartMono - this.k.intervalMs;
    while (this.startLags.length && this.startLags[0]!.atMs < since) this.startLags.shift();
    const lags = this.startLags.map((x) => x.lagMs).sort((a, b) => a - b);
    const p = nearestRank(lags, 0.99);
    return p === undefined ? 0 : Math.max(0, Math.ceil(p));
  }

  /** One renewal, retried with identical bytes to its answer while the lease it was sent under holds. */
  private async renewOnce(): Promise<void> {
    const lease = this.lease!;
    const g = this.grant!;
    const t0 = this.clocks();
    const tx = lease.begin(t0, randomBytes(16).toString("hex"), (seq, nonce) => this.renewFields(seq, nonce));
    if (!tx) {
      if (!lease.held(this.clocks())) this.onExpiry();
      return;
    }
    const state = this.renewState;
    this.renewals.sent += 1;
    this.renewals.states.push(state);
    if (this.reason !== undefined) this.renewals.afterTerminate += 1;
    const record = {
      attempts: 0, ms: null as number | null, outcome: "none",
      firstSendAtMs: tx.firstSendWall, answerAppliedAtMs: null as number | null, phase: this.phase,
    };
    this.latency.set(tx.seq, record);
    const signal = this.renewController.signal;
    // Before every retry: a pause, so a port that fails or answers at once never holds the event
    // loop (and the signal handlers, the watch and the proxy with it) for the rest of the lease;
    // then the lease again, so nothing is sent outside the deadline it was first sent under.
    const again = async (): Promise<boolean> => {
      if (lease.mayRetry(this.clocks())) await delay(Math.min(100, this.k.renewAttemptMs), signal).catch(() => undefined);
      if (signal.aborted) return false;
      if (lease.mayRetry(this.clocks())) return true;
      this.onExpiry();
      return false;
    };
    for (;;) {
      if (signal.aborted) return;
      const attempt = AbortSignal.any([signal, AbortSignal.timeout(this.k.renewAttemptMs)]);
      let raw: unknown;
      record.attempts += 1;
      try {
        raw = await this.o.port.renew(g.claimId, g.runToken, tx.body, attempt);
      } catch {
        if (signal.aborted || !(await again())) return;
        continue;
      }
      if (signal.aborted) return;
      const decoded = decodeRenewReply(raw);
      if (decoded.kind === "unaddressed") {
        if (!(await again())) return;
        continue;
      }
      const now = this.clocks();
      const d = lease.apply(decoded.reply, now);
      this.emit({ type: "renewal", seq: tx.seq, state, decision: d.kind });
      if (d.kind === "ignored") {
        if (!(await again())) return;
        continue;
      }
      if (d.kind !== "rejected") {
        record.ms = Math.max(0, now.monoMs - tx.firstSendMono);
        record.answerAppliedAtMs = now.wallMs;
      }
      record.outcome = d.kind === "lease" ? "held" : d.kind;
      if (d.kind === "lost") {
        if (d.stop?.mode === "now") {
          this.stopNowLive = true;
          this.gate?.revokeLease();
          this.terminate("stopped");
        } else {
          this.gate?.revokeLease();
          this.onExpiry();
        }
        return;
      }
      if (d.kind === "lease") {
        this.gate?.applyLease(d.grant);
        if (d.stop?.mode === "graceful") this.onGracefulStop();
        this.alignDrain(decoded.reply);
      }
      this.armWatch();
      this.scheduleRenew(tx.firstSendMono, now.monoMs);
      return;
    }
  }

  private onExpiry(): void {
    if (this.drainCutFirst(this.clocks())) return this.terminate(this.gracefulStop ? "stopped" : "completed");
    this.expiryObserved = true;
    this.gate?.revokeLease();
    this.terminate("lease_lost");
  }

  private onGracefulStop(): void {
    if (this.gracefulStop) return;
    this.gracefulStop = true;
    if (this.phase !== "measurement") return this.terminate(this.phase === "starting" ? "didnt_start" : "stopped", this.phase === "starting" ? "didnt_start" : "stopped");
    this.startDrain();
    this.maybeFinishMeasurement();
  }

  private startDrain(): void {
    this.renewState = "draining";
    if (this.graceEnd === undefined) {
      const t = this.clocks();
      this.markMeasurementEnd(t);
      this.graceEnd = { monoMs: t.monoMs + this.drainGraceMs, wallMs: t.wallMs + this.drainGraceMs };
      this.drainLimit = this.graceEnd;
      this.gate!.drain(this.graceEnd);
    }
    this.armWatch();
  }

  /**
   * While the runner drains, Peeps caps the lease at its own drain start plus the grace (rule 10).
   * The runner maps that cap from the renewal's first send, so a slow or retried renewal places it
   * before `graceEnd`. A capped lease (one that ends before its TTL) then ends the drain with it,
   * so the cap is the drain's cut, not a lost lease. An uncapped one restores the drain's own end.
   */
  private alignDrain(reply: { ttlMs: number; leaseUntilServerMs: number; serverNowMs: number }): void {
    if (!this.lease) return;
    const g = this.lease.grantNow;
    this.leaseUntil = { monoMs: g.monoUntil, wallMs: g.wallUntil };
    if (!this.drainLimit || this.reason !== undefined) return;
    const capped = reply.leaseUntilServerMs - reply.serverNowMs < reply.ttlMs;
    this.graceEnd = capped
      ? { monoMs: Math.min(this.drainLimit.monoMs, g.monoUntil), wallMs: Math.min(this.drainLimit.wallMs, g.wallUntil) }
      : this.drainLimit;
    this.gate!.drain(this.graceEnd);
  }

  /** The drain's end came at or before the lease's, and has passed: running out is the drain's cut. */
  private drainCutFirst(t: Clocks): boolean {
    const end = this.graceEnd;
    const lease = this.leaseUntil;
    if (!end || !lease) return false;
    return end.monoMs <= lease.monoMs && end.wallMs <= lease.wallMs && !(t.monoMs < end.monoMs && t.wallMs < end.wallMs);
  }

  /** One self-re-arming timer on the nearest deadline: the lease, the run's end, and the grace end. */
  private armWatch(): void {
    if (this.reason !== undefined || !this.lease) return;
    clearTimeout(this.watchTimer);
    const t = this.clocks();
    const grant = this.lease.grantNow;
    const monoLeft = Math.min(grant.monoUntil, this.runEndMono, this.graceEnd?.monoMs ?? Infinity) - t.monoMs;
    const wallLeft = Math.min(grant.wallUntil, this.runEndWall, this.graceEnd?.wallMs ?? Infinity) - t.wallMs;
    const wait = Math.min(100, Math.max(1, Math.min(monoLeft, wallLeft)));
    this.watchTimer = setTimeout(() => this.watch(), Number.isFinite(wait) ? wait : 100);
  }

  private watch(): void {
    if (this.reason !== undefined || !this.lease) return;
    const t = this.clocks();
    if (!this.lease.held(t)) return this.onExpiry();
    const cutoff = this.gate?.checkRunEnd(t);
    if (cutoff === "hard" || (!this.gate && !(t.monoMs < this.runEndMono && t.wallMs < this.runEndWall))) {
      return this.terminate("run_end", "failed");
    }
    if (cutoff === "drain") return this.terminate(this.gracefulStop ? "stopped" : "completed");
    for (const state of this.busySlots.values()) {
      if (!(t.wallMs < state.deadlineWall)) this.expireTurn(state);
    }
    this.armWatch();
  }

  // ---------------------------------------------------------------- prepare

  private async prepare(claimed: Binding): Promise<void> {
    const g = this.grant!;
    const projection = { allowedOrigins: g.limits.allowedOrigins, maxUsers: g.limits.maxUsers, requestBudget: g.limits.requestBudget, policyRevision: g.limits.policyRevision };
    const input = validatePlanInput({ plan: g.plan, limits: projection });
    if (!input.ok) throw new Refused("didnt_start", "plan_invalid", input.errors.slice(0, 5).join("; "));
    if (planHashOf(input.value.plan) !== g.planHash) throw new Refused("didnt_start", "plan_hash");
    const plan = input.value.plan;
    this.plan = plan;
    if (g.workload.module !== plan.journey.module || g.workload.export !== plan.journey.export || g.workload.path !== this.o.workloadPath) throw new Refused("didnt_start", "workload_mismatch");
    const now = await bindingOf(this.o.workspace, this.o.workloadPath, undefined, this.signal);
    if (!sameBinding(now, claimed) || !sameBinding(now, g.binding)) throw new Refused("didnt_start", "checkout_changed");
    const limits = runLimits(input.value, g.limits, { parallel: OUTSTANDING_PER_TURN, constants: this.engine });
    if (!limits.ok) throw new Refused("didnt_start", limits.reason, limits.detail);
    this.limits = limits.value;
    this.drainGraceMs = Math.min(g.graceMs, limits.value.budgets.measurement.turnDeadlineMs);
    if (this.o.harnessHosts) {
      const allowed = new Set(this.o.harnessHosts.map((h) => h.toLowerCase()));
      for (const a of limits.value.approved.values()) if (!allowed.has(a.host.toLowerCase())) throw new Refused("didnt_start", "outside_harness");
    }
    let base: URL;
    try {
      base = new URL(g.baseURL);
    } catch {
      throw new Refused("didnt_start", "base_url");
    }
    const baseOrigin = `${base.protocol}//${base.host}`;
    if (!limits.value.approved.has(baseOrigin.replace(/:443$/, ""))) throw new Refused("didnt_start", "base_url");
    this.throwIfDone();

    const hosts = [...limits.value.approved.values()].map((a) => a.host);
    const nowWall = Date.now();
    const ca = createRunCa({ hosts, nowMs: nowWall, validForMs: g.maxRunMs + g.graceMs + 3_600_000 });
    this.caDir = mkdtempSync(path.join(os.tmpdir(), "peeps-load-ca-"));
    const caFile = path.join(this.caDir, "ca.pem");
    writeFileSync(caFile, ca.certPem, { mode: 0o600 });

    const journal = new Journal();
    const gate = new Gate({ ...limits.value.gate, runEndMono: this.runEndMono, runEndWall: this.runEndWall, phase: limits.value.checking });
    gate.applyLease(this.lease!.grantNow);
    this.gate = gate;
    this.journal = journal;
    this.proxy = new GateProxy({
      gate,
      journal,
      ca,
      policy: limits.value.policy,
      origins: limits.value.approved,
      authorize: (c) => this.credentials.get(c),
      limits: { ...limits.value.proxy, exchangeMs: this.engine.turnDeadlineMs },
      clocks: this.clocks,
      onLeaseExpired: () => this.onExpiry(),
      onRunEnded: () => this.watch(),
      onTurnExpired: (turn) => {
        const state = this.turns.get(turn);
        if (state) this.expireTurn(state);
      },
      dial: this.s.dial ?? (this.s.dialSeams ? makeDial(this.s.dialSeams) : undefined),
      seqHeader: this.s.seqHeader,
    });
    this.lastSnapshot = journal.snapshot();
    this.s.onJournal?.(journal);

    const node = "/run/peeps/node/bin/node";
    const spec: JailSpec = {
      runId: this.o.runId,
      claimId: g.claimId,
      node: path.join(this.o.nodeDir, "bin", "node"),
      nodeDir: this.o.nodeDir,
      actionDir: this.o.actionDir,
      outer: path.join(this.o.actionDir, "load-outer.js"),
      init: path.join(this.o.actionDir, "load-init.js"),
      workspace: this.o.workspace,
      caPem: caFile,
      executorUid: process.getuid?.() ?? 0,
      executorGid: process.getgid?.() ?? 0,
      install: [node, "/run/peeps/node/lib/node_modules/npm/bin/npm-cli.js", "rebuild", "--foreground-scripts"],
      command: this.s.command ?? [node, "/run/peeps/action/load-executor.js"],
      env: {},
      // The clocks read fractional milliseconds; systemd and the spec take whole ones.
      limits: { maxRunMs: Math.ceil(15 * 60_000 + 60_000 + Math.max(0, this.runEndMono - this.clocks().monoMs) + g.graceMs), memoryMax: "2G", tasksMax: 512, cpuQuotaPercent: Math.max(100, (os.availableParallelism() - 1) * 100) },
    };
    const proxy = this.proxy;
    const launch = this.s.launch ?? startJail;
    this.jailLaunchPending = true;
    this.launchCalled = true;
    let handle: JailHandle;
    try {
      handle = await launch(spec, { listenProxy: (p) => proxy.listen(p).then(() => proxy.server) }, this.signal);
    } finally {
      this.jailLaunchPending = false;
    }
    this.jail = handle;
    if (this.reason !== undefined) {
      this.jailEnded = handle.end();
      this.jailEnded.catch(() => undefined);
      this.throwIfDone();
    }
    handle.onFrame((f) => this.onFrame(f));
    void handle.exited.then((e) => {
      if (this.reason !== undefined) return;
      if (e.signal === "protocol") this.terminate("executor_protocol", "failed");
      else if (this.phase !== "starting" || this.playwright !== null) this.terminate("executor_exit", "failed");
    });
  }

  // ---------------------------------------------------------------- startup

  private ticketOf = (): Ticket | null => {
    const t = this.clocks();
    const lease = this.lease!;
    if (this.reason !== undefined || this.gracefulStop || this.stopNowLive || !lease.held(t)) return null;
    if (!(t.monoMs < this.runEndMono && t.wallMs < this.runEndWall)) return null;
    const g = lease.grantNow;
    return { claimId: this.grant!.claimId, epoch: this.grant!.epoch, planHash: this.grant!.planHash, leaseSeq: g.seq, nonce: randomBytes(16).toString("hex"), monoDeadline: Math.min(g.monoUntil, this.runEndMono), wallDeadline: Math.min(g.wallUntil, this.runEndWall) };
  };

  private async startup(): Promise<void> {
    const jail = this.jail!;
    const installed = await jail.start(this.ticketOf, this.signal);
    this.throwIfDone();
    if (installed.code !== 0) throw new Refused("didnt_start", "install_failed", `code ${installed.code ?? installed.signal}`);
    await jail.launch(this.ticketOf, this.signal);
    this.throwIfDone();
    const answer = this.nextFrame((f) => f.type === "loaded" || f.type === "fatal", this.k.loadedMs);
    jail.send({ type: "init", journey: this.plan!.journey, baseURL: this.grant!.baseURL, proxy: jail.relayUrl, renewEveryMs: this.grant!.lease.renewEveryMs, parallel: DIALS_PER_TURN });
    const f = await answer;
    this.throwIfDone();
    if (!f) throw new Refused("didnt_start", "loaded_timeout");
    if (f.type === "fatal") {
      this.failures.push({ message: sanitize(f.message, 2000) ?? "", location: sanitize(f.location) });
      throw new Refused("didnt_start", `executor_${f.code}`);
    }
    if (f.type === "loaded") this.playwright = sanitize(f.playwright, 64);
  }

  /** The next frame matching, or null at the time limit or the run's end. */
  private nextFrame(match: (f: CtlFrame) => boolean, ms: number): Promise<CtlFrame | null> {
    return new Promise((resolve) => {
      const timer = setTimeout(() => done(null), ms);
      const off = this.jail!.onFrame((f) => {
        if (match(f)) done(f);
      });
      const onEnd = () => done(null);
      void this.terminated.then(onEnd);
      const done = (f: CtlFrame | null) => {
        clearTimeout(timer);
        off();
        resolve(f);
      };
    });
  }

  // ---------------------------------------------------------------- turns

  private openTurn(slot: number, phase: "checking" | "measurement", deadlineMs: number, accountingId: string): TurnState | null {
    const gate = this.gate!;
    const t = this.clocks();
    const opened = gate.openTurn(`s${slot}`, t, deadlineMs);
    if (!opened.ok) {
      if (opened.reason === "run_end") this.watch();
      return null;
    }
    const turn = opened.turn;
    const password = randomBytes(32).toString("base64url");
    this.credentials.set(`Basic ${Buffer.from(`${turn}:${password}`).toString("base64")}`, turn);
    const deadlineMono = Math.min(t.monoMs + deadlineMs, this.runEndMono);
    const state: TurnState = { turn, slot, phase, startMono: t.monoMs, deadlineWall: t.wallMs + deadlineMs, deadlineReached: false, timers: [], accountingId };
    this.turns.set(turn, state);
    this.busySlots.set(slot, state);
    if (phase === "checking") this.journal!.trackTurn(turn);
    state.timers.push(setTimeout(() => this.expireTurn(state), Math.max(0, deadlineMono - t.monoMs)));
    this.jail!.send({ type: "turn", turn, slot, password, deadlineMono });
    this.emit({ type: "turn", turn, slot, phase });
    return state;
  }

  /** At the deadline, close the gate side and cancel. The slot stays busy until its outcome. */
  private expireTurn(state: TurnState): void {
    if (state.deadlineReached || state.outcome !== undefined || this.reason !== undefined) return;
    state.deadlineReached = true;
    this.proxy!.closeTurn(state.turn);
    this.jail!.send({ type: "cancel", turn: state.turn });
    state.timers.push(setTimeout(() => {
      if (state.outcome === undefined && this.reason === undefined) this.terminate("executor_unresponsive", "failed");
    }, this.k.outcomeTimeoutMs));
  }

  private onFrame(f: CtlFrame): void {
    if (f.type !== "outcome") return;
    const state = this.turns.get(f.turn);
    if (!state || state.outcome !== undefined) {
      this.duplicateOutcomes = Math.min(this.duplicateOutcomes + 1, 1_000_000);
      return;
    }
    // A late frame cannot reopen anything; the gate side of the turn ends now, synchronously.
    state.outcome = f.kind;
    for (const timer of state.timers) clearTimeout(timer);
    this.proxy?.closeTurn(f.turn);
    this.busySlots.delete(state.slot);
    this.emit({ type: "outcome", turn: f.turn, kind: f.kind });
    if (f.kind !== "success" && this.failures.length < 20) this.failures.push({ message: sanitize(f.message, 2000) ?? f.kind, location: sanitize(f.location) });
    const counts = state.phase === "checking" ? this.checking : this.measurement;
    counts[f.kind] += 1;
    if (state.phase === "measurement") {
      const planNow = this.clocks().monoMs - this.measureStartMono;
      this.accounting.record(state.accountingId, f.kind === "cancelled" ? "interrupted" : f.kind, planNow);
    }
    for (const w of [...this.outcomeWaiters]) w();
    if (this.phase === "measurement") this.maybeFinishMeasurement();
  }

  private waitOutcomes(states: TurnState[], untilMono: number): Promise<void> {
    return new Promise((resolve) => {
      const check = () => {
        if (states.every((x) => x.outcome !== undefined) || this.reason !== undefined) done();
      };
      const timer = setTimeout(() => done(), Math.max(0, untilMono - this.clocks().monoMs));
      const done = () => {
        clearTimeout(timer);
        this.outcomeWaiters.delete(check);
        resolve();
      };
      this.outcomeWaiters.add(check);
      void this.terminated.then(done);
      check();
    });
  }

  // ---------------------------------------------------------------- Checking: a barrier

  private async runChecking(): Promise<void> {
    this.phase = "checking";
    this.emit({ type: "phase", phase: "checking" });
    const caps = this.limits!.checking;
    const deadline = this.clocks().monoMs + this.engine.checkingDeadlineMs;
    const states: TurnState[] = [];
    for (let slot = 1; slot <= caps.maxUsers; slot++) {
      const st = this.openTurn(slot, "checking", Math.min(this.engine.turnDeadlineMs, this.engine.checkingDeadlineMs), `checking-${slot}`);
      if (st) states.push(st);
    }
    this.checking.turns = states.length;
    await this.waitOutcomes(states, deadline);
    this.throwIfDone();
    for (const st of states) this.proxy!.closeTurn(st.turn);
    this.checking.responded = states.map((st) => this.journal!.respondedForTurn(st.turn));
    const passed =
      states.length === caps.maxUsers &&
      states.length > 0 &&
      states.every((st) => st.outcome === "success") &&
      this.checking.responded.every((n) => n >= 1) &&
      this.clocks().monoMs < deadline;
    if (!passed) throw new Refused("didnt_start", "checking_failed");
    // Just before the phase changes: the terminal and drain latches must be clear.
    if (this.reason !== undefined || this.gracefulStop || this.stopNowLive) throw new Refused("didnt_start", this.reason ?? "stopped");
    this.gate!.setPhase(this.limits!.measurement, this.clocks());
  }

  // ---------------------------------------------------------------- measurement

  private async runMeasurement(): Promise<void> {
    const plan = this.plan!;
    this.phase = "measurement";
    const started = this.clocks();
    this.measureStartMono = started.monoMs;
    this.measureStartWall = started.wallMs;
    this.emit({ type: "phase", phase: "measurement" });
    this.scheduler = new Scheduler({ pacingEveryMs: plan.cohort.pacingEveryMs, stages: plan.cohort.stages }, this.limits!.budgets.startSlackMs);
    this.tick();
    await this.terminated;
  }

  private tick(): void {
    if (this.reason !== undefined) return;
    const planNow = this.clocks().monoMs - this.measureStartMono;
    const scheduler = this.scheduler!;
    if (!this.gracefulStop) {
      const poll = scheduler.poll(planNow, (user) => this.busySlots.has(user));
      for (const m of poll.missed) {
        this.accounting.missed(m.dueMs);
        this.measurement.missed += 1;
      }
      for (const st of poll.starts) {
        this.accounting.due(st.dueMs);
        const id = `m-${st.userId}-${st.dueMs}`;
        const opened = this.openTurn(st.userId, "measurement", this.limits!.budgets.measurement.turnDeadlineMs, id);
        if (!opened) {
          this.accounting.missed(st.dueMs);
          this.measurement.missed += 1;
          continue;
        }
        this.measurement.started += 1;
        const startMs = opened.startMono - this.measureStartMono;
        this.startLags.push({ atMs: startMs, lagMs: Math.max(0, startMs - st.dueMs) });
        this.accounting.start(id, planNow, st.stage, planNow + this.limits!.budgets.measurement.turnDeadlineMs);
      }
    }
    this.countRequests(planNow);
    this.publishIntervals(planNow, false);
    if (scheduler.finished(planNow) && this.graceEnd === undefined) this.startDrain();
    this.maybeFinishMeasurement();
    if (this.reason === undefined) this.tickTimer = setTimeout(() => this.tick(), this.k.tickMs);
  }

  private maybeFinishMeasurement(): void {
    if (this.reason !== undefined || this.phase !== "measurement") return;
    const ending = this.gracefulStop || (this.scheduler !== undefined && this.graceEnd !== undefined);
    if (ending && this.busySlots.size === 0) this.terminate(this.gracefulStop ? "stopped" : "completed");
  }

  private markMeasurementEnd(at: Clocks): void {
    if (this.measureStartWall === undefined || this.measureEndWall !== undefined) return;
    const elapsed = Math.max(0, at.monoMs - this.measureStartMono);
    this.measureEndWall = this.measureStartWall + Math.min(elapsed, this.plan!.durationMs);
  }

  private measurementWindow(): LoadResult["measurementWindow"] {
    if (this.measureStartWall === undefined || this.measureEndWall === undefined) return null;
    return { startedAtMs: this.measureStartWall, endedAtMs: this.measureEndWall };
  }

  private countRequests(planNow: number): void {
    const snap = this.journal!.snapshot();
    this.accounting.requests(Math.max(0, planNow), requestDelta(this.lastSnapshot!, snap));
    this.lastSnapshot = snap;
  }

  // ---------------------------------------------------------------- terminate, settle, report

  /** Cancels (if nothing has ended the run yet) and drops the draining: the lease is abandoned and the reporting is cut short. */
  private hardCancel(): void {
    if (this.hard) return;
    this.hard = true;
    this.hardTimer = setTimeout(this.resolveHardLimit, this.k.hardReportingMs);
    this.terminate("cancelled");
    this.lease?.abandon();
    this.renewing = false;
    clearTimeout(this.renewTimer);
    this.renewController.abort();
  }

  /** Synchronous and idempotent: one reason, latched. */
  private terminate(trigger: string, status?: LoadStatus, detail?: string): void {
    if (this.reason !== undefined) return;
    if (detail !== undefined && this.failures.length < 20) this.failures.push({ message: sanitize(detail, 2000) ?? trigger, location: null });
    let reason = trigger;
    let st: LoadStatus | undefined = status;
    if (this.expiryObserved || this.gate?.leaseExpired) [reason, st] = ["lease_lost", "lease_lost"];
    else if (this.stopNowLive) [reason, st] = ["stopped", "stopped"];
    else if (this.lease && !this.lease.held(this.clocks()) && !this.drainCutFirst(this.clocks())) [reason, st] = ["lease_lost", "lease_lost"];
    this.markMeasurementEnd(this.clocks());
    this.reason = reason;
    this.status = st ?? statusOf(reason);
    clearTimeout(this.watchTimer);
    clearTimeout(this.tickTimer);
    for (const state of this.turns.values()) for (const timer of state.timers) clearTimeout(timer);
    if (this.journal && this.gate && this.lease) {
      this.emit({ type: "snapshot", at: "terminate", handoffs: encodeHandoffs(this.journal.handoffs()), journal: this.journal.snapshot(), monoMs: this.clocks().monoMs, leaseMonoUntil: this.lease.grantNow.monoUntil });
    }
    this.emit({ type: "terminate", reason, status: this.status });
    // Stop the gate and reset every upstream, and end the jail, without waiting on each other.
    this.proxyClosed = this.proxy ? this.proxy.close() : Promise.resolve();
    this.jailEnded = this.jail ? this.jail.end() : Promise.resolve({ clean: true });
    this.jailEnded.catch(() => undefined);
    const keepRenewing = this.lease !== undefined && !this.hard && !(reason === "lease_lost" || reason.startsWith("executor_") || this.phase === "starting");
    if (!keepRenewing) {
      this.lease?.abandon();
      this.renewing = false;
      clearTimeout(this.renewTimer);
      this.renewController.abort();
    } else {
      this.renewState = "draining";
    }
    this.internal.abort();
    for (const w of [...this.outcomeWaiters]) w();
    this.resolveTerminated();
  }

  private async finish(): Promise<LoadResult> {
    const deadline = delayResolve(this.k.reportingMs);
    // The same SIGTERM deadline bounds startup, settlement, reporting and cleanup.
    void this.hardLimit.then(deadline.finish);
    // Settlement: the proxy has closed every upstream and owned work, and no renewal is in flight.
    const settled = (async () => {
      await this.proxyClosed;
      this.renewing = false;
      clearTimeout(this.renewTimer);
      while (this.renewInFlight) await this.renewInFlight;
      return true;
    })();
    const ok = await Promise.race([settled, deadline.then(() => false)]);
    this.renewing = false;
    clearTimeout(this.renewTimer);
    this.renewController.abort();
    // One final debit, shared by the final watermark and `closed`.
    const finalDebit = this.gate?.admitted ?? 0;
    if (ok && this.gate) {
      this.gateClosed = true;
      this.emit({ type: "gate_closed", debited: finalDebit });
    }
    if (this.journal) {
      const planNow = this.phase === "measurement" ? this.clocks().monoMs - this.measureStartMono : 0;
      this.countRequests(Math.max(0, planNow));
      this.publishIntervals(Math.max(0, planNow), true);
      this.queueHandoffs();
      if (this.gateClosed) this.queueFinal(finalDebit);
    }
    // Proof collection runs beside the evidence: `closed` never waits for an upload.
    const cleanup = this.cleanupProof(deadline);
    const closing = cleanup.then((c) => this.close(ok, c, finalDebit, deadline));
    await Promise.race([Promise.all([this.flushEvidence(), closing]), deadline]);
    this.evidenceStopped = true;
    this.evidenceCancel.abort();
    this.closedCancel.abort();
    const jailEnd = await Promise.race([cleanup, deadline.then(() => "dirty" as const)]);
    if (this.caDir) rmSync(this.caDir, { recursive: true, force: true });
    deadline.cancel();
    const loop = this.loopDelay;
    return {
      status: this.status!,
      reason: this.reason!,
      claimId: this.claimId,
      playwright: this.playwright,
      checking: this.checking,
      measurement: this.measurement,
      measurementWindow: this.measurementWindow(),
      journal: this.journal?.snapshot() ?? null,
      handoffs: this.journal ? encodeHandoffs(this.journal.handoffs()) : null,
      gateClosed: this.gateClosed,
      final: this.finalSent ?? "missing",
      renewals: this.renewals,
      latency: this.latencySummary(true),
      eventLoop: { p99Ms: loop.count ? round(loop.percentile(99) / 1e6) : 0, maxMs: loop.count ? round(loop.max / 1e6) : 0 },
      closed: this.closedOutcome,
      evidence: this.finalSent ? { state: "complete" } : this.incomplete ? { state: "incomplete", ...this.incomplete } : { state: "missing" },
      cleanup: jailEnd,
      duplicateOutcomes: this.duplicateOutcomes,
      failures: this.failures,
    };
  }

  /**
   * Whether nothing of this run can be left: `clean` when the jail ended with its cgroup proven
   * empty, or when no launch was ever attempted (`not_started`). A launch still pending, one that
   * failed, or an end that is not clean or not back by the deadline is `dirty`.
   */
  private async cleanupProof(deadline: Promise<void>): Promise<"clean" | "dirty" | "not_started"> {
    if (!this.launchCalled) return "not_started";
    if (this.jailLaunchPending || !this.jail || !this.jailEnded) return "dirty";
    const end = await Promise.race([this.jailEnded.catch(() => null), deadline.then(() => null)]);
    return end?.clean ? "clean" : "dirty";
  }

  /**
   * The release-bearing `closed` renewal: once, only with settlement proven, retried with
   * identical bytes until a matching receipt, a refusal or the reporting deadline.
   */
  private async close(settled: boolean, cleanup: "clean" | "dirty" | "not_started", debited: number, deadline: ReturnType<typeof delayResolve>): Promise<void> {
    const lease = this.lease;
    const g = this.grant;
    if (!lease || !g) return;
    const inFlight = this.gate?.inFlight ?? 0;
    const withheld = !settled ? "unsettled" : cleanup === "dirty" ? "dirty" : inFlight !== 0 ? "in_flight" : undefined;
    if (withheld) {
      this.closedOutcome = { state: "withheld", reason: withheld, attempts: 0, latencyMs: null };
      return;
    }
    if (deadline.expired()) return;
    const t0 = this.clocks();
    const tx = lease.beginClosed(t0, randomBytes(16).toString("hex"), (seq, nonce) =>
      renewBody({ epoch: g.epoch, seq, nonce, phase: this.phase, debited, unresolved: this.gate?.unresolved ?? 0, inFlight: 0, state: "closed", lagP99Ms: this.lagP99Ms() }),
    );
    if (!tx) return;
    const out: ClosedOutcome = { state: "unanswered", seq: tx.seq, debited, attempts: 0, latencyMs: null };
    this.closedOutcome = out;
    const stop = AbortSignal.any([this.closedCancel.signal, this.hardSignalOr()]);
    void deadline.then(() => this.closedCancel.abort());
    let pause = this.k.retryMs;
    while (!stop.aborted && !deadline.expired()) {
      out.attempts += 1;
      let raw: unknown;
      let answered = true;
      try {
        raw = await this.o.port.renew(g.claimId, g.runToken, tx.body, AbortSignal.any([stop, AbortSignal.timeout(this.k.renewAttemptMs)]));
      } catch {
        answered = false;
      }
      if (stop.aborted || deadline.expired()) break;
      if (answered) {
        const receipt = decodeClosedReceipt(raw);
        if (receipt && lease.ackClosed(receipt)) {
          out.state = "acked";
          out.latencyMs = round(this.clocks().monoMs - tx.firstSendMono);
          break;
        }
        const refused = isObj(raw) && typeof raw.refused === "string" ? raw.refused.slice(0, 64) : undefined;
        if (refused !== undefined) {
          out.state = "refused";
          out.reason = refused;
          break;
        }
      }
      // No answer, or one that is not this receipt: the same bytes again, after a pause.
      await delay(pause, stop).catch(() => undefined);
      pause = Math.min(pause * 2, this.k.retryMaxMs);
    }
    this.emit({ type: "closed", seq: tx.seq, outcome: out.state });
  }

  /** The closed retries stop with the hard limit too. */
  private hardSignalOr(): AbortSignal {
    const ac = new AbortController();
    void this.hardLimit.then(() => ac.abort());
    return ac.signal;
  }

  /** The renewal latency record; `withRecords` keeps every allocation's entry. */
  private latencySummary(withRecords: boolean): RenewalLatency {
    const records: RenewalLatency["records"] = [...this.latency.entries()].sort((a, b) => a[0] - b[0]).map(([seq, r]) =>
      [seq, r.attempts, r.ms === null ? null : round(r.ms), r.outcome, r.firstSendAtMs, r.answerAppliedAtMs, r.phase],
    );
    const values = records.map((r) => (r[2] === null ? Number.POSITIVE_INFINITY : r[2])).sort((a, b) => a - b);
    const at = (q: number) => {
      const v = nearestRank(values, q);
      return v === undefined || !Number.isFinite(v) ? null : v;
    };
    return { records: withRecords ? records : [], count: records.length, unanswered: records.filter((r) => r[2] === null).length, p50Ms: at(0.5), p99Ms: at(0.99), p999Ms: at(0.999), maxMs: at(1) };
  }

  // ---------------------------------------------------------------- evidence

  private publishIntervals(planNow: number, force: boolean): void {
    if (!this.journal || this.phase !== "measurement") return;
    const intervals: IntervalRecord[] = force ? this.accounting.closeIntervals(Math.ceil((planNow + 1) / this.k.intervalMs) * this.k.intervalMs) : this.accounting.closeIntervals(planNow);
    const cohorts: CohortRecord[] = this.accounting.sealCohorts(planNow, this.drainGraceMs, force);
    if (!intervals.length && !cohorts.length) return;
    if (this.fits({ kind: "intervals", intervals, cohorts })) this.queue({ kind: "intervals", intervals, cohorts });
    else {
      this.queueRecords("intervals", "intervals", intervals, { cohorts: [] });
      this.queueRecords("intervals", "cohorts", cohorts, { intervals: [] });
    }
  }

  /** The handoffs, the renewal latencies and the summary, each split to fit a batch. */
  private queueHandoffs(): void {
    const h = encodeHandoffs(this.journal!.handoffs());
    this.queueRecords("handoffs", "unattempted", h.unattempted, { debited: h.debited });
    const latency = this.latencySummary(true);
    this.queueRecords("renewals", "records", latency.records, {});
    const { records: _records, ...latencyStats } = latency;
    const loop = this.loopDelay;
    this.queue({ kind: "summary", journal: this.journal!.snapshot(), checking: this.checking, measurement: this.measurement, measurementWindow: this.measurementWindow(), reason: this.reason, playwright: this.playwright, failures: this.failures.slice(0, 20), denyReasons: DENY_REASONS.length, cutReasons: CUT_REASONS.length, zero: zeroCounts().debited, latency: latencyStats, eventLoop: { p99Ms: loop.count ? round(loop.percentile(99) / 1e6) : 0, maxMs: loop.count ? round(loop.max / 1e6) : 0 } });
  }

  private queueFinal(watermark: number): void {
    // No complete final follows a record that could not be sent.
    if (this.incomplete) return;
    this.queue({ kind: "final" }, { watermark });
  }

  /** Whether `payload` fits one batch and one events body. */
  private fits(payload: Record<string, unknown>): boolean {
    const batch = JSON.stringify(payload);
    return Buffer.byteLength(batch) <= this.k.maxBatchBytes && Buffer.byteLength(JSON.stringify(batch)) + 512 <= this.k.maxEventsBodyBytes;
  }

  /** `records` under `key`, split to fit before any seq is allocated (`splitToFit`). */
  private queueRecords(kind: string, key: string, records: readonly unknown[], extra: Record<string, unknown>): void {
    const split = splitToFit(kind, key, records, extra, (p) => this.fits(p));
    for (const payload of split.payloads) this.queue(payload);
    if (split.oversized !== undefined) this.latchIncomplete({ reason: "oversized", record: { kind, index: split.oversized } });
  }

  private latchIncomplete(why: Omit<EvidenceState, "state">): void {
    this.incomplete ??= why;
  }

  private queue(payload: Record<string, unknown>, final?: { watermark: number }): void {
    if (!this.grant || this.evidenceStopped) return;
    if (!this.fits(payload)) return this.latchIncomplete({ reason: "oversized", record: { kind: String(payload.kind), index: 0 } });
    const seq = ++this.evidenceSeq;
    const batch = JSON.stringify(payload);
    const payloadHash = batchHash({ streamId: this.streamId, seq, payload: batch, final });
    this.evidenceQueue.push({ body: { streamId: this.streamId, seq, payloadHash, batch, ...(final ? { final } : {}) } });
    this.startEvidence();
  }

  private startEvidence(): Promise<void> {
    return this.evidenceRunning ??= this.pump().finally(() => (this.evidenceRunning = undefined));
  }

  /**
   * One batch in flight. Dropped only on `{ok: true}`. A transport failure (a 5xx or 429 too) or
   * an answer that does not decode sends the same bytes again after a pause that doubles up to
   * `retryMaxMs`. Any refusal latches the evidence `incomplete` at that seq and stops the
   * stream, so nothing after a hole is sent and no final is acknowledged past one.
   */
  private async pump(): Promise<void> {
    const g = this.grant!;
    let pause = this.k.retryMs;
    while (this.evidenceQueue.length && !this.evidenceStopped) {
      const head = this.evidenceQueue[0]!;
      let answer: unknown;
      let answered = true;
      try {
        answer = await this.o.port.events(g.claimId, g.eventsToken, head.body, AbortSignal.any([this.evidenceCancel.signal, AbortSignal.timeout(this.k.renewAttemptMs * 2)]));
      } catch {
        answered = false;
      }
      if (this.evidenceStopped) return;
      if (answered && isObj(answer)) {
        if (answer.ok === true && typeof answer.replay === "boolean" && !("reason" in answer) && !("refused" in answer)) {
          this.evidenceQueue.shift();
          if (head.body.final) this.finalSent = head.body.final;
          pause = this.k.retryMs;
          continue;
        }
        const refusal = answer.ok === false ? answer.reason : answer.refused;
        if (answer.ok === false || (answer.ok !== true && typeof answer.refused === "string")) {
          this.latchIncomplete({ seq: head.body.seq, reason: typeof refusal === "string" ? refusal.slice(0, 64) : "unknown" });
          this.evidenceStopped = true;
          return;
        }
      }
      await delay(pause, this.evidenceCancel.signal).catch(() => undefined);
      pause = Math.min(pause * 2, this.k.retryMaxMs);
    }
  }

  private async flushEvidence(): Promise<void> {
    // Final batches can be queued after the last pump saw an empty queue but
    // before its finally handler cleared evidenceRunning. Start a pump for them.
    while (this.evidenceRunning || (!this.evidenceStopped && this.evidenceQueue.length > 0)) {
      await this.startEvidence();
    }
  }
}

function statusOf(reason: string): LoadStatus {
  if (reason === "completed") return "completed";
  if (reason === "stopped") return "stopped";
  if (reason === "cancelled") return "cancelled";
  if (reason === "lease_lost") return "lease_lost";
  if (reason === "didnt_start") return "didnt_start";
  return "failed";
}

const round = (ms: number) => Math.round(ms * 10) / 10;
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/**
 * `records` under `key` as batches that each fit: `{kind, ...extra, first, [key]}`, halved until
 * they do, in order, with `first` the index of a part's first record. A single record that cannot
 * fit is never sent: `oversized` is the first such index, and nothing after it is batched.
 */
export function splitToFit(kind: string, key: string, records: readonly unknown[], extra: Record<string, unknown>, fits: (payload: Record<string, unknown>) => boolean): { payloads: Record<string, unknown>[]; oversized?: number } {
  const payloads: Record<string, unknown>[] = [];
  let oversized: number | undefined;
  const go = (part: readonly unknown[], first: number): void => {
    if (oversized !== undefined) return;
    const payload = { kind, ...extra, first, [key]: part };
    if (fits(payload)) return void payloads.push(payload);
    if (part.length <= 1) return void (oversized = first);
    const half = Math.ceil(part.length / 2);
    go(part.slice(0, half), first);
    go(part.slice(half), first + half);
  };
  go(records, 0);
  return oversized === undefined ? { payloads } : { payloads, oversized };
}

/** Nearest-rank: the value at rank ⌈q·n⌉ of the sorted values (q = 1: the largest). */
export function nearestRank(sorted: readonly number[], q: number): number | undefined {
  if (sorted.length === 0) return undefined;
  return sorted[Math.min(sorted.length, Math.max(1, Math.ceil(q * sorted.length))) - 1];
}

function pick<T extends object>(o: T | undefined, keys: string[]): Partial<T> {
  if (!o) return {};
  return Object.fromEntries(Object.entries(o).filter(([k, v]) => keys.includes(k) && v !== undefined)) as Partial<T>;
}

function delay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason);
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal!.reason);
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

function delayResolve(ms: number): Promise<void> & { expired(): boolean; cancel(): void; finish(): void } {
  const end = performance.now() + ms;
  let finished = false;
  let done!: () => void;
  const p = new Promise<void>((resolve) => { done = resolve; });
  const finish = () => {
    finished = true;
    clearTimeout(timer);
    done();
  };
  const timer = setTimeout(finish, ms);
  return Object.assign(p, {
    cancel: () => clearTimeout(timer),
    expired: () => finished || performance.now() >= end,
    finish,
  });
}
