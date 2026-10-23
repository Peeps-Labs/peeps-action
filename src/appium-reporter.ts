/**
 * The WebdriverIO side of peeps-action's Appium path, loaded by the wrapper
 * config the action writes beside the customer's `wdio.conf`:
 *
 *   PeepsAppiumReporter  a WebdriverIO reporter that streams `run_start /
 *                        test_start / test_end / run_end` for every planned
 *                        test to `POST /api/v1/runs/{runId}/events`, the same
 *                        events and credentials the Playwright reporter
 *                        (`reporter.ts`) and the pytest plugin send.
 *   peepsAfterTest       an `afterTest` hook: on a failed test, saves a
 *   peepsAfterHook       screenshot and the page source (and on a failed
 *                        `beforeEach`, the same for the test it was for) as
 *                        attachments the reporter lists on that test's final
 *                        `test_end`, in the pytest evidence shape
 *                        (`PytestTestEndEvidence`).
 *   withPeeps            what the wrapper config exports: the customer's
 *                        config with the above appended, and in run mode the
 *                        planned spec files and a mocha grep.
 *
 * Bundled to its own file (dist/appium-reporter.js) and loaded inside the
 * customer's WebdriverIO workers, so it must stay dependency-free: it is a
 * plain reporter (WebdriverIO instantiates any class in `reporters` and
 * calls `emit(event, payload)` on it), not a subclass of `@wdio/reporter`,
 * which a strict node_modules layout may not even let it resolve.
 *
 * Every worker is its own process with its own instance of this module, and
 * the hook and the reporter of one worker share it: the hook runs inside the
 * test's own function wrapper, before mocha reports the failure, so what it
 * saved is there when the reporter builds that test's `test_end`.
 */

