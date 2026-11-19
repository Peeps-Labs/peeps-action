/**
 * Gate.admit (plan v3 §5, §10 `load-gate`), on injected clocks.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { Gate, type Clocks, type GateLimits, type PhaseCaps } from "../src/load/gate/admission";

const ORIGIN = "https://shop.test:443";
const OTHER = "https://api.shop.test:443";
const phase = (over: Partial<PhaseCaps> = {}): PhaseCaps => ({ ratePerSecond: 10, burst: 3, maxUsers: 2, total: 1000, ...over });
const limits = (over: Partial<GateLimits> = {}, ph: Partial<PhaseCaps> = {}): GateLimits => ({
  origins: { [ORIGIN]: 1000, [OTHER]: 1000 },
  methods: ["GET", "POST"],
  maxOutstandingPerTurn: 4,
  runTotal: 100,
  turnDeadlineMs: 60_000,
  runEndMono: 1_000_000,
  phase: phase(ph),
  ...over,
});
const at = (monoMs: number, wallMs = 1_700_000_000_000 + monoMs): Clocks => ({ monoMs, wallMs });
const LEASE = { monoUntil: 10_000, wallUntil: 1_700_000_010_000, ceiling: 1000 };
let leaseSeq = 0;
let slotN = 0;
/** A fresh grant, newer than any before it. */
const grant = (over: Partial<typeof LEASE> = {}) => ({ ...LEASE, ...over, seq: ++leaseSeq });
const reason = (a: ReturnType<Gate["admit"]>) => (a.ok ? "ok" : a.reason);

function gate(over: Partial<GateLimits> = {}, ph: Partial<PhaseCaps> = {}) {
  const g = new Gate(limits(over, ph));
  g.applyLease(grant());
  const opened = g.openTurn(`s${++slotN}`, at(0));
  assert.ok(opened.ok);
  const req = (method = "GET", origin = ORIGIN) => ({ turn: opened.turn, origin, method });
  return { g, turn: opened.turn, req };
}

/** Admits, sends and finishes, so outstanding never limits. */
function sendOk(g: Gate, r: ReturnType<ReturnType<typeof gate>["req"]>, t: Clocks) {
  const a = g.admit(r, t);
  if (a.ok) {
    g.resolve(a.seq, true);
    g.finish(a.seq);
  }
  return a;
}

test("burst after a long gap is at most burst, and a backwards clock adds nothing", () => {
  const { g, req } = gate();
  for (let i = 0; i < 3; i++) assert.ok(sendOk(g, req(), at(0)).ok);
  assert.deepEqual(g.admit(req(), at(0)), { ok: false, reason: "rate", final: false, retryInMs: 100 });
  let ok = 0;
  for (let i = 0; i < 10; i++) if (sendOk(g, req(), at(5_000)).ok) ok += 1;
  assert.equal(ok, 3);
  assert.equal(sendOk(g, req(), at(4_000)).ok, false, "a clock that ran back refills nothing");
  assert.ok(sendOk(g, req(), at(5_100)).ok, "100 ms at 10/s is one token");
});

test("the ceiling is absolute: every admitted request counts, sent or not, finished or not", () => {
  const { g, req } = gate({}, { burst: 50 });
  g.applyLease(grant({ ceiling: 3 }));
  const a = g.admit(req(), at(1));
  const b = g.admit(req(), at(1));
  assert.ok(a.ok && b.ok);
  g.resolve(a.seq, true);
  g.finish(a.seq);
  g.resolve(b.seq, false);
  assert.ok(g.admit(req(), at(1)).ok);
  assert.deepEqual(g.admit(req(), at(1)), { ok: false, reason: "ceiling", final: false });
  assert.equal(g.admitted, 3);
  assert.equal(g.sent, 1);
  assert.equal(g.unresolved, 1);
});

test("a lower ceiling applies at once", () => {
  const { g, req } = gate({ maxOutstandingPerTurn: 10 }, { burst: 50 });
  g.applyLease(grant({ ceiling: 5 }));
  for (let i = 0; i < 4; i++) assert.ok(g.admit(req(), at(1)).ok);
  g.applyLease(grant({ ceiling: 1 }));
  assert.deepEqual(g.admit(req(), at(1)), { ok: false, reason: "ceiling", final: false });
});

