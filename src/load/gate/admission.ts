/**
 * The gate's decision (plan v3 §5): whether one prepared request may be handed to its
 * upstream socket now. Every limit is checked here, in one synchronous call, on clocks the
 * caller passes in: the lease on both clocks, the absolute ceiling, the run, phase and
 * per-origin totals, the run end, the turn and its deadline, the origin and method,
 * outstanding exchanges per turn, and the phase's rate bucket.
 *
 * Counting. Every admitted request counts against the ceiling and the totals for good,
 * whatever becomes of it, so `admitted` only grows and is what renewals report as debited.
 * `resolve` records whether its bytes left (for the journal's unresolved count); `finish`
 * records that its exchange is over (for the per-turn cap). The two are separate events.
 *
 * Every limit check fails closed: a missing or non-numeric limit denies.
 *
 * Pure: no clock, no timer, no I/O.
 */

export interface Clocks {
  /** A monotonic clock, in ms (`performance.now()`). */
  monoMs: number;
  /** The wall clock, in ms since the epoch (`Date.now()`). */
  wallMs: number;
}

/** What may change between phases (Checking, ramp, steady). */
export interface PhaseCaps {
  ratePerSecond: number;
  burst: number;
  /** Live turns at once. */
  maxUsers: number;
  /** Requests admitted in this phase. */
  total: number;
}

export interface GateLimits {
  /** Canonical origins (`https://host:port`), each with its request total for the run. */
  origins: Readonly<Record<string, number>>;
  /** Upper-case methods the plan may send. */
  methods: readonly string[];
  /** Requests in flight per turn. */
  maxOutstandingPerTurn: number;
  /** Requests for the whole run, every phase included. */
  runTotal: number;
  /** How long one turn may send, from when it opened. */
  turnDeadlineMs: number;
  /** The run's absolute end, on the monotonic clock. */
  runEndMono: number;
  /** The first phase. */
  phase: PhaseCaps;
}

export interface LeaseGrant {
  /** Grants apply in order: one at or below the last applied seq is ignored. */
  seq: number;
  monoUntil: number;
  wallUntil: number;
  /** Absolute: requests admitted may never exceed it. */
  ceiling: number;
}

export interface PreparedRequest {
  turn: number;
  /** Canonical origin of the tunnel the request arrived on. */
  origin: string;
  /** The serialized method, as it will be written. */
  method: string;
}

export type DenyReason =
  | "stopped"
  | "run_end"
  | "lease"
  | "turn_closed"
  | "turn_deadline"
  | "origin"
  | "method"
  | "total"
  | "phase_total"
  | "origin_total"
  | "ceiling"
  | "outstanding"
  | "rate";

export type Admit =
  | { ok: true; seq: number }
  /** `final`: waiting cannot change the answer for this turn. `retryInMs` only for `rate`. */
  | { ok: false; reason: DenyReason; final: boolean; retryInMs?: number };

export type OpenTurn = { ok: true; turn: number } | { ok: false; reason: "stopped" | "draining" | "run_end" | "users" | "slot_busy" };

const MILLI = 1000;

interface Turn {
  openedMono: number;
  outstanding: number;
  open: boolean;
}

export class Gate {
  private lease: LeaseGrant = { seq: -1, monoUntil: Number.NEGATIVE_INFINITY, wallUntil: Number.NEGATIVE_INFINITY, ceiling: 0 };
  private lastLeaseSeq = -1;
  private readonly liveSlots = new Map<number, string>();
  private readonly turns = new Map<number, Turn>();
  /** Admitted, delivery not yet known. */
  private readonly undelivered = new Set<number>();
  /** Admitted, exchange not yet over: seq → turn. */
  private readonly exchanges = new Map<number, number>();
  private readonly perOrigin = new Map<string, number>();
  private nextTurn = 1;
  private seq = 0;
  private liveTurns = 0;
  private sentCount = 0;
  private phaseCount = 0;
  private stoppedFlag = false;
  private drainingFlag = false;
  private phase: PhaseCaps;
  private milliTokens: number;
  private lastRefillMono: number | undefined;
  private readonly methods: ReadonlySet<string>;

