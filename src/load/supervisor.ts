/**
 * The supervisor: the engine's own process, which never imports the journey. It owns the
 * lease, the qualified clock, the scheduler, every budget and the containment, and the
 * executor can do nothing without it:
 *
 * - **Lease.** Renewed every third of a lease. An answer counts only for its own `seq`, only
 *   if no later `seq` was accepted, and only while young; permission then runs to the
 *   *request's* send time plus the lease, so a delayed or reordered answer never extends it.
 * - **Clock.** A resume fence (a gap or a wall/monotonic divergence) stops starts and permits
 *   until a renewal sent after the fence comes back.
 * - **Permits.** One per send, after the request policy and the phase's budget agree.
 * - **Stops.** Graceful: no new start; started turns may finish within the grace, then the
 *   containment kill. Now: the containment kill at once. Lost lease: no start or permit
 *   after `lastRenewal + leaseMs`, drain for the grace, then the kill. A turn past its
 *   deadline plus the kill grace means a hung executor: the kill.
 */
import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync, appendFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";

import { Accounting, type Outcome } from "./accounting";
import { PhaseGate } from "./budget";
import { QualifiedClock, type ClockBounds, type ClockSources } from "./clock";
import { spawnContained, type ContainedProcess, type ContainmentLevel } from "./containment";
import type { ControlPort, LeaseAnswer, Marker, MarkerKind, Phase } from "./control-port";
import { ENGINE_LIMITS, engineBudgets, type EngineBudgets, type EngineConstants } from "./engine-limits";
import { encodeFrame, FrameError, FrameReader, type Frame } from "./frames";
import type { PlanInput } from "./plan-input";
import { checkRequest } from "./policy";
import { Scheduler } from "./scheduler";
import { histogramOf, mergeHistograms, percentile, type Histogram } from "./timing";

export interface EngineOptions {
  /** The checked-out repository: the journey module is relative to it. */
  repositoryRoot: string;
  /** Where the job's tests run (the customer's Playwright is resolved from here). */
  workingDirectory?: string;
  /** The journey's `baseURL` (default: the first allowed origin). */
  baseURL?: string;
  runId?: string;
  /** Default: `load-executor.js` beside this bundle. */
  executorPath?: string;
  /** Overrides of the engine constants (tests; PR 3's grant). */
  constants?: Partial<EngineConstants>;
  intervalMs?: number;
  tickMs?: number;
  heartbeatMs?: number;
  /** How long the executor waits for the supervisor before it ends all traffic itself. */
  deadManMs?: number;
  /** How long after a permit the send must begin. */
  permitTtlMs?: number;
  clockBounds?: ClockBounds;
  clockSources?: ClockSources;
  /** After a turn's deadline, how long a silent executor gets before it is killed. */
  killGraceMs?: number;
  /** How old a lease answer may be, from its request's send time. */
  maxRenewalAgeMs?: number;
  containment?: ContainmentLevel | "auto";
  /** Run the executor as uid/gid 65534 when possible (default true). */
  dropPrivileges?: boolean;
  /** A directory only the supervisor can write; one is made when not given. */
  spoolDir?: string;
  /** Extra environment for the executor (PR 3: the environment's variables). */
  executorEnv?: Record<string, string>;
  /** Everything that happens, for tests and the job log. */
  observer?: (event: EngineEvent) => void;
}

export type EngineEvent =
  | { type: "started"; turn: string; user: number; phase: Phase; wallMs: number }
  | { type: "permit"; id: string; turn: string; wallMs: number }
  | { type: "outcome"; turn: string; kind: Outcome; phase: Phase; message?: string; location?: string | null }
  | { type: "marker"; marker: Marker; wallMs: number }
  | { type: "renewal"; seq: number; accepted: boolean; wallMs: number }
  | { type: "bypass"; kind: string; url: string }
  | { type: "executor"; pid: number | null; hostPid: number; containment: ContainmentLevel }
  | { type: "log"; line: string };

