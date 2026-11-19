/**
 * The sink oracle (T5): the committed engine (`dist/load.js` and `dist/load-executor.js`),
 * run in its own process against an independent HTTP target that records what actually
 * arrived. Every stop scenario first shows traffic, with requests outstanding at the cutoff,
 * while the plan still offers work past it; then the sink must see no new start and no
 * request after the bound.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { existsSync, mkdtempSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  alive,
  engineZeroWall,
  executorHostPid,
  newSink,
  permitIds,
  permits,
  recordStarts,
  signalGroup,
  startRun,
  type EngineEventLine,
  type EngineRun,
  type Finished,
} from "./support/load-run";
import type { LoadSink } from "./support/load-sink";

/** Scheduling noise allowed at the sink: a tick, a frame and a socket. */
const SLOP = 250;

async function until(condition: () => boolean, timeoutMs = 20_000): Promise<void> {
  const started = Date.now();
  while (!condition()) {
    if (Date.now() - started > timeoutMs) throw new Error("condition not met in time");
    await new Promise((r) => setTimeout(r, 10));
  }
}

/** Waits until measurement traffic is flowing and a request is outstanding at the sink. */
async function waitForBusyTraffic(run: EngineRun, sink: LoadSink): Promise<number> {
  await run.waitFor((events) => events.some((e) => e.type === "marker" && (e.marker as { detail?: string }).detail === "measurement"));
  await until(() => sink.requests.length >= 4 && sink.outstandingAt(Date.now()).length > 0);
  return Date.now();
}

function judged(run: EngineRun, sink: LoadSink): void {
  recordStarts(sink, run.events());
}

function measurementStartsAfter(sink: LoadSink, wallMs: number) {
  return sink.startsAfter(wallMs).filter((s) => s.phase === "measurement");
}

/** Every arrival carried a permit of its own, and went exactly where that permit approved. */
function noBypass(run: EngineRun, sink: LoadSink): void {
  assert.deepEqual(
    sink.bypasses(permitIds(run.events())).map((r) => r.path),
    [],
  );
  assert.deepEqual(
    sink.mismatches(permits(run.events())).map((m) => `${m.request.method} ${m.request.host}${m.request.path} for ${m.approved}`),
    [],
  );
}

/**
 * Binds each arrival to its permit, and the permit to the last renewal accepted before it
 * was given: the arrival must fall inside that renewal's permission, counted from when the
 * renewal was *asked* (`leaseMs` after, or less when the answer granted less).
 */
function withinRenewals(events: EngineEventLine[], done: Finished, sink: LoadSink, leaseMs: number): void {
  const asked = new Map(done.renewals.map((r) => [r.seq, r.askedWallMs]));
  const accepted = events.filter((e) => e.type === "renewal" && e.accepted).map((e) => ({ seq: Number(e.seq), at: Number(e.at) }));
  const byId = new Map(permits(events).map((p) => [p.id, p]));
  for (const request of sink.requests) {
    const permit = byId.get(request.permit ?? "");
    assert.ok(permit, `an arrival with no permit: ${request.path}`);
    const before = accepted.filter((r) => r.at <= permit.wallMs);
    assert.ok(before.length > 0, "a permit given before any renewal was accepted");
    const renewal = before[before.length - 1]!;
    const bound = asked.get(renewal.seq)! + leaseMs;
    assert.ok(permit.wallMs <= bound + SLOP, `permit ${permit.id} given ${permit.wallMs - bound} ms after its renewal's permission ended`);
    assert.ok(request.arrivalMs <= bound + SLOP, `a send ${request.arrivalMs - bound} ms after its renewal's permission ended`);
  }
}

function processesGone(run: EngineRun): void {
  for (const pid of run.executorPids()) assert.equal(alive(pid), false, `executor process ${pid} still running`);
}

