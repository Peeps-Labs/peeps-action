/**
 * The wire with Peeps (design v3 §6, as amended by e4 plan v3 §2.7). E4 ships only the fake
 * adapter (`test/support/fake-control-port.ts`); E5 adds the HTTP one. Everything Peeps answers
 * is decoded here as untrusted: an answer that does not decode is treated as no answer.
 *
 * Amendments for E5:
 *   - the grant carries `baseURL` and the `binding` it was issued for (checkout, lock digests,
 *     tree digest, workload);
 *   - a renew reply echoes `claimId` and `planHash`;
 *   - a renew body is `RenewFields` plus `requestHash` (over the canonical fields);
 *   - `state: "closed"` is the release-bearing last renewal (e5 plan §2.4): sent once, after
 *     settlement, and acknowledged by a receipt that echoes its address with `closed: true`;
 *   - A1 (e5 plan v3 §2.3–§2.4) adopts P1's wire-v1 corpus: the claim has one strict schema,
 *     built only by `claim-body.ts`, with the dispatch's `grantRef` required; the grant's
 *     `binding` is P1's (`lockDigests` with `package-lock.json` alone, and `observed` with the
 *     tree and generated lockfile digests), decoded strictly; a stop's reason is one of
 *     `STOP_REASONS`, and a claim refusal one of `CLAIM_REFUSALS` (`wire.ts`).
 *
 * Pure: no clock, no timer, no I/O.
 */
import { createHash } from "node:crypto";
import type { ClosedReceipt, RenewReply } from "./lease";
import { isClaimRefusal, isRenewRefusal, isStopReason, WIRE_PROTOCOL } from "./wire";

export const PROTOCOL = WIRE_PROTOCOL;

/** What a claim binds (P1's `GrantBinding`): the checkout, its lockfile, what the install left, the workload. */
export interface Binding {
  checkoutSha: string;
  /** sha256 of `package-lock.json`. */
  lockDigests: { "package-lock.json": string };
  /** After the offline pre-claim install: the tree, and npm's record of what it installed (`node_modules/.package-lock.json`). */
  observed: { treeDigest: string; generatedLockDigest: string };
  workload: { path: string; digest: string };
}

/** The claim body (seq 0). Built only by `claimBody` in `claim-body.ts`. */
export interface ClaimRequest extends Binding {
  protocol: typeof WIRE_PROTOCOL;
  actionVersion: string;
  grantRef: string;
  idempotencyKey: string;
  runAttempt: number;
  checkRunId: number;
  fence: { kind: "netns"; probe: { passed: boolean; failures: string[]; image: string; kernel: string; tools: string; chrony: string } };
}

/** Engine cap overrides. The P1 grant decoder requires all four fields per phase. */
export interface GrantPhaseCaps {
  ratePerSecond?: number;
  burst?: number;
  maxUsers?: number;
  total?: number;
}

export interface GrantLimits {
  allowedOrigins: string[];
  /** Origin → the private ranges (CIDR) the Owner approved for it. */
  privateOrigins: Record<string, string[]>;
  maxUsers: number;
  requestBudget: number;
  policyRevision: number;
  phases: { checking?: GrantPhaseCaps; measurement?: GrantPhaseCaps };
  /** Per-origin request caps; absent: each origin may use the whole run total. */
  originCaps?: Record<string, number>;
}

export interface ClaimLease {
  seq: 0;
  nonce: string;
  ttlMs: number;
  renewEveryMs: number;
  ceiling: number;
  leaseUntilServerMs: number;
  serverNowMs: number;
}

export interface Grant {
  claimId: string;
  epoch: number;
  runToken: string;
  eventsToken: string;
  planHash: string;
  plan: unknown;
  workload: { path: string; digest: string; module: string; export: string };
  limits: GrantLimits;
  lease: ClaimLease;
  maxRunMs: number;
  graceMs: number;
  hardEndServerMs: number;
  baseURL: string;
  binding: Binding;
}

