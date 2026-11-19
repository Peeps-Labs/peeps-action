/**
 * Containment (T4): a journey's `setsid` grandchild, reparented away from the executor, is
 * gone when the run ends, and a process the engine did not start is left alone. Where only a
 * process-group kill is available the result says `limited`, and the escape is expected.
 */
import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";

import { cgroupV2Dir, privilege, spawnContained } from "../src/load/containment";
import { alive, newSink, startRun } from "./support/load-run";
import type { LoadSink } from "./support/load-sink";

function escaped(sink: LoadSink): number[] {
  return sink.reports.map((r) => Number(r.escaped)).filter((pid) => Number.isInteger(pid) && pid > 0);
}

function unrelatedSleeper(t: TestContext): number {
  const sleeper = spawn("sleep", ["60"], { stdio: "ignore", detached: true });
  sleeper.unref();
  t.after(() => {
    try {
      process.kill(sleeper.pid!, "SIGKILL");
    } catch {
      // gone
    }
  });
  return sleeper.pid!;
}

function killAll(pids: number[]): void {
  for (const pid of pids) {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // gone
    }
  }
}

async function runEscape(t: TestContext, containment: string) {
  const sink = await newSink(t);
  const bystander = unrelatedSleeper(t);
  const run = await startRun(t, sink, {
    plan: { module: "containment.ts", export: "escape", users: 2, holdMs: 3_000 },
    options: { containment },
  });
  const done = await run.finished();
  const pids = escaped(sink);
  t.after(() => killAll(pids));
  return { done, pids, bystander };
}

const canContain = privilege().root || privilege().sudo;
// The escape fixture needs `setsid` and /proc, and every level but `limited` is Linux's own.
const linux = process.platform === "linux";

test("pid namespace: a setsid grandchild is gone after the run, a bystander is not", { skip: (!linux && "Linux only") || (!canContain && "needs root or sudo -n") }, async (t) => {
  const { done, pids, bystander } = await runEscape(t, "pid-namespace");
  assert.equal(done.result.containment.level, "pid-namespace");
  assert.equal(done.result.containment.limitedBecause, null);
  assert.ok(pids.length > 0, "the journey reported no escaped process");
  for (const pid of pids) assert.equal(alive(pid), false, `escaped process ${pid} survived the run`);
  assert.equal(alive(bystander), true, "a process the engine did not start was killed");
});

test("cgroup: a setsid grandchild is gone after the run, a bystander is not", { skip: (!linux && "Linux only") || (!cgroupV2Dir() && "no cgroup v2") }, async (t) => {
  const { done, pids, bystander } = await runEscape(t, "cgroup");
  if (done.result.containment.level !== "cgroup") {
    t.skip(`cgroup containment unavailable here: ${done.result.containment.limitedBecause}`);
    return;
  }
  assert.ok(pids.length > 0, "the journey reported no escaped process");
  for (const pid of pids) assert.equal(alive(pid), false, `escaped process ${pid} survived the run`);
  assert.equal(alive(bystander), true, "a process the engine did not start was killed");
});

test("limited containment says so, and a setsid grandchild is expected to escape it", { skip: !linux && "the escape fixture needs setsid and /proc" }, async (t) => {
  const { done, pids, bystander } = await runEscape(t, "limited");
  assert.equal(done.result.containment.level, "limited");
  assert.ok(done.result.containment.limitedBecause, "limited without a reason");
  assert.ok(pids.length > 0, "the journey reported no escaped process");
  // Expected-limited: a process-group kill cannot reach a process that left the group.
  assert.ok(pids.some((pid) => alive(pid)), "the escape was expected to survive limited containment");
  assert.equal(alive(bystander), true);
});

test("pid namespace: a kill after the executor has exited never signals its old host pid", { skip: (!linux && "Linux only") || (!canContain && "needs root or sudo -n") }, async (t) => {
  const contained = spawnContained({ command: "true", args: [], env: { PATH: process.env.PATH }, cwd: process.cwd() }, { prefer: "pid-namespace", name: `reuse-${process.pid}` });
  assert.equal(contained.level, "pid-namespace");
  await new Promise((resolve) => contained.child.on("exit", resolve));
  // Stands in for a process that took the dead executor's pid.
  const reused = unrelatedSleeper(t);
  contained.setHostPid(reused);
  contained.kill();
  await new Promise((r) => setTimeout(r, 100));
  assert.equal(alive(reused), true, "the kill signalled a pid the executor no longer held");
});
