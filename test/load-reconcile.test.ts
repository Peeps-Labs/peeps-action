/**
 * The journal and reconciliation (plan v3 §5, §10 `load-reconcile`).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { Journal } from "../src/load/gate/journal";
import { crashRange, EventLedger, receivedOutsideGate } from "../src/load/gate/reconcile";

const META = { turn: 1, origin: "https://shop.test", method: "GET", path: "/" };

test("the journal keeps accepted, received, unresolved and denied apart; debited is accepted + unresolved", () => {
  const j = new Journal();
  for (const seq of [1, 2, 3, 4]) j.begin(seq, META);
  j.accept(1);
  j.receive(1);
  j.accept(2);
  j.receive(3); // a response proves delivery even if the write callback has not run
  j.deny("rate");
  j.deny("rate");
  j.deny("not_allowed");
  assert.deepEqual(j.snapshot(), { debited: 4, accepted: 3, received: 2, unresolved: 1, denied: { rate: 2, not_allowed: 1 } });
  assert.equal(j.state(4), "unresolved", "a write never confirmed stays unresolved");
  j.accept(1);
  j.receive(1);
  assert.deepEqual(j.snapshot(), { debited: 4, accepted: 3, received: 2, unresolved: 1, denied: { rate: 2, not_allowed: 1 } }, "repeats change nothing");
  assert.throws(() => j.begin(2, META), /begun twice/);
  j.accept(99);
  j.receive(99);
  assert.equal(j.snapshot().debited, 4, "an unknown seq is never counted");
  assert.deepEqual(j.handedOff(), [1, 2, 3, 4]);
});

test("received ⊆ handed off: anything the target saw that the gate never wrote is named", () => {
  assert.deepEqual(receivedOutsideGate([1, 2, 3], [1, 3]), []);
  assert.deepEqual(receivedOutsideGate([1, 2, 3], [3, 7, 5, 7]), [5, 7]);
});

test("a crash range runs from the last acknowledged debit to the highest ceiling granted", () => {
  assert.deepEqual(crashRange(120, 245), { atLeast: 120, atMost: 245 });
  assert.deepEqual(crashRange(300, 245), { atLeast: 300, atMost: 300 }, "never below what was acknowledged");
  assert.throws(() => crashRange(-1, 10));
  assert.throws(() => crashRange(1.5, 10));
});

test("events: in order, an exact replay is a no-op, a conflicting replay is refused, and a missing final watermark is missing coverage", () => {
  const l = new EventLedger("s1");
  assert.deepEqual(l.accept({ streamId: "s1", seq: 1, payloadHash: "a" }), { ok: true, replay: false });
  assert.deepEqual(l.accept({ streamId: "s1", seq: 3, payloadHash: "c" }), { ok: false, reason: "gap" });
  assert.deepEqual(l.accept({ streamId: "s2", seq: 2, payloadHash: "b" }), { ok: false, reason: "stream" });
  assert.deepEqual(l.accept({ streamId: "s1", seq: 1, payloadHash: "a" }), { ok: true, replay: true });
  assert.deepEqual(l.accept({ streamId: "s1", seq: 1, payloadHash: "x" }), { ok: false, reason: "conflict" });
  assert.deepEqual(l.accept({ streamId: "s1", seq: 0, payloadHash: "x" }), { ok: false, reason: "malformed" });
  assert.deepEqual(l.coverage(), { batches: 1, watermark: undefined, missing: "final" });
  assert.deepEqual(l.accept({ streamId: "s1", seq: 2, payloadHash: "b", final: { watermark: 42 } }), { ok: true, replay: false });
  assert.deepEqual(l.coverage(), { batches: 2, watermark: 42, missing: undefined });
  assert.deepEqual(l.accept({ streamId: "s1", seq: 3, payloadHash: "c" }), { ok: false, reason: "after_final" });
  assert.deepEqual(l.accept({ streamId: "s1", seq: 2, payloadHash: "b", final: { watermark: 42 } }), { ok: true, replay: true });
});
