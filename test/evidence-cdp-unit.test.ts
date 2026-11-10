/** The CDP collector's bookkeeping over a fake connection: when a target counts as lost, and when its take is final. */
import { test } from "node:test";
import assert from "node:assert/strict";

import { CdpCoverage, type CdpConnection } from "../src/evidence/browser/cdp-coverage";

type Handler = (params: Record<string, unknown>, sessionId?: string) => Promise<unknown> | unknown;

class FakeCdp implements CdpConnection {
  private handler: ((method: string, params: unknown, sessionId?: string) => void) | null = null;
  readonly sent: Array<{ method: string; sessionId?: string }> = [];
  constructor(private readonly answers: Record<string, Handler> = {}) {}
  send(method: string, params: object = {}, sessionId?: string): Promise<unknown> {
    this.sent.push({ method, ...(sessionId ? { sessionId } : {}) });
    const answer = this.answers[method];
    return Promise.resolve(answer ? answer(params as Record<string, unknown>, sessionId) : {});
  }
  onEvent(handler: (method: string, params: unknown, sessionId?: string) => void): void {
    this.handler = handler;
  }
  private closers: Array<() => void> = [];
  onClose(handler: () => void): void {
    this.closers.push(handler);
  }
  close(): void {
    for (const closer of this.closers) closer();
  }
  emit(method: string, params: unknown, sessionId?: string): void {
    this.handler!(method, params, sessionId);
  }
  attach(sessionId: string, browserContextId: string, type = "page"): void {
    this.emit("Target.attachedToTarget", { sessionId, targetInfo: { targetId: `t-${sessionId}`, type, browserContextId }, waitingForDebugger: false });
  }
}

const tick = () => new Promise((resolve) => setImmediate(resolve));
const coverageOf = (fn: string) => ({ result: [{ url: "http://a/x.js", functions: [{ functionName: fn, ranges: [{ startOffset: 1, endOffset: 9, count: 1 }] }] }] });

test("a target lost while its setup is still pending is lost, not complete", async () => {
  // Precise coverage never starts: the reply never comes.
  const cdp = new FakeCdp({ "Profiler.startPreciseCoverage": () => new Promise(() => {}) });
  const coverage = new CdpCoverage(cdp, { browser: "chromium" });
  await coverage.begin();
  cdp.attach("s1", "ctx-a");
  await tick();
  cdp.emit("Target.detachedFromTarget", { sessionId: "s1" });
  const result = await coverage.finish();
  assert.equal(result.lost, 1);
});

test("a live target whose setup never finished has no final take: lost too", async () => {
  const cdp = new FakeCdp({ "Profiler.startPreciseCoverage": () => new Promise(() => {}) });
  const coverage = new CdpCoverage(cdp, { browser: "chromium" });
  await coverage.begin();
  cdp.attach("s1", "ctx-a");
  await tick();
  assert.equal((await coverage.finish()).lost, 1);
});

test("one context's close is no final take for another context's targets", async () => {
  let ran = "first";
  const cdp = new FakeCdp({ "Profiler.takePreciseCoverage": () => coverageOf(ran) });
  const coverage = new CdpCoverage(cdp, { browser: "chromium" });
  await coverage.begin();
  cdp.attach("a1", "ctx-a");
  cdp.attach("b1", "ctx-b");
  await tick();
  // Context A closes first: B's page is taken too, but not finally.
  const first = await coverage.finish({ context: "ctx-a", last: false });
  assert.equal(first.lost, 0);
  // B's page runs more, then is lost before its own context's final take.
  ran = "later";
  cdp.emit("Target.detachedFromTarget", { sessionId: "b1" });
  const second = await coverage.finish({ context: "ctx-b", last: true });
  assert.equal(second.lost, 1, "B's page never had its final take");
});

test("each context's own final take makes its targets whole", async () => {
  const cdp = new FakeCdp({ "Profiler.takePreciseCoverage": () => coverageOf("f") });
  const coverage = new CdpCoverage(cdp, { browser: "chromium" });
  await coverage.begin();
  cdp.attach("a1", "ctx-a");
  cdp.attach("b1", "ctx-b");
  await tick();
  assert.equal((await coverage.finish({ context: "ctx-a", last: false })).lost, 0);
  cdp.emit("Target.detachedFromTarget", { sessionId: "a1" });
  assert.equal((await coverage.finish({ context: "ctx-b", last: true })).lost, 0);
});

test("a target with no context id is final only at the last context's close", async () => {
  const cdp = new FakeCdp({ "Profiler.takePreciseCoverage": () => coverageOf("f") });
  const coverage = new CdpCoverage(cdp, { browser: "chromium" });
  await coverage.begin();
  cdp.emit("Target.attachedToTarget", { sessionId: "w1", targetInfo: { targetId: "t-w1", type: "service_worker" }, waitingForDebugger: false });
  await tick();
  await coverage.finish({ context: "ctx-a", last: false });
  cdp.emit("Target.detachedFromTarget", { sessionId: "w1" });
  assert.equal((await coverage.finish({ context: "ctx-b", last: true })).lost, 1);
});

