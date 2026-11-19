/**
 * The load executor: `dist/load-executor.js`, started by the supervisor with
 * `process.execPath` inside its containment, with an allowlisted environment. It is the only
 * process that loads customer code. It
 *
 *   1. drops to uid/gid 65534 first, when it starts as root and the supervisor asks;
 *   2. waits for `go` (the supervisor encloses it in its cgroup before saying go);
 *   3. checks it can read the journey and the customer's Playwright, then loads both;
 *   4. runs turns the supervisor starts, each send waiting for the supervisor's permit;
 *   5. exits on its own when the supervisor goes quiet for `deadManMs` (the dead-man).
 *
 * Its stdout carries only frames (`frames.ts`): the journey's `console` and
 * `process.stdout.write` are sent to stderr.
 */
import { accessSync, constants as fsConstants, readFileSync } from "node:fs";
import http from "node:http";
import https from "node:https";
import { createRequire } from "node:module";
import path from "node:path";
import { performance } from "node:perf_hooks";

import { encodeFrame, FrameError, FrameReader, type Frame } from "./frames";
import { loadJourney, originalLocation, resolveTsFile } from "./loader";
import { LoadRefusal, PERMIT_HEADER, TurnDeadline, UserSession, type PlaywrightRequest, type Turn } from "./transport";

interface Init {
  runId: string;
  repositoryRoot: string;
  workingDirectory: string;
  journey: { module: string; export: string };
  baseURL?: string;
  deadManMs: number;
  permitTtlMs: number;
}

const MAX_MESSAGE = 2000;

// The only writer to the frame channel. Everything else that writes to stdout goes to stderr.
const writeFrameBytes = process.stdout.write.bind(process.stdout);
const send = (message: Frame) => writeFrameBytes(encodeFrame(message));
const toStderr = process.stderr.write.bind(process.stderr) as typeof process.stdout.write;
process.stdout.write = toStderr;
for (const level of ["log", "info", "debug", "trace", "dir", "table"] as const) {
  // eslint-disable-next-line no-console
  console[level] = (...args: unknown[]) => {
    toStderr(args.map((a) => (typeof a === "string" ? a : safeInspect(a))).join(" ") + "\n");
  };
}

