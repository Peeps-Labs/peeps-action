/**
 * The device tools an `agent`-mode job offers for an Appium suite, against a
 * fake Appium (test/support/fake-webdriver.ts).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { runAgent, summarizeArgs } from "../src/agent";
import { readAppiumCapabilities } from "../src/appium";
import { firstCapabilities } from "../src/appium-collect";
import {
  createDeviceTools,
  DEVICE_TOOL_SPECS,
  pngSize,
  resolveAppiumBinary,
  SCREENSHOT_INLINE_BASE64,
  sessionCapabilities,
  startAppiumServer,
  type AppiumServer,
  type CallToolResult,
  type DeviceLimits,
  type DeviceToolHost,
} from "../src/device-tools";
import { readRunnerEnv } from "../src/env";
import { PeepsClient } from "../src/peeps";
import { makeRedactor } from "../src/tools";
import { fakePng, startFakeWebDriver, type FakeWebDriver } from "./support/fake-webdriver";

const FIXTURE = path.join(__dirname, "fixtures", "appium");
const MODULES = path.join(__dirname, "..", "node_modules");
const FAKE_APPIUM = path.join(__dirname, "support", "fake-webdriver.ts");
const TSX = path.join(MODULES, "tsx", "dist", "loader.mjs");

const CAPS = {
  platformName: "Android",
  "appium:automationName": "UiAutomator2",
  "appium:app": "/apps/shop.apk",
  "appium:appPackage": "com.example.shop",
};

function env(root = mkdtempSync(path.join(tmpdir(), "peeps-device-")), extra: Record<string, string> = {}) {
  return readRunnerEnv({ GITHUB_WORKSPACE: root, INPUT_FRAMEWORK: "appium", ...extra });
}

/** A host on an in-process fake Appium; `stopped` counts Appium stops. */
async function hostOnFake(
  over: { caps?: Record<string, unknown> | null; redact?: (t: string) => string; limits?: Partial<DeviceLimits> } = {},
): Promise<{ host: DeviceToolHost; fake: FakeWebDriver; stopped: () => number; call: (tool: string, args?: Record<string, unknown>) => Promise<CallToolResult> }> {
  const fake = await startFakeWebDriver();
  let stops = 0;
  const host = createDeviceTools(env(), {
    redact: over.redact,
    limits: over.limits,
    deps: {
      readCapabilities: async () => (over.caps === undefined ? CAPS : over.caps),
      startAppium: async (): Promise<AppiumServer> => ({ url: fake.url, logFile: "/tmp/appium.log", stop: async () => void (stops += 1) }),
    },
  });
  host.start();
  return { host, fake, stopped: () => stops, call: (tool, args = {}) => host.handlers[tool]!(args) };
}

const textOf = (result: CallToolResult) =>
  result.content.filter((p): p is { type: "text"; text: string } => p.type === "text").map((p) => p.text).join("\n");
const json = (result: CallToolResult) => JSON.parse(textOf(result)) as Record<string, unknown>;

// ---------------------------------------------------------------------------
// Capabilities
// ---------------------------------------------------------------------------

test("the session's capabilities: wdio keys dropped, bare extensions prefixed, an idle limit an agent can live with", () => {
  assert.deepEqual(
    sessionCapabilities({
      platformName: "Android",
      "appium:automationName": "UiAutomator2",
      deviceName: "emulator-5554",
      "wdio:maxInstances": 1,
      "wdio:specs": ["./a.spec.ts"],
      "appium:newCommandTimeout": 60,
    }),
    {
      platformName: "Android",
      "appium:automationName": "UiAutomator2",
      "appium:deviceName": "emulator-5554",
      "appium:newCommandTimeout": 1800,
    },
  );
  // A longer limit, or none at all (0), is the customer's and stays.
  assert.equal(sessionCapabilities({ "appium:newCommandTimeout": 3600 })["appium:newCommandTimeout"], 3600);
  assert.equal(sessionCapabilities({ "appium:newCommandTimeout": 0 })["appium:newCommandTimeout"], 0);
});