test("the final take reaches every target at once: one slow target costs its own wait, not one per target", async () => {
  const cdp = new FakeCdp({ "Profiler.takePreciseCoverage": () => new Promise((resolve) => setTimeout(() => resolve(coverageOf("f")), 150)) });
  const coverage = new CdpCoverage(cdp, { browser: "chromium" });
  await coverage.begin();
  for (let i = 0; i < 6; i++) cdp.attach(`s${i}`, "ctx-a");
  await tick();
  const started = Date.now();
  const result = await coverage.finish({ context: "ctx-a", last: true });
  assert.equal(result.lost, 0);
  assert.ok(Date.now() - started < 600, `took ${Date.now() - started} ms for 6 targets of 150 ms each`);
});

test("a shared context's page that ran and was lost counts against the attempt, though its context isn't closing", async () => {
  const cdp = new FakeCdp({ "Profiler.takePreciseCoverage": () => coverageOf("f") });
  const coverage = new CdpCoverage(cdp, { browser: "chromium" });
  await coverage.begin();
  cdp.attach("own", "ctx-test");
  cdp.attach("shared", "ctx-worker");
  await tick();
  // The worker-scoped context's page runs, then is gone before any take.
  cdp.emit("Target.detachedFromTarget", { sessionId: "shared" });
  const result = await coverage.finish({ context: "ctx-test", last: false });
  assert.equal(result.lost, 1);
});

test("a shared context's live page isn't lost: its context isn't done", async () => {
  const cdp = new FakeCdp({ "Profiler.takePreciseCoverage": () => coverageOf("f") });
  const coverage = new CdpCoverage(cdp, { browser: "chromium" });
  await coverage.begin();
  cdp.attach("own", "ctx-test");
  cdp.attach("shared", "ctx-worker");
  await tick();
  assert.equal((await coverage.finish({ context: "ctx-test", last: false })).lost, 0);
});

test("a CSS setup that fails while other setup is pending is an error at once, and the page is never final", async () => {
  const cdp = new FakeCdp({
    "CSS.startRuleUsageTracking": () => Promise.reject(new Error("CSS agent unavailable")),
    // Another setup reply that never comes: the old code waited for it before recording anything.
    "Page.enable": () => new Promise(() => {}),
    "Profiler.takePreciseCoverage": () => coverageOf("f"),
  });
  const coverage = new CdpCoverage(cdp, { browser: "chromium" });
  await coverage.begin();
  cdp.attach("p1", "ctx-a");
  await tick();
  const result = await coverage.finish({ context: "ctx-a", last: true });
  assert.ok(result.errors.some((e) => e.includes("CSS agent unavailable")), JSON.stringify(result.errors));
  assert.equal(result.lost, 1, "its CSS was never measured, so its final take isn't whole");
});

test("a connection that closes while idle kills the collector: this attempt and every later one is refused", async () => {
  const cdp = new FakeCdp({ "Profiler.takePreciseCoverage": () => coverageOf("f") });
  const coverage = new CdpCoverage(cdp, { browser: "chromium" });
  await coverage.attach();
  await coverage.begin();
  // No command pending: nothing else would notice.
  cdp.close();
  cdp.attach("p1", "ctx-a");
  const result = await coverage.finish({ context: "ctx-a", last: true });
  assert.equal(result.refused, "collector_disconnected");
  await coverage.begin();
  assert.equal((await coverage.finish()).refused, "collector_disconnected");
});

// Every completeness check runs over every target that contributed to the attempt; context
// decides only when a target is final. One test per check, on a page of a context that isn't closing.
const sharedPage = async (answers: Record<string, Handler>) => {
  const cdp = new FakeCdp({ "Profiler.takePreciseCoverage": () => coverageOf("f"), ...answers });
  const coverage = new CdpCoverage(cdp, { browser: "chromium" });
  await coverage.begin();
  cdp.attach("own", "ctx-test");
  cdp.attach("shared", "ctx-worker");
  await tick();
  return coverage.finish({ context: "ctx-test", last: false });
};
const pendingFor = (session: string) => (_: Record<string, unknown>, sessionId?: string) => (sessionId === session ? new Promise(() => {}) : {});

test("check: setup — a shared page whose JS setup never finished isn't wholly seen", async () => {
  assert.equal((await sharedPage({ "Profiler.startPreciseCoverage": pendingFor("shared") })).lost, 1);
});

