/**
 * The scheduler on a fake clock (§5.3): the closed form against a brute-force expansion,
 * missed ticks never repaid, a start counted where it began, no late start across a stage
 * boundary, users retired in stable order, and slow or failed work.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";

import { Scheduler, scheduleStageStarts, stageAt, userEpochs, type ScheduleInput } from "../src/load/scheduler";

const plan = JSON.parse(readFileSync(path.resolve(__dirname, "fixtures/load-engine/plan.json"), "utf8")) as {
  cohort: ScheduleInput;
};

/** Every tick, by brute force: the oracle the closed form must equal. */
function expand(input: ScheduleInput): number[] {
  const ends: number[] = [];
  let end = 0;
  for (const stage of input.stages) ends.push((end += stage.durationMs));
  const counts = input.stages.map(() => 0);
  for (const epoch of userEpochs(input)) {
    for (let t = epoch.activeFromMs; t < epoch.activeUntilMs; t += input.pacingEveryMs) counts[stageAt(ends, t)]! += 1;
  }
  return counts;
}

/** Runs the scheduler on a fake clock with work that takes `workMs(userId, n)`. */
function simulate(input: ScheduleInput, stepMs: number, workMs: (userId: number, n: number) => number, slackMs = 1000) {
  const scheduler = new Scheduler(input, slackMs);
  const busyUntil = new Map<number, number>();
  const turns = new Map<number, number>();
  const starts: { userId: number; dueMs: number; atMs: number; stage: number }[] = [];
  const missed: { userId: number; dueMs: number; reason: string; stage: number }[] = [];
  for (let now = 0; now <= scheduler.endMs; now += stepMs) {
    const poll = scheduler.poll(now, (u) => (busyUntil.get(u) ?? -1) > now);
    for (const s of poll.starts) {
      const n = (turns.get(s.userId) ?? 0) + 1;
      turns.set(s.userId, n);
      busyUntil.set(s.userId, now + workMs(s.userId, n));
      starts.push({ ...s, atMs: now });
    }
    missed.push(...poll.missed);
  }
  return { scheduler, starts, missed };
}

const cases: [string, ScheduleInput][] = [
  ["the hand-written plan", plan.cohort],
  [
    "durations not divisible by pacing",
    { pacingEveryMs: 3000, stages: [
      { durationMs: 7000, fromUsers: 0, toUsers: 3 },
      { durationMs: 10000, fromUsers: 3, toUsers: 3 },
      { durationMs: 7000, fromUsers: 3, toUsers: 0 },
    ] },
  ],
  [
    "down and back up: a re-added user is a new epoch",
    { pacingEveryMs: 2000, stages: [
      { durationMs: 5000, fromUsers: 2, toUsers: 2 },
      { durationMs: 4000, fromUsers: 2, toUsers: 0 },
      { durationMs: 6000, fromUsers: 0, toUsers: 3 },
    ] },
  ],
  ["a jump between stages", { pacingEveryMs: 1000, stages: [
    { durationMs: 3000, fromUsers: 1, toUsers: 1 },
    { durationMs: 3000, fromUsers: 4, toUsers: 4 },
  ] }],
];

for (const [name, input] of cases) {
  test(`closed form equals expansion: ${name}`, () => {
    assert.deepEqual(scheduleStageStarts(input), expand(input));
  });

  test(`on time, every planned start starts where it was due: ${name}`, () => {
    const { starts, missed } = simulate(input, 1, () => 1);
    assert.deepEqual(missed, []);
    const perStage = input.stages.map((_, i) => starts.filter((s) => s.stage === i).length);
    assert.deepEqual(perStage, scheduleStageStarts(input));
  });
}

test("the hand-written plan's starts are 6, 48 and 6", () => {
  assert.deepEqual(scheduleStageStarts(plan.cohort), [6, 48, 6]);
});

test("users retire highest-numbered first, and a ramp up activates in user order", () => {
  const epochs = userEpochs({ pacingEveryMs: 1000, stages: [
    { durationMs: 4000, fromUsers: 0, toUsers: 4 },
    { durationMs: 4000, fromUsers: 4, toUsers: 0 },
  ] });
  assert.deepEqual(epochs.map((e) => [e.userId, e.activeFromMs, e.activeUntilMs]), [
    // Ramp down mirrors ramp up: user 4, the last activated, retires first, at the start of
    // the ramp down (start + D − floor(4·D/4)), so its span is empty.
    [1, 1000, 7000], [2, 2000, 6000], [3, 3000, 5000], [4, 4000, 4000],
  ]);
});

