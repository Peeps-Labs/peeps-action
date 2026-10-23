/**
 * Device tools: the Appium counterpart of the browser tools a local runner
 * serves over the bridge (Peeps' docs/REPO_BACKED_PROJECTS.md, "Browser
 * tools over the bridge"). Offered in `agent` mode, for a `framework: appium`
 * suite, only when the job asks for them (`device-tools: true`).
 *
 * The runner half, end to end:
 *
 *   1. Capabilities. `dist/appium-collect.mjs --capabilities` reads the
 *      WebdriverIO config with WebdriverIO's own ConfigParser, in its own
 *      process with the job's environment (so `"appium:app":
 *      process.env.APP_PATH` resolves as it does under `wdio run`), and the
 *      first capability set is the session's (`sessionCapabilities`).
 *   2. Appium. The `appium` the working directory resolves (its
 *      `node_modules/.bin`, walking up, as `npx appium` would; else one on
 *      PATH) is started on a free loopback port, in its own process group,
 *      logging at `warn` (no request bodies, so no typed text) to
 *      `$RUNNER_TEMP/peeps-appium-<port>.log`.
 *   3. A WebDriver session with those capabilities, through the minimal
 *      fetch client below. Started in the background at attach, so the first
 *      device call does not pay for the app's install and launch.
 *   4. The `device_*` tools, each answering an MCP `CallToolResult` (text
 *      parts, plus an image part for a screenshot that fits), the shape a
 *      local runner answers browser calls in, so Peeps can relay them the
 *      same way.
 *   5. On session end, SIGTERM or error: the WebDriver session is deleted
 *      (at most 3 s) while Appium is still up, then Appium's process group
 *      stopped (SIGTERM, SIGKILL after 2 s): `close`, inside the ~7 s a
 *      cancelled GitHub job gets.
 *
 * Why a fetch client and not webdriverio: the action has no runtime
 * dependencies (SECURITY.md, "Supply chain"), and resolving the customer's
 * webdriverio would make these tools depend on its version and module
 * format, for the dozen W3C/Appium endpoints used here. The endpoints are
 * the stable ones every Appium 2 driver serves; app activation and logs go
 * through `mobile:` execute methods and the log endpoint.
 *
 * What these send to Peeps: the screen's page source (native hierarchy XML,
 * or a WebView's HTML), element texts, context names, device logs, and a
 * screenshot's pixels. Text is masked like every tool result (`redact`: the
 * job's secret-looking environment values) plus every value this session
 * typed into a secure field. Pixels cannot be masked.
 */

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { readAppiumCapabilities } from "./appium";
import { pageSourceExtension } from "./appium-reporter";
import type { RunnerEnv } from "./env";

