/**
 * The accounting contract (product spec §5.5): live interval counters and sealed start
 * cohorts, from the same events.
 *
 * - Intervals are fixed windows from the measured start (10 s by default). Every elapsed
 *   interval is published, an empty one too: a zero is a record, a missing interval is a gap
 *   (`intervalGaps`).
 * - Every start ends in exactly one outcome (success, failure, timeout, interrupted), or is
 *   unresolved when its cohort seals without one. A second outcome for a start is ignored.
 * - A deadline is the instant permission ends: an outcome at or after it is a timeout,
 *   counted live in the interval holding the deadline (or the oldest still-open interval, if
 *   that one was already published).
 * - Cohorts group starts by the interval and stage they actually began in, so a start at the
 *   end of a hold stays with the hold even when it finishes later. A cohort seals once every
 *   start is resolved, or its last deadline plus the delivery grace has passed.
 *
 * Requests (e4 plan v3 §2.3): each interval also carries the gate's request counts, as the
 * journal's deltas over it, with an explicit zero for every known denial and cut reason.
 * Times are the supervisor's clock only.
 *
 * Pure: no file system, network or Playwright.
 */
import type { JournalSnapshot } from "./gate/journal";

/** Every reason the gate or proxy refuses a request with before its debit. */
export const DENY_REASONS = [
  "stopped", "run_end", "lease", "turn_closed", "turn_deadline", "origin", "method", "total", "phase_total", "origin_total", "turn_total", "ceiling", "outstanding", "users", "rate",
  "credential", "form", "header", "host", "sni", "path", "not_allowed", "expect", "upgrade", "pipelined", "too_large", "memory", "dials", "tunnels", "setup_timeout",
] as const;
/** Every reason a debited exchange can end early with. */
export const CUT_REASONS = [
  "dial", "dial_timeout", "turn_closed", "stopped", "revoked", "pin", "lease", "rate", "run_end", "turn_deadline", "write", "upstream", "exchange_timeout", "response_too_large",
] as const;

export interface RequestCounts {
  debited: number;
  attempted: number;
  accepted: number;
  responded: number;
  received: number;
  denied: Record<string, number>;
  cut: Record<string, number>;
}

export function zeroCounts(): RequestCounts {
  return {
    debited: 0,
    attempted: 0,
    accepted: 0,
    responded: 0,
    received: 0,
    denied: Object.fromEntries(DENY_REASONS.map((r) => [r, 0])),
    cut: Object.fromEntries(CUT_REASONS.map((r) => [r, 0])),
  };
}

const COUNTERS = ["debited", "attempted", "accepted", "responded", "received"] as const;

/** What happened between two journal snapshots. The journal's counters only grow. */
export function requestDelta(prev: JournalSnapshot, next: JournalSnapshot): RequestCounts {
  const out = zeroCounts();
  for (const k of COUNTERS) {
    const d = next[k] - prev[k];
    if (d < 0) throw new Error(`accounting: ${k} ran back`);
    out[k] = d;
  }
  for (const kind of ["denied", "cut"] as const) {
    for (const [reason, n] of Object.entries(next[kind])) {
      const d = n - (prev[kind][reason] ?? 0);
      if (d < 0) throw new Error(`accounting: ${kind} ${reason} ran back`);
      out[kind][reason] = (out[kind][reason] ?? 0) + d;
    }
  }
  return out;
}

export function sumCounts(all: readonly RequestCounts[]): RequestCounts {
  const out = zeroCounts();
  for (const c of all) addCounts(out, c);
  return out;
}

function addCounts(into: RequestCounts, c: RequestCounts): void {
  for (const k of COUNTERS) into[k] += c[k];
  for (const kind of ["denied", "cut"] as const) for (const [r, n] of Object.entries(c[kind])) into[kind][r] = (into[kind][r] ?? 0) + n;
}

export type Outcome = "success" | "failure" | "timeout" | "interrupted";

