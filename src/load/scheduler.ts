/**
 * The closed-cohort scheduler (product spec §5.3), on an injected clock.
 *
 * The schedule is peeps' (`protocol/domain/schedule.ts`), restated here so the action can
 * check a plan's planned starts and then run it: users are numbered from 1; a ramp up of n
 * users activates user a+j at `start + floor(j·D/n)`; a ramp down retires the
 * highest-numbered user first, user a−j+1 at `start + D − floor((n−j+1)·D/n)`; each active
 * span (an epoch) has due ticks every `pacingEveryMs` from its activation, none at or after
 * its retirement.
 *
 * Running it (`Scheduler.poll`):
 * - a missed tick is never repaid: only the latest due tick of a user can start, every
 *   earlier one is recorded as missed;
 * - a start counts in the stage it actually began;
 * - a late start never crosses a stage boundary: a tick due in one stage cannot start in
 *   the next (recorded as missed, `boundary`);
 * - a busy user (its previous turn still running) misses the tick (closed model);
 * - retired users start nothing.
 *
 * Pure: no file system, network or Playwright.
 */

export interface ScheduleStage {
  name?: string;
  kind?: string;
  durationMs: number;
  fromUsers: number;
  toUsers: number;
}

export interface ScheduleInput {
  pacingEveryMs: number;
  stages: readonly ScheduleStage[];
}

/** One user's continuous active span: ticks at activeFromMs + k·pacing, before activeUntilMs. */
export interface UserEpoch {
  userId: number;
  activeFromMs: number;
  activeUntilMs: number;
}

const ceilDiv = (a: number, b: number) => Math.ceil(a / b);

/** Every user's active spans across the whole plan, in stable order (activation, then user). */
export function userEpochs(input: ScheduleInput): UserEpoch[] {
  const closed: UserEpoch[] = [];
  const active: number[] = [];
  let stageStart = 0;
  const retire = (at: number) => {
    const userId = active.length;
    const activeFromMs = active.pop();
    if (activeFromMs !== undefined) closed.push({ userId, activeFromMs, activeUntilMs: at });
  };
  const settleAt = (users: number, at: number) => {
    while (active.length < users) active.push(at);
    while (active.length > users) retire(at);
  };
  for (const stage of input.stages) {
    const duration = stage.durationMs;
    settleAt(stage.fromUsers, stageStart);
    const n = Math.abs(stage.toUsers - stage.fromUsers);
    if (stage.toUsers > stage.fromUsers) {
      for (let j = 1; j <= n; j++) active.push(stageStart + Math.floor((j * duration) / n));
    } else if (stage.toUsers < stage.fromUsers) {
      for (let j = 1; j <= n; j++) retire(stageStart + duration - Math.floor(((n - j + 1) * duration) / n));
    }
    stageStart += duration;
  }
  settleAt(0, stageStart);
  return closed.sort((a, b) => a.activeFromMs - b.activeFromMs || a.userId - b.userId);
}

/** Due ticks of one epoch in [fromMs, untilMs). */
export function ticksInWindow(epoch: UserEpoch, pacingEveryMs: number, fromMs: number, untilMs: number): number {
  const lo = Math.max(fromMs, epoch.activeFromMs);
  const hi = Math.min(untilMs, epoch.activeUntilMs);
  if (hi <= lo) return 0;
  return ceilDiv(hi - epoch.activeFromMs, pacingEveryMs) - ceilDiv(lo - epoch.activeFromMs, pacingEveryMs);
}

/** Planned starts per stage, in closed form (nothing is expanded). */
export function scheduleStageStarts(input: ScheduleInput): number[] {
  const epochs = userEpochs(input);
  const out: number[] = [];
  let startMs = 0;
  for (const stage of input.stages) {
    const untilMs = startMs + stage.durationMs;
    let starts = 0;
    for (const epoch of epochs) starts += ticksInWindow(epoch, input.pacingEveryMs, startMs, untilMs);
    out.push(starts);
    startMs = untilMs;
  }
  return out;
}

