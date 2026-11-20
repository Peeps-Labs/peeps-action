/**
 * The runner's lease (plan v3 §6 "Runner rules", §10 `load-lease`), on injected clocks.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { MAX_REMAINING_MS, RunnerLease, type ClaimGrant, type RenewReply } from "../src/load/lease";
import type { Clocks } from "../src/load/gate/admission";

const SERVER0 = 1_800_000_000_000;
/** The runner's wall clock is 7 s behind the server's. */
const SKEW = 7_000;
const at = (monoMs: number): Clocks => ({ monoMs, wallMs: SERVER0 - SKEW + monoMs });
const binding = { claimId: "c1", epoch: 3, planHash: "p" };
const claim = (over: Partial<ClaimGrant> = {}): ClaimGrant => ({
  binding,
  nonce: "n0",
  renewEveryMs: 1500,
  ttlMs: 5000,
  ceiling: 100,
  serverNowMs: SERVER0 + 50,
  leaseUntilServerMs: SERVER0 + 50 + 5000,
  ...over,
});

/** A renewal body that records the seq it was built for. */
const build = (hash: string) => (seq: number, nonce: string) => ({ requestHash: hash, body: JSON.stringify({ seq, nonce }) });

/** Claim sent at mono 0, answered at mono 100. */
function lease(over: Partial<ClaimGrant> = {}) {
  return new RunnerLease(claim(over), at(0), at(100));
}

const reply = (seq: number, nonce: string, serverNowMs: number, over: Partial<RenewReply> = {}): RenewReply => ({
  ...binding,
  seq,
  nonce,
  lease: "held",
  ttlMs: 5000,
  ceiling: 150,
  serverNowMs,
  leaseUntilServerMs: serverNowMs + 5000,
  ...over,
});

test("the claim's lease runs from the claim's send, and the wall deadline uses the measured offset", () => {
  const l = lease();
  const g = l.grantNow;
  assert.equal(g.monoUntil, 5000);
  // offset = serverNow − mid-point of the local wall times = 50 + SKEW − 50; minus rtt/2 = 50.
  assert.equal(g.wallUntil, SERVER0 + 50 + 5000 - SKEW - 50);
  assert.equal(g.ceiling, 100);
  assert.ok(l.held(at(4999)));
  assert.equal(l.held(at(5000)), false);
});

test("remaining is capped at 6 s, whatever ttl the server grants", () => {
  const l = lease({ ttlMs: 60_000, leaseUntilServerMs: SERVER0 + 50 + 60_000 });
  assert.equal(l.grantNow.monoUntil, MAX_REMAINING_MS);
});

test("a retry at +3 s keeps the deadline from the first send", () => {
  const l = lease();
  const tx = l.begin(at(1000), "n1", build("h1"));
  assert.ok(tx);
  assert.ok(l.mayRetry(at(4000)), "still inside the lease it was sent under");
  const d = l.apply(reply(1, "n1", SERVER0 + 4000), at(4100));
  assert.equal(d.kind, "lease");
  assert.equal(l.grantNow.monoUntil, 1000 + 5000, "firstSend + remaining, not the retry's send");
  assert.equal(l.grantNow.ceiling, 150);
  assert.equal(l.mayRetry(at(4200)), false, "nothing in flight");
});

test("a retry is refused once the lease it was sent under has run out", () => {
  const l = lease();
  l.begin(at(1000), "n1", build("h1"));
  assert.equal(l.mayRetry(at(5000)), false);
});

test("replies for another claim, epoch, plan, seq or nonce are ignored and change nothing", () => {
  const l = lease();
  l.begin(at(1000), "n1", build("h1"));
  const before = l.grantNow;
  assert.deepEqual(l.apply({ ...reply(1, "n1", SERVER0 + 1100), claimId: "other" }, at(1200)), { kind: "ignored", reason: "binding" });
  assert.deepEqual(l.apply({ ...reply(1, "n1", SERVER0 + 1100), epoch: 2 }, at(1200)), { kind: "ignored", reason: "binding" });
  assert.deepEqual(l.apply({ ...reply(1, "n1", SERVER0 + 1100), planHash: "q" }, at(1200)), { kind: "ignored", reason: "binding" });
  assert.deepEqual(l.apply(reply(2, "n1", SERVER0 + 1100), at(1200)), { kind: "ignored", reason: "seq" });
  assert.deepEqual(l.apply(reply(1, "nX", SERVER0 + 1100), at(1200)), { kind: "ignored", reason: "nonce" });
  assert.deepEqual(l.grantNow, before);
  assert.equal(l.apply(reply(1, "n1", SERVER0 + 1100), at(1200)).kind, "lease", "the real answer still counts");
  assert.deepEqual(l.apply(reply(1, "n1", SERVER0 + 1100), at(1300)), { kind: "ignored", reason: "seq" }, "a replayed answer is ignored");
});

test("a reply to an older seq is ignored", () => {
  const l = lease();
  l.begin(at(1000), "n1", build("h1"));
  assert.equal(l.apply(reply(1, "n1", SERVER0 + 1100), at(1200)).kind, "lease");
  l.begin(at(2500), "n2", build("h2"));
  assert.deepEqual(l.apply(reply(1, "n1", SERVER0 + 1100), at(2600)), { kind: "ignored", reason: "seq" });
});