export type ClaimReply = { ok: true; grant: Grant } | { ok: false; refused: string };

export type RenewState = "running" | "draining" | "closed";

export interface RenewFields {
  epoch: number;
  seq: number;
  nonce: string;
  phase: "starting" | "checking" | "measurement";
  debited: number;
  unresolved: number;
  inFlight: number;
  state: RenewState;
  lagP99Ms: number;
}

export interface RenewBody extends RenewFields {
  requestHash: string;
}

export interface EventsBody {
  streamId: string;
  seq: number;
  payloadHash: string;
  batch: string;
  final?: { watermark: number };
}

export interface ControlPort {
  claim(body: ClaimRequest, signal: AbortSignal): Promise<unknown>;
  /** `body` is the exact text to send: a retry sends the same. */
  renew(claimId: string, runToken: string, body: string, signal: AbortSignal): Promise<unknown>;
  events(claimId: string, eventsToken: string, body: EventsBody, signal: AbortSignal): Promise<unknown>;
}

/** JSON with object keys sorted at every depth; arrays keep their order. */
export function canonical(value: unknown): string {
  if (value === null || typeof value !== "object") {
    if (typeof value === "number" && !Number.isFinite(value)) throw new Error("canonical: a number must be finite");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  const obj = value as Record<string, unknown>;
  return `{${Object.keys(obj).filter((k) => obj[k] !== undefined).sort().map((k) => `${JSON.stringify(k)}:${canonical(obj[k])}`).join(",")}}`;
}

export function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

/** The plan's hash: over its canonical JSON. Prepare recomputes it from the validated plan. */
export function planHashOf(plan: unknown): string {
  return sha256(canonical(plan));
}

/** The renew body for `fields`: `requestHash` over the canonical fields, then the exact text sent. */
export function renewBody(fields: RenewFields): { requestHash: string; body: string } {
  const requestHash = sha256(canonical(fields));
  return { requestHash, body: canonical({ ...fields, requestHash }) };
}

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);
const text = (v: unknown, max = 512): v is string => typeof v === "string" && v.length > 0 && v.length <= max;
const whole = (v: unknown): v is number => typeof v === "number" && Number.isSafeInteger(v) && v >= 0;
const finite = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const texts = (v: unknown, max: number): v is string[] => Array.isArray(v) && v.length <= max && v.every((x) => text(x, 2048));
const CLAIM_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const LOAD_TOKEN = /^[A-Za-z0-9_-]{43}$/;
const SHA = /^[0-9a-f]{64}$/;
const COMMIT = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/;
const sha = (v: unknown): v is string => typeof v === "string" && SHA.test(v);
const only = (v: Obj, keys: readonly string[]) => Object.keys(v).length === keys.length && keys.every((k) => Object.hasOwn(v, k));

/** The grant's binding, strictly in P1's shape: exactly these keys at every depth. */
function decodeBinding(v: unknown): Binding | undefined {
  if (!isObj(v) || !only(v, ["checkoutSha", "lockDigests", "observed", "workload"])) return;
  const { lockDigests: l, observed: o, workload: w } = v;
  if (typeof v.checkoutSha !== "string" || !COMMIT.test(v.checkoutSha)) return;
  if (!isObj(l) || !only(l, ["package-lock.json"]) || !sha(l["package-lock.json"])) return;
  if (!isObj(o) || !only(o, ["treeDigest", "generatedLockDigest"]) || !sha(o.treeDigest) || !sha(o.generatedLockDigest)) return;
  if (!isObj(w) || !only(w, ["path", "digest"]) || !text(w.path, 1024) || !sha(w.digest)) return;
  return {
    checkoutSha: v.checkoutSha,
    lockDigests: { "package-lock.json": l["package-lock.json"] },
    observed: { treeDigest: o.treeDigest, generatedLockDigest: o.generatedLockDigest },
    workload: { path: w.path, digest: w.digest },
  };
}

