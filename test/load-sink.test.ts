/**
 * The run's limits, held where they matter: at the target (e4 plan v3 §3.2 `load-sink`). The
 * whole supervisor on the fake jail, and on the real jail with LOAD_JAIL_TESTS=1. Counts at the
 * sink only.
 */
import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import type { ServerResponse } from "node:http";
import { OUTSTANDING_PER_TURN } from "../src/load/engine-limits";
import type { LoadResult } from "../src/load/supervisor";
import { respond as fixtureRespond } from "./support/e4-fixtures";
import type { Arrival } from "./support/load-sink";
import { FAST, installedWorkspace, invariants, rig, smallPlan, type Rig, type RigOptions } from "./support/run-supervisor";

const enabled = process.env.LOAD_JAIL_TESTS === "1";
const JAILS = [
  { name: "fake jail", real: false, options: {} },
  { name: "real jail", real: true, options: { skip: enabled ? false : "set LOAD_JAIL_TESTS=1 on a Linux runner with sudo and systemd", timeout: 600_000 } },
];

async function start(t: TestContext, real: boolean, o: RigOptions): Promise<Rig> {
  if (!real) return rig(t, o);
  const ws = await installedWorkspace();
  t.after(() => rmSync(ws, { recursive: true, force: true }));
  return rig(t, { ...o, ws, real: true, seams: { constants: { ...FAST, loadedMs: 120_000, checkingDeadlineMs: 60_000 } } });
}

const why = (res: LoadResult) => JSON.stringify({ status: res.status, reason: res.reason, failures: res.failures.slice(0, 3), checking: res.checking, measurement: res.measurement });

for (const jail of JAILS) {
  test(`concurrency is held at the sink, measured by overlap (${jail.name})`, jail.options, async (t) => {
    let open = 0;
    let most = 0;
    const r = await start(t, jail.real, {
      plan: smallPlan({ exportName: "twelveAtOnce", users: 2, durationMs: 3_000, perJourneyMax: 12 }),
      respond: (a: Arrival, res: ServerResponse) => {
        open += 1;
        most = Math.max(most, open);
        setTimeout(() => {
          open -= 1;
          fixtureRespond(a, res);
        }, 150);
      },
    });
    const res = await r.result;
    assert.equal(res.status, "completed", why(res));
    assert.ok(most >= 2, "requests did overlap");
    assert.ok(most <= 2 * OUTSTANDING_PER_TURN, `at most ${2 * OUTSTANDING_PER_TURN} at once, saw ${most}`);
    invariants(r, res);
  });

  test(`rate and burst are held at the sink (${jail.name})`, jail.options, async (t) => {
    const at: number[] = [];
    // 2 users × 10 per journey every second: 20 a second, a burst of 20.
    const r = await start(t, jail.real, {
      plan: smallPlan({ exportName: "getTen", users: 2, durationMs: 4_000, perJourneyMax: 10 }),
      respond: (a, res) => {
        at.push(Date.now());
        fixtureRespond(a, res);
      },
    });
    const res = await r.result;
    assert.equal(res.status, "completed", why(res));
    const rate = 20;
    const burst = 20;
    let worst = 0;
    for (let i = 0; i < at.length; i++) worst = Math.max(worst, at.filter((x) => x >= at[i]! && x < at[i]! + 1000).length);
    assert.ok(worst <= rate + burst, `at most ${rate + burst} in any second, saw ${worst}`);
    invariants(r, res);
  });

  test(`the total and the per-journey maximum are held at the sink (${jail.name})`, jail.options, async (t) => {
    // getTen asks for 10; the plan allows 3 a journey.
    const r = await start(t, jail.real, { plan: smallPlan({ exportName: "getTen", users: 2, durationMs: 3_000, perJourneyMax: 3 }) });
    const res = await r.result;
    const turns = res.checking.turns + res.measurement.started;
    assert.ok(turns >= 2, why(res));
    assert.ok(r.sink.arrivals.length <= 3 * turns, `≤ 3 a turn: ${r.sink.arrivals.length} for ${turns} turns`);
    assert.ok((res.journal!.denied.turn_total ?? 0) >= 1, "the fourth request of a turn is refused");
    assert.ok(r.sink.arrivals.length <= res.journal!.debited);
    invariants(r, res);
  });
}

test("Checking and measurement draw on one run total: the sink never sees more than the budget", async (t) => {
  // Budget = Checking's maximum (2 × 1) + the plan's ceiling, exactly.
  const plan = smallPlan({ exportName: "get", users: 2, durationMs: 3_000, perJourneyMax: 1 });
  const budget = 2 + plan.requests.ceiling;
  const r = await rig(t, { plan, limits: { requestBudget: budget } });
  const res = await r.result;
  assert.equal(res.status, "completed", why(res));
  assert.ok(r.sink.arrivals.length <= budget);
  assert.ok(res.journal!.debited <= budget);
  invariants(r, res);
});