  constructor(private readonly limits: GateLimits) {
    for (const [name, value] of [["maxOutstandingPerTurn", limits.maxOutstandingPerTurn], ["runTotal", limits.runTotal], ...Object.entries(limits.origins)] as const) {
      if (!Number.isSafeInteger(value) || value < 0) throw new Error(`gate: ${name} must be a whole number ≥ 0`);
    }
    for (const [name, value] of [["turnDeadlineMs", limits.turnDeadlineMs], ["runEndMono", limits.runEndMono]] as const) {
      if (!Number.isFinite(value) || value < 0) throw new Error(`gate: ${name} must be a finite number ≥ 0`);
    }
    checkPhase(limits.phase);
    this.phase = { ...limits.phase };
    this.milliTokens = this.phase.burst * MILLI;
    this.methods = new Set(limits.methods);
  }

  /** Requests admitted: what counts against the ceiling and totals, and what renewals report. Only grows. */
  get admitted(): number {
    return this.seq;
  }

  /** Admitted requests known to have sent bytes. */
  get sent(): number {
    return this.sentCount;
  }

  /** Admitted requests whose delivery is not yet known. */
  get unresolved(): number {
    return this.undelivered.size;
  }

  /** Admitted requests whose exchange is not over. */
  get inFlight(): number {
    return this.exchanges.size;
  }

  get stopped(): boolean {
    return this.stoppedFlag;
  }

  /**
   * Replaces the lease with a newer one. A lower ceiling or an earlier deadline takes effect
   * at once. A grant at or below the last applied seq is ignored, even after a revoke; a
   * malformed one revokes.
   */
  applyLease(lease: LeaseGrant): void {
    if (!(lease.seq > this.lastLeaseSeq)) return;
    this.lastLeaseSeq = lease.seq;
    if (!Number.isSafeInteger(lease.ceiling) || lease.ceiling < 0 || Number.isNaN(lease.monoUntil) || Number.isNaN(lease.wallUntil)) return this.revokeLease();
    this.lease = { ...lease };
  }

  /** Lost contact, a lost lease, or one seen expired: nothing more is admitted until a newer lease applies. */
  revokeLease(): void {
    this.lease = { ...this.lease, monoUntil: Number.NEGATIVE_INFINITY, wallUntil: Number.NEGATIVE_INFINITY };
  }

  /**
   * Moves to the next phase. The bucket is refilled at the old rate up to `t`, then clamped
   * to the new burst, so a phase change never adds tokens.
   */
  setPhase(caps: PhaseCaps, t: Clocks): void {
    checkPhase(caps);
    this.refill(t.monoMs);
    this.phase = { ...caps };
    this.milliTokens = Math.min(this.milliTokens, caps.burst * MILLI);
    this.phaseCount = 0;
  }

  /** Draining: existing turns go on, no new turn opens. */
  drain(): void {
    this.drainingFlag = true;
  }

  /** Irreversible: a hard stop, the run's end, or `close()`. */
  stop(): void {
    this.stoppedFlag = true;
    for (const turn of this.turns.values()) turn.open = false;
    this.liveSlots.clear();
    this.liveTurns = 0;
  }

  /** Opens a turn for `slot` (one simulated user). A slot has at most one live turn. */
  openTurn(slot: string, t: Clocks): OpenTurn {
    if (this.stoppedFlag) return { ok: false, reason: "stopped" };
    if (this.drainingFlag) return { ok: false, reason: "draining" };
    if (!(t.monoMs < this.limits.runEndMono)) return { ok: false, reason: "run_end" };
    if ([...this.liveSlots.values()].includes(slot)) return { ok: false, reason: "slot_busy" };
    if (!(this.liveTurns < this.phase.maxUsers)) return { ok: false, reason: "users" };
    const turn = this.nextTurn++;
    this.liveSlots.set(turn, slot);
    this.turns.set(turn, { openedMono: t.monoMs, outstanding: 0, open: true });
    this.liveTurns += 1;
    return { ok: true, turn };
  }

  /** Revokes the turn: nothing more of it is admitted, and its user slot frees. Its exchanges finish on their own. */
  closeTurn(turn: number): void {
    const state = this.turns.get(turn);
    if (!state) return;
    if (state.open) this.liveTurns -= 1;
    state.open = false;
    this.liveSlots.delete(turn);
    if (state.outstanding === 0) this.turns.delete(turn);
  }