export interface IntervalRecord {
  interval: number;
  fromMs: number;
  untilMs: number;
  due: number;
  started: number;
  missed: number;
  success: number;
  failure: number;
  timeout: number;
  interrupted: number;
  /** Starts still running at the interval's end, and how old the oldest was then. */
  inFlight: number;
  oldestInFlightMs: number | null;
  /** The gate's requests in this interval. */
  requests: RequestCounts;
}

export interface CohortRecord {
  interval: number;
  stage: number;
  starts: number;
  success: number;
  failure: number;
  timeout: number;
  interrupted: number;
  unresolved: number;
}

interface StartState {
  atMs: number;
  deadlineMs: number;
  interval: number;
  stage: number;
  outcome: Outcome | null;
  outcomeAtMs: number | null;
}

interface CohortState {
  interval: number;
  stage: number;
  starts: number;
  success: number;
  failure: number;
  timeout: number;
  interrupted: number;
  lastDeadlineMs: number;
}

type Counters = Omit<IntervalRecord, "interval" | "fromMs" | "untilMs" | "inFlight" | "oldestInFlightMs" | "requests">;

const emptyCounters = (): Counters => ({ due: 0, started: 0, missed: 0, success: 0, failure: 0, timeout: 0, interrupted: 0 });

/**
 * Kept incrementally: cohorts are aggregated as starts and outcomes arrive, and a start is let
 * go once it is settled (it has an outcome, every interval it ran in is published, and its
 * cohort is sealed), so a tick costs what is still in flight, not everything ever started.
 */
export class Accounting {
  private readonly starts = new Map<string, StartState>();
  private readonly counters = new Map<number, Counters>();
  private readonly requestCounts = new Map<number, RequestCounts>();
  private readonly cohorts = new Map<string, CohortState>();
  private readonly sealed = new Set<string>();
  private nextToClose = 0;
  /** Every outcome recorded, once each: the run's totals. */
  readonly totals: Record<Outcome, number> = { success: 0, failure: 0, timeout: 0, interrupted: 0 };

  constructor(readonly intervalMs = 10_000) {}

  intervalOf(atMs: number): number {
    return Math.floor(atMs / this.intervalMs);
  }

  private bump(atMs: number, key: keyof Counters): void {
    const interval = Math.max(this.intervalOf(atMs), this.nextToClose);
    const counters = this.counters.get(interval) ?? emptyCounters();
    counters[key] += 1;
    this.counters.set(interval, counters);
  }

  /** Requests counted at `atMs` (a journal delta), in the interval holding it or the oldest still open. */
  requests(atMs: number, delta: RequestCounts): void {
    const interval = Math.max(this.intervalOf(atMs), this.nextToClose);
    const counts = this.requestCounts.get(interval) ?? zeroCounts();
    addCounts(counts, delta);
    this.requestCounts.set(interval, counts);
  }

  due(atMs: number): void {
    this.bump(atMs, "due");
  }

  missed(atMs: number): void {
    this.bump(atMs, "missed");
  }

  start(id: string, atMs: number, stage: number, deadlineMs: number): void {
    if (this.starts.has(id)) throw new Error(`start ${id} recorded twice`);
    const interval = this.intervalOf(atMs);
    this.starts.set(id, { atMs, deadlineMs, interval, stage, outcome: null, outcomeAtMs: null });
    const key = `${interval}/${stage}`;
    if (!this.sealed.has(key)) {
      const cohort = this.cohorts.get(key) ?? { interval, stage, starts: 0, success: 0, failure: 0, timeout: 0, interrupted: 0, lastDeadlineMs: deadlineMs };
      cohort.starts += 1;
      cohort.lastDeadlineMs = Math.max(cohort.lastDeadlineMs, deadlineMs);
      this.cohorts.set(key, cohort);
    }
    this.bump(atMs, "started");
  }

  /** Records the start's one outcome; false when it had one already or is unknown. */
  outcome(id: string, kind: Outcome, atMs: number): boolean {
    return this.record(id, kind, atMs) !== null;
  }