test("a malformed limit admits nothing", () => {
  for (const ceiling of [Number.NaN, undefined as unknown as number, 0.5, -1]) {
    const { g, req } = gate({}, { burst: 50 });
    g.applyLease(grant({ ceiling }));
    assert.equal(g.admit(req(), at(1)).ok, false, String(ceiling));
  }
  {
    const { g, req } = gate();
    g.applyLease(grant({ monoUntil: Number.NaN }));
    assert.equal(reason(g.admit(req(), at(1))), "lease");
  }
  assert.throws(() => new Gate(limits({ runTotal: Number.NaN })));
  assert.throws(() => new Gate(limits({ runTotal: 2.5 })));
  assert.throws(() => new Gate(limits({ runEndMono: Number.POSITIVE_INFINITY })));
  assert.throws(() => new Gate(limits({ origins: { [ORIGIN]: Number.NaN } })));
  assert.throws(() => new Gate(limits({}, { burst: 0 })));
  assert.throws(() => new Gate(limits({}, { total: 1.5 })));
  assert.throws(() => new Gate(limits({}, { ratePerSecond: Number.POSITIVE_INFINITY })));
});

test("the run total holds across leases, and is final", () => {
  const { g, req } = gate({ runTotal: 2 }, { burst: 50 });
  assert.ok(sendOk(g, req(), at(1)).ok);
  assert.ok(sendOk(g, req(), at(1)).ok);
  assert.deepEqual(g.admit(req(), at(1)), { ok: false, reason: "total", final: true });
  g.applyLease(grant({ ceiling: 10_000 }));
  assert.equal(g.admit(req(), at(1)).ok, false);
});

test("bucket and ceiling are each checked on their own", () => {
  {
    const { g, req } = gate({}, { burst: 1 });
    assert.ok(sendOk(g, req(), at(1)).ok);
    assert.equal(reason(g.admit(req(), at(1))), "rate", "ceiling has room, bucket does not");
  }
  {
    const { g, req } = gate({}, { burst: 50 });
    g.applyLease(grant({ ceiling: 1 }));
    assert.ok(sendOk(g, req(), at(1)).ok);
    assert.equal(reason(g.admit(req(), at(1))), "ceiling", "bucket has room, ceiling does not");
  }
});

test("each clock alone expires the lease", () => {
  {
    const { g, req } = gate({}, { burst: 50 });
    assert.ok(sendOk(g, req(), at(9_999, LEASE.wallUntil - 1)).ok);
  }
  {
    const { g, req } = gate({}, { burst: 50 });
    assert.deepEqual(g.admit(req(), at(10_000, LEASE.wallUntil - 1_000_000)), { ok: false, reason: "lease", final: false }, "monotonic passed, wall stepped back");
  }
  {
    const { g, req } = gate({}, { burst: 50 });
    assert.deepEqual(g.admit(req(), at(1, LEASE.wallUntil)), { ok: false, reason: "lease", final: false }, "monotonic stalled, wall stepped forward");
  }
});

test("a lease seen expired stays expired when a clock steps back, and no grant reopens it", () => {
  const { g, req } = gate({}, { burst: 50 });
  const old = grant();
  g.applyLease(old);
  assert.equal(reason(g.admit(req(), at(1, LEASE.wallUntil))), "lease");
  assert.equal(reason(g.admit(req(), at(1, LEASE.wallUntil - 5_000))), "lease", "the wall clock stepped back");
  g.applyLease(old);
  assert.equal(reason(g.admit(req(), at(1, LEASE.wallUntil - 5_000))), "lease", "the same grant again is ignored");
  g.applyLease(grant());
  assert.equal(reason(g.admit(req(), at(1, LEASE.wallUntil - 5_000))), "lease", "a newer grant does not reopen an expired gate");
});

test("an expired lease is lost for good: a later grant does not reopen the gate", () => {
  const { g, req } = gate({}, { burst: 50 });
  assert.equal(reason(g.admit(req(), at(1, LEASE.wallUntil))), "lease");
  g.applyLease(grant());
  assert.equal(reason(g.admit(req(), at(1, LEASE.wallUntil - 5_000))), "lease");
});

