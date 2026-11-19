/**
 * A scripted `ControlPort` for the engine's tests. The only adapter this release ships; PR 3
 * adds the HTTP one. Times are wall-clock milliseconds since the port was made.
 */
import type { ControlPort, LeaseAnswer, LeaseRequest, Marker, PublishedCohort, PublishedInterval } from "../../src/load/control-port";

export interface PortScript {
  /** Stop answering renewals (the answer never comes) from this many ms on. */
  silentAfterMs?: number;
  /** Answer renewals this late, from `delayAfterMs` on (default: from the start). */
  delayMs?: number;
  delayAfterMs?: number;
  /** Hold every answer, then deliver them newest first (reordered). */
  reorderAfterMs?: number;
  /** Answer `stop` from this many ms on. */
  stopAfterMs?: number;
  stopMode?: "graceful" | "now";
  /** Refuse renewals (granted: false) from this many ms on. */
  refuseAfterMs?: number;
}

export interface RenewalRecord {
  seq: number;
  sentAtMs: number;
  askedWallMs: number;
  answeredWallMs: number | null;
}

export class FakeControlPort implements ControlPort {
  readonly renewals: RenewalRecord[] = [];
  readonly intervals: PublishedInterval[] = [];
  readonly cohorts: PublishedCohort[] = [];
  readonly markers: (Marker & { wallMs: number })[] = [];
  final: unknown = null;
  private readonly born = Date.now();
  private held: (() => void)[] = [];

  constructor(private readonly script: PortScript = {}) {}

  private since(): number {
    return Date.now() - this.born;
  }

  renewLease(request: LeaseRequest): Promise<LeaseAnswer> {
    const record: RenewalRecord = { ...request, askedWallMs: Date.now(), answeredWallMs: null };
    this.renewals.push(record);
    const at = this.since();
    const s = this.script;
    if (s.silentAfterMs !== undefined && at >= s.silentAfterMs) return new Promise(() => undefined);
    const answer: LeaseAnswer = {
      seq: request.seq,
      granted: !(s.refuseAfterMs !== undefined && at >= s.refuseAfterMs),
      ...(s.stopAfterMs !== undefined && at >= s.stopAfterMs ? { stop: s.stopMode ?? "graceful" } : {}),
    };
    return new Promise((resolve) => {
      const deliver = () => {
        record.answeredWallMs = Date.now();
        resolve(answer);
      };
      if (s.reorderAfterMs !== undefined && at >= s.reorderAfterMs) {
        this.held.push(deliver);
        if (this.held.length >= 2) {
          const batch = this.held.reverse();
          this.held = [];
          // On a later tick, so the newest answer's handler is attached before any is delivered.
          setImmediate(() => {
            for (const d of batch) d();
          });
        }
        return;
      }
      if (s.delayMs && at >= (s.delayAfterMs ?? 0)) setTimeout(deliver, s.delayMs);
      else deliver();
    });
  }

  async publishInterval(record: PublishedInterval): Promise<void> {
    this.intervals.push(record);
  }

  async publishCohort(record: PublishedCohort): Promise<void> {
    this.cohorts.push(record);
  }

  async publishMarker(marker: Marker): Promise<void> {
    this.markers.push({ ...marker, wallMs: Date.now() });
  }

  async publishFinal(result: unknown): Promise<void> {
    this.final = result;
  }
}
