/**
 * The qualified clock (Sol): a wall/monotonic divergence or a long gap between ticks raises a
 * resume fence, and only a renewal sent after the fence lifts it.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { QualifiedClock } from "../src/load/clock";

function fake() {
  const t = { mono: 1_000, wall: 1_700_000_000_000 };
  return { t, sources: { monoMs: () => t.mono, wallMs: () => t.wall } };
}
const bounds = { maxDivergenceMs: 250, maxGapMs: 1_000 };

test("steady ticks advance elapsed time and raise nothing", () => {
  const { t, sources } = fake();
  const clock = new QualifiedClock(sources, bounds);
  for (let i = 0; i < 10; i++) {
    t.mono += 100;
    t.wall += 100;
    clock.tick();
  }
  assert.equal(clock.nowMs, 1_000);
  assert.equal(clock.fenced, false);
});

test("permission counts the larger step: if either clock says time passed, it passed", () => {
  const { t, sources } = fake();
  const clock = new QualifiedClock(sources, bounds);
  t.mono += 100;
  t.wall += 300;
  clock.tick();
  assert.equal(clock.nowMs, 300);
});

test("wall and monotonic diverging beyond the bound fences", () => {
  const { t, sources } = fake();
  const clock = new QualifiedClock(sources, bounds);
  t.mono += 100;
  t.wall += 900; // NTP step, or a suspend the monotonic clock did not count
  clock.tick();
  assert.equal(clock.fenced, true);
  assert.equal(clock.fenceReason, "divergence");
});

test("a long gap between ticks (SIGSTOP, VM pause) fences", () => {
  const { t, sources } = fake();
  const clock = new QualifiedClock(sources, bounds);
  t.mono += 5_000;
  t.wall += 5_000;
  clock.tick();
  assert.equal(clock.fenced, true);
  assert.equal(clock.fenceReason, "gap");
  assert.equal(clock.fencedAtMs, 5_000);
});

test("a clock going backwards fences", () => {
  const { t, sources } = fake();
  const clock = new QualifiedClock(sources, bounds);
  t.mono += 10;
  t.wall -= 10;
  clock.tick();
  assert.equal(clock.fenceReason, "backwards");
  assert.equal(clock.nowMs, 10);
});

test("only a renewal sent after the fence lifts it; an answer to an older request does not", () => {
  const { t, sources } = fake();
  const clock = new QualifiedClock(sources, bounds);
  t.mono += 100;
  t.wall += 100;
  const sentBefore = clock.tick();
  t.mono += 4_000;
  t.wall += 4_000;
  clock.tick();
  assert.equal(clock.fenced, true);
  // The answer to the request sent before the pause arrives now: still fenced.
  assert.equal(clock.renewed(sentBefore), false);
  assert.equal(clock.fenced, true);
  t.mono += 50;
  t.wall += 50;
  const sentAfter = clock.tick();
  assert.equal(clock.renewed(sentAfter), true);
  assert.equal(clock.fenced, false);
});

test("a second pause while fenced moves the bar", () => {
  const { t, sources } = fake();
  const clock = new QualifiedClock(sources, bounds);
  t.mono += 2_000;
  t.wall += 2_000;
  clock.tick();
  const sent = clock.nowMs;
  t.mono += 3_000;
  t.wall += 3_000;
  clock.tick();
  assert.equal(clock.renewed(sent), false);
  assert.equal(clock.renewed(clock.nowMs), true);
});
