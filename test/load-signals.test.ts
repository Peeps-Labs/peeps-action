/**
 * The process signals a runner sends a cancelled job (e4 plan v3 §3.3 F5): SIGINT, then
 * SIGTERM 7.5 s later, then SIGKILL at 10 s. A handler for each keeps Node's default (exit,
 * the kernel then flushing what was queued) from running: SIGINT cancels the run, SIGTERM
 * cancels it hard (every upstream reset at once, no draining).
 *
 * F5b and F5c send them to a supervisor in its own process; fake jail everywhere, the real jail
 * with LOAD_JAIL_TESTS=1 (ci.yml `load-jail`). The forced-kill timer bounds the hard-cancel test.
 */
import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { existsSync, readFileSync, rmSync } from "node:fs";
import path from "node:path";
import { loadSignals } from "../src/load/signals";
import { respond as fixtureRespond } from "./support/e4-fixtures";
import { startSink, type Sink } from "./support/load-sink";
import { installedWorkspace, SINK_HOST, workspace } from "./support/run-supervisor";

test("SIGINT cancels; SIGTERM cancels hard; repeats change nothing; dispose removes the handlers", () => {
  const proc = new EventEmitter();
  const s = loadSignals(proc as never);
  assert.equal(proc.listenerCount("SIGINT"), 1);
  assert.equal(proc.listenerCount("SIGTERM"), 1);
  proc.emit("SIGINT");
  assert.equal(s.signal.aborted, true);
  assert.equal(s.hard.aborted, false);
  proc.emit("SIGINT");
  assert.equal(proc.listenerCount("SIGINT"), 1, "a second SIGINT is still ours, not Node's default exit");
  proc.emit("SIGTERM");
  assert.equal(s.hard.aborted, true);
  assert.deepEqual(s.received, ["SIGINT", "SIGINT", "SIGTERM"]);
  s.dispose();
  assert.equal(proc.listenerCount("SIGINT") + proc.listenerCount("SIGTERM"), 0);
});

test("SIGTERM alone is a hard cancel", () => {
  const proc = new EventEmitter();
  const s = loadSignals(proc as never);
  proc.emit("SIGTERM");
  assert.equal(s.signal.aborted, true);
  assert.equal(s.hard.aborted, true);
  s.dispose();
});

const enabled = process.env.LOAD_JAIL_TESTS === "1";
const JAILS = [
  { name: "fake jail", real: false, options: {} },
  { name: "real jail", real: true, options: { skip: enabled ? false : "set LOAD_JAIL_TESTS=1 on a Linux runner with sudo and systemd", timeout: 600_000 } },
];
/** The lease the child's fake Peeps grants (the lease is never more than 6 s). */
const TTL_MS = 6_000;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(what: string, check: () => boolean, ms = 30_000): Promise<void> {
  for (let waited = 0; !check(); waited += 25) {
    if (waited > ms) throw new Error(`barrier not reached: ${what}`);
    await sleep(25);
  }
}

/** A supervisor in its own process (support/supervisor-child.ts), the sink here: the runner's signals go to it. */
interface Child {
  proc: ChildProcess;
  sink: Sink;
  facts: Record<string, unknown>[];
  exited: Promise<NodeJS.Signals | number | null>;
}

async function startChild(t: TestContext, real: boolean, slowReporting: boolean): Promise<Child> {
  const self = { facts: [] } as unknown as Child;
  let checked = false;
  self.sink = await startSink({
    host: SINK_HOST,
    respond: (arrival, response) => {
      checked = true;
      fixtureRespond(arrival, response);
    },
    stall: () => checked,
  });
  t.after(() => self.sink.close());
  let ws: string;
  if (real) {
    ws = await installedWorkspace();
    t.after(() => rmSync(ws, { recursive: true, force: true }));
  } else ws = workspace(t);
  const env = { ...process.env, PEEPS_CHILD: JSON.stringify({ sinkPort: self.sink.port, caPem: self.sink.caPem, ws, real, ttlMs: TTL_MS, slowReporting }) };
  self.proc = spawn(process.execPath, ["--import", "tsx", path.join(__dirname, "support/supervisor-child.ts")], { env, stdio: ["pipe", "pipe", "inherit"] });
  t.after(() => self.proc.kill("SIGKILL"));
  self.exited = new Promise((resolve) => self.proc.once("exit", (code, signal) => resolve(signal ?? code)));
  let buf = "";
  self.proc.stdout!.setEncoding("utf8");
  self.proc.stdout!.on("data", (d: string) => {
    buf += d;
    for (let nl = buf.indexOf("\n"); nl >= 0; nl = buf.indexOf("\n")) {
      const line = buf.slice(0, nl);
      buf = buf.slice(nl + 1);
      try {
        self.facts.push(JSON.parse(line) as Record<string, unknown>);
      } catch {
        // Not a fact (the jail's own output).
      }
    }
  });
  return self;
}

const fact = (c: Child, key: string) => c.facts.find((f) => key in f)?.[key] as Record<string, unknown> | undefined;
const sawPhase = (c: Child, phase: string) => c.facts.some((f) => (f.event as { phase?: string } | undefined)?.phase === phase);
const uploads = (sink: Sink) => sink.arrivals.filter((a) => a.url === "/upload" && a.body.length === 1024 * 1024 - 4096).length;