test("Stop: no new start after it, and the work in flight finishes within the grace", async (t) => {
  const sink = await newSink(t);
  sink.holdMs = 1_500;
  const run = await startRun(t, sink, {
    plan: { module: "basic.ts", export: "readValue", users: 3, holdMs: 30_000 },
    constants: { stopGraceMs: 3_000 },
  });
  await waitForBusyTraffic(run, sink);
  const outstanding = sink.outstandingAt(Date.now());
  const stopWall = Date.now();
  process.kill(run.child.pid!, "SIGUSR1");
  const done: Finished = await run.finished();
  judged(run, sink);

  assert.equal(done.result.status, "stopped");
  assert.ok(outstanding.length > 0);
  assert.ok(sink.requests.some((r) => r.arrivalMs < stopWall), "no traffic before the stop");
  assert.deepEqual(measurementStartsAfter(sink, stopWall + SLOP), [], "a journey started after the stop");
  // In-flight work completed inside the grace, and was not cut off.
  for (const r of outstanding) {
    assert.equal(r.aborted, false, `${r.path} was cut off`);
    assert.ok(r.endMs !== null && r.endMs <= stopWall + 3_000 + SLOP, `${r.path} ended late`);
  }
  // One request per journey: nothing new reaches the sink once the stop has landed.
  assert.deepEqual(sink.requestsAfter(stopWall + SLOP).map((r) => r.path), []);
  noBypass(run, sink);
  processesGone(run);
});

test("Stop now: no request reaches the sink after it, and what was in flight is cut off", async (t) => {
  const sink = await newSink(t);
  sink.holdMs = 2_500;
  const run = await startRun(t, sink, {
    plan: { module: "basic.ts", export: "readValue", users: 3, holdMs: 30_000 },
  });
  await waitForBusyTraffic(run, sink);
  const outstanding = sink.outstandingAt(Date.now());
  const stopWall = Date.now();
  process.kill(run.child.pid!, "SIGUSR2");
  const done = await run.finished();
  judged(run, sink);

  assert.equal(done.result.status, "stopped");
  assert.equal(done.result.reason, "stop now");
  assert.ok(outstanding.length > 0);
  // The spec's bound is 10 s; the kill is immediate.
  assert.deepEqual(sink.requestsAfter(stopWall + SLOP), []);
  assert.deepEqual(measurementStartsAfter(sink, stopWall + SLOP), []);
  for (const r of outstanding) assert.equal(r.aborted, true, `${r.path} was answered after Stop now`);
  processesGone(run);
});

test("a lost lease: starts fenced at the last renewal plus the lease, then drain, then the kill", async (t) => {
  const sink = await newSink(t);
  // Each request is held longer than the lease, so one is in flight whenever the lease ends.
  sink.holdMs = 5_000;
  const run = await startRun(t, sink, {
    plan: { module: "basic.ts", export: "readValue", users: 3, holdMs: 30_000 },
    constants: { leaseMs: 3_000, stopGraceMs: 1_000, turnDeadlineMs: 8_000 },
    port: { silentAfterMs: 4_000 },
  });
  const done = await run.finished();
  judged(run, sink);

  assert.equal(done.result.status, "lease_lost");
  const answered = done.renewals.filter((r) => r.answeredWallMs !== null);
  const lastRenewal = Math.max(...answered.map((r) => r.askedWallMs));
  const fencedAt = lastRenewal + 3_000;
  assert.ok(sink.requests.some((r) => r.arrivalMs < fencedAt - 1_000), "no traffic before the cutoff");
  assert.ok(sink.outstandingAt(fencedAt).length > 0, "nothing outstanding at the cutoff");
  assert.deepEqual(measurementStartsAfter(sink, fencedAt + SLOP), [], "a journey started after the lease ended");
  assert.deepEqual(sink.requestsAfter(fencedAt + SLOP).map((r) => r.path), [], "a send after the lease ended");
  // After the drain the containment kill: nothing outstanding survives it.
  const killedBy = fencedAt + 1_000 + SLOP * 2;
  for (const r of sink.requests) assert.ok(r.endMs !== null && r.endMs <= killedBy, `${r.path} outlived the kill by ${r.endMs === null ? "ever" : `${r.endMs - killedBy} ms`}`);
  const kinds = done.markers.map((m) => m.kind);
  assert.ok(kinds.includes("lease_lost") && kinds.includes("executor_killed"), kinds.join(","));
  processesGone(run);
});