test("a reply read after its own deadline, or after the held lease, loses it", () => {
  {
    // Sent at 1000; the server grants only 1 s; read at 2100: past firstSend + remaining.
    const l = lease();
    l.begin(at(1000), "n1", build("h1"));
    const late = reply(1, "n1", SERVER0 + 1100, { leaseUntilServerMs: SERVER0 + 2100 });
    assert.deepEqual(l.apply(late, at(2100)), { kind: "lost", stop: undefined });
    assert.equal(l.held(at(2101)), false, "the server may have shortened it: the old grant does not outlive the answer");
  }
  {
    const l = lease();
    l.begin(at(1000), "n1", build("h1"));
    assert.equal(l.apply(reply(1, "n1", SERVER0 + 1100), at(5000)).kind, "lost", "the event loop was blocked past the lease");
    assert.equal(l.held(at(5001)), false);
    assert.equal(l.begin(at(5001), "n2", build("h2")), null);
  }
});

test("a server clock that runs back loses the lease", () => {
  const l = lease();
  l.begin(at(1000), "n1", build("h1"));
  assert.equal(l.apply(reply(1, "n1", SERVER0 + 1100), at(1200)).kind, "lease");
  l.begin(at(2500), "n2", build("h2"));
  assert.deepEqual(l.apply(reply(2, "n2", SERVER0 + 1000), at(2600)), { kind: "lost", stop: undefined });
});

test("lost, a hard stop, and an empty remaining lose the lease; a graceful stop is passed on", () => {
  const stop = { mode: "now" as const, reason: "owner" };
  for (const r of [reply(1, "n1", SERVER0 + 1100, { lease: "lost" }), reply(1, "n1", SERVER0 + 1100, { stop }), reply(1, "n1", SERVER0 + 1100, { leaseUntilServerMs: SERVER0 + 1100 })]) {
    const l = lease();
    l.begin(at(1000), "n1", build("h1"));
    assert.equal(l.apply(r, at(1200)).kind, "lost");
    assert.equal(l.lost, true);
    assert.equal(l.grantNow.monoUntil, Number.NEGATIVE_INFINITY);
  }
  const l = lease();
  l.begin(at(1000), "n1", build("h1"));
  const drain = { mode: "graceful" as const, reason: "drain" };
  // While draining the server caps the deadline at the grace end; the runner takes the shorter grant.
  const d = l.apply(reply(1, "n1", SERVER0 + 1100, { stop: drain, leaseUntilServerMs: SERVER0 + 1100 + 2000 }), at(1200));
  assert.deepEqual(d.kind === "lease" && d.stop, drain);
  assert.equal(l.grantNow.monoUntil, 1000 + 2000);
});

test("one renewal at a time; a hung request closes the gate without waiting for HTTP", () => {
  const l = lease();
  assert.ok(l.begin(at(1000), "n1", build("h1")));
  assert.equal(l.begin(at(1001), "n2", build("h2")), null);
  l.abandon();
  assert.equal(l.lost, true);
  assert.equal(l.held(at(1002)), false);
  assert.equal(l.apply(reply(1, "n1", SERVER0 + 1100), at(1200)).kind, "ignored", "an answer after abandon is not this renewal's");
});

test("the next send waits for the answer and at most renewEvery or half the remaining time", () => {
  const l = lease();
  assert.equal(l.nextSendAt(1000, 1200), 2500);
  assert.equal(l.nextSendAt(1000, 2900), 2900);
  const short = lease({ ttlMs: 2000, leaseUntilServerMs: SERVER0 + 50 + 2000 });
  assert.equal(short.nextSendAt(0, 10), 1000);
});

test("a claim answered after its own lease is lost from the start", () => {
  const l = new RunnerLease(claim(), at(0), at(5000));
  assert.equal(l.lost, true);
});

test("an unknown lease value loses the lease; a malformed reply is rejected and changes nothing", () => {
  {
    const l = lease();
    l.begin(at(1000), "n1", build("h1"));
    assert.equal(l.apply(reply(1, "n1", SERVER0 + 1100, { lease: "revoked" as "held" }), at(1200)).kind, "lost");
  }
  for (const bad of [{ ceiling: undefined as unknown as number }, { ceiling: 1.5 }, { ceiling: -1 }, { ttlMs: Number.NaN }, { leaseUntilServerMs: Number.POSITIVE_INFINITY }]) {
    const l = lease();
    l.begin(at(1000), "n1", build("h1"));
    const before = l.grantNow;
    assert.deepEqual(l.apply(reply(1, "n1", SERVER0 + 1100, bad), at(1200)), { kind: "rejected", reason: "malformed" }, JSON.stringify(bad));
    assert.deepEqual(l.grantNow, before);
  }
  assert.equal(lease({ ceiling: Number.NaN }).lost, true, "a malformed claim is lost from the start");
});

