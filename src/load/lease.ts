/**
 * The lease's arithmetic, on the engine's qualified clock. Permission runs from a renewal
 * request's *send* time for the shorter of the lease and the answer's `validForMs`, so a
 * delayed or reordered answer never extends it. An answer counts only for its own seq, only
 * if no later seq was accepted, only while younger than the age bound, and only while
 * permission is still running when it is read: an answer read after permission ran out (the
 * event loop was blocked, the job paused) loses the lease instead of reviving it. Every
 * accepted renewal starts a new generation, which starts and permits carry.
 *
 * Pure: no file system, network or Playwright.
 */
import type { LeaseAnswer } from "./control-port";

export type LeaseRefusal = "wrong_seq" | "stale_seq" | "not_granted" | "too_old" | "expired" | "lost";

export interface LeaseVerdict {
  accepted: boolean;
  reason?: LeaseRefusal;
  /** This answer is what showed the lease was lost. */
  lost: boolean;
}

export class Lease {
  private untilMs = Number.NEGATIVE_INFINITY;
  private acceptedSeq = 0;
  private gen = 0;
  private lostFlag = false;

  constructor(private readonly bounds: { leaseMs: number; maxAgeMs: number }) {}

  /** When permission ends, on the engine's clock. */
  get until(): number {
    return this.untilMs;
  }

  get generation(): number {
    return this.gen;
  }

  get lost(): boolean {
    return this.lostFlag;
  }

  /** Whether permission is running at `nowMs`. */
  held(nowMs: number): boolean {
    return !this.lostFlag && nowMs < this.untilMs;
  }

  /** Marks the lease lost once permission it had has ended; true the one time it does. */
  check(nowMs: number): boolean {
    if (this.lostFlag || this.acceptedSeq === 0 || nowMs < this.untilMs) return false;
    this.lostFlag = true;
    return true;
  }

  /** An answer to the request `seq` sent at `sentAtMs`, read at `nowMs`. */
  answer(seq: number, sentAtMs: number, answer: LeaseAnswer, nowMs: number): LeaseVerdict {
    if (this.check(nowMs)) return { accepted: false, reason: "expired", lost: true };
    if (this.lostFlag) return { accepted: false, reason: "lost", lost: false };
    if (answer.seq !== seq) return { accepted: false, reason: "wrong_seq", lost: false };
    if (seq <= this.acceptedSeq) return { accepted: false, reason: "stale_seq", lost: false };
    if (!answer.granted) return { accepted: false, reason: "not_granted", lost: false };
    if (nowMs - sentAtMs > this.bounds.maxAgeMs) return { accepted: false, reason: "too_old", lost: false };
    const validFor = Math.min(this.bounds.leaseMs, answer.validForMs ?? this.bounds.leaseMs);
    const grant = sentAtMs + validFor;
    if (grant <= nowMs) return { accepted: false, reason: "expired", lost: false };
    this.acceptedSeq = seq;
    this.gen += 1;
    this.untilMs = Math.max(this.untilMs, grant);
    return { accepted: true, lost: false };
  }
}
