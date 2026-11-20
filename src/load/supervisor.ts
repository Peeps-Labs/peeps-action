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
 *   deadline → teardown.
 *
 * No `closed` renewal is ever sent: that is E5's.
 */
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { CUT_REASONS, DENY_REASONS, Accounting, requestDelta, zeroCounts, type IntervalRecord, type CohortRecord } from "./accounting";
import { sharedClocks } from "./clocks";
import { decodeClaimReply, decodeRenewReply, planHashOf, renewBody, type Binding, type ClaimRequest, type ControlPort, type Grant, type RenewState } from "./control-port";
import { ENGINE_LIMITS, OUTSTANDING_PER_TURN, runLimits, type EngineConstants, type RunLimits } from "./engine-limits";
import { Gate, type Clocks } from "./gate/admission";
import { createRunCa } from "./gate/ca";
import { encodeHandoffs, Journal, type JournalSnapshot } from "./gate/journal";
import { GateProxy, makeDial, type Dial, type DialSeams } from "./gate/proxy";
import { batchHash } from "./gate/reconcile";
import { checkoutHead, preinstall as realPreinstall, treeDigest, trustedToolchain, type InstallDigests } from "./install";
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
  stopGraceMs: number;
  /** Largest evidence batch, in bytes. */
  maxBatchBytes: number;
}

