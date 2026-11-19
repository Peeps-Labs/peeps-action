/**
 * Per-phase budgets on a fake clock: totals, rate and burst, concurrency, the phase deadline,
 * the absolute end and the turn deadline, each answered with its own reason.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { PhaseGate } from "../src/load/budget";
import type { PhaseBudget } from "../src/load/engine-limits";

const budget = (over: Partial<PhaseBudget> = {}): PhaseBudget => ({
  users: 2, totalRequests: 100, ratePerSecond: 10, burst: 3, concurrency: 2,
  phaseDeadlineMs: 60_000, turnDeadlineMs: 5_000, ...over,
});

test("a burst then the rate: three at once, then one every 100 ms", () => {
  const gate = new PhaseGate(budget({ concurrency: 100 }), 0, 1_000_000);
  assert.deepEqual([1, 2, 3].map(() => gate.permit(0, 0).ok), [true, true, true]);
  assert.deepEqual(gate.permit(0, 0), { ok: false, reason: "rate", final: false, retryInMs: 100 });
  assert.deepEqual(gate.permit(99, 0), { ok: false, reason: "rate", final: false, retryInMs: 1 });
  assert.deepEqual(gate.permit(100, 0), { ok: true, seq: 4 });
  // A long quiet spell refills only up to the burst.
  for (let i = 0; i < 3; i++) assert.equal(gate.permit(10_000, 9_000).ok, true);
  assert.equal(gate.permit(10_000, 9_000).ok, false);
});

test("over a long run the rate holds: never more than burst + rate × elapsed", () => {
  const gate = new PhaseGate(budget({ concurrency: 1000, totalRequests: 1_000_000 }), 0, 10_000_000);
  let granted = 0;
  for (let now = 0; now <= 30_000; now += 7) {
    while (gate.permit(now, now).ok) {
      granted += 1;
      gate.release();
    }
    assert.ok(granted <= 3 + Math.floor((now * 10) / 1000), `${granted} by ${now} ms`);
  }
  assert.ok(granted >= 300);
});

test("concurrency: a third request waits until one finishes", () => {
  const gate = new PhaseGate(budget({ burst: 10 }), 0, 1_000_000);
  assert.equal(gate.permit(0, 0).ok, true);
  assert.equal(gate.permit(0, 0).ok, true);
  assert.deepEqual(gate.permit(0, 0), { ok: false, reason: "concurrency", final: false, retryInMs: 1 });
  gate.release();
  assert.equal(gate.inFlight, 1);
  assert.equal(gate.permit(1, 0).ok, true);
});

test("the total is final", () => {
  const gate = new PhaseGate(budget({ totalRequests: 2, concurrency: 5 }), 0, 1_000_000);
  gate.permit(0, 0);
  gate.permit(0, 0);
  assert.deepEqual(gate.permit(10_000, 10_000), { ok: false, reason: "total", final: true });
  assert.equal(gate.issued, 2);
});

test("deadlines are final, the earliest first: absolute end, phase, turn", () => {
  const gate = new PhaseGate(budget({ phaseDeadlineMs: 10_000 }), 1_000, 8_000);
  assert.equal(gate.phaseEndMs, 8_000);
  assert.deepEqual(gate.permit(8_000, 7_999), { ok: false, reason: "absolute_end", final: true });
  const phase = new PhaseGate(budget({ phaseDeadlineMs: 10_000 }), 1_000, 100_000);
  assert.deepEqual(phase.permit(11_000, 10_500), { ok: false, reason: "phase_deadline", final: true });
  assert.equal(phase.permit(10_999, 10_500).ok, true);
  assert.deepEqual(phase.permit(6_000, 1_000), { ok: false, reason: "turn_deadline", final: true });
});

test("releasing more than was taken never goes negative", () => {
  const gate = new PhaseGate(budget(), 0, 1_000);
  gate.release();
  assert.equal(gate.inFlight, 0);
});

test("the next phase starts with the tokens the last one left, not a fresh burst", () => {
  const checking = new PhaseGate(budget({ concurrency: 100 }), 0, 1_000_000);
  for (let i = 0; i < 3; i++) assert.equal(checking.permit(500, 500).ok, true);
  // Measurement begins at once, on its own clock from 0.
  const measurement = new PhaseGate(budget({ concurrency: 100 }), 0, 1_000_000, checking.tokensAt(500));
  assert.deepEqual(measurement.permit(0, 0), { ok: false, reason: "rate", final: false, retryInMs: 100 });
  assert.equal(measurement.permit(100, 0).ok, true);
});
