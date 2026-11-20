/**
 * The wire with Peeps (e4 plan v3 §2.7, §3.2 `load-control`): decoders, hashes, and the fake's
 * §6 server rules.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { canonical, decodeClaimReply, decodeRenewReply, planHashOf, renewBody, sha256, type ClaimRequest, type RenewFields } from "../src/load/control-port";
import { RunnerLease, type ClaimGrant } from "../src/load/lease";
import type { Clocks } from "../src/load/gate/admission";
import { FakeControlPort, type FakeSetup } from "./support/fake-control-port";

const PLAN = { protocolVersion: 1, journey: { module: "j.ts", export: "go" }, z: [3, 1, 2], a: { y: 1, b: 2 } };
const BINDING = { checkoutSha: "a".repeat(40), lockDigests: { "package-lock.json": "d1".repeat(32) }, observed: { treeDigest: "7".repeat(64), generatedLockDigest: "6".repeat(64) }, workload: { path: "peeps/load/x.workload.yaml", digest: "f1".repeat(32) } };
const CAPS = { ratePerSecond: 5, burst: 5, maxUsers: 5, total: 100 };
const SETUP: FakeSetup = {
  plan: PLAN,
  limits: { allowedOrigins: ["https://shop.test"], privateOrigins: {}, maxUsers: 5, requestBudget: 1000, policyRevision: 1, phases: { checking: CAPS, measurement: CAPS } },
  workload: { ...BINDING.workload, module: "j.ts", export: "go" },
  baseURL: "https://shop.test",
  binding: BINDING,
  allowance: 100,
};
const PROBE = { passed: true, failures: [], image: "ubuntu24 20261116.376.1", kernel: "6.8.0", tools: "systemd 255; unshare 2.39.3", chrony: "normal" };
const CLAIM: ClaimRequest = { protocol: 1, actionVersion: "1.0.0", grantRef: "q2Jx7Vf0bH1kR8sTzW4uYg", idempotencyKey: "0b5e4a6c-7d1f-4e2a-8b3c-9d4e5f6a7b8c", runAttempt: 1, checkRunId: 7, fence: { kind: "netns", probe: PROBE }, ...BINDING };
const signal = new AbortController().signal;

async function claimed(script = {}) {
  const port = new FakeControlPort(SETUP, script);
  const reply = decodeClaimReply(await port.claim(CLAIM, signal));
  assert.ok(reply.ok, JSON.stringify(reply));
  return { port, grant: reply.grant };
}

const fields = (over: Partial<RenewFields> = {}): RenewFields => ({ epoch: 1, seq: 1, nonce: "n1", phase: "checking", debited: 0, unresolved: 0, inFlight: 0, state: "running", lagP99Ms: 0, ...over });

test("canonical JSON sorts keys at every depth and keeps array order; the plan hash is over it", () => {
  assert.equal(canonical({ b: 1, a: { d: [2, 1], c: null } }), '{"a":{"c":null,"d":[2,1]},"b":1}');
  assert.equal(planHashOf({ a: 1, b: 2 }), planHashOf({ b: 2, a: 1 }));
  assert.notEqual(planHashOf({ a: 1, b: 2 }), planHashOf({ a: 1, b: 3 }));
  assert.throws(() => canonical({ a: Number.NaN }));
});

test("requestHash is over the canonical RenewFields; the body is those fields plus the hash", () => {
  const f = fields({ debited: 7 });
  const { requestHash, body } = renewBody(f);
  assert.equal(requestHash, sha256(canonical(f)));
  assert.deepEqual(JSON.parse(body), { ...f, requestHash });
  assert.notEqual(renewBody(fields({ debited: 8 })).requestHash, requestHash);
});

test("the claim reply decoder refuses anything malformed, and passes a refusal through", async () => {
  const { port } = await claimed();
  const good = await port.claim(CLAIM, signal);
  assert.equal(decodeClaimReply(good).ok, true, "an exact retry of the claim gets the same answer");
  const mutate = (f: (x: Record<string, any>) => void) => {
    const x = structuredClone(good) as Record<string, any>;
    f(x);
    return decodeClaimReply(x);
  };
  for (const [name, f] of [
    ["not hex planHash", (x) => (x.planHash = "nope")],
    ["an extra grant field", (x) => (x.stop = { mode: "now", reason: "user_stop" })],
    ["a malformed run token", (x) => (x.runToken = "invalid")],
    ["an extra lease field", (x) => (x.lease.lease = "lost")],
    ["a non-hash workload digest", (x) => (x.workload.digest = "invalid")],
    ["lease seq 1", (x) => (x.lease.seq = 1)],
    ["negative ceiling", (x) => (x.lease.ceiling = -1)],
    ["missing binding", (x) => delete x.binding],
    ["binding without tree digest", (x) => delete x.binding.observed.treeDigest],
    ["binding with a second lock digest", (x) => (x.binding.lockDigests["node_modules/.package-lock.json"] = "6".repeat(64))],
    ["a phase rate of zero", (x) => (x.limits.phases.checking.ratePerSecond = 0)],
    ["a phase burst of zero", (x) => (x.limits.phases.measurement.burst = 0)],
    ["a fractional phase total", (x) => (x.limits.phases.measurement.total = 1.5)],
    ["a phase missing a cap", (x) => delete x.limits.phases.checking.maxUsers],
    ["an extra phase cap", (x) => (x.limits.phases.checking.perOrigin = 1)],
    ["an extra phase", (x) => (x.limits.phases.warmup = x.limits.phases.checking)],
    ["origin caps (P1 has none)", (x) => (x.limits.originCaps = { "https://shop.test": 1 })],
    ["an extra workload field", (x) => (x.workload.ref = "main")],
    ["a workload path other than the binding's", (x) => (x.workload.path = "peeps/load/other.workload.yaml")],
    ["a malformed events token", (x) => (x.eventsToken = x.runToken.slice(1))],
    ["a claim id that is not a UUID", (x) => (x.claimId = "claim-1")],
    ["no baseURL", (x) => delete x.baseURL],
    ["renewEveryMs 0", (x) => (x.lease.renewEveryMs = 0)],
  ] as [string, (x: Record<string, any>) => void][]) {
    assert.deepEqual(mutate(f), { ok: false, refused: "malformed" }, name);
  }
  assert.deepEqual(decodeClaimReply({ refused: "rerun" }), { ok: false, refused: "rerun" });
  assert.deepEqual(decodeClaimReply({ refused: "matrix" }), { ok: false, refused: "unknown" }, "a code the wire does not name");
  assert.deepEqual(decodeClaimReply("x"), { ok: false, refused: "malformed" });
  assert.deepEqual(decodeClaimReply(await port.claim({ ...CLAIM, idempotencyKey: "1b5e4a6c-7d1f-4e2a-8b3c-9d4e5f6a7b8c" }, signal)), { ok: false, refused: "duplicate_claim" });
});

test("the fake verifies the claim's binding, each input on its own", async () => {
  for (const over of [{ checkoutSha: "b".repeat(40) }, { observed: { ...BINDING.observed, treeDigest: "8".repeat(64) } }, { observed: { ...BINDING.observed, generatedLockDigest: "8".repeat(64) } }, { lockDigests: { "package-lock.json": "d2".repeat(32) } }, { workload: { ...BINDING.workload, digest: "f2".repeat(32) } }]) {
    const port = new FakeControlPort(SETUP);
    assert.deepEqual(decodeClaimReply(await port.claim({ ...CLAIM, ...over }, signal)), { ok: false, refused: "binding" }, JSON.stringify(over));
  }
  const { grant } = await claimed();
  assert.equal(grant.planHash, planHashOf(PLAN));
  assert.deepEqual(grant.binding, BINDING);
  const port = new FakeControlPort(SETUP);
  assert.deepEqual(decodeClaimReply(await port.claim({ ...CLAIM, lockDigests: { ...CLAIM.lockDigests, "node_modules/.package-lock.json": "6".repeat(64) } } as ClaimRequest, signal)), { ok: false, refused: "malformed" }, "a body outside the strict schema");
});

test("the fake refuses a changed payload, a seq gap and a falling debited; an exact retry is never extended", async () => {
  const { port, grant } = await claimed();
  const send = (f: RenewFields) => port.renew(grant.claimId, grant.runToken, renewBody(f).body, signal);
  const first = (await send(fields({ debited: 5 }))) as Record<string, number>;
  assert.equal(first.seq, 1);
  assert.equal(first.ceiling, 105);
  const retry = (await send(fields({ debited: 5 }))) as Record<string, number>;
  assert.equal(retry.leaseUntilServerMs, first.leaseUntilServerMs, "an exact retry does not extend");
  assert.deepEqual(await send(fields({ debited: 6 })), { refused: "changed_payload" });
  assert.deepEqual(await send(fields({ seq: 3, nonce: "n3", debited: 6 })), { refused: "gap" });
  assert.deepEqual(await send(fields({ seq: 2, nonce: "n2", debited: 4 })), { refused: "debited" });
  assert.equal(((await send(fields({ seq: 2, nonce: "n2", debited: 9 }))) as Record<string, number>).ceiling, 109);
  assert.deepEqual(await port.renew(grant.claimId, "wrong", renewBody(fields({ seq: 3, nonce: "n3" })).body, signal), { refused: "auth" });
  const forged = JSON.stringify({ ...fields({ seq: 3, nonce: "n3", debited: 9 }), requestHash: renewBody(fields({ seq: 3, nonce: "n3", debited: 1 })).requestHash });
  assert.deepEqual(await port.renew(grant.claimId, grant.runToken, forged, signal), { refused: "hash" });
  const closedBody = renewBody(fields({ seq: 5, nonce: "n5", debited: 9, state: "closed" })).body;
  const receipt = (await port.renew(grant.claimId, grant.runToken, closedBody, signal)) as Record<string, unknown>;
  assert.equal(receipt.closed, true, "closed is accepted at any seq above the last applied one");
  assert.equal(receipt.seq, 5);
  assert.equal(receipt.lease, "lost");
  assert.equal(receipt.ttlMs, 0);
  assert.deepEqual(await port.renew(grant.claimId, grant.runToken, closedBody, signal), receipt, "a replay of closed gets the same receipt");
  assert.deepEqual(await send(fields({ seq: 6, nonce: "n6", debited: 9 })), { refused: "closed" });
});

// ---------------------------------------------------------------- replies through the runner's lease

const SERVER0 = 1_800_000_000_000;
const at = (monoMs: number): Clocks => ({ monoMs, wallMs: SERVER0 + monoMs });
const binding = { claimId: "c1", epoch: 3, planHash: "p".repeat(64) };
const claimGrant: ClaimGrant = { binding, nonce: "n0", renewEveryMs: 1500, ttlMs: 5000, ceiling: 100, serverNowMs: SERVER0 + 50, leaseUntilServerMs: SERVER0 + 5050 };
const wire = (over: Record<string, unknown> = {}) => ({ ...binding, seq: 1, nonce: "n1", lease: "held", ttlMs: 5000, ceiling: 150, serverNowMs: SERVER0 + 1100, leaseUntilServerMs: SERVER0 + 6100, ...over });
function applied(raw: unknown) {
  const lease = new RunnerLease(claimGrant, at(0), at(100));
  lease.begin(at(1000), "n1", (seq, nonce) => renewBody(fields({ seq, nonce })));
  const d = decodeRenewReply(raw);
  return d.kind === "reply" ? lease.apply(d.reply, at(1200)) : d;
}

test("a reply for the wrong claim, epoch, plan, seq or nonce is ignored, each on its own", () => {
  assert.equal(applied(wire()).kind, "lease");
  assert.deepEqual(applied(wire({ claimId: "c2" })), { kind: "ignored", reason: "binding" });
  assert.deepEqual(applied(wire({ epoch: 4 })), { kind: "ignored", reason: "binding" });
  assert.deepEqual(applied(wire({ planHash: "q".repeat(64) })), { kind: "ignored", reason: "binding" });
  assert.deepEqual(applied(wire({ seq: 2 })), { kind: "ignored", reason: "seq" });
  assert.deepEqual(applied(wire({ nonce: "n9" })), { kind: "ignored", reason: "nonce" });
  assert.deepEqual(applied({ refused: "gap" }), { kind: "unaddressed" });
  assert.deepEqual(applied(wire({ seq: -1 })), { kind: "unaddressed" });
});

test("a matching malformed reply: one with only a bad field keeps the old grant; a stop, a shorter lease or an unreadable state fails closed", () => {
  assert.deepEqual(applied(wire({ ceiling: "lots" })), { kind: "rejected", reason: "malformed" });
  assert.deepEqual(applied(wire({ ttlMs: null })), { kind: "rejected", reason: "malformed" });
  assert.equal(applied(wire({ ceiling: "lots", stop: { mode: "graceful", reason: "user_stop" } })).kind, "lost", "a stop");
  assert.equal(applied(wire({ ceiling: "lots", leaseUntilServerMs: SERVER0 + 2000 })).kind, "lost", "a shorter lease");
  assert.equal(applied(wire({ lease: "maybe" })).kind, "lost", "an unreadable lease state");
  assert.equal(applied(wire({ stop: { mode: "later" } })).kind, "lost", "an unreadable stop");
  assert.equal(applied(wire({ stop: { mode: "graceful", reason: "owner" } })).kind, "lost", "a stop reason the wire does not name");
});
