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
 * Pure: no file system, network or Playwright.
 */

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

type Counters = Omit<IntervalRecord, "interval" | "fromMs" | "untilMs" | "inFlight" | "oldestInFlightMs">;

const emptyCounters = (): Counters => ({ due: 0, started: 0, missed: 0, success: 0, failure: 0, timeout: 0, interrupted: 0 });

export class Accounting {
  private readonly starts = new Map<string, StartState>();
  private readonly counters = new Map<number, Counters>();
  private readonly sealed = new Set<string>();
  private nextToClose = 0;

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

  due(atMs: number): void {
    this.bump(atMs, "due");
  }

  missed(atMs: number): void {
    this.bump(atMs, "missed");
  }

  start(id: string, atMs: number, stage: number, deadlineMs: number): void {
    if (this.starts.has(id)) throw new Error(`start ${id} recorded twice`);
    this.starts.set(id, { atMs, deadlineMs, interval: this.intervalOf(atMs), stage, outcome: null, outcomeAtMs: null });
    this.bump(atMs, "started");
  }

  /** Records the start's one outcome; false when it had one already or is unknown. */
  outcome(id: string, kind: Outcome, atMs: number): boolean {
    const start = this.starts.get(id);
    if (!start || start.outcome) return false;
    const late = atMs >= start.deadlineMs;
    const final: Outcome = late && kind !== "interrupted" ? "timeout" : kind;
    start.outcome = final;
    start.outcomeAtMs = final === "timeout" ? start.deadlineMs : atMs;
    this.bump(start.outcomeAtMs, final);
    return true;
  }

  /** Starts with no outcome whose deadline has passed: they are timeouts now. */
  expire(nowMs: number): string[] {
    const expired: string[] = [];
    for (const [id, start] of this.starts) {
      if (!start.outcome && nowMs >= start.deadlineMs) {
        this.outcome(id, "timeout", start.deadlineMs);
        expired.push(id);
      }
    }
    return expired;
  }

  /** Every interval that has fully elapsed by `nowMs` and was not published yet, in order. */
  closeIntervals(nowMs: number): IntervalRecord[] {
    const out: IntervalRecord[] = [];
    while ((this.nextToClose + 1) * this.intervalMs <= nowMs) out.push(this.close(this.nextToClose++));
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
    return { interval, fromMs: interval * this.intervalMs, untilMs, ...counters, inFlight, oldestInFlightMs: oldest };
  }

  /** Cohorts that can seal by `nowMs`: every start resolved, or past its deadline plus grace. */
  sealCohorts(nowMs: number, graceMs: number, force = false): CohortRecord[] {
    const groups = new Map<string, StartState[]>();
    for (const start of this.starts.values()) {
      const key = `${start.interval}/${start.stage}`;
      if (this.sealed.has(key)) continue;
      groups.set(key, [...(groups.get(key) ?? []), start]);
    }
    const out: CohortRecord[] = [];
    for (const [key, starts] of groups) {
      // A cohort's interval must be over before it can hold every start it will ever hold.
      const intervalOver = (starts[0]!.interval + 1) * this.intervalMs <= nowMs;
      const resolved = starts.every((s) => s.outcome);
      const lastDeadline = Math.max(...starts.map((s) => s.deadlineMs));
      if (!force && !(intervalOver && (resolved || nowMs >= lastDeadline + graceMs))) continue;
      this.sealed.add(key);
      const count = (o: Outcome) => starts.filter((s) => s.outcome === o).length;
      out.push({
        interval: starts[0]!.interval,
        stage: starts[0]!.stage,
        starts: starts.length,
        success: count("success"),
        failure: count("failure"),
        timeout: count("timeout"),
        interrupted: count("interrupted"),
        unresolved: starts.filter((s) => !s.outcome).length,
      });
    }
    return out.sort((a, b) => a.interval - b.interval || a.stage - b.stage);
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
