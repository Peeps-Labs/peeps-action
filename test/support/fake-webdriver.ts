/**
 * A fake Appium: just enough of the W3C WebDriver and Appium endpoints for
 * the device tools, with a native screen, a WebView and a device log.
 *
 * In-process: `startFakeWebDriver()`. As a process standing in for the
 * `appium` binary (`node --import tsx fake-webdriver.ts --port N --log F`):
 * it listens on that port, writes every request it gets to the file named
 * by `FAKE_APPIUM_RECORD` (one JSON line each), and exits on SIGTERM.
 */
import { appendFileSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

export interface Recorded {
  method: string;
  path: string;
  body: unknown;
}

export interface FakeWebDriver {
  url: string;
  port: number;
  requests: Recorded[];
  state: FakeState;
  close(): Promise<void>;
}

export interface FakeState {
  context: string;
  /** Element ids that become findable after this many swipes (device_scroll). */
  revealAfterSwipes: number;
  swipes: number;
  /** Routes (`METHOD /path` after the session id) that never answer. */
  hang: Set<string>;
  /** Text typed per element id. */
  typed: Map<string, string>;
  deleted: boolean;
}

/** A PNG signature and IHDR: enough for `pngSize`, and `bytes` long in total. */
export function fakePng(width: number, height: number, bytes = 64): Buffer {
  const out = Buffer.alloc(Math.max(bytes, 24));
  out.writeUInt32BE(0x89504e47, 0);
  out.writeUInt32BE(0x0d0a1a0a, 4);
  out.writeUInt32BE(13, 8);
  out.write("IHDR", 12, "ascii");
  out.writeUInt32BE(width, 16);
  out.writeUInt32BE(height, 20);
  return out;
}

const ELEMENT = "element-6066-11e4-a52e-4f735466cecf";

interface Element {
  id: string;
  text: string;
  rect: { x: number; y: number; width: number; height: number };
  displayed: boolean;
  attributes: Record<string, string>;
}

const NATIVE: Element[] = [
  { id: "e-user", text: "", rect: { x: 40, y: 400, width: 1000, height: 120 }, displayed: true, attributes: { password: "false", type: "android.widget.EditText" } },
  { id: "e-pass", text: "", rect: { x: 40, y: 560, width: 1000, height: 120 }, displayed: true, attributes: { password: "true", type: "android.widget.EditText" } },
  { id: "e-signin", text: "Sign in", rect: { x: 40, y: 720, width: 1000, height: 140 }, displayed: true, attributes: { password: "false" } },
];

export function startFakeWebDriver(port = 0, record?: string): Promise<FakeWebDriver> {
  const requests: Recorded[] = [];
  const state: FakeState = { context: "NATIVE_APP", revealAfterSwipes: 1, swipes: 0, hang: new Set(), typed: new Map(), deleted: false };
  let sessionCaps: Record<string, unknown> = {};

  const nativeSource = () =>
    `<?xml version="1.0" encoding="UTF-8"?><hierarchy rotation="0">${NATIVE.map(
      (e) => `<android.widget.TextView resource-id="${e.id}" text="${e.attributes.password === "true" ? state.typed.get(e.id) ?? "" : state.typed.get(e.id) ?? e.text}"/>`,
    ).join("")}<android.widget.TextView text="token ${process.env.FAKE_SECRET ?? ""}"/></hierarchy>`;

  const server: Server = createServer((req, res) => {
    let raw = "";
    req.on("data", (chunk: Buffer) => (raw += chunk.toString("utf8")));
    req.on("end", () => {
      const url = new URL(req.url ?? "/", "http://x");
      let body: unknown = null;
      try {
        body = raw ? JSON.parse(raw) : null;
      } catch {
        body = raw;
      }
      const entry = { method: req.method ?? "GET", path: url.pathname, body };
      requests.push(entry);
      if (record) appendFileSync(record, `${JSON.stringify(entry)}\n`);
      const send = (status: number, value: unknown, extra: Record<string, unknown> = {}) => {
        res.writeHead(status, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ value, ...extra }));
      };
      const error = (status: number, code: string, message: string) => send(status, { error: code, message, stacktrace: "at fake" });
      const b = (body ?? {}) as Record<string, unknown>;

      if (entry.method === "GET" && url.pathname === "/status") return send(200, { ready: true, message: "fake" });
      if (entry.method === "POST" && url.pathname === "/session") {
        sessionCaps = ((b.capabilities as Record<string, unknown>)?.alwaysMatch ?? {}) as Record<string, unknown>;
        return send(200, { sessionId: "s-1", capabilities: sessionCaps });
      }
      const match = url.pathname.match(/^\/session\/([^/]+)(\/.*)?$/);
      if (!match || match[1] !== "s-1" || state.deleted) return error(404, "invalid session id", "no such session");
      const route = match[2] ?? "";
      const key = `${entry.method} ${route}`;
      if (state.hang.has(key)) return; // never answers
      if (key === "DELETE ") {
        state.deleted = true;
        return send(200, null);
      }
      if (key === "GET /source") {
        return send(200, state.context === "NATIVE_APP" ? nativeSource() : `<html><body><input type="password"><p>Welcome</p></body></html>`);
      }
      if (key === "GET /context") return send(200, state.context);
      if (key === "GET /contexts") return send(200, ["NATIVE_APP", "WEBVIEW_com.example.shop"]);
      if (key === "POST /context") {
        if (!["NATIVE_APP", "WEBVIEW_com.example.shop"].includes(String(b.name))) return error(404, "no such context", `${String(b.name)} is not a context`);
        state.context = String(b.name);
        return send(200, null);
      }
      if (key === "GET /screenshot") return send(200, fakePng(1080, 2400, Number(process.env.FAKE_PNG_BYTES ?? 64)).toString("base64"));
      if (key === "GET /window/rect") return send(200, { x: 0, y: 0, width: 1080, height: 2400 });
      if (key === "POST /elements") {
        const value = String(b.value);
        if (b.using === "accessibility id" && value === "signIn") return send(200, [{ [ELEMENT]: "e-signin" }]);
        if (b.using === "id" && value === "password") return send(200, [{ [ELEMENT]: "e-pass" }]);
        if (b.using === "id" && value === "username") return send(200, [{ [ELEMENT]: "e-user" }]);
        if (b.using === "xpath" && value === "//*") return send(200, NATIVE.map((e) => ({ ELEMENT: e.id })));
        if (b.using === "accessibility id" && value === "footer") {
          return send(200, state.swipes >= state.revealAfterSwipes ? [{ [ELEMENT]: "e-signin" }] : []);
        }
        return send(200, []);
      }
      const el = route.match(/^\/element\/([^/]+)\/(text|rect|displayed|click|clear|value|attribute\/([a-z]+))$/);
      if (el) {
        const element = NATIVE.find((e) => e.id === el[1]);
        if (!element) return error(404, "no such element", `${el[1]} is gone`);
        if (el[2] === "text") return send(200, element.text);
        if (el[2] === "rect") return send(200, element.rect);
        if (el[2] === "displayed") return send(200, element.displayed);
        if (el[2] === "click") return send(200, null);
        if (el[2] === "clear") {
          state.typed.delete(element.id);
          return send(200, null);
        }
        if (el[2] === "value") {
          state.typed.set(element.id, (state.typed.get(element.id) ?? "") + String(b.text));
          return send(200, null);
        }
        return send(200, element.attributes[el[3]!] ?? null);
      }
      if (key === "POST /actions") {
        const actions = ((b.actions as Array<{ actions: Array<{ type: string }> }>)?.[0]?.actions ?? []).filter((a) => a.type === "pointerMove");
        if (actions.length > 1) state.swipes += 1;
        return send(200, null);
      }
      if (key === "DELETE /actions") return send(200, null);
      if (key === "POST /back") return send(200, null);
      if (key === "POST /execute/sync") {
        if (b.script === "mobile: terminateApp") return send(200, true);
        if (b.script === "mobile: activateApp") return send(200, null);
        return error(404, "unknown method", "not here");
      }
      if (key === "POST /se/log") return error(404, "unknown command", "The requested resource could not be found");
      if (key === "POST /log") {
        return send(200, [
          { timestamp: 1_700_000_000_000, level: "INFO", message: "ActivityManager: Start proc com.example.shop" },
          { timestamp: 1_700_000_001_000, level: "ERROR", message: `Auth: bad token ${process.env.FAKE_SECRET ?? ""}` },
        ]);
      }
      return error(404, "unknown command", `${key} is not implemented`);
    });
  });

  return new Promise((resolve) => {
    server.listen(port, "127.0.0.1", () => {
      const actual = (server.address() as AddressInfo).port;
      resolve({
        url: `http://127.0.0.1:${actual}`,
        port: actual,
        requests,
        state,
        close: () =>
          new Promise<void>((done) => {
            server.closeAllConnections();
            server.close(() => done());
          }),
      });
    });
  });
}

// As the `appium` binary: `--port N --log F`, everything else ignored.
if (process.argv[1] && /fake-webdriver\.ts$/.test(process.argv[1])) {
  const args = process.argv.slice(2);
  const value = (flag: string) => args[args.indexOf(flag) + 1];
  const port = Number(value("--port"));
  const log = value("--log");
  if (log) writeFileSync(log, `fake appium ${args.join(" ")}\n`);
  if (process.env.FAKE_APPIUM_ARGS) writeFileSync(process.env.FAKE_APPIUM_ARGS, JSON.stringify({ args, cwd: process.cwd() }));
  void startFakeWebDriver(port, process.env.FAKE_APPIUM_RECORD).then((fake) => {
    console.log(`fake appium listening on ${fake.url}`);
    process.on("SIGTERM", () => {
      // An Appium stuck in shutdown: only SIGKILL stops it.
      if (process.env.FAKE_APPIUM_IGNORE_TERM) return;
      void fake.close().then(() => process.exit(0));
    });
  });
}
