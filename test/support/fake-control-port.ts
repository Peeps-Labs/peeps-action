/**
 * A scripted Peeps for the engine's tests: the §6 server rules (design v3) with the e4 plan v3
 * §2.7 amendments, over a `ControlPort`. Its clock is the wall clock plus `serverSkewMs`.
 *
 *   - claim: the binding must match what the fake was told to expect; one idempotency key, one
 *     answer;
 *   - renew: the runToken; an exact retry (same seq and hash) gets the stored answer,
 *     re-evaluated against stop and expiry, never extended; a changed payload, a seq gap or a
 *     falling `debited` is refused; `ceiling = min(requestBudget, debited + allowance)`;
 *     `leaseUntil = min(now + ttl, hardEnd)`, and the grace end while draining;
 *   - closed (e5 plan §2.4, P1's renew.json): accepted at any seq above the last applied one
 *     (a gap is allowed only for closed), with the epoch, the hash, no falling `debited` and
 *     `inFlight` 0 (else `malformed`), whether or not the lease is still held; it answers an
 *     immutable receipt, a replay of the closed seq gets the same receipt, and every later
 *     renewal is refused `closed`;
 *   - events: one stream per claim, in order, through `EventLedger`.
 *
 * Refusals answer `{refused}`, which the runner cannot match to a renewal, so it is no answer.
 */
import type { ClaimRequest, ControlPort, EventsBody, Binding, GrantLimits } from "../../src/load/control-port";
import { claimBodyProblem } from "../../src/load/claim-body";
import { canonical, planHashOf, sha256 } from "../../src/load/control-port";
import { batchHash, EventLedger } from "../../src/load/gate/reconcile";

export interface PortScript {
  /** No renew is answered from this many ms after the claim (the answer never comes). */
  silentAfterMs?: number;
  /** This renew seq never answers (a hung renew); its retries neither. */
  hangSeq?: number;
  /** Renewals answer `lease: "lost"` from this many ms on. */
  lostAfterMs?: number;
  /** Peeps asks the run to stop from this many ms on. */
  stopAfterMs?: number;
  stopMode?: "graceful" | "now";
  /** Each renew answer is delivered this late. */
  delayMs?: number;
  /** Rewrites a renew answer before it is sent (malformed replies). */
  mangle?: (reply: Record<string, unknown>, seq: number) => Record<string, unknown>;
  /** The claim is refused with this reason. */
  claimRefused?: string;
  /** The server's clock runs this far ahead of the runner's wall clock. */
  serverSkewMs?: number;
  /** Events: the batch is recorded but the answer is lost (the request rejects) for these seqs, once each. */
  ackLost?: number[];
  /** Events: no answer ever comes. */
  eventsBlocked?: boolean;
  /** Events: this seq is answered as a conflicting replay. */
  conflictSeq?: number;
  /** The closed renewal never answers (`silentAfterMs` leaves it answered, so a silent Peeps' run still reports quickly). */
  closedSilent?: boolean;
  /** Events: answered with a transport failure (as a 5xx would be) this many times in all. */
  eventsFailures?: number;
  /** Events: from this seq on, answered with this refusal instead. */
  eventsRefuseFrom?: { seq: number; answer: unknown };
}

export interface FakeSetup {
  /** The grant's claim id; "claim-1" when absent. */
  claimId?: string;
  plan: unknown;
  limits: GrantLimits;
  workload: { path: string; digest: string; module: string; export: string };
  baseURL: string;
  /** What the claim must bind. */
  binding: Binding;
  ttlMs?: number;
  renewEveryMs?: number;
  /** debited + allowance is the ceiling, up to the request budget. */
  allowance?: number;
  maxRunMs?: number;
  graceMs?: number;
}

export interface RenewRecord {
  seq: number;
  hash: string;
  fields: Record<string, unknown>;
  body: string;
  atServerMs: number;
  answered: boolean;
  refused?: string;
}

