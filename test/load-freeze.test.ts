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
import { spawn } from "node:child_process";
import { rmSync } from "node:fs";
import { encodeHandoffs, type Journal } from "../src/load/gate/journal";
import type { Dial } from "../src/load/gate/proxy";
import type { Upstream } from "../src/load/gate/resolve";
import type { LoadResult } from "../src/load/supervisor";
import { arrivedSeqs } from "./support/load-sink";
import { FAST, installedWorkspace, invariants, rig, smallPlan, type Rig, type RigOptions } from "./support/run-supervisor";
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
  assert.deepEqual(res.handoffs!.unattempted, snap.unattempted, "no handoff after the boundary");
  const seqs = arrivedSeqs(r.sink);
  assert.equal(seqs.length, r.sink.arrivals.length, "every arrival has a seq");
  const attempted = attemptedIn(snap);
  assert.ok(seqs.every((s) => attempted.has(s)), `sink seqs ${JSON.stringify(seqs)} ⊆ attempted at the boundary`);
  assert.equal(new Set(seqs).size, seqs.length, "no seq arrived twice");
}

/** Traffic in measurement: the barrier every stop trial needs first. */
const TRAFFIC: RigOptions = { plan: smallPlan({ exportName: "getTen", users: 2, durationMs: 60_000, perJourneyMax: 10 }) };
/** Checking's 2 × 10 arrivals, then 3 in measurement. */
const MEASURED = 23;