export type EngineStatus = "finished" | "stopped" | "didnt_start" | "lease_lost" | "failed";

export interface EngineResult {
  status: EngineStatus;
  reason: string | null;
  runId: string;
  containment: { level: ContainmentLevel; limitedBecause: string | null };
  isolation: { uid: number | null; level: "uid-65534" | "limited"; limitedBecause: string | null };
  playwright: string | null;
  checking: {
    users: number;
    success: number;
    failure: number;
    timeout: number;
    failures: { message: string; location: string | null }[];
  };
  measurement: {
    started: number;
    missed: number;
    success: number;
    failure: number;
    timeout: number;
    interrupted: number;
    successTime: Histogram;
    p95Micros: number | "overflow" | null;
  };
  permits: { issued: number; ids: string[]; denied: Record<string, number> };
  bypasses: { count: number; samples: { kind: string; url: string }[] };
  intervalsPublished: number;
  spoolDir: string;
}

/** Renewals that may be outstanding at once. */
const MAX_RENEWALS_IN_FLIGHT = 3;

const ALLOWED_ENV = ["PATH", "LANG", "LC_ALL", "TZ"];

interface ActiveTurn {
  id: string;
  user: number;
  phase: Phase;
  startAt: number;
  deadlineAt: number;
  /** Permits this turn has had: never more than the plan's `perJourneyMax`. */
  sends: number;
}

interface PendingAsk {
  req: number;
  turn: string;
  method: string;
  url: string;
}

const realSources: ClockSources = { monoMs: () => performance.now(), wallMs: () => Date.now() };

export class Supervisor {
  private readonly budgets: EngineBudgets;
  private readonly constants: EngineConstants;
  private readonly clock: QualifiedClock;
  private readonly runId: string;
  private readonly spoolDir: string;
  private readonly ownsSpool: boolean;
  private readonly tickMs: number;
  private readonly heartbeatMs: number;
  private readonly killGraceMs: number;
  private readonly maxRenewalAgeMs: number;

  private contained: ContainedProcess | null = null;
  private reader = new FrameReader();
  private executorExited = false;
  private killed = false;
  private isolation: EngineResult["isolation"] = { uid: null, level: "limited", limitedBecause: "not started" };
  private playwrightVersion: string | null = null;

  private leaseUntil = Number.NEGATIVE_INFINITY;
  private renewSeq = 0;
  private lastAcceptedSeq = 0;
  /** Renewals asked and not yet answered. A few may overlap, so one lost answer doesn't stall
   * the lease; their answers can then arrive out of order, and only a newer seq counts. */
  private renewalsInFlight = 0;
  private lastRenewSentAt = Number.NEGATIVE_INFINITY;
  private leaseLostMarked = false;
  private fenceMarked = false;

  private phase: Phase | "starting" | "done" = "starting";
  private gate: PhaseGate | null = null;
  private accounting: Accounting;
  private checkingAccounting: Accounting;
  private phaseStart = 0;
  private turnSeq = 0;
  private readonly turns = new Map<string, ActiveTurn>();
  private readonly busy = new Set<number>();
  private pending: PendingAsk[] = [];
  private readonly permitGates = new Map<string, PhaseGate>();
  private readonly issued: string[] = [];
  private readonly denied: Record<string, number> = {};
  private readonly bypasses: { kind: string; url: string }[] = [];
  private bypassCount = 0;
  private readonly successMicros: number[] = [];
  private checkingResult: EngineResult["checking"] = { users: 0, success: 0, failure: 0, timeout: 0, failures: [] };
  private measured = { started: 0, missed: 0, success: 0, failure: 0, timeout: 0, interrupted: 0 };
  private intervalsPublished = 0;

  private stopMode: "graceful" | "now" | "lease" | null = null;
  private drainUntil = Number.POSITIVE_INFINITY;
  private status: EngineStatus = "finished";
  private reason: string | null = null;
  private finishing = false;
  private resolveDone!: (result: EngineResult) => void;
  readonly done: Promise<EngineResult>;
  private timer: NodeJS.Timeout | null = null;
  private lastHeartbeat = Number.NEGATIVE_INFINITY;
  private readyWaiter: ((frame: Frame) => void) | null = null;
  private scheduler: Scheduler;