interface Stored {
  hash: string;
  body: string;
  answer: Record<string, unknown>;
}

export class FakeControlPort implements ControlPort {
  readonly claims: ClaimRequest[] = [];
  readonly renewals: RenewRecord[] = [];
  readonly posted: (EventsBody & { refused?: string })[] = [];
  readonly ledger = new Map<string, EventLedger>();
  readonly claimId: string;
  readonly runToken = "run-token-" + "r".repeat(20);
  readonly eventsToken = "events-token-" + "e".repeat(20);
  readonly epoch = 1;
  readonly planHash: string;
  private claimedAt: number | undefined;
  private claimAnswer: unknown;
  private idempotencyKey: string | undefined;
  private last: Stored | undefined;
  private lastSeq = 0;
  private lastDebited = 0;
  private highestCeiling = 0;
  private leaseUntil = 0;
  /** The accepted closed: its seq, body, receipt text and Peeps' time. */
  closed: { seq: number; body: string; receipt: string; atServerMs: number; debited: number } | undefined;
  eventsCalls = 0;
  private drainingSince: number | undefined;
  private hardEndServerMs = 0;
  private readonly ackLost = new Set<number>();
  private nonceN = 0;

  constructor(private readonly setup: FakeSetup, private readonly script: PortScript = {}) {
    this.claimId = setup.claimId ?? "claim-1";
    this.planHash = planHashOf(setup.plan);
    for (const seq of script.ackLost ?? []) this.ackLost.add(seq);
  }

  now(): number {
    return Date.now() + (this.script.serverSkewMs ?? 0);
  }

  private since(): number {
    return this.claimedAt === undefined ? 0 : this.now() - this.claimedAt;
  }

  get ttlMs(): number {
    return this.setup.ttlMs ?? 5000;
  }

  get renewEveryMs(): number {
    return this.setup.renewEveryMs ?? 1500;
  }

  async claim(body: ClaimRequest, signal: AbortSignal): Promise<unknown> {
    signal.throwIfAborted();
    this.claims.push(structuredClone(body));
    if (this.idempotencyKey !== undefined) return body.idempotencyKey === this.idempotencyKey ? this.claimAnswer : { refused: "duplicate_claim" };
    if (this.script.claimRefused) return { refused: this.script.claimRefused };
    const b = this.setup.binding;
    // Peeps' strict schema first (P1's parseClaimBody): a body it would not parse is `malformed`.
    if (claimBodyProblem(canonical(body)) !== undefined) return { refused: "malformed" };
    if (body.checkoutSha !== b.checkoutSha || canonical(body.observed) !== canonical(b.observed) || canonical(body.lockDigests) !== canonical(b.lockDigests) || canonical(body.workload) !== canonical(b.workload)) return { refused: "binding" };
    if (!body.fence?.probe?.passed) return { refused: "fence_unverified" };
    const now = this.now();
    this.claimedAt = now;
    this.idempotencyKey = body.idempotencyKey;
    const maxRunMs = this.setup.maxRunMs ?? 120_000;
    const graceMs = this.setup.graceMs ?? 5_000;
    this.hardEndServerMs = now + maxRunMs;
    this.highestCeiling = this.ceilingFor(0);
    this.leaseUntil = Math.min(now + this.ttlMs, this.hardEndServerMs);
    this.claimAnswer = {
      claimId: this.claimId,
      epoch: this.epoch,
      runToken: this.runToken,
      eventsToken: this.eventsToken,
      planHash: this.planHash,
      plan: this.setup.plan,
      workload: this.setup.workload,
      limits: this.setup.limits,
      lease: { seq: 0, nonce: this.nonce(), ttlMs: this.ttlMs, renewEveryMs: this.renewEveryMs, ceiling: this.ceilingFor(0), leaseUntilServerMs: Math.min(now + this.ttlMs, this.hardEndServerMs), serverNowMs: now },
      maxRunMs,
      graceMs,
      hardEndServerMs: this.hardEndServerMs,
      baseURL: this.setup.baseURL,
      binding: this.setup.binding,
    };
    return this.claimAnswer;
  }

