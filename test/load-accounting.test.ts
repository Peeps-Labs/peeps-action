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
    success: 0, failure: 0, timeout: 0, interrupted: 0, inFlight: 0, oldestInFlightMs: null,
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
