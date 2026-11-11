/**
 * Raw-CDP coverage in real Chromium. Spike 3's 15 tests, graded as it graded them:
 * complete when every expected function ran and every expected rule was used, and a
 * partial test is never read whole. Its "delta per action" row is 12/15 complete, 3/3
 * partial flagged, 0 missed. Then a built chunk's functions mapped onto its fingerprint.
 */
import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import net from "node:net";
import path from "node:path";
import { chromium, type Browser, type Page } from "@playwright/test";

import { CdpCoverage } from "../src/evidence/browser/cdp-coverage";
import { connectCdp, type CdpSocket } from "../src/evidence/browser/cdp-socket";
import { browserFootprint, partialReasons, type AttemptCoverage } from "../src/evidence/browser/rules";
import { fingerprintBuild } from "../src/evidence/fingerprint/rules";
import { BASE, nextBuild } from "./support/next-build";

const FIXTURE = path.join(__dirname, "fixtures/browser-coverage");
const TYPES: Record<string, string> = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".map": "application/json" };

function serve(files: (pathname: string) => Promise<string | null>): Promise<Server> {
  const server = createServer(async (request, response) => {
    const pathname = new URL(request.url ?? "/", "http://x").pathname;
    const body = await files(pathname).catch(() => null);
    if (body === null) {
      response.writeHead(404).end();
      return;
    }
    response.writeHead(200, { "Content-Type": TYPES[path.extname(pathname) || ".html"] ?? "text/plain", "Cache-Control": "no-store" }).end(body);
  });
  // Every interface, so both `127.0.0.1` and `localhost` reach it: two sites, one server.
  return new Promise((resolve) => server.listen(0, () => resolve(server)));
}

async function freePort(): Promise<number> {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as net.AddressInfo;
      server.close(() => resolve(port));
    });
  });
}

async function launch(t: TestContext, channel?: string): Promise<{ browser: Browser; cdp: CdpSocket }> {
  const port = await freePort();
  const browser = await chromium.launch({ headless: true, args: [`--remote-debugging-port=${port}`], ...(channel ? { channel } : {}) });
  const cdp = await connectCdp(port);
  t.after(async () => {
    cdp.close();
    await browser.close();
  });
  return { browser, cdp };
}

interface SpikeTest {
  name: string;
  js: string[];
  css: string[];
  run: (page: Page) => Promise<unknown>;
}

const BASE_JS = ["inlineFn", "appInitFn"];
const BASE_CSS = [".used-rule"];
const NEVER = ["neverCalledFn", ".unused-rule"];

const clickDone = async (page: Page, selector: string) => {
  await page.click(selector);
  return page.evaluate(() => (window as unknown as { __done: unknown }).__done);
};
const popupVia = async (page: Page, selector: string, title: string) => {
  const [popup] = await Promise.all([page.context().waitForEvent("page"), page.click(selector)]);
  await popup.waitForLoadState("load");
  await popup.waitForFunction((t) => document.title === t, title);
};

const TESTS: SpikeTest[] = [
  { name: "control", js: [], css: [], run: async () => {} },
  {
    name: "nav-same", js: ["page2Fn"], css: [".page2-used"],
    run: async (page) => {
      await Promise.all([page.waitForURL("**/page2.html"), page.click("#to-page2")]);
      await page.waitForFunction(() => document.title === "page2 ran");
    },
  },
  {
    name: "nav-xsite", js: ["page2Fn"], css: [".page2-used"],
    run: async (page) => {
      await Promise.all([page.waitForURL("http://localhost:*/page2.html"), page.click("#to-page2-xsite")]);
      await page.waitForFunction(() => document.title === "page2 ran");
    },
  },
  {
    name: "nav-js", js: ["navSoonFn", "navTimerFn", "page2Fn"], css: [".clicked-rule", ".page2-used"],
    run: async (page) => {
      await Promise.all([page.waitForURL("**/page2.html"), page.click("#nav-js")]);
      await page.waitForFunction(() => document.title === "page2 ran");
    },
  },
  { name: "route", js: ["routeFn", "routeChunkFn"], css: [], run: (page) => clickDone(page, "#route") },
  { name: "popup", js: ["popupFn"], css: [".popup-used"], run: (page) => popupVia(page, "#popup", "popup ran") },
  { name: "popup-xsite", js: ["popupFn"], css: [".popup-used"], run: (page) => popupVia(page, "#popup-xsite", "popup ran") },
  {
    name: "popup-close", js: ["popupCloseFn"], css: [],
    run: async (page) => {
      const [popup] = await Promise.all([page.context().waitForEvent("page"), page.click("#popup-close")]);
      await popup.waitForEvent("close");
    },
  },
  { name: "iframe", js: ["frameFn"], css: [".frame-used"], run: (page) => clickDone(page, "#iframe") },
  { name: "iframe-xsite", js: ["frameXFn"], css: [".framex-used"], run: (page) => clickDone(page, "#iframe-xsite") },
  { name: "worker", js: ["workerFn"], css: [], run: (page) => clickDone(page, "#worker") },
  { name: "worker-term", js: ["workerTermFn"], css: [], run: (page) => clickDone(page, "#worker-term") },
  { name: "service-worker", js: ["swFn"], css: [], run: (page) => clickDone(page, "#sw") },
  { name: "delayed", js: ["delayedFn"], css: [], run: (page) => clickDone(page, "#delayed") },
  { name: "css-injected", js: [], css: [".inj-nosrc-used", ".inj-src-used"], run: (page) => clickDone(page, "#inject") },
];