function decodePhase(v: unknown): GrantPhaseCaps | undefined {
  if (!isObj(v) || !only(v, ["ratePerSecond", "burst", "maxUsers", "total"])) return;
  const { ratePerSecond, burst, maxUsers, total } = v;
  if (!whole(ratePerSecond) || ratePerSecond === 0 || !whole(burst) || burst === 0 || !whole(maxUsers) || !whole(total)) return;
  return { ratePerSecond, burst, maxUsers, total };
}

/**
 * A claim reply, untrusted. Anything that does not decode is refused `malformed`; a refusal
 * outside `CLAIM_REFUSALS` reads `unknown`, as the HTTP port reduces it.
 */
export function decodeClaimReply(raw: unknown): ClaimReply {
  const bad = { ok: false as const, refused: "malformed" };
  if (!isObj(raw)) return bad;
  if (raw.refused !== undefined) return { ok: false, refused: isClaimRefusal(raw.refused) ? raw.refused : "unknown" };
  if (!only(raw, ["claimId", "epoch", "runToken", "eventsToken", "planHash", "plan", "workload", "limits", "lease", "maxRunMs", "graceMs", "hardEndServerMs", "baseURL", "binding"])) return bad;
  const { limits: l, lease: s, workload: w } = raw;
  if (typeof raw.claimId !== "string" || !CLAIM_ID.test(raw.claimId) || !whole(raw.epoch) ||
      typeof raw.runToken !== "string" || !LOAD_TOKEN.test(raw.runToken) ||
      typeof raw.eventsToken !== "string" || !LOAD_TOKEN.test(raw.eventsToken) || !sha(raw.planHash)) return bad;
  if (!isObj(raw.plan) || !text(raw.baseURL, 2048)) return bad;
  if (!isObj(w) || !only(w, ["path", "digest", "module", "export"]) || !text(w.path, 1024) || !sha(w.digest) || !text(w.module, 1024) || !text(w.export, 256)) return bad;
  if (!isObj(l) || !only(l, ["allowedOrigins", "privateOrigins", "maxUsers", "requestBudget", "policyRevision", "phases"])) return bad;
  if (!texts(l.allowedOrigins, 20) || !isObj(l.privateOrigins) || !Object.values(l.privateOrigins).every((v) => texts(v, 20)) || Object.keys(l.privateOrigins).length > 20 || !whole(l.maxUsers) || !whole(l.requestBudget) || !whole(l.policyRevision)) return bad;
  if (!isObj(l.phases) || !only(l.phases, ["checking", "measurement"])) return bad;
  const checking = decodePhase(l.phases.checking);
  const measurement = decodePhase(l.phases.measurement);
  if (!checking || !measurement) return bad;
  if (!isObj(s) || !only(s, ["seq", "nonce", "ttlMs", "renewEveryMs", "ceiling", "leaseUntilServerMs", "serverNowMs"])) return bad;
  if (s.seq !== 0 || !text(s.nonce, 256) || !finite(s.ttlMs) || !(finite(s.renewEveryMs) && s.renewEveryMs > 0) || !whole(s.ceiling) || !finite(s.leaseUntilServerMs) || !finite(s.serverNowMs)) return bad;
  if (!whole(raw.maxRunMs) || !whole(raw.graceMs) || !finite(raw.hardEndServerMs)) return bad;
  const binding = decodeBinding(raw.binding);
  if (!binding || w.path !== binding.workload.path || w.digest !== binding.workload.digest) return bad;
  return {
    ok: true,
    grant: {
      claimId: raw.claimId,
      epoch: raw.epoch,
      runToken: raw.runToken,
      eventsToken: raw.eventsToken,
      planHash: raw.planHash,
      plan: raw.plan,
      workload: { path: w.path, digest: w.digest, module: w.module, export: w.export },
      limits: {
        allowedOrigins: [...l.allowedOrigins],
        privateOrigins: Object.fromEntries(Object.entries(l.privateOrigins as Record<string, string[]>).map(([k, v]) => [k, [...v]])),
        maxUsers: l.maxUsers,
        requestBudget: l.requestBudget,
        policyRevision: l.policyRevision,
        phases: { checking, measurement },
      },
      lease: { seq: 0, nonce: s.nonce, ttlMs: s.ttlMs, renewEveryMs: s.renewEveryMs, ceiling: s.ceiling, leaseUntilServerMs: s.leaseUntilServerMs, serverNowMs: s.serverNowMs },
      maxRunMs: raw.maxRunMs,
      graceMs: raw.graceMs,
      hardEndServerMs: raw.hardEndServerMs,
      baseURL: raw.baseURL,
      binding,
    },
  };
}

