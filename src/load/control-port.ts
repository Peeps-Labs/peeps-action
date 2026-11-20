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
 *   - the claim carries the dispatch's `grantRef` when the entry has one (A1 makes it required,
 *     with the strict claim schema).
 *
 * Pure: no clock, no timer, no I/O.
 */
import { createHash } from "node:crypto";
import type { ClosedReceipt, RenewReply } from "./lease";

export const PROTOCOL = 1;

export interface Binding {
  checkoutSha: string;
  /** File → sha256, for `package-lock.json` and `node_modules/.package-lock.json`. */
  lockDigests: Record<string, string>;
  treeDigest: string;
  workload: { path: string; digest: string };
}

export interface ClaimRequest extends Binding {
  protocol: 1;
  grantRef?: string;
  actionVersion: string;
  idempotencyKey: string;
  runAttempt: number;
  checkRunId: number;
  fence: { kind: "netns"; probe: { passed: boolean; failures: string[] } };
}

/** Per-phase caps the grant may lower; any field may be absent. */
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
const SHA = /^[0-9a-f]{64}$/;

function decodeBinding(v: unknown): Binding | undefined {
  if (!isObj(v) || !text(v.checkoutSha, 64) || !text(v.treeDigest, 128) || !isObj(v.lockDigests) || !isObj(v.workload)) return;
  const lockDigests: Record<string, string> = {};
  for (const [k, d] of Object.entries(v.lockDigests)) {
    if (!text(d, 128)) return;
    lockDigests[k] = d;
  }
  const w = v.workload;
  if (!text(w.path, 1024) || !text(w.digest, 128)) return;
  return { checkoutSha: v.checkoutSha, lockDigests, treeDigest: v.treeDigest, workload: { path: w.path, digest: w.digest } };
}

function decodePhase(v: unknown): GrantPhaseCaps | undefined | false {
  if (v === undefined) return undefined;
  if (!isObj(v)) return false;
  const out: GrantPhaseCaps = {};
  for (const key of ["ratePerSecond", "burst", "maxUsers", "total"] as const) {
    const x = v[key];
    if (x === undefined) continue;
    if (key === "ratePerSecond" ? !(finite(x) && x > 0) : !whole(x)) return false;
    out[key] = x as number;
  }
  return out;
}

/** A claim reply, untrusted. Anything that does not decode is refused `malformed`. */
export function decodeClaimReply(raw: unknown): ClaimReply {
  const bad = { ok: false as const, refused: "malformed" };
  if (!isObj(raw)) return bad;
  if (raw.refused !== undefined) return text(raw.refused, 64) ? { ok: false, refused: raw.refused } : bad;
  const { limits: l, lease: s, workload: w } = raw;
  if (!text(raw.claimId, 256) || !whole(raw.epoch) || !text(raw.runToken, 4096) || !text(raw.eventsToken, 4096) || !text(raw.planHash, 64) || !SHA.test(raw.planHash)) return bad;
  if (!isObj(raw.plan) || !text(raw.baseURL, 2048)) return bad;
  if (!isObj(w) || !text(w.path, 1024) || !text(w.digest, 128) || !text(w.module, 1024) || !text(w.export, 256)) return bad;
  if (!isObj(l) || !texts(l.allowedOrigins, 20) || !isObj(l.privateOrigins) || !Object.values(l.privateOrigins).every((v) => texts(v, 20)) || Object.keys(l.privateOrigins).length > 20 || !whole(l.maxUsers) || !whole(l.requestBudget) || !whole(l.policyRevision) || !isObj(l.phases)) return bad;
  const checking = decodePhase(l.phases.checking);
  const measurement = decodePhase(l.phases.measurement);
  if (checking === false || measurement === false) return bad;
  let originCaps: Record<string, number> | undefined;
  if (l.originCaps !== undefined) {
    if (!isObj(l.originCaps)) return bad;
    originCaps = {};
    for (const [k, n] of Object.entries(l.originCaps)) {
      if (!whole(n)) return bad;
      originCaps[k] = n;
    }
  }
  if (!isObj(s) || s.seq !== 0 || !text(s.nonce, 256) || !finite(s.ttlMs) || !(finite(s.renewEveryMs) && s.renewEveryMs > 0) || !whole(s.ceiling) || !finite(s.leaseUntilServerMs) || !finite(s.serverNowMs)) return bad;
  if (!whole(raw.maxRunMs) || !whole(raw.graceMs) || !finite(raw.hardEndServerMs)) return bad;
  const binding = decodeBinding(raw.binding);
  if (!binding) return bad;
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
        phases: { ...(checking ? { checking } : {}), ...(measurement ? { measurement } : {}) },
        ...(originCaps ? { originCaps } : {}),
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
  /**
   * Addressed: claim, epoch, plan, seq and nonce all read. A lease number that does not read is
   * NaN, which `RunnerLease.apply` rejects (the old grant stays and runs out) unless the reply
   * carries a stop or a readable shorter lease. An unreadable `lease` state or `stop` reads as
   * `lost`: its effect on authorization cannot be established, so it fails closed.
   */
  | { kind: "reply"; reply: RenewReply };

/** A renew reply, untrusted. */
export function decodeRenewReply(raw: unknown): DecodedRenew {
  if (!isObj(raw) || !text(raw.claimId, 256) || !whole(raw.epoch) || !text(raw.planHash, 64) || !whole(raw.seq) || !text(raw.nonce, 256)) return { kind: "unaddressed" };
  const num = (v: unknown) => (finite(v) ? v : Number.NaN);
  let stop: RenewReply["stop"];
  let lease: RenewReply["lease"] = raw.lease === "held" || raw.lease === "lost" ? raw.lease : "lost";
  if (raw.stop !== undefined) {
    const st = raw.stop;
    if (isObj(st) && (st.mode === "graceful" || st.mode === "now") && typeof st.reason === "string" && st.reason.length <= 256) stop = { mode: st.mode, reason: st.reason };
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
  if (!isObj(raw) || raw.closed !== true || !text(raw.claimId, 256) || !whole(raw.epoch) || !text(raw.planHash, 64) || !whole(raw.seq) || !text(raw.nonce, 256)) return undefined;
  return { claimId: raw.claimId, epoch: raw.epoch, planHash: raw.planHash, seq: raw.seq, nonce: raw.nonce, closed: true };
}