test("check: setup — a shared page whose CSS setup never finished isn't wholly seen", async () => {
  assert.equal((await sharedPage({ "CSS.startRuleUsageTracking": pendingFor("shared") })).lost, 1);
});

test("check: take — a shared page whose take failed isn't wholly seen", async () => {
  const failing = (_: Record<string, unknown>, sessionId?: string) => (sessionId === "shared" ? Promise.reject(new Error("take failed")) : coverageOf("f"));
  assert.equal((await sharedPage({ "Profiler.takePreciseCoverage": failing })).lost, 1);
});

test("check: control — a shared page set up and taken in full is whole, though not final", async () => {
  assert.equal((await sharedPage({})).lost, 0);
});

// Lateness is proven or not, never read from coverage data. A target that attached held
// (waiting for the debugger) is proven once its starts succeed: Chrome holds it for us. One
// that attached already running is a document proven only by a navigation history of just
// the initial about:blank; anything else, or no answer, is late.
const history = (...urls: string[]) => () => ({ currentIndex: urls.length - 1, entries: urls.map((url, id) => ({ id, url })) });
const startedOn = async (navigation: Handler, type = "page", extra: Record<string, Handler> = {}) => {
  const cdp = new FakeCdp({ "Page.getNavigationHistory": navigation, "Profiler.takePreciseCoverage": () => ({ result: [] }), ...extra });
  const coverage = new CdpCoverage(cdp, { browser: "chromium" });
  await coverage.begin();
  cdp.attach("p1", "ctx-a", type);
  await tick();
  await coverage.settled();
  return coverage.finish({ context: "ctx-a", last: true });
};

test("running-attached: never proven, whatever its history says (lead r7)", async () => {
  assert.equal((await startedOn(history("about:blank"))).late, 1);
  assert.equal((await startedOn(history(""))).late, 1);
  assert.equal((await startedOn(history("http://app/login"))).late, 1);
  assert.equal((await startedOn(() => Promise.reject(new Error("no Page domain")))).late, 1);
});

test("running-attached: a worker is late", async () => {
  assert.equal((await startedOn(history("about:blank"), "worker")).late, 1);
});

test("carried into a later attempt with its starts done: not late there", async () => {
  const cdp = new FakeCdp({ "Page.getNavigationHistory": history("http://app/login"), "Profiler.takePreciseCoverage": () => ({ result: [] }) });
  const coverage = new CdpCoverage(cdp, { browser: "chromium" });
  await coverage.begin();
  cdp.attach("p1", "ctx-a");
  await tick();
  await coverage.settled();
  assert.equal((await coverage.finish({ context: "ctx-a", last: true })).late, 1);
  await coverage.begin();
  assert.equal((await coverage.finish({ context: "ctx-a", last: true })).late, 0);
});

test("carried into a later attempt with its start still pending: it must earn its own proof (opus r6)", async () => {
  let release!: () => void;
  const pending = new Promise<void>((resolve) => (release = resolve));
  const cdp = new FakeCdp({
    "Profiler.startPreciseCoverage": () => pending.then(() => ({})),
    // By the time its start lands, the page has navigated.
    "Page.getNavigationHistory": history("about:blank", "http://app/login"),
    "Profiler.takePreciseCoverage": () => ({ result: [] }),
  });
  const coverage = new CdpCoverage(cdp, { browser: "chromium" });
  await coverage.begin();
  cdp.attach("p1", "ctx-a");
  await tick();
  // The next attempt begins while P's start is still pending.
  await coverage.begin();
  release();
  await coverage.settled();
  assert.equal((await coverage.finish({ context: "ctx-a", last: true })).late, 1);
});

const attachWaiting = (cdp: FakeCdp, sessionId: string, type: string) =>
  cdp.emit("Target.attachedToTarget", { sessionId, targetInfo: { targetId: `t-${sessionId}`, type, browserContextId: "ctx-a" }, waitingForDebugger: true });
const held = async (type: string, answers: Record<string, Handler> = {}) => {
  const cdp = new FakeCdp({ "Profiler.takePreciseCoverage": () => ({ result: [] }), ...answers });
  const coverage = new CdpCoverage(cdp, { browser: "chromium" });
  await coverage.begin();
  attachWaiting(cdp, "h1", type);
  await tick();
  await coverage.settled();
  return coverage.finish({ context: "ctx-a", last: true });
};

test("held: a worker attached waiting, resumed by us after our start, is proven", async () => {
  assert.equal((await held("worker")).late, 0);
  assert.equal((await held("service_worker")).late, 0);
});

test("held: a page attached waiting is proven only once its CSS started too", async () => {
  assert.equal((await held("page")).late, 0);
  assert.equal((await held("page", { "CSS.startRuleUsageTracking": () => Promise.reject(new Error("no CSS")) })).late, 1);
});