export interface ToolSpecLike {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

/** An MCP `CallToolResult`, as a local runner answers a browser call. */
export interface CallToolResult {
  content: Array<{ type: "text"; text: string } | { type: "image"; data: string; mimeType: string }>;
  isError?: true;
}

export interface AppiumServer {
  /** `http://127.0.0.1:<port>`, base path `/`. */
  url: string;
  logFile: string;
  stop(): Promise<void>;
}

export interface DeviceToolsDeps {
  /** The WebdriverIO config's first capability set, as `wdio run` would read it. */
  readCapabilities(): Promise<Record<string, unknown> | null>;
  /** Start Appium; abort the signal to stop it while it is still starting. */
  startAppium(signal: AbortSignal): Promise<AppiumServer>;
}

export interface DeviceLimits {
  /** How long a call waits for the session to be ready before answering "still starting". */
  readyWaitMs: number;
  /** One tool call, start to finish (after the session is ready). */
  callMs: number;
  /** One WebDriver request. */
  requestMs: number;
  /** Creating the session: installs and launches the app. */
  sessionCreateMs: number;
  /** Deleting the session on close (Appium is stopped after it). */
  closeMs: number;
}

/**
 * Peeps gives up on a relayed browser call after 120 s
 * (`BRIDGE_BROWSER_CALL_TIMEOUT_MS`); a device call answers well inside
 * that: at most `readyWaitMs` waiting for the session plus `callMs`.
 */
export const DEFAULT_DEVICE_LIMITS: DeviceLimits = {
  readyWaitMs: 60_000,
  callMs: 50_000,
  requestMs: 30_000,
  sessionCreateMs: 6 * 60_000,
  // GitHub gives a cancelled job about 7 s between SIGINT and SIGTERM: the
  // delete (3 s) and Appium's stop (SIGTERM, SIGKILL after 2 s, 1 s more)
  // fit inside it.
  closeMs: 3_000,
};

/** On close, how long a startup still in flight gets to notice the abort. */
const CLOSE_STARTUP_WAIT_MS = 500;

/** Page source returned by default, and at most. */
export const PAGE_SOURCE_DEFAULT_CHARS = 60_000;
export const PAGE_SOURCE_MAX_CHARS = 150_000;
/** A screenshot is returned inline only up to this much base64 (~135 KB of PNG). */
export const SCREENSHOT_INLINE_BASE64 = 180_000;
/** Appium's default idle limit is 60 s; an agent thinks for longer than that between calls. */
export const SESSION_IDLE_SECONDS = 1800;

const ELEMENT_KEY = "element-6066-11e4-a52e-4f735466cecf";

/** Appium masks a request so marked as `**SECURE**` in every log line about it (Appium 2.x and later). */
const SENSITIVE = { "X-Appium-Is-Sensitive": "true" };

const W3C_CAPABILITIES = new Set([
  "browserName",
  "browserVersion",
  "platformName",
  "acceptInsecureCerts",
  "pageLoadStrategy",
  "proxy",
  "setWindowRect",
  "timeouts",
  "strictFileInteractability",
  "unhandledPromptBehavior",
  "webSocketUrl",
]);

export const DEVICE_STRATEGIES = [
  "accessibility id",
  "id",
  "xpath",
  "class name",
  "-android uiautomator",
  "-ios predicate string",
  "-ios class chain",
  "css selector",
] as const;

const DIRECTIONS = ["up", "down", "left", "right"] as const;
type Direction = (typeof DIRECTIONS)[number];

/**
 * The capabilities the session opens with: WebdriverIO's own keys
 * (`wdio:*`) dropped, a bare non-W3C key given Appium's vendor prefix (W3C
 * refuses unprefixed extensions), and an idle limit long enough for an agent.
 */
export function sessionCapabilities(raw: Record<string, unknown>): Record<string, unknown> {
  const caps: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(raw)) {
    if (key.startsWith("wdio:")) continue;
    caps[W3C_CAPABILITIES.has(key) || key.includes(":") ? key : `appium:${key}`] = value;
  }
  const idle = Number(caps["appium:newCommandTimeout"]);
  if (idle !== 0 && !(idle >= SESSION_IDLE_SECONDS)) caps["appium:newCommandTimeout"] = SESSION_IDLE_SECONDS;
  return caps;
}

/** Width and height from a PNG's IHDR chunk; null when it is not a PNG. */
export function pngSize(bytes: Buffer): { width: number; height: number } | null {
  if (bytes.length < 24 || bytes.readUInt32BE(0) !== 0x89504e47 || bytes.toString("ascii", 12, 16) !== "IHDR") return null;
  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
}

class DeviceError extends Error {
  constructor(
    message: string,
    readonly code: string | null = null,
  ) {
    super(message);
  }
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const duration = (ms: number) => (ms >= 1000 ? `${Math.round(ms / 1000)} s` : `${ms} ms`);

function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  return Promise.race([
    promise,
    new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new DeviceError(message)), ms);
    }),
  ]).finally(() => clearTimeout(timer));
}