test("an unusable answer loses the lease and still passes on its stop", () => {
  const l = lease();
  l.begin(at(1000), "n1", build("h1"));
  assert.equal(l.apply(reply(1, "n1", SERVER0 + 1100), at(1200)).kind, "lease");
  l.begin(at(2500), "n2", build("h2"));
  const drain = { mode: "graceful" as const, reason: "drain" };
  assert.deepEqual(l.apply(reply(2, "n2", SERVER0 + 1000, { stop: drain }), at(2600)), { kind: "lost", stop: drain });
});

test("the wall deadline is capped at remaining from the first send too", () => {
  const l = lease({ ttlMs: 60_000, leaseUntilServerMs: SERVER0 + 50 + 60_000 });
  assert.equal(l.grantNow.wallUntil, at(0).wallMs + MAX_REMAINING_MS);
  l.begin(at(1000), "n1", build("h1"));
  assert.equal(l.apply(reply(1, "n1", SERVER0 + 1100, { ttlMs: 60_000, leaseUntilServerMs: SERVER0 + 61_100 }), at(1200)).kind, "lease");
  assert.equal(l.grantNow.wallUntil, at(1000).wallMs + MAX_REMAINING_MS);
});

test("a lost lease is a newer grant, so a gate fed from grantNow revokes", async () => {
  const { Gate } = await import("../src/load/gate/admission");
  const g = new Gate({ origins: { o: 10 }, methods: ["GET"], maxOutstandingPerTurn: 5, runTotal: 10, turnDeadlineMs: 60_000, runEndMono: 1e9, phase: { ratePerSecond: 10, burst: 5, maxUsers: 1, total: 10 } });
  const l = lease();
  g.applyLease(l.grantNow);
  const turn = g.openTurn("s", at(1));
  assert.ok(turn.ok);
  assert.ok(g.permit({ turn: turn.turn, origin: "o", method: "GET" }, at(1)).ok);
  l.abandon();
  g.applyLease(l.grantNow);
  assert.equal(g.permit({ turn: turn.turn, origin: "o", method: "GET" }, at(2)).ok, false);
});

test("a malformed reply that carries a stop loses the lease", () => {
  const l = lease();
  l.begin(at(1000), "n1", build("h1"));
  const drain = { mode: "graceful" as const, reason: "drain" };
  assert.deepEqual(l.apply(reply(1, "n1", SERVER0 + 1100, { ceiling: Number.NaN, stop: drain }), at(1200)), { kind: "lost", stop: drain });
  assert.equal(lease({ renewEveryMs: 0 }).lost, true, "a claim with no renewal interval is lost");
});

test("the lease reads no clock and holds no timer", () => {
  const src = readFileSync(path.resolve(__dirname, "../src/load/lease.ts"), "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
  assert.doesNotMatch(src, /Date\.now|performance\.now|setTimeout|setInterval|process\.hrtime/);
});

test("begin hands build the seq it allocates, and stores the hash and the frozen bytes once", () => {
  const l = lease();
  const seen: [number, string][] = [];
  const tx = l.begin(at(1000), "n1", (seq, nonce) => {
    seen.push([seq, nonce]);
    return { requestHash: `h${seq}`, body: `body ${seq}` };
  });
  assert.ok(tx);
  assert.deepEqual(seen, [[1, "n1"]]);
  assert.equal(tx.seq, 1);
  assert.equal(tx.requestHash, "h1");
  assert.equal(tx.body, "body 1");
  assert.ok(Object.isFrozen(tx), "the outstanding renewal is frozen, its body a string");
  assert.throws(() => ((tx as { body: string }).body = "changed"));
  assert.equal(l.outstanding!.body, "body 1", "a retry sends the same bytes");
  assert.equal(l.begin(at(1001), "n2", () => assert.fail("build is not called while one is in flight")), null);
  assert.equal(l.apply(reply(1, "n1", SERVER0 + 1100), at(1200)).kind, "lease");
  const next = l.begin(at(2500), "n2", (seq) => ({ requestHash: `h${seq}`, body: "" }));
  assert.equal(next?.seq, 2);
});

test("Stop now survives apply when the grant was live on receipt, and not when it had run out", () => {
  const now = { mode: "now" as const, reason: "owner" };
  {
    const l = lease();
    l.begin(at(1000), "n1", build("h1"));
    assert.deepEqual(l.apply(reply(1, "n1", SERVER0 + 1100, { stop: now }), at(1200)), { kind: "lost", stop: now });
  }
  {
    const l = lease();
    l.begin(at(1000), "n1", build("h1"));
    const d = l.apply(reply(1, "n1", SERVER0 + 1100, { stop: now }), at(5000));
    assert.deepEqual(d, { kind: "lost", stop: undefined }, "read after the lease ran out: a loss, not a stop");
  }
});

test("an unreadable server clock cannot hide a shorter readable TTL", () => {
  const l = lease();
  assert.ok(l.begin(at(1000), "n1", build("h1")));
  const shortened = reply(1, "n1", SERVER0 + 1100, { serverNowMs: NaN, ttlMs: 100 });
  assert.equal(l.apply(shortened, at(1050)).kind, "lost");
  assert.equal(l.held(at(1050)), false);
});
