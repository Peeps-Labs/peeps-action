/**
 * Gate.admit (plan v3 §5, §10 `load-gate`), on injected clocks.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { Gate, type Clocks, type GateLimits } from "../src/load/gate/admission";

const ORIGIN = "https://shop.test:443";
const limits = (over: Partial<GateLimits> = {}): GateLimits => ({
  origins: [ORIGIN],
  methods: ["GET", "POST"],
  maxUsers: 2,
  maxOutstandingPerTurn: 4,
  ratePerSecond: 10,
  burst: 3,
  runTotal: 100,
  turnDeadlineMs: 60_000,
  runEndMono: 1_000_000,
  ...over,
});
const at = (monoMs: number, wallMs = 1_700_000_000_000 + monoMs): Clocks => ({ monoMs, wallMs });
const LEASE = { monoUntil: 10_000, wallUntil: 1_700_000_010_000, ceiling: 1000 };

function gate(over: Partial<GateLimits> = {}) {
  const g = new Gate(limits(over));
  g.applyLease(LEASE);
  const opened = g.openTurn(at(0));
  assert.ok(opened.ok);
  const req = (method = "GET", origin = ORIGIN) => ({ turn: opened.turn, origin, method });
  return { g, turn: opened.turn, req };
}

/** Admits and resolves as sent, so outstanding never limits. */
function sendOk(g: Gate, r: ReturnType<ReturnType<typeof gate>["req"]>, t: Clocks) {
  const a = g.admit(r, t);
  if (a.ok) g.resolve(a.seq, true);
  return a;
}

test("burst after a long gap is at most burst, and a backwards clock adds nothing", () => {
  const { g, req } = gate();
  for (let i = 0; i < 3; i++) assert.ok(sendOk(g, req(), at(0)).ok);
  assert.deepEqual(g.admit(req(), at(0)), { ok: false, reason: "rate", final: false, retryInMs: 100 });
  // A long gap refills only up to burst.
  let ok = 0;
  for (let i = 0; i < 10; i++) if (sendOk(g, req(), at(5_000)).ok) ok += 1;
  assert.equal(ok, 3);
  assert.equal(sendOk(g, req(), at(4_000)).ok, false, "a clock that ran back refills nothing");
  assert.ok(sendOk(g, req(), at(5_100)).ok, "100 ms at 10/s is one token");
});

test("the ceiling is absolute and counts unresolved handoffs", () => {
  const { g, req } = gate({ burst: 50 });
  g.applyLease({ ...LEASE, ceiling: 3 });
  const a = g.admit(req(), at(1));
  const b = g.admit(req(), at(1));
  assert.ok(a.ok && b.ok);
  g.resolve(a.seq, true);
  assert.ok(g.admit(req(), at(1)).ok, "1 debited + 1 unresolved < 3");
  assert.deepEqual(g.admit(req(), at(1)), { ok: false, reason: "ceiling", final: false });
  assert.equal(g.debited + g.unresolved, 3);
  // A write that never took a byte frees its place; an uncertain one does not.
  g.resolve(b.seq, false);
  assert.equal(g.debited, 1);
  assert.ok(g.admit(req(), at(1)).ok);
  assert.equal(g.admit(req(), at(1)).ok, false);
  // A lower ceiling applies at once.
  g.applyLease({ ...LEASE, ceiling: 1 });
  assert.equal(g.admit(req(), at(1)).ok, false);
});

test("the run total holds across leases, and is final", () => {
  const { g, req } = gate({ runTotal: 2, burst: 50 });
  assert.ok(sendOk(g, req(), at(1)).ok);
  assert.ok(sendOk(g, req(), at(1)).ok);
  assert.deepEqual(g.admit(req(), at(1)), { ok: false, reason: "total", final: true });
  g.applyLease({ ...LEASE, ceiling: 10_000 });
  assert.equal(g.admit(req(), at(1)).ok, false);
});

test("bucket and ceiling are each checked on their own", () => {
  {
    const { g, req } = gate({ burst: 1 });
    g.applyLease({ ...LEASE, ceiling: 1000 });
    assert.ok(sendOk(g, req(), at(1)).ok);
    assert.equal((g.admit(req(), at(1)) as { reason: string }).reason, "rate", "ceiling has room, bucket does not");
  }
  {
    const { g, req } = gate({ burst: 50 });
    g.applyLease({ ...LEASE, ceiling: 1 });
    assert.ok(sendOk(g, req(), at(1)).ok);
    assert.equal((g.admit(req(), at(1)) as { reason: string }).reason, "ceiling", "bucket has room, ceiling does not");
  }
});