/** One WebDriver request; a W3C error answer becomes a DeviceError with its code. */
async function webdriver(
  url: string,
  method: string,
  body: unknown,
  timeoutMs: number,
  headers: Record<string, string> = {},
): Promise<{ value: unknown; sessionId?: string }> {
  let response: Response;
  try {
    response = await fetch(url, {
      method,
      headers: body === undefined ? headers : { "Content-Type": "application/json; charset=utf-8", ...headers },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (error) {
    const name = (error as { name?: string }).name;
    if (name === "TimeoutError" || name === "AbortError") {
      throw new DeviceError(`Appium did not answer ${method} ${new URL(url).pathname} within ${duration(timeoutMs)}`);
    }
    throw new DeviceError(`could not reach Appium: ${(error as Error).message}`);
  }
  const text = await response.text();
  let json: { value?: unknown; sessionId?: string } | null = null;
  try {
    json = JSON.parse(text) as { value?: unknown; sessionId?: string };
  } catch {
    // Reported below.
  }
  const value = json?.value as { error?: unknown; message?: unknown } | undefined;
  if (!response.ok || (value && typeof value === "object" && typeof value.error === "string")) {
    const code = typeof value?.error === "string" ? value.error : `HTTP ${response.status}`;
    const message = String(value?.message ?? text).split("\n")[0]!.slice(0, 500);
    throw new DeviceError(`${code}: ${message}`, code);
  }
  return { value: json?.value ?? null, sessionId: json?.sessionId };
}

function elementIdOf(value: unknown): string | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  const id = record[ELEMENT_KEY] ?? record.ELEMENT;
  return typeof id === "string" ? id : null;
}

// ---------------------------------------------------------------------------
// Arguments
// ---------------------------------------------------------------------------

function stringArg(args: Record<string, unknown>, key: string, required: true): string;
function stringArg(args: Record<string, unknown>, key: string, required: false): string | null;
function stringArg(args: Record<string, unknown>, key: string, required: boolean): string | null {
  const value = args[key];
  if (typeof value === "string" && value.length > 0) return value;
  if (value === undefined && !required) return null;
  throw new DeviceError(`argument "${key}" must be a non-empty string`);
}

function numberArg(args: Record<string, unknown>, key: string, min: number, max: number, fallback: number | null): number | null {
  const value = args[key];
  if (value === undefined) return fallback;
  if (typeof value !== "number" || !Number.isFinite(value) || value < min || value > max) {
    throw new DeviceError(`argument "${key}" must be a number from ${min} to ${max}`);
  }
  return value;
}

function enumArg<T extends string>(args: Record<string, unknown>, key: string, allowed: readonly T[], fallback: T | null): T | null {
  const value = args[key];
  if (value === undefined && fallback !== null) return fallback;
  if (value === undefined) return null;
  if (typeof value !== "string" || !allowed.includes(value as T)) {
    throw new DeviceError(`argument "${key}" must be one of: ${allowed.join(", ")}`);
  }
  return value as T;
}

// ---------------------------------------------------------------------------
// The catalogue
// ---------------------------------------------------------------------------

function obj(properties: Record<string, unknown>, required: string[] = []): Record<string, unknown> {
  return { type: "object", properties, required, additionalProperties: false };
}
const str = (description: string) => ({ type: "string", description });
const strategy = { type: "string", enum: [...DEVICE_STRATEGIES], description: "Locator strategy. Prefer accessibility id; css selector only in a WEBVIEW context" };
const direction = (description: string) => ({ type: "string", enum: [...DIRECTIONS], description });

export const DEVICE_TOOL_SPECS: ToolSpecLike[] = [
  {
    name: "device_page_source",
    description: "The current screen's page source: the native view hierarchy as XML, or the page's HTML in a WEBVIEW context. Truncated to maxChars.",
    inputSchema: obj({ maxChars: { type: "integer", minimum: 1000, maximum: PAGE_SOURCE_MAX_CHARS, description: `Default ${PAGE_SOURCE_DEFAULT_CHARS}` } }),
  },
  {
    name: "device_screenshot",
    description: "A PNG screenshot of the device screen, returned as an image when it is small enough; always saved on the runner.",
    inputSchema: obj({}),
  },
  {
    name: "device_find",
    description: "Find elements on the current screen. Returns each element's id (for device_tap / device_type), text, rect and whether it is displayed.",
    inputSchema: obj({ strategy, selector: str("The selector for that strategy, e.g. `signIn` for accessibility id"), limit: { type: "integer", minimum: 1, maximum: 50, description: "Most elements described; default 10" } }, ["strategy", "selector"]),
  },
  {
    name: "device_tap",
    description: "Tap an element (elementId from device_find), or a point on the screen (x, y in screen pixels).",
    inputSchema: obj({ elementId: str("An element id from device_find"), x: { type: "number", minimum: 0 }, y: { type: "number", minimum: 0 } }),
  },
  {
    name: "device_type",
    description: "Type text into an element (elementId from device_find), optionally clearing it first. The text is never echoed; a value typed into a secure field is masked in later results.",
    inputSchema: obj({ elementId: str("An element id from device_find"), text: str("The text to type"), clear: { type: "boolean", description: "Clear the field first" } }, ["elementId", "text"]),
  },
  {
    name: "device_swipe",
    description: "Swipe a finger across the screen, or across one element, in a direction (the direction the finger moves).",
    inputSchema: obj({ direction: direction("The way the finger moves"), elementId: str("Swipe within this element instead of the whole screen"), distance: { type: "number", minimum: 0.1, maximum: 0.95, description: "Fraction of the area to travel; default 0.6" } }, ["direction"]),
  },
  {
    name: "device_scroll",
    description: "Scroll the screen to reveal content in a direction (down reveals what is below), optionally until an element is displayed.",
    inputSchema: obj({ direction: direction("The content to reveal: down scrolls toward the end"), strategy, selector: str("Stop when an element matching this is displayed"), maxSwipes: { type: "integer", minimum: 1, maximum: 10, description: "Default 5" } }, ["direction"]),
  },
  { name: "device_back", description: "Press the system back button (Android), or navigate back.", inputSchema: obj({}) },
  { name: "device_contexts", description: "The available contexts (NATIVE_APP, WEBVIEW_…) and the current one.", inputSchema: obj({}) },
  {
    name: "device_switch_context",
    description: "Switch to a context from device_contexts: a WEBVIEW_… one to use css selectors and read the page's HTML, NATIVE_APP to return.",
    inputSchema: obj({ name: str("The context name") }, ["name"]),
  },
  {
    name: "device_launch_app",
    description: "Bring an app to the foreground, launching it if needed. Defaults to the app under test (appium:appPackage / appium:bundleId).",
    inputSchema: obj({ appId: str("Android package or iOS bundle id; default the app under test") }),
  },
  {
    name: "device_terminate_app",
    description: "Stop an app. Defaults to the app under test (appium:appPackage / appium:bundleId).",
    inputSchema: obj({ appId: str("Android package or iOS bundle id; default the app under test") }),
  },
  {
    name: "device_logs",
    description: "The device log since the last read: logcat on Android, syslog on iOS, by default. The last maxLines entries.",
    inputSchema: obj({ type: str("Log type, e.g. logcat, syslog, crashlog, server"), maxLines: { type: "integer", minimum: 1, maximum: 1000, description: "Default 200" } }),
  },
];

export type DeviceToolHandler = (args: Record<string, unknown>) => Promise<CallToolResult>;

export interface DeviceToolHost {
  specs: ToolSpecLike[];
  handlers: Record<string, DeviceToolHandler>;
  /** Read the capabilities, start Appium and open the session, in the background. */
  start(): void;
  /** Delete the session and stop Appium. Idempotent; never throws. */
  close(reason: string): Promise<void>;
  /** What `runnerInfo.deviceTools` reports at attach. */
  info(): Record<string, unknown>;
}

function text(value: string): CallToolResult {
  return { content: [{ type: "text", text: value }] };
}

function failure(message: string): CallToolResult {
  return { content: [{ type: "text", text: message }], isError: true };
}

/**
 * The device tool host for one agent session.
 * @param options.redact - the tool server's redactor (the job's secret-looking environment values).
 */
export function createDeviceTools(
  env: RunnerEnv,
  options: { redact?: (text: string) => string; deps?: Partial<DeviceToolsDeps>; limits?: Partial<DeviceLimits> } = {},
): DeviceToolHost {
  const limits = { ...DEFAULT_DEVICE_LIMITS, ...options.limits };
  const redact = options.redact ?? ((t: string) => t);
  const deps: DeviceToolsDeps = {
    readCapabilities: options.deps?.readCapabilities ?? (() => defaultReadCapabilities(env)),
    startAppium: options.deps?.startAppium ?? ((signal) => startAppiumServer(env, signal)),
  };

  let ready: Promise<void> | null = null;
  let startError: Error | null = null;
  let appium: AppiumServer | null = null;
  let sessionId: string | null = null;
  let caps: Record<string, unknown> = {};
  let closing: Promise<void> | null = null;
  /** Set first on close: new calls are refused while the session is deleted. */
  let ended = false;
  const stopping = new AbortController();
  /** Values typed into secure fields this session: masked in every later result. */
  const typedSecrets = new Set<string>();
  let screenshots = 0;

  const mask = (value: string) => {
    let out = redact(value);
    for (const secret of [...typedSecrets].sort((a, b) => b.length - a.length)) out = out.split(secret).join("[redacted]");
    return out;
  };
  const platform = () => String(caps.platformName ?? "").toLowerCase();

  async function startup(): Promise<void> {
    const raw = await deps.readCapabilities();
    if (!raw) throw new DeviceError("the WebdriverIO config names no capabilities to open a device session with");
    caps = sessionCapabilities(raw);
    if (stopping.signal.aborted) return;
    appium = await deps.startAppium(stopping.signal);
    if (stopping.signal.aborted) {
      // Closed while Appium was starting: `close` may already have returned.
      await appium.stop();
      return;
    }
    const created = await webdriver(
      `${appium.url}/session`,
      "POST",
      { capabilities: { alwaysMatch: caps, firstMatch: [{}] } },
      limits.sessionCreateMs,
    );
    const value = created.value as { sessionId?: string } | null;
    sessionId = value?.sessionId ?? created.sessionId ?? null;
    if (!sessionId) throw new DeviceError("Appium answered the new session without a session id");
    console.log(
      `[peeps] device session ${sessionId} open (${String(caps.platformName ?? "?")}, ${String(caps["appium:automationName"] ?? "?")}); Appium log: ${appium.logFile}`,
    );
  }

  function start(): void {
    if (ready) return;
    console.log("[peeps] device tools: reading capabilities, starting Appium and a device session");
    ready = startup().catch(async (error: unknown) => {
      startError = error instanceof Error ? error : new Error(String(error));
      // Appium's output can carry what the job's environment put in the capabilities.
      if (!stopping.signal.aborted) console.log(`[peeps] device session could not start: ${mask(startError.message).slice(0, 2000)}`);
      await appium?.stop().catch(() => undefined);
    });
  }

  /** The live session, waiting for it to be ready (within `readyWaitMs`). */
  async function session(): Promise<{ url: string }> {
    if (ended || stopping.signal.aborted) throw new DeviceError("the device session has ended");
    if (!ready) start();
    await withTimeout(
      ready!,
      limits.readyWaitMs,
      "the device session is still starting (Appium and the app launch can take a few minutes); call again shortly",
    );
    if (startError) throw new DeviceError(`the device session could not start: ${startError.message.slice(0, 1500)}`);
    if (ended || stopping.signal.aborted || !appium || !sessionId) throw new DeviceError("the device session has ended");
    return { url: `${appium.url}/session/${sessionId}` };
  }

  async function wd(method: string, route: string, body?: unknown, timeoutMs = limits.requestMs, headers?: Record<string, string>): Promise<unknown> {
    const { url } = await session();
    return (await webdriver(`${url}${route}`, method, body, timeoutMs, headers)).value;
  }

  async function currentContext(): Promise<string | null> {
    const value = await wd("GET", "/context").catch(() => null);
    return typeof value === "string" ? value : null;
  }

  async function findElements(using: string, value: string): Promise<string[]> {
    const found = await wd("POST", "/elements", { using, value });
    return (Array.isArray(found) ? found : []).map(elementIdOf).filter((id): id is string => id !== null);
  }

  async function describe(id: string) {
    const quick = Math.min(limits.requestMs, 10_000);
    const [elementText, rect, displayed] = await Promise.all([
      wd("GET", `/element/${encodeURIComponent(id)}/text`, undefined, quick).catch(() => null),
      wd("GET", `/element/${encodeURIComponent(id)}/rect`, undefined, quick).catch(() => null),
      wd("GET", `/element/${encodeURIComponent(id)}/displayed`, undefined, quick).catch(() => null),
    ]);
    return {
      elementId: id,
      text: typeof elementText === "string" ? mask(elementText).slice(0, 500) : null,
      rect: rect && typeof rect === "object" ? rect : null,
      displayed: typeof displayed === "boolean" ? displayed : null,
    };
  }

  async function performTouch(points: Array<{ x: number; y: number }>, moveMs: number): Promise<void> {
    const [first, ...rest] = points;
    const actions: Array<Record<string, unknown>> = [
      { type: "pointerMove", duration: 0, x: Math.round(first!.x), y: Math.round(first!.y), origin: "viewport" },
      { type: "pointerDown", button: 0 },
      { type: "pause", duration: 100 },
      ...rest.map((p) => ({ type: "pointerMove", duration: moveMs, x: Math.round(p.x), y: Math.round(p.y), origin: "viewport" })),
      { type: "pointerUp", button: 0 },
    ];
    await wd("POST", "/actions", {
      actions: [{ type: "pointer", id: "finger1", parameters: { pointerType: "touch" }, actions }],
    });
    await wd("DELETE", "/actions").catch(() => undefined);
  }

  async function areaOf(elementId: string | null): Promise<{ x: number; y: number; width: number; height: number }> {
    const rect = (await wd("GET", elementId ? `/element/${encodeURIComponent(elementId)}/rect` : "/window/rect")) as Record<string, unknown> | null;
    const n = (key: string) => (typeof rect?.[key] === "number" ? (rect[key] as number) : 0);
    if (!(n("width") > 0 && n("height") > 0)) throw new DeviceError("could not read the size of the area to swipe");
    return { x: n("x"), y: n("y"), width: n("width"), height: n("height") };
  }

  async function swipe(area: { x: number; y: number; width: number; height: number }, finger: Direction, distance: number) {
    const cx = area.x + area.width / 2;
    const cy = area.y + area.height / 2;
    const dx = (area.width * distance) / 2;
    const dy = (area.height * distance) / 2;
    const from = { up: { x: cx, y: cy + dy }, down: { x: cx, y: cy - dy }, left: { x: cx + dx, y: cy }, right: { x: cx - dx, y: cy } }[finger];
    const to = { up: { x: cx, y: cy - dy }, down: { x: cx, y: cy + dy }, left: { x: cx - dx, y: cy }, right: { x: cx + dx, y: cy } }[finger];
    await performTouch([from, to], 500);
    return { from: { x: Math.round(from.x), y: Math.round(from.y) }, to: { x: Math.round(to.x), y: Math.round(to.y) } };
  }

  function appIdFor(args: Record<string, unknown>): { key: "appId" | "bundleId"; id: string } {
    const ios = platform() === "ios";
    const id = stringArg(args, "appId", false) ?? String(caps[ios ? "appium:bundleId" : "appium:appPackage"] ?? "");
    if (!id) {
      throw new DeviceError(
        `pass appId: the capabilities name no ${ios ? "appium:bundleId" : "appium:appPackage"} for the app under test`,
      );
    }
    return { key: ios ? "bundleId" : "appId", id };
  }

  async function readLogs(type: string): Promise<unknown> {
    try {
      return await wd("POST", "/se/log", { type });
    } catch (error) {
      const code = (error as DeviceError).code ?? "";
      if (!/unknown (command|method)|HTTP 404/.test(code)) throw error;
      return wd("POST", "/log", { type });
    }
  }

  const tools: Record<string, (args: Record<string, unknown>) => Promise<CallToolResult>> = {
    async device_page_source(args) {
      const maxChars = numberArg(args, "maxChars", 1000, PAGE_SOURCE_MAX_CHARS, PAGE_SOURCE_DEFAULT_CHARS)!;
      const [source, context] = await Promise.all([wd("GET", "/source"), currentContext()]);
      const masked = mask(String(source ?? ""));
      const kind = pageSourceExtension(masked, context);
      const cut = masked.length > maxChars;
      return text(
        `Page source (${kind}, context ${context ?? "unknown"}, ${masked.length} characters${cut ? `; the first ${maxChars} follow` : ""}):\n${masked.slice(0, maxChars)}`,
      );
    },

    async device_screenshot() {
      const data = String((await wd("GET", "/screenshot")) ?? "");
      const bytes = Buffer.from(data, "base64");
      const size = pngSize(bytes);
      const dir = path.join(process.env.RUNNER_TEMP ?? tmpdir(), "peeps-device");
      await mkdir(dir, { recursive: true });
      screenshots += 1;
      const file = path.join(dir, `screenshot-${screenshots}.png`);
      await writeFile(file, bytes);
      const inline = data.length <= SCREENSHOT_INLINE_BASE64;
      const info = {
        width: size?.width ?? null,
        height: size?.height ?? null,
        bytes: bytes.length,
        savedOnRunner: file,
        returned: inline,
        ...(inline ? {} : { note: `larger than ${SCREENSHOT_INLINE_BASE64} base64 characters, so not returned; read the screen with device_page_source` }),
      };
      const parts: CallToolResult["content"] = [{ type: "text", text: JSON.stringify(info) }];
      if (inline) parts.unshift({ type: "image", data, mimeType: "image/png" });
      return { content: parts };
    },

    async device_find(args) {
      const using = enumArg(args, "strategy", DEVICE_STRATEGIES, null)!;
      if (!using) throw new DeviceError('argument "strategy" is required');
      const selector = stringArg(args, "selector", true);
      const limit = numberArg(args, "limit", 1, 50, 10)!;
      const ids = await findElements(using, selector);
      const elements = await Promise.all(ids.slice(0, limit).map(describe));
      return text(JSON.stringify({ strategy: using, selector: mask(selector), count: ids.length, truncated: ids.length > limit, elements }));
    },

    async device_tap(args) {
      const elementId = stringArg(args, "elementId", false);
      if (elementId) {
        await wd("POST", `/element/${encodeURIComponent(elementId)}/click`, {});
        return text(`Tapped element ${elementId}.`);
      }
      const x = numberArg(args, "x", 0, 100_000, null);
      const y = numberArg(args, "y", 0, 100_000, null);
      if (x === null || y === null) throw new DeviceError("pass elementId, or both x and y");
      await performTouch([{ x, y }], 0);
      return text(`Tapped at (${Math.round(x)}, ${Math.round(y)}).`);
    },

    async device_type(args) {
      const elementId = stringArg(args, "elementId", true);
      const value = args.text;
      if (typeof value !== "string") throw new DeviceError('argument "text" must be a string');
      if (value.length > 10_000) throw new DeviceError('argument "text" is longer than 10000 characters');
      const element = `/element/${encodeURIComponent(elementId)}`;
      const quick = Math.min(limits.requestMs, 10_000);
      const [password, type] = await Promise.all([
        wd("GET", `${element}/attribute/password`, undefined, quick).catch(() => null),
        wd("GET", `${element}/attribute/type`, undefined, quick).catch(() => null),
      ]);
      const secure = String(password) === "true" || /SecureTextField|^password$/i.test(String(type ?? ""));
      // Too short a value would mask ordinary text everywhere.
      if (secure && value.length >= 3) typedSecrets.add(value);
      if (args.clear === true) await wd("POST", `${element}/clear`, {});
      // Marked sensitive: an Appium that logs request bodies (it does at
      // info; this one runs at warn) writes **SECURE** in place of the text.
      await wd("POST", `${element}/value`, { text: value, value: Array.from(value) }, limits.requestMs, SENSITIVE);
      return text(
        `Typed ${Array.from(value).length} characters into element ${elementId}${secure ? " (a secure field: the value is masked in later results)" : ""}.`,
      );
    },

    async device_swipe(args) {
      const finger = enumArg(args, "direction", DIRECTIONS, null);
      if (!finger) throw new DeviceError('argument "direction" is required');
      const distance = numberArg(args, "distance", 0.1, 0.95, 0.6)!;
      const elementId = stringArg(args, "elementId", false);
      const moved = await swipe(await areaOf(elementId), finger, distance);
      return text(`Swiped ${finger} ${elementId ? `within element ${elementId}` : "across the screen"}, from (${moved.from.x}, ${moved.from.y}) to (${moved.to.x}, ${moved.to.y}).`);
    },

    async device_scroll(args) {
      const reveal = enumArg(args, "direction", DIRECTIONS, null);
      if (!reveal) throw new DeviceError('argument "direction" is required');
      const using = enumArg(args, "strategy", DEVICE_STRATEGIES, null);
      const selector = stringArg(args, "selector", false);
      if ((using === null) !== (selector === null)) throw new DeviceError("pass strategy and selector together, or neither");
      const maxSwipes = numberArg(args, "maxSwipes", 1, 10, 5)!;
      const finger = ({ down: "up", up: "down", right: "left", left: "right" } as const)[reveal];
      const visible = async () => {
        if (!using || !selector) return [];
        const shown = [];
        for (const id of (await findElements(using, selector)).slice(0, 10)) {
          const element = await describe(id);
          if (element.displayed !== false) shown.push(element);
        }
        return shown;
      };
      const area = await areaOf(null);
      for (let swipes = 0; ; swipes++) {
        const shown = await visible();
        if (shown.length > 0) return text(JSON.stringify({ found: true, swipes, elements: shown }));
        if (swipes >= maxSwipes) break;
        await swipe(area, finger, 0.5);
      }
      return text(JSON.stringify(using ? { found: false, swipes: maxSwipes } : { scrolled: reveal, swipes: maxSwipes }));
    },

    async device_back() {
      await wd("POST", "/back", {});
      return text("Pressed back.");
    },

    async device_contexts() {
      const [contexts, current] = await Promise.all([wd("GET", "/contexts"), currentContext()]);
      const names = (Array.isArray(contexts) ? contexts : []).map((c) => (typeof c === "string" ? c : String((c as { id?: unknown })?.id ?? c)));
      return text(JSON.stringify({ current, contexts: names }));
    },

    async device_switch_context(args) {
      const name = stringArg(args, "name", true);
      await wd("POST", "/context", { name });
      return text(`Switched to context ${name}.`);
    },

    async device_launch_app(args) {
      const { key, id } = appIdFor(args);
      await wd("POST", "/execute/sync", { script: "mobile: activateApp", args: [{ [key]: id }] });
      return text(`Brought ${id} to the foreground.`);
    },

    async device_terminate_app(args) {
      const { key, id } = appIdFor(args);
      const stopped = await wd("POST", "/execute/sync", { script: "mobile: terminateApp", args: [{ [key]: id }] });
      return text(stopped === false ? `${id} was not running.` : `Stopped ${id}.`);
    },

    async device_logs(args) {
      const type = stringArg(args, "type", false) ?? (platform() === "ios" ? "syslog" : "logcat");
      const maxLines = numberArg(args, "maxLines", 1, 1000, 200)!;
      const entries = await readLogs(type);
      const list = Array.isArray(entries) ? (entries as Array<{ timestamp?: unknown; level?: unknown; message?: unknown }>) : [];
      const lines = list.slice(-maxLines).map((entry) => {
        const at = typeof entry.timestamp === "number" ? new Date(entry.timestamp).toISOString() : "";
        return `${at} ${String(entry.level ?? "")} ${mask(String(entry.message ?? "")).slice(0, 500)}`.trim();
      });
      return text(`${type}: ${list.length} entr${list.length === 1 ? "y" : "ies"} since the last read${list.length > maxLines ? `, the last ${maxLines} follow` : ""}:\n${lines.join("\n")}`);
    },
  };

  const handlers: Record<string, DeviceToolHandler> = {};
  for (const [name, tool] of Object.entries(tools)) {
    handlers[name] = async (args) => {
      try {
        await session();
        return await withTimeout(tool(args ?? {}), limits.callMs, `${name} did not finish within ${duration(limits.callMs)}`);
      } catch (error) {
        return failure(mask(error instanceof Error ? error.message : String(error)));
      }
    };
  }

  async function close(reason: string): Promise<void> {
    if (closing) return closing;
    closing = (async () => {
      ended = true;
      // The session first, while Appium is still up to end it (and the app
      // and driver with it); only then stop Appium.
      const live = appium && sessionId ? `${appium.url}/session/${sessionId}` : null;
      if (live) {
        await webdriver(live, "DELETE", undefined, limits.closeMs).catch((error: unknown) => {
          console.log(`[peeps] could not delete the device session: ${mask(String(error)).slice(0, 200)}`);
        });
      }
      stopping.abort();
      // A startup still in flight notices the abort and stops what it started.
      if (ready) await withTimeout(ready, CLOSE_STARTUP_WAIT_MS, "startup did not stop").catch(() => undefined);
      await (appium as AppiumServer | null)?.stop().catch(() => undefined);
      if (ready) console.log(`[peeps] device session closed (${reason})`);
    })();
    return closing;
  }

  return {
    specs: DEVICE_TOOL_SPECS,
    handlers,
    start,
    close,
    info: () => ({ tools: DEVICE_TOOL_SPECS.map((t) => t.name) }),
  };
}

// ---------------------------------------------------------------------------
// Production dependencies
// ---------------------------------------------------------------------------

async function defaultReadCapabilities(env: RunnerEnv): Promise<Record<string, unknown> | null> {
  return (await readAppiumCapabilities(env)).capabilities;
}

/**
 * The `appium` the working directory resolves, as `npx appium` would find a
 * local install: `node_modules/.bin/appium` in it or a directory above it;
 * else an `appium` on PATH (a global install). Null when there is neither.
 */
export function resolveAppiumBinary(from: string, pathEnv = process.env.PATH ?? ""): string | null {
  for (let dir = path.resolve(from); ; dir = path.dirname(dir)) {
    const candidate = path.join(dir, "node_modules", ".bin", "appium");
    if (existsSync(candidate)) return candidate;
    if (path.dirname(dir) === dir) break;
  }
  for (const dir of pathEnv.split(path.delimiter)) {
    if (!dir) continue;
    const candidate = path.join(dir, "appium");
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

/** A loopback port nothing listens on right now. */
export function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      server.close(() => resolve(port));
    });
  });
}