  /** Records the start's one outcome and returns it as counted (late is a timeout); null when
   * it had one already or is unknown. */
  record(id: string, kind: Outcome, atMs: number): Outcome | null {
    const start = this.starts.get(id);
    if (!start || start.outcome) return null;
    const late = atMs >= start.deadlineMs;
    const final: Outcome = late && kind !== "interrupted" ? "timeout" : kind;
    start.outcome = final;
    start.outcomeAtMs = final === "timeout" ? start.deadlineMs : atMs;
    this.bump(start.outcomeAtMs, final);
    this.totals[final] += 1;
    const cohort = this.cohorts.get(`${start.interval}/${start.stage}`);
    if (cohort) cohort[final] += 1;
    return final;
  }

  /** Starts with no outcome whose deadline has passed: they are timeouts now. */
  expire(nowMs: number): string[] {
    const expired: string[] = [];
    for (const [id, start] of this.starts) {
      if (!start.outcome && nowMs >= start.deadlineMs) {
        this.record(id, "timeout", start.deadlineMs);
        expired.push(id);
      }
    }
    return expired;
  }

  /** Every interval that has fully elapsed by `nowMs` and was not published yet, in order. */
  closeIntervals(nowMs: number): IntervalRecord[] {
    const out: IntervalRecord[] = [];
    while ((this.nextToClose + 1) * this.intervalMs <= nowMs) out.push(this.close(this.nextToClose++));
    this.prune();
    return out;
  }

  private close(interval: number): IntervalRecord {
    const untilMs = (interval + 1) * this.intervalMs;
    let inFlight = 0;
    let oldest: number | null = null;
    for (const start of this.starts.values()) {
      if (start.atMs < untilMs && (start.outcomeAtMs === null || start.outcomeAtMs >= untilMs)) {
        inFlight += 1;
        oldest = Math.max(oldest ?? 0, untilMs - start.atMs);
      }
    }
    const counters = this.counters.get(interval) ?? emptyCounters();
    this.counters.delete(interval);
    const requests = this.requestCounts.get(interval) ?? zeroCounts();
    this.requestCounts.delete(interval);
    return { interval, fromMs: interval * this.intervalMs, untilMs, ...counters, inFlight, oldestInFlightMs: oldest, requests };
  }

  /** Cohorts that can seal by `nowMs`: every start resolved, or past its deadline plus grace. */
  sealCohorts(nowMs: number, graceMs: number, force = false): CohortRecord[] {
    const out: CohortRecord[] = [];
    for (const [key, c] of this.cohorts) {
      // A cohort's interval must be over before it can hold every start it will ever hold.
      const intervalOver = (c.interval + 1) * this.intervalMs <= nowMs;
      const settled = c.success + c.failure + c.timeout + c.interrupted;
      const resolved = settled === c.starts;
      if (!force && !(intervalOver && (resolved || nowMs >= c.lastDeadlineMs + graceMs))) continue;
      this.sealed.add(key);
      this.cohorts.delete(key);
      out.push({
        interval: c.interval,
        stage: c.stage,
        starts: c.starts,
        success: c.success,
        failure: c.failure,
        timeout: c.timeout,
        interrupted: c.interrupted,
        unresolved: c.starts - settled,
      });
    }
    this.prune();
    return out.sort((a, b) => a.interval - b.interval || a.stage - b.stage);
  }

  /** Lets go of starts no published record can still need. */
  private prune(): void {
    const publishedUntil = this.nextToClose * this.intervalMs;
    for (const [id, s] of this.starts) {
      if (s.outcomeAtMs !== null && s.outcomeAtMs < publishedUntil && this.sealed.has(`${s.interval}/${s.stage}`)) this.starts.delete(id);
    }
  }

  /** How many starts are still held (in flight, or not yet published and sealed). */
  retained(): number {
    return this.starts.size;
  }

  /** Starts with no outcome yet. */
  unresolved(): string[] {
    return [...this.starts].filter(([, s]) => !s.outcome).map(([id]) => id);
  }
}

/** Interval numbers missing from a published sequence that should run 0..last. */
export function intervalGaps(records: readonly Pick<IntervalRecord, "interval">[], expectedCount: number): number[] {
  const seen = new Set(records.map((r) => r.interval));
  const gaps: number[] = [];
  for (let i = 0; i < expectedCount; i++) if (!seen.has(i)) gaps.push(i);
  return gaps;
}
