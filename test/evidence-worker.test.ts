/**
 * The worker side of in-run coverage, in real Chromium through Playwright's own client
 * instrumentation (as its test runner saves traces): a context's coverage is taken before
 * it closes and written as one attempt's file. The full run is in targeted-action.test.ts.
 */
import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";

import { installCoverage, pickPort, type AttemptFile } from "../src/evidence/browser/worker";

// eslint-disable-next-line @typescript-eslint/no-require-imports
const core = require("playwright-core") as typeof import("playwright-core") & { _instrumentation: { addListener(listener: object): void; removeListener(listener: unknown): void } };

const PAGE = `<!doctype html><html><head><style>.used{color:red}.unused{color:blue}</style></head><body><div class="used">x</div><script>function ranOnLoad(){return 1} ranOnLoad();</script></body></html>`;
/** A page whose only code is an external script's startup function. */
const STARTUP_PAGE = `<!doctype html><html><body><script src="/startup.js"></script></body></html>`;
const STARTUP_JS = `function startup() { document.body.dataset.ready = "1"; } startup();`;

async function app(t: TestContext): Promise<string> {
  const server = createServer((req, res) => {
    if (req.url === "/startup") return void res.writeHead(200, { "Content-Type": "text/html" }).end(STARTUP_PAGE);
    if (req.url === "/startup.js") return void res.writeHead(200, { "Content-Type": "text/javascript" }).end(STARTUP_JS);
    if (req.url === "/plain") return void res.writeHead(200, { "Content-Type": "text/html" }).end("<!doctype html><html><body>plain</body></html>");
    res.writeHead(200, { "Content-Type": "text/html" }).end(PAGE);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}/`;
}

/** What a failed assertion should say: every file's attempt, refusal, losses, errors, navigations and scripts. */
function explain(written: AttemptFile[]): string {
  return JSON.stringify(
    written.map((f) => ({ testId: f.testId, retry: f.retry, contextId: f.contextId, browser: f.browser, refused: f.coverage.refused, lost: f.coverage.lost, errors: f.coverage.errors, late: f.coverage.late, lostDetail: f.coverage.lostDetail, navigations: f.coverage.navigations, scripts: f.coverage.scripts.map((s) => `${s.url}: ${s.functions.map((fn) => fn.name).join(",")}`) })),
    null,
    1,
  );
}

const STARTS = new Set(["Profiler.startPreciseCoverage", "CSS.startRuleUsageTracking"]);

/**
 * A connection whose profiler start lands late, the way Playwright's own resume can beat it:
 * the start is held for `delayMs`, and every later command on that session queues behind it,
 * so the session's commands still reach the browser in the order they were sent.
 */
async function lateStart(port: number, delayMs: number, onSend?: (method: string, answer: unknown, sessionId?: string) => void, replyDelayMs = 0) {
  const { connectCdp } = await import("../src/evidence/browser/cdp-socket");
  const real = await connectCdp(port);
  const queues = new Map<string, Promise<unknown>>();
  return {
    ...real,
    send(method: string, params?: object, sessionId?: string) {
      const key = sessionId ?? "";
      const before = queues.get(key) ?? Promise.resolve();
      const dispatched = before.then(() => (method === "Profiler.startPreciseCoverage" ? new Promise((resolve) => setTimeout(resolve, delayMs)) : undefined));
      queues.set(key, dispatched.catch(() => {}));
      return dispatched.then(() => real.send(method, params, sessionId)).then(async (answer) => {
        // Our starts' replies trailing the page's own connection, which reports it loaded first.
        if (replyDelayMs > 0 && STARTS.has(method)) await new Promise((resolve) => setTimeout(resolve, replyDelayMs));
        onSend?.(method, answer, sessionId);
        return answer;
      });
    },
  };
}

/** The worker's test hook: wait until its collector has started every open page's coverage. */
interface Settles {
  settled(): Promise<void>;
}

async function files(dir: string): Promise<AttemptFile[]> {
  return Promise.all((await readdir(dir)).filter((name) => name.startsWith("cov-")).sort().map(async (name) => JSON.parse(await readFile(path.join(dir, name), "utf8")) as AttemptFile));
}

test("a test's context: coverage taken before it closes, one file for its attempt", async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), "peeps-worker-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const url = await app(t);
  const port = pickPort()!;
  assert.ok(port > 0);
  let current = { testId: "abc-123", retry: 1 };
  const listener = installCoverage({ dir, core, test: { info: () => current }, port });
  t.after(() => core._instrumentation.removeListener(listener));
  const browser = await core.chromium.launch({ args: [`--remote-debugging-port=${port}`] });
  t.after(() => browser.close());

  const context = await browser.newContext();
  const page = await context.newPage();
  // Playwright resumes a new page without waiting for this collector: let its coverage start first.
  await (listener as unknown as Settles).settled();
  await page.goto(url);
  await context.close();
  current = { testId: "def-456", retry: 0 };
  const second = await browser.newContext();
  const secondPage = await second.newPage();
  await (listener as unknown as Settles).settled();
  await secondPage.goto(url);
  await second.close();

  const written = await files(dir);
  assert.deepEqual(written.map((f) => [f.testId, f.retry, f.browser.name]).sort(), [["abc-123", 1, "chromium"], ["def-456", 0, "chromium"]].sort(), explain(written));
  for (const file of written) {
    assert.match(file.browser.version, /^\d+\./);
    assert.deepEqual([file.coverage.refused, file.coverage.errors, file.coverage.lost], [undefined, [], 0], explain(written));
    assert.ok(file.coverage.scripts.some((s) => s.functions.some((fn) => fn.name === "ranOnLoad")), explain(written));
  }
  // The second attempt holds only its own run, never the first's.
  assert.equal(written[1]!.coverage.scripts.filter((s) => s.functions.some((fn) => fn.name === "ranOnLoad")).length, 1, explain(written));
});

test("a debugging port that isn't this browser's is refused, never read", async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), "peeps-worker-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const url = await app(t);
  const port = pickPort()!;
  // Another job's browser on the port this worker was given.
  const stranger = await core.chromium.launch({ args: [`--remote-debugging-port=${port}`] });
  t.after(() => stranger.close());
  const listener = installCoverage({ dir, core, test: { info: () => ({ testId: "t", retry: 0 }) }, port });
  t.after(() => core._instrumentation.removeListener(listener));
  const browser = await core.chromium.launch();
  t.after(() => browser.close());
  const context = await browser.newContext();
  await (await context.newPage()).goto(url);
  await context.close();
  const [file] = await files(dir);
  assert.equal(file!.coverage.refused, "not_this_browser", explain(await files(dir)));
  assert.deepEqual(file!.coverage.scripts, []);
});

test("outside a test nothing is written; a browser without coverage writes its name, read partial", async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), "peeps-worker-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  let inTest = false;
  const listener = installCoverage({
    dir,
    core,
    test: { info: () => { if (!inTest) throw new Error("test.info() can only be called while test is running"); return { testId: "w", retry: 0 }; } },
    port: pickPort()!,
  });
  t.after(() => core._instrumentation.removeListener(listener));
  const browser = await core.chromium.launch();
  t.after(() => browser.close());
  await (await browser.newContext()).close();
  assert.deepEqual(await files(dir), []);
  inTest = true;
  // No debugging port on this browser at all: refused, so the attempt reads partial.
  await (await browser.newContext()).close();
  const [file] = await files(dir);
  assert.equal(file!.coverage.browser, "chromium");
  assert.notEqual(file!.coverage.refused, undefined);
});

test("two contexts in one test are one attempt: both read, neither refused", async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), "peeps-worker-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const url = await app(t);
  const port = pickPort()!;
  const listener = installCoverage({ dir, core, test: { info: () => ({ testId: "both", retry: 0 }) }, port });
  t.after(() => core._instrumentation.removeListener(listener));
  const browser = await core.chromium.launch({ args: [`--remote-debugging-port=${port}`] });
  t.after(() => browser.close());
  const first = await browser.newContext();
  const second = await browser.newContext();
  const firstPage = await first.newPage();
  const secondPage = await second.newPage();
  await (listener as unknown as Settles).settled();
  await firstPage.goto(url);
  await secondPage.goto(url);
  await second.close();
  await first.close();
  const written = await files(dir);
  assert.equal(written.length, 2, explain(written));
  for (const file of written) {
    assert.equal(file.coverage.refused, undefined, explain(written));
    assert.deepEqual([file.coverage.lost, file.coverage.errors], [0, []], explain(written));
    assert.ok(file.coverage.scripts.some((s) => s.functions.some((fn) => fn.name === "ranOnLoad")));
  }
});

test("a collector that fails never fails the test: the context opens, and its attempt reads refused", async (t) => {
  const { connectCdp } = await import("../src/evidence/browser/cdp-socket");
  const dir = await mkdtemp(path.join(tmpdir(), "peeps-worker-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const url = await app(t);
  const port = pickPort()!;
  // The right browser, whose debugging connection then fails as coverage attaches.
  const connect = async (p: number) => {
    const real = await connectCdp(p);
    return { ...real, send: (method: string, params?: object, sessionId?: string) => (method === "Target.setAutoAttach" ? Promise.reject(new Error("socket closed")) : real.send(method, params, sessionId)) };
  };
  const listener = installCoverage({ dir, core, test: { info: () => ({ testId: "t", retry: 0 }) }, port, connect });
  t.after(() => core._instrumentation.removeListener(listener));
  const browser = await core.chromium.launch({ args: [`--remote-debugging-port=${port}`] });
  t.after(() => browser.close());
  const context = await browser.newContext();
  await (await context.newPage()).goto(url);
  await context.close();
  const cov = (await files(dir)).filter((f) => "coverage" in f);
  assert.equal(cov.length, 1);
  assert.equal(cov[0]!.coverage.refused, "collector_failed", explain(cov));
});

test("every context a test opens is announced, and one closed after the test leaves its marker unmatched", async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), "peeps-worker-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const url = await app(t);
  const port = pickPort()!;
  let inTest = true;
  const listener = installCoverage({ dir, core, test: { info: () => { if (!inTest) throw new Error("not in a test"); return { testId: "t", retry: 0 }; } }, port });
  t.after(() => core._instrumentation.removeListener(listener));
  const browser = await core.chromium.launch({ args: [`--remote-debugging-port=${port}`] });
  t.after(() => browser.close());
  const first = await browser.newContext();
  const second = await browser.newContext();
  await (await first.newPage()).goto(url);
  await first.close();
  inTest = false;
  await second.close();
  const names = await readdir(dir);
  const markers = names.filter((n) => n.startsWith("ctx-"));
  const covered = (await files(dir)).filter((f) => "coverage" in f);
  assert.equal(markers.length, 2);
  assert.equal(covered.length, 1, explain(covered));
  const marked = await Promise.all(markers.map(async (n) => (JSON.parse(await readFile(path.join(dir, n), "utf8")) as { contextId: string }).contextId));
  assert.ok(marked.includes(covered[0]!.contextId));
});

test("a context closed outside any test (a worker fixture, afterAll) never leaves later attempts partial", async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), "peeps-worker-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const url = await app(t);
  const port = pickPort()!;
  let current: { testId: string; retry: number } | null = null;
  const listener = installCoverage({ dir, core, test: { info: () => { if (!current) throw new Error("not in a test"); return current; } }, port });
  t.after(() => core._instrumentation.removeListener(listener));
  const browser = await core.chromium.launch({ args: [`--remote-debugging-port=${port}`] });
  t.after(() => browser.close());
  // A worker-scoped context, opened and closed outside any test.
  const shared = await browser.newContext();
  await (await shared.newPage()).goto(url);
  await shared.close();
  current = { testId: "later", retry: 0 };
  const own = await browser.newContext();
  const ownPage = await own.newPage();
  await (listener as unknown as Settles).settled();
  await ownPage.goto(url);
  await own.close();
  const [file] = await files(dir);
  assert.equal(file!.testId, "later", explain(await files(dir)));
  assert.deepEqual([file!.coverage.refused, file!.coverage.lost, file!.coverage.errors], [undefined, 0, []], explain(await files(dir)));
  assert.ok(file!.coverage.scripts.some((s) => s.functions.some((fn) => fn.name === "ranOnLoad")), "a fresh attempt began");
});

test("a context whose marker can't be written taints its attempt: the record is refused, never whole", async (t) => {
  const { chmod } = await import("node:fs/promises");
  const dir = await mkdtemp(path.join(tmpdir(), "peeps-worker-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const url = await app(t);
  const port = pickPort()!;
  const listener = installCoverage({ dir, core, test: { info: () => ({ testId: "t", retry: 0 }) }, port });
  t.after(() => core._instrumentation.removeListener(listener));
  const browser = await core.chromium.launch({ args: [`--remote-debugging-port=${port}`] });
  t.after(() => browser.close());
  await chmod(dir, 0o500);
  let context;
  try {
    context = await browser.newContext();
  } finally {
    await chmod(dir, 0o700);
  }
  await (await context.newPage()).goto(url);
  await context.close();
  const written = await files(dir);
  assert.deepEqual(written.map((f) => f.coverage.refused), ["marker_failed"], explain(written));
});

test("a marker that fails after the attempt's other record landed still taints it, through a taint file", async (t) => {
  const { chmod } = await import("node:fs/promises");
  const dir = await mkdtemp(path.join(tmpdir(), "peeps-worker-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const url = await app(t);
  const port = pickPort()!;
  let inTest = true;
  const listener = installCoverage({ dir, core, test: { info: () => { if (!inTest) throw new Error("not in a test"); return { testId: "t", retry: 0 }; } }, port }) as { flushTaints(): void };
  t.after(() => core._instrumentation.removeListener(listener));
  const browser = await core.chromium.launch({ args: [`--remote-debugging-port=${port}`] });
  t.after(() => browser.close());
  // A: opens and closes normally, its record written.
  const a = await browser.newContext();
  await (await a.newPage()).goto(url);
  await a.close();
  // B: its marker fails, and it closes outside the test, so it writes nothing.
  await chmod(dir, 0o500);
  let b;
  try {
    b = await browser.newContext();
  } finally {
    await chmod(dir, 0o700);
  }
  inTest = false;
  await b.close();
  // At the worker's exit, what it owes is written down.
  listener.flushTaints();
  const taints = (await readdir(dir)).filter((n) => n.startsWith("taint-"));
  assert.equal(taints.length, 1);
  assert.deepEqual(JSON.parse(await readFile(path.join(dir, taints[0]!), "utf8")), { testId: "t", retry: 0 });
});

test("a begin that times out leaves the context out of the open set, so the worker's next attempt starts clean", async (t) => {
  const { connectCdp } = await import("../src/evidence/browser/cdp-socket");
  const dir = await mkdtemp(path.join(tmpdir(), "peeps-worker-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const url = await app(t);
  const port = pickPort()!;
  // A target still alive when the next context opens (a closed context's service worker,
  // say), whose take never answers: begin waits on it.
  const handlers: Array<(method: string, params: unknown, sessionId?: string) => void> = [];
  const connect = async (p: number) => {
    const real = await connectCdp(p);
    return {
      ...real,
      onEvent(handler: (method: string, params: unknown, sessionId?: string) => void) {
        handlers.push(handler);
        real.onEvent(handler);
      },
      send: (method: string, params?: object, sessionId?: string) => {
        if (sessionId !== "ghost") return real.send(method, params, sessionId);
        return method === "Profiler.takePreciseCoverage" ? new Promise<never>(() => {}) : Promise.resolve({});
      },
    };
  };
  const listener = installCoverage({ dir, core, test: { info: () => ({ testId: "t", retry: 0 }) }, port, connect, hookMs: 300 }) as { openContexts(): Promise<number> };
  t.after(() => core._instrumentation.removeListener(listener));
  const browser = await core.chromium.launch({ args: [`--remote-debugging-port=${port}`] });
  t.after(() => browser.close());
  const first = await browser.newContext();
  await (await first.newPage()).goto(url);
  await first.close();
  for (const handler of handlers) handler("Target.attachedToTarget", { sessionId: "ghost", targetInfo: { targetId: "ghost", type: "service_worker" }, waitingForDebugger: false });
  await new Promise((resolve) => setTimeout(resolve, 50));
  const timedOut = await browser.newContext();
  assert.equal(await listener.openContexts(), 0, "the context whose begin timed out isn't held open");
  await timedOut.close();
});

test("a page that navigates at once with our start delayed is still whole: Chrome holds it for our resume (no settled())", async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), "peeps-worker-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const url = await app(t);
  const port = pickPort()!;
  const listener = installCoverage({ dir, core, test: { info: () => ({ testId: "held", retry: 0 }) }, port, connect: (p) => lateStart(p, 400) });
  t.after(() => core._instrumentation.removeListener(listener));
  const browser = await core.chromium.launch({ args: [`--remote-debugging-port=${port}`] });
  t.after(() => browser.close());
  const context = await browser.newContext();
  const page = await context.newPage();
  await page.goto(url);
  await context.close();
  const [file] = await files(dir);
  assert.ok(file, "a record was written");
  assert.deepEqual([file!.coverage.late, file!.coverage.lost, file!.coverage.errors], [0, 0, []], explain([file!]));
  assert.ok(file!.coverage.scripts.some((s) => s.functions.some((fn) => fn.name === "ranOnLoad")), explain([file!]));
});

for (const [replyDelayMs, whole] of [
  [50, true],
  [1_000, false],
] as const) {
  test(`a close right after goto, our starts' replies ${replyDelayMs} ms behind the page: ${whole ? "waited for, whole" : "past the bound, still lost"} (no settled())`, async (t) => {
    const { partialReasons } = await import("../src/evidence/browser/rules");
    const dir = await mkdtemp(path.join(tmpdir(), "peeps-worker-"));
    t.after(() => rm(dir, { recursive: true, force: true }));
    const url = await app(t);
    const port = pickPort()!;
    const listener = installCoverage({ dir, core, test: { info: () => ({ testId: "trailing", retry: 0 }) }, port, connect: (p) => lateStart(p, 0, undefined, replyDelayMs) });
    t.after(() => core._instrumentation.removeListener(listener));
    const browser = await core.chromium.launch({ args: [`--remote-debugging-port=${port}`] });
    t.after(() => browser.close());
    const context = await browser.newContext();
    const page = await context.newPage();
    await page.goto(url);
    await context.close();
    const [file] = await files(dir);
    assert.ok(file, "a record was written");
    if (whole) {
      assert.deepEqual(partialReasons(file!.coverage), [], explain([file!]));
      assert.ok(file!.coverage.scripts.some((s) => s.functions.some((fn) => fn.name === "ranOnLoad")), explain([file!]));
    } else {
      // Never a false whole: a start not answered within the bound leaves the page lost.
      assert.ok(partialReasons(file!.coverage).includes("target_lost"), explain([file!]));
    }
  });
}

