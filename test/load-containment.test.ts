/**
 * Containment (T4): a journey's `setsid` grandchild, reparented away from the executor, is
 * gone when the run ends, and a process the engine did not start is left alone. Where only a
 * process-group kill is available the result says `limited`, and the escape is expected.
 */
import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import path from "node:path";

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
  assert.equal(done.result.cleanup, "complete");
  assert.ok(done.markers.some((m) => m.kind === "traffic_stopped"));
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
  assert.equal(done.result.cleanup, "complete");
});

test("limited containment says so, and a setsid grandchild is expected to escape it", { skip: !linux && "the escape fixture needs setsid and /proc" }, async (t) => {
  const { done, pids, bystander } = await runEscape(t, "limited");
  assert.equal(done.result.containment.level, "limited");
  assert.ok(done.result.containment.limitedBecause, "limited without a reason");
  assert.ok(pids.length > 0, "the journey reported no escaped process");
  // Expected-limited: a process-group kill cannot reach a process that left the group.
  assert.ok(pids.some((pid) => alive(pid)), "the escape was expected to survive limited containment");
  assert.equal(alive(bystander), true);
  // A process-group kill cannot see what left the group: the result never claims it all stopped.
  assert.equal(done.result.cleanup, "unverified");
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

test("cgroup: containment is verified only once the executor is in it, and reports what is left", { skip: (!linux && "Linux only") || (!cgroupV2Dir() && "no cgroup v2") }, async (t) => {
  const contained = spawnContained({ command: "sleep", args: ["30"], env: { PATH: process.env.PATH }, cwd: "/" }, { prefer: "cgroup", name: `verify-${process.pid}` });
  t.after(() => {
    contained.kill();
    contained.dispose();
  });
  if (contained.level !== "cgroup") {
    t.skip(`cgroup containment unavailable here: ${contained.limitedBecause}`);
    return;
  }
  assert.match(String(contained.verify({ nsPid: contained.child.pid! })), /not in its cgroup/);
  contained.enclose();
  assert.equal(contained.verify({ nsPid: contained.child.pid! }), null);
  assert.equal(contained.remaining(), "some");
  contained.kill();
  await new Promise((resolve) => contained.child.on("exit", resolve));
  for (let i = 0; i < 50 && contained.remaining() !== "none"; i++) await new Promise((r) => setTimeout(r, 20));
  assert.equal(contained.remaining(), "none");
});

test("pid namespace: verified only when the executor is the namespace's init", { skip: (!linux && "Linux only") || (!canContain && "needs root or sudo -n") }, async (t) => {
  const contained = spawnContained({ command: "sleep", args: ["30"], env: { PATH: process.env.PATH }, cwd: "/" }, { prefer: "pid-namespace", name: `verify-ns-${process.pid}` });
  t.after(() => contained.kill());
  assert.equal(contained.level, "pid-namespace");
  assert.equal(contained.verify({ nsPid: 1 }), null);
  assert.match(String(contained.verify({ nsPid: 7 })), /not its init/);
  assert.equal(contained.remaining(), "some");
  contained.kill();
  await new Promise((resolve) => contained.child.on("exit", resolve));
  assert.equal(contained.remaining(), "none");
});

test("cgroup: with the supervisor frozen, the watchdog kills everything the journey started", { skip: (!linux && "Linux only") || (!cgroupV2Dir() && "no cgroup v2") }, async (t) => {
  const sink = await newSink(t);
  const run = await startRun(t, sink, {
    plan: { module: "containment.ts", export: "escape", users: 1, holdMs: 30_000 },
    options: { containment: "cgroup", deadManMs: 1_500 },
  });
  const events = await run.waitFor((e) => e.some((x) => x.type === "executor"));
  if (events.find((x) => x.type === "executor")!.containment !== "cgroup") {
    t.skip("cgroup containment unavailable here");
    return;
  }
  const started = Date.now();
  while (escaped(sink).length === 0 && Date.now() - started < 15_000) await new Promise((r) => setTimeout(r, 20));
  const pids = escaped(sink);
  t.after(() => killAll(pids));
  assert.ok(pids.length > 0, "the journey reported no escaped process");
  // The supervisor alone stops; the journey's setsid grandchild is in the cgroup, outside
  // every process group, and outlives the executor's own dead-man.
  process.kill(-run.child.pid!, "SIGSTOP");
  t.after(() => {
    try {
      process.kill(-run.child.pid!, "SIGCONT");
    } catch {
      // the run is over
    }
  });
  await new Promise((r) => setTimeout(r, 1_500 + 1_500));
  const survivors = pids.filter((pid) => alive(pid));
  process.kill(-run.child.pid!, "SIGCONT");
  assert.deepEqual(survivors, [], "the journey's processes outlived a silent supervisor");
  await run.finished();
});

test("pid namespace: an executor that is not the namespace's init is refused before any customer code", { skip: (!linux && "Linux only") || (!canContain && "needs root or sudo -n") }, async (t) => {
  const sink = await newSink(t);
  const run = await startRun(t, sink, {
    plan: { module: "basic.ts", export: "readValue", users: 1, holdMs: 2_000 },
    options: { containment: "pid-namespace", executorPath: path.resolve(__dirname, "fixtures/load-engine/nested-executor.js") },
  });
  const done = await run.finished();
  assert.equal(done.result.status, "didnt_start");
  assert.match(done.result.reason ?? "", /containment could not be verified/);
  assert.equal(sink.requests.length, 0);
});
