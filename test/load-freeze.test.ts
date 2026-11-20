/**
 * The fault matrix (e4 plan v3 §3.3 `load-freeze`): the supervisor stopped, a dial parked, a
 * handshake held, a write stalled, a cancellation with a body in flight. Each trial first shows
 * traffic (its barrier) and asserts on counts and seq sets only; times are logged, never
 * asserted.
 *
 * The freeze and the SIGSTOP stop this whole test process, the in-process sink included; the
 * executor, in its own process (and on Linux in the real jail), keeps going. Bytes the gate wrote
 * before the boundary may still arrive after it; nothing written after it may.
 *
 * Fake jail everywhere; the same trials on the real jail with LOAD_JAIL_TESTS=1 (ci.yml
 * `load-jail`).
 */
import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { existsSync, readFileSync, rmSync } from "node:fs";
import path from "node:path";
import { encodeHandoffs, type Journal } from "../src/load/gate/journal";
import type { Dial } from "../src/load/gate/proxy";
import type { LoadResult } from "../src/load/supervisor";
import { respond as fixtureRespond } from "./support/e4-fixtures";
import { arrivedSeqs, startSink, type Sink } from "./support/load-sink";
import { FAST, installedWorkspace, invariants, rig, SINK_HOST, smallPlan, workspace, type Rig, type RigOptions } from "./support/run-supervisor";
import { tcpHold } from "./support/tcp-hold";

const enabled = process.env.LOAD_JAIL_TESTS === "1";
const JAILS = [
  { name: "fake jail", real: false, options: {} },
  { name: "real jail", real: true, options: { skip: enabled ? false : "set LOAD_JAIL_TESTS=1 on a Linux runner with sudo and systemd", timeout: 600_000 } },
];
/** The lease the fake Peeps grants in these trials. */
const TTL_MS = 3_000;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(what: string, check: () => boolean, ms = 30_000): Promise<void> {
  for (let waited = 0; !check(); waited += 25) {
    if (waited > ms) throw new Error(`barrier not reached: ${what}`);
    await sleep(25);
  }
}

async function start(t: TestContext, real: boolean, o: RigOptions): Promise<Rig> {
  const extra: RigOptions = {};
  if (real) {
    const ws = await installedWorkspace();
    t.after(() => rmSync(ws, { recursive: true, force: true }));
    Object.assign(extra, { ws, real: true, seams: { ...o.seams, constants: { ...FAST, loadedMs: 120_000, checkingDeadlineMs: 60_000 } } });
  }
  return rig(t, { ...o, ...extra, setup: { ttlMs: TTL_MS, ...o.setup } });
}

function why(r: Rig, res: LoadResult): string {
  return JSON.stringify({ status: res.status, reason: res.reason, failures: res.failures.slice(0, 3), checking: res.checking, measurement: res.measurement, stderr: r.jails.made[0]?.stderr().slice(-1500) });
}

const attemptedIn = (snap: { debited: number; unattempted: number[] }) => {
  const out = new Set<number>();
  for (let seq = 1; seq <= snap.debited; seq++) if (!snap.unattempted.includes(seq)) out.add(seq);
  return out;
};

/** No debit after the boundary; every seq the sink saw was attempted by then, once. */
function boundaryHolds(r: Rig, res: LoadResult, snap: { debited: number; unattempted: number[] }): void {
  assert.equal(res.handoffs!.debited, snap.debited, "no debit after the boundary");
  const seqs = arrivedSeqs(r.sink);
  const attempted = attemptedIn(snap);
  assert.ok(seqs.every((s) => attempted.has(s)), `sink seqs ${JSON.stringify(seqs)} ⊆ attempted at the boundary`);
  assert.equal(new Set(seqs).size, seqs.length, "no seq arrived twice");
}

/** A supervisor in its own process (support/supervisor-child.ts), the sink here: the runner's signals go to it. */
interface Child {
  proc: ChildProcess;
  sink: Sink;
  facts: Record<string, unknown>[];
  exited: Promise<NodeJS.Signals | number | null>;
  stalling: boolean;
}