test("slow work: a busy user misses its tick, and the miss is never repaid", () => {
  const input: ScheduleInput = { pacingEveryMs: 1000, stages: [{ durationMs: 10_000, fromUsers: 1, toUsers: 1 }] };
  // Each turn takes 2.5 s: due at 0 starts, 1 and 2 are busy, 3 starts, ...
  const { starts, missed } = simulate(input, 10, () => 2500);
  assert.deepEqual(starts.map((s) => s.dueMs), [0, 3000, 6000, 9000]);
  assert.deepEqual(missed.map((m) => [m.dueMs, m.reason]), [
    [1000, "busy"], [2000, "busy"], [4000, "busy"], [5000, "busy"], [7000, "busy"], [8000, "busy"],
  ]);
  // Never more than one start per tick, never two at once.
  assert.equal(new Set(starts.map((s) => s.atMs)).size, starts.length);
});

test("failed work (instant) starts every tick; the scheduler does not care how a turn ended", () => {
  const input: ScheduleInput = { pacingEveryMs: 1000, stages: [{ durationMs: 5_000, fromUsers: 2, toUsers: 2 }] };
  const { starts, missed } = simulate(input, 1, () => 0);
  assert.equal(starts.length, 10);
  assert.deepEqual(missed, []);
});

test("a stalled clock: ticks missed during the stall are recorded and not caught up in a burst", () => {
  const input: ScheduleInput = { pacingEveryMs: 1000, stages: [{ durationMs: 20_000, fromUsers: 1, toUsers: 1 }] };
  const scheduler = new Scheduler(input, 500);
  assert.equal(scheduler.poll(0, () => false).starts.length, 1);
  // Nothing polled for 5.2 s: ticks at 1..5 s are due. Only 5 s could start, and it is
  // within slack, so it starts; 1..4 s are missed as late.
  const poll = scheduler.poll(5200, () => false);
  assert.deepEqual(poll.starts.map((s) => s.dueMs), [5000]);
  assert.deepEqual(poll.missed.map((m) => [m.dueMs, m.reason]), [[1000, "late"], [2000, "late"], [3000, "late"], [4000, "late"]]);
  // Past slack: the latest tick is missed too.
  const late = scheduler.poll(6700, () => false);
  assert.deepEqual(late.starts, []);
  assert.deepEqual(late.missed.map((m) => [m.dueMs, m.reason]), [[6000, "late"]]);
});

test("a start counts in the stage it began; a late start never crosses into the next stage", () => {
  const input: ScheduleInput = { pacingEveryMs: 1000, stages: [
    { durationMs: 3000, fromUsers: 1, toUsers: 1 },
    { durationMs: 3000, fromUsers: 1, toUsers: 1 },
  ] };
  const scheduler = new Scheduler(input, 1000);
  scheduler.poll(0, () => false);
  scheduler.poll(1000, () => false);
  // The tick due at 2.9 s... is at 2 s; polled at 3.2 s, inside slack but in the next stage.
  const poll = scheduler.poll(3200, () => false);
  assert.deepEqual(poll.missed.map((m) => [m.dueMs, m.stage, m.reason]), [[2000, 0, "late"]]);
  assert.deepEqual(poll.starts.map((s) => [s.dueMs, s.stage]), [[3000, 1]]);
  const boundary = new Scheduler(input, 1000);
  boundary.poll(0, () => false);
  boundary.poll(1000, () => false);
  // Due at 2 s in stage 0, polled at 3.0 s exactly: within slack, but stage 1 now.
  const crossed = boundary.poll(2999, () => false);
  assert.deepEqual(crossed.starts.map((s) => [s.dueMs, s.stage]), [[2000, 0]]);
  const b2 = new Scheduler({ pacingEveryMs: 2000, stages: input.stages }, 1500);
  b2.poll(0, () => false);
  const crossing = b2.poll(3100, () => false);
  assert.deepEqual(crossing.missed.map((m) => [m.dueMs, m.stage, m.reason]), [[2000, 0, "boundary"]]);
  assert.deepEqual(crossing.starts, []);
});

test("nothing starts after the plan's end, and nextDueMs runs out", () => {
  const input: ScheduleInput = { pacingEveryMs: 1000, stages: [{ durationMs: 2000, fromUsers: 1, toUsers: 1 }] };
  const scheduler = new Scheduler(input, 1000);
  assert.equal(scheduler.nextDueMs(), 0);
  assert.equal(scheduler.poll(1500, () => false).starts.length, 1);
  assert.equal(scheduler.nextDueMs(), null);
  assert.deepEqual(scheduler.poll(5000, () => false), { starts: [], missed: [] });
  assert.equal(scheduler.finished(2000), true);
});