for (const delayMs of [0, 400]) {
  test(`a page that navigates at once is whole, its startup seen, whatever our start's delay (${delayMs} ms; no settled())`, async (t) => {
    const { connectCdp } = await import("../src/evidence/browser/cdp-socket");
    const { partialReasons } = await import("../src/evidence/browser/rules");
    const dir = await mkdtemp(path.join(tmpdir(), "peeps-worker-"));
    t.after(() => rm(dir, { recursive: true, force: true }));
    const url = await app(t);
    const port = pickPort()!;
    void connectCdp;
    const connect = (p: number) => lateStart(p, delayMs);
    const listener = installCoverage({ dir, core, test: { info: () => ({ testId: "race", retry: 0 }) }, port, connect });
    t.after(() => core._instrumentation.removeListener(listener));
    const browser = await core.chromium.launch({ args: [`--remote-debugging-port=${port}`] });
    t.after(() => browser.close());
    const context = await browser.newContext();
    const page = await context.newPage();
    // At once, as a customer's test does: no settled().
    await page.goto(`${url}startup`);
    await page.waitForFunction(() => document.body.dataset.ready === "1");
    // Closed at once: the close itself waits for our starts' replies still on their way.
    await context.close();
    const [file] = await files(dir);
    assert.ok(file, "a record was written");
    const ran = file!.coverage.scripts.some((s) => s.functions.some((fn) => fn.name === "startup"));
    // Whole means its startup was seen; anything not proven to have started first reads partial.
    if (!ran) assert.ok(partialReasons(file!.coverage).includes("started_late"), `startup unseen, yet: ${explain([file!])}`);
    // Held for our resume, whatever our delay: its startup ran after our start, and was seen.
    assert.equal(ran, true, explain([file!]));
    assert.deepEqual(partialReasons(file!.coverage), [], explain([file!]));
  });
}



