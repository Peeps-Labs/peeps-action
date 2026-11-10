/**
 * In-run browser coverage, inside a Playwright worker: bundled as `dist/evidence-worker.js`
 * and loaded by the capture config (#26's hook, `capture-config.ts`), which also adds this
 * worker's debugging port to Chromium's launch. It listens on Playwright's own client
 * instrumentation, the hooks its test runner saves traces with: a context's coverage
 * starts when it is created and is taken before it closes, while its pages still exist.
 *
 * No hook waits on each action (`onApiCallBegin` isn't awaited), so there is no delta
 * per action: a cross-document navigation reads partial, as spike 3's final-take row.
 * Each attempt's coverage is one file in the scratch directory, plaintext URLs and
 * offsets: the action keys it after Playwright exits. The key is never here.
 *
 * The port is checked before anything is read: another job's browser on it (a shared
 * runner) has other contexts, and is refused.
 */
import { spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { writeFileSync } from "node:fs";
import path from "node:path";
import { CdpCoverage } from "./cdp-coverage";
import { connectCdp, type CdpSocket } from "./cdp-socket";
import type { AttemptCoverage } from "./rules";

export interface AttemptFile {
  testId: string;
  retry: number;
  /** The context it was taken at the close of, as its `ctx-` marker names it. */
  contextId: string;
  browser: { name: string; version: string };
  coverage: AttemptCoverage;
}

/** What this needs of Playwright's client objects. */
interface ClientBrowser {
  browserType(): { name(): string };
  version(): string;
  newBrowserCDPSession(): Promise<{ send(method: string): Promise<unknown>; detach(): Promise<void> }>;
}
interface ClientContext {
  browser(): ClientBrowser | null;
  pages(): unknown[];
}

export interface WorkerInput {
  /** The scratch directory (`scratch.ts`). */
  dir: string;
  /** `playwright-core` as Playwright's runner loaded it. */
  core: { _instrumentation?: { addListener(listener: object): void } };
  /** `playwright/test`'s `test`: which attempt a context belongs to. */
  test: { info(): { testId: string; retry: number } };
  port: number;
  /** How to reach the browser's debugging port; tests stand in for it. */
  connect?: (port: number) => Promise<CdpSocket>;
  /** The backstop for any one wait in a hook (tests shorten it). */
  hookMs?: number;
}

/** A free local port, found synchronously: the config that launches the browser can't wait. */
export function pickPort(): number | null {
  const probe = "const s=require('net').createServer();s.listen(0,'127.0.0.1',()=>{process.stdout.write(String(s.address().port));s.close()})";
  const result = spawnSync(process.execPath, ["-e", probe], { encoding: "utf8", timeout: 5_000 });
  const port = Number(result.stdout);
  return Number.isSafeInteger(port) && port > 0 ? port : null;
}

/** Playwright's own session, for the port check. */
const SAME_BROWSER_MS = 3_000;
/** The backstop for any one wait in a hook; CDP replies time out at 5 s on their own. */
const HOOK_MS = 8_000;

const empty = (browser: string, refused: string): AttemptCoverage => ({ browser, scripts: [], sheets: [], assets: [], covered: [], lost: 0, errors: [], navigations: 0, refused });

async function sameBrowser(browser: ClientBrowser, cdp: CdpSocket): Promise<boolean> {
  const session = await browser.newBrowserCDPSession();
  try {
    const ids = (answer: unknown) => [...((answer as { browserContextIds?: string[] }).browserContextIds ?? [])].sort().join(",");
    const theirs = ids(await session.send("Target.getBrowserContexts"));
    return theirs !== "" && theirs === ids(await cdp.send("Target.getBrowserContexts"));
  } finally {
    await session.detach().catch(() => {});
  }
}

/**
 * A worker runs one test at a time, so every context open in it is the current test's:
 * coverage starts when the first opens, and each close writes all of it since then. Each
 * context's own targets are taken finally only at its own close (`cdp-coverage.ts`).
 */
interface Collector {
  coverage: CdpCoverage | null;
  cdp?: CdpSocket;
  refused?: string;
  open: Set<ClientContext>;
}

/** What the worker knows of a context: its attempt, its marker's id, its CDP id. */
interface Opened {
  attempt: { testId: string; retry: number } | null;
  contextId: string;
  collector: Promise<Collector> | null;
  cdpContext: string | null;
}

const attemptName = (prefix: string, attempt: { testId: string; retry: number }, contextId: string) =>
  `${prefix}-${createHash("sha256").update(attempt.testId).digest("hex").slice(0, 16)}-${attempt.retry}-${contextId}.json`;

/**
 * Registers the listener (returned, for removal) and leaves the browser's launch to the
 * config. Neither hook ever throws: Playwright awaits them, so a collector's failure would
 * fail the customer's test. A failure is refused evidence, which reads partial.
 */
export function installCoverage(input: WorkerInput): object | null {
  const instrumentation = input.core._instrumentation;
  if (!instrumentation?.addListener) return null;
  const hookMs = input.hookMs ?? HOOK_MS;
  const collectors = new Map<ClientBrowser, Promise<Collector>>();
  const opened = new Map<ClientContext, Opened>();
  const write = (name: string, value: unknown): boolean => {
    try {
      writeFileSync(path.join(input.dir, name), JSON.stringify(value), { mode: 0o600, flag: "wx" });
      return true;
    } catch {
      // No file is no evidence: that attempt reads partial.
      return false;
    }
  };
  /**
   * Attempts with a context whose marker never landed: none of their records may read
   * whole. Written as a `taint-` file at once, and again at the worker's exit, since an
   * earlier record of the attempt may already have landed.
   */
  const tainted = new Map<string, { testId: string; retry: number; written: boolean }>();
  const attemptKey = (a: { testId: string; retry: number }) => `${a.testId}\u0000${a.retry}`;
  const flushTaints = () => {
    for (const taint of tainted.values()) {
      if (!taint.written) taint.written = write(attemptName("taint", taint, "attempt"), { testId: taint.testId, retry: taint.retry });
    }
  };
  process.once("exit", flushTaints);
  /** Every wait inside an awaited Playwright hook is bounded: past it, coverage is refused, never the test. */
  const within = <T>(promise: Promise<T>, ms: number) =>
    Promise.race([promise, new Promise<never>((_, reject) => setTimeout(() => reject(new Error("timed out")), ms).unref())]);
  const currentAttempt = () => {
    try {
      const { testId, retry } = input.test.info();
      return { testId, retry };
    } catch {
      // Not a test's context (a worker fixture's, say).
      return null;
    }
  };

  const collectorFor = (browser: ClientBrowser) => {
    let collector = collectors.get(browser);
    if (!collector) {
      collector = (async (): Promise<Collector> => {
        const open = new Set<ClientContext>();
        let cdp: CdpSocket;
        try {
          cdp = await (input.connect ?? connectCdp)(input.port);
        } catch {
          return { coverage: null, refused: "no_debugging_port", open };
        }
        try {
          if (!(await within(sameBrowser(browser, cdp), SAME_BROWSER_MS).catch(() => false))) {
            cdp.close();
            return { coverage: null, refused: "not_this_browser", open };
          }
          const coverage = new CdpCoverage(cdp, { browser: browser.browserType().name() });
          await coverage.attach();
          return { coverage, cdp, open };
        } catch {
          cdp.close();
          return { coverage: null, refused: "collector_failed", open };
        }
      })();
      collectors.set(browser, collector);
    }
    return collector;
  };

  /** The context's CDP id: the one browser context no open context has claimed yet. */
  const cdpContextOf = async (collector: Collector): Promise<string | null> => {
    const answer = (await collector.cdp!.send("Target.getBrowserContexts")) as { browserContextIds?: string[] };
    const claimed = new Set([...opened.values()].map((o) => o.cdpContext));
    const free = (answer.browserContextIds ?? []).filter((id) => !claimed.has(id));
    return free.length === 1 ? free[0]! : null;
  };

  const listener = {
    runAfterCreateBrowserContext: async (context: ClientContext) => {
      const entry: Opened = { attempt: currentAttempt(), contextId: randomUUID(), collector: null, cdpContext: null };
      opened.set(context, entry);
      // Announced before anything can fail: the attempt is whole only once this context's own record arrives.
      if (entry.attempt && !write(attemptName("ctx", entry.attempt, entry.contextId), { ...entry.attempt, contextId: entry.contextId })) {
        tainted.set(attemptKey(entry.attempt), { ...entry.attempt, written: false });
        flushTaints();
      }
      let joined: Collector | null = null;
      try {
        const browser = context.browser();
        if (!browser || browser.browserType().name() !== "chromium") return;
        entry.collector = collectorFor(browser);
        const collector = await within(entry.collector, hookMs);
        if (!collector.coverage) return;
        entry.cdpContext = await within(cdpContextOf(collector), hookMs);
        collector.open.add(context);
        joined = collector;
        if (collector.open.size === 1) await within(collector.coverage.begin(), hookMs);
      } catch {
        // Out of the open set too: held there, it would keep every later attempt from beginning.
        joined?.open.delete(context);
        entry.collector = Promise.resolve({ coverage: null, refused: "collector_failed", open: new Set() });
      }
    },
    runBeforeCloseBrowserContext: async (context: ClientContext) => {
      const entry = opened.get(context);
      opened.delete(context);
      try {
        const attempt = currentAttempt();
        const browser = context.browser();
        const name = browser?.browserType().name() ?? "unknown";
        const version = browser?.version() ?? "";
        let coverage: AttemptCoverage;
        if (!entry?.collector) {
          // Not Chromium: no precise coverage to read, and `rules.ts` reads its name as partial.
          coverage = { browser: name, scripts: [], sheets: [], assets: [], covered: [], lost: 0, errors: [], navigations: 0 };
        } else {
          const collector = await within(entry.collector, hookMs).catch((): Collector => ({ coverage: null, refused: "collector_timeout", open: new Set() }));
          collector.open.delete(context);
          if (!collector.coverage) coverage = empty(name, collector.refused ?? "no_collector");
          else if (entry.cdpContext === null) coverage = empty(name, "context_unknown");
          else coverage = await within(collector.coverage.finish({ context: entry.cdpContext, last: collector.open.size === 0 }), hookMs).catch((error: unknown) => ({ ...empty(name, "take_failed"), errors: [String(error)] }));
        }
        // Closed outside the test that opened it (worker teardown): that attempt's record stays missing.
        if (!attempt || !entry?.attempt || attempt.testId !== entry.attempt.testId || attempt.retry !== entry.attempt.retry) return;
        if (tainted.has(attemptKey(attempt))) coverage = empty(name, "marker_failed");
        const file: AttemptFile = { testId: attempt.testId, retry: attempt.retry, contextId: entry.contextId, browser: { name, version }, coverage };
        write(attemptName("cov", attempt, entry.contextId), file);
      } catch {
        // Its record stays missing, and the attempt reads partial.
      }
    },
  };
  instrumentation.addListener(listener);
  /** How many contexts the collectors hold open: a diagnostic, and what tests check. */
  const openContexts = async () => {
    let count = 0;
    for (const collector of collectors.values()) count += (await collector).open.size;
    return count;
  };
  /**
   * Once the collector has attached to every page Playwright has opened, and their setup
   * replies are in: what tests wait on before a page runs. Bounded, like everything here.
   */
  const settled = async (deadlineMs = 2_000) => {
    const deadline = Date.now() + deadlineMs;
    for (const [context, entry] of opened) {
      const collector = entry.collector && (await entry.collector);
      if (!collector?.coverage || entry.cdpContext === null) continue;
      while (collector.coverage.pages(entry.cdpContext) < context.pages().length && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 10));
      await collector.coverage.settled();
    }
  };
  return Object.assign(listener, { flushTaints, openContexts, settled });
}