async function startChild(t: TestContext, real: boolean, slowReporting: boolean): Promise<Child> {
  const self = { facts: [], stalling: false } as unknown as Child;
  self.sink = await startSink({ host: SINK_HOST, respond: fixtureRespond, stall: () => self.stalling });
  t.after(() => self.sink.close());
  let ws: string;
  if (real) {
    ws = await installedWorkspace();
    t.after(() => rmSync(ws, { recursive: true, force: true }));
  } else ws = workspace(t);
  const env = { ...process.env, PEEPS_CHILD: JSON.stringify({ sinkPort: self.sink.port, caPem: self.sink.caPem, ws, real, ttlMs: TTL_MS * 2, slowReporting }) };
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
      } catch {
        return true;
      }
    } else {
      const file = `/sys/fs/cgroup${cgroup}/cgroup.events`;
      if (!existsSync(file) || /^populated 0$/m.test(readFileSync(file, "utf8"))) return true;
    }
    await sleep(100);
  }
  return false;
}

const cgroupOf = (jail: Record<string, unknown>) =>
  typeof jail.unit === "string" ? execFileSync("systemctl", ["show", "-p", "ControlGroup", "--value", `${jail.unit}.service`], { encoding: "utf8" }).trim() : undefined;

/** Traffic in measurement: the barrier every stop trial needs first. */
const TRAFFIC: RigOptions = { plan: smallPlan({ exportName: "getTen", users: 2, durationMs: 60_000, perJourneyMax: 10 }) };
/** Checking's 2 × 10 arrivals, then 3 in measurement. */
const MEASURED = 23;