for (const [name, port] of [
  // Too old for the age bound: refused, so the lease runs out.
  ["delayed past the age bound", { delayMs: 1_700, delayAfterMs: 3_000 }],
  // Young enough to be accepted: only counting from the send time keeps permission honest
  // when the answers stop.
  ["delayed within the age bound", { delayMs: 1_000, delayAfterMs: 0, silentAfterMs: 4_500 }],
  ["reordered", { reorderAfterMs: 3_000 }],
] as const) {
  test(`renewals ${name} never extend permission`, async (t) => {
    const sink = await newSink(t);
    sink.holdMs = 50;
    const run = await startRun(t, sink, {
      plan: {
        module: "basic.ts",
        export: "readFive",
        users: 4,
        holdMs: 12_000,
      },
      constants: { leaseMs: 3_000, stopGraceMs: 500 },
      options: { maxRenewalAgeMs: 1_500 },
      port,
    });
    const done = await run.finished();
    const events = run.events();
    const renewals = events.filter((e) => e.type === "renewal");
    // An answer is accepted only for a newer seq than any accepted before it.
    let highest = 0;
    for (const r of renewals.filter((e) => e.accepted)) {
      assert.ok((r.seq as number) > highest, `seq ${String(r.seq)} accepted after ${highest}`);
      highest = r.seq as number;
    }
    assert.ok(sink.requests.length > 10, `${sink.requests.length} requests`);
    withinRenewals(events, done, sink, 3_000);
    if (name === "delayed past the age bound") {
      assert.ok(
        renewals.some((e) => e.reason === "too_old"),
        "no delayed answer was refused",
      );
      assert.equal(done.result.status, "lease_lost");
    } else if (name === "delayed within the age bound") {
      assert.ok(renewals.filter((e) => e.accepted).length >= 3, "the delayed answers were not accepted");
      assert.equal(done.result.status, "lease_lost");
      // Sends ran right up to the end of permission, so a later end would have shown.
      const lastAccepted = Math.max(...renewals.filter((e) => e.accepted).map((e) => Number(e.seq)));
      const end = done.renewals.find((r) => r.seq === lastAccepted)!.askedWallMs + 3_000;
      assert.ok(
        sink.requests.some((r) => r.arrivalMs > end - 600),
        "no traffic near the end of permission",
      );
    } else {
      assert.ok(
        renewals.some((e) => e.reason === "stale_seq"),
        "no reordered answer was refused",
      );
    }
    noBypass(run, sink);
  });
}