test("malformed grants and phases are refused", () => {
  for (const bad of [{ monoUntil: Number.POSITIVE_INFINITY }, { wallUntil: Number.POSITIVE_INFINITY }]) {
    const { g, req } = gate({}, { burst: 50 });
    g.applyLease(grant(bad));
    assert.equal(reason(g.admit(req(), at(1))), "lease", JSON.stringify(bad));
  }
  {
    const { g, req } = gate({}, { burst: 50 });
    g.applyLease({ ...LEASE, seq: Number.POSITIVE_INFINITY });
    assert.equal(reason(g.admit(req(), at(1))), "lease");
    g.applyLease(grant());
    assert.ok(g.admit(req(), at(1)).ok, "a valid later grant still applies");
  }
  assert.throws(() => new Gate(limits({ phase: { ratePerSecond: 10, maxUsers: 1, total: 10 } as PhaseCaps })), /burst/);
  const { g } = gate();
  assert.throws(() => g.setPhase({ ratePerSecond: 1, burst: 1, maxUsers: 1 } as PhaseCaps, at(1)), /total/);
});

test("a phase with fewer users holds the live turns until enough close", () => {
  const { g, turn, req } = gate({}, { burst: 50, maxUsers: 2 });
  const second = g.openTurn("other", at(1));
  assert.ok(second.ok);
  g.setPhase(phase({ burst: 50, maxUsers: 1 }), at(1));
  assert.equal(reason(g.admit(req(), at(1))), "users");
  g.closeTurn(second.turn);
  assert.ok(g.admit(req(), at(1)).ok);
  g.setPhase(phase({ burst: 50, maxUsers: 0 }), at(1));
  assert.equal(reason(g.admit({ turn, origin: ORIGIN, method: "GET" }, at(1))), "users");
});

test("a slot has one live turn", () => {
  const { g } = gate();
  const a = g.openTurn("user-1", at(1));
  assert.ok(a.ok);
  assert.deepEqual(g.openTurn("user-1", at(1)), { ok: false, reason: "slot_busy" });
  g.closeTurn(a.turn);
  assert.ok(g.openTurn("user-1", at(1)).ok);
});

test("with both clocks frozen, admissions are bounded by burst and the ceiling", () => {
  for (const [burst, ceiling] of [[3, 100], [50, 5]] as const) {
    const { g, req } = gate({}, { burst });
    g.applyLease(grant({ ceiling }));
    let ok = 0;
    for (let i = 0; i < 1000; i++) if (sendOk(g, req(), at(5)).ok) ok += 1;
    assert.equal(ok, Math.min(burst, ceiling));
  }
});

test("no lease, a revoked lease, or a stop admits nothing", () => {
  const g = new Gate(limits());
  const turn = g.openTurn(`s${++slotN}`, at(0));
  assert.ok(turn.ok);
  const r = { turn: turn.turn, origin: ORIGIN, method: "GET" };
  assert.equal(reason(g.admit(r, at(1))), "lease");
  g.applyLease(grant());
  assert.ok(g.admit(r, at(1)).ok);
  g.revokeLease();
  assert.equal(reason(g.admit(r, at(1))), "lease");
  g.applyLease(grant());
  g.stop();
  assert.deepEqual(g.admit(r, at(1)), { ok: false, reason: "stopped", final: true });
  g.applyLease(grant());
  assert.equal(g.admit(r, at(1)).ok, false, "a stop is irreversible");
  assert.deepEqual(g.openTurn(`s${++slotN}`, at(1)), { ok: false, reason: "stopped" });
});

test("draining keeps existing turns and opens no new one", () => {
  const { g, req } = gate();
  g.drain();
  assert.deepEqual(g.openTurn(`s${++slotN}`, at(1)), { ok: false, reason: "draining" });
  assert.ok(sendOk(g, req(), at(1)).ok);
});

test("turn deadline and run end are decided inside admit", () => {
  const { g, req } = gate({ turnDeadlineMs: 500, runEndMono: 9_000 }, { burst: 50 });
  assert.ok(sendOk(g, req(), at(499)).ok);
  assert.deepEqual(g.admit(req(), at(500)), { ok: false, reason: "turn_deadline", final: true });
  const late = g.openTurn(`s${++slotN}`, at(8_999));
  assert.ok(late.ok);
  assert.deepEqual(g.admit({ turn: late.turn, origin: ORIGIN, method: "GET" }, at(9_000)), { ok: false, reason: "run_end", final: true });
  assert.deepEqual(g.openTurn(`s${++slotN}`, at(9_000)), { ok: false, reason: "run_end" });
});

