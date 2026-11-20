/**
 * The supervisor over the fake Peeps and the fake jail (e4 plan v3 §3.2 `load-supervisor`).
 * Every assertion is a count or an order, never a duration.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { rig } from "./support/run-supervisor";

test("a run end to end: Checking passes, measurement completes, renewals drain, the gate closes, the stream ends", async (t) => {
  const r = await rig(t);
  const res = await r.result;
  assert.equal(res.status, "completed", JSON.stringify({ reason: res.reason, failures: res.failures, stderr: r.jails.made[0]?.stderr() }));
  assert.equal(res.checking.turns, 2);
  assert.equal(res.checking.success, 2);
  assert.deepEqual(res.checking.responded, [1, 1]);
  assert.ok(res.measurement.success >= 1);
  assert.equal(res.measurement.failure, 0);
  assert.equal(res.gateClosed, true);
  assert.notEqual(res.final, "missing");
  assert.equal((res.final as { watermark: number }).watermark, res.journal!.debited);
  assert.equal(res.journal!.debited, r.sink.arrivals.length, "every debit reached the target");
  for (const rec of r.port.renewals) assert.notEqual(rec.fields.state, "closed");
  const states = r.port.renewals.map((x) => x.fields.state);
  assert.ok(states.includes("running"));
  assert.ok(r.events.findIndex((e) => e.type === "terminate") < r.events.findIndex((e) => e.type === "gate_closed"));
  assert.equal(res.cleanup, "clean");
});
