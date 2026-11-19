/**
 * The runner's half of the lease (plan v3 §6, "Runner rules"). Peeps grants short leases
 * with an absolute ceiling; this turns each reply into deadlines on the runner's two clocks,
 * and refuses anything that could stretch permission: a reply for another claim, epoch, plan,
 * seq or nonce, a reply read after its own deadline, a server clock that ran back, or a retry
 * outside the deadline it was first sent under.
 *
 * Deadlines run from the *first* send of a seq, so a retry never moves them. `remaining` is
 * capped at 6 s whatever the server says.
 *
 * Pure: no clock, no timer, no I/O. The caller passes the clocks and the nonces.
 */
import type { Clocks, LeaseGrant } from "./gate/admission";

export const MAX_REMAINING_MS = 6000;

export interface LeaseBinding {
  claimId: string;
  epoch: number;
  planHash: string;
}

export interface ServerLease {
  ttlMs: number;
  ceiling: number;
  leaseUntilServerMs: number;
  serverNowMs: number;
}

/** The claim's lease (seq 0) with the binding it came with. */
export interface ClaimGrant extends ServerLease {
  binding: LeaseBinding;
  nonce: string;
  renewEveryMs: number;
}

export interface RenewReply extends ServerLease {
  claimId: string;
  epoch: number;
  planHash: string;
  seq: number;
  nonce: string;
  lease: "held" | "lost";
  stop?: { mode: "graceful" | "now"; reason: string };
}

/** One renewal in flight. */
export interface Outstanding {
  seq: number;
  nonce: string;
  requestHash: string;
  firstSendMono: number;
}

export type Ignored = "binding" | "seq" | "nonce";
export type Rejected = "late" | "clock_rollback" | "expired";

export type Decision =
  /** Not this renewal's answer: drop it, keep waiting. */
  | { kind: "ignored"; reason: Ignored }
  /** This renewal's answer, unusable: the gate keeps the lease it has, which runs out on its own. */
  | { kind: "rejected"; reason: Rejected }
  /** The lease is gone: revoke the gate now. */
  | { kind: "lost"; stop?: RenewReply["stop"] }
  | { kind: "lease"; grant: LeaseGrant; stop?: RenewReply["stop"] };

export class RunnerLease {
  private readonly offsetMs: number;
  private readonly rttMs: number;
  private readonly renewEveryMs: number;
  private current: LeaseGrant;
  private remainingMs: number;
  private lastServerNowMs: number;
  private lastSeq = 0;
  private inFlight: Outstanding | undefined;
  private lostFlag = false;

  /**
   * `sent` and `received` are the claim request's send and reply times. The wall offset and
   * round trip are measured once, here.
   */
  constructor(
    private readonly claim: ClaimGrant,
    sent: Clocks,
    received: Clocks,
  ) {
    this.offsetMs = claim.serverNowMs - (sent.wallMs + received.wallMs) / 2;
    this.rttMs = Math.max(0, received.monoMs - sent.monoMs);
    this.renewEveryMs = claim.renewEveryMs;
    this.lastServerNowMs = claim.serverNowMs;
    this.remainingMs = remaining(claim);
    this.current = this.grant(claim, sent.monoMs, this.remainingMs);
    if (!(received.monoMs < this.current.monoUntil)) this.lose();
  }

  get grantNow(): LeaseGrant {
    return { ...this.current };
  }

  get lost(): boolean {
    return this.lostFlag;
  }

  get outstanding(): Outstanding | undefined {
    return this.inFlight;
  }

  /** Whether the lease is still running at `t`; false once either clock passes its deadline. */
  held(t: Clocks): boolean {
    return !this.lostFlag && t.monoMs < this.current.monoUntil && t.wallMs < this.current.wallUntil;
  }

  /** Starts the next renewal. One at a time: refused while one is in flight or the lease is lost. */
  begin(t: Clocks, nonce: string, requestHash: string): Outstanding | null {
    if (this.lostFlag || this.inFlight || !this.held(t)) return null;
    this.inFlight = { seq: this.lastSeq + 1, nonce, requestHash, firstSendMono: t.monoMs };
    return { ...this.inFlight };
  }

  /** Whether the in-flight renewal may be sent again (identical bytes): only inside the lease it was first sent under. */
  mayRetry(t: Clocks): boolean {
    return this.inFlight !== undefined && this.held(t);
  }

  /** When to send the next renewal, after one sent at `prevSendMono` was answered at `prevAnswerMono`. */
  nextSendAt(prevSendMono: number, prevAnswerMono: number): number {
    return Math.max(prevSendMono + Math.min(this.renewEveryMs, this.remainingMs / 2), prevAnswerMono);
  }

  /** The renewal timed out or failed for good: the gate closes without waiting for HTTP. */
  abandon(): void {
    this.inFlight = undefined;
    this.lose();
  }

  apply(reply: RenewReply, t: Clocks): Decision {
    const tx = this.inFlight;
    const b = this.claim.binding;
    if (reply.claimId !== b.claimId || reply.epoch !== b.epoch || reply.planHash !== b.planHash) return { kind: "ignored", reason: "binding" };
    if (!tx || reply.seq !== tx.seq) return { kind: "ignored", reason: "seq" };
    if (reply.nonce !== tx.nonce) return { kind: "ignored", reason: "nonce" };
    this.inFlight = undefined;
    this.lastSeq = tx.seq;
    if (this.lostFlag) return { kind: "lost", stop: reply.stop };
    if (!this.held(t)) return this.lose(reply.stop);
    if (reply.lease === "lost" || reply.stop?.mode === "now") return this.lose(reply.stop);
    if (reply.serverNowMs < this.lastServerNowMs) return { kind: "rejected", reason: "clock_rollback" };
    const rem = remaining(reply);
    if (rem <= 0) return this.lose(reply.stop);
    const grant = this.grant(reply, tx.firstSendMono, rem);
    if (!(t.monoMs < grant.monoUntil)) return { kind: "rejected", reason: "late" };
    this.lastServerNowMs = reply.serverNowMs;
    this.remainingMs = rem;
    this.current = grant;
    return { kind: "lease", grant: { ...grant }, stop: reply.stop };
  }

  private grant(lease: ServerLease, firstSendMono: number, rem: number): LeaseGrant {
    return {
      monoUntil: firstSendMono + rem,
      wallUntil: lease.leaseUntilServerMs - this.offsetMs - this.rttMs / 2,
      ceiling: lease.ceiling,
    };
  }

  private lose(stop?: RenewReply["stop"]): Decision {
    this.lostFlag = true;
    this.current = { ...this.current, monoUntil: Number.NEGATIVE_INFINITY, wallUntil: Number.NEGATIVE_INFINITY };
    return { kind: "lost", stop };
  }
}

function remaining(lease: ServerLease): number {
  return Math.min(lease.ttlMs, lease.leaseUntilServerMs - lease.serverNowMs, MAX_REMAINING_MS);
}