test("held: the proof is the attach flag and our starts, not the resume reply", async () => {
  // A failed resume leaves the target held, so nothing ran before our start: still proven.
  assert.equal((await held("worker", { "Runtime.runIfWaitingForDebugger": () => Promise.reject(new Error("gone")) })).late, 0);
  // A start that failed proves nothing.
  assert.equal((await held("worker", { "Profiler.startPreciseCoverage": () => Promise.reject(new Error("no")) })).late, 1);
});

test("the baseline stays a late signal: an app script that ran before our start is late, held or not", async () => {
  const ran = { result: [{ url: "http://app/a.js", functions: [{ functionName: "", ranges: [{ startOffset: 0, endOffset: 9, count: 0 }] }] }] };
  let first = true;
  assert.equal((await held("worker", { "Profiler.takePreciseCoverage": () => (first ? ((first = false), ran) : { result: [] }) })).late, 1);
});

const popup = async (targetInfo: Record<string, unknown>) => {
  const cdp = new FakeCdp({ "Profiler.takePreciseCoverage": () => ({ result: [] }), "Runtime.getIsolateId": (_, sessionId) => ({ id: `iso-${sessionId}` }) });
  const coverage = new CdpCoverage(cdp, { browser: "chromium" });
  await coverage.begin();
  cdp.emit("Target.attachedToTarget", { sessionId: "p2", targetInfo: { targetId: "t-p2", type: "page", browserContextId: "ctx-a", ...targetInfo }, waitingForDebugger: true });
  await tick();
  await coverage.settled();
  return coverage.finish({ context: "ctx-a", last: true });
};

test("a popup that can reach its opener may share its isolate, whose counts its start resets: partial", async () => {
  assert.equal((await popup({ openerId: "t-p1", canAccessOpener: true })).sharedIsolate, 1);
  // Unknown is shared: fail closed.
  assert.equal((await popup({ openerId: "t-p1" })).sharedIsolate, 1);
});

test("a noopener popup, or a page with no opener, shares nothing", async () => {
  assert.equal((await popup({ openerId: "t-p1", canAccessOpener: false })).sharedIsolate, 0);
  assert.equal((await popup({})).sharedIsolate, 0);
});

// Two targets in one V8 isolate share its coverage counts: one's start or take resets what the
// other ran. Any target that shared an isolate with another, or whose isolate can't be read, is partial.
const isolates = async (ids: Record<string, string | Error>) => {
  const cdp = new FakeCdp({
    "Profiler.takePreciseCoverage": () => ({ result: [] }),
    "Runtime.getIsolateId": (_, sessionId) => {
      const id = ids[sessionId!];
      return id instanceof Error ? Promise.reject(id) : { id };
    },
  });
  const coverage = new CdpCoverage(cdp, { browser: "chromium" });
  await coverage.begin();
  for (const sessionId of Object.keys(ids)) cdp.emit("Target.attachedToTarget", { sessionId, targetInfo: { targetId: `t-${sessionId}`, type: "page", browserContextId: "ctx-a" }, waitingForDebugger: true });
  await tick();
  await coverage.settled();
  return coverage.finish({ context: "ctx-a", last: true });
};

test("two unrelated pages in one isolate (the renderer limit): both partial", async () => {
  assert.equal((await isolates({ a: "iso-1", b: "iso-1" })).sharedIsolate, 2);
});

test("pages in their own isolates share nothing", async () => {
  assert.equal((await isolates({ a: "iso-1", b: "iso-2" })).sharedIsolate, 0);
});

test("an isolate that can't be read counts as shared: fail closed", async () => {
  assert.equal((await isolates({ a: "iso-1", b: new Error("no Runtime.getIsolateId") })).sharedIsolate, 1);
});

test("a page that moved into another's isolate, by a later navigation, shares it", async () => {
  const current: Record<string, string> = { a: "iso-1", b: "iso-2" };
  const cdp = new FakeCdp({ "Profiler.takePreciseCoverage": () => ({ result: [] }), "Runtime.getIsolateId": (_, sessionId) => ({ id: current[sessionId!] }) });
  const coverage = new CdpCoverage(cdp, { browser: "chromium" });
  await coverage.begin();
  for (const sessionId of ["a", "b"]) cdp.emit("Target.attachedToTarget", { sessionId, targetInfo: { targetId: `t-${sessionId}`, type: "page", browserContextId: "ctx-a" }, waitingForDebugger: true });
  await tick();
  await coverage.settled();
  // b swaps into a's process, and back out, before the final take.
  current.b = "iso-1";
  cdp.emit("Page.frameNavigated", { frame: { id: "fb", url: "http://app/x" } }, "b");
  await tick();
  await coverage.settled();
  current.b = "iso-3";
  assert.equal((await coverage.finish({ context: "ctx-a", last: true })).sharedIsolate, 2);
});
