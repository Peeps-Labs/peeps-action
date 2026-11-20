/**
 * What never runs, and what cannot get out (e4 plan v3 §3.2 `load-isolation`). The startup
 * refusals on the fake jail (no customer code is ever started, so they hold the same on the
 * real one), the install spanning renewals, and on the real jail (LOAD_JAIL_TESTS=1) raw
 * egress around the gate.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { appendFileSync, existsSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { startSink } from "./support/load-sink";
import { FAST, installedWorkspace, rig, SINK_HOST, smallPlan, workspace, type Rig } from "./support/run-supervisor";

const enabled = process.env.LOAD_JAIL_TESTS === "1";
const realOnly = { skip: enabled ? false : "set LOAD_JAIL_TESTS=1 on a Linux runner with sudo and systemd", timeout: 600_000 };

/** A journey module that leaves a marker outside the checkout if it is ever loaded. */
function trap(ws: string): string {
  const marker = path.join(os.tmpdir(), `peeps-trap-${path.basename(ws)}`);
  appendFileSync(path.join(ws, "journeys.ts"), `\nimport * as trapFs from "node:fs";\ntrapFs.writeFileSync(${JSON.stringify(marker)}, "loaded");\n`);
  return marker;
}

function nothingRan(r: Rig, marker: string): void {
  assert.equal(existsSync(marker), false, "the journey module was never loaded");
  assert.equal(r.jails.made.flatMap((j) => j.tickets).filter((x) => x.kind === "launch" && x.answer === "ok").length, 0, "no executor launched");
  assert.equal(r.sink.arrivals.length, 0);
}

test("a refused claim loads no customer code", async (t) => {
  const ws = workspace(t);
  const marker = trap(ws);
  const r = await rig(t, { ws, script: { claimRefused: "matrix" } });
  const res = await r.result;
  assert.equal(res.reason, "claim_matrix");
  nothingRan(r, marker);
});

test("checkout_changed loads no customer code", async (t) => {
  let marker = "";
  const r = await rig(t, {
    observer: (e, x) => {
      if (e.type === "claimed") marker = trap(x.ws);
    },
  });
  const res = await r.result;
  assert.equal(res.reason, "checkout_changed");
  nothingRan(r, marker);
});

test("a stale ticket is refused before the install and loads no customer code", async (t) => {
  const ws = workspace(t);
  const marker = trap(ws);
  const r = await rig(t, {
    ws,
    // The supervisor's monotonic clock reads 30 s behind the shared one: its tickets (deadline the lease's,
    // 3 s on) are already stale to init. Not more: on a freshly booted runner CLOCK_MONOTONIC is only
    // minutes old, and a shift past it makes the supervisor's clock negative, which the gate refuses
    // (startup_failed, seen on CI with -10 min).
    monoShift: -30_000,
  });
  const res = await r.result;
  assert.equal(res.status, "didnt_start");
  assert.deepEqual(r.jails.made[0]!.tickets, [{ kind: "start", answer: "stale" }]);
  nothingRan(r, marker);
});

test("an install spanning two renewals keeps the lease and the run goes on", async (t) => {
  const marks: number[] = [];
  let r!: Rig;
  r = await rig(t, { jail: { installMs: 1_500, onTicket: () => void marks.push(r.port.renewals.filter((x) => x.answered).length) } });
  const res = await r.result;
  assert.equal(res.status, "completed", JSON.stringify({ reason: res.reason }));
  assert.equal(marks.length, 2);
  assert.ok(marks[1]! - marks[0]! >= 2, `renewals during the install: ${marks[1]! - marks[0]!}`);
});

test("raw fetch and node:https from the journey reach nothing (real jail)", realOnly, async (t) => {
  const ws = await installedWorkspace();
  t.after(() => rmSync(ws, { recursive: true, force: true }));
  const sink = await startSink({ host: SINK_HOST });
  t.after(() => sink.close());
  writeFileSync(path.join(ws, "target.txt"), `https://127.0.0.1:${sink.port}/raw\n`);
  const probe = await rig(t, { ws, sink, real: true, plan: smallPlan({ exportName: "rawFetch" }), seams: { constants: { ...FAST, loadedMs: 120_000, checkingDeadlineMs: 60_000 } } });
  const res = await probe.result;
  assert.equal(probe.sink.stats.connections, 0, JSON.stringify({ reason: res.reason, failures: res.failures }));
  assert.equal(probe.sink.arrivals.length, 0);
});
