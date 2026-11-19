/**
 * The lease, on a fake clock: permission runs from a renewal's *send* time, for the shorter of
 * the lease and what the answer grants; an answer for an older seq, an old answer, or one
 * that comes back after permission already ran out never extends it; and every accepted
 * renewal starts a new generation.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { Lease } from "../src/load/lease";

const LEASE = 3_000;
const make = () => new Lease({ leaseMs: LEASE, maxAgeMs: 1_500 });
const yes = (seq: number, extra: Record<string, unknown> = {}) => ({ seq, granted: true, ...extra });

test("permission runs from the request's send time, never the answer's arrival", () => {
  const lease = make();
  assert.equal(lease.answer(1, 0, yes(1), 1_000).accepted, true);
  assert.equal(lease.until, LEASE);
  assert.equal(lease.held(LEASE - 1), true);
  assert.equal(lease.held(LEASE), false);
});

test("an answer may grant less than the lease, never more", () => {
  const lease = make();
  lease.answer(1, 0, yes(1, { validForMs: 1_000 }), 10);
  assert.equal(lease.until, 1_000);
  const more = make();
  more.answer(1, 0, yes(1, { validForMs: 60_000 }), 10);
  assert.equal(more.until, LEASE);
});

test("an answer older than the age bound is refused", () => {
  const lease = make();
  assert.deepEqual(lease.answer(1, 0, yes(1), 1_501), { accepted: false, reason: "too_old", lost: false });
  assert.equal(lease.until, Number.NEGATIVE_INFINITY);
});

test("an answer for an older seq than one accepted is refused", () => {
  const lease = make();
  lease.answer(2, 1_000, yes(2), 1_010);
  assert.deepEqual(lease.answer(1, 500, yes(1), 1_020), { accepted: false, reason: "stale_seq", lost: false });
  assert.equal(lease.until, 1_000 + LEASE);
});

test("a mismatched or refused answer is refused", () => {
  const lease = make();
  assert.equal(lease.answer(1, 0, yes(2), 10).reason, "wrong_seq");
  assert.equal(lease.answer(1, 0, { seq: 1, granted: false }, 10).reason, "not_granted");
});

test("an answer that arrives after permission ran out loses the lease, and never revives it", () => {
  const lease = make();
  lease.answer(1, 0, yes(1), 10);
  // The event loop was blocked: the next answer is read after the lease already ended.
  const late = lease.answer(2, 1_000, yes(2), LEASE + 5);
  assert.deepEqual(late, { accepted: false, reason: "expired", lost: true });
  assert.equal(lease.lost, true);
  assert.equal(lease.answer(3, LEASE + 10, yes(3), LEASE + 20).accepted, false);
  assert.equal(lease.held(LEASE + 20), false);
});

test("a grant already over when it arrives is refused", () => {
  const lease = make();
  assert.equal(lease.answer(1, 0, yes(1, { validForMs: 100 }), 200).reason, "expired");
});

test("each accepted renewal is a new generation", () => {
  const lease = make();
  assert.equal(lease.generation, 0);
  lease.answer(1, 0, yes(1), 10);
  assert.equal(lease.generation, 1);
  lease.answer(2, 900, yes(2), 910);
  assert.equal(lease.generation, 2);
  lease.answer(3, 950, yes(2), 960);
  assert.equal(lease.generation, 2);
});

test("checking the clock marks the lease lost once permission ends", () => {
  const lease = make();
  assert.equal(lease.check(5_000), false, "never held: not lost");
  lease.answer(1, 0, yes(1), 10);
  assert.equal(lease.check(LEASE - 1), false);
  assert.equal(lease.check(LEASE), true);
  assert.equal(lease.lost, true);
  assert.equal(lease.check(LEASE + 1), false, "lost once");
});
