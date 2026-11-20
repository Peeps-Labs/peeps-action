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
 *   - events: one stream per claim, in order, through `EventLedger`.
 *
 * Refusals answer `{refused}`, which the runner cannot match to a renewal, so it is no answer.
 */
import type { ClaimRequest, ControlPort, EventsBody, Binding, GrantLimits } from "../../src/load/control-port";
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
}

export interface FakeSetup {
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
  readonly claimId = "claim-1";
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
  private drainingSince: number | undefined;
  private hardEndServerMs = 0;
  private readonly ackLost = new Set<number>();
  private nonceN = 0;

  constructor(private readonly setup: FakeSetup, private readonly script: PortScript = {}) {
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
    if (body.checkoutSha !== b.checkoutSha || body.treeDigest !== b.treeDigest || canonical(body.lockDigests) !== canonical(b.lockDigests) || canonical(body.workload) !== canonical(b.workload)) return { refused: "binding" };
    if (!body.fence?.probe?.passed) return { refused: "fence_unverified" };
    const now = this.now();
    this.claimedAt = now;
    this.idempotencyKey = body.idempotencyKey;
    const maxRunMs = this.setup.maxRunMs ?? 120_000;
    const graceMs = this.setup.graceMs ?? 5_000;
    this.hardEndServerMs = now + maxRunMs;
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
    if (answer === "hang" || (this.script.silentAfterMs !== undefined && this.since() >= this.script.silentAfterMs)) return this.forever(signal);
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
    if (fields.state === "closed") return refuse("closed_reserved");
    if (fields.epoch !== this.epoch) return refuse("epoch");
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
    const answer: Record<string, unknown> = {
      claimId: this.claimId,
      epoch: this.epoch,
      planHash: this.planHash,
      seq,
      nonce: fields.nonce,
      lease: "held",
      ttlMs: this.ttlMs,
      ceiling: this.ceilingFor(debited),
      leaseUntilServerMs: until,
      serverNowMs: now,
    };
    this.lastSeq = seq;
    this.lastDebited = debited;
    this.last = { hash: String(requestHash), body, answer };
    return this.reevaluate(answer);
  }

  private reevaluate(stored: Record<string, unknown>): Record<string, unknown> {
    const s = this.script;
    const at = this.since();
    const answer = { ...stored };
    if (s.lostAfterMs !== undefined && at >= s.lostAfterMs) answer.lease = "lost";
    if (s.stopAfterMs !== undefined && at >= s.stopAfterMs) answer.stop = { mode: s.stopMode ?? "graceful", reason: "owner" };
    if (this.now() >= (stored.leaseUntilServerMs as number)) answer.lease = "lost";
    return answer;
  }

  async events(claimId: string, eventsToken: string, body: EventsBody, signal: AbortSignal): Promise<unknown> {
    if (this.script.eventsBlocked) return this.forever(signal);
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