// The whole job, or the supervisor alone: then the executor never sees a pause of its own, so
// only the supervisor's resume fence holds starts and permits back.
for (const [what, wholeJob, frozenMs, deadManMs] of [
  ["the whole job", true, 3_000, 3_000],
  ["the supervisor alone", false, 2_500, 6_000],
] as const) {
  test(`${what} SIGSTOPped and resumed: nothing starts or is sent until a fresh renewal is accepted`, async (t) => {
    const sink = await newSink(t);
    sink.holdMs = 50;
    // Renewals asked from 3.8 s on come back 2 s late, so after the resume the fence stays up
    // across every user's next due tick (pacing 1 s) and their asks.
    const run = await startRun(t, sink, {
      plan: {
        module: "basic.ts",
        export: "readFive",
        users: 4,
        holdMs: 30_000,
      },
      constants: { leaseMs: 9_000 },
      options: { deadManMs, maxRenewalAgeMs: 4_000 },
      port: { delayMs: 2_000, delayAfterMs: 3_800 },
      stopAfterMs: 11_000,
    });
    const born = (await run.waitFor((e) => e.some((x) => x.type === "harness")))[0]!.at;
    await run.waitFor((e) => e.some((x) => x.type === "marker" && (x.marker as { detail?: string }).detail === "measurement"));
    await until(() => Date.now() >= born + 4_000);
    const groups = wholeJob ? [run.child.pid!, ...run.executorPids().slice(0, 1)] : [run.child.pid!];
    for (const pid of groups) signalGroup(pid, "SIGSTOP");
    const stoppedAt = Date.now();
    await new Promise((r) => setTimeout(r, frozenMs));
    const resumedAt = Date.now();
    for (const pid of groups) signalGroup(pid, "SIGCONT");
    const done = await run.finished();
    judged(run, sink);
    const events = run.events();

    const kinds = done.markers.map((m) => m.kind);
    assert.ok(kinds.includes("resume_fence"), kinds.join(","));
    assert.ok(kinds.includes("resume_cleared"), kinds.join(","));
    const fresh = events.filter((e) => e.type === "renewal" && e.accepted && Number(e.at) >= resumedAt);
    assert.ok(fresh.length > 0, "no renewal accepted after the resume");
    const firstFresh = Math.min(...fresh.map((e) => Number(e.at)));
    assert.ok(firstFresh - resumedAt >= 1_500, `the fresh renewal came back too soon to prove anything: ${firstFresh - resumedAt} ms`);
    assert.deepEqual(
      sink
        .requestsAfter(resumedAt)
        .filter((r) => r.arrivalMs < firstFresh)
        .map((r) => r.path),
      [],
      "sent after the resume before a fresh renewal",
    );
    assert.deepEqual(
      measurementStartsAfter(sink, resumedAt).filter((s) => s.wallMs < firstFresh),
      [],
      "started after the resume before a fresh renewal",
    );
    // A running executor may still use a permit given before the stop, until it expires (1 s).
    const quiet = stoppedAt + (wholeJob ? 0 : 1_000) + SLOP;
    assert.deepEqual(
      sink.requests.filter((r) => r.arrivalMs > quiet && r.arrivalMs < resumedAt),
      [],
    );
    // Work fell due while fenced: it was missed or held, never run.
    assert.ok(done.result.measurement.missed > 0 || (done.result.permits.denied.fenced ?? 0) > 0, "nothing fell due while fenced");
    // The run carried on afterwards.
    assert.ok(sink.requestsAfter(firstFresh).length > 0, "traffic never resumed");
    noBypass(run, sink);
  });
}

test("a frozen supervisor: permits stop, and the executor's dead-man ends traffic within one lease", async (t) => {
  const sink = await newSink(t);
  sink.holdMs = 200;
  const run = await startRun(t, sink, {
    plan: { module: "basic.ts", export: "readFive", users: 3, holdMs: 30_000 },
    constants: { leaseMs: 3_000 },
    options: { deadManMs: 1_500 },
  });
  await waitForBusyTraffic(run, sink);
  const executor = executorHostPid(run.events());
  assert.ok(executor, "no executor pid");
  process.kill(-run.child.pid!, "SIGSTOP");
  const frozenAt = Date.now();
  t.after(() => {
    try {
      process.kill(-run.child.pid!, "SIGCONT");
    } catch {
      // gone
    }
  });
  await until(() => !alive(executor!), 5_000);
  const goneAt = Date.now();
  assert.ok(goneAt - frozenAt <= 3_000, `the executor outlived the lease: ${goneAt - frozenAt} ms`);
  // A frozen supervisor gives no permits: nothing new reaches the sink.
  assert.deepEqual(sink.requestsAfter(frozenAt + SLOP).map((r) => r.path), []);
  process.kill(-run.child.pid!, "SIGCONT");
  const done = await run.finished();
  assert.equal(done.result.status, "failed");
});

test("a hung executor (a busy loop) is killed at the turn deadline plus the grace", async (t) => {
  const sink = await newSink(t);
  const run = await startRun(t, sink, {
    plan: { module: "hang.ts", export: "busyLoop", users: 1, holdMs: 30_000 },
    constants: { turnDeadlineMs: 2_000 },
    options: { killGraceMs: 1_000 },
  });
  const events = await run.waitFor((e) => e.some((x) => x.type === "started"));
  const startedAt = Number(events.find((e) => e.type === "started")!.wallMs);
  const done = await run.finished();
  assert.equal(done.result.status, "failed");
  assert.equal(done.result.reason, "the executor stopped responding");
  const killed = done.markers.find((m) => m.kind === "executor_killed")!;
  assert.ok(killed.wallMs <= startedAt + 2_000 + 1_000 + SLOP * 2, `killed ${killed.wallMs - startedAt} ms after the start`);
  assert.equal(sink.requests.length, 1);
  processesGone(run);
});