test("the first capability set: the usual array, or a multiremote config's first instance", () => {
  assert.deepEqual(firstCapabilities([{ platformName: "iOS" }, { platformName: "Android" }]), { platformName: "iOS" });
  assert.deepEqual(firstCapabilities({ phone: { capabilities: { platformName: "Android" } } }), { platformName: "Android" });
  assert.deepEqual(firstCapabilities([{ phone: { capabilities: { "appium:udid": "x" } } }]), { "appium:udid": "x" });
  assert.equal(firstCapabilities([]), null);
  assert.equal(firstCapabilities(undefined), null);
});

test("the capabilities are read from the WebdriverIO config, with the job's environment resolving appium:app", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "peeps-caps-"));
  const suite = path.join(root, "mobile");
  cpSync(FIXTURE, suite, { recursive: true });
  symlinkSync(MODULES, path.join(root, "node_modules"), "dir");
  writeFileSync(
    path.join(suite, "wdio.conf.ts"),
    readFileSync(path.join(FIXTURE, "wdio.conf.ts"), "utf8").replace('"./apps/sample.apk"', 'process.env.PEEPS_TEST_APP ?? "./apps/sample.apk"'),
  );
  process.env.PEEPS_TEST_APP = "/builds/app-debug.apk";
  try {
    const read = await readAppiumCapabilities(env(root, { "INPUT_WORKING-DIRECTORY": "mobile" }));
    assert.deepEqual(read.capabilities, {
      platformName: "Android",
      "appium:automationName": "UiAutomator2",
      "appium:deviceName": "emulator-5554",
      "appium:app": "/builds/app-debug.apk",
    });
    assert.equal(read.rootDir, suite);
  } finally {
    delete process.env.PEEPS_TEST_APP;
  }
});

// ---------------------------------------------------------------------------
// The tools
// ---------------------------------------------------------------------------

test("the catalogue: thirteen device_* tools with closed object schemas", () => {
  assert.deepEqual(DEVICE_TOOL_SPECS.map((t) => t.name), [
    "device_page_source",
    "device_screenshot",
    "device_find",
    "device_tap",
    "device_type",
    "device_swipe",
    "device_scroll",
    "device_back",
    "device_contexts",
    "device_switch_context",
    "device_launch_app",
    "device_terminate_app",
    "device_logs",
  ]);
  for (const spec of DEVICE_TOOL_SPECS) {
    assert.match(spec.name, /^[a-z][a-z0-9_]{0,63}$/);
    assert.equal(spec.inputSchema.additionalProperties, false, spec.name);
    assert.ok(spec.description.length <= 2000);
  }
});