export type MissReason = "late" | "busy" | "boundary";

export interface StartOrder {
  userId: number;
  /** The tick's due time, on the plan's clock (0 = the measured start). */
  dueMs: number;
  /** The stage the start counts in: where it actually began. */
  stage: number;
}

export interface MissedTurn {
  userId: number;
  dueMs: number;
  /** The stage the tick was due in. */
  stage: number;
  reason: MissReason;
}

export interface Poll {
  starts: StartOrder[];
  missed: MissedTurn[];
}

/** The stage holding `atMs`, or -1 past the plan's end. */
export function stageAt(stageEnds: readonly number[], atMs: number): number {
  for (let i = 0; i < stageEnds.length; i++) if (atMs < stageEnds[i]!) return i;
  return -1;
}

/** Runs the schedule against a clock it is handed: the caller says when it is, and who is busy. */
export class Scheduler {
  private readonly epochs: UserEpoch[];
  /** Per epoch: the next tick index not yet decided. */
  private readonly next: number[];
  readonly stageEnds: number[];
  readonly endMs: number;

  constructor(
    private readonly input: ScheduleInput,
    /** How late after its due time a tick may still start. */
    private readonly startSlackMs: number,
  ) {
    this.epochs = userEpochs(input);
    this.next = this.epochs.map(() => 0);
    let end = 0;
    this.stageEnds = input.stages.map((stage) => (end += stage.durationMs));
    this.endMs = end;
  }

  /** Every tick due at or before `nowMs` that has not been decided: started, or missed. */
  poll(nowMs: number, isBusy: (userId: number) => boolean): Poll {
    const starts: StartOrder[] = [];
    const missed: MissedTurn[] = [];
    const pacing = this.input.pacingEveryMs;
    const nowStage = stageAt(this.stageEnds, nowMs);
    this.epochs.forEach((epoch, i) => {
      if (nowMs < epoch.activeFromMs) return;
      const lastDueAt = Math.min(nowMs, epoch.activeUntilMs - 1);
      if (lastDueAt < epoch.activeFromMs) return;
      const latest = Math.floor((lastDueAt - epoch.activeFromMs) / pacing);
      for (let k = this.next[i]!; k <= latest; k++) {
        const dueMs = epoch.activeFromMs + k * pacing;
        const dueStage = stageAt(this.stageEnds, dueMs);
        if (k < latest) {
          // Never repaid: a later tick has already come due.
          missed.push({ userId: epoch.userId, dueMs, stage: dueStage, reason: "late" });
          continue;
        }
        if (nowMs - dueMs > this.startSlackMs) missed.push({ userId: epoch.userId, dueMs, stage: dueStage, reason: "late" });
        else if (dueStage !== nowStage) missed.push({ userId: epoch.userId, dueMs, stage: dueStage, reason: "boundary" });
        else if (isBusy(epoch.userId)) missed.push({ userId: epoch.userId, dueMs, stage: dueStage, reason: "busy" });
        else starts.push({ userId: epoch.userId, dueMs, stage: nowStage });
      }
      this.next[i] = Math.max(this.next[i]!, latest + 1);
    });
    const order = (a: { dueMs: number; userId: number }, b: { dueMs: number; userId: number }) =>
      a.dueMs - b.dueMs || a.userId - b.userId;
    return { starts: starts.sort(order), missed: missed.sort(order) };
  }

  /** Whether every tick has been decided. */
  finished(nowMs: number): boolean {
    return nowMs >= this.endMs;
  }

  /** When the next undecided tick is due, or null when none is left. */
  nextDueMs(): number | null {
    let best: number | null = null;
    this.epochs.forEach((epoch, i) => {
      const dueMs = epoch.activeFromMs + this.next[i]! * this.input.pacingEveryMs;
      if (dueMs < epoch.activeUntilMs && (best === null || dueMs < best)) best = dueMs;
    });
    return best;
  }
}
