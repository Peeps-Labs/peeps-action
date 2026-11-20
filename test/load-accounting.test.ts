/**
 * Interval counters and sealed start cohorts (§5.5): an empty interval is a record and a
 * missing one is a gap; every start ends in exactly one outcome or is unresolved; an outcome
 * at the deadline is a timeout; a start at the end of a hold stays with the hold.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { Accounting, intervalGaps } from "../src/load/accounting";

test("an empty interval is published as zeros; a missing interval is a gap", () => {
  const a = new Accounting(10_000);
  a.start("s1", 1_000, 0, 6_000);
  a.outcome("s1", "success", 2_000);
  const records = a.closeIntervals(30_000);
  assert.deepEqual(records.map((r) => [r.interval, r.started, r.success]), [[0, 1, 1], [1, 0, 0], [2, 0, 0]]);
  assert.deepEqual(records[1], {
    interval: 1, fromMs: 10_000, untilMs: 20_000, due: 0, started: 0, missed: 0,
    success: 0, failure: 0, timeout: 0, interrupted: 0, inFlight: 0, oldestInFlightMs: null, requests: zeroCounts(),
  });
  assert.deepEqual(intervalGaps(records, 3), []);
  assert.deepEqual(intervalGaps([records[0]!, records[2]!], 3), [1]);
  // Nothing is published twice, and an unfinished interval waits.
  assert.deepEqual(a.closeIntervals(39_999), []);
});

test("an outcome exactly at the deadline is a timeout, counted where the deadline falls", () => {
  const a = new Accounting(10_000);
  a.start("s1", 8_000, 0, 12_000);
  a.start("s2", 8_000, 0, 12_000);
  assert.equal(a.outcome("s1", "success", 12_000), true);
  assert.equal(a.outcome("s2", "success", 11_999), true);
  const [first, second] = a.closeIntervals(20_000);
  assert.equal(first!.started, 2);
  assert.deepEqual([second!.timeout, second!.success], [1, 1]);
});

test("every start ends in exactly one outcome", () => {
  const a = new Accounting(10_000);
  a.start("s1", 0, 0, 5_000);
  assert.equal(a.outcome("s1", "failure", 100), true);
  assert.equal(a.outcome("s1", "success", 200), false);
  assert.equal(a.outcome("nope", "success", 200), false);
  assert.throws(() => a.start("s1", 0, 0, 5_000), /recorded twice/);
  const [record] = a.closeIntervals(10_000);
  assert.deepEqual([record!.failure, record!.success], [1, 0]);
});

test("expire turns a start past its deadline into a timeout at that deadline", () => {
  const a = new Accounting(10_000);
  a.start("s1", 9_000, 0, 14_000);
  assert.deepEqual(a.expire(13_999), []);
  assert.deepEqual(a.expire(25_000), ["s1"]);
  const records = a.closeIntervals(30_000);
  assert.deepEqual(records.map((r) => r.timeout), [0, 1, 0]);
  assert.deepEqual(records.map((r) => r.inFlight), [1, 0, 0]);
});

test("a start at the end of a hold stays with the hold's cohort, though it finishes later", () => {
  const a = new Accounting(10_000);
  a.start("last-of-hold", 9_999, 1, 15_000);
  a.start("first-of-down", 10_000, 2, 15_000);
  a.outcome("last-of-hold", "success", 14_000);
  a.outcome("first-of-down", "success", 11_000);
  const cohorts = a.sealCohorts(20_000, 1_000);
  assert.deepEqual(cohorts.map((c) => [c.interval, c.stage, c.starts, c.success]), [[0, 1, 1, 1], [1, 2, 1, 1]]);
});

test("a cohort seals unresolved after its deadline and grace, never as a success or timeout", () => {
  const a = new Accounting(10_000);
  a.start("lost", 1_000, 0, 5_000);
  a.start("done", 2_000, 0, 6_000);
  a.outcome("done", "success", 3_000);
  // Interval over, but the lost start's deadline + grace (5 s + 2 s) not yet.
  assert.deepEqual(a.sealCohorts(6_999 + 3_001, 5_000), []);
  const [cohort] = a.sealCohorts(11_000, 2_000);
  assert.deepEqual(cohort, { interval: 0, stage: 0, starts: 2, success: 1, failure: 0, timeout: 0, interrupted: 0, unresolved: 1 });
  // Sealed once.
  assert.deepEqual(a.sealCohorts(100_000, 0), []);
});

test("a cohort waits for its interval to end even when every start is resolved", () => {
  const a = new Accounting(10_000);
  a.start("s1", 1_000, 0, 5_000);
  a.outcome("s1", "success", 2_000);
  assert.deepEqual(a.sealCohorts(9_999, 0), []);
  assert.equal(a.sealCohorts(10_000, 0).length, 1);
});

test("interrupted stays interrupted even past the deadline; force seals everything", () => {
  const a = new Accounting(10_000);
  a.start("s1", 0, 0, 1_000);
  a.start("s2", 0, 0, 1_000);
  a.outcome("s1", "interrupted", 5_000);
  assert.deepEqual(a.unresolved(), ["s2"]);
  const [cohort] = a.sealCohorts(0, 0, true);
  assert.deepEqual([cohort!.interrupted, cohort!.unresolved], [1, 1]);
});

test("due and missed turns are counted in their interval", () => {
  const a = new Accounting(10_000);
  a.due(1_000);
  a.due(12_000);
  a.missed(12_000);
  const records = a.closeIntervals(20_000);
  assert.deepEqual(records.map((r) => [r.due, r.missed]), [[1, 0], [1, 1]]);
  // After an interval is published, a late event lands in the oldest open interval.
  a.missed(5_000);
  assert.equal(a.closeIntervals(30_000)[0]!.missed, 1);
});

test("totals count every outcome once, an expiry included, and a later outcome for it is ignored", () => {
  const a = new Accounting(10_000);
  a.start("s1", 0, 0, 5_000);
  a.start("s2", 0, 0, 5_000);
  assert.equal(a.record("s1", "success", 1_000), "success");
  assert.deepEqual(a.expire(6_000), ["s2"]);
  assert.equal(a.record("s2", "success", 6_100), null, "an expired start took a second outcome");
  assert.deepEqual(a.totals, { success: 1, failure: 0, timeout: 1, interrupted: 0 });
  const [record] = a.closeIntervals(10_000);
  assert.deepEqual([record!.success, record!.timeout], [a.totals.success, a.totals.timeout]);
});

test("settled starts are let go once their intervals are published and their cohort sealed", () => {
  const a = new Accounting(1_000);
  for (let i = 0; i < 5_000; i++) {
    const at = i * 20;
    a.start(`s${i}`, at, 0, at + 500);
    a.outcome(`s${i}`, "success", at + 10);
    if (i % 50 === 0) {
      a.closeIntervals(at);
      a.sealCohorts(at, 100);
    }
  }
  assert.ok(a.retained() <= 200, `retained ${a.retained()} starts`);
  assert.equal(a.totals.success, 5_000);
});

// ---------------------------------------------------------------- request counts from journal deltas (e4 plan v3 §2.3)

import { CUT_REASONS, DENY_REASONS, requestDelta, sumCounts, zeroCounts } from "../src/load/accounting";
import type { JournalSnapshot } from "../src/load/gate/journal";

const snap = (over: Partial<JournalSnapshot> = {}): JournalSnapshot => ({ debited: 0, attempted: 0, accepted: 0, responded: 0, received: 0, unresolved: 0, denied: {}, cut: {}, ...over });

test("request counts carry an explicit zero for every reason", () => {
  const z = zeroCounts();
  for (const r of DENY_REASONS) assert.equal(z.denied[r], 0, r);
  for (const r of CUT_REASONS) assert.equal(z.cut[r], 0, r);
  const d = requestDelta(snap(), snap({ debited: 2, attempted: 1, denied: { rate: 3 }, cut: { dial: 1 } }));
  assert.equal(d.denied.lease, 0, "a reason that never happened is a zero, not missing");
  assert.equal(d.denied.rate, 3);
  assert.equal(d.cut.dial, 1);
  assert.equal(d.cut.lease, 0);
  const odd = requestDelta(snap(), snap({ denied: { brand_new: 1 } }));
  assert.equal(odd.denied.brand_new, 1, "an unlisted reason is still counted");
});

test("interval deltas sum to the final snapshot, and a counter never runs back", () => {
  const steps = [
    snap(),
    snap({ debited: 3, attempted: 3, accepted: 2, responded: 2, unresolved: 1, denied: { rate: 1 } }),
    snap({ debited: 5, attempted: 4, accepted: 4, responded: 3, received: 1, unresolved: 1, denied: { rate: 1, lease: 2 }, cut: { dial: 1 } }),
    snap({ debited: 9, attempted: 8, accepted: 8, responded: 8, received: 1, unresolved: 1, denied: { rate: 4, lease: 2 }, cut: { dial: 1, turn_closed: 2 } }),
  ];
  const deltas = steps.slice(1).map((s, i) => requestDelta(steps[i]!, s));
  const total = sumCounts(deltas);
  const last = steps.at(-1)!;
  for (const k of ["debited", "attempted", "accepted", "responded", "received"] as const) assert.equal(total[k], last[k], k);
  for (const [r, n] of Object.entries(last.denied)) assert.equal(total.denied[r], n, r);
  for (const [r, n] of Object.entries(last.cut)) assert.equal(total.cut[r], n, r);
  assert.throws(() => requestDelta(steps[2]!, steps[1]!), /back/);
});

test("the accounting's intervals carry the requests counted in them, zeroes included", () => {
  const a = new Accounting(1000);
  a.requests(500, requestDelta(snap(), snap({ debited: 2, attempted: 2 })));
  a.requests(1500, requestDelta(snap({ debited: 2, attempted: 2 }), snap({ debited: 3, attempted: 2, cut: { dial: 1 } })));
  const [i0, i1, i2] = a.closeIntervals(3000).concat(a.closeIntervals(3000));
  assert.equal(i0!.requests.debited, 2);
  assert.equal(i1!.requests.debited, 1);
  assert.equal(i1!.requests.cut.dial, 1);
  assert.equal(i2!.requests.debited, 0, "an empty interval publishes explicit zeroes");
  assert.equal(i2!.requests.denied.lease, 0);
});