function safeInspect(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function dropPrivileges(): { uid: number; dropped: boolean } {
  const wanted = process.env.PEEPS_LOAD_DROP_UID;
  delete process.env.PEEPS_LOAD_DROP_UID;
  if (wanted && typeof process.getuid === "function" && process.getuid() === 0) {
    const id = Number(wanted);
    process.setgroups?.([]);
    process.setgid?.(id);
    process.setuid?.(id);
    return { uid: process.getuid(), dropped: true };
  }
  return { uid: typeof process.getuid === "function" ? process.getuid() : -1, dropped: false };
}

/** This process's pid as the host sees it: the first `NSpid` entry. */
function hostPid(): number {
  try {
    const line = readFileSync("/proc/self/status", "utf8").split("\n").find((l) => l.startsWith("NSpid:"));
    const first = line?.split(/\s+/)[1];
    if (first) return Number(first);
  } catch {
    // not Linux
  }
  return process.pid;
}

function resolvePlaywright(dirs: string[]): { request: PlaywrightRequest; version: string; from: string } {
  for (const dir of dirs) {
    const req = createRequire(path.join(dir, "noop.js"));
    for (const name of ["@playwright/test", "playwright-core", "playwright"]) {
      try {
        const pkg = req.resolve(`${name}/package.json`);
        const lib = req(name) as { request?: PlaywrightRequest };
        if (!lib.request) continue;
        const version = (JSON.parse(readFileSync(pkg, "utf8")) as { version?: string }).version ?? "?";
        return { request: lib.request, version, from: path.dirname(pkg) };
      } catch {
        // try the next
      }
    }
  }
  throw new Error("Playwright was not found from the working directory or the journey's folder");
}

function hasPermitHeader(args: unknown[]): boolean {
  for (const arg of args) {
    if (arg && typeof arg === "object" && "headers" in arg) {
      const headers = (arg as { headers?: unknown }).headers;
      if (headers && typeof headers === "object") {
        for (const key of Object.keys(headers)) if (key.toLowerCase() === PERMIT_HEADER.toLowerCase()) return true;
      }
    }
  }
  return false;
}

function urlOf(args: unknown[]): string {
  const first = args[0];
  if (typeof first === "string") return first;
  if (first instanceof URL) return first.href;
  if (first && typeof first === "object") {
    const o = first as { protocol?: string; host?: string; hostname?: string; port?: number; path?: string; url?: string };
    if (o.url) return o.url;
    return `${o.protocol ?? "http:"}//${o.host ?? o.hostname ?? "?"}${o.port ? `:${o.port}` : ""}${o.path ?? "/"}`;
  }
  return "?";
}

/** Reports every send that does not carry a permit: raw `fetch`, `node:http`, `node:https`. */
function watchForBypasses(): void {
  const report = (kind: string, url: string) => send({ t: "bypass", kind, url: url.slice(0, 500) });
  const originalFetch = globalThis.fetch;
  if (originalFetch) {
    globalThis.fetch = function (this: unknown, input: unknown, init?: unknown) {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : (input as { url?: string })?.url ?? "?";
      report("fetch", url);
      return (originalFetch as (...a: unknown[]) => Promise<Response>).call(this, input, init);
    } as typeof fetch;
  }
  for (const [kind, mod] of [["node:http", http], ["node:https", https]] as const) {
    for (const fn of ["request", "get"] as const) {
      const original = mod[fn] as (...a: unknown[]) => unknown;
      (mod as unknown as Record<string, unknown>)[fn] = function (this: unknown, ...args: unknown[]) {
        if (!hasPermitHeader(args)) report(kind, urlOf(args));
        return original.apply(this, args);
      };
    }
  }
}

let init: Init | null = null;
let journey: ((...args: unknown[]) => unknown) | null = null;
let playwright: PlaywrightRequest | null = null;
let lastHeard = performance.now();
let nextAsk = 0;
const asks = new Map<number, { resolve: (v: { id: string }) => void; reject: (e: Error) => void }>();
const sessions = new Map<number, UserSession>();
const turns = new Map<string, Turn>();

function session(user: number): UserSession {
  let s = sessions.get(user);
  if (!s) {
    s = new UserSession(playwright!, {
      baseURL: init!.baseURL,
      permitTtlMs: init!.permitTtlMs,
      now: () => performance.now(),
      ask: ({ turn, method, url }) =>
        new Promise((resolve, reject) => {
          const req = ++nextAsk;
          asks.set(req, { resolve, reject });
          send({ t: "ask", req, turn, method, url });
        }),
      done: (permit) => send({ t: "done", permit }),
    });
    sessions.set(user, s);
  }
  return s;
}

function failureOf(error: unknown): { message: string; location: string | null } {
  const e = error instanceof Error ? error : new Error(String(error));
  return { message: e.message.slice(0, MAX_MESSAGE), location: originalLocation(e.stack, init!.repositoryRoot) };
}

async function runTurn(id: string, user: number, deadlineInMs: number): Promise<void> {
  const startedAt = performance.now();
  const turn: Turn = { id, deadlineAt: startedAt + deadlineInMs, ended: false };
  turns.set(id, turn);
  const s = session(user);
  let settled = false;
  const finish = (kind: "success" | "failure" | "timeout", extra: Record<string, unknown> = {}) => {
    if (settled) return;
    settled = true;
    turn.ended = true;
    turns.delete(id);
    send({ t: "outcome", turn: id, kind, durationUs: Math.round((performance.now() - startedAt) * 1000), ...extra });
  };
  const timer = setTimeout(() => {
    finish("timeout");
    // Disposing the context cancels whatever it has in flight.
    void s.reset();
  }, Math.max(0, deadlineInMs));
  send({ t: "started", turn: id, user, wallMs: Date.now() });
  try {
    await journey!(s.guarded(turn));
    finish("success");
  } catch (error) {
    if (error instanceof TurnDeadline) {
      finish("timeout");
      void s.reset();
    } else finish("failure", failureOf(error));
  } finally {
    clearTimeout(timer);
    await s.afterTurn();
  }
}

let lastCheck = performance.now();

function deadMan(): void {
  if (!init) return;
  const now = performance.now();
  const gap = now - lastCheck;
  lastCheck = now;
  // This process was paused itself (SIGSTOP, a suspended VM): the supervisor's silence is
  // explained, and it is fenced too, so nothing can be sent until it renews. Start counting
  // again rather than mistaking our own pause for its death.
  if (gap > Math.max(500, init.deadManMs / 2)) {
    lastHeard = now;
    return;
  }
  if (now - lastHeard > init.deadManMs) {
    // The supervisor went quiet: end all traffic now. Exiting closes every socket, and as a
    // namespace's init it takes every descendant with it.
    process.stderr.write("load executor: supervisor silent, stopping\n");
    process.exit(75);
  }
}

async function onFrame(frame: Frame): Promise<void> {
  lastHeard = performance.now();
  switch (frame.t) {
    case "init": {
      init = frame as unknown as Init;
      setInterval(deadMan, Math.max(10, Math.min(100, Math.floor(init.deadManMs / 4)))).unref();
      return;
    }
    case "go": {
      if (!init) throw new FrameError("go before init");
      const module = resolveTsFile(path.resolve(init.repositoryRoot, init.journey.module));
      try {
        accessSync(init.workingDirectory, fsConstants.R_OK | fsConstants.X_OK);
        if (!module) throw new Error(`journey module ${init.journey.module} was not found`);
        accessSync(module, fsConstants.R_OK);
      } catch (error) {
        send({ t: "fatal", code: "unreadable", message: failureOf(error).message });
        return;
      }
      let found: ReturnType<typeof resolvePlaywright>;
      try {
        found = resolvePlaywright([init.workingDirectory, path.dirname(module)]);
      } catch (error) {
        send({ t: "fatal", code: "playwright", message: failureOf(error).message });
        return;
      }
      playwright = found.request;
      watchForBypasses();
      try {
        journey = loadJourney(init.repositoryRoot, init.journey.module, init.journey.export);
      } catch (error) {
        send({ t: "fatal", code: "journey", ...failureOf(error) });
        return;
      }
      send({ t: "ready", playwright: found.version, playwrightFrom: found.from });
      return;
    }
    case "hb":
      return;
    case "start":
      void runTurn(String(frame.turn), Number(frame.user), Number(frame.deadlineInMs));
      return;
    case "permit": {
      const ask = asks.get(Number(frame.req));
      asks.delete(Number(frame.req));
      ask?.resolve({ id: String(frame.id) });
      return;
    }
    case "deny": {
      const ask = asks.get(Number(frame.req));
      asks.delete(Number(frame.req));
      ask?.reject(new LoadRefusal(`request refused (${String(frame.reason)})`));
      return;
    }
    case "stats?": {
      (globalThis as { gc?: () => void }).gc?.();
      send({ t: "stats", heapUsed: process.memoryUsage().heapUsed, sessions: sessions.size });
      return;
    }
    case "exit": {
      await Promise.allSettled([...sessions.values()].map((s) => s.reset()));
      process.exit(0);
    }
    // falls through: process.exit never returns
    default:
      throw new FrameError(`unknown message ${frame.t}`);
  }
}

const identity = dropPrivileges();
send({ t: "hello", hostPid: hostPid(), uid: identity.uid, dropped: identity.dropped });
const reader = new FrameReader();
process.stdin.on("data", (chunk: Buffer) => {
  let frames: Frame[];
  try {
    frames = reader.push(chunk);
  } catch (error) {
    process.stderr.write(`load executor: ${String(error)}\n`);
    process.exit(76);
  }
  for (const frame of frames) {
    onFrame(frame).catch((error: unknown) => {
      process.stderr.write(`load executor: ${String(error)}\n`);
      process.exit(77);
    });
  }
});
// The supervisor is gone: nothing may run without it.
process.stdin.on("end", () => process.exit(74));
process.stdin.on("error", () => process.exit(74));