test("a Checking timeout sends no measurement traffic", async (t) => {
  const sink = await newSink(t);
  const run = await startRun(t, sink, {
    plan: { module: "basic.ts", export: "slow", users: 2, holdMs: 30_000 },
    constants: { checkingDeadlineMs: 2_000 },
  });
  const done = await run.finished();
  judged(run, sink);
  assert.equal(done.result.status, "didnt_start");
  assert.equal(done.result.checking.timeout, 2);
  assert.deepEqual(sink.starts.filter((s) => s.phase === "measurement"), []);
  assert.deepEqual(permitIds(run.events()).filter((id) => id.includes(".m.")), []);
  assert.equal(sink.requests.length, 2);
  for (const r of sink.requests) assert.equal(r.aborted, true, "the timed-out request was not cancelled");
});

test("concurrency is held at the sink, measured by overlap", async (t) => {
  const sink = await newSink(t);
  sink.holdMs = 300;
  const run = await startRun(t, sink, {
    plan: {
      module: "basic.ts",
      export: "readFiveAtOnce",
      users: 2,
      holdMs: 5_000,
      perJourneyMax: 5,
    },
    constants: { turnDeadlineMs: 4_000 },
  });
  const done = await run.finished();
  assert.ok(sink.requests.length >= 10, `${sink.requests.length} requests`);
  assert.ok(sink.peakConcurrency() <= 2, `peak ${sink.peakConcurrency()}`);
  assert.equal(sink.peakConcurrency(), 2);
  assert.ok(done.result.checking.success >= 1);
  noBypass(run, sink);
});

test("rate and burst are held at the sink", async (t) => {
  const sink = await newSink(t);
  const run = await startRun(t, sink, {
    plan: {
      module: "basic.ts",
      export: "readFive",
      users: 2,
      holdMs: 6_000,
      perJourneyMax: 5,
    },
    constants: { maxRatePerSecond: 4, maxBurst: 2, turnDeadlineMs: 4_000 },
  });
  await run.finished();
  // In any second: the burst plus a second's worth of rate.
  assert.ok(sink.peakArrivals(1_000) <= 2 + 4, `peak ${sink.peakArrivals(1_000)} in a second`);
  assert.ok(sink.peakArrivals(100) <= 2 + 1, `peak ${sink.peakArrivals(100)} in 100 ms`);
  assert.ok(sink.requests.length >= 8);
  noBypass(run, sink);
});

test("the total and the per-journey maximum are held at the sink", async (t) => {
  const sink = await newSink(t);
  // Checking: 2 users × 5 requests, but a total of 3.
  const run = await startRun(t, sink, {
    plan: {
      module: "basic.ts",
      export: "readFive",
      users: 2,
      holdMs: 3_000,
      perJourneyMax: 5,
    },
    constants: { checkingDailyRequests: 3 },
  });
  const done = await run.finished();
  assert.equal(sink.requests.length, 3);
  assert.equal(done.result.status, "didnt_start");
  assert.ok((done.result.permits.denied.total ?? 0) >= 1);

  const sink2 = await newSink(t);
  const run2 = await startRun(t, sink2, {
    plan: {
      module: "basic.ts",
      export: "readFive",
      users: 1,
      holdMs: 3_000,
      perJourneyMax: 2,
    },
  });
  const done2 = await run2.finished();
  // The one Checking turn gets two sends, then is refused.
  assert.equal(sink2.requests.length, 2);
  assert.equal(done2.result.permits.denied.per_journey, 1);
});

for (const [name, journey, path] of [
  ["a network reset", "reset", "/reset"],
  ["a 401 with a Basic challenge", "basic", "/basic"],
  ["a 302", "redirect", "/redirect"],
] as const) {
  test(`a one-request budget answered with ${name} is exactly one send`, async (t) => {
    const sink = await newSink(t);
    const run = await startRun(t, sink, {
      plan: {
        module: "one-request.ts",
        export: journey,
        users: 1,
        holdMs: 3_000,
        perJourneyMax: 1,
      },
    });
    const done = await run.finished();
    assert.deepEqual(sink.requests.map((r) => r.path), [path]);
    assert.equal(done.result.permits.issued, 1);
    assert.equal(done.result.status, "didnt_start");
    noBypass(run, sink);
  });
}