import { mkdirSync, readFileSync, realpathSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { PlanEntry } from "./reporter";

export const TITLE_PATH_SEPARATOR = " › ";

/** The plan file the action writes for an Appium run (`PEEPS_PLAN_FILE`). */
export interface AppiumPlanFile {
  peepsUrl: string;
  /** The repository root, absolute: test paths are relative to it. */
  workspace: string;
  runs: PlanEntry[];
}

// ---------------------------------------------------------------------------
// Identity
// ---------------------------------------------------------------------------

/**
 * `abs` relative to the repository root, POSIX, or null when it lies
 * outside. Tried as given and then with both sides' symlinks resolved, since
 * WebdriverIO reports spec paths as it globbed them and a workspace reached
 * through a symlink (macOS's `/var`) would otherwise come out as `../…`.
 */
export function repoRelative(workspace: string, abs: string): string | null {
  const attempt = (root: string, file: string) => {
    const rel = path.relative(root, file).split(path.sep).join("/");
    return rel === "" || rel === ".." || rel.startsWith("../") || path.isAbsolute(rel) ? null : rel;
  };
  const direct = attempt(workspace, abs);
  if (direct !== null) return direct;
  try {
    return attempt(realpathSync(workspace), realpathSync(abs));
  } catch {
    return null;
  }
}

/** Identity is `(path, titlePath)`: one run per test (no projects here). */
export function identityKey(test: { path: string; titlePath: string }): string {
  return `${test.path}\n${test.titlePath}`;
}

class Plan {
  readonly entries = new Map<string, PlanEntry>();
  constructor(readonly file: AppiumPlanFile) {
    for (const run of file.runs) {
      const key = identityKey(run);
      if (!this.entries.has(key)) this.entries.set(key, run);
    }
  }

  /** The run a test reports to: its spec file (absolute) and title chain. */
  entryFor(file: string | undefined, titles: string[]): PlanEntry | null {
    if (!file) return null;
    const rel = repoRelative(this.file.workspace, file.startsWith("file://") ? fileURLToPath(file) : file);
    if (rel === null) return null;
    return this.entries.get(identityKey({ path: rel, titlePath: titles.join(TITLE_PATH_SEPARATOR) })) ?? null;
  }
}

let cachedPlan: Plan | null | undefined;

/** The plan, read once per worker; null (and inert) when there is none. */
function loadPlan(): Plan | null {
  if (cachedPlan !== undefined) return cachedPlan;
  const planPath = process.env.PEEPS_PLAN_FILE;
  if (!planPath) {
    cachedPlan = null;
    return null;
  }
  cachedPlan = new Plan(JSON.parse(readFileSync(planPath, "utf8")) as AppiumPlanFile);
  return cachedPlan;
}

/** For tests: forget the plan and captured evidence this process holds. */
export function resetForTests(): void {
  cachedPlan = undefined;
  captured.clear();
}

// ---------------------------------------------------------------------------
// Evidence: a failed test's screenshot and page source
// ---------------------------------------------------------------------------

/**
 * The extensions Peeps accepts under a batch's `data/` (`REPORT_DATA_EXTENSIONS`
 * in Peeps' `src/lib/repo-backed/pytest-evidence.ts`; the pytest plugin's
 * `DATA_EXTENSIONS`). xml and html are deliberately absent there: the report
 * route serves `data/` inline from the app origin. Anything else is uploaded
 * with `.dat` appended, so a page source travels as `page-source.xml.dat`.
 */
export const DATA_EXTENSIONS: ReadonlySet<string> = new Set([
  "dat", "png", "jpg", "jpeg", "gif", "webp", "webm", "mp4", "zip",
  "md", "txt", "log", "json", "csv", "har", "pdf",
]);

/** The pytest plugin's per-file cap; a larger capture is listed as omitted. */
export const MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024;

/** How long one capture command may take before it is given up on. */
const CAPTURE_TIMEOUT_MS = 20_000;

/**
 * The file name one attachment is staged and uploaded under (the batch path
 * is `data/` + this), as the pytest plugin's `upload_name` names it: the run,
 * `-evidence-`, the file's own name, and `.dat` for a type `data/` refuses.
 */
export function evidenceFileName(runId: string, name: string): string {
  let flat = name.replace(/\//g, "-").replace(/[^A-Za-z0-9._-]/g, "_").replace(/^\.+/, "") || "file";
  const ext = path.extname(flat).slice(1).toLowerCase();
  if (!DATA_EXTENSIONS.has(ext)) flat = `${flat}.dat`;
  return `${runId}-evidence-${flat}`;
}

/**
 * `xml` for a native screen (UiAutomator2's `<hierarchy>`, XCUITest's
 * `<AppiumAUT>`), `html` in a WebView or browser context.
 */
export function pageSourceExtension(source: string, context: string | null): "xml" | "html" {
  if (context && /^(WEBVIEW|CHROMIUM)/i.test(context)) return "html";
  const head = source.trimStart().slice(0, 512);
  if (/^<\?xml|^<hierarchy[\s>]|^<AppiumAUT[\s>]/i.test(head)) return "xml";
  if (/^<!doctype html|<html[\s>]/i.test(head)) return "html";
  return context && /^NATIVE/i.test(context) ? "xml" : "html";
}

interface Captured {
  attachments: Array<{ name: string; path: string; size: number }>;
  omitted: Array<{ name: string; reason: string }>;
  context: string | null;
  /** The staged files, absolute, so a retried attempt's can be removed. */
  files: string[];
}

/** What this worker captured, by run id: the latest attempt only. */
const captured = new Map<string, Captured>();

function discardCaptured(runId: string): void {
  for (const file of captured.get(runId)?.files ?? []) {
    try {
      unlinkSync(file);
    } catch {
      // Already gone.
    }
  }
  captured.delete(runId);
}

function withTimeout<T>(promise: Promise<T>, label: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  return Promise.race([
    promise,
    new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${label} timed out after ${CAPTURE_TIMEOUT_MS} ms`)), CAPTURE_TIMEOUT_MS);
    }),
  ]).finally(() => clearTimeout(timer));
}

function reasonOf(error: unknown): string {
  return `capture failed: ${(error instanceof Error ? error.message : String(error)).split("\n")[0]!.slice(0, 200)}`;
}

/** The subset of a WebdriverIO browser this module calls. */
export interface CaptureBrowser {
  isMobile?: boolean;
  saveScreenshot(file: string): Promise<unknown>;
  getPageSource(): Promise<string>;
  getContext?(): Promise<unknown>;
}

/**
 * Save a screenshot and the page source for one run, into
 * `PEEPS_ARTIFACTS_DIR/upload`, replacing what an earlier attempt saved.
 * Never throws: evidence is a bonus on top of the result.
 */
export async function captureEvidence(runId: string, browser: CaptureBrowser): Promise<void> {
  const artifacts = process.env.PEEPS_ARTIFACTS_DIR;
  if (!artifacts) return;
  discardCaptured(runId);
  const dir = path.join(artifacts, "upload");
  const out: Captured = { attachments: [], omitted: [], context: null, files: [] };
  const keep = (name: string, file: string) => {
    out.files.push(file);
    const size = statSync(file).size;
    if (size > MAX_ATTACHMENT_BYTES) {
      unlinkSync(file);
      out.omitted.push({ name, reason: `larger than ${MAX_ATTACHMENT_BYTES} bytes` });
      return;
    }
    out.attachments.push({ name, path: `data/${path.basename(file)}`, size });
  };
  try {
    mkdirSync(dir, { recursive: true });
    try {
      const file = path.join(dir, evidenceFileName(runId, "screenshot.png"));
      await withTimeout(Promise.resolve(browser.saveScreenshot(file)), "saveScreenshot");
      keep("screenshot.png", file);
    } catch (error) {
      out.omitted.push({ name: "screenshot.png", reason: reasonOf(error) });
    }
    // Appium only: `NATIVE_APP`, or `WEBVIEW_<package>` once the test switched.
    if (browser.isMobile && typeof browser.getContext === "function") {
      try {
        const context = await withTimeout(Promise.resolve(browser.getContext()), "getContext");
        const id = typeof context === "string" ? context : (context as { id?: unknown } | null)?.id;
        out.context = typeof id === "string" ? id : null;
      } catch {
        // Not every driver answers; the page source still says what it is.
      }
    }
    let name = "page-source";
    try {
      const source = String(await withTimeout(Promise.resolve(browser.getPageSource()), "getPageSource"));
      name = `page-source.${pageSourceExtension(source, out.context)}`;
      const file = path.join(dir, evidenceFileName(runId, name));
      writeFileSync(file, source);
      keep(name, file);
    } catch (error) {
      out.omitted.push({ name, reason: reasonOf(error) });
    }
  } catch (error) {
    console.log(`[peeps] evidence for ${runId} not captured: ${String(error)}`);
  }
  captured.set(runId, out);
}

/** The `browser` global the WebdriverIO worker set up, if it is usable. */
function workerBrowser(): CaptureBrowser | null {
  const browser = (globalThis as { browser?: Partial<CaptureBrowser> }).browser;
  return browser && typeof browser.saveScreenshot === "function" && typeof browser.getPageSource === "function"
    ? (browser as CaptureBrowser)
    : null;
}

interface MochaRunnableLike {
  title?: string;
  file?: string;
  titlePath?: () => string[];
}

function titlesOf(test: MochaRunnableLike | undefined): string[] | null {
  return test && typeof test.titlePath === "function" ? test.titlePath() : null;
}

/**
 * WebdriverIO's `afterTest(test, context, result)`. Runs inside the test's
 * own wrapper, after its body and before mocha reports the failure; `context`
 * is mocha's, whose `test` is the real mocha Test.
 */
export async function peepsAfterTest(
  _test: unknown,
  context: { test?: MochaRunnableLike } | undefined,
  result: { passed?: boolean; error?: unknown } | undefined,
): Promise<void> {
  try {
    if (!result || result.passed || !result.error) return;
    const plan = loadPlan();
    const titles = titlesOf(context?.test);
    const browser = workerBrowser();
    if (!plan || !titles || !browser) return;
    const entry = plan.entryFor(context?.test?.file, titles);
    if (entry) await captureEvidence(entry.runId, browser);
  } catch (error) {
    console.log(`[peeps] afterTest evidence not captured: ${String(error)}`);
  }
}

/**
 * WebdriverIO's `afterHook(test, context, result)`: a failed `beforeEach`
 * never runs its test, so the screen it failed on is captured here, for the
 * test it was for (`context.currentTest`).
 */
export async function peepsAfterHook(
  _hook: unknown,
  context: { test?: MochaRunnableLike; currentTest?: MochaRunnableLike } | undefined,
  result: { passed?: boolean; error?: unknown } | undefined,
): Promise<void> {
  try {
    if (!result?.error || !/^"before each" hook/.test(context?.test?.title ?? "")) return;
    const plan = loadPlan();
    const titles = titlesOf(context?.currentTest);
    const browser = workerBrowser();
    if (!plan || !titles || !browser) return;
    const entry = plan.entryFor(context?.currentTest?.file, titles);
    if (entry) await captureEvidence(entry.runId, browser);
  } catch (error) {
    console.log(`[peeps] afterHook evidence not captured: ${String(error)}`);
  }
}

// ---------------------------------------------------------------------------
// The reporter
// ---------------------------------------------------------------------------

/** WebdriverIO's error, as `@wdio/mocha-framework` formats it into an event. */
interface WdioError {
  name?: string;
  type?: string;
  message?: string;
  stack?: string;
}

/** The fields of a WebdriverIO reporter event this reporter reads. */
export interface WdioEventPayload {
  title?: string;
  /** The enclosing suite's title (a hook's: the suite that owns it). */
  parent?: string;
  file?: string;
  duration?: number;
  error?: WdioError;
  errors?: WdioError[];
  specs?: string[];
}

export interface PeepsEvent {
  type: "run_start" | "test_start" | "test_end" | "run_end";
  timestamp: number;
  testName?: string;
  status?: "passed" | "failed" | "skipped";
  duration?: number;
  error?: string;
  errorStack?: string;
  failure?: {
    phase: "setup" | "call" | "teardown";
    exceptionType: string | null;
    message: string;
    traceback: string;
  };
  properties?: Array<{ name: string; value: string }>;
  attachments?: Array<{ name: string; path: string; size: number }>;
  attachmentsOmitted?: Array<{ name: string; reason: string }>;
}

/** The pytest plugin's traceback trim: keep the head and the tail. */
function trimMiddle(text: string, head = 2000, tail = 10000): string {
  if (text.length <= head + tail) return text;
  return `${text.slice(0, head)}\n… (trimmed) …\n${text.slice(-tail)}`;
}

/** The evidence fields of a failed test's final `test_end`. */
export function failureEvidence(
  error: WdioError | undefined,
  phase: "setup" | "call",
  evidence: Captured | undefined,
): Partial<PeepsEvent> {
  const fields: Partial<PeepsEvent> = {};
  if (error) {
    const message = error.message ?? "";
    fields.failure = {
      phase,
      exceptionType: error.name || error.type || null,
      message: message.slice(0, 4000),
      traceback: trimMiddle(error.stack ?? message),
    };
  }
  if (evidence?.attachments.length) fields.attachments = evidence.attachments;
  if (evidence?.omitted.length) fields.attachmentsOmitted = evidence.omitted;
  if (evidence?.context) fields.properties = [{ name: "context", value: evidence.context }];
  return fields;
}

const BEFORE_HOOK = /^"before (all|each)" hook/;

/**
 * Streams each planned test's events to Peeps. One instance per WebdriverIO
 * worker (one spec file, or one group, on one capability).
 */
export class PeepsAppiumReporter {
  private readonly plan: Plan | null;
  /** The describe titles enclosing what runs now, outermost first. */
  private readonly suites: string[] = [];
  private readonly queues = new Map<string, PeepsEvent[]>();
  private readonly started = new Set<string>();
  private readonly ended = new Set<string>();
  private readonly attemptStart = new Map<string, number>();
  private inflight = 0;
  private file: string | undefined;

  constructor(_options?: unknown) {
    this.plan = loadPlan();
    if (!this.plan) console.log("[peeps] PEEPS_PLAN_FILE is not set; nothing is reported");
  }

  /** WebdriverIO waits for this before the worker exits (`reporterSyncTimeout`). */
  get isSynchronised(): boolean {
    return this.inflight === 0;
  }

  emit(event: string, payload: WdioEventPayload = {}): void {
    if (!this.plan) return;
    switch (event) {
      case "runner:start":
        console.log(`[peeps] reporting ${this.plan.entries.size} planned run(s) to ${this.plan.file.peepsUrl}`);
        return;
      case "suite:start":
        this.suites.push(payload.title ?? "");
        if (payload.file) this.file = payload.file;
        return;
      case "suite:end":
        this.suites.pop();
        return;
      case "test:start":
        this.onTestStart(payload);
        return;
      case "test:pass":
        this.onTestEnd(payload, "passed");
        return;
      case "test:fail":
        this.onTestEnd(payload, "failed");
        return;
      case "test:pending":
        this.onTestEnd(payload, "skipped");
        return;
      case "test:retry":
        this.onTestRetry(payload);
        return;
      case "hook:end":
        if (payload.error && BEFORE_HOOK.test(payload.title ?? "")) this.onSetupFailure(payload);
        return;
      case "runner:end":
        for (const runId of this.queues.keys()) this.flush(runId);
        return;
      default:
        return;
    }
  }

  private entryOf(payload: WdioEventPayload): PlanEntry | null {
    return this.plan!.entryFor(payload.file ?? this.file, [...this.suites, payload.title ?? ""]);
  }

  private begin(entry: PlanEntry, testName: string): void {
    const now = Date.now();
    if (!this.started.has(entry.runId)) {
      this.started.add(entry.runId);
      this.enqueue(entry.runId, { type: "run_start", timestamp: now });
    }
    this.enqueue(entry.runId, { type: "test_start", timestamp: now, testName });
    this.attemptStart.set(entry.runId, now);
  }

  private onTestStart(payload: WdioEventPayload): void {
    const entry = this.entryOf(payload);
    if (entry && !this.ended.has(entry.runId)) this.begin(entry, payload.title ?? "");
  }

  private onTestEnd(payload: WdioEventPayload, status: "passed" | "failed" | "skipped"): void {
    const entry = this.entryOf(payload);
    if (!entry) {
      console.log(
        `[peeps] not planned, not reported: ${[...this.suites, payload.title ?? ""].join(TITLE_PATH_SEPARATOR)} (${status})`,
      );
      return;
    }
    // A test mocha reports twice (a second `done()`) closed its run already.
    if (this.ended.has(entry.runId)) return;
    // `it.skip` is reported without ever starting.
    if (!this.attemptStart.has(entry.runId)) this.begin(entry, payload.title ?? "");
    const error = payload.error ?? payload.errors?.[0];
    const event: PeepsEvent = {
      type: "test_end",
      timestamp: Date.now(),
      testName: payload.title ?? "",
      status,
      duration: this.durationOf(entry.runId, payload),
    };
    if (status === "failed") {
      if (error?.message) event.error = error.message.slice(0, 4000);
      if (error?.stack) event.errorStack = error.stack.slice(0, 8000);
      Object.assign(event, failureEvidence(error, "call", captured.get(entry.runId)));
    }
    this.close(entry, event);
  }

  /** A failed attempt mocha retries: a failed `test_end`, without evidence. */
  private onTestRetry(payload: WdioEventPayload): void {
    const entry = this.entryOf(payload);
    if (!entry || this.ended.has(entry.runId)) return;
    const error = payload.error ?? payload.errors?.[0];
    this.enqueue(entry.runId, {
      type: "test_end",
      timestamp: Date.now(),
      testName: payload.title ?? "",
      status: "failed",
      duration: this.durationOf(entry.runId, payload),
      error: (error?.message ?? "failed; retried").slice(0, 4000),
      ...(error?.stack ? { errorStack: error.stack.slice(0, 8000) } : {}),
    });
    this.attemptStart.delete(entry.runId);
    // Only the final attempt's evidence is reported, as under pytest.
    discardCaptured(entry.runId);
  }

  /**
   * A failed `before`/`beforeEach` hook: mocha runs none of the tests below
   * it and reports none of them. Each planned test there that has not ended
   * fails at setup, with the hook's error, as a pytest fixture error does.
   */
  private onSetupFailure(payload: WdioEventPayload): void {
    const file = payload.file ?? this.file;
    const rel = file ? repoRelative(this.plan!.file.workspace, file) : null;
    if (rel === null) return;
    // Everything under the suite that owns the hook; the root's (`""`) is the file.
    const owner = payload.parent === "" ? 0 : this.suites.lastIndexOf(payload.parent ?? "") + 1;
    const scope = owner > 0 || payload.parent === "" ? this.suites.slice(0, owner) : this.suites;
    const prefix = scope.length ? scope.join(TITLE_PATH_SEPARATOR) + TITLE_PATH_SEPARATOR : "";
    const error = payload.error ?? payload.errors?.[0];
    for (const entry of this.plan!.entries.values()) {
      if (entry.path !== rel || !entry.titlePath.startsWith(prefix) || this.ended.has(entry.runId)) continue;
      const testName = entry.titlePath.split(TITLE_PATH_SEPARATOR).pop() ?? "";
      if (!this.attemptStart.has(entry.runId)) this.begin(entry, testName);
      const message = `${payload.title ?? "a before hook"} failed: ${error?.message ?? ""}`;
      this.close(entry, {
        type: "test_end",
        timestamp: Date.now(),
        testName,
        status: "failed",
        duration: 0,
        error: message.slice(0, 4000),
        ...(error?.stack ? { errorStack: error.stack.slice(0, 8000) } : {}),
        ...failureEvidence(error, "setup", captured.get(entry.runId)),
      });
    }
  }

  private durationOf(runId: string, payload: WdioEventPayload): number {
    if (typeof payload.duration === "number" && Number.isFinite(payload.duration)) {
      return Math.max(0, Math.round(payload.duration));
    }
    const start = this.attemptStart.get(runId);
    return start === undefined ? 0 : Date.now() - start;
  }

  private close(entry: PlanEntry, event: PeepsEvent): void {
    this.enqueue(entry.runId, event);
    this.enqueue(entry.runId, { type: "run_end", timestamp: Date.now() });
    this.ended.add(entry.runId);
    this.attemptStart.delete(entry.runId);
    this.flush(entry.runId);
  }

  private enqueue(runId: string, event: PeepsEvent): void {
    const queue = this.queues.get(runId) ?? [];
    queue.push(event);
    this.queues.set(runId, queue);
  }

  private flush(runId: string): void {
    const events = this.queues.get(runId) ?? [];
    if (events.length === 0) return;
    this.queues.set(runId, []);
    const entry = this.plan!.file.runs.find((run) => run.runId === runId);
    if (!entry) return;
    this.inflight += 1;
    void deliver(this.plan!.file.peepsUrl, entry, events).finally(() => {
      this.inflight -= 1;
    });
  }
}

/** The Playwright reporter's delivery: three tries, a 4xx other than 408/429 is final. */
async function deliver(peepsUrl: string, entry: PlanEntry, events: PeepsEvent[]): Promise<void> {
  const url = `${peepsUrl}/api/v1/runs/${entry.runId}/events`;
  const body = JSON.stringify({ events });
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const response = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer v1.${entry.credential.exp}.${entry.credential.sig}`,
          "User-Agent": "peeps-action/0.1",
        },
        body,
        signal: AbortSignal.timeout(10_000),
      });
      if (response.ok) return;
      if (response.status < 500 && response.status !== 408 && response.status !== 429) {
        console.log(`[peeps] events for ${entry.runId} rejected: ${response.status} ${await response.text()}`);
        return;
      }
    } catch (error) {
      if (attempt === 2) console.log(`[peeps] events for ${entry.runId} failed: ${String(error)}`);
    }
    if (attempt < 2) await new Promise((r) => setTimeout(r, 1000 * (attempt + 1)));
  }
}