export const SUPERVISOR_CONSTANTS: SupervisorConstants = {
  loadedMs: 60_000,
  reportingMs: 10_000,
  hardReportingMs: 2_000,
  intervalMs: 10_000,
  tickMs: 50,
  renewAttemptMs: 1_000,
  stopGraceMs: 5_000,
  maxBatchBytes: 256 * 1024,
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

export type LoadStatus = "completed" | "stopped" | "cancelled" | "lease_lost" | "didnt_start" | "failed";

export type LoadEvent =
  | { type: "claimed"; claimId: string }
  | { type: "renewal"; seq: number; state: RenewState; decision: string }
  | { type: "phase"; phase: "checking" | "measurement" }
  | { type: "turn"; turn: number; slot: number; phase: "checking" | "measurement" }
  | { type: "outcome"; turn: number; kind: string }
  | { type: "terminate"; reason: string; status: LoadStatus }
  | { type: "gate_closed"; debited: number }
  | { type: "snapshot"; at: "terminate"; handoffs: { debited: number; unattempted: number[] }; journal: JournalSnapshot; monoMs: number; leaseMonoUntil: number };

export interface LoadResult {
  status: LoadStatus;
  reason: string;
  claimId: string | null;
  playwright: string | null;
  checking: { turns: number; success: number; failure: number; timeout: number; cancelled: number; responded: number[] };
  measurement: { started: number; missed: number; success: number; failure: number; timeout: number; cancelled: number };
  journal: JournalSnapshot | null;
  handoffs: { debited: number; unattempted: number[] } | null;
  /** The gate settled and the local marker was written. */
  gateClosed: boolean;
  /** The evidence stream's final watermark, or missing when the deadline passed first. */
  final: { watermark: number } | "missing";
  renewals: { sent: number; states: RenewState[]; afterTerminate: number };
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
export async function bindingOf(workspace: string, workloadPath: string, tree?: string): Promise<Binding> {
  const lock = path.join(workspace, "package-lock.json");
  const hidden = path.join(workspace, "node_modules/.package-lock.json");
  return {
    checkoutSha: checkoutHead(workspace),
    lockDigests: { "package-lock.json": existsSync(lock) ? sha256Of(lock) : "", "node_modules/.package-lock.json": existsSync(hidden) ? sha256Of(hidden) : "" },
    treeDigest: tree ?? (await treeDigest(workspace)),
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
  private caDir: string | undefined;

  /** Latches. */
  private reason: string | undefined;
  private status: LoadStatus | undefined;
  private expiryObserved = false;
  private stopNowLive = false;
  private gracefulStop = false;
  private phase: "starting" | "checking" | "measurement" = "starting";

  private renewController = new AbortController();
  private renewing = false;
  private renewInFlight: Promise<void> | undefined;
  private renewTimer: NodeJS.Timeout | undefined;
  private renewState: RenewState = "running";
  private readonly renewals = { sent: 0, states: [] as RenewState[], afterTerminate: 0 };
  private watchTimer: NodeJS.Timeout | undefined;
  private tickTimer: NodeJS.Timeout | undefined;
  private graceEndMono: number | undefined;

  private readonly credentials = new Map<string, number>();
  private readonly turns = new Map<number, TurnState>();
  private readonly busySlots = new Set<number>();
  private duplicateOutcomes = 0;
  private readonly failures: LoadResult["failures"] = [];
  private playwright: string | null = null;
  private readonly checking = { turns: 0, success: 0, failure: 0, timeout: 0, cancelled: 0, responded: [] as number[] };
  private readonly measurement = { started: 0, missed: 0, success: 0, failure: 0, timeout: 0, cancelled: 0 };
  private accounting: Accounting;
  private measureStartMono = 0;
  private scheduler: Scheduler | undefined;
  private lastSnapshot: JournalSnapshot | undefined;

  private terminated: Promise<void>;
  private resolveTerminated!: () => void;
  private proxyClosed: Promise<void> | undefined;
  private jailEnded: Promise<{ clean: boolean }> | undefined;
  private gateClosed = false;
  private outcomeWaiters = new Set<() => void>();
  private hard = false;
  private hardDeadline: (() => void) | undefined;

  // Evidence: one ordered stream, one batch in flight.
  private readonly streamId = randomUUID();
  private evidenceSeq = 0;
  private readonly evidenceQueue: { body: { streamId: string; seq: number; payloadHash: string; batch: string; final?: { watermark: number } } }[] = [];
  private evidenceRunning: Promise<void> | undefined;
  private evidenceStopped = false;
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
    this.signal.addEventListener("abort", onAbort, { once: true });
    const onHard = () => this.hardCancel();
    if (this.o.hardSignal?.aborted) onHard();
    else this.o.hardSignal?.addEventListener("abort", onHard, { once: true });
    try {
      const report = await (this.s.probe ? this.s.probe() : this.realProbe());
      if (!report.passed) throw new Refused("didnt_start", "fence_unverified", report.failures.join("; "));
      const digests = await (this.s.preinstall ? this.s.preinstall(this.o.workspace) : this.realPreinstall());
      const binding = await bindingOf(this.o.workspace, this.o.workloadPath, digests.tree);
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
    } finally {
      this.signal.removeEventListener("abort", onAbort);
    }
    await this.terminated;
    try {
      return await this.finish();
    } finally {
      this.o.hardSignal?.removeEventListener("abort", onHard);
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

  private async realPreinstall(): Promise<InstallDigests> {
    const scratch = mkdtempSync(path.join(os.tmpdir(), "peeps-load-install-"));
    try {
      return await realPreinstall(this.o.workspace, trustedToolchain(this.o.nodeDir, this.o.workspace), scratch);
    } catch (error) {
      throw new Refused("didnt_start", "install_unsupported", (error as Error).message);
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  }

  // ---------------------------------------------------------------- claim and the lease controller

  private async claim(binding: Binding, report: ProbeReport): Promise<void> {
    const body: ClaimRequest = {
      protocol: 1,
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
    // The hard end on the monotonic clock, conservatively from the claim's send.
    this.runEndMono = sent.monoMs + (g.hardEndServerMs - g.lease.serverNowMs);
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
      lagP99Ms: 0,
    });
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
    const signal = this.renewController.signal;
    for (;;) {
      if (signal.aborted) return;
      const attempt = AbortSignal.any([signal, AbortSignal.timeout(this.k.renewAttemptMs)]);
      let raw: unknown;
      try {
        raw = await this.o.port.renew(g.claimId, g.runToken, tx.body, attempt);
      } catch {
        if (signal.aborted) return;
        if (!lease.mayRetry(this.clocks())) return this.onExpiry();
        continue;
      }
      if (signal.aborted) return;
      const decoded = decodeRenewReply(raw);
      if (decoded.kind === "unaddressed") {
        if (!lease.mayRetry(this.clocks())) return this.onExpiry();
        await delay(Math.min(100, this.k.renewAttemptMs), signal).catch(() => undefined);
        continue;
      }
      const now = this.clocks();
      const d = lease.apply(decoded.reply, now);
      this.emit({ type: "renewal", seq: tx.seq, state, decision: d.kind });
      if (d.kind === "ignored") {
        if (!lease.mayRetry(this.clocks())) return this.onExpiry();
        continue;
      }
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
      }
      this.armWatch();
      this.scheduleRenew(tx.firstSendMono, now.monoMs);
      return;
    }
  }

  private onExpiry(): void {
    this.expiryObserved = true;
    this.gate?.revokeLease();
    this.terminate("lease_lost");
  }

  private onGracefulStop(): void {
    if (this.gracefulStop) return;
    this.gracefulStop = true;
    this.gate?.drain();
    if (this.phase !== "measurement") return this.terminate(this.phase === "starting" ? "didnt_start" : "stopped", this.phase === "starting" ? "didnt_start" : "stopped");
    this.graceEndMono = this.clocks().monoMs + this.k.stopGraceMs;
    this.armWatch();
    this.maybeFinishMeasurement();
  }

  /** One self-re-arming timer on the nearest deadline: the lease, the run's end, and the grace end. */
  private armWatch(): void {
    if (this.reason !== undefined || !this.lease) return;
    clearTimeout(this.watchTimer);
    const t = this.clocks();
    const nearest = Math.min(this.lease.grantNow.monoUntil, this.runEndMono, this.graceEndMono ?? Number.POSITIVE_INFINITY);
    const wait = Math.min(100, Math.max(1, nearest - t.monoMs));
    this.watchTimer = setTimeout(() => this.watch(), Number.isFinite(wait) ? wait : 100);
  }

  private watch(): void {
    if (this.reason !== undefined || !this.lease) return;
    const t = this.clocks();
    if (!this.lease.held(t)) return this.onExpiry();
    if (!(t.monoMs < this.runEndMono)) return this.terminate("run_end", "failed");
    if (this.graceEndMono !== undefined && !(t.monoMs < this.graceEndMono)) return this.terminate(this.gracefulStop ? "stopped" : "completed");
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
    const now = await bindingOf(this.o.workspace, this.o.workloadPath);
    if (!sameBinding(now, claimed) || !sameBinding(now, g.binding)) throw new Refused("didnt_start", "checkout_changed");
    const limits = runLimits(input.value, g.limits, { parallel: OUTSTANDING_PER_TURN, constants: this.engine });
    if (!limits.ok) throw new Refused("didnt_start", limits.reason, limits.detail);
    this.limits = limits.value;
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
    const gate = new Gate({ ...limits.value.gate, runEndMono: this.runEndMono, phase: limits.value.checking });
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
    const handle = await launch(spec, { listenProxy: (p) => proxy.listen(p).then(() => proxy.server) }, this.signal);
    this.jail = handle;
    if (this.reason !== undefined) {
      void handle.end();
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
    const g = lease.grantNow;
    return { claimId: this.grant!.claimId, epoch: this.grant!.epoch, planHash: this.grant!.planHash, leaseSeq: g.seq, nonce: randomBytes(16).toString("hex"), monoDeadline: g.monoUntil, wallDeadline: g.wallUntil };
  };

  private async startup(): Promise<void> {
    const jail = this.jail!;
    const installed = await jail.start(this.ticketOf, this.signal);
    this.throwIfDone();
    if (installed.code !== 0) throw new Refused("didnt_start", "install_failed", `code ${installed.code ?? installed.signal}`);
    await jail.launch(this.ticketOf, this.signal);
    this.throwIfDone();
    const answer = this.nextFrame((f) => f.type === "loaded" || f.type === "fatal", this.k.loadedMs);
    jail.send({ type: "init", journey: this.plan!.journey, baseURL: this.grant!.baseURL, proxy: jail.relayUrl, renewEveryMs: this.grant!.lease.renewEveryMs, parallel: Math.min(4, 8, OUTSTANDING_PER_TURN) });
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
    const opened = gate.openTurn(`s${slot}`, t);
    if (!opened.ok) return null;
    const turn = opened.turn;
    const password = randomBytes(32).toString("base64url");
    this.credentials.set(`Basic ${Buffer.from(`${turn}:${password}`).toString("base64")}`, turn);
    const deadlineMono = Math.min(t.monoMs + deadlineMs, this.runEndMono);
    const state: TurnState = { turn, slot, phase, startMono: t.monoMs, timers: [], accountingId };
    this.turns.set(turn, state);
    this.busySlots.add(slot);
    if (phase === "checking") this.journal!.trackTurn(turn);
    // At the deadline the gate side closes and `cancel` goes; the slot stays busy until the outcome.
    state.timers.push(setTimeout(() => {
      this.proxy!.closeTurn(turn);
      this.jail!.send({ type: "cancel", turn });
      state.timers.push(setTimeout(() => {
        if (state.outcome === undefined && this.reason === undefined) this.terminate("executor_unresponsive", "failed");
      }, this.k.stopGraceMs));
    }, Math.max(0, deadlineMono - t.monoMs)));
    this.jail!.send({ type: "turn", turn, slot, password, deadlineMono });
    this.emit({ type: "turn", turn, slot, phase });
    return state;
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
    this.emit({ type: "phase", phase: "measurement" });
    this.measureStartMono = this.clocks().monoMs;
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
        this.accounting.start(id, planNow, st.stage, planNow + this.limits!.budgets.measurement.turnDeadlineMs);
      }
    }
    this.countRequests(planNow);
    this.publishIntervals(planNow, false);
    if (scheduler.finished(planNow) && this.graceEndMono === undefined) {
      this.gate!.drain();
      this.graceEndMono = this.clocks().monoMs + this.k.stopGraceMs;
      this.armWatch();
    }
    this.maybeFinishMeasurement();
    if (this.reason === undefined) this.tickTimer = setTimeout(() => this.tick(), this.k.tickMs);
  }

  private maybeFinishMeasurement(): void {
    if (this.reason !== undefined || this.phase !== "measurement") return;
    const ending = this.gracefulStop || (this.scheduler !== undefined && this.graceEndMono !== undefined);
    if (ending && this.busySlots.size === 0) this.terminate(this.gracefulStop ? "stopped" : "completed");
  }

  private countRequests(planNow: number): void {
    const snap = this.journal!.snapshot();
    this.accounting.requests(Math.max(0, planNow), requestDelta(this.lastSnapshot!, snap));
    this.lastSnapshot = snap;
  }

  // ---------------------------------------------------------------- terminate, settle, report

  /** Cancels (if nothing has ended the run yet) and drops the draining: the lease is abandoned and the reporting is cut short. */
  private hardCancel(): void {
    this.hard = true;
    this.terminate("cancelled");
    this.lease?.abandon();
    this.renewing = false;
    clearTimeout(this.renewTimer);
    this.renewController.abort();
    this.hardDeadline?.();
  }

  /** Synchronous and idempotent: one reason, latched. */
  private terminate(trigger: string, status?: LoadStatus, detail?: string): void {
    if (this.reason !== undefined) return;
    if (detail !== undefined && this.failures.length < 20) this.failures.push({ message: sanitize(detail, 2000) ?? trigger, location: null });
    let reason = trigger;
    let st: LoadStatus | undefined = status;
    if (this.expiryObserved || this.gate?.leaseExpired) [reason, st] = ["lease_lost", "lease_lost"];
    else if (this.stopNowLive) [reason, st] = ["stopped", "stopped"];
    else if (this.lease && !this.lease.held(this.clocks())) [reason, st] = ["lease_lost", "lease_lost"];
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
    // A hard cancel, before or during the reporting, leaves it hardReportingMs from then.
    let short: ReturnType<typeof delayResolve> | undefined;
    const shorten = () => {
      short ??= delayResolve(this.k.hardReportingMs);
      void short.then(deadline.finish);
    };
    if (this.hard) shorten();
    else this.hardDeadline = shorten;
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
    if (ok && this.gate) {
      this.gateClosed = true;
      this.emit({ type: "gate_closed", debited: this.gate.admitted });
    }
    if (this.journal) {
      const planNow = this.phase === "measurement" ? this.clocks().monoMs - this.measureStartMono : 0;
      this.countRequests(Math.max(0, planNow));
      this.publishIntervals(Math.max(0, planNow), true);
      this.queueHandoffs();
      if (this.gateClosed) this.queueFinal(this.gate!.admitted);
    }
    await Promise.race([this.flushEvidence(), deadline]);
    this.evidenceStopped = true;
    const jailWait = delayResolve(10_000);
    const jailEnd = await Promise.race([this.jailEnded ?? Promise.resolve(null), jailWait.then(() => null)]).catch(() => null);
    jailWait.cancel();
    if (this.caDir) rmSync(this.caDir, { recursive: true, force: true });
    deadline.cancel();
    short?.cancel();
    this.hardDeadline = undefined;
    return {
      status: this.status!,
      reason: this.reason!,
      claimId: this.claimId,
      playwright: this.playwright,
      checking: this.checking,
      measurement: this.measurement,
      journal: this.journal?.snapshot() ?? null,
      handoffs: this.journal ? encodeHandoffs(this.journal.handoffs()) : null,
      gateClosed: this.gateClosed,
      final: this.finalSent ?? "missing",
      renewals: this.renewals,
      cleanup: this.jail ? (jailEnd?.clean ? "clean" : "dirty") : "not_started",
      duplicateOutcomes: this.duplicateOutcomes,
      failures: this.failures,
    };
  }

  // ---------------------------------------------------------------- evidence

  private publishIntervals(planNow: number, force: boolean): void {
    if (!this.journal || this.phase !== "measurement") return;
    const intervals: IntervalRecord[] = force ? this.accounting.closeIntervals(Math.ceil((planNow + 1) / this.k.intervalMs) * this.k.intervalMs) : this.accounting.closeIntervals(planNow);
    const cohorts: CohortRecord[] = this.accounting.sealCohorts(planNow, this.k.stopGraceMs, force);
    if (intervals.length || cohorts.length) this.queue({ kind: "intervals", intervals, cohorts });
  }

  /** The handoffs, in batches under the byte limit. */
  private queueHandoffs(): void {
    const h = encodeHandoffs(this.journal!.handoffs());
    const per = Math.max(1, Math.floor((this.k.maxBatchBytes - 1024) / 17));
    for (let i = 0; i === 0 || i < h.unattempted.length; i += per) {
      this.queue({ kind: "handoffs", debited: h.debited, unattempted: h.unattempted.slice(i, i + per), part: Math.floor(i / per) });
    }
    this.queue({ kind: "summary", journal: this.journal!.snapshot(), checking: this.checking, measurement: this.measurement, reason: this.reason, playwright: this.playwright, failures: this.failures.slice(0, 20), denyReasons: DENY_REASONS.length, cutReasons: CUT_REASONS.length, zero: zeroCounts().debited });
  }

  private queueFinal(watermark: number): void {
    this.queue({ kind: "final" }, { watermark });
  }

  private queue(payload: Record<string, unknown>, final?: { watermark: number }): void {
    if (!this.grant || this.evidenceStopped) return;
    const seq = ++this.evidenceSeq;
    let batch = JSON.stringify(payload);
    if (Buffer.byteLength(batch) > this.k.maxBatchBytes) batch = JSON.stringify({ kind: payload.kind, truncated: true });
    const payloadHash = batchHash({ streamId: this.streamId, seq, payload: batch, final });
    this.evidenceQueue.push({ body: { streamId: this.streamId, seq, payloadHash, batch, ...(final ? { final } : {}) } });
    this.evidenceRunning ??= this.pump().finally(() => (this.evidenceRunning = undefined));
  }

  /** One batch in flight, retried with identical bytes until its answer. */
  private async pump(): Promise<void> {
    const g = this.grant!;
    while (this.evidenceQueue.length && !this.evidenceStopped) {
      const head = this.evidenceQueue[0]!;
      let answer: unknown;
      try {
        answer = await this.o.port.events(g.claimId, g.eventsToken, head.body, AbortSignal.timeout(this.k.renewAttemptMs * 2));
      } catch {
        await delay(50).catch(() => undefined);
        continue;
      }
      const a = answer as { ok?: boolean; reason?: string };
      if (a?.ok === true || (a?.ok === false && a.reason !== "conflict")) {
        this.evidenceQueue.shift();
        if (a.ok && head.body.final) this.finalSent = head.body.final;
        continue;
      }
      // A conflicting replay: Peeps holds other bytes at this seq. Nothing more is sent.
      this.evidenceStopped = true;
    }
  }

  private async flushEvidence(): Promise<void> {
    while (this.evidenceRunning) await this.evidenceRunning;
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

function pick<T extends object>(o: T | undefined, keys: string[]): Partial<T> {
  if (!o) return {};
  return Object.fromEntries(Object.entries(o).filter(([k, v]) => keys.includes(k) && v !== undefined)) as Partial<T>;
}

function delay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => {
      clearTimeout(timer);
      reject(signal.reason);
    }, { once: true });
  });
}

function delayResolve(ms: number): Promise<void> & { cancel(): void; finish(): void } {
  let timer!: NodeJS.Timeout;
  let done!: () => void;
  const p = new Promise<void>((resolve) => {
    done = resolve;
    timer = setTimeout(resolve, ms);
  }) as Promise<void> & { cancel(): void; finish(): void };
  p.cancel = () => clearTimeout(timer);
  p.finish = () => {
    clearTimeout(timer);
    done();
  };
  return p;
}