  constructor(
    private readonly input: PlanInput,
    private readonly port: ControlPort,
    private readonly options: EngineOptions,
  ) {
    this.constants = { ...ENGINE_LIMITS, ...options.constants };
    this.budgets = engineBudgets(input, this.constants);
    this.clock = new QualifiedClock(options.clockSources ?? realSources, options.clockBounds ?? { maxDivergenceMs: 1_000, maxGapMs: 2_000 });
    this.runId = options.runId ?? randomBytes(6).toString("hex");
    this.ownsSpool = !options.spoolDir;
    this.spoolDir = options.spoolDir ?? mkdtempSync(path.join(tmpdir(), "peeps-load-spool-"));
    this.tickMs = options.tickMs ?? 20;
    this.heartbeatMs = options.heartbeatMs ?? Math.max(10, Math.min(250, Math.floor((options.deadManMs ?? this.budgets.leaseMs) / 4)));
    this.killGraceMs = options.killGraceMs ?? 2_000;
    this.maxRenewalAgeMs = options.maxRenewalAgeMs ?? Math.floor(this.budgets.leaseMs / 2);
    this.scheduler = new Scheduler(input.plan.cohort, this.budgets.startSlackMs);
    this.accounting = new Accounting(options.intervalMs ?? 10_000);
    this.checkingAccounting = new Accounting(options.intervalMs ?? 10_000);
    this.done = new Promise((resolve) => (this.resolveDone = resolve));
  }

  // ---------------------------------------------------------------- events and markers

  private emit(event: EngineEvent): void {
    try {
      this.options.observer?.(event);
    } catch {
      // an observer never breaks the run
    }
  }

  private marker(kind: MarkerKind, detail?: string): void {
    const marker: Marker = { kind, atMs: this.clock.nowMs, ...(detail ? { detail } : {}) };
    this.emit({ type: "marker", marker, wallMs: Date.now() });
    this.port.publishMarker(marker).catch(() => undefined);
  }

  private sendToExecutor(frame: Frame): void {
    const stdin = this.contained?.child.stdin;
    if (!stdin || stdin.destroyed || this.executorExited) return;
    stdin.write(encodeFrame(frame));
  }

  // ---------------------------------------------------------------- start up

  async start(): Promise<void> {
    try {
      await this.spawnExecutor(this.options.dropPrivileges ?? true);
    } catch (error) {
      this.status = "didnt_start";
      this.reason = error instanceof Error ? error.message : String(error);
      await this.finish(false);
      return;
    }
    this.renew();
    this.timer = setInterval(() => this.tick(), this.tickMs);
  }

