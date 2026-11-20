/**
 * The supervisor over the fake Peeps and the fake jail (e4 plan v3 §3.2 `load-supervisor`):
 * malformed replies and startup.
 * Every assertion is a count or an order, never a duration. The suite is split across files so each
 * stays well inside the per-file test timeout.
 */
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { appendFileSync } from "node:fs";
import path from "node:path";
import { claimBodyProblem } from "../src/load/claim-body";
import { canonical } from "../src/load/control-port";
import { GRANT_REF, invariants, onPhase, rig, scripted, smallPlan, why, WORKLOAD_PATH } from "./support/run-supervisor";

describe("load supervisor: malformed replies and startup", { concurrency: 4 }, () => {
  // ---------------------------------------------------------------- malformed replies

  test("a renew reply with only a bad ceiling keeps the old grant, which runs out: lease lost", async (t) => {
    const r = await rig(t, { plan: smallPlan({ exportName: "get", durationMs: 20_000 }), script: { mangle: (x, seq) => (seq >= 2 ? { ...x, ceiling: "lots" } : x) } });
    const res = await r.result;
    assert.equal(res.status, "lease_lost", why(r, res));
    assert.ok(r.events.some((e) => e.type === "renewal" && e.decision === "rejected"));
    const rejected = res.latency.records.find(([, , , outcome]) => outcome === "rejected");
    assert.ok(rejected);
    assert.equal(rejected[2], null, "a malformed reply was never applied");
    assert.equal(rejected[5], null);
    assert.equal(res.latency.maxMs, null);
    invariants(r, res);
  });

  test("an unreadable stop fails closed: lease lost", async (t) => {
    const r = await rig(t, { plan: smallPlan({ exportName: "get", durationMs: 20_000 }), script: { mangle: (x, seq) => (seq >= 3 ? { ...x, stop: { mode: "later" } } : x) } });
    const res = await r.result;
    assert.equal(res.status, "lease_lost", why(r, res));
    invariants(r, res);
  });

  test("replies for another claim are ignored: nothing is applied and the lease runs out", async (t) => {
    const r = await rig(t, { plan: smallPlan({ exportName: "get", durationMs: 20_000 }), script: { mangle: (x, seq) => (seq >= 2 ? { ...x, claimId: "someone-else" } : x) } });
    const res = await r.result;
    assert.equal(res.status, "lease_lost", why(r, res));
    assert.ok(r.events.some((e) => e.type === "renewal" && e.decision === "ignored"));
    // Paced: an answer that comes back at once is not asked for again in a tight loop.
    assert.ok(r.port.renewals.length <= 100, `renew was sent ${r.port.renewals.length} times`);
    invariants(r, res);
  });

  test("a renew that fails at once is retried at a pace, not in a tight loop, until the lease runs out", async (t) => {
    let calls = 0;
    const r = await rig(t, {
      plan: smallPlan({ exportName: "get", durationMs: 20_000 }),
      observer: onPhase("measurement", (x) => {
        x.port.renew = async () => {
          calls += 1;
          throw new Error("connect ECONNREFUSED");
        };
      }),
    });
    const res = await r.result;
    assert.equal(res.status, "lease_lost", why(r, res));
    assert.ok(calls >= 2, "retried");
    assert.ok(calls <= 100, `renew was sent ${calls} times`);
    invariants(r, res);
  });

  test("immediate ignored renewals leave the event loop live for cancellation", async (t) => {
    const soft = new AbortController();
    const hard = new AbortController();
    let timerRan = false;
    let ignored = 0;
    let timerRanAtTerminate = false;
    const r = await rig(t, {
      signal: soft.signal,
      hardSignal: hard.signal,
      script: { mangle: (reply) => ({ ...reply, claimId: "unrelated" }) },
      observer: (e) => {
        if (e.type === "terminate") timerRanAtTerminate = timerRan;
        if (e.type !== "renewal" || e.decision !== "ignored") return;
        if (++ignored === 1) setTimeout(() => {
          timerRan = true;
          hard.abort();
        }, 0);
        if (ignored === 10) {
          // Bound the regression run without waiting for a lease or accumulating attempts.
          soft.abort();
          hard.abort();
        }
      },
    });
    const res = await r.result;
    assert.equal(res.status, "cancelled", why(r, res));
    assert.ok(timerRanAtTerminate, "the cancellation timer ran while the retry was pending");
    assert.equal(ignored, 1);
  });

  // ---------------------------------------------------------------- startup

  test("a run cancelled before it starts: cancelled, nothing probed, installed or claimed", async (t) => {
    let probes = 0;
    let installs = 0;
    const r = await rig(t, {
      signal: AbortSignal.abort(),
      seams: {
        probe: async () => { probes++; return { passed: true, failures: [], seen: null }; },
        preinstall: async () => { installs++; throw new Error("unexpected install"); },
      },
    });
    const res = await r.result;
    assert.equal(res.status, "cancelled", why(r, res));
    assert.equal(probes, 0);
    assert.equal(installs, 0);
    assert.equal(r.port.claims.length, 0);
    assert.equal(res.cleanup, "not_started");
  });

  test("the claim is P1's strict body: the grant reference, the probe's labels, observed digests", async (t) => {
    const r = await rig(t, { seams: { labels: async () => ({ image: "ubuntu24 20261116.376.1", kernel: "6.8.0-1017-azure", tools: "systemd 255; unshare 2.39.3", chrony: "normal" }) } });
    const res = await r.result;
    assert.equal(res.status, "completed", why(r, res));
    const sent = r.port.claims[0]!;
    assert.equal(claimBodyProblem(canonical(sent)), undefined);
    assert.equal(sent.grantRef, GRANT_REF);
    assert.deepEqual(Object.keys(sent.lockDigests), ["package-lock.json"]);
    assert.match(sent.observed.generatedLockDigest, /^[0-9a-f]{64}$/);
    assert.deepEqual(sent.fence.probe, { passed: true, failures: [], image: "ubuntu24 20261116.376.1", kernel: "6.8.0-1017-azure", tools: "systemd 255; unshare 2.39.3", chrony: "normal" });
  });

  test("a body Peeps' strict schema would refuse is never sent: nothing is claimed", async (t) => {
    const r = await rig(t, { grantRef: "not-a-grant-ref" });
    const res = await r.result;
    assert.equal(res.status, "didnt_start");
    assert.equal(res.reason, "claim_invalid");
    assert.equal(r.port.claims.length, 0);
    assert.equal(r.jails.made.length, 0);
  });

  test("a failed fence probe: nothing is claimed", async (t) => {
    const r = await rig(t, { seams: { probe: async () => ({ passed: false, failures: ["egress"], seen: null }) } });
    const res = await r.result;
    assert.equal(res.status, "didnt_start");
    assert.equal(res.reason, "fence_unverified");
    assert.equal(r.port.claims.length, 0);
    assert.equal(r.jails.made.length, 0);
  });

  test("a refused claim: no jail starts", async (t) => {
    const r = await rig(t, { script: { claimRefused: "rerun" } });
    const res = await r.result;
    assert.equal(res.status, "didnt_start");
    assert.equal(res.reason, "claim_rerun");
    assert.equal(r.jails.made.length, 0);
    assert.equal(r.port.renewals.length, 0);
  });

  test("the checkout differs from what Peeps expects: the claim is refused binding", async (t) => {
    const r = await rig(t, { afterBinding: (ws) => appendFileSync(path.join(ws, "journeys.ts"), "\n// changed\n") });
    const res = await r.result;
    assert.equal(res.reason, "claim_binding", why(r, res));
    assert.equal(r.jails.made.length, 0);
  });

  test("the workload changes between the claim and prepare: checkout_changed, no jail", async (t) => {
    const r = await rig(t, {
      observer: (e, x) => {
        if (e.type === "claimed") appendFileSync(path.join(x.ws, WORKLOAD_PATH), "# edited\n");
      },
    });
    const res = await r.result;
    assert.equal(res.status, "didnt_start");
    assert.equal(res.reason, "checkout_changed", why(r, res));
    assert.equal(r.jails.made.length, 0);
    assert.equal(res.renewals.afterTerminate, 0);
  });

  test("the lease runs out while the jail starts: no ticket is minted, lease lost", async (t) => {
    const r = await rig(t, { script: { silentAfterMs: 0 }, jail: { readyDelayMs: 6_000 } });
    const res = await r.result;
    assert.equal(res.status, "lease_lost", why(r, res));
    assert.equal(r.jails.made[0]?.tickets.length ?? 0, 0, "no ticket after the lease ran out");
    assert.equal(r.sink.arrivals.length, 0);
  });

  test("the lease runs out during the install: no launch ticket", async (t) => {
    const r = await rig(t, { script: { silentAfterMs: 0 }, jail: { installMs: 6_000 } });
    const res = await r.result;
    assert.equal(res.status, "lease_lost", why(r, res));
    assert.deepEqual(r.jails.made[0]!.tickets.map((x) => x.kind), ["start"]);
  });

  test("the control channel closes during startup: the run does not start", async (t) => {
    const r = await rig(t, { jail: { eofAfterReadyMs: 0, installMs: 500 } });
    const res = await r.result;
    assert.equal(res.status, "failed", why(r, res));
    assert.equal(r.sink.arrivals.length, 0);
  });

  test("an executor that does not load in time: loaded_timeout", async (t) => {
    const r = await rig(t, { jail: scripted({ PEEPS_SCRIPT: "mute" }), seams: { constants: { loadedMs: 1500 } as never } });
    const res = await r.result;
    assert.equal(res.reason, "loaded_timeout", why(r, res));
  });

  test("a fatal at load: didn't start, with the message sanitized", async (t) => {
    const r = await rig(t, { jail: scripted({ PEEPS_SCRIPT: "fatal" }) });
    const res = await r.result;
    assert.equal(res.status, "didnt_start");
    assert.equal(res.reason, "executor_journey", why(r, res));
    assert.equal(res.failures.length, 1);
    assert.doesNotMatch(res.failures[0]!.message, /::/);
  });

  // ---------------------------------------------------------------- the harness hosts (e5 plan v3 §4)

  test("a grant naming a host off the harness list is refused outside_harness before the jail starts: nothing launched, nothing sent, a zero-debit closed", async (t) => {
    for (const harnessHosts of [["sink.load-harness.example.com"], ["test"], ["evil-sink.test"], ["sink.test.example.com"]]) {
      const r = await rig(t, { harnessHosts });
      const res = await r.result;
      assert.equal(res.status, "didnt_start", why(r, res));
      assert.equal(res.reason, "outside_harness", JSON.stringify(harnessHosts));
      assert.equal(r.jails.made.length, 0, "no jail was launched");
      assert.equal(res.cleanup, "not_started");
      assert.equal(res.journal, null, "no gate, no proxy");
      assert.deepEqual(r.sink.arrivals, []);
      assert.equal(res.closed.state, "acked");
      assert.equal(r.port.closed!.debited, 0);
    }
  });

  test("a grant whose every origin is on the harness list runs (the list is matched whole, whatever its case)", async (t) => {
    const r = await rig(t, { harnessHosts: ["other.example.com", "SINK.test"] });
    const res = await r.result;
    assert.equal(res.status, "completed", why(r, res));
    invariants(r, res);
  });

  test("a grant with any off-list origin is refused before launch or a sink request", async (t) => {
    let launches = 0;
    const r = await rig(t, {
      harnessHosts: ["sink.test"],
      setup: { baseURL: "https://sink.test" },
      limits: { allowedOrigins: ["https://sink.test", "https://off-list.test"] },
      launch: async () => {
        launches += 1;
        throw new Error("the harness guard must run first");
      },
    });
    const res = await r.result;
    assert.equal(res.reason, "outside_harness", why(r, res));
    assert.equal(res.cleanup, "not_started");
    assert.equal(launches, 0);
    assert.equal(r.sink.arrivals.length, 0);
    assert.equal(res.closed.state, "acked");
    assert.equal(res.closed.debited, 0);
  });
});
