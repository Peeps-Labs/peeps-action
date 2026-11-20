/**
 * Integer microseconds and `hist/1`: golden bucket and percentile vectors, and merging counts
 * before a percentile (never averaging percentiles).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";

import {
  HIST_MAX_MICROS,
  bucketLower,
  bucketOf,
  bucketUpper,
  histogramOf,
  mergeHistograms,
  millisToMicros,
  nanosToMicros,
  percentile,
  type Histogram,
} from "../src/load/timing";

const vectors = JSON.parse(
  readFileSync(path.resolve(__dirname, "fixtures/load-engine/histogram-vectors.json"), "utf8"),
) as {
  buckets: { micros: number; bucket: number; lower: number; upper: number }[];
  percentiles: { name: string; values: number[] | "1..100 ms"; expect: Record<string, number | string | null> }[];
};

const valuesOf = (v: number[] | "1..100 ms") => (v === "1..100 ms" ? Array.from({ length: 100 }, (_, i) => (i + 1) * 1000) : v);

for (const v of vectors.buckets) {
  test(`hist/1 puts ${v.micros} µs in bucket ${v.bucket} [${v.lower}, ${v.upper}]`, () => {
    assert.equal(bucketOf(v.micros), v.bucket);
    assert.equal(bucketLower(v.bucket), v.lower);
    assert.equal(bucketUpper(v.bucket), v.upper);
  });
}

for (const v of vectors.percentiles) {
  test(`hist/1 percentiles: ${v.name}`, () => {
    const hist = histogramOf(valuesOf(v.values));
    assert.deepEqual(
      { p50: percentile(hist, 0.5), p95: percentile(hist, 0.95), p99: percentile(hist, 0.99) },
      v.expect,
    );
  });
}

test("every value sits inside its bucket, and buckets are at most 1/64 of their lower bound wide", () => {
  for (let micros = 0; micros < 300_000; micros += micros < 2000 ? 1 : 97) {
    const bucket = bucketOf(micros);
    assert.ok(bucketLower(bucket) <= micros && micros <= bucketUpper(bucket), `${micros}`);
    if (micros >= 128) assert.ok((bucketUpper(bucket) - bucketLower(bucket) + 1) / bucketLower(bucket) <= 1 / 64);
    if (micros > 0) assert.ok(bucketOf(micros) >= bucketOf(micros - 1));
  }
  for (let e = 7; e <= 31; e++) {
    for (const micros of [2 ** e - 1, 2 ** e, 2 ** e + 1]) {
      const bucket = bucketOf(micros);
      assert.ok(bucketLower(bucket) <= micros && micros <= bucketUpper(bucket), `${micros}`);
    }
  }
});

test("merging counts and then ranking equals ranking everything at once, unlike averaging", () => {
  const fast = Array.from({ length: 90 }, () => 1000);
  const slow = Array.from({ length: 10 }, () => 900_000);
  const merged = mergeHistograms([histogramOf(fast), histogramOf(slow)]);
  assert.deepEqual(merged, histogramOf([...fast, ...slow]));
  assert.equal(percentile(merged, 0.95), bucketUpper(bucketOf(900_000)));
  // The average of the two parts' p95s would be about 450 ms: a number no request took.
  const averaged = ((percentile(histogramOf(fast), 0.95) as number) + (percentile(histogramOf(slow), 0.95) as number)) / 2;
  assert.notEqual(percentile(merged, 0.95), averaged);
});

test("merging refuses another format", () => {
  const other = { v: "ddsketch/1", counts: [], overflow: 0, n: 0 } as unknown as Histogram;
  assert.throws(() => mergeHistograms([histogramOf([1]), other]), /cannot merge ddsketch\/1/);
});

test("values must be whole, non-negative microseconds; overflow is counted, never ranked as a number", () => {
  assert.throws(() => histogramOf([1.5]), RangeError);
  assert.throws(() => histogramOf([-1]), RangeError);
  const hist = histogramOf([HIST_MAX_MICROS, HIST_MAX_MICROS + 1]);
  assert.equal(hist.overflow, 1);
  assert.equal(hist.n, 2);
  assert.throws(() => percentile(hist, 0), RangeError);
});

test("durations convert to whole microseconds", () => {
  assert.equal(nanosToMicros(1_999n), 1);
  assert.equal(nanosToMicros(0n), 0);
  assert.throws(() => nanosToMicros(-1n), RangeError);
  assert.equal(millisToMicros(250), 250_000);
  assert.throws(() => millisToMicros(1.5), RangeError);
});