  private async spawnExecutor(drop: boolean): Promise<void> {
    const executor = this.options.executorPath ?? path.join(__dirname, "load-executor.js");
    const env: Record<string, string> = {};
    for (const key of ALLOWED_ENV) if (process.env[key]) env[key] = process.env[key]!;
    env.HOME = tmpdir();
    const baseURL = this.options.baseURL ?? this.input.limits.allowedOrigins[0]!;
    env.BASE_URL = baseURL;
    Object.assign(env, this.options.executorEnv ?? {});
    this.contained = spawnContained(
      { command: process.execPath, args: [executor], env: { ...env, ...(drop ? { PEEPS_LOAD_DROP_UID: "65534" } : {}) }, cwd: "/" },
      { prefer: this.options.containment ?? "auto", name: this.runId },
    );
    const child = this.contained.child;
    this.executorExited = false;
    this.reader = new FrameReader();
    child.stdout!.on("data", (chunk: Buffer) => this.onExecutorBytes(chunk));
    child.stderr!.on("data", (chunk: Buffer) => {
      for (const line of chunk.toString("utf8").split("\n").filter(Boolean)) this.emit({ type: "log", line: line.slice(0, 2000) });
    });
    child.on("exit", () => {
      this.executorExited = true;
      this.onExecutorExit();
    });
    child.stdin!.on("error", () => undefined);

    const hello = await this.expect("hello", 15_000);
    this.contained.setHostPid(Number(hello.hostPid));
    this.emit({ type: "executor", pid: child.pid ?? null, hostPid: Number(hello.hostPid), containment: this.contained.level });
    this.sendToExecutor({
      t: "init",
      runId: this.runId,
      repositoryRoot: path.resolve(this.options.repositoryRoot),
      workingDirectory: path.resolve(this.options.workingDirectory ?? this.options.repositoryRoot),
      journey: this.input.plan.journey,
      baseURL,
      deadManMs: this.options.deadManMs ?? this.budgets.leaseMs,
      permitTtlMs: this.options.permitTtlMs ?? 1_000,
    });
    // Enclosed before any customer code can run.
    this.contained.enclose();
    this.sendToExecutor({ t: "go" });
    const ready = await this.expect("ready", 60_000);
    if (ready.t === "fatal") {
      if (ready.code === "unreadable" && drop) {
        // uid 65534 cannot read the workspace: run as ourselves, and say so (P6).
        this.kill("unreadable workspace");
        this.killed = false;
        this.contained.dispose();
        await this.spawnExecutor(false);
        this.isolation = { uid: this.isolation.uid, level: "limited", limitedBecause: "uid 65534 cannot read the workspace or node_modules" };
        return;
      }
      throw new Error(`the executor could not start: ${String(ready.message)}${ready.location ? ` (${String(ready.location)})` : ""}`);
    }
    this.playwrightVersion = String(ready.playwright);
    const uid = Number(hello.uid);
    this.isolation = hello.dropped
      ? { uid, level: "uid-65534", limitedBecause: null }
      : { uid, level: "limited", limitedBecause: drop ? "the supervisor is neither root nor able to use sudo" : "isolation was turned off" };
  }