test("a device session opens with the config's capabilities, and the tools read and drive the screen", async () => {
  const { host, fake, call, stopped } = await hostOnFake();
  try {
    const source = await call("device_page_source");
    assert.equal(source.isError, undefined);
    assert.match(textOf(source), /^Page source \(xml, context NATIVE_APP, \d+ characters\):\n<\?xml/);
    const created = fake.requests.find((r) => r.method === "POST" && r.path === "/session")!;
    assert.deepEqual(created.body, { capabilities: { alwaysMatch: { ...CAPS, "appium:newCommandTimeout": 1800 }, firstMatch: [{}] } });

    const found = json(await call("device_find", { strategy: "xpath", selector: "//*", limit: 2 }));
    assert.equal(found.count, 3);
    assert.equal(found.truncated, true);
    assert.deepEqual((found.elements as unknown[])[0], {
      elementId: "e-user",
      text: "",
      rect: { x: 40, y: 400, width: 1000, height: 120 },
      displayed: true,
    });

    assert.equal(textOf(await call("device_tap", { elementId: "e-signin" })), "Tapped element e-signin.");
    assert.equal(textOf(await call("device_tap", { x: 540.4, y: 1200 })), "Tapped at (540, 1200).");
    const tap = fake.requests.filter((r) => r.path.endsWith("/actions") && r.method === "POST").at(-1)!;
    assert.deepEqual((tap.body as { actions: Array<{ actions: unknown[] }> }).actions[0]!.actions.slice(0, 2), [
      { type: "pointerMove", duration: 0, x: 540, y: 1200, origin: "viewport" },
      { type: "pointerDown", button: 0 },
    ]);

    assert.match(textOf(await call("device_swipe", { direction: "up" })), /^Swiped up across the screen, from \(540, 1920\) to \(540, 480\)\.$/);
    // The footer shows after one more swipe.
    fake.state.revealAfterSwipes = fake.state.swipes + 1;
    const scrolled = json(await call("device_scroll", { direction: "down", strategy: "accessibility id", selector: "footer" }));
    assert.equal(scrolled.found, true);
    assert.equal(scrolled.swipes, 1);

    assert.equal(textOf(await call("device_back")), "Pressed back.");
    assert.deepEqual(json(await call("device_contexts")), { current: "NATIVE_APP", contexts: ["NATIVE_APP", "WEBVIEW_com.example.shop"] });
    assert.equal(textOf(await call("device_switch_context", { name: "WEBVIEW_com.example.shop" })), "Switched to context WEBVIEW_com.example.shop.");
    assert.match(textOf(await call("device_page_source")), /^Page source \(html, context WEBVIEW_com\.example\.shop/);
    const missing = await call("device_switch_context", { name: "WEBVIEW_nope" });
    assert.equal(missing.isError, true);
    assert.equal(textOf(missing), "no such context: WEBVIEW_nope is not a context");

    assert.equal(textOf(await call("device_launch_app")), "Brought com.example.shop to the foreground.");
    assert.equal(textOf(await call("device_terminate_app", { appId: "com.other" })), "Stopped com.other.");
    const scripts = fake.requests.filter((r) => r.path.endsWith("/execute/sync")).map((r) => r.body);
    assert.deepEqual(scripts, [
      { script: "mobile: activateApp", args: [{ appId: "com.example.shop" }] },
      { script: "mobile: terminateApp", args: [{ appId: "com.other" }] },
    ]);

    // logcat by default; the W3C-era /se/log refused, so the legacy route.
    const logs = textOf(await call("device_logs", { maxLines: 1 }));
    assert.match(logs, /^logcat: 2 entries since the last read, the last 1 follow:\n2023-11-14T22:13:21\.000Z ERROR Auth: bad token/);
    assert.deepEqual(fake.requests.filter((r) => /\/(se\/)?log$/.test(r.path)).map((r) => [r.path.replace("/session/s-1", ""), r.body]), [
      ["/se/log", { type: "logcat" }],
      ["/log", { type: "logcat" }],
    ]);
  } finally {
    await host.close("test over");
    assert.equal(fake.state.deleted, true);
    assert.equal(stopped(), 1);
    await fake.close();
  }
});

test("a screenshot comes back as an image part when it is small, is always saved on the runner, and is described either way", async () => {
  const { host, fake, call } = await hostOnFake();
  const temp = mkdtempSync(path.join(tmpdir(), "peeps-runner-temp-"));
  const previous = process.env.RUNNER_TEMP;
  process.env.RUNNER_TEMP = temp;
  try {
    const small = await call("device_screenshot");
    assert.equal(small.content[0]!.type, "image");
    assert.equal((small.content[0] as { mimeType: string }).mimeType, "image/png");
    const info = JSON.parse((small.content[1] as { text: string }).text) as Record<string, unknown>;
    assert.deepEqual(info, { width: 1080, height: 2400, bytes: 64, savedOnRunner: path.join(temp, "peeps-device", "screenshot-1.png"), returned: true });
    assert.equal(pngSize(readFileSync(info.savedOnRunner as string))!.width, 1080);

    process.env.FAKE_PNG_BYTES = String(SCREENSHOT_INLINE_BASE64);
    const large = await call("device_screenshot");
    assert.deepEqual(large.content.map((p) => p.type), ["text"]);
    const described = json(large);
    assert.equal(described.returned, false);
    assert.match(String(described.note), /read the screen with device_page_source/);
    assert.ok(existsSync(path.join(temp, "peeps-device", "screenshot-2.png")));
  } finally {
    delete process.env.FAKE_PNG_BYTES;
    if (previous === undefined) delete process.env.RUNNER_TEMP;
    else process.env.RUNNER_TEMP = previous;
    await host.close("test over");
    await fake.close();
  }
});

test("typed text is never echoed, and a value typed into a secure field is masked in every later result, as are the job's secrets", async () => {
  process.env.FAKE_SECRET = "job-secret-value-123";
  const { host, fake, call } = await hostOnFake({ redact: makeRedactor({ API_TOKEN: "job-secret-value-123" }) });
  try {
    const user = await call("device_type", { elementId: "e-user", text: "alice@example.com" });
    assert.equal(textOf(user), "Typed 17 characters into element e-user.");
    const pass = await call("device_type", { elementId: "e-pass", text: "hunter2-pass", clear: true });
    assert.equal(textOf(pass), "Typed 12 characters into element e-pass (a secure field: the value is masked in later results).");
    assert.deepEqual(
      fake.requests.filter((r) => r.path.startsWith("/session/s-1/element/e-pass/")).map((r) => r.path.split("/").slice(5).join("/")),
      ["attribute/password", "attribute/type", "clear", "value"],
    );
    const source = textOf(await call("device_page_source"));
    // What the agent typed into an ordinary field it may see again; never the secure field's value or a job secret.
    assert.match(source, /alice@example\.com/);
    assert.doesNotMatch(source, /hunter2-pass|job-secret-value-123/);
    assert.match(source, /text="\[redacted\]"/);
    assert.doesNotMatch(textOf(await call("device_logs")), /job-secret-value-123/);
    // And the job log never shows the text argument at all.
    assert.equal(summarizeArgs({ elementId: "e-pass", text: "hunter2-pass" }), 'elementId="e-pass"');
  } finally {
    delete process.env.FAKE_SECRET;
    await host.close("test over");
    await fake.close();
  }
});

test("bad arguments and missing pieces are tool errors, not crashes", async () => {
  const { host, fake, call } = await hostOnFake({ caps: { platformName: "iOS", "appium:automationName": "XCUITest" } });
  try {
    const cases: Array<[string, Record<string, unknown>, RegExp]> = [
      ["device_find", { strategy: "link text", selector: "x" }, /strategy" must be one of/],
      ["device_find", { strategy: "id" }, /selector" must be a non-empty string/],
      ["device_tap", { x: 10 }, /pass elementId, or both x and y/],
      ["device_type", { elementId: "e-user" }, /text" must be a string/],
      ["device_swipe", { direction: "sideways" }, /direction" must be one of/],
      ["device_scroll", { direction: "down", strategy: "id" }, /strategy and selector together/],
      ["device_page_source", { maxChars: 5 }, /maxChars" must be a number from 1000/],
      ["device_launch_app", {}, /pass appId: the capabilities name no appium:bundleId/],
      ["device_tap", { elementId: "e-gone" }, /^no such element: e-gone is gone$/],
    ];
    for (const [tool, args, expected] of cases) {
      const result = await call(tool, args);
      assert.equal(result.isError, true, tool);
      assert.match(textOf(result), expected, tool);
    }
    // iOS: the log type and the app key follow the platform.
    await call("device_logs");
    assert.deepEqual(fake.requests.find((r) => r.path.endsWith("/se/log"))!.body, { type: "syslog" });
    await call("device_launch_app", { appId: "com.example.Shop" });
    assert.deepEqual(fake.requests.find((r) => r.path.endsWith("/execute/sync"))!.body, { script: "mobile: activateApp", args: [{ bundleId: "com.example.Shop" }] });
  } finally {
    await host.close("test over");
    await fake.close();
  }
});

test("every call has a timeout: a request Appium never answers, and a session that is slow to start", async () => {
  const { host, fake, call } = await hostOnFake({ limits: { requestMs: 300, callMs: 2000 } });
  try {
    fake.state.hang.add("GET /source");
    const hung = await call("device_page_source");
    assert.equal(hung.isError, true);
    assert.equal(textOf(hung), "Appium did not answer GET /session/s-1/source within 300 ms");
  } finally {
    await host.close("test over");
    await fake.close();
  }

  let release: () => void = () => undefined;
  const slow = createDeviceTools(env(), {
    limits: { readyWaitMs: 100 },
    deps: {
      readCapabilities: () => new Promise((resolve) => (release = () => resolve(CAPS))),
      startAppium: async () => ({ url: "http://127.0.0.1:9", logFile: "", stop: async () => undefined }),
    },
  });
  slow.start();
  const waiting = await slow.handlers.device_back!({});
  assert.equal(waiting.isError, true);
  assert.match(textOf(waiting), /still starting/);
  release();
  await slow.close("test over");
});

test("a session that cannot start answers every call with why, and stops what it started", async () => {
  const noCaps = createDeviceTools(env(), { deps: { readCapabilities: async () => null, startAppium: async () => assert.fail("not started") } });
  noCaps.start();
  assert.match(textOf(await noCaps.handlers.device_back!({})), /could not start: the WebdriverIO config names no capabilities/);
  await noCaps.close("test over");

  let stops = 0;
  const refused = await new Promise<FakeWebDriver>((resolve) => void startFakeWebDriver().then(resolve));
  const broken = createDeviceTools(env(), {
    deps: {
      readCapabilities: async () => CAPS,
      // Appium answers, but the session is refused (a fake that knows no session route here).
      startAppium: async () => ({ url: `${refused.url}/nowhere`, logFile: "", stop: async () => void (stops += 1) }),
    },
  });
  broken.start();
  const answer = await broken.handlers.device_page_source!({});
  assert.equal(answer.isError, true);
  assert.match(textOf(answer), /could not start: invalid session id/);
  assert.equal(stops, 1);
  await broken.close("test over");
  await refused.close();
});

test("closing while Appium is still starting aborts the start, and later calls are refused", async () => {
  let aborted = false;
  const host = createDeviceTools(env(), {
    deps: {
      readCapabilities: async () => CAPS,
      startAppium: (signal) =>
        new Promise((_, reject) => {
          signal.addEventListener("abort", () => {
            aborted = true;
            reject(new Error("stopped while Appium was starting"));
          });
        }),
    },
  });
  host.start();
  await new Promise((r) => setTimeout(r, 20));
  await host.close("SIGTERM");
  assert.equal(aborted, true);
  assert.match(textOf(await host.handlers.device_back!({})), /the device session has ended/);
});

// ---------------------------------------------------------------------------
// Appium itself
// ---------------------------------------------------------------------------

test("Appium is the working directory's own, walking up as npx would, else one on PATH", () => {
  const root = mkdtempSync(path.join(tmpdir(), "peeps-bin-"));
  const nested = path.join(root, "apps", "mobile");
  mkdirSync(nested, { recursive: true });
  const global = path.join(root, "global-bin");
  mkdirSync(global);
  writeFileSync(path.join(global, "appium"), "");
  assert.equal(resolveAppiumBinary(nested, ""), null);
  assert.equal(resolveAppiumBinary(nested, global), path.join(global, "appium"));
  mkdirSync(path.join(root, "node_modules", ".bin"), { recursive: true });
  writeFileSync(path.join(root, "node_modules", ".bin", "appium"), "");
  assert.equal(resolveAppiumBinary(nested, global), path.join(root, "node_modules", ".bin", "appium"));
});

/** A workspace whose `node_modules/.bin/appium` is the fake. */
function workspaceWithFakeAppium(): { root: string; suite: string; record: string; argsFile: string } {
  const root = mkdtempSync(path.join(tmpdir(), "peeps-appium-bin-"));
  const suite = path.join(root, "mobile");
  cpSync(FIXTURE, suite, { recursive: true });
  symlinkSync(MODULES, path.join(root, "node_modules"), "dir");
  const bin = path.join(suite, "node_modules", ".bin");
  mkdirSync(bin, { recursive: true });
  writeFileSync(path.join(bin, "appium"), `#!/bin/sh\nexec "${process.execPath}" --import "${TSX}" "${FAKE_APPIUM}" "$@"\n`);
  chmodSync(path.join(bin, "appium"), 0o755);
  return { root, suite, record: path.join(root, "requests.jsonl"), argsFile: path.join(root, "args.json") };
}

test("Appium starts from the working directory on a free loopback port, logs to RUNNER_TEMP, and stops with its process group", async () => {
  const { root, suite, argsFile } = workspaceWithFakeAppium();
  const temp = mkdtempSync(path.join(tmpdir(), "peeps-runner-temp-"));
  process.env.RUNNER_TEMP = temp;
  process.env.FAKE_APPIUM_ARGS = argsFile;
  try {
    const server = await startAppiumServer(env(root, { "INPUT_WORKING-DIRECTORY": "mobile" }), new AbortController().signal, 30_000);
    const port = Number(new URL(server.url).port);
    assert.equal(new URL(server.url).hostname, "127.0.0.1");
    assert.equal(server.logFile, path.join(temp, `peeps-appium-${port}.log`));
    assert.ok(existsSync(server.logFile));
    const started = JSON.parse(readFileSync(argsFile, "utf8")) as { args: string[]; cwd: string };
    assert.equal(started.cwd, suite);
    assert.deepEqual(started.args, ["--address", "127.0.0.1", "--port", String(port), "--base-path", "/", "--log", server.logFile, "--log-no-colors", "--log-timestamp"]);
    assert.equal((await fetch(`${server.url}/status`)).ok, true);
    await server.stop();
    await assert.rejects(fetch(`${server.url}/status`, { signal: AbortSignal.timeout(2000) }));
  } finally {
    delete process.env.RUNNER_TEMP;
    delete process.env.FAKE_APPIUM_ARGS;
  }
});

test("without Appium installed the start fails with what to install", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "peeps-no-appium-"));
  const previous = process.env.PATH;
  process.env.PATH = "";
  try {
    await assert.rejects(startAppiumServer(env(root), new AbortController().signal), /npm i -D appium/);
  } finally {
    process.env.PATH = previous;
  }
});

// ---------------------------------------------------------------------------
// The agent session
// ---------------------------------------------------------------------------

interface PeepsFake {
  url: string;
  attach: Record<string, unknown> | null;
  results: Array<Record<string, unknown>>;
  close(): void;
}

/** Peeps' bridge routes: attach, hand out the given calls one per poll, then 410. */
async function fakeBridge(calls: Array<{ tool: string; args: Record<string, unknown> }>): Promise<PeepsFake> {
  const state: PeepsFake = { url: "", attach: null, results: [], close: () => undefined };
  const queue = calls.map((c, i) => ({ id: `c-${i + 1}`, seq: i + 1, ...c }));
  const read = (req: IncomingMessage) =>
    new Promise<string>((resolve) => {
      let data = "";
      req.on("data", (c: Buffer) => (data += c.toString("utf8")));
      req.on("end", () => resolve(data));
    });
  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://x");
    const body = await read(req);
    if (url.pathname.endsWith("/attach")) {
      state.attach = JSON.parse(body) as Record<string, unknown>;
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ sessionId: "sess-1", kind: "generate", expiresAt: new Date(Date.now() + 600_000).toISOString() }));
      return;
    }
    if (url.pathname.endsWith("/calls")) {
      const next = queue.shift();
      if (!next) {
        res.writeHead(410, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "session_over" }));
        return;
      }
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ call: next }));
      return;
    }
    if (url.pathname.endsWith("/result")) state.results.push(JSON.parse(body) as Record<string, unknown>);
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end("{}");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  state.url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  state.close = () => server.close();
  return state;
}

