/**
 * Checks that join the runner's journal to what the target and Peeps saw (plan v3 §7
 * property 6, `load-reconcile`):
 *
 *   - **received ⊆ handed off, once each**: a request the target saw that the gate never
 *     wrote, or saw twice, means something got out around the gate;
 *   - **crash range**: after a runner dies, Peeps knows only the last debit and receipt count it
 *     acknowledged and the highest ceiling it granted; the true counts lie between them;
 *   - **events**: one stream per claim, seq from 1 with no gaps; an exact replay is a no-op, a
 *     replay with another payload is refused, and a stream without its final watermark is
 *     reported as missing coverage, never as complete.
 *
 * Pure: no clock, no I/O.
 */
import { createHash } from "node:crypto";
import type { EventsBody } from "../control-port";
import { wasAttempted, type Handoffs } from "./journal";

export interface Arrivals {
  /** Seqs the target recorded that the gate never handed off. */
  unknown: number[];
  /** Seqs the target recorded more than once: one admission, several arrivals. */
  repeated: number[];
}

/** Compare the target's complete receipts with this run's socket-write attempts. */
export function receivedOutsideGate(handoffs: Handoffs, receipts: Iterable<number>): Arrivals {
  const seen = new Map<number, number>();
  for (const seq of receipts) seen.set(seq, (seen.get(seq) ?? 0) + 1);
  const sorted = [...seen.keys()].sort((a, b) => a - b);
  return {
    unknown: sorted.filter((seq) => !wasAttempted(handoffs, seq)),
    repeated: sorted.filter((seq) => seen.get(seq)! > 1),
  };
}

export interface CrashRange {
  /** Requests admitted: at least the last debit Peeps acknowledged, at most the highest ceiling it granted. */
  debited: { atLeast: number; atMost: number };
  /** Requests the target saw: only receipts prove an arrival, so an unresolved write proves none. */
  arrivals: { atLeast: number; atMost: number };
}

export function crashRange(lastAckDebited: number, lastAckSinkReceipts: number, highestCeiling: number): CrashRange {
  for (const n of [lastAckDebited, lastAckSinkReceipts, highestCeiling]) if (!Number.isSafeInteger(n) || n < 0) throw new Error("reconcile: counts must be whole numbers ≥ 0");
  if (lastAckSinkReceipts > lastAckDebited) throw new Error("reconcile: more received than debited");
  const atMost = Math.max(lastAckDebited, highestCeiling);
  return { debited: { atLeast: lastAckDebited, atMost }, arrivals: { atLeast: lastAckSinkReceipts, atMost } };
}

export interface EventBatch {
  streamId: string;
  seq: number;
  /** The batch's canonical body. */
  payload: string;
  final?: { watermark: number };
}

/** The hash a batch is compared by: over its seq, body and final marker, so none can change on replay. */
export function batchHash(batch: EventBatch): string {
  return createHash("sha256").update(JSON.stringify([batch.streamId, batch.seq, batch.payload, batch.final?.watermark ?? null])).digest("hex");
}

/** The events envelope, hashed once when the supervisor queues it. */
export function eventsBody(streamId: string, seq: number, batch: string, final?: EventsBody["final"]): EventsBody {
  return { streamId, seq, batch, ...(final ? { final } : {}), payloadHash: batchHash({ streamId, seq, payload: batch, final }) };
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
    if (!Number.isSafeInteger(batch.seq) || batch.seq < 1 || typeof batch.payload !== "string") return { ok: false, reason: "malformed" };
    if (batch.final && !(Number.isSafeInteger(batch.final.watermark) && batch.final.watermark >= 0)) return { ok: false, reason: "malformed" };
    const hash = batchHash(batch);
    const seen = this.hashes[batch.seq - 1];
    if (seen !== undefined) return seen === hash ? { ok: true, replay: true } : { ok: false, reason: "conflict" };
    if (this.finalWatermark !== undefined) return { ok: false, reason: "after_final" };
    if (batch.seq !== this.hashes.length + 1) return { ok: false, reason: "gap" };
    this.hashes.push(hash);
    if (batch.final) this.finalWatermark = batch.final.watermark;
    return { ok: true, replay: false };
  }

  coverage(): Coverage {
    return { batches: this.hashes.length, watermark: this.finalWatermark, missing: this.finalWatermark === undefined ? "final" : undefined };
  }
}