test("a closed turn is revoked and its user slot frees", () => {
  const { g, turn, req } = gate({}, { maxUsers: 1, burst: 50 });
  assert.deepEqual(g.openTurn(`s${++slotN}`, at(1)), { ok: false, reason: "users" });
  const a = g.admit(req(), at(1));
  assert.ok(a.ok);
  g.closeTurn(turn);
  assert.deepEqual(g.admit(req(), at(1)), { ok: false, reason: "turn_closed", final: true });
  assert.equal(g.inFlight, 1);
  assert.ok(g.openTurn(`s${++slotN}`, at(2)).ok);
  g.resolve(a.seq, true);
  g.resolve(a.seq, true);
  assert.equal(g.sent, 1, "a repeated resolve is ignored");
  g.finish(a.seq);
  assert.equal(g.inFlight, 0);
  assert.deepEqual(g.admit({ turn: 999, origin: ORIGIN, method: "GET" }, at(2)), { ok: false, reason: "turn_closed", final: true });
});

test("delivery and the end of the exchange are separate: only finish frees the turn's place", () => {
  const { g, req } = gate({ maxOutstandingPerTurn: 1 }, { burst: 50 });
  const a = g.admit(req(), at(1));
  assert.ok(a.ok);
  g.resolve(a.seq, true);
  assert.equal(g.unresolved, 0);
  assert.equal(reason(g.admit(req(), at(1))), "outstanding", "sent, but the response has not ended");
  g.finish(a.seq);
  const b = g.admit(req(), at(1));
  assert.ok(b.ok);
  g.resolve(b.seq, false);
  assert.ok(g.admit(req(), at(1)).ok, "a write that took no byte has no exchange to wait for");
});

test("origin, method and the per-origin total", () => {
  const { g, req } = gate({ origins: { [ORIGIN]: 2, [OTHER]: 10 } }, { burst: 50 });
  assert.deepEqual(g.admit(req("GET", "https://other.test:443"), at(1)), { ok: false, reason: "origin", final: true });
  assert.deepEqual(g.admit(req("GET", "constructor"), at(1)), { ok: false, reason: "origin", final: true }, "no prototype key is an origin");
  assert.deepEqual(g.admit(req("DELETE"), at(1)), { ok: false, reason: "method", final: true });
  assert.ok(sendOk(g, req(), at(1)).ok);
  assert.ok(sendOk(g, req(), at(1)).ok);
  assert.deepEqual(g.admit(req(), at(1)), { ok: false, reason: "origin_total", final: true });
  assert.ok(sendOk(g, req("GET", OTHER), at(1)).ok, "another origin still admits");
});

test("a phase change never adds tokens, and each phase has its own total and users", () => {
  const { g, req } = gate({}, { ratePerSecond: 10, burst: 10, total: 1000 });
  assert.ok(sendOk(g, req(), at(0)).ok);
  g.setPhase(phase({ ratePerSecond: 1, burst: 2, maxUsers: 1, total: 3 }), at(1_000));
  let ok = 0;
  for (let i = 0; i < 10; i++) if (sendOk(g, req(), at(1_000)).ok) ok += 1;
  assert.equal(ok, 2, "clamped to the new burst");
  assert.equal(reason(g.admit(req(), at(1_500))), "rate");
  assert.ok(sendOk(g, req(), at(2_000)).ok, "one per second");
  assert.deepEqual(g.admit(req(), at(9_000)), { ok: false, reason: "phase_total", final: false }, "the next phase may admit it");
  assert.deepEqual(g.openTurn(`s${++slotN}`, at(9_000)), { ok: false, reason: "users" }, "one turn is already live");
});

test("a denial takes no token and counts nothing", () => {
  const { g, req } = gate({}, { burst: 1 });
  for (let i = 0; i < 5; i++) assert.equal(g.admit(req("DELETE"), at(1)).ok, false);
  assert.equal(g.admitted, 0);
  assert.ok(g.admit(req(), at(1)).ok, "the one token is still there");
});

test("the gate reads no clock and holds no timer", () => {
  const src = readFileSync(path.resolve(__dirname, "../src/load/gate/admission.ts"), "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
  assert.doesNotMatch(src, /Date\.now|performance\.now|setTimeout|setInterval|process\.hrtime|^import (?!type)/m);
});
