/**
 * The journal and reconciliation (plan v3 §5, §10 `load-reconcile`).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { Journal, MAX_JOURNAL_PATH } from "../src/load/gate/journal";
import { crashRange, EventLedger, receivedOutsideGate } from "../src/load/gate/reconcile";

const META = { turn: 1, origin: "https://shop.test", method: "GET", path: "/", address: "93.184.216.34" };

test("the journal keeps accepted, received, unresolved, denied and cut apart; debited is accepted + unresolved", () => {
  const j = new Journal();
  for (const seq of [1, 2, 3, 4]) j.begin(seq, META);
  j.accept(1);
  j.receive(1);
  j.accept(2);
  j.receive(3); // an early response: the target saw the head, not necessarily the body
  j.deny("rate");
  j.deny("rate");
  j.deny("not_allowed");
  j.cut(3, "exchange_timeout");
  j.cut(3, "upstream"); // only the first reason counts
  j.cut(99, "upstream"); // an unknown seq is never cut
  assert.deepEqual(j.snapshot(), { debited: 4, accepted: 2, received: 2, unresolved: 2, denied: { rate: 2, not_allowed: 1 }, cut: { exchange_timeout: 1 } });
  assert.equal(j.entry(3)?.written, "unresolved", "a response does not prove the whole write");
  j.accept(1);
  j.receive(1);
  assert.deepEqual(j.snapshot(), { debited: 4, accepted: 2, received: 2, unresolved: 2, denied: { rate: 2, not_allowed: 1 }, cut: { exchange_timeout: 1 } }, "repeats change nothing");
  assert.throws(() => j.begin(2, META), /out of order/);
  assert.throws(() => j.begin(6, META), /out of order/);
  j.accept(99);
  j.receive(99);
  assert.equal(j.snapshot().debited, 4, "an unknown seq is never counted");
});

test("the journal keeps entries only while open, and bounds what it keeps", () => {
  const j = new Journal();
  for (let seq = 1; seq <= 10_000; seq++) {
    j.begin(seq, { ...META, path: "/" + "x".repeat(1000) });
    j.accept(seq);
    j.receive(seq);
    j.finish(seq);
  }
  assert.equal(j.openCount, 0);
  assert.deepEqual(j.snapshot(), { debited: 10_000, accepted: 10_000, received: 10_000, unresolved: 0, denied: {}, cut: {} });
  j.begin(10_001, { ...META, path: "/" + "y".repeat(1000) });
  j.finish(10_001);
  assert.equal(j.openCount, 1, "an unresolved write stays open after its exchange ends");
  assert.equal(j.entry(10_001)!.meta.path.length, MAX_JOURNAL_PATH);
});

test("receipts: every arrival must be a handed-off seq, once", () => {
  assert.deepEqual(receivedOutsideGate(3, [1, 3]), { unknown: [], repeated: [] });
  assert.deepEqual(receivedOutsideGate(3, [3, 7, 5, 7, 0, 1, 1]), { unknown: [0, 5, 7], repeated: [1, 7] });
});

test("a crash range: debits from the last acknowledged debit, arrivals only from receipts", () => {
  assert.deepEqual(crashRange(120, 100, 245), { debited: { atLeast: 120, atMost: 245 }, arrivals: { atLeast: 100, atMost: 245 } });
  assert.deepEqual(crashRange(300, 0, 245), { debited: { atLeast: 300, atMost: 300 }, arrivals: { atLeast: 0, atMost: 300 } }, "only unresolved writes prove no arrival");
  assert.throws(() => crashRange(-1, 0, 10));
  assert.throws(() => crashRange(1.5, 0, 10));
  assert.throws(() => crashRange(5, 6, 10), /more received/);
});

test("events: in order, an exact replay is a no-op, any change on replay is refused, and a missing final watermark is missing coverage", () => {
  const l = new EventLedger("s1");
  assert.deepEqual(l.accept({ streamId: "s1", seq: 1, payload: "a" }), { ok: true, replay: false });
  assert.deepEqual(l.accept({ streamId: "s1", seq: 3, payload: "c" }), { ok: false, reason: "gap" });
  assert.deepEqual(l.accept({ streamId: "s2", seq: 2, payload: "b" }), { ok: false, reason: "stream" });
  assert.deepEqual(l.accept({ streamId: "s1", seq: 1, payload: "a" }), { ok: true, replay: true });
  assert.deepEqual(l.accept({ streamId: "s1", seq: 1, payload: "x" }), { ok: false, reason: "conflict" });
  assert.deepEqual(l.accept({ streamId: "s1", seq: 1, payload: "a", final: { watermark: 9 } }), { ok: false, reason: "conflict" }, "a final marker added on replay");
  assert.deepEqual(l.accept({ streamId: "s1", seq: 0, payload: "x" }), { ok: false, reason: "malformed" });
  assert.deepEqual(l.coverage(), { batches: 1, watermark: undefined, missing: "final" });
  assert.deepEqual(l.accept({ streamId: "s1", seq: 2, payload: "b", final: { watermark: 42 } }), { ok: true, replay: false });
  assert.deepEqual(l.coverage(), { batches: 2, watermark: 42, missing: undefined });
  assert.deepEqual(l.accept({ streamId: "s1", seq: 3, payload: "c" }), { ok: false, reason: "after_final" });
  assert.deepEqual(l.accept({ streamId: "s1", seq: 2, payload: "b", final: { watermark: 42 } }), { ok: true, replay: true });
  assert.deepEqual(l.accept({ streamId: "s1", seq: 2, payload: "b", final: { watermark: 43 } }), { ok: false, reason: "conflict" }, "a changed watermark");
});
