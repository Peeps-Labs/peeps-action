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
 *   peepsBefore          a `before` hook: registers `browser.peepsScreen(name)`,
 *                        which saves a named screen of the running test for
 *                        Peeps' visual diffs, listed on its passed or failed
 *                        `test_end` with the device it was taken on.
 *   mochaHooks           run mode's mocha root hook: skips every test whose
 *                        (spec file, title path) the plan does not name.
 *   withPeeps            what the wrapper config exports: the customer's
 *                        config with the above appended, and in run mode the
 *                        planned spec files, a mocha grep and that hook.
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

import { createHash } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync, realpathSync, statSync, unlinkSync, writeFileSync } from "node:fs";
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
  /**
   * Agent mode's `run_tests`: there are no Peeps runs to report to. Every
   * test the run reports gets a local entry (`localRunId`), and its events
   * are appended to `<resultsDir>/events-<pid>.jsonl` instead of being sent.
   */
  resultsDir?: string;
  /**
   * Run mode: execute only the planned `(spec file, title path)` pairs. The
   * mocha grep matches titles only, so a planned file can hold a same-titled
   * test of another file's plan entry; `mochaHooks` skips it.
   */
  onlyPlanned?: boolean;
}

/** One line of a `resultsDir` events file: a test and the events it produced. */
export interface LocalResultsLine {
  runId: string;
  path: string;
  titlePath: string;
  events: PeepsEvent[];
}

