/**
 * The executor through the mini supervisor, a real GateProxy and the HTTPS sink (e4 plan v3
 * §3.1 `load-executor`). Runs on this checkout's Playwright, and again at the 1.46 floor when
 * PEEPS_LOAD_PLAYWRIGHT_DIR names a folder holding node_modules/playwright-core (ci.yml).
 */
import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { connect as netConnect } from "node:net";
import os from "node:os";
import path from "node:path";
import { sharedClocks } from "../src/load/clocks";
import { CUT_HEADER as GATE_CUT, DENIED_HEADER as GATE_DENIED, RETRY_HEADER as GATE_RETRY } from "../src/load/gate/proxy";
import { CUT_HEADER, DENIED_HEADER, RETRY_HEADER, WAITABLE } from "../src/load/session";
import type { Dial } from "../src/load/gate/proxy";
import { MiniSupervisor, type MiniOptions } from "./support/mini-supervisor";
import { FIXTURES, fixtureWorkspace, respond } from "./support/e4-fixtures";

const FLOOR_DIR = process.env.PEEPS_LOAD_PLAYWRIGHT_DIR;

async function mini(t: TestContext, exportName: string, o: Partial<MiniOptions> = {}): Promise<MiniSupervisor> {
  const m = await MiniSupervisor.start(t, { journey: { module: "journeys.ts", export: exportName }, workspace: fixtureWorkspace(t), respond, ...o });
  const loaded = await m.init();
  assert.equal(loaded.type, "loaded", JSON.stringify(loaded) + m.link.stderr());
  if (FLOOR_DIR) assert.match((loaded as { playwright: string }).playwright, /^1\.46\./, "the floor run uses Playwright 1.46");
  return m;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

test("the session reads the gate's own header names", () => {
  assert.deepEqual([DENIED_HEADER, CUT_HEADER, RETRY_HEADER], [GATE_DENIED, GATE_CUT, GATE_RETRY]);
  assert.deepEqual([...WAITABLE].sort(), ["ceiling", "dials", "memory", "outstanding", "phase_total", "rate", "tunnels", "users"]);
});

test("50 requests: no credential denial, one CONNECT each, each with its turn's credential", async (t) => {
  const m = await mini(t, "getTen");
  const turns = [];
  for (let i = 0; i < 5; i++) {
    const opened = m.open(1 + (i % 2));
    turns.push(opened);
    assert.equal((await opened.outcome).kind, "success");
  }
  assert.equal(m.sink.arrivals.length, 50);
  const snap = m.journal.snapshot();
  assert.equal(snap.denied.credential, undefined, JSON.stringify(snap.denied));
  assert.deepEqual(snap.denied, {});
  assert.equal(m.connects.length, 50, "one CONNECT per request");
  for (const opened of turns) assert.equal(m.connects.filter((c) => c === opened.credential).length, 10, "each turn's requests carried its own credential");
});

/** A raw CONNECT with `credential`: the proxy's first status line. */
function connectWith(m: MiniSupervisor, credential: string): Promise<string> {
  const address = m.proxy.server.address() as import("node:net").AddressInfo;
  return new Promise((resolve) => {
    const s = netConnect(address.port, "127.0.0.1");
    let got = "";
    s.on("data", (d) => (got += d.toString("latin1")));
    s.on("close", () => resolve(got));
    s.on("error", () => resolve(got));
    s.write(`CONNECT sink.test:${m.sink.port} HTTP/1.1\r\nHost: sink.test:${m.sink.port}\r\nProxy-Authorization: ${credential}\r\n\r\n`);
    setTimeout(() => s.destroy(), 2000);
  });
}

test("a closed turn's credential is refused while the slot's next turn works", async (t) => {
  const m = await mini(t, "get");
  const first = m.open(1);
  assert.equal((await first.outcome).kind, "success");
  assert.match(await connectWith(m, first.credential), /^HTTP\/1\.1 403[^]*x-peeps-load-denied: turn_closed/);
  const before = m.sink.arrivals.length;
  const second = m.open(1);
  assert.equal((await second.outcome).kind, "success");
  assert.notEqual(second.credential, first.credential, "a fresh credential");
  assert.equal(m.sink.arrivals.length, before + 1);
});

test("12 parallel GETs all return 200", async (t) => {
  const m = await mini(t, "twelveAtOnce", { parallel: 4 });
  const o = await m.turn(1);
  assert.equal(o.kind, "success", o.message);
  assert.equal(m.sink.arrivals.length, 12);
});

test("a final refusal raises GateDenied and the outcome is failure", async (t) => {
  const m = await mini(t, "notAllowed");
  const o = await m.turn(1);
  assert.equal(o.kind, "failure");
  assert.match(o.message ?? "", /GateDenied.*not_allowed/);
  assert.equal(o.location, "journeys.ts:28");
  assert.equal(m.sink.arrivals.length, 0);
});

test("a target's own 503 passes untouched", async (t) => {
  const m = await mini(t, "target503");
  const o = await m.turn(1);
  assert.equal(o.kind, "success", o.message);
  assert.equal(m.sink.arrivals.length, 1);
});

test("rate, ceiling and a header-less dials denial are waited out and re-sent within the deadline", async (t) => {
  // rate: one request a second, and no burst beyond one.
  const rate = await mini(t, "three", { phase: { ratePerSecond: 4, burst: 1 } });
  const o1 = await rate.turn(1, { deadlineMs: 10_000 });
  assert.equal(o1.kind, "success", o1.message);
  assert.equal(rate.sink.arrivals.length, 3);
  assert.ok((rate.journal.snapshot().denied.rate ?? 0) >= 1, "the gate did refuse on rate");

  // ceiling: one request allowed until the lease grows.
  const ceiling = await mini(t, "three", { lease: { ceiling: 1 }, renewEveryMs: 100 });
  const pending = ceiling.turn(1, { deadlineMs: 10_000 });
  await sleep(400);
  assert.equal(ceiling.sink.arrivals.length, 1);
  const now = sharedClocks();
  ceiling.gate.applyLease({ seq: 2, monoUntil: now.monoMs + 600_000, wallUntil: now.wallMs + 600_000, ceiling: 100 });
  const o2 = await pending;
  assert.equal(o2.kind, "success", o2.message);
  assert.equal(ceiling.sink.arrivals.length, 3);
  assert.ok((ceiling.journal.snapshot().denied.ceiling ?? 0) >= 1);

  // dials: one dial at a time for the run, held 150 ms each, two users at once.
  const slowDial = (inner: Dial): Dial => async (o, signal, pin, ready) => {
    await sleep(150);
    return inner(o, signal, pin, ready);
  };
  const dials = await mini(t, "three", { proxyLimits: { maxPendingDials: 1 }, dial: slowDial });
  const both = await Promise.all([dials.turn(1, { deadlineMs: 15_000 }), dials.turn(2, { deadlineMs: 15_000 })]);
  for (const o of both) assert.equal(o.kind, "success", o.message);
  assert.equal(dials.sink.arrivals.length, 6);
  assert.ok((dials.journal.snapshot().denied.dials ?? 0) >= 1, "the gate did refuse on dials");
});

test("a redirect is returned, not followed; a cut is not re-sent", async (t) => {
  const r = await mini(t, "redirect");
  assert.equal((await r.turn(1)).kind, "success");
  await sleep(300);
  assert.deepEqual(r.sink.arrivals.map((a) => a.url), ["/redirect"], "no follow-up arrival");

  const c = await mini(t, "cut", { proxyLimits: { exchangeMs: 300 } });
  const o = await c.turn(1);
  assert.equal(o.kind, "failure");
  assert.match(o.message ?? "", /GateDenied.*cut.*exchange_timeout/);
  await sleep(500);
  assert.equal(c.sink.arrivals.length, 1, "the cut request was not sent again");
  assert.equal(c.journal.snapshot().cut.exchange_timeout, 1);
});

test("refused options never reach the target", async (t) => {
  for (const [name, why] of [
    ["optRetries", /retries/],
    ["optRedirects", /redirects/],
    ["optIgnoreHttps", /ignoreHTTPSErrors/],
    ["optStream", /streams/],
    ["optDispose", /cannot dispose/],
  ] as const) {
    const m = await mini(t, name);
    const o = await m.turn(1);
    assert.equal(o.kind, "failure", name);
    assert.match(o.message ?? "", why, name);
    assert.equal(m.sink.arrivals.length, 0, name);
  }
});

test("fatal: no Playwright, Playwright below 1.46, a journey that throws as it loads", async (t) => {
  const bare = mkdtempSync(path.join(os.tmpdir(), "peeps-no-pw-"));
  t.after(() => rmSync(bare, { recursive: true, force: true }));
  cpSync(FIXTURES, bare, { recursive: true });
  const none = await MiniSupervisor.start(t, { journey: { module: "journeys.ts", export: "get" }, workspace: bare, respond });
  const f1 = await none.init();
  assert.equal(f1.type, "fatal");
  assert.equal((f1 as { code: string }).code, "playwright");

  const old = mkdtempSync(path.join(os.tmpdir(), "peeps-old-pw-"));
  t.after(() => rmSync(old, { recursive: true, force: true }));
  cpSync(FIXTURES, old, { recursive: true });
  mkdirSync(path.join(old, "node_modules/playwright-core"), { recursive: true });
  writeFileSync(path.join(old, "node_modules/playwright-core/package.json"), JSON.stringify({ name: "playwright-core", version: "1.45.3", main: "index.js" }));
  writeFileSync(path.join(old, "node_modules/playwright-core/index.js"), "throw new Error('an old Playwright must not even be loaded');");
  const below = await MiniSupervisor.start(t, { journey: { module: "journeys.ts", export: "get" }, workspace: old, respond });
  const f2 = await below.init();
  assert.equal(f2.type, "fatal");
  assert.equal((f2 as { code: string }).code, "playwright");
  assert.match((f2 as { message: string }).message, /1\.45\.3 is below 1\.46/);

  const throws = await MiniSupervisor.start(t, { journey: { module: "throws-on-load.ts", export: "journey" }, workspace: fixtureWorkspace(t), respond });
  const f3 = await throws.init();
  assert.equal(f3.type, "fatal");
  assert.equal((f3 as { code: string }).code, "journey");
  assert.match((f3 as { message: string }).message, /fails as it loads/);
});

test("a turn for a busy slot is fatal (protocol)", async (t) => {
  const m = await mini(t, "hang");
  m.open(1, { deadlineMs: 60_000 });
  m.open(2, { deadlineMs: 60_000 });
  // Bypass the gate's own slot check: the executor must refuse on its own.
  m.link.send({ type: "turn", turn: 999, slot: 1, password: "A".repeat(43), deadlineMono: sharedClocks().monoMs + 10_000 });
  const f = await m.waitFrame((x) => x.type === "fatal");
  assert.equal((f as { code: string }).code, "protocol");
  assert.match((f as { message: string }).message, /slot 1 is busy/);
  const exit = await m.link.exited;
  assert.notEqual(exit.code, 0);
});

test("cancel for an ended turn is a no-op; completion racing cancel gives exactly one outcome", async (t) => {
  const m = await mini(t, "quick");
  const first = m.open(1);
  assert.equal((await first.outcome).kind, "success");
  m.link.send({ type: "cancel", turn: first.turn });
  const second = m.open(1);
  assert.equal((await second.outcome).kind, "success", "the slot still works after a late cancel");

  for (let i = 0; i < 20; i++) {
    const racing = m.open(1 + (i % 3));
    m.link.send({ type: "cancel", turn: racing.turn });
    const o = await racing.outcome;
    assert.ok(o.kind === "success" || o.kind === "cancelled", o.kind);
  }
  await sleep(300);
  for (const [turn, list] of m.outcomes) assert.equal(list.length, 1, `turn ${turn}: ${JSON.stringify(list)}`);
  assert.equal(m.outcomes.get(first.turn)!.length, 1, "the late cancel added no outcome");
});