/** Ends within `ms`: the fake executor's process, or the real unit's cgroup. */
async function jailGoneWithin(jail: Record<string, unknown>, cgroup: string | undefined, ms: number): Promise<boolean> {
  for (let waited = 0; waited <= ms; waited += 100) {
    if (typeof jail.pid === "number") {
      try {
        process.kill(jail.pid, 0);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ESRCH") return true;
        throw error;
      }
    } else {
      assert.ok(cgroup, "the real jail had a cgroup before the cutoff");
      const file = `/sys/fs/cgroup${cgroup}/cgroup.events`;
      if (!existsSync(file) || /^populated 0$/m.test(readFileSync(file, "utf8"))) return true;
    }
    await sleep(100);
  }
  return false;
}

function cgroupOf(jail: Record<string, unknown>): string | undefined {
  if (typeof jail.unit !== "string") {
    assert.ok(typeof jail.pid === "number", "the fake jail had a live executor before cutoff");
    process.kill(jail.pid, 0);
    return;
  }
  const cgroup = execFileSync("systemctl", ["show", "-p", "ControlGroup", "--value", `${jail.unit}.service`], { encoding: "utf8" }).trim();
  assert.match(cgroup, /^\/.+/, "the unit had a cgroup before cutoff");
  assert.match(readFileSync(`/sys/fs/cgroup${cgroup}/cgroup.events`, "utf8"), /^populated 1$/m);
  return cgroup;
}

for (const jail of JAILS) {
  test(`F5b (${jail.name}): the runner's SIGINT (handler held up 2 s), SIGTERM at 7.5 s, SIGKILL at 10 s: the stalled POST is reset, never flushed`, jail.options, async (t) => {
    // The reporting would take a minute (evidence blocked), so the run is still reporting when SIGTERM comes.
    const c = await startChild(t, jail.real, true);
    await until("measurement in the child", () => sawPhase(c, "measurement"), jail.real ? 300_000 : 30_000);
    const unit = fact(c, "jail")!;
    const cgroup = cgroupOf(unit);
    const before = uploads(c.sink);
    await until("the POST is queued at the sender", () =>
      c.sink.stats.stalled >= 1 && c.facts.some((f) => Number(f.queuedBytes) >= 1024 * 1024 - 4096));
    const bytesBefore = c.sink.stats.requestBytes;
    // Held for 2 s: inside the lease (at most 6 s, renewed every 0.5 s), so only the signals end the run.
    c.proc.stdin!.write("block 2000\n");
    await until("the child's event loop is blocked", () => fact(c, "blocking") !== undefined);
    c.proc.kill("SIGINT");
    const term = setTimeout(() => c.proc.kill("SIGTERM"), 7_500);
    const kill = setTimeout(() => c.proc.kill("SIGKILL"), 10_000);
    const how = await c.exited;
    clearTimeout(term);
    clearTimeout(kill);
    c.sink.resumeStalled();
    await until("the stalled connection ends at the sink", () => c.sink.stats.aborted + c.sink.stats.socketErrors.length >= 1 || uploads(c.sink) > before, 10_000);
    t.diagnostic(`child ended by ${how}; facts ${JSON.stringify(c.facts.filter((f) => !("jail" in f)))}`);
    assert.equal(how, 0, "hard cancellation finished before the fallback SIGKILL");
    assert.equal(c.sink.stats.requestBytes, bytesBefore, "queued HTTP bytes did not flush");
    assert.deepEqual(c.facts.filter((f) => "signal" in f).map((f) => f.signal), ["SIGINT", "SIGTERM"], "both handlers ran, in order");
    assert.deepEqual(c.facts.find((f) => (f.event as { terminate?: string } | undefined)?.terminate)?.event, { terminate: "cancelled" });
    assert.equal(uploads(c.sink), before, "the stalled POST never completed at the target");
    assert.ok(await jailGoneWithin(unit, cgroup, 5_000), "the jail ended within 5 s");
  });

  test(`F5c (${jail.name}): SIGKILL alone: the jail ends within 5 s; what the kernel flushed is reported`, jail.options, async (t) => {
    const c = await startChild(t, jail.real, false);
    await until("measurement in the child", () => sawPhase(c, "measurement"), jail.real ? 300_000 : 30_000);
    const unit = fact(c, "jail")!;
    const cgroup = cgroupOf(unit);
    const before = uploads(c.sink);
    await until("the POST's connection is stalled at the sink", () => c.sink.stats.stalled >= 1);
    assert.ok(c.proc.kill("SIGKILL"), "the supervisor was alive at the kill");
    assert.equal(await c.exited, "SIGKILL");
    assert.ok(await jailGoneWithin(unit, cgroup, 5_000), "the jail ended within 5 s");
    c.sink.resumeStalled();
    await until("the stalled connection ends at the sink", () => c.sink.stats.aborted + c.sink.stats.socketErrors.length >= 1 || uploads(c.sink) > before, 10_000);
    // No handler runs on SIGKILL: whatever the kernel held is its to send. Reported, not asserted.
    t.diagnostic(`uploads completed after the kill: ${uploads(c.sink) - before}; aborted ${c.sink.stats.aborted}; socket errors ${JSON.stringify(c.sink.stats.socketErrors)}`);
  });
}