/** A stable, file-name-safe run id for a test that has no Peeps run. */
export function localRunId(relPath: string, titlePath: string): string {
  return `local-${createHash("sha1").update(`${relPath}\n${titlePath}`).digest("hex").slice(0, 16)}`;
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

/** Who a worker is: WebdriverIO's cid (`<capability>-<n>`, kept by a specFileRetries retry), else its pid. */
function workerId(): string {
  return process.env.WDIO_WORKER_ID || `pid-${process.pid}`;
}

const fileSafe = (value: string) => value.replace(/[^A-Za-z0-9._-]/g, "_");

/**
 * Whether a worker may report a run: `new` (it claimed it: send `run_start`),
 * `continue` (its earlier attempt claimed it and left it open), `ended` (its
 * earlier attempt closed it) or `other` (another worker claimed it).
 */
export type RunClaim = { state: "new" | "continue" | "ended" } | { state: "other"; owner: string };

class Plan {
  readonly entries = new Map<string, PlanEntry>();
  constructor(
    readonly file: AppiumPlanFile,
    /** Beside the plan file: one owner file per run, shared by every worker. */
    readonly claimsDir: string | null = null,
  ) {
    for (const run of file.runs) {
      const key = identityKey(run);
      if (!this.entries.has(key)) this.entries.set(key, run);
    }
  }

  /**
   * Claim `runId` for `worker` by creating its owner file exclusively, so
   * exactly one worker reports each run however many capabilities run its
   * test; a later attempt of the same worker (a specFileRetries retry keeps
   * its cid) continues it. Without a usable claims directory, every worker
   * reports, as before.
   */
  claim(runId: string, worker: string): RunClaim {
    if (!this.claimsDir) return { state: "new" };
    const owner = path.join(this.claimsDir, `${fileSafe(runId)}.owner`);
    try {
      mkdirSync(this.claimsDir, { recursive: true });
      writeFileSync(owner, worker, { flag: "wx" });
      return { state: "new" };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
        console.log(`[peeps] could not claim ${runId}, reporting it anyway: ${String(error)}`);
        return { state: "new" };
      }
    }
    const holder = readFileSync(owner, "utf8");
    if (holder !== worker) return { state: "other", owner: holder };
    return { state: existsSync(path.join(this.claimsDir, `${fileSafe(runId)}.ended`)) ? "ended" : "continue" };
  }

  /** The run's `run_end` was sent: a later attempt of its worker must not reopen it. */
  markEnded(runId: string): void {
    if (!this.claimsDir) return;
    try {
      writeFileSync(path.join(this.claimsDir, `${fileSafe(runId)}.ended`), "");
    } catch {
      // A later attempt then sends a second close; Peeps keeps the first.
    }
  }

  /** This worker's attempt number, 1 for its first (a specFileRetries retry keeps the cid). */
  nextAttempt(worker: string): number {
    if (!this.claimsDir) return 1;
    const file = path.join(this.claimsDir, `attempts-${fileSafe(worker)}`);
    try {
      mkdirSync(this.claimsDir, { recursive: true });
      const attempt = (Number(existsSync(file) ? readFileSync(file, "utf8") : "0") || 0) + 1;
      writeFileSync(file, String(attempt));
      return attempt;
    } catch {
      return 1;
    }
  }

  /** The run a test reports to: its spec file (absolute) and title chain. */
  entryFor(file: string | undefined, titles: string[]): PlanEntry | null {
    if (!file) return null;
    const rel = repoRelative(this.file.workspace, file.startsWith("file://") ? fileURLToPath(file) : file);
    if (rel === null) return null;
    const titlePath = titles.join(TITLE_PATH_SEPARATOR);
    const key = identityKey({ path: rel, titlePath });
    const planned = this.entries.get(key);
    if (planned || !this.file.resultsDir) return planned ?? null;
    // Local results: every test is "planned" the moment it is seen.
    const entry: PlanEntry = {
      runId: localRunId(rel, titlePath),
      path: rel,
      titlePath,
      pwProject: "",
      credential: { exp: 0, sig: "" },
    };
    this.entries.set(key, entry);
    this.file.runs.push(entry);
    return entry;
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
  cachedPlan = new Plan(JSON.parse(readFileSync(planPath, "utf8")) as AppiumPlanFile, path.join(path.dirname(planPath), "claims"));
  return cachedPlan;
}

/**
 * The customer's `specFileRetries`, read by `withPeeps` when the worker
 * loads the wrapper config (before WebdriverIO builds its reporters).
 */
let specFileRetries = 0;

/** For tests: forget the plan, captured evidence and config this process holds. */
export function resetForTests(): void {
  cachedPlan = undefined;
  captured.clear();
  screens.clear();
  currentRunId = null;
  cachedDevice = undefined;
  specFileRetries = 0;
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

function removeFiles(files: string[]): void {
  for (const file of files) {
    try {
      unlinkSync(file);
    } catch {
      // Already gone.
    }
  }
}

function discardFailureEvidence(runId: string): void {
  removeFiles(captured.get(runId)?.files ?? []);
  captured.delete(runId);
}

/** Drop everything the attempt captured: its failure evidence and its named screens. */
function discardCaptured(runId: string): void {
  discardFailureEvidence(runId);
  removeFiles(screens.get(runId)?.files ?? []);
  screens.delete(runId);
}

function withTimeout<T>(promise: Promise<T>, label: string, ms = CAPTURE_TIMEOUT_MS): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  return Promise.race([
    promise,
    new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms} ms`)), ms);
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
  discardFailureEvidence(runId);
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
// Named screens: browser.peepsScreen(name), for visual diffs
// ---------------------------------------------------------------------------

/** Named screens kept per test; a call past it is listed as omitted, not captured. */
export const MAX_SCREENS_PER_TEST = 10;
/** A name is 1 to this many characters, after trimming. */
const MAX_SCREEN_NAME = 80;
const STABLE_FRAME_CAPTURES = 5;
const STABLE_FRAME_INTERVAL_MS = 300;
/** How long the status bar query may take before it counts as unknown. */
const DEVICE_QUERY_TIMEOUT_MS = 5_000;

/** The device a test's screens were taken on, as Peeps keys their baselines. */
export interface ScreenDevice {
  platform: "ios" | "android";
  deviceName: string;
  /**
   * When the session reports one (UiAutomator2's `deviceModel`): UiAutomator2
   * rewrites `deviceName` to the device serial, so Peeps keys on this first.
   */
  deviceModel?: string;
  platformVersion: string;
  /** The screenshot's own pixel size. */
  width: number;
  height: number;
  /** In screenshot pixels; 0 when unknown. */
  statusBarHeight: number;
}

interface Screens {
  attachments: Array<{ name: string; path: string; size: number }>;
  omitted: Array<{ name: string; reason: string }>;
  /** The staged files, absolute, so a retried attempt's can be removed. */
  files: string[];
  slugs: Set<string>;
  /** Captures started, so calls that were not awaited still respect the cap. */
  reserved: number;
  device: ScreenDevice | null;
}

/** Each run's named screens, this attempt only. */
const screens = new Map<string, Screens>();

/** The run of the test running now in this worker (set by the reporter), else null. */
let currentRunId: string | null = null;

/** The subset of a WebdriverIO browser `peepsScreen` calls. */
export interface ScreenBrowser {
  capabilities?: Record<string, unknown>;
  takeScreenshot(): Promise<string>;
  execute?(script: string, ...args: unknown[]): Promise<unknown>;
  getSystemBars?(): Promise<unknown>;
}

/** Width and height from a PNG's IHDR chunk; null when it is not a PNG. */
export function pngSize(bytes: Buffer): { width: number; height: number } | null {
  if (bytes.length < 24 || bytes.readUInt32BE(0) !== 0x89504e47 || bytes.toString("ascii", 12, 16) !== "IHDR") return null;
  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
}

/**
 * A screen's name in its file: lowercased, every run of characters outside
 * `[a-z0-9]` one `-`, no `-` at either end, at most 60 characters. A name
 * with nothing left (all non-Latin, say) is `screen`; its attachment keeps
 * the name as given.
 */
export function screenSlug(name: string): string {
  const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60).replace(/-+$/, "");
  return slug || "screen";
}

/**
 * Up to five captures `intervalMs` apart, until two in a row are
 * byte-identical (the screen has settled); else the last one.
 */
export async function stableFrame(take: () => Promise<Buffer>, intervalMs = STABLE_FRAME_INTERVAL_MS): Promise<Buffer> {
  let last = await take();
  for (let i = 1; i < STABLE_FRAME_CAPTURES; i++) {
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
    const next = await take();
    if (next.equals(last)) return next;
    last = next;
  }
  return last;
}

/** What a worker's device is, apart from each screenshot's size. */
export type DeviceFacts = Omit<ScreenDevice, "width" | "height">;

/** The worker's device facts, asked once per worker. */
let cachedDevice: Promise<DeviceFacts | null> | undefined;

/**
 * The device from the session's capabilities (Appium's `appium:` prefix or
 * not; `deviceModel` only when the session reports one), and the status bar's height in screenshot pixels: iOS from
 * `mobile: deviceScreenInfo` (points times its scale), else the session's
 * `statBarHeight` times its `pixelRatio`; Android from `getSystemBars()`.
 * Each query is bounded and best-effort: 0 when the driver does not say.
 * Null when the session is not an iOS or Android one.
 */
export async function deviceFacts(browser: ScreenBrowser, timeoutMs = DEVICE_QUERY_TIMEOUT_MS): Promise<DeviceFacts | null> {
  const caps = browser.capabilities ?? {};
  const cap = (key: string): unknown => caps[key] ?? caps[`appium:${key}`];
  const text = (key: string): string => {
    const value = cap(key);
    return typeof value === "string" || typeof value === "number" ? String(value) : "";
  };
  const platform = text("platformName").toLowerCase();
  if (platform !== "ios" && platform !== "android") return null;
  const positive = (value: unknown): number => (typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0);
  let statusBarHeight = 0;
  try {
    if (platform === "ios") {
      type ScreenInfo = { statusBarSize?: { height?: unknown }; scale?: unknown } | null;
      let info: ScreenInfo = null;
      try {
        if (typeof browser.execute === "function") {
          info = (await withTimeout(Promise.resolve(browser.execute("mobile: deviceScreenInfo")), "deviceScreenInfo", timeoutMs)) as ScreenInfo;
        }
      } catch {
        // Older XCUITest drivers: the session's own numbers below.
      }
      statusBarHeight =
        positive(info?.statusBarSize?.height) * (positive(info?.scale) || 1) ||
        positive(cap("statBarHeight")) * (positive(cap("pixelRatio")) || 1);
    } else if (typeof browser.getSystemBars === "function") {
      const bars = (await withTimeout(Promise.resolve(browser.getSystemBars()), "getSystemBars", timeoutMs)) as {
        statusBar?: { height?: unknown };
      } | null;
      statusBarHeight = positive(bars?.statusBar?.height);
    }
  } catch {
    // Unknown: 0.
  }
  const deviceModel = text("deviceModel");
  return {
    platform,
    deviceName: text("deviceName"),
    ...(deviceModel ? { deviceModel } : {}),
    platformVersion: text("platformVersion"),
    statusBarHeight: Math.round(statusBarHeight),
  };
}

/**
 * Save a settled screenshot of the screen as `name` for one run, into
 * `PEEPS_ARTIFACTS_DIR/upload`, as `<runId>-evidence-screen-<slug>.png` (a
 * slug already taken in this test gets `-2`, `-3`…). The test's first
 * screen also records the device. Never throws: a failure is logged and
 * listed as omitted.
 */
export async function captureScreen(
  runId: string,
  browser: ScreenBrowser,
  name: string,
  intervalMs = STABLE_FRAME_INTERVAL_MS,
): Promise<void> {
  const label = `screen:${name}`;
  const artifacts = process.env.PEEPS_ARTIFACTS_DIR;
  if (!artifacts) {
    console.log(`[peeps] peepsScreen(${JSON.stringify(name)}) not captured: PEEPS_ARTIFACTS_DIR is not set`);
    return;
  }
  const out = screens.get(runId) ?? { attachments: [], omitted: [], files: [], slugs: new Set<string>(), reserved: 0, device: null };
  screens.set(runId, out);
  if (out.reserved >= MAX_SCREENS_PER_TEST) {
    console.log(`[peeps] peepsScreen(${JSON.stringify(name)}) not captured: at most ${MAX_SCREENS_PER_TEST} screens per test`);
    out.omitted.push({ name: label, reason: "screen_limit" });
    return;
  }
  out.reserved += 1;
  try {
    const frame = await stableFrame(
      async () => Buffer.from(String(await withTimeout(Promise.resolve(browser.takeScreenshot()), "takeScreenshot")), "base64"),
      intervalMs,
    );
    const size = pngSize(frame);
    if (!size) throw new Error("the screenshot is not a PNG");
    if (frame.length > MAX_ATTACHMENT_BYTES) throw new Error(`larger than ${MAX_ATTACHMENT_BYTES} bytes`);
    const base = screenSlug(name);
    let slug = base;
    for (let n = 2; out.slugs.has(slug); n++) slug = `${base}-${n}`;
    out.slugs.add(slug);
    const dir = path.join(artifacts, "upload");
    mkdirSync(dir, { recursive: true });
    const file = path.join(dir, evidenceFileName(runId, `screen-${slug}.png`));
    writeFileSync(file, frame);
    out.files.push(file);
    out.attachments.push({ name: label, path: `data/${path.basename(file)}`, size: frame.length });
    if (!out.device) {
      cachedDevice ??= deviceFacts(browser);
      const facts = await cachedDevice;
      if (facts) {
        const { platform, deviceName, deviceModel, platformVersion, statusBarHeight } = facts;
        out.device = {
          platform,
          deviceName,
          ...(deviceModel ? { deviceModel } : {}),
          platformVersion,
          width: size.width,
          height: size.height,
          statusBarHeight,
        };
      }
    }
  } catch (error) {
    out.reserved -= 1;
    console.log(`[peeps] peepsScreen(${JSON.stringify(name)}) not captured: ${String(error).split("\n")[0]}`);
    out.omitted.push({ name: label, reason: reasonOf(error) });
  }
}

/**
 * `browser.peepsScreen(name)`: a named screen of the running test. Resolves,
 * never rejects, whatever happens: a bad name, no test running, or a failed
 * capture is a logged warning and the test carries on.
 */
async function peepsScreen(this: ScreenBrowser, name: unknown): Promise<void> {
  try {
    const trimmed = typeof name === "string" ? name.trim() : "";
    if (trimmed.length < 1 || trimmed.length > MAX_SCREEN_NAME) {
      console.log(`[peeps] peepsScreen: the name must be 1 to ${MAX_SCREEN_NAME} characters; got ${JSON.stringify(name)}`);
      return;
    }
    if (!currentRunId) {
      console.log(`[peeps] peepsScreen(${JSON.stringify(trimmed)}) not captured: no Peeps test is running`);
      return;
    }
    await captureScreen(currentRunId, this, trimmed);
  } catch (error) {
    console.log(`[peeps] peepsScreen not captured: ${String(error)}`);
  }
}

/**
 * WebdriverIO's `before(capabilities, specs, browser)`: registers
 * `peepsScreen` on the worker's browser. Never throws.
 */
export function peepsBefore(
  _capabilities: unknown,
  _specs: unknown,
  browser: { addCommand?: (name: string, fn: typeof peepsScreen) => unknown } | undefined,
): void {
  try {
    const host = browser ?? (globalThis as { browser?: typeof browser }).browser;
    if (typeof host?.addCommand !== "function") return;
    host.addCommand("peepsScreen", peepsScreen);
  } catch (error) {
    console.log(`[peeps] peepsScreen not registered: ${String(error)}`);
  }
}

/** Add a run's named screens, and the device they were taken on, to its final `test_end`. */
function attachScreens(event: PeepsEvent, runId: string): void {
  const shots = screens.get(runId);
  if (!shots) return;
  if (shots.attachments.length) event.attachments = [...(event.attachments ?? []), ...shots.attachments];
  if (shots.omitted.length) event.attachmentsOmitted = [...(event.attachmentsOmitted ?? []), ...shots.omitted];
  if (shots.device) event.properties = [...(event.properties ?? []), { name: "peeps_device", value: JSON.stringify(shots.device) }];
}

// ---------------------------------------------------------------------------
// Run mode: only planned tests execute
// ---------------------------------------------------------------------------

/** The mocha `this` of a hook, as far as `mochaHooks` reads it. */
interface MochaHookContext {
  currentTest?: MochaRunnableLike;
  skip(): void;
}

/**
 * A mocha root-hook plugin (mocha's `mochaHooks` export), loaded through
 * `mochaOpts.require` by the wrapper config in run mode only, so it merges
 * with any root hooks the customer's own `require` plugins export instead of
 * replacing them (`@wdio/mocha-framework` assigns the merged plugins onto
 * `mochaOpts`). Its `beforeEach` runs before any other `beforeEach` and
 * skips a test whose `(spec file, title path)` is not in the plan: mocha
 * then runs none of the remaining `beforeEach` hooks or the test body,
 * reports it pending (not a failure), and the reporter, finding no plan
 * entry, reports nothing for it. Inert unless the plan file says
 * `onlyPlanned` (run mode); report mode runs the whole suite.
 */
export const mochaHooks = {
  beforeEach(this: MochaHookContext): void {
    const plan = loadPlan();
    if (!plan || !plan.file.onlyPlanned || plan.file.resultsDir) return;
    const test = this.currentTest;
    const titles = titlesOf(test);
    if (!titles) return;
    if (!plan.entryFor(test?.file, titles)) this.skip();
  },
};

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
  /** Runs another worker reports, or an earlier attempt closed: nothing is sent for them. */
  private readonly suppressed = new Set<string>();
  private readonly worker = workerId();
  /**
   * Whether WebdriverIO can still retry this worker's spec file
   * (`specFileRetries`): it does whenever the file fails with retries left,
   * so a failure here is a retried attempt, and the retry, keeping this
   * worker's cid, continues the run.
   */
  private readonly retriable: boolean = false;
  private inflight = 0;
  private file: string | undefined;

  constructor(_options?: unknown) {
    this.plan = loadPlan();
    if (!this.plan) {
      console.log("[peeps] PEEPS_PLAN_FILE is not set; nothing is reported");
      return;
    }
    this.retriable = this.plan.nextAttempt(this.worker) <= specFileRetries;
  }

  /** WebdriverIO waits for this before the worker exits (`reporterSyncTimeout`). */
  get isSynchronised(): boolean {
    return this.inflight === 0;
  }

  emit(event: string, payload: WdioEventPayload = {}): void {
    if (!this.plan) return;
    switch (event) {
      case "runner:start":
        console.log(
          this.plan.file.resultsDir
            ? "[peeps] recording results for the agent session"
            : `[peeps] reporting ${this.plan.entries.size} planned run(s) to ${this.plan.file.peepsUrl}`,
        );
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

  /** Open an attempt of `entry`'s run; false when this worker does not report it. */
  private begin(entry: PlanEntry, testName: string): boolean {
    if (this.suppressed.has(entry.runId)) return false;
    const now = Date.now();
    if (!this.started.has(entry.runId)) {
      const claim = this.plan!.claim(entry.runId, this.worker);
      if (claim.state === "other" || claim.state === "ended") {
        this.suppressed.add(entry.runId);
        console.log(
          claim.state === "other"
            ? `[peeps] ${entry.titlePath}: reported by worker ${claim.owner}; this attempt (worker ${this.worker}) is not sent`
            : `[peeps] ${entry.titlePath}: closed by an earlier attempt of worker ${this.worker}; this one is not sent`,
        );
        return false;
      }
      this.started.add(entry.runId);
      if (claim.state === "new") this.enqueue(entry.runId, { type: "run_start", timestamp: now });
    }
    this.enqueue(entry.runId, { type: "test_start", timestamp: now, testName });
    this.attemptStart.set(entry.runId, now);
    return true;
  }

  private onTestStart(payload: WdioEventPayload): void {
    const entry = this.entryOf(payload);
    // What `peepsScreen` saves its screens for, until the test ends.
    currentRunId = entry && !this.ended.has(entry.runId) && this.begin(entry, payload.title ?? "") ? entry.runId : null;
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
    if (this.ended.has(entry.runId) || this.suppressed.has(entry.runId)) return;
    // `it.skip` is reported without ever starting.
    if (!this.attemptStart.has(entry.runId) && !this.begin(entry, payload.title ?? "")) return;
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
    if (status === "skipped") discardCaptured(entry.runId);
    else attachScreens(event, entry.runId);
    this.close(entry, event);
  }

  /** A failed attempt mocha retries: a failed `test_end`, without evidence. */
  private onTestRetry(payload: WdioEventPayload): void {
    const entry = this.entryOf(payload);
    if (!entry || this.ended.has(entry.runId) || this.suppressed.has(entry.runId)) return;
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
    if (currentRunId === entry.runId) currentRunId = null;
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
      if (!this.attemptStart.has(entry.runId) && !this.begin(entry, testName)) continue;
      const message = `${payload.title ?? "a before hook"} failed: ${error?.message ?? ""}`;
      const event: PeepsEvent = {
        type: "test_end",
        timestamp: Date.now(),
        testName,
        status: "failed",
        duration: 0,
        error: message.slice(0, 4000),
        ...(error?.stack ? { errorStack: error.stack.slice(0, 8000) } : {}),
        ...failureEvidence(error, "setup", captured.get(entry.runId)),
      };
      attachScreens(event, entry.runId);
      this.close(entry, event);
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
    this.ended.add(entry.runId);
    this.attemptStart.delete(entry.runId);
    if (currentRunId === entry.runId) currentRunId = null;
    if (event.status === "failed" && this.retriable) {
      // WebdriverIO will run this spec file again on this worker: like a
      // mocha retry, a failed attempt without evidence, the run left open.
      const { attachments: _a, attachmentsOmitted: _o, properties: _p, ...attempt } = event;
      this.enqueue(entry.runId, attempt);
      discardCaptured(entry.runId);
    } else {
      this.enqueue(entry.runId, event);
      this.enqueue(entry.runId, { type: "run_end", timestamp: Date.now() });
      this.plan!.markEnded(entry.runId);
    }
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
    const resultsDir = this.plan!.file.resultsDir;
    if (resultsDir) {
      // Synchronous, so nothing is in flight when the worker exits.
      const line: LocalResultsLine = { runId, path: entry.path, titlePath: entry.titlePath, events };
      try {
        mkdirSync(resultsDir, { recursive: true });
        appendFileSync(path.join(resultsDir, `events-${process.pid}.jsonl`), `${JSON.stringify(line)}\n`);
      } catch (error) {
        console.log(`[peeps] results for ${entry.titlePath} not written: ${String(error)}`);
      }
      return;
    }
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
  /**
   * Run mode: per capability, in the config's order, the planned spec files
   * among its own. A capability gets exactly these as its `wdio:specs`, and
   * one with none is left out of the run. Without it (agent mode's one
   * file), every capability runs `specs`.
   */
  capabilitySpecs?: string[][];
  /** Run mode: a mocha grep over each test's full title (a coarse pre-filter). */
  grep?: string;
  /**
   * Run mode: load this module as a mocha root-hook plugin, whose
   * `beforeEach` skips every test the plan does not name (`mochaHooks`).
   */
  onlyPlanned?: boolean;
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
 * replacing theirs. In run mode, the planned spec files (each capability
 * kept to the planned ones among its own `wdio:specs`, and left out when it
 * has none), a mocha grep, and the root hook that skips any test the plan
 * does not name.
 */
export function withPeeps(base: Record<string, unknown>, options: PeepsWdioOptions = {}): Record<string, unknown> {
  if (!base || typeof base !== "object") throw new Error("the WebdriverIO config must export a `config` object");
  specFileRetries = Math.max(0, Math.floor(Number(base.specFileRetries) || 0));
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
    before: [...hooksOf(base.before), peepsBefore],
    // Room for the last test's events to reach Peeps before the worker exits.
    reporterSyncTimeout: Math.max(Number(base.reporterSyncTimeout) || 5000, 60_000),
  };
  if (options.specs) {
    config.specs = options.specs;
    config.exclude = [];
    if (Array.isArray(base.capabilities)) {
      const caps = base.capabilities as Array<Record<string, unknown>>;
      const perCapability = options.capabilitySpecs?.length === caps.length ? options.capabilitySpecs : null;
      const narrowed: unknown[] = [];
      caps.forEach((cap, index) => {
        if (!cap || typeof cap !== "object") return void narrowed.push(cap);
        // Its own excludes were applied when its list was resolved; the config's are cleared above.
        const { "wdio:specs": _s, "wdio:exclude": _e, ...rest } = cap;
        if (!perCapability) return void narrowed.push(rest);
        if (perCapability[index]!.length > 0) narrowed.push({ ...rest, "wdio:specs": perCapability[index] });
      });
      config.capabilities = narrowed;
    }
  }
  if (options.grep !== undefined || options.onlyPlanned) {
    const mochaOpts = (base.mochaOpts && typeof base.mochaOpts === "object" ? base.mochaOpts : {}) as Record<string, unknown>;
    const next: Record<string, unknown> = { ...mochaOpts };
    if (options.grep !== undefined) Object.assign(next, { grep: options.grep, invert: false });
    if (options.onlyPlanned) {
      const theirs = Array.isArray(mochaOpts.require) ? mochaOpts.require : typeof mochaOpts.require === "string" ? [mochaOpts.require] : [];
      // This very file (dist/appium-reporter.js): its `mochaHooks` export.
      next.require = [...theirs, __filename];
    }
    config.mochaOpts = next;
  }
  return config;
}