for (const jail of JAILS) {
  for (const kind of ["freeze", "SIGSTOP"] as const) {
    test(`F1${kind === "freeze" ? "a" : "b"} (${jail.name}, ${kind}): resume past lease expiry with a dial waiting to start`, jail.options, async (t) => {
      let journal!: Journal;
      let waiting = false;
      let resumed = false;
      let release!: () => void;
      const held = new Promise<void>((resolve) => { release = resolve; });
      let snap: ReturnType<typeof encodeHandoffs> | undefined;
      let boundary!: Promise<void>;
      const r = await start(t, jail.real, {
        ...TRAFFIC,
        seams: { onJournal: (j) => (journal = j) },
        dial: (inner) => async (...args) => {
          if (!waiting && r.sink.arrivals.length >= MEASURED) {
            waiting = true;
            await held;
            resumed = true;
          }
          return inner(...args);
        },
        observer: (e) => {
          if (e.type !== "phase" || e.phase !== "measurement") return;
          boundary = until("a measured dial is debited and waiting before TCP", () => waiting).then(() => {
            snap = encodeHandoffs(journal.handoffs());
            try {
              if (kind === "freeze") {
                Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, TTL_MS * 2);
              } else {
                const waker = spawn("/bin/sh", ["-c", `sleep ${(TTL_MS * 2) / 1000}; kill -CONT ${process.pid}`], { detached: true, stdio: "ignore" });
                waker.unref();
                process.kill(process.pid, "SIGSTOP");
              }
            } finally {
              release();
            }
          });
          void boundary.catch(() => release());
        },
      });
      const res = await r.result;
      await boundary;
      assert.ok(snap?.unattempted.length, "a paid dial was outstanding at the boundary");
      assert.ok(resumed, "the waiting dial resumed and attempted to start TCP");
      assert.equal(res.status, "lease_lost", why(r, res));
      boundaryHolds(r, res, snap);
      if (jail.real) assert.equal(res.cleanup, "clean");
      invariants(r, res);
    });
  }

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

  test(`F2b (${jail.name}): live at the permit, expired at the handoff (clock seam): zero HTTP bytes, the debit unattempted and cut lease`, jail.options, async (t) => {
    let shifting = false;
    let shifted = 0;
    let bytesAtShift = -1;
    const r = await start(t, jail.real, {
      plan: smallPlan({ exportName: "get", users: 1, durationMs: 60_000 }),
      // The dial is done (the permit was live); the clock passes the lease before the handoff.
      dial: (inner: Dial): Dial => async (o, signal, pin, ready) => {
        const up = await inner(o, signal, pin, ready);
        if (shifting && shifted === 0) {
          shifted += 1;
          bytesAtShift = r.sink.stats.requestBytes;
          // Past the lease (3 s), short of the run's end (a minute on): the handoff sees the lease, not run_end.
          r.seam.monoShift = 10_000;
        }
        return up;
      },
      observer: (e) => {
        if (e.type === "phase" && e.phase === "measurement") shifting = true;
      },
    });
    const res = await r.result;
    assert.equal(shifted, 1, "the clock passed the lease between a dial and its handoff");
    assert.equal(res.status, "lease_lost", why(r, res));
    assert.equal(r.sink.stats.requestBytes, bytesAtShift, "zero HTTP bytes after the shift");
    assert.ok(res.handoffs!.unattempted.length >= 1, "that debit stays unattempted");
    assert.ok((res.journal!.cut.lease ?? 0) >= 1, `cut lease: ${JSON.stringify(res.journal!.cut)}`);
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
          void until("the gate sent a TLS ClientHello", () => hold.stats.bytes > 0).then(() => {
            if (clock === "monotonic") x.seam.monoShift = 600_000;
            else x.seam.wallShift = 600_000;
          });
        },
      });
      const res = await r.result;
      assert.equal(res.status, "lease_lost", why(r, res));
      await until("every held connection closed", () => hold.stats.ended + hold.stats.reset === hold.stats.accepted, 10_000);
      assert.ok(hold.stats.accepted >= 1);
      assert.equal(hold.stats.reset, hold.stats.accepted, "each connected handshake was reset");
      assert.equal(r.sink.arrivals.length, arrivalsAtHold, "zero requests after the hold");
      t.diagnostic(`held ${hold.stats.accepted}: ended ${hold.stats.ended}, reset ${hold.stats.reset}`);
      invariants(r, res);
    });
  }

  for (const trial of ["expiry", "control", "SIGINT"] as const) {
    const label = trial === "SIGINT" ? "F5a" : "F4";
    test(`${label} (${jail.name}, ${trial}): a queued POST ${trial === "control" ? "is delivered without cutoff" : "is dropped at cutoff"}`, jail.options, async (t) => {
      const cancel = new AbortController();
      const cutoff = trial !== "control";
      const uploadBytes = 1024 * 1024 - 4096;
      let measuring = false;
      let queued: Upstream | undefined;
      let terminated!: () => void;
      const termination = new Promise<void>((resolve) => { terminated = resolve; });
      const r = await start(t, jail.real, {
        signal: cancel.signal,
        plan: smallPlan({
          exportName: "bigPost", users: 1, durationMs: cutoff ? 60_000 : 1_000, perJourneyMax: 1,
          allowedRequests: [{ method: "POST", path: "/upload" }],
        }),
        dial: (inner) => async (...args) => {
          const upstream = await inner(...args);
          if (measuring && !queued) {
            queued = upstream;
            // Force actual sender-side backpressure even where loopback can absorb 1 MiB.
            upstream.socket.cork();
          }
          return upstream;
        },
        stall: () => measuring,
        observer: (e) => {
          if (e.type === "phase" && e.phase === "measurement") measuring = true;
          if (e.type === "terminate") terminated();
        },
      });
      await until("the measured POST is queued in the sender", () =>
        r.sink.stats.stalled === 1 && (queued?.socket.writableLength ?? 0) >= uploadBytes, 10_000);
      const bytesBefore = r.sink.stats.requestBytes;
      if (cutoff) {
        if (trial === "expiry") r.seam.wallShift = 600_000;
        else cancel.abort();
        await termination;
      }
      // After cutoff, try to release the very same bytes that the positive control delivers.
      queued!.socket.uncork();
      r.sink.resumeStalled();
      const res = await r.result;
      const uploads = r.sink.arrivals.filter((a) => a.url === "/upload" && a.body.length === uploadBytes);
      assert.equal(res.checking.success, 1, why(r, res));
      if (cutoff) {
        assert.equal(res.status, trial === "expiry" ? "lease_lost" : "cancelled", why(r, res));
        const snap = r.events.find((e) => e.type === "snapshot")!;
        assert.ok(snap.journal.attempted > res.checking.success, "the upload reached the write boundary");
        boundaryHolds(r, res, snap.handoffs);
        assert.equal(r.sink.stats.requestBytes, bytesBefore, "queued bytes did not flush");
        assert.equal(uploads.length, res.checking.success);
        // The reset, as the target sees it: the connection ends early (Linux reads it as an early EOF).
        await until("the target saw the upload end early", () => r.sink.stats.aborted + r.sink.stats.socketErrors.length >= 1, 10_000);
        if (trial === "SIGINT") {
          assert.equal(res.gateClosed, true);
          assert.deepEqual(res.final, { watermark: res.journal!.debited });
          assert.equal(res.cleanup, "clean");
        }
      } else {
        assert.equal(res.status, "completed", why(r, res));
        assert.equal(uploads.length, res.checking.success + 1);
      }
      invariants(r, res);
    });
  }
}