test("an agent session with device-tools offers the device tools, serves them, and closes the device session when Peeps ends it", async () => {
  const fake = await startFakeWebDriver();
  const bridge = await fakeBridge([
    { tool: "device_find", args: { strategy: "accessibility id", selector: "signIn" } },
    { tool: "device_tap", args: { elementId: "e-signin" } },
  ]);
  const previousKey = process.env.PEEPS_API_KEY;
  process.env.PEEPS_API_KEY = "test-key";
  let stops = 0;
  try {
    const { suite, root } = workspaceWithFakeAppium();
    const runnerEnv = env(root, {
      "INPUT_WORKING-DIRECTORY": "mobile",
      "INPUT_SESSION-ID": "sess-1",
      "INPUT_DEVICE-TOOLS": "true",
      PEEPS_API_URL: bridge.url,
    });
    assert.equal(runnerEnv.deviceTools, true);
    await runAgent(runnerEnv, new PeepsClient(runnerEnv), {
      handleSignals: false,
      deviceDeps: {
        readCapabilities: async () => CAPS,
        startAppium: async () => ({ url: fake.url, logFile: path.join(suite, "appium.log"), stop: async () => void (stops += 1) }),
      },
    });
    const attach = bridge.attach!;
    const names = (attach.tools as Array<{ name: string }>).map((t) => t.name);
    assert.ok(names.includes("run_tests") && names.includes("device_page_source") && names.includes("device_logs"));
    assert.ok(names.length <= 64);
    const info = attach.runnerInfo as Record<string, unknown>;
    assert.equal(info.framework, "appium");
    assert.deepEqual((info.deviceTools as { tools: string[] }).tools, DEVICE_TOOL_SPECS.map((t) => t.name));
    assert.equal(bridge.results.length, 2);
    const first = bridge.results[0] as { ok: boolean; result: CallToolResult };
    assert.equal(first.ok, true);
    assert.equal((json(first.result).elements as Array<{ elementId: string }>)[0]!.elementId, "e-signin");
    assert.deepEqual(bridge.results[1], { ok: true, result: { content: [{ type: "text", text: "Tapped element e-signin." }] } });
    // Peeps ended the session (410): the device session is deleted and Appium stopped.
    assert.equal(fake.state.deleted, true);
    assert.equal(stops, 1);
  } finally {
    if (previousKey === undefined) delete process.env.PEEPS_API_KEY;
    else process.env.PEEPS_API_KEY = previousKey;
    bridge.close();
    await fake.close();
  }
});