  private nonce(): string {
    return `nonce-${++this.nonceN}`;
  }

  private ceilingFor(debited: number): number {
    return Math.min(this.setup.limits.requestBudget, debited + (this.setup.allowance ?? 500));
  }

  async renew(claimId: string, runToken: string, body: string, signal: AbortSignal): Promise<unknown> {
    const record: RenewRecord = { seq: -1, hash: "", fields: {}, body, atServerMs: this.now(), answered: false };
    this.renewals.push(record);
    const answer = this.decide(claimId, runToken, body, record);
    const closing = record.fields.state === "closed";
    if (answer === "hang" || (closing && this.script.closedSilent) || (!closing && this.script.silentAfterMs !== undefined && this.since() >= this.script.silentAfterMs)) return this.forever(signal);
    if (this.script.delayMs) await sleep(this.script.delayMs, signal);
    signal.throwIfAborted();
    record.answered = true;
    if ("refused" in answer) return answer;
    return this.script.mangle ? this.script.mangle({ ...answer }, record.seq) : answer;
  }

  private decide(claimId: string, runToken: string, body: string, record: RenewRecord): Record<string, unknown> | "hang" {
    const refuse = (why: string) => {
      record.refused = why;
      return { refused: why };
    };
    if (claimId !== this.claimId || runToken !== this.runToken) return refuse("auth");
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(body) as Record<string, unknown>;
    } catch {
      return refuse("malformed");
    }
    const { requestHash, ...fields } = parsed;
    record.seq = Number(fields.seq);
    record.hash = String(requestHash);
    record.fields = fields;
    if (requestHash !== sha256(canonical(fields))) return refuse("hash");
    if (fields.epoch !== this.epoch) return refuse("epoch");
    if (this.closed) {
      // The receipt is immutable: a replay of the closed seq gets it byte for byte.
      if (record.seq === this.closed.seq && body === this.closed.body) return JSON.parse(this.closed.receipt) as Record<string, unknown>;
      return refuse("closed");
    }
    if (fields.state === "closed") return this.close(fields, String(requestHash), body, record);
    if (this.script.hangSeq === record.seq) return "hang";
    const seq = record.seq;
    if (this.last && seq === this.lastSeq) {
      if (this.last.hash !== requestHash || this.last.body !== body) return refuse("changed_payload");
      // An exact retry: the stored answer, re-evaluated against stop and expiry, never extended.
      return this.reevaluate(this.last.answer);
    }
    if (seq !== this.lastSeq + 1) return refuse("gap");
    const debited = Number(fields.debited);
    if (!Number.isSafeInteger(debited) || debited < this.lastDebited) return refuse("debited");
    const now = this.now();
    if (fields.state === "draining" && this.drainingSince === undefined) this.drainingSince = now;
    let until = Math.min(now + this.ttlMs, this.hardEndServerMs);
    if (this.drainingSince !== undefined) until = Math.min(until, this.drainingSince + (this.setup.graceMs ?? 5000));
    const ceiling = Math.max(this.ceilingFor(debited), this.highestCeiling);
    const answer: Record<string, unknown> = {
      claimId: this.claimId,
      epoch: this.epoch,
      planHash: this.planHash,
      seq,
      nonce: fields.nonce,
      lease: "held",
      ttlMs: this.ttlMs,
      ceiling,
      leaseUntilServerMs: until,
      serverNowMs: now,
    };
    this.highestCeiling = ceiling;
    this.leaseUntil = until;
    this.lastSeq = seq;
    this.lastDebited = debited;
    this.last = { hash: String(requestHash), body, answer };
    return this.reevaluate(answer);
  }

  private close(fields: Record<string, unknown>, requestHash: string, body: string, record: RenewRecord): Record<string, unknown> {
    const refuse = (why: string) => {
      record.refused = why;
      return { refused: why };
    };
    if (fields.inFlight !== 0) return refuse("malformed");
    if (!(record.seq > this.lastSeq)) return refuse("gap");
    const debited = Number(fields.debited);
    if (!Number.isSafeInteger(debited) || debited < this.lastDebited) return refuse("debited");
    const now = this.now();
    const receipt = canonical({ ceiling: this.highestCeiling, claimId: this.claimId, closed: true, epoch: this.epoch, lease: "lost", leaseUntilServerMs: Math.min(this.leaseUntil, now), nonce: fields.nonce, planHash: this.planHash, seq: record.seq, serverNowMs: now, ttlMs: 0 });
    this.closed = { seq: record.seq, body, receipt, atServerMs: now, debited };
    this.lastSeq = record.seq;
    this.lastDebited = debited;
    void requestHash;
    return JSON.parse(receipt) as Record<string, unknown>;
  }

  private reevaluate(stored: Record<string, unknown>): Record<string, unknown> {
    const s = this.script;
    const at = this.since();
    const answer = { ...stored };
    if (s.lostAfterMs !== undefined && at >= s.lostAfterMs) answer.lease = "lost";
    if (s.stopAfterMs !== undefined && at >= s.stopAfterMs) answer.stop = { mode: s.stopMode ?? "graceful", reason: "user_stop" };
    if (this.now() >= (stored.leaseUntilServerMs as number)) answer.lease = "lost";
    return answer;
  }

  async events(claimId: string, eventsToken: string, body: EventsBody, signal: AbortSignal): Promise<unknown> {
    this.eventsCalls += 1;
    if (this.script.eventsBlocked) return this.forever(signal);
    if (this.script.eventsFailures !== undefined && this.script.eventsFailures > 0) {
      this.script.eventsFailures -= 1;
      throw new Error("load control events: status 503");
    }
    const refuseFrom = this.script.eventsRefuseFrom;
    if (refuseFrom && body.seq >= refuseFrom.seq) {
      this.posted.push({ ...structuredClone(body), refused: "scripted" });
      return refuseFrom.answer;
    }
    if (this.script.conflictSeq === body.seq) {
      this.posted.push({ ...structuredClone(body), refused: "conflict" });
      return { ok: false, reason: "conflict" };
    }
    const record: EventsBody & { refused?: string } = structuredClone(body);
    this.posted.push(record);
    if (claimId !== this.claimId || eventsToken !== this.eventsToken) return { ok: false, reason: (record.refused = "auth") };
    if (body.payloadHash !== batchHash({ streamId: body.streamId, seq: body.seq, payload: body.batch, final: body.final })) return { ok: false, reason: (record.refused = "hash") };
    let ledger = this.ledger.get(claimId);
    if (!ledger) this.ledger.set(claimId, (ledger = new EventLedger(body.streamId)));
    const answer = ledger.accept({ streamId: body.streamId, seq: body.seq, payload: body.batch, final: body.final });
    if (!answer.ok) record.refused = answer.reason;
    if (this.ackLost.delete(body.seq)) throw new Error("the answer was lost");
    return answer;
  }

  /** The batches accepted, in order, parsed. */
  batches(): unknown[] {
    return this.posted.filter((e) => !e.refused).sort((a, b) => a.seq - b.seq).filter((e, i, all) => i === 0 || all[i - 1]!.seq !== e.seq).map((e) => JSON.parse(e.batch));
  }

  private forever(signal: AbortSignal): Promise<never> {
    return new Promise((_resolve, reject) => {
      if (signal.aborted) return reject(signal.reason);
      signal.addEventListener("abort", () => reject(signal.reason), { once: true });
    });
  }
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    signal.addEventListener("abort", () => {
      clearTimeout(timer);
      reject(signal.reason);
    }, { once: true });
  });
}