// ---------------------------------------------------------------------------
// The wrapper config
// ---------------------------------------------------------------------------

export interface PeepsWdioOptions {
  /** Run mode: only these spec files (absolute). */
  specs?: string[];
  /** Run mode: a mocha grep over each test's full title. */
  grep?: string;
  /** Where `@wdio/junit-reporter` writes, when the action adds it. */
  junitDir?: string | null;
}

type Hook = (...args: never[]) => unknown;

function hooksOf(value: unknown): Hook[] {
  if (typeof value === "function") return [value as Hook];
  return Array.isArray(value) ? value.filter((h): h is Hook => typeof h === "function") : [];
}

function isJunit(reporter: unknown): boolean {
  const name = Array.isArray(reporter) ? reporter[0] : reporter;
  return name === "junit" || name === "@wdio/junit-reporter";
}

/**
 * The customer's config with Peeps' reporter and hooks appended, never
 * replacing theirs. In run mode, the planned spec files (capability-level
 * `wdio:specs` would otherwise win over them) and a mocha grep.
 */
export function withPeeps(base: Record<string, unknown>, options: PeepsWdioOptions = {}): Record<string, unknown> {
  if (!base || typeof base !== "object") throw new Error("the WebdriverIO config must export a `config` object");
  const reporters: unknown[] = Array.isArray(base.reporters) ? [...(base.reporters as unknown[])] : [];
  reporters.push(PeepsAppiumReporter);
  // Only when the customer has none: WebdriverIO reads a reporter's options
  // by its name, so a second `junit` entry would write to theirs.
  if (options.junitDir && !reporters.some(isJunit)) {
    reporters.push([
      "junit",
      { outputDir: options.junitDir, outputFileFormat: (o: { cid: string }) => `junit-${o.cid}.xml` },
    ]);
  }
  const config: Record<string, unknown> = {
    ...base,
    reporters,
    afterTest: [...hooksOf(base.afterTest), peepsAfterTest],
    afterHook: [...hooksOf(base.afterHook), peepsAfterHook],
    // Room for the last test's events to reach Peeps before the worker exits.
    reporterSyncTimeout: Math.max(Number(base.reporterSyncTimeout) || 5000, 60_000),
  };
  if (options.specs) {
    config.specs = options.specs;
    config.exclude = [];
    if (Array.isArray(base.capabilities)) {
      config.capabilities = (base.capabilities as Array<Record<string, unknown>>).map((cap) => {
        if (!cap || typeof cap !== "object") return cap;
        const { "wdio:specs": _s, "wdio:exclude": _e, ...rest } = cap;
        return rest;
      });
    }
  }
  if (options.grep !== undefined) {
    const mochaOpts = base.mochaOpts && typeof base.mochaOpts === "object" ? base.mochaOpts : {};
    config.mochaOpts = { ...mochaOpts, grep: options.grep, invert: false };
  }
  return config;
}