test("without device-tools, or on a suite that is not Appium, no device tool is offered", async () => {
  const previousKey = process.env.PEEPS_API_KEY;
  process.env.PEEPS_API_KEY = "test-key";
  try {
    const variants: Array<Record<string, string>> = [{}, { INPUT_FRAMEWORK: "playwright", "INPUT_DEVICE-TOOLS": "true" }];
    for (const extra of variants) {
      const bridge = await fakeBridge([]);
      const runnerEnv = env(undefined, { "INPUT_SESSION-ID": "sess-1", PEEPS_API_URL: bridge.url, ...extra });
      await runAgent(runnerEnv, new PeepsClient(runnerEnv), {
        handleSignals: false,
        deviceDeps: { readCapabilities: async () => assert.fail("no device session"), startAppium: async () => assert.fail("no Appium") },
      });
      const names = (bridge.attach!.tools as Array<{ name: string }>).map((t) => t.name);
      assert.equal(names.some((n) => n.startsWith("device_")), false);
      assert.equal("deviceTools" in (bridge.attach!.runnerInfo as Record<string, unknown>), false);
      bridge.close();
    }
  } finally {
    if (previousKey === undefined) delete process.env.PEEPS_API_KEY;
    else process.env.PEEPS_API_KEY = previousKey;
  }
});

test("pngSize reads the IHDR and refuses what is not a PNG", () => {
  assert.deepEqual(pngSize(fakePng(390, 844)), { width: 390, height: 844 });
  assert.equal(pngSize(Buffer.from("not a png at all, really not")), null);
});
