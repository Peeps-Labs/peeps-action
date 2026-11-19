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
import { LoadRefusal, PERMIT_HEADER, sharedNowMs, TurnDeadline, UserSession, type PermitGrant, type PlaywrightRequest, type Turn } from "./transport";

interface Init {
  runId: string;
  repositoryRoot: string;
  workingDirectory: string;
  journey: { module: string; export: string };
  baseURL?: string;
  deadManMs: number;
  /** The journey's environment (BASE_URL, PR 3's variables): set only after the uid drop, and
   * never on a command line. */
  env?: Record<string, string>;
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

/** A `node_modules` on a lookup path that exists but this uid cannot read, if any. */
function unreadableNodeModules(dirs: string[]): string | null {
  for (const start of dirs) {
    for (let dir = start; ; dir = path.dirname(dir)) {
      const candidate = path.join(dir, "node_modules");
      try {
        accessSync(candidate, fsConstants.R_OK | fsConstants.X_OK);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "EACCES") return candidate;
      }
      if (path.dirname(dir) === dir) break;
    }
  }
  return null;
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
const asks = new Map<number, { resolve: (v: PermitGrant) => void; reject: (e: Error) => void }>();
/** The newest lease generation the supervisor has named. */
let generationSeen = 0;
/** After this process saw itself paused: nothing from an older generation is used. */
let minGeneration = 0;
const sessions = new Map<number, UserSession>();
const turns = new Map<string, Turn>();

function session(user: number): UserSession {
  let s = sessions.get(user);
  if (!s) {
    s = new UserSession(playwright!, {
      baseURL: init!.baseURL,
      now: sharedNowMs,
      // Sampled at the send itself: a pause since the last tick voids the permit here too.
      usable: (permit) => {
        checkPause();
        return permit.generation >= minGeneration;
      },
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

async function runTurn(id: string, user: number, deadlineAt: number): Promise<void> {
  const startedAt = performance.now();
  const turn: Turn = { id, deadlineAt, ended: false };
  turns.set(id, turn);
  const s = session(user);
  let settled = false;
  const finish = (kind: "success" | "failure" | "timeout", extra: Record<string, unknown> = {}, durationMs = performance.now() - startedAt) => {
    if (settled) return;
    settled = true;
    turn.ended = true;
    turns.delete(id);
    send({ t: "outcome", turn: id, kind, durationUs: Math.round(durationMs * 1000), ...extra });
  };
  const timer = setTimeout(() => {
    turn.ended = true;
    // Disposing the context cancels whatever it has in flight.
    void s.reset();
    finish("timeout");
  }, Math.max(0, deadlineAt - sharedNowMs()));
  send({ t: "started", turn: id, user, wallMs: Date.now() });
  let kind: "success" | "failure" | "timeout" = "success";
  let extra: Record<string, unknown> = {};
  try {
    await journey!(s.guarded(turn));
  } catch (error) {
    if (error instanceof TurnDeadline) kind = "timeout";
    else {
      kind = "failure";
      extra = failureOf(error);
    }
  }
  const duration = performance.now() - startedAt;
  turn.ended = true;
  if (kind === "timeout") void s.reset();
  // The user is free only once the sends this turn left outstanding have ended (each by the
  // turn's deadline, when the timer cancels them).
  await s.afterTurn(turn);
  clearTimeout(timer);
  finish(kind, extra, duration);
}

let lastCheck = performance.now();

/**
 * Whether this process was just paused itself (SIGSTOP, a suspended VM): its timers and its
 * reads stalled together. Then the supervisor's silence is explained, and nothing it said
 * before the pause is trusted: every start and permit of the generation seen so far is
 * void until a newer one arrives. Sampled on every timer tick and before every frame read.
 */
function checkPause(): void {
  if (!init) return;
  const now = performance.now();
  const gap = now - lastCheck;
  lastCheck = now;
  if (gap > Math.max(500, init.deadManMs / 2)) {
    lastHeard = now;
    minGeneration = Math.max(minGeneration, generationSeen + 1);
  }
}

function deadMan(): void {
  if (!init) return;
  checkPause();
  if (performance.now() - lastHeard > init.deadManMs) {
    // The supervisor went quiet: end all traffic now. Exiting closes every socket, and as a
    // namespace's init it takes every descendant with it.
    process.stderr.write("load executor: supervisor silent, stopping\n");
    process.exit(75);
  }
}

function noteGeneration(frame: Frame): void {
  const generation = Number(frame.generation);
  if (Number.isFinite(generation)) generationSeen = Math.max(generationSeen, generation);
}

/** Names allowed in the journey's environment: no loader, preload or runtime switches. */
const ENV_NAME = /^[A-Z_][A-Z0-9_]*$/;
const ENV_FORBIDDEN = /^(?:NODE_|LD_|DYLD_|UV_|PEEPS_LOAD_)/;

async function onFrame(frame: Frame): Promise<void> {
  lastHeard = performance.now();
  switch (frame.t) {
    case "init": {
      init = frame as unknown as Init;
      for (const [key, value] of Object.entries(init.env ?? {})) {
        if (!ENV_NAME.test(key) || ENV_FORBIDDEN.test(key) || typeof value !== "string") throw new FrameError(`environment variable ${key} refused`);
        process.env[key] = value;
      }
      lastCheck = performance.now();
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
        const closed = unreadableNodeModules([init.workingDirectory, path.dirname(module)]);
        if (closed) send({ t: "fatal", code: "unreadable", message: `${closed} cannot be read` });
        else send({ t: "fatal", code: "playwright", message: failureOf(error).message });
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
      // Loading blocked this process on purpose; that was not a pause.
      lastCheck = performance.now();
      lastHeard = lastCheck;
      send({ t: "ready", playwright: found.version, playwrightFrom: found.from });
      return;
    }
    case "hb":
      noteGeneration(frame);
      return;
    case "start": {
      noteGeneration(frame);
      const generation = Number(frame.generation);
      const deadlineAt = Number(frame.deadlineAt);
      const leaseEndsAt = Number(frame.leaseEndsAt);
      // Read late (queued while this process was frozen) or from before its own pause: the
      // supervisor's permission for it is gone. It never runs.
      if (!(generation >= minGeneration) || !(sharedNowMs() < Math.min(deadlineAt, leaseEndsAt))) {
        send({ t: "outcome", turn: String(frame.turn), kind: "interrupted", message: "stale start", durationUs: 0 });
        return;
      }
      void runTurn(String(frame.turn), Number(frame.user), deadlineAt);
      return;
    }
    case "permit": {
      noteGeneration(frame);
      const ask = asks.get(Number(frame.req));
      asks.delete(Number(frame.req));
      ask?.resolve({ id: String(frame.id), expiresAt: Number(frame.expiresAt), generation: Number(frame.generation) });
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
  // Sampled before reading anything: a frame read after a pause must meet the pause's fence.
  checkPause();
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