test("a same-site popup that keeps its opener (same isolate, no takeAll): the opener's earlier code is kept, or the attempt reads partial", async (t) => {
  const { partialReasons } = await import("../src/evidence/browser/rules");
  const dir = await mkdtemp(path.join(tmpdir(), "peeps-worker-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const url = await app(t);
  const port = pickPort()!;
  const listener = installCoverage({ dir, core, test: { info: () => ({ testId: "popup", retry: 0 }) }, port });
  t.after(() => core._instrumentation.removeListener(listener));
  const browser = await core.chromium.launch({ args: [`--remote-debugging-port=${port}`] });
  t.after(() => browser.close());
  const context = await browser.newContext();
  const page = await context.newPage();
  // As production runs: no settled(), no delta before the click.
  await page.goto(url);
  const [popup] = await Promise.all([page.waitForEvent("popup"), page.evaluate(() => void window.open("/startup"))]);
  await popup.waitForFunction(() => document.body.dataset.ready === "1");
  assert.equal(await popup.evaluate(() => window.opener !== null), true, "the popup kept its opener");
  await context.close();
  const [file] = await files(dir);
  assert.ok(file, "a record was written");
  const ran = (name: string) => file!.coverage.scripts.some((s) => s.functions.some((fn) => fn.name === name));
  const partial = partialReasons(file!.coverage).length > 0;
  assert.ok(ran("ranOnLoad") || partial, `the opener's code went missing while the attempt reads whole: ${explain([file!])}`);
  assert.ok(ran("startup") || partial, `the popup's code went missing while the attempt reads whole: ${explain([file!])}`);
});

for (const layout of ["one context", "two contexts"] as const) {
  test(`at the renderer limit, two unrelated same-site pages (${layout}) share a process: the first page's code is kept, or the attempt reads partial`, async (t) => {
    const { partialReasons } = await import("../src/evidence/browser/rules");
    const dir = await mkdtemp(path.join(tmpdir(), "peeps-worker-"));
    t.after(() => rm(dir, { recursive: true, force: true }));
    const url = await app(t);
    const port = pickPort()!;
    const listener = installCoverage({ dir, core, test: { info: () => ({ testId: "shared", retry: 0 }) }, port });
    t.after(() => core._instrumentation.removeListener(listener));
    // One renderer process for everything: unrelated pages share it, and its V8 isolate.
    const browser = await core.chromium.launch({ args: [`--remote-debugging-port=${port}`, "--renderer-process-limit=1"] });
    t.after(() => browser.close());
    const first = await browser.newContext();
    const a = await first.newPage();
    // As production runs: no settled(), no delta between the pages.
    await a.goto(url);
    const second = layout === "one context" ? first : await browser.newContext();
    const b = await second.newPage();
    await b.goto(`${url}startup`);
    await b.waitForFunction(() => document.body.dataset.ready === "1");
    if (second !== first) await second.close();
    await first.close();
    const written = await files(dir);
    assert.ok(written.length > 0, "a record was written");
    for (const file of written) {
      const ran = (name: string) => file.coverage.scripts.some((s) => s.functions.some((fn) => fn.name === name));
      const partial = partialReasons(file.coverage).length > 0;
      assert.ok(ran("ranOnLoad") || partial, `page A's code went missing while the attempt reads whole: ${explain(written)}`);
      // When it went missing, it is because the pages shared an isolate, and that is what reads partial.
      if (!ran("ranOnLoad")) assert.ok(partialReasons(file.coverage).includes("shared_isolate"), explain(written));
    }
  });
}