for (const jail of JAILS) {
  test(`F1a (${jail.name}): frozen past expiry with demand outstanding; on resume, lease lost and nothing new`, jail.options, async (t) => {
    let journal!: Journal;
    let snap: { debited: number; unattempted: number[] } | undefined;
    let arrivalsAtFreeze = 0;
    const r = await start(t, jail.real, {
      ...TRAFFIC,
      seams: { onJournal: (j) => (journal = j) },
      observer: (e, x) => {
        if (e.type !== "phase" || e.phase !== "measurement") return;
        void until("3 arrivals in measurement", () => x.sink.arrivals.length >= MEASURED).then(() => {
          snap = encodeHandoffs(journal.handoffs());
          arrivalsAtFreeze = x.sink.arrivals.length;
          const t0 = Date.now();
          Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, TTL_MS * 2);
          t.diagnostic(`frozen ${Date.now() - t0} ms at debited ${snap.debited}`);
        });
      },
    });
    const res = await r.result;
    assert.ok(snap, "the freeze happened");
    assert.equal(res.status, "lease_lost", why(r, res));
    boundaryHolds(r, res, snap);
    t.diagnostic(`arrivals at freeze ${arrivalsAtFreeze}, after ${r.sink.arrivals.length}; denied ${JSON.stringify(res.journal!.denied)}`);
    if (jail.real) assert.equal(res.cleanup, "clean");
    invariants(r, res);
  });

  test(`F1b (${jail.name}): SIGSTOP past expiry, then SIGCONT: lease lost and nothing new`, jail.options, async (t) => {
    let journal!: Journal;
    let snap: { debited: number; unattempted: number[] } | undefined;
    const r = await start(t, jail.real, {
      ...TRAFFIC,
      seams: { onJournal: (j) => (journal = j) },
      observer: (e, x) => {
        if (e.type !== "phase" || e.phase !== "measurement") return;
        void until("3 arrivals in measurement", () => x.sink.arrivals.length >= MEASURED).then(() => {
          snap = encodeHandoffs(journal.handoffs());
          const waker = spawn("/bin/sh", ["-c", `sleep ${(TTL_MS * 2) / 1000}; kill -CONT ${process.pid}`], { detached: true, stdio: "ignore" });
          waker.unref();
          process.kill(process.pid, "SIGSTOP");
        });
      },
    });
    const res = await r.result;
    assert.ok(snap, "the stop happened");
    assert.equal(res.status, "lease_lost", why(r, res));
    boundaryHolds(r, res, snap);
    invariants(r, res);
  });

  test(`F2 (${jail.name}): a verified upstream parked before the handoff while the lease runs out: zero HTTP bytes, its debit unattempted`, jail.options, async (t) => {
    let parking = false;
    let parked = 0;
    let release!: () => void;
    const released = new Promise<void>((resolve) => (release = resolve));
    let bytesAtTerminate = -1;
    const r = await start(t, jail.real, {
      plan: smallPlan({ exportName: "get", users: 1, durationMs: 60_000 }),
      dial: (inner: Dial): Dial => async (o, signal, pin, ready) => {
        const up = await inner(o, signal, pin, ready);
        if (!parking) return up;
        parked += 1;
        r.seam.wallShift = 600_000;
        await released;
        return up;
      },
      observer: (e, x) => {
        if (e.type === "phase" && e.phase === "measurement") parking = true;
        if (e.type === "terminate") {
          bytesAtTerminate = x.sink.stats.requestBytes;
          release();
        }
      },
    });
    const res = await r.result;
    assert.ok(parked >= 1, "a dial was parked");
    assert.equal(res.status, "lease_lost", why(r, res));
    assert.equal(r.sink.stats.requestBytes, bytesAtTerminate, "zero HTTP bytes after the cutoff");
    assert.ok(res.handoffs!.unattempted.length >= parked, "the parked debit stays unattempted");
    invariants(r, res);
  });

  for (const clock of ["monotonic", "wall"] as const) {
    test(`F3 (${jail.name}, ${clock}): a held handshake when the lease runs out: that connection is closed, zero requests`, jail.options, async (t) => {
      const hold = await tcpHold();
      t.after(() => hold.close());
      let holding = false;
      let arrivalsAtHold = -1;
      const r = await start(t, jail.real, {
        plan: smallPlan({ exportName: "get", users: 1, durationMs: 60_000 }),
        dial: (inner: Dial): Dial => (o, signal, pin, ready) => (holding ? inner({ ...o, port: hold.port }, signal, pin, ready) : inner(o, signal, pin, ready)),
        observer: (e, x) => {
          if (e.type !== "phase" || e.phase !== "measurement") return;
          holding = true;
          arrivalsAtHold = x.sink.arrivals.length;
          void until("the gate's handshake is held", () => hold.stats.accepted >= 1).then(() => {
            if (clock === "monotonic") x.seam.monoShift = 600_000;
            else x.seam.wallShift = 600_000;
          });
        },
      });
      const res = await r.result;
      assert.equal(res.status, "lease_lost", why(r, res));
      await until("every held connection closed", () => hold.stats.ended + hold.stats.reset === hold.stats.accepted, 10_000);
      assert.ok(hold.stats.accepted >= 1);
      assert.equal(r.sink.arrivals.length, arrivalsAtHold, "zero requests after the hold");
      t.diagnostic(`held ${hold.stats.accepted}: ended ${hold.stats.ended}, reset ${hold.stats.reset}`);
      invariants(r, res);
    });
  }

  test(`F4 (${jail.name}): a stalled 1 MiB POST at the cutoff: late receipts stay within the attempted set at terminate`, jail.options, async (t) => {
    let stalling = false;
    const r = await start(t, jail.real, {
      plan: smallPlan({ exportName: "bigPost", users: 1, durationMs: 60_000, perJourneyMax: 1, allowedRequests: [{ method: "POST", path: "/upload" }] }),
      stall: () => stalling,
      observer: (e, x) => {
        if (e.type === "phase" && e.phase === "measurement") {
          stalling = true;
          void until("the POST's connection is stalled at the sink", () => x.sink.stats.stalled >= 1).then(() => setTimeout(() => (x.seam.wallShift = 600_000), 300));
        }
        if (e.type === "terminate") setTimeout(() => x.sink.resumeStalled(), 200);
      },
    });
    const res = await r.result;
    assert.equal(res.status, "lease_lost", why(r, res));
    const snap = r.events.find((e) => e.type === "snapshot")!;
    await until("the stalled connection ends at the sink", () => r.sink.arrivals.length + r.sink.stats.aborted + r.sink.stats.socketErrors.length > res.checking.success, 10_000);
    boundaryHolds(r, res, (snap as { handoffs: { debited: number; unattempted: number[] } }).handoffs);
    t.diagnostic(`uploads ${r.sink.arrivals.filter((a) => a.url === "/upload").length}, aborted ${r.sink.stats.aborted}, socket errors ${JSON.stringify(r.sink.stats.socketErrors)}`);
    invariants(r, res);
  });

  test(`F4 control (${jail.name}): the same stalled POST, resumed with no cutoff, is delivered`, jail.options, async (t) => {
    let stalling = false;
    const r = await start(t, jail.real, {
      plan: smallPlan({ exportName: "bigPost", users: 1, durationMs: 1_000, perJourneyMax: 1, allowedRequests: [{ method: "POST", path: "/upload" }] }),
      stall: () => stalling,
      observer: (e, x) => {
        if (e.type === "phase" && e.phase === "measurement") {
          stalling = true;
          void until("the POST's connection is stalled at the sink", () => x.sink.stats.stalled >= 1).then(() => setTimeout(() => x.sink.resumeStalled(), 300));
        }
      },
    });
    const res = await r.result;
    assert.equal(res.status, "completed", why(r, res));
    assert.equal(r.sink.arrivals.filter((a) => a.url === "/upload" && a.body.length === 1024 * 1024 - 4096).length, res.checking.success + 1);
    invariants(r, res);
  });

  test(`F5a (${jail.name}): cancelled with a 1 MiB POST in flight: the upstream is reset, the final batch goes, cleanup clean`, jail.options, async (t) => {
    const ac = new AbortController();
    let stalling = false;
    const r = await start(t, jail.real, {
      signal: ac.signal,
      plan: smallPlan({ exportName: "bigPost", users: 1, durationMs: 60_000, perJourneyMax: 1, allowedRequests: [{ method: "POST", path: "/upload" }] }),
      stall: () => stalling,
      observer: (e, x) => {
        if (e.type === "phase" && e.phase === "measurement") {
          stalling = true;
          void until("the POST's connection is stalled at the sink", () => x.sink.stats.stalled >= 1).then(() => setTimeout(() => ac.abort(), 300));
        }
        if (e.type === "terminate") setTimeout(() => x.sink.resumeStalled(), 200);
      },
    });
    const res = await r.result;
    assert.equal(res.status, "cancelled", why(r, res));
    await until("the stalled connection ends at the sink", () => r.sink.arrivals.length + r.sink.stats.aborted + r.sink.stats.socketErrors.length > res.checking.success, 10_000);
    t.diagnostic(`uploads ${r.sink.arrivals.filter((a) => a.url === "/upload").length}, aborted ${r.sink.stats.aborted}, socket errors ${JSON.stringify(r.sink.stats.socketErrors)}`);
    assert.equal(res.gateClosed, true);
    assert.deepEqual(res.final, { watermark: res.journal!.debited });
    assert.equal(res.cleanup, "clean");
    invariants(r, res);
  });

  test(`F5b (${jail.name}): the runner's SIGINT (handler held up 2 s), SIGTERM at 7.5 s, SIGKILL at 10 s: the stalled POST is reset, never flushed`, jail.options, async (t) => {
    // The reporting would take a minute (evidence blocked), so the run is still reporting when SIGTERM comes.
    const c = await startChild(t, jail.real, true);
    await until("measurement in the child", () => sawPhase(c, "measurement"), jail.real ? 300_000 : 30_000);
    const unit = fact(c, "jail")!;
    const cgroup = cgroupOf(unit);
    const before = uploads(c.sink);
    c.stalling = true;
    await until("the POST's connection is stalled at the sink", () => c.sink.stats.stalled >= 1);
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
    c.stalling = true;
    await until("the POST's connection is stalled at the sink", () => c.sink.stats.stalled >= 1);
    c.proc.kill("SIGKILL");
    await c.exited;
    assert.ok(await jailGoneWithin(unit, cgroup, 5_000), "the jail ended within 5 s");
    c.sink.resumeStalled();
    await until("the stalled connection ends at the sink", () => c.sink.stats.aborted + c.sink.stats.socketErrors.length >= 1 || uploads(c.sink) > before, 10_000);
    // No handler runs on SIGKILL: whatever the kernel held is its to send. Reported, not asserted.
    t.diagnostic(`uploads completed after the kill: ${uploads(c.sink) - before}; aborted ${c.sink.stats.aborted}; socket errors ${JSON.stringify(c.sink.stats.socketErrors)}`);
  });
}