  /** Waits for the next frame of type `t` (or `fatal`) during start-up. */
  private expect(t: string, timeoutMs: number): Promise<Frame> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.readyWaiter = null;
        reject(new Error(`the executor did not say ${t} in time`));
      }, timeoutMs);
      this.readyWaiter = (frame) => {
        if (frame.t !== t && frame.t !== "fatal") return;
        clearTimeout(timer);
        this.readyWaiter = null;
        resolve(frame);
      };
      this.onEarlyExit = () => {
        clearTimeout(timer);
        reject(new Error("the executor exited while starting"));
      };
    });
  }

  private onEarlyExit: (() => void) | null = null;

  // ---------------------------------------------------------------- executor messages

  private onExecutorBytes(chunk: Buffer): void {
    let frames: Frame[];
    try {
      frames = this.reader.push(chunk);
    } catch (error) {
      // Anything on stdout that is not a frame: stop, never interpret it.
      if (error instanceof FrameError) this.fail(`executor protocol: ${error.message}`, true);
      return;
    }
    for (const frame of frames) {
      if (this.readyWaiter) {
        this.readyWaiter(frame);
        continue;
      }
      this.onExecutorFrame(frame);
    }
  }

  private onExecutorFrame(frame: Frame): void {
    switch (frame.t) {
      case "started": {
        const turn = this.turns.get(String(frame.turn));
        if (turn) this.emit({ type: "started", turn: turn.id, user: turn.user, phase: turn.phase, wallMs: Number(frame.wallMs) });
        return;
      }
      case "ask":
        this.pending.push({ req: Number(frame.req), turn: String(frame.turn), method: String(frame.method), url: String(frame.url) });
        this.answerAsks();
        return;
      case "done": {
        const gate = this.permitGates.get(String(frame.permit));
        this.permitGates.delete(String(frame.permit));
        gate?.release();
        this.answerAsks();
        return;
      }
      case "outcome":
        this.onOutcome(String(frame.turn), frame.kind as Outcome, frame);
        return;
      case "bypass": {
        this.bypassCount += 1;
        const sample = { kind: String(frame.kind), url: String(frame.url) };
        if (this.bypasses.length < 100) this.bypasses.push(sample);
        this.emit({ type: "bypass", ...sample });
        this.marker("bypass", `${sample.kind} ${sample.url}`);
        return;
      }
      case "stats":
        this.emit({ type: "log", line: `stats ${JSON.stringify(frame)}` });
        return;
      default:
        this.fail(`executor protocol: unexpected ${frame.t}`, true);
    }
  }

  private onOutcome(id: string, kind: Outcome, frame: Frame): void {
    const turn = this.turns.get(id);
    if (!turn) return;
    this.turns.delete(id);
    this.busy.delete(turn.user);
    const now = this.clock.nowMs;
    const message = typeof frame.message === "string" ? frame.message : undefined;
    const location = typeof frame.location === "string" ? frame.location : null;
    this.emit({ type: "outcome", turn: id, kind, phase: turn.phase, ...(message ? { message, location } : {}) });
    if (turn.phase === "checking") {
      this.checkingAccounting.outcome(id, kind, now - this.phaseStart);
      if (kind === "success") this.checkingResult.success += 1;
      else if (kind === "timeout") this.checkingResult.timeout += 1;
      else {
        this.checkingResult.failure += 1;
        if (this.checkingResult.failures.length < 10) this.checkingResult.failures.push({ message: message ?? kind, location });
      }
      return;
    }
    const recorded = this.accounting.outcome(id, kind, now - this.phaseStart);
    if (!recorded) return;
    const late = now >= turn.deadlineAt;
    const final: Outcome = late && kind !== "interrupted" ? "timeout" : kind;
    this.measured[final] += 1;
    if (final === "success" && typeof frame.durationUs === "number") this.successMicros.push(Math.max(0, Math.round(frame.durationUs)));
  }

  private onExecutorExit(): void {
    this.onEarlyExit?.();
    this.onEarlyExit = null;
    if (this.finishing || this.killed) return;
    this.fail("the executor exited", false);
  }

  // ---------------------------------------------------------------- lease

  private renew(): void {
    if (this.renewalsInFlight >= MAX_RENEWALS_IN_FLIGHT || this.finishing) return;
    this.renewalsInFlight += 1;
    const seq = ++this.renewSeq;
    const sentAtMs = this.clock.nowMs;
    this.lastRenewSentAt = sentAtMs;
    this.port
      .renewLease({ seq, sentAtMs })
      .then((answer) => this.onLease(seq, sentAtMs, answer))
      .catch(() => this.emit({ type: "renewal", seq, accepted: false, wallMs: Date.now() }))
      .finally(() => {
        this.renewalsInFlight -= 1;
      });
  }

  private onLease(seq: number, sentAtMs: number, answer: LeaseAnswer): void {
    this.clock.tick();
    const age = this.clock.nowMs - sentAtMs;
    const accepted =
      answer.seq === seq && seq > this.lastAcceptedSeq && answer.granted && age <= this.maxRenewalAgeMs && !this.leaseLostMarked;
    this.emit({ type: "renewal", seq, accepted, wallMs: Date.now() });
    if (answer.stop && answer.seq === seq && seq > this.lastAcceptedSeq) this.stop(answer.stop);
    if (!accepted) return;
    this.lastAcceptedSeq = seq;
    // From the request's send time, never the answer's arrival.
    this.leaseUntil = Math.max(this.leaseUntil, sentAtMs + this.budgets.leaseMs);
    if (this.clock.fenced) {
      if (this.clock.renewed(sentAtMs)) {
        this.fenceMarked = false;
        this.marker("resume_cleared");
      }
    }
  }

  // ---------------------------------------------------------------- stopping

  stop(mode: "graceful" | "now"): void {
    if (this.finishing) return;
    if (this.stopMode === "now" || this.stopMode === mode) return;
    if (this.stopMode === null) this.marker("stop_requested", mode);
    if (mode === "now") {
      this.stopMode = "now";
      this.status = "stopped";
      this.reason = "stop now";
      this.marker("starts_fenced");
      void this.finish(true);
      return;
    }
    if (this.stopMode === null) {
      this.stopMode = "graceful";
      this.status = "stopped";
      this.reason = "stopped";
      this.drainUntil = this.clock.nowMs + this.budgets.stopGraceMs;
      this.marker("starts_fenced");
    }
  }

  private fail(reason: string, kill: boolean): void {
    if (this.finishing) return;
    this.status = "failed";
    this.reason = reason;
    void this.finish(kill);
  }

  private kill(why: string): void {
    if (this.killed || !this.contained) return;
    this.killed = true;
    this.contained.kill();
    this.marker("executor_killed", why);
  }

  // ---------------------------------------------------------------- the loop

  private permitted(now: number): boolean {
    return !this.clock.fenced && now < this.leaseUntil && this.stopMode !== "now" && this.stopMode !== "lease" && !this.executorExited;
  }

  private canStart(now: number): boolean {
    return this.permitted(now) && this.stopMode === null;
  }

  private startTurn(user: number, phase: Phase, now: number): ActiveTurn {
    const gate = this.gate!;
    const deadlineIn = Math.max(0, Math.min(this.budgets[phase].turnDeadlineMs, gate.phaseEndMs - now));
    const id = `${phase === "checking" ? "c" : "m"}${++this.turnSeq}`;
    const turn: ActiveTurn = { id, user, phase, startAt: now, deadlineAt: now + deadlineIn, sends: 0 };
    this.turns.set(id, turn);
    this.busy.add(user);
    this.sendToExecutor({ t: "start", turn: id, user, deadlineInMs: deadlineIn });
    return turn;
  }

  private answerAsks(): void {
    if (this.pending.length === 0) return;
    const now = this.clock.nowMs;
    const still: PendingAsk[] = [];
    for (const ask of this.pending) {
      const deny = (reason: string) => {
        this.denied[reason] = (this.denied[reason] ?? 0) + 1;
        this.sendToExecutor({ t: "deny", req: ask.req, reason });
      };
      const turn = this.turns.get(ask.turn);
      if (!turn) {
        deny("turn_over");
        continue;
      }
      if (now >= turn.deadlineAt) {
        deny("turn_deadline");
        continue;
      }
      if (!this.permitted(now)) {
        // Fenced (resume fence, lease, stop now): wait while there is time, refuse after.
        if (this.clock.fenced && this.stopMode === null && now < this.leaseUntil) still.push(ask);
        else deny(this.clock.fenced ? "fenced" : "lease");
        continue;
      }
      if (this.stopMode === "graceful" && now >= this.drainUntil) {
        deny("stopped");
        continue;
      }
      const policy = checkRequest(
        { allowedOrigins: this.input.limits.allowedOrigins, allowedRequests: this.input.plan.allowedRequests },
        ask.method,
        ask.url,
      );
      if (!policy.ok) {
        deny(policy.reason);
        continue;
      }
      if (turn.sends >= this.input.plan.requests.perJourneyMax) {
        deny("per_journey");
        continue;
      }
      const gate = this.gate!;
      const answer = gate.permit(now - this.phaseStart, turn.startAt - this.phaseStart);
      if (answer.ok) {
        turn.sends += 1;
        const id = `${this.runId}.${turn.phase === "checking" ? "c" : "m"}.${answer.seq}`;
        this.issued.push(id);
        this.permitGates.set(id, gate);
        this.emit({ type: "permit", id, turn: turn.id, wallMs: Date.now() });
        this.sendToExecutor({ t: "permit", req: ask.req, id });
      } else if (answer.final) deny(answer.reason);
      else still.push(ask);
    }
    this.pending = still;
  }

  private tick(): void {
    if (this.finishing) return;
    const before = this.clock.fenced;
    const now = this.clock.tick();
    if (this.clock.fenced && (!before || !this.fenceMarked)) {
      this.fenceMarked = true;
      this.marker("resume_fence", this.clock.fenceReason ?? undefined);
    }

    // Renew every third of a lease, and at once after a fence (only a fresh one lifts it).
    if (now - this.lastRenewSentAt >= this.budgets.leaseMs / 3 || (this.clock.fenced && this.lastRenewSentAt < (this.clock.fencedAtMs ?? 0))) {
      this.renew();
    }

    // Lease lost: no start or permit from lastRenewal + leaseMs; drain, then the kill.
    if (this.phase !== "starting" && now >= this.leaseUntil && !this.leaseLostMarked && this.stopMode !== "now") {
      this.leaseLostMarked = true;
      this.stopMode = "lease";
      this.status = "lease_lost";
      this.reason = "the lease was not renewed";
      this.drainUntil = now + this.budgets.stopGraceMs;
      this.marker("lease_lost");
      this.marker("starts_fenced");
    }

    if (now - this.lastHeartbeat >= this.heartbeatMs) {
      this.lastHeartbeat = now;
      this.sendToExecutor({ t: "hb" });
    }

    if (this.phase === "starting") {
      if (now < this.leaseUntil) this.beginChecking(now);
      else if (now > this.budgets.leaseMs) this.failToStart("no lease");
      return;
    }

    // A turn far past its deadline: the executor is hung (a busy loop, a blocked call).
    for (const turn of this.turns.values()) {
      if (now > turn.deadlineAt + this.killGraceMs) {
        this.status = "failed";
        this.reason = "the executor stopped responding";
        void this.finish(true);
        return;
      }
    }

    this.answerAsks();
    if (this.phase === "checking") this.tickChecking(now);
    else if (this.phase === "measurement") this.tickMeasurement(now);
  }

  private beginChecking(now: number): void {
    const users = this.budgets.checking.users;
    this.phase = "checking";
    this.phaseStart = now;
    this.gate = new PhaseGate(this.budgets.checking, 0, this.budgets.absoluteEndMs);
    this.checkingResult.users = users;
    this.marker("phase_started", "checking");
    for (let user = 1; user <= users; user++) {
      const turn = this.startTurn(user, "checking", now);
      this.checkingAccounting.start(turn.id, 0, 0, turn.deadlineAt - now);
    }
  }

  private tickChecking(now: number): void {
    const elapsed = now - this.phaseStart;
    if (this.stopMode !== null) {
      if (this.turns.size === 0 || now >= this.drainUntil) {
        this.status = this.stopMode === "lease" ? "lease_lost" : "stopped";
        void this.finish(this.turns.size > 0);
      }
      return;
    }
    if (this.turns.size > 0) {
      if (elapsed >= this.budgets.checking.phaseDeadlineMs) {
        this.status = "didnt_start";
        this.reason = "checking timed out";
        void this.finish(true);
      }
      return;
    }
    if (this.checkingResult.success !== this.checkingResult.users) {
      this.status = "didnt_start";
      this.reason = "checking failed";
      void this.finish(false);
      return;
    }
    this.phase = "measurement";
    this.phaseStart = now;
    this.gate = new PhaseGate(this.budgets.measurement, 0, this.budgets.absoluteEndMs - now);
    this.marker("phase_started", "measurement");
    this.tickMeasurement(now);
  }

  private tickMeasurement(now: number): void {
    const planNow = now - this.phaseStart;
    const poll = this.scheduler.poll(planNow, (user) => this.busy.has(user));
    for (const order of poll.starts) {
      this.accounting.due(order.dueMs);
      if (this.canStart(now)) {
        const turn = this.startTurn(order.userId, "measurement", now);
        this.accounting.start(turn.id, planNow, order.stage, turn.deadlineAt - this.phaseStart);
        this.measured.started += 1;
      } else {
        this.accounting.missed(planNow);
        this.measured.missed += 1;
      }
    }
    for (const missed of poll.missed) {
      this.accounting.due(missed.dueMs);
      this.accounting.missed(missed.dueMs);
      this.measured.missed += 1;
    }
    this.accounting.expire(planNow);
    this.publish(planNow, false);

    const grace = this.budgets.stopGraceMs;
    if (this.stopMode !== null) {
      if (this.turns.size === 0 || now >= this.drainUntil) void this.finish(this.turns.size > 0);
      return;
    }
    if (this.scheduler.finished(planNow) && this.turns.size === 0) void this.finish(false);
    else if (planNow >= this.input.plan.durationMs + grace) {
      this.reason = "turns still running at the end of the grace";
      void this.finish(true);
    }
  }

  private publish(planNow: number, force: boolean): void {
    const intervals = this.accounting.closeIntervals(force ? Math.ceil((planNow + 1) / this.accounting.intervalMs) * this.accounting.intervalMs : planNow);
    for (const record of intervals) {
      this.intervalsPublished += 1;
      const published = { ...record, phase: "measurement" as const };
      try {
        appendFileSync(path.join(this.spoolDir, "intervals.jsonl"), JSON.stringify(published) + "\n", { mode: 0o600 });
      } catch {
        // the spool is a convenience; the port is the record
      }
      this.port.publishInterval(published).catch(() => undefined);
    }
    for (const cohort of this.accounting.sealCohorts(planNow, this.budgets.stopGraceMs, force)) {
      this.port.publishCohort({ ...cohort, phase: "measurement" }).catch(() => undefined);
    }
  }

  private failToStart(reason: string): void {
    this.status = "didnt_start";
    this.reason = reason;
    void this.finish(true);
  }

  // ---------------------------------------------------------------- the end

  private async finish(kill: boolean): Promise<void> {
    if (this.finishing) return;
    this.finishing = true;
    if (this.timer) clearInterval(this.timer);
    for (const ask of this.pending) this.sendToExecutor({ t: "deny", req: ask.req, reason: "stopped" });
    this.pending = [];
    if (kill) this.kill(this.reason ?? "stop");
    else if (this.contained && !this.executorExited) {
      this.sendToExecutor({ t: "exit" });
      await waitFor(() => this.executorExited, 3_000);
    }
    // Whatever happened, nothing the executor started outlives the run.
    this.kill("end of run");
    if (this.contained && !this.executorExited) await waitFor(() => this.executorExited, 5_000);
    this.contained?.dispose();
    this.marker("traffic_stopped");

    const now = this.clock.tick();
    if (this.phase === "measurement") {
      for (const id of this.accounting.unresolved()) {
        if (this.accounting.outcome(id, "interrupted", now - this.phaseStart)) this.measured.interrupted += 1;
      }
      this.publish(now - this.phaseStart, true);
    }
    this.phase = "done";
    const successTime = mergeHistograms([histogramOf(this.successMicros)]);
    const result: EngineResult = {
      status: this.status,
      reason: this.reason,
      runId: this.runId,
      containment: this.contained
        ? { level: this.contained.level, limitedBecause: this.contained.limitedBecause }
        : { level: "limited", limitedBecause: "not started" },
      isolation: this.isolation,
      playwright: this.playwrightVersion,
      checking: this.checkingResult,
      measurement: { ...this.measured, successTime, p95Micros: percentile(successTime, 0.95) },
      permits: { issued: this.issued.length, ids: this.issued, denied: this.denied },
      bypasses: { count: this.bypassCount, samples: this.bypasses },
      intervalsPublished: this.intervalsPublished,
      spoolDir: this.spoolDir,
    };
    await this.port.publishFinal(result).catch(() => undefined);
    if (this.ownsSpool) rmSync(this.spoolDir, { recursive: true, force: true });
    this.resolveDone(result);
  }
}

function waitFor(condition: () => boolean, timeoutMs: number): Promise<void> {
  return new Promise((resolve) => {
    const started = Date.now();
    const check = () => {
      if (condition() || Date.now() - started > timeoutMs) resolve();
      else setTimeout(check, 10);
    };
    check();
  });
}