test("a journey asking for retries is refused before anything is sent", async (t) => {
  const sink = await newSink(t);
  const run = await startRun(t, sink, {
    plan: {
      module: "one-request.ts",
      export: "retries",
      users: 1,
      holdMs: 3_000,
      perJourneyMax: 1,
    },
  });
  const done = await run.finished();
  assert.deepEqual(sink.requests, []);
  assert.match(done.result.checking.failures[0]!.message, /retries are not allowed/);
});

test("an unlisted origin and an unlisted write are refused; a redirect is not followed", async (t) => {
  for (const [journey, expectedRequests, reason] of [
    ["unlisted", 0, "origin"],
    ["unlistedWrite", 0, "method"],
    ["redirectOut", 1, null],
  ] as const) {
    const sink = await newSink(t);
    const run = await startRun(t, sink, {
      plan: { module: "origins.ts", export: journey, users: 1, holdMs: 3_000 },
    });
    const done = await run.finished();
    assert.equal(sink.requests.length, expectedRequests, journey);
    if (reason) {
      assert.equal(done.result.permits.denied[reason], 1, journey);
      assert.match(done.result.checking.failures[0]!.message, new RegExp(`request refused \\(${reason}\\)`));
    } else {
      assert.match(done.result.checking.failures[0]!.message, /Expected: 200\s+Received: 302/);
    }
    assert.equal(done.result.status, "didnt_start");
  }
});

test("raw fetch and node:http from the journey are reported as bypasses and counted", async (t) => {
  const sink = await newSink(t);
  const run = await startRun(t, sink, {
    plan: { module: "raw.ts", export: "rawClients", users: 1, holdMs: 2_000 },
  });
  const done = await run.finished();
  const events = run.events();
  const bypasses = sink.bypasses(permitIds(events));
  assert.ok(bypasses.length >= 2);
  assert.deepEqual([...new Set(bypasses.map((r) => r.path))].sort(), ["/raw-fetch", "/raw-http"]);
  assert.equal(done.result.bypasses.count, bypasses.length);
  assert.deepEqual([...new Set(done.result.bypasses.samples.map((s) => s.kind))].sort(), ["fetch", "node:http"]);
  // The journey's own request through the context carried a permit.
  assert.ok(sink.requests.some((r) => r.path === "/value" && r.permit));
});

test("a start that never sends is still recorded as a start", async (t) => {
  const sink = await newSink(t);
  const run = await startRun(t, sink, {
    plan: { module: "basic.ts", export: "noSend", users: 2, holdMs: 3_000 },
  });
  const done = await run.finished();
  judged(run, sink);
  assert.equal(sink.requests.length, 0);
  assert.equal(sink.starts.length, done.result.checking.users + done.result.measurement.started);
  assert.ok(done.result.measurement.started >= 4);
  assert.equal(done.result.status, "finished");
});

test("a journey trying to send somewhere its permit didn't approve is refused, and nothing mismatched arrives", async (t) => {
  const sink = await newSink(t);
  const run = await startRun(t, sink, {
    plan: { module: "smuggle.ts", export: "smuggle", users: 1, holdMs: 2_000 },
  });
  const done = await run.finished();
  assert.equal(done.result.status, "finished", String(done.result.reason));
  assert.ok(sink.requests.length >= 1);
  assert.deepEqual([...new Set(sink.requests.map((r) => `${r.method} ${r.path}`))], ["GET /value?from=smuggle"]);
  noBypass(run, sink);
});

test("measurement turns keep their whole deadline after a slow Checking", async (t) => {
  const sink = await newSink(t);
  // Checking takes 1.5 s of the run; the plan's last turns still get their full deadline.
  sink.holdMs = 1_500;
  const run = await startRun(t, sink, {
    plan: { module: "basic.ts", export: "readValue", users: 2, holdMs: 6_000 },
    constants: { stopGraceMs: 1_000, turnDeadlineMs: 3_000 },
  });
  const done = await run.finished();
  assert.equal(done.result.status, "finished", String(done.result.reason));
  assert.equal(done.result.measurement.timeout, 0);
  assert.ok(done.result.measurement.success >= 6, JSON.stringify(done.result.measurement));
  assert.equal(done.result.permits.denied.turn_deadline ?? 0, 0);
});

