/**
 * Durations as integer microseconds, and `hist/1`: one mergeable distribution format for
 * every timing metric (product spec §5.5). Counts are merged before a percentile is taken;
 * percentiles of parts are never averaged.
 *
 * `hist/1` is log-linear: values below 128 µs have a bucket each; above that, each power of
 * two is split into 64 equal buckets, so a bucket's width is at most 1/64 (1.6%) of its
 * lower bound. Values from 0 to `HIST_MAX_MICROS` (1 hour) are recorded; larger ones count as
 * `overflow` and are reported as above the range, never as a number. A percentile is the
 * upper bound of the bucket holding the nearest-rank sample, so it never under-reports.
 *
 * Pure: no file system, network or Playwright.
 */

export const HIST_VERSION = "hist/1";
export const HIST_MAX_MICROS = 3_600_000_000;
const LINEAR = 128;
const SUB = 64;

/** Nanoseconds (from `process.hrtime.bigint()`) as whole microseconds, rounded down. */
export function nanosToMicros(nanos: bigint): number {
  if (nanos < 0n) throw new RangeError("a duration cannot be negative");
  const micros = nanos / 1000n;
  if (micros > BigInt(Number.MAX_SAFE_INTEGER)) throw new RangeError("duration out of range");
  return Number(micros);
}

/** Whole milliseconds as microseconds. */
export function millisToMicros(ms: number): number {
  if (!Number.isSafeInteger(ms) || ms < 0) throw new RangeError("milliseconds must be a whole, non-negative number");
  return ms * 1000;
}

/** The bucket a value falls in. */
export function bucketOf(micros: number): number {
  if (micros < LINEAR) return micros;
  const bits = Math.floor(Math.log2(micros)) + 1; // micros ≥ 128, so bits ≥ 8
  let shift = bits - 7;
  let mantissa = Math.floor(micros / 2 ** shift);
  // Guard against log2 rounding at exact powers of two.
  if (mantissa >= 2 * SUB) {
    shift += 1;
    mantissa = Math.floor(micros / 2 ** shift);
  } else if (mantissa < SUB) {
    shift -= 1;
    mantissa = Math.floor(micros / 2 ** shift);
  }
  return LINEAR + (shift - 1) * SUB + (mantissa - SUB);
}

/** The largest value a bucket holds. */
export function bucketUpper(bucket: number): number {
  if (bucket < LINEAR) return bucket;
  const shift = Math.floor((bucket - LINEAR) / SUB) + 1;
  const mantissa = ((bucket - LINEAR) % SUB) + SUB;
  return (mantissa + 1) * 2 ** shift - 1;
}

/** The smallest value a bucket holds. */
export function bucketLower(bucket: number): number {
  if (bucket < LINEAR) return bucket;
  const shift = Math.floor((bucket - LINEAR) / SUB) + 1;
  const mantissa = ((bucket - LINEAR) % SUB) + SUB;
  return mantissa * 2 ** shift;
}

export interface Histogram {
  v: typeof HIST_VERSION;
  /** Sparse `[bucket, count]` pairs, buckets ascending. */
  counts: [number, number][];
  overflow: number;
  /** Every recorded value, overflow included. */
  n: number;
}

export function emptyHistogram(): Histogram {
  return { v: HIST_VERSION, counts: [], overflow: 0, n: 0 };
}

/** A histogram of these values, in microseconds. */
export function histogramOf(values: readonly number[]): Histogram {
  const counts = new Map<number, number>();
  let overflow = 0;
  for (const value of values) {
    if (!Number.isSafeInteger(value) || value < 0) throw new RangeError(`not a duration in microseconds: ${value}`);
    if (value > HIST_MAX_MICROS) overflow += 1;
    else counts.set(bucketOf(value), (counts.get(bucketOf(value)) ?? 0) + 1);
  }
  return {
    v: HIST_VERSION,
    counts: [...counts.entries()].sort((a, b) => a[0] - b[0]),
    overflow,
    n: values.length,
  };
}

/** Counts added bucket by bucket. Refuses anything that is not `hist/1`. */
export function mergeHistograms(parts: readonly Histogram[]): Histogram {
  const counts = new Map<number, number>();
  let overflow = 0;
  let n = 0;
  for (const part of parts) {
    if (part.v !== HIST_VERSION) throw new Error(`cannot merge ${String(part.v)} into ${HIST_VERSION}`);
    for (const [bucket, count] of part.counts) counts.set(bucket, (counts.get(bucket) ?? 0) + count);
    overflow += part.overflow;
    n += part.n;
  }
  return { v: HIST_VERSION, counts: [...counts.entries()].sort((a, b) => a[0] - b[0]), overflow, n };
}

/**
 * The nearest-rank `q` percentile (0 < q ≤ 1) as the upper bound of its bucket; `"overflow"`
 * when that sample was above the range, null when there is nothing to rank.
 */
export function percentile(hist: Histogram, q: number): number | "overflow" | null {
  if (!(q > 0 && q <= 1)) throw new RangeError("q must be in (0, 1]");
  if (hist.n === 0) return null;
  const rank = Math.ceil(q * hist.n);
  let seen = 0;
  for (const [bucket, count] of hist.counts) {
    seen += count;
    if (seen >= rank) return bucketUpper(bucket);
  }
  return "overflow";
}
