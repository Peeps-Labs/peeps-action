/**
 * The supervisor over the fake Peeps and the fake jail (e4 plan v3 §3.2 `load-supervisor`):
 * Checking as a barrier, and executor misbehaviour.
 * Every assertion is a count or an order, never a duration. The suite is split across files so each
 * stays well inside the per-file test timeout.
 */
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { FAST, invariants, rig, scripted, smallPlan, why } from "./support/run-supervisor";

describe("load supervisor: Checking and the executor", { concurrency: 4 }, () => {
  // ---------------------------------------------------------------- Checking is a barrier

  for (const clock of ["wall", "monotonic"] as const) {
    test(`Checking cuts a verified dial at the turn deadline when only the ${clock} clock expires`, async (t) => {
      let shifted = false;
      const r = await rig(t, {
        jail: scripted({}),
        plan: smallPlan({ exportName: "get", users: 1 }),
        setup: { ttlMs: 6000 },
        seams: { constants: { ...FAST, checkingDeadlineMs: 2000 } },
        dial: (inner) => async (...args) => {
          const upstream = await inner(...args);
          if (!shifted) {
            shifted = true;
            if (clock === "wall") r.seam.wallShift = 2500;
            else r.seam.monoShift = 2500;
          }
          return upstream;
        },
      });
      const res = await r.result;
      assert.equal(res.reason, "checking_failed", why(r, res));
      assert.equal(res.journal!.cut.turn_deadline, 1);
      assert.deepEqual(res.handoffs!.unattempted, [1]);
      assert.equal(r.sink.stats.requestBytes, 0);
    });
  }

  test("Checking: turns that report success but sent nothing do not pass", async (t) => {
    const r = await rig(t, { jail: scripted({ PEEPS_SCRIPT: "silent" }) });
    const res = await r.result;
    assert.equal(res.status, "didnt_start");
    assert.equal(res.reason, "checking_failed", why(r, res));
    assert.equal(res.checking.success, 2);
    assert.deepEqual(res.checking.responded, [0, 0]);
    assert.equal(res.measurement.started, 0);
  });

  test("Checking: a journey whose requests the gate refuses does not pass", async (t) => {
    const r = await rig(t, { exportName: "notAllowed", plan: smallPlan({ exportName: "notAllowed" }) });
    const res = await r.result;
    assert.equal(res.reason, "checking_failed", why(r, res));
    assert.equal(r.sink.arrivals.length, 0);
    assert.equal(res.measurement.started, 0);
  });

  test("Checking: a failing journey does not pass", async (t) => {
    const r = await rig(t, { exportName: "throwsUnreadable", plan: smallPlan({ exportName: "throwsUnreadable" }) });
    const res = await r.result;
    assert.equal(res.reason, "checking_failed", why(r, res));
    assert.equal(res.checking.failure, 2);
  });

  test("a scripted executor that makes its own request passes Checking and completes", async (t) => {
    const r = await rig(t, { jail: scripted({ PEEPS_SCRIPT: "request" }) });
    const res = await r.result;
    assert.equal(res.status, "completed", why(r, res));
    assert.equal(res.playwright, "0.0.0-scripted");
    invariants(r, res);
  });

  // ---------------------------------------------------------------- executor misbehaviour

  test("duplicate outcomes are counted and change nothing", async (t) => {
    const r = await rig(t, { jail: scripted({ PEEPS_SCRIPT: "request", PEEPS_DUP: "1" }) });
    const res = await r.result;
    assert.equal(res.status, "completed", why(r, res));
    assert.equal(res.duplicateOutcomes, res.checking.turns + res.measurement.started);
    invariants(r, res);
  });

  test("the executor exits mid-run: executor_exit", async (t) => {
    const r = await rig(t, { plan: smallPlan({ exportName: "get", durationMs: 20_000 }), jail: scripted({ PEEPS_SCRIPT: "request", PEEPS_EXIT_AFTER: "4" }) });
    const res = await r.result;
    assert.equal(res.reason, "executor_exit", why(r, res));
    assert.equal(res.status, "failed");
    invariants(r, res);
  });

  test("a frame only init may send: executor_protocol", async (t) => {
    const r = await rig(t, { plan: smallPlan({ exportName: "get", durationMs: 20_000 }), jail: scripted({ PEEPS_SCRIPT: "request", PEEPS_BAD_AFTER: "3" }) });
    const res = await r.result;
    assert.equal(res.reason, "executor_protocol", why(r, res));
    invariants(r, res);
  });

  test("an oversized frame: executor_protocol", async (t) => {
    const r = await rig(t, { plan: smallPlan({ exportName: "get", durationMs: 20_000 }), jail: scripted({ PEEPS_SCRIPT: "request", PEEPS_BIG_AFTER: "3" }) });
    const res = await r.result;
    assert.equal(res.reason, "executor_protocol", why(r, res));
    invariants(r, res);
  });

  test("an executor that ignores cancel: executor_unresponsive after the turn's deadline and grace", async (t) => {
    const r = await rig(t, { plan: smallPlan({ exportName: "get", durationMs: 20_000 }), jail: scripted({ PEEPS_SCRIPT: "request", PEEPS_IGNORE_AFTER: "3" }) });
    const res = await r.result;
    assert.equal(res.reason, "executor_unresponsive", why(r, res));
    invariants(r, res);
  });
});