/** A directory the executor (uid 65534) can leave a mark in. */
function markerPath(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "peeps-load-marker-"));
  chmodSync(dir, 0o777);
  return path.join(dir, "loaded");
}

test("a stop before the lease is held loads no customer code", async (t) => {
  const sink = await newSink(t);
  const marker = markerPath();
  const run = await startRun(t, sink, {
    plan: {
      module: "startup.ts",
      export: "readValue",
      users: 1,
      holdMs: 3_000,
    },
    options: { executorEnv: { LOAD_MARKER: marker } },
    // The port answers nothing for a while, then the stop lands.
    port: { delayMs: 1_500 },
    stopAfterMs: 500,
  });
  const done = await run.finished();
  assert.equal(done.result.status, "stopped");
  assert.equal(existsSync(marker), false, "the journey module was loaded");
  assert.equal(sink.requests.length, 0);
  assert.deepEqual(
    run.events().filter((e) => e.type === "started"),
    [],
  );
});

test("a lease never granted loads no customer code", async (t) => {
  const sink = await newSink(t);
  const marker = markerPath();
  const run = await startRun(t, sink, {
    plan: {
      module: "startup.ts",
      export: "readValue",
      users: 1,
      holdMs: 3_000,
    },
    options: { executorEnv: { LOAD_MARKER: marker } },
    port: { refuseAfterMs: 0 },
  });
  const done = await run.finished();
  assert.equal(done.result.status, "didnt_start");
  assert.equal(existsSync(marker), false, "the journey module was loaded");
  assert.equal(sink.requests.length, 0);
});

test("the run's absolute end holds over a stop's drain and the phase's own end", async (t) => {
  const sink = await newSink(t);
  // The lease answers come 1.5 s late, so Checking starts late; with a short Checking
  // deadline the absolute end (Checking's deadline plus the hold plus the grace, from the
  // engine's start) falls well before the measurement phase's own end. A stop just before
  // the absolute end would drain past it.
  sink.holdMs = 1_500;
  const run = await startRun(t, sink, {
    plan: { module: "basic.ts", export: "readValue", users: 2, holdMs: 3_000 },
    constants: {
      leaseMs: 9_000,
      checkingDeadlineMs: 1_800,
      stopGraceMs: 3_000,
      turnDeadlineMs: 10_000,
    },
    port: { delayMs: 1_500 },
  });
  const events = await run.waitFor((e) => e.some((x) => x.type === "marker" && (x.marker as { detail?: string }).detail === "measurement"));
  sink.holdMs = 20_000;
  const zero = engineZeroWall(events);
  const absoluteEnd = zero + 1_800 + 3_000 + 3_000;
  const measurementAt = Number(events.find((x) => x.type === "marker" && (x.marker as { detail?: string }).detail === "measurement")!.wallMs);
  assert.ok(measurementAt + 6_000 > absoluteEnd + 800, `the phase's own end is too close to the absolute end: ${measurementAt + 6_000 - absoluteEnd} ms`);
  await until(() => Date.now() >= absoluteEnd - 1_000);
  process.kill(run.child.pid!, "SIGUSR1");
  const done = await run.finished();
  assert.equal(done.result.reason, "the run reached its absolute end");
  assert.ok(
    sink.requests.some((r) => r.arrivalMs > measurementAt),
    "no measurement traffic",
  );
  assert.deepEqual(
    sink.requestsAfter(absoluteEnd + SLOP).map((r) => r.path),
    [],
    "a send after the absolute end",
  );
  for (const r of sink.requests)
    assert.ok(r.endMs !== null && r.endMs <= absoluteEnd + SLOP * 2, `${r.path} outlived the absolute end by ${(r.endMs ?? Infinity) - absoluteEnd} ms`);
  noBypass(run, sink);
});