  admit(r: PreparedRequest, t: Clocks): Admit {
    if (this.stoppedFlag) return deny("stopped", true);
    if (!(t.monoMs < this.limits.runEndMono)) return deny("run_end", true);
    if (!(t.monoMs < this.lease.monoUntil && t.wallMs < this.lease.wallUntil)) {
      // Seen expired on either clock: a clock stepping back later must not revive it.
      this.revokeLease();
      return deny("lease", false);
    }
    const turn = this.turns.get(r.turn);
    if (!turn?.open) return deny("turn_closed", true);
    if (!(t.monoMs < turn.openedMono + this.limits.turnDeadlineMs)) return deny("turn_deadline", true);
    const originTotal = Object.hasOwn(this.limits.origins, r.origin) ? this.limits.origins[r.origin] : undefined;
    if (originTotal === undefined) return deny("origin", true);
    if (!this.methods.has(r.method)) return deny("method", true);
    if (!(this.seq < this.limits.runTotal)) return deny("total", true);
    if (!(this.phaseCount < this.phase.total)) return deny("phase_total", true);
    if (!((this.perOrigin.get(r.origin) ?? 0) < originTotal)) return deny("origin_total", true);
    if (!(this.seq < this.lease.ceiling)) return deny("ceiling", false);
    if (!(turn.outstanding < this.limits.maxOutstandingPerTurn)) return deny("outstanding", false);
    this.refill(t.monoMs);
    if (this.milliTokens < MILLI) {
      const retryInMs = Math.ceil((MILLI - this.milliTokens) / this.phase.ratePerSecond);
      return { ok: false, reason: "rate", final: false, retryInMs };
    }
    this.milliTokens -= MILLI;
    const seq = ++this.seq;
    this.phaseCount += 1;
    this.perOrigin.set(r.origin, (this.perOrigin.get(r.origin) ?? 0) + 1);
    this.undelivered.add(seq);
    this.exchanges.set(seq, r.turn);
    turn.outstanding += 1;
    return { ok: true, seq };
  }

  /**
   * Whether an admitted request's bytes left: `false` only when the write took none. Either
   * way it stays admitted. A request that never sent also has no exchange, so it finishes too.
   * Unknown or repeated seqs are ignored.
   */
  resolve(seq: number, sent: boolean): void {
    if (!this.undelivered.delete(seq)) return;
    if (sent) this.sentCount += 1;
    else this.finish(seq);
  }

  /** The request's exchange is over (answered, failed or abandoned): its turn may send another. */
  finish(seq: number): void {
    const turnId = this.exchanges.get(seq);
    if (turnId === undefined) return;
    this.exchanges.delete(seq);
    const turn = this.turns.get(turnId);
    if (!turn) return;
    turn.outstanding -= 1;
    if (!turn.open && turn.outstanding === 0) this.turns.delete(turnId);
  }

  /** The bucket never holds more than `burst`, whatever the gap; a clock that runs back adds nothing. */
  private refill(monoMs: number): void {
    if (this.lastRefillMono === undefined) {
      this.lastRefillMono = monoMs;
      return;
    }
    if (!(monoMs > this.lastRefillMono)) return;
    const added = (monoMs - this.lastRefillMono) * this.phase.ratePerSecond;
    this.milliTokens = Math.min(this.phase.burst * MILLI, this.milliTokens + added);
    this.lastRefillMono = monoMs;
  }
}

function checkPhase(caps: PhaseCaps): void {
  if (!(caps.ratePerSecond > 0 && Number.isFinite(caps.ratePerSecond))) throw new Error("gate: ratePerSecond must be positive");
  for (const [name, value] of Object.entries(caps)) {
    if (!Number.isSafeInteger(value) && name !== "ratePerSecond") throw new Error(`gate: ${name} must be an integer`);
  }
  if (caps.burst < 1 || caps.maxUsers < 0 || caps.total < 0) throw new Error("gate: burst ≥ 1, maxUsers and total ≥ 0");
}

function deny(reason: DenyReason, final: boolean): Admit {
  return { ok: false, reason, final };
}
