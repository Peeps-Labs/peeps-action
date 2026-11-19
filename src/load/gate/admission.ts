/**
 * The gate's decision (plan v3 §5): whether one prepared request may be handed to its
 * upstream socket now. Every limit is checked here, in one synchronous call, on clocks the
 * caller passes in: the lease on both clocks, the absolute ceiling (debited plus
 * unresolved), the run total, the run end, the turn and its deadline, the origin and
 * method, outstanding exchanges per turn, and the rate bucket.
 *
 * A request that `admit` lets through is unresolved until `resolve` says whether its bytes
 * left; until then it counts against the ceiling and the total as if it had.
 *
 * Pure: no clock, no timer, no I/O.
 */

export interface Clocks {
  /** A monotonic clock, in ms (`performance.now()`). */
  monoMs: number;
  /** The wall clock, in ms since the epoch (`Date.now()`). */
  wallMs: number;
}

export interface GateLimits {
  /** Canonical origins (`https://host:port`) the plan may reach. */
  origins: readonly string[];
  /** Upper-case methods the plan may send. */
  methods: readonly string[];
  /** Live turns at once: the plan's users. */
  maxUsers: number;
  /** Requests in flight per turn. */
  maxOutstandingPerTurn: number;
  ratePerSecond: number;
  burst: number;
  /** Requests for the whole run, Checking included. */
  runTotal: number;
  /** How long one turn may send, from when it opened. */
  turnDeadlineMs: number;
  /** The run's absolute end, on the monotonic clock. */
  runEndMono: number;
}

export interface LeaseGrant {
  monoUntil: number;
  wallUntil: number;
  /** Absolute: debited plus unresolved may never exceed it. */
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
  | "ceiling"
  | "outstanding"
  | "rate";

export type Admit =
  | { ok: true; seq: number }
  /** `final`: waiting cannot change the answer for this turn. `retryInMs` only for `rate`. */
  | { ok: false; reason: DenyReason; final: boolean; retryInMs?: number };

export type OpenTurn = { ok: true; turn: number } | { ok: false; reason: "stopped" | "run_end" | "users" };

const MILLI = 1000;

interface Turn {
  openedMono: number;
  outstanding: number;
  open: boolean;
}

export class Gate {
  private lease: LeaseGrant = { monoUntil: Number.NEGATIVE_INFINITY, wallUntil: Number.NEGATIVE_INFINITY, ceiling: 0 };
  private readonly turns = new Map<number, Turn>();
  private readonly pending = new Map<number, number>();
  private nextTurn = 1;
  private seq = 0;
  private liveTurns = 0;
  private debitedCount = 0;
  private stoppedFlag = false;
  private milliTokens: number;
  private lastRefillMono: number | undefined;
  private readonly origins: ReadonlySet<string>;
  private readonly methods: ReadonlySet<string>;

  constructor(private readonly limits: GateLimits) {
    for (const [name, value] of Object.entries(limits)) {
      if (typeof value === "number" && !(value >= 0)) throw new Error(`gate: ${name} must be a number ≥ 0`);
    }
    if (limits.ratePerSecond <= 0 || limits.burst < 1) throw new Error("gate: rate and burst must be positive");
    this.milliTokens = limits.burst * MILLI;
    this.origins = new Set(limits.origins);
    this.methods = new Set(limits.methods);
  }

  /** Requests whose bytes left. */
  get debited(): number {
    return this.debitedCount;
  }

  /** Requests admitted whose delivery is not yet known. */
  get unresolved(): number {
    return this.pending.size;
  }

  get stopped(): boolean {
    return this.stoppedFlag;
  }

  /** Replaces the lease. A lower ceiling or earlier deadline takes effect at once. */
  applyLease(lease: LeaseGrant): void {
    this.lease = { ...lease };
  }

  /** Lost contact or a lost lease: nothing more is admitted until a new lease applies. */
  revokeLease(): void {
    this.lease = { monoUntil: Number.NEGATIVE_INFINITY, wallUntil: Number.NEGATIVE_INFINITY, ceiling: this.lease.ceiling };
  }

  /** Irreversible: a hard stop, the run's end, or `close()`. */
  stop(): void {
    this.stoppedFlag = true;
    for (const turn of this.turns.values()) turn.open = false;
  }

  openTurn(t: Clocks): OpenTurn {
    if (this.stoppedFlag) return { ok: false, reason: "stopped" };
    if (t.monoMs >= this.limits.runEndMono) return { ok: false, reason: "run_end" };
    if (this.liveTurns >= this.limits.maxUsers) return { ok: false, reason: "users" };
    const turn = this.nextTurn++;
    this.turns.set(turn, { openedMono: t.monoMs, outstanding: 0, open: true });
    this.liveTurns += 1;
    return { ok: true, turn };
  }

  /** Revokes the turn: nothing more of it is admitted. Its unresolved requests stay counted until resolved. */
  closeTurn(turn: number): void {
    const state = this.turns.get(turn);
    if (!state) return;
    if (state.open) this.liveTurns -= 1;
    state.open = false;
    if (state.outstanding === 0) this.turns.delete(turn);
  }

  admit(r: PreparedRequest, t: Clocks): Admit {
    if (this.stoppedFlag) return deny("stopped", true);
    if (t.monoMs >= this.limits.runEndMono) return deny("run_end", true);
    if (!(t.monoMs < this.lease.monoUntil && t.wallMs < this.lease.wallUntil)) return deny("lease", false);
    const turn = this.turns.get(r.turn);
    if (!turn?.open) return deny("turn_closed", true);
    if (t.monoMs >= turn.openedMono + this.limits.turnDeadlineMs) return deny("turn_deadline", true);
    if (!this.origins.has(r.origin)) return deny("origin", true);
    if (!this.methods.has(r.method)) return deny("method", true);
    const counted = this.debitedCount + this.pending.size;
    if (counted >= this.limits.runTotal) return deny("total", true);
    if (counted >= this.lease.ceiling) return deny("ceiling", false);
    if (turn.outstanding >= this.limits.maxOutstandingPerTurn) return deny("outstanding", false);
    this.refill(t.monoMs);
    if (this.milliTokens < MILLI) {
      const retryInMs = Math.ceil((MILLI - this.milliTokens) / this.limits.ratePerSecond);
      return { ok: false, reason: "rate", final: false, retryInMs };
    }
    this.milliTokens -= MILLI;
    const seq = ++this.seq;
    this.pending.set(seq, r.turn);
    turn.outstanding += 1;
    return { ok: true, seq };
  }

  /**
   * What became of an admitted request. `sent: false` only when no byte of it was written
   * (the write threw before taking any); anything else, including an uncertain write, is
   * debited. Unknown or repeated seqs are ignored.
   */
  resolve(seq: number, sent: boolean): void {
    const turnId = this.pending.get(seq);
    if (turnId === undefined) return;
    this.pending.delete(seq);
    if (sent) this.debitedCount += 1;
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
    if (monoMs <= this.lastRefillMono) return;
    const added = (monoMs - this.lastRefillMono) * this.limits.ratePerSecond;
    this.milliTokens = Math.min(this.limits.burst * MILLI, this.milliTokens + added);
    this.lastRefillMono = monoMs;
  }
}

function deny(reason: DenyReason, final: boolean): Admit {
  return { ok: false, reason, final };
}