function covered(coverage: AttemptCoverage): { functions: Set<string>; selectors: Set<string> } {
  const functions = new Set(coverage.scripts.flatMap((script) => script.functions.map((fn) => fn.name)));
  const selectors = new Set<string>();
  for (const sheet of coverage.sheets as Array<AttemptCoverage["sheets"][number] & { text?: string }>) {
    for (const used of sheet.used) for (const match of (sheet.text ?? "").slice(used.start, used.end).match(/\.[a-zA-Z][\w-]*/g) ?? []) selectors.add(match);
  }
  return { functions, selectors };
}

test("spike 3's fixture, with a delta before each action: its verdicts, every partial one flagged, none missed", async (t) => {
  const server = await serve((pathname) => readFile(path.join(FIXTURE, pathname === "/" ? "index.html" : path.normalize(pathname)), "utf8"));
  t.after(() => server.close());
  const base = `http://127.0.0.1:${(server.address() as net.AddressInfo).port}`;
  const { browser, cdp } = await launch(t);
  const collector = new CdpCoverage(cdp, { browser: "chromium", sheetText: true });
  await collector.attach();

  const rows: Array<{ name: string; complete: boolean; flagged: boolean; reasons: string[] }> = [];
  for (const spike of TESTS) {
    const context = await browser.newContext();
    try {
      const page = await context.newPage();
      await collector.begin();
      // An adapter that wraps each test action takes a delta first.
      const click = page.click.bind(page);
      page.click = async (...args: Parameters<Page["click"]>) => {
        await collector.takeAll();
        return click(...args);
      };
      await page.goto(`${base}/index.html`);
      await spike.run(page);
      const coverage = await collector.finish();
      const { functions, selectors } = covered(coverage);
      const missing = [...BASE_JS, ...spike.js].filter((fn) => !functions.has(fn)).concat([...BASE_CSS, ...spike.css].filter((s) => !selectors.has(s)));
      assert.deepEqual(NEVER.filter((name) => functions.has(name) || selectors.has(name)), [], `${spike.name}: never-run code read as run`);
      const reasons = partialReasons(coverage);
      rows.push({ name: spike.name, complete: missing.length === 0, flagged: reasons.length > 0, reasons: [...reasons, ...(coverage.lostDetail ?? []).map((d) => `${d.type}:${d.profiler ? "p" : "-"}${d.css ? "c" : "-"}${d.detached ? "d" : "-"}`), ...(missing.length ? [`missing=${missing.join("+")}`] : [])] });
    } finally {
      await context.close();
    }
  }
  const summary = rows.map((r) => `${r.name}: ${r.complete ? "complete" : "partial"}${r.flagged ? ` [${r.reasons.join(",")}]` : ""}`).join("\n");
  // Safety, strict: a test that didn't run whole is never read whole.
  const missed = rows.filter((r) => !r.complete && !r.flagged);
  assert.deepEqual(missed.map((r) => r.name), [], `a partial test read whole:\n${summary}`);
  // Spike 3's verdict, exactly, for every test whose targets exist before it acts. A target
  // the app creates mid-test (a worker, the service worker, a popup, a cross-site frame) is
  // held for this collector too (the premise pinned below), but under load its setup replies
  // or final take can miss the test's end: it must then read partial (flagged above), so its
  // verdict may go either way.
  const RACES = new Set(["worker", "service-worker", "popup", "popup-xsite", "iframe-xsite"]);
  const SPIKE_PARTIAL = new Set(["nav-js", "popup-close", "worker-term"]);
  for (const row of rows.filter((r) => !RACES.has(r.name))) {
    assert.equal(row.complete, !SPIKE_PARTIAL.has(row.name), `${row.name}, against spike 3's row:\n${summary}`);
  }
  assert.ok(rows.filter((r) => r.complete).length >= 12 - RACES.size, summary);
  // The only false alarms: spike 3's navigations (partial though the delta saved them), and
  // a target that can't prove its coverage started first (a worker has no frame tree to show).
  assert.ok(rows.filter((r) => r.complete && r.flagged).every((r) => r.name.startsWith("nav-") || (RACES.has(r.name) && r.reasons.includes("started_late"))), summary);
});