test("each clock alone expires the lease", () => {
  const { g, req } = gate({ burst: 50 });
  assert.ok(sendOk(g, req(), at(9_999, LEASE.wallUntil - 1)).ok);
  assert.deepEqual(g.admit(req(), at(10_000, LEASE.wallUntil - 1_000_000)), { ok: false, reason: "lease", final: false }, "monotonic passed, wall stepped back");
  assert.deepEqual(g.admit(req(), at(1, LEASE.wallUntil)), { ok: false, reason: "lease", final: false }, "monotonic stalled, wall stepped forward");
  assert.equal(g.admit(req(), at(10_000, LEASE.wallUntil)).ok, false, "both passed");
});

test("no lease, a revoked lease, or a stop admits nothing", () => {
  const g = new Gate(limits());
  const turn = g.openTurn(at(0));
  assert.ok(turn.ok);
  assert.equal((g.admit({ turn: turn.turn, origin: ORIGIN, method: "GET" }, at(1)) as { reason: string }).reason, "lease");
  g.applyLease(LEASE);
  assert.ok(g.admit({ turn: turn.turn, origin: ORIGIN, method: "GET" }, at(1)).ok);
  g.revokeLease();
  assert.equal((g.admit({ turn: turn.turn, origin: ORIGIN, method: "GET" }, at(1)) as { reason: string }).reason, "lease");
  g.applyLease(LEASE);
  g.stop();
  assert.deepEqual(g.admit({ turn: turn.turn, origin: ORIGIN, method: "GET" }, at(1)), { ok: false, reason: "stopped", final: true });
  g.applyLease(LEASE);
  assert.equal(g.admit({ turn: turn.turn, origin: ORIGIN, method: "GET" }, at(1)).ok, false, "a stop is irreversible");
  assert.deepEqual(g.openTurn(at(1)), { ok: false, reason: "stopped" });
});

test("turn deadline and run end are decided inside admit", () => {
  const { g, req } = gate({ turnDeadlineMs: 500, runEndMono: 9_000, burst: 50 });
  assert.ok(sendOk(g, req(), at(499)).ok);
  assert.deepEqual(g.admit(req(), at(500)), { ok: false, reason: "turn_deadline", final: true });
  const late = g.openTurn(at(8_999));
  assert.ok(late.ok);
  assert.deepEqual(g.admit({ turn: late.turn, origin: ORIGIN, method: "GET" }, at(9_000)), { ok: false, reason: "run_end", final: true });
  assert.deepEqual(g.openTurn(at(9_000)), { ok: false, reason: "run_end" });
});

test("a closed turn is revoked, its unresolved requests still count, and its user slot frees", () => {
  const { g, turn, req } = gate({ maxUsers: 1, burst: 50 });
  assert.deepEqual(g.openTurn(at(1)), { ok: false, reason: "users" });
  const a = g.admit(req(), at(1));
  assert.ok(a.ok);
  g.closeTurn(turn);
  assert.deepEqual(g.admit(req(), at(1)), { ok: false, reason: "turn_closed", final: true });
  assert.equal(g.unresolved, 1);
  const next = g.openTurn(at(2));
  assert.ok(next.ok);
  g.resolve(a.seq, true);
  g.resolve(a.seq, true);
  assert.equal(g.debited, 1, "a repeated resolve is ignored");
  assert.deepEqual(g.admit({ turn: 999, origin: ORIGIN, method: "GET" }, at(2)), { ok: false, reason: "turn_closed", final: true });
});

test("origin, method and outstanding per turn", () => {
  const { g, req } = gate({ maxOutstandingPerTurn: 1, burst: 50 });
  assert.deepEqual(g.admit(req("GET", "https://other.test:443"), at(1)), { ok: false, reason: "origin", final: true });
  assert.deepEqual(g.admit(req("DELETE"), at(1)), { ok: false, reason: "method", final: true });
  const a = g.admit(req(), at(1));
  assert.ok(a.ok);
  assert.deepEqual(g.admit(req(), at(1)), { ok: false, reason: "outstanding", final: false });
  g.resolve(a.seq, true);
  assert.ok(g.admit(req(), at(1)).ok);
});

test("a denial takes no token and counts nothing", () => {
  const { g, req } = gate({ burst: 1 });
  for (let i = 0; i < 5; i++) assert.equal(g.admit(req("DELETE"), at(1)).ok, false);
  assert.equal(g.debited + g.unresolved, 0);
  assert.ok(g.admit(req(), at(1)).ok, "the one token is still there");
});

test("the gate reads no clock and holds no timer", () => {
  const src = readFileSync(path.resolve(__dirname, "../src/load/gate/admission.ts"), "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
  assert.doesNotMatch(src, /Date\.now|performance\.now|setTimeout|setInterval|process\.hrtime|^import (?!type)/m);
});
