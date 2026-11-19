/**
 * Checks that join the runner's journal to what the target and Peeps saw (plan v3 §7
 * property 6, `load-reconcile`):
 *
 *   - **received ⊆ handed off**: a request the sink saw that the gate never wrote means
 *     something got out around the gate;
 *   - **crash range**: after a runner dies, Peeps knows only the last debit it acknowledged and
 *     the highest ceiling it granted; the true count lies between them;
 *   - **events**: one stream per claim, seq from 1 with no gaps; an exact replay is a no-op, a
 *     replay with another payload is refused, and a stream without its final watermark is
 *     reported as missing coverage, never as complete.
 *
 * Pure: no clock, no I/O.
 */

export function receivedOutsideGate(handedOff: Iterable<number>, received: Iterable<number>): number[] {
  const handed = new Set(handedOff);
  return [...new Set(received)].filter((seq) => !handed.has(seq)).sort((a, b) => a - b);
}

export interface CrashRange {
  atLeast: number;
  atMost: number;
}

export function crashRange(lastAckDebited: number, highestCeiling: number): CrashRange {
  if (!Number.isSafeInteger(lastAckDebited) || !Number.isSafeInteger(highestCeiling) || lastAckDebited < 0) throw new Error("reconcile: counts must be whole numbers ≥ 0");
  return { atLeast: lastAckDebited, atMost: Math.max(lastAckDebited, highestCeiling) };
}

export interface EventBatch {
  streamId: string;
  seq: number;
  payloadHash: string;
  final?: { watermark: number };
}

export type EventAnswer = { ok: true; replay: boolean } | { ok: false; reason: "stream" | "gap" | "conflict" | "after_final" | "malformed" };

export interface Coverage {
  batches: number;
  /** Set only once the final batch arrived. */
  watermark: number | undefined;
  missing: "final" | undefined;
}

export class EventLedger {
  private readonly hashes: string[] = [];
  private finalWatermark: number | undefined;

  constructor(private readonly streamId: string) {}

  accept(batch: EventBatch): EventAnswer {
    if (batch.streamId !== this.streamId) return { ok: false, reason: "stream" };
    if (!Number.isSafeInteger(batch.seq) || batch.seq < 1 || typeof batch.payloadHash !== "string" || batch.payloadHash === "") return { ok: false, reason: "malformed" };
    if (batch.final && !(Number.isSafeInteger(batch.final.watermark) && batch.final.watermark >= 0)) return { ok: false, reason: "malformed" };
    const seen = this.hashes[batch.seq - 1];
    if (seen !== undefined) return seen === batch.payloadHash ? { ok: true, replay: true } : { ok: false, reason: "conflict" };
    if (this.finalWatermark !== undefined) return { ok: false, reason: "after_final" };
    if (batch.seq !== this.hashes.length + 1) return { ok: false, reason: "gap" };
    this.hashes.push(batch.payloadHash);
    if (batch.final) this.finalWatermark = batch.final.watermark;
    return { ok: true, replay: false };
  }

  coverage(): Coverage {
    return { batches: this.hashes.length, watermark: this.finalWatermark, missing: this.finalWatermark === undefined ? "final" : undefined };
  }
}