test("a built chunk's functions land on its fingerprint's keys", async (t) => {
  const build = nextBuild(BASE);
  const fingerprint = fingerprintBuild({ files: [...build.keys()], read: (file) => build.get(file) ?? null, sourcePrefix: "" });
  const page = `<!doctype html><html><head><link rel="stylesheet" href="/_next/static/chunks/${BASE.hash}c3.css"></head><body><div class="Badge-module__badge">b</div>
<script src="/_next/static/chunks/${BASE.hash}c1.js"></script>
<script>
  const exported = {};
  const context = { i: () => ({ badge: "b", ok: "o" }), s: (names) => Object.assign(exported, names), v: () => {} };
  for (const factories of globalThis.TURBOPACK) for (const factory of Object.values(factories[1])) factory(context);
  exported.LoginForm()({ token: "t" });
  exported.default()({ variant: "ok" });
</script></body></html>`;
  const server = await serve(async (pathname) => (pathname === "/" ? page : build.get(pathname.replace(/^\/_next\//, "")) ?? null));
  t.after(() => server.close());
  const { browser, cdp } = await launch(t);
  const collector = new CdpCoverage(cdp, { browser: "chromium" });
  await collector.attach();
  const context = await browser.newContext();
  t.after(() => context.close());
  const tab = await context.newPage();
  await collector.begin();
  // This test is about mapping, not the first-page race (evidence-worker.test.ts has that):
  // let coverage start on the page before it runs.
  const { browserContextIds } = (await cdp.send("Target.getBrowserContexts")) as { browserContextIds: string[] };
  for (let waited = 0; collector.pages(browserContextIds[0]!) < 1 && waited < 2_000; waited += 10) await new Promise((resolve) => setTimeout(resolve, 10));
  await collector.settled();
  await tab.goto(`http://127.0.0.1:${(server.address() as net.AddressInfo).port}/`);
  const coverage = await collector.finish();
  const footprint = browserFootprint(coverage, fingerprint);
  assert.equal(footprint.unmapped, 0, JSON.stringify(coverage.scripts));
  for (const name of ["LoginForm", "onSuccess", "Badge", "default"]) {
    assert.ok(footprint.keys.some((key) => key.endsWith(`:${name}`)), `${name} ran and maps: ${footprint.keys.join(", ")}`);
  }
  assert.ok(footprint.keys.includes("fn:browser:src/components/common/Badge.module.css:[project]/src/components/common/Badge.module.css [client] (css module)"), footprint.keys.join("\n"));
  assert.ok(footprint.keys.includes("file:src/components/common/Badge.module.css"));
  assert.ok(footprint.keys.includes("css:src/components/common/Badge.module.css"), footprint.keys.join("\n"));
  assert.deepEqual(footprint.partial, [], footprint.reasons.join(","));
});

test("sol's case in real Chromium: a page that ran before the collector attached, its startup gone from an empty baseline, reads started_late", async (t) => {
  const pages: Record<string, string> = {
    "/startup": `<!doctype html><html><body><script src="/startup.js"></script></body></html>`,
    "/startup.js": `function startup() { document.body.dataset.ready = "1"; } startup();`,
    "/plain": `<!doctype html><html><body>plain</body></html>`,
  };
  const server = await serve(async (pathname) => pages[pathname] ?? null);
  t.after(() => server.close());
  const base = `http://127.0.0.1:${(server.address() as net.AddressInfo).port}`;
  const { browser, cdp } = await launch(t);
  const context = await browser.newContext();
  const page = await context.newPage();
  // All before the collector exists: the startup runs, then its document is replaced.
  await page.goto(`${base}/startup`);
  await page.waitForFunction(() => document.body.dataset.ready === "1");
  await page.goto(`${base}/plain`);
  let baseline: unknown = null;
  const watched = {
    ...cdp,
    send: async (method: string, params?: object, sessionId?: string) => {
      const answer = await cdp.send(method, params, sessionId);
      if (method === "Profiler.takePreciseCoverage" && sessionId && baseline === null) baseline = answer;
      return answer;
    },
  };
  const collector = new CdpCoverage(watched, { browser: "chromium" });
  await collector.begin();
  await collector.attach();
  // The page is already running: it attaches without waiting for us.
  for (let waited = 0; collector.pages((await cdp.send("Target.getBrowserContexts") as { browserContextIds: string[] }).browserContextIds[0]!) < 1 && waited < 2_000; waited += 10) await new Promise((resolve) => setTimeout(resolve, 10));
  await collector.settled();
  await new Promise((resolve) => setTimeout(resolve, 200));
  const coverage = await collector.finish();
  assert.ok(!coverage.scripts.some((s) => s.functions.some((fn) => fn.name === "startup")), "startup ran unseen");
  assert.deepEqual(((baseline as { result?: Array<{ url: string }> } | null)?.result ?? []).filter((s) => s.url.includes("startup")), [], "the baseline holds nothing of it");
  assert.ok(partialReasons(coverage).includes("started_late"), JSON.stringify({ late: coverage.late, lost: coverage.lost, errors: coverage.errors }));
});

// Adversarial: every way a target can run app code before our start and still look proven.
// Each one runs before the collector attaches; each must read late.
const ADVERSARY_PAGES: Record<string, string> = {
  "/startup": `<!doctype html><html><body><script src="/startup.js"></script></body></html>`,
  "/startup.js": `function startup() { document.body.dataset.ready = "1"; } startup();`,
  "/plain": `<!doctype html><html><body>plain</body></html>`,
  "/framed": "", // filled in with the other site's address
};

async function attachedAfter(t: TestContext, prepare: (page: Page, sites: { same: string; other: string }) => Promise<void>, channel?: string) {
  const server = await serve(async (pathname) => ADVERSARY_PAGES[pathname] ?? null);
  t.after(() => server.close());
  const port = (server.address() as net.AddressInfo).port;
  const sites = { same: `http://127.0.0.1:${port}`, other: `http://localhost:${port}` };
  ADVERSARY_PAGES["/framed"] = `<!doctype html><html><body><iframe src="${sites.other}/startup"></iframe></body></html>`;
  const { browser, cdp } = await launch(t, channel);
  const context = await browser.newContext();
  const page = await context.newPage();
  await prepare(page, sites);
  const collector = new CdpCoverage(cdp, { browser: "chromium" });
  await collector.begin();
  await collector.attach();
  const [contextId] = ((await cdp.send("Target.getBrowserContexts")) as { browserContextIds: string[] }).browserContextIds;
  for (let waited = 0; collector.pages(contextId!) < context.pages().length && waited < 2_000; waited += 10) await new Promise((resolve) => setTimeout(resolve, 10));
  await new Promise((resolve) => setTimeout(resolve, 300));
  await collector.settled();
  return collector.finish();
}

const lateTypes = (coverage: AttemptCoverage) => (coverage.lateDetail ?? []).map((d) => d.type).sort();

test("a target that attaches already running is never proven, even on its first about:blank", async (t) => {
  const coverage = await attachedAfter(t, async () => {});
  assert.deepEqual(lateTypes(coverage), ["page"]);
});

test("held control: a page opened after we attach is proven, and reads whole", async (t) => {
  const server = await serve(async (pathname) => ADVERSARY_PAGES[pathname] ?? null);
  t.after(() => server.close());
  const { browser, cdp } = await launch(t);
  const collector = new CdpCoverage(cdp, { browser: "chromium" });
  await collector.attach();
  const context = await browser.newContext();
  await collector.begin();
  const page = await context.newPage();
  await page.goto(`http://127.0.0.1:${(server.address() as net.AddressInfo).port}/startup`);
  await page.waitForFunction(() => document.body.dataset.ready === "1");
  await collector.settled();
  const coverage = await collector.finish();
  assert.deepEqual([lateTypes(coverage), coverage.lost], [[], 0], JSON.stringify(coverage.lateDetail));
  assert.ok(coverage.scripts.some((s) => s.functions.some((fn) => fn.name === "startup")));
});

test("adversary — a popup that runs, then location.replace('about:blank') (sol r7): late", async (t) => {
  const coverage = await attachedAfter(t, async (page, { same }) => {
    const [popup] = await Promise.all([page.waitForEvent("popup"), page.evaluate((url) => void window.open(url), `${same}/startup`)]);
    await popup.waitForFunction(() => document.body.dataset.ready === "1");
    await popup.evaluate(() => location.replace("about:blank"));
    await popup.waitForURL("about:blank");
  });
  assert.ok(lateTypes(coverage).filter((type) => type === "page").length === 2, JSON.stringify(coverage.lateDetail));
});

test("adversary — code run on the initial blank by setContent (sol r7): late", async (t) => {
  const coverage = await attachedAfter(t, async (page) => {
    await page.setContent(`<script>function injected() { document.title = "ran"; } injected();</script>`);
  });
  assert.deepEqual(lateTypes(coverage), ["page"]);
});

test("adversary — navigate, run, then back to about:blank (sol r6): late", async (t) => {
  const coverage = await attachedAfter(t, async (page, { same }) => {
    await page.goto(`${same}/startup`);
    await page.waitForFunction(() => document.body.dataset.ready === "1");
    await page.goto("about:blank");
  });
  assert.deepEqual(lateTypes(coverage), ["page"]);
});

test("adversary — window.open, then the popup navigates and runs: the popup is late", async (t) => {
  const coverage = await attachedAfter(t, async (page, { same }) => {
    const [popup] = await Promise.all([page.waitForEvent("popup"), page.evaluate((url) => void window.open(url), `${same}/startup`)]);
    await popup.waitForFunction(() => document.body.dataset.ready === "1");
  });
  // Both attached already running: the popup that ran, and its opener too (never proven).
  assert.deepEqual(lateTypes(coverage), ["page", "page"]);
});

test("adversary — a cross-site frame swapped in and run: the frame is late too", async (t) => {
  // Full Chromium: the headless shell runs a cross-site frame in-process, with no target of its own.
  const coverage = await attachedAfter(t, async (page, { same }) => {
    await page.goto(`${same}/framed`);
    await page.frames()[1]!.waitForFunction(() => document.body.dataset.ready === "1");
  }, "chromium");
  assert.deepEqual(lateTypes(coverage), ["iframe", "page"], JSON.stringify(coverage.lateDetail));
});

test("adversary — run, leave, then come back from the back/forward cache: late", async (t) => {
  const coverage = await attachedAfter(t, async (page, { same }) => {
    await page.goto(`${same}/startup`);
    await page.waitForFunction(() => document.body.dataset.ready === "1");
    await page.goto(`${same}/plain`);
    await page.goBack();
  });
  assert.deepEqual(lateTypes(coverage), ["page"]);
});

test("adversary — run, then history.pushState away: late", async (t) => {
  const coverage = await attachedAfter(t, async (page, { same }) => {
    await page.goto(`${same}/startup`);
    await page.waitForFunction(() => document.body.dataset.ready === "1");
    await page.evaluate(() => history.pushState({}, "", "/elsewhere"));
  });
  assert.deepEqual(lateTypes(coverage), ["page"]);
});

test("adversary — run, then reload in place (one history entry, not about:blank): late", async (t) => {
  const coverage = await attachedAfter(t, async (page, { same }) => {
    await page.goto(`${same}/startup`);
    await page.reload();
    await page.waitForFunction(() => document.body.dataset.ready === "1");
  });
  assert.deepEqual(lateTypes(coverage), ["page"]);
});

test("the held proof's premise, pinned: Chrome holds a new page until our session resumes it too", async (t) => {
  const server = await serve(async () => "<script>document.title = 'ran'</script>");
  t.after(() => server.close());
  const { browser, cdp } = await launch(t);
  // Our session asks to hold every new target, and never resumes one.
  await cdp.send("Target.setAutoAttach", { autoAttach: true, waitForDebuggerOnStart: true, flatten: true });
  const page = await (await browser.newContext()).newPage();
  const outcome = await Promise.race([
    page.goto(`http://127.0.0.1:${(server.address() as net.AddressInfo).port}/`).then(() => "ran"),
    new Promise((resolve) => setTimeout(() => resolve("held"), 3_000)),
  ]);
  assert.equal(outcome, "held", "if Chrome stops waiting for every client, the held proof no longer holds");
});
