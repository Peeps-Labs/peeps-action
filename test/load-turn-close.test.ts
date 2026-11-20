/**
 * F6 (e4 plan v3 §3.3): a turn's deadline closes its gate side (`closeTurn`) with work in it: an
 * active dial, and a queued write. Counts only; times are not asserted.
 *
 * Fake jail everywhere; the real jail with LOAD_JAIL_TESTS=1 (ci.yml `load-jail`).
 */
import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import type { Dial } from "../src/load/gate/proxy";
import type { Upstream } from "../src/load/gate/resolve";
import type { LoadResult } from "../src/load/supervisor";
import { arrivedSeqs } from "./support/load-sink";
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
  return rig(t, { ...o, ws, real: true, seams: { ...o.seams, constants: { ...FAST, loadedMs: 120_000, checkingDeadlineMs: 60_000 } } });
}

function why(r: Rig, res: LoadResult): string {
  return JSON.stringify({ status: res.status, reason: res.reason, failures: res.failures.slice(0, 3), checking: res.checking, measurement: res.measurement, cut: res.journal?.cut, stderr: r.jails.made[0]?.stderr().slice(-1500) });
}

const UPLOAD_BYTES = 1024 * 1024 - 4096;

for (const jail of JAILS) {
  test(`F6 (${jail.name}): a dial cut at the turn deadline keeps its debit unattempted`, jail.options, async (t) => {
    let holding = false;
    let held = 0;
    let heldSeq = 0;
    let journal!: import("../src/load/gate/journal").Journal;
    const r = await start(t, jail.real, {
      plan: smallPlan({ exportName: "get", users: 1, durationMs: 6_000 }),
      seams: { onJournal: (j) => { journal = j; } },
      // The first dial in measurement never connects; it ends only when the gate gives it up.
      dial: (inner: Dial): Dial => async (o, signal, pin, ready) => {
        if (!holding || held > 0) return inner(o, signal, pin, ready);
        held += 1;
        heldSeq = journal.snapshot().debited;
        await new Promise<void>((resolve) => (signal.aborted ? resolve() : signal.addEventListener("abort", () => resolve(), { once: true })));
        throw signal.reason ?? new Error("aborted");
      },
      observer: (e) => {
        if (e.type === "phase" && e.phase === "measurement") holding = true;
      },
    });
    const res = await r.result;
    assert.equal(held, 1, "a dial was held");
    assert.equal(res.status, "completed", why(r, res));
    // The executor's request timeout and the supervisor's turn timer can race.
    const cuts = res.journal!.cut;
    assert.equal((cuts.turn_closed ?? 0) + (cuts.revoked ?? 0), 1, why(r, res));
    assert.ok(heldSeq > 0, "the held dial had a debit");
    assert.deepEqual(res.handoffs!.unattempted, [heldSeq]);
    assert.ok(res.measurement.timeout + res.measurement.cancelled + res.measurement.failure >= 1, "its turn did not succeed");
    assert.ok(!arrivedSeqs(r.sink).includes(heldSeq), "the held debit never reached the sink");
    invariants(r, res);
  });

  test(`F6 (${jail.name}): the turn's deadline closes it on a queued write: the 1 MiB POST is reset and never completes`, jail.options, async (t) => {
    let measuring = false;
    let queued: Upstream | undefined;
    let queuedBytes = 0;
    let resets = 0;
    let stallNext = false;
    let resumed = false;
    const r = await start(t, jail.real, {
      plan: smallPlan({ exportName: "bigPost", users: 1, durationMs: 6_000, perJourneyMax: 1, allowedRequests: [{ method: "POST", path: "/upload" }] }),
      dial: (inner) => async (...args) => {
        const upstream = await inner(...args);
        if (!measuring || queued) return upstream;
        queued = upstream;
        upstream.socket.cork();
        return { ...upstream, reset: () => {
          queuedBytes = upstream.socket.writableLength;
          resets += 1;
          upstream.reset();
        } };
      },
      // Only the first upload in measurement is stalled at the target.
      stall: () => {
        if (!stallNext) return false;
        stallNext = false;
        return true;
      },
      observer: (e, x) => {
        if (e.type === "phase" && e.phase === "measurement") measuring = stallNext = true;
        // That turn's outcome comes after its deadline closed it: only then is the target read again.
        if (e.type === "outcome" && x.sink.stats.stalled >= 1 && !resumed) {
          resumed = true;
          queued?.socket.uncork();
          x.sink.resumeStalled();
        }
      },
    });
    const res = await r.result;
    assert.equal(r.sink.stats.stalled, 1, "one upload was stalled");
    assert.equal(resets, 1, "the upstream was reset");
    assert.ok(queuedBytes >= UPLOAD_BYTES, `the sender held ${queuedBytes} bytes when reset`);
    assert.equal(res.status, "completed", why(r, res));
    const uploads = r.sink.arrivals.filter((a) => a.url === "/upload" && a.body.length === UPLOAD_BYTES).length;
    assert.equal(uploads, res.checking.success + res.measurement.success, "the stalled upload never completed");
    assert.ok(r.sink.stats.aborted + r.sink.stats.socketErrors.length >= 1, `the target saw it end early: ${JSON.stringify(r.sink.stats)}`);
    // Handed off already, so closeTurn revokes its tunnel: the exchange is cut `revoked`, its upstream reset.
    assert.ok((res.journal!.cut.revoked ?? 0) >= 1, `cut revoked: ${why(r, res)}`);
    invariants(r, res);
  });
}