export type DecodedRenew =
  /** Not addressed to any renewal: ignore it. */
  | { kind: "unaddressed" }
  /** The control endpoint sent a refusal outside the renew vocabulary. */
  | { kind: "unknown_refusal" }
  /**
   * Addressed: claim, epoch, plan, seq and nonce all read. A lease number that does not read is
   * NaN, which `RunnerLease.apply` rejects (the old grant stays and runs out) unless the reply
   * carries a stop or a readable shorter lease. An unreadable `lease` state or `stop` (a stop
   * reason outside `STOP_REASONS` included) reads as `lost`, with no stop: its effect on
   * authorization cannot be established, so it fails closed.
   */
  | { kind: "reply"; reply: RenewReply };

/** A renew reply, untrusted. */
export function decodeRenewReply(raw: unknown): DecodedRenew {
  if (isObj(raw) && "refused" in raw) return { kind: isRenewRefusal(raw.refused) ? "unaddressed" : "unknown_refusal" };
  if (!isObj(raw) || !text(raw.claimId, 256) || !whole(raw.epoch) || !text(raw.planHash, 64) || !whole(raw.seq) || !text(raw.nonce, 256)) return { kind: "unaddressed" };
  const num = (v: unknown) => (finite(v) ? v : Number.NaN);
  let stop: RenewReply["stop"];
  let lease: RenewReply["lease"] = raw.lease === "held" || raw.lease === "lost" ? raw.lease : "lost";
  if (raw.stop !== undefined) {
    const st = raw.stop;
    // A reason outside the six is a malformed answer (e5 plan v3 §2.4): it fails closed.
    if (isObj(st) && (st.mode === "graceful" || st.mode === "now") && isStopReason(st.reason)) stop = { mode: st.mode, reason: st.reason };
    else lease = "lost";
  }
  return {
    kind: "reply",
    reply: {
      claimId: raw.claimId,
      epoch: raw.epoch,
      planHash: raw.planHash,
      seq: raw.seq,
      nonce: raw.nonce,
      lease,
      ttlMs: num(raw.ttlMs),
      ceiling: whole(raw.ceiling) ? raw.ceiling : Number.NaN,
      leaseUntilServerMs: num(raw.leaseUntilServerMs),
      serverNowMs: num(raw.serverNowMs),
      ...(stop ? { stop } : {}),
    },
  };
}

/**
 * A `closed` acknowledgement, untrusted: P1's receipt is the renew reply's address plus
 * `closed: true` (with `lease: "lost"` and `ttlMs: 0`). Anything else is no acknowledgement.
 */
export function decodeClosedReceipt(raw: unknown): ClosedReceipt | undefined {
  if (!isObj(raw) || raw.closed !== true || raw.lease !== "lost" || raw.ttlMs !== 0 ||
      !whole(raw.ceiling) || !finite(raw.leaseUntilServerMs) || !finite(raw.serverNowMs) || "refused" in raw ||
      !text(raw.claimId, 256) || !whole(raw.epoch) || !text(raw.planHash, 64) || !whole(raw.seq) || !text(raw.nonce, 256)) return undefined;
  return { claimId: raw.claimId, epoch: raw.epoch, planHash: raw.planHash, seq: raw.seq, nonce: raw.nonce, closed: true };
}