/** How long Appium may take to answer `/status` after it is started. */
const APPIUM_START_MS = 120_000;

/**
 * Start Appium from the working directory on a free loopback port, in its
 * own process group (so stopping it also stops the drivers it spawned),
 * logging warnings and errors only (no request bodies) to
 * `$RUNNER_TEMP/peeps-appium-<port>.log`, and wait for `/status`.
 */
export async function startAppiumServer(env: RunnerEnv, signal: AbortSignal, startMs = APPIUM_START_MS): Promise<AppiumServer> {
  const bin = resolveAppiumBinary(env.workingDirectory);
  if (!bin) {
    throw new Error(
      "Appium is not installed where the job runs: add it to the working directory (npm i -D appium) and install your driver (npx appium driver install uiautomator2, or xcuitest) before the action runs",
    );
  }
  const port = await freePort();
  const logFile = path.join(process.env.RUNNER_TEMP ?? tmpdir(), `peeps-appium-${port}.log`);
  const child = spawn(
    bin,
    // `warn`: at its default (debug) and at info Appium logs every request
    // body, so the text device_type types would land in this file.
    [
      "--address", "127.0.0.1", "--port", String(port), "--base-path", "/",
      "--log", logFile, "--log-level", "warn", "--log-no-colors", "--log-timestamp",
    ],
    { cwd: env.workingDirectory, env: process.env, stdio: ["ignore", "pipe", "pipe"], detached: true },
  );
  let output = "";
  const keep = (chunk: Buffer) => {
    output = (output + chunk.toString("utf8")).slice(-4000);
  };
  child.stdout?.on("data", keep);
  child.stderr?.on("data", keep);
  let exited: string | null = null;
  const exitedPromise = new Promise<void>((resolve) => {
    child.on("exit", (code, sig) => {
      exited = String(code ?? sig);
      resolve();
    });
    child.on("error", (error) => {
      exited = error.message;
      resolve();
    });
  });
  const kill = (sig: NodeJS.Signals) => {
    try {
      process.kill(-child.pid!, sig);
    } catch {
      try {
        child.kill(sig);
      } catch {
        // Already gone.
      }
    }
  };
  let stopped: Promise<void> | null = null;
  const stop = () => {
    stopped ??= (async () => {
      if (exited !== null) return;
      kill("SIGTERM");
      await Promise.race([exitedPromise, sleep(2000)]);
      if (exited === null) {
        kill("SIGKILL");
        await Promise.race([exitedPromise, sleep(1000)]);
      }
    })();
    return stopped;
  };
  signal.addEventListener("abort", () => void stop(), { once: true });

  const url = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + startMs;
  for (;;) {
    if (signal.aborted) {
      await stop();
      throw new Error("stopped while Appium was starting");
    }
    if (exited !== null) throw new Error(`Appium exited before it was ready (${exited}):\n${output.slice(-2000)}`);
    try {
      const response = await fetch(`${url}/status`, { signal: AbortSignal.timeout(2000) });
      if (response.ok) break;
    } catch {
      // Not listening yet.
    }
    if (Date.now() > deadline) {
      await stop();
      throw new Error(`Appium did not answer on port ${port} within ${Math.round(startMs / 1000)} s:\n${output.slice(-2000)}`);
    }
    await sleep(500);
  }
  console.log(`[peeps] Appium ${bin} listening on ${url}; log ${logFile}`);
  return { url, logFile, stop };
}
