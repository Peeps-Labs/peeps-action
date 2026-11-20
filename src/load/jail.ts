/**
 * Starts and ends the load jail (plan v3 §3). The jail is a transient systemd
 * unit whose main process, the outer watcher, holds the lifeline: this process's
 * pipe to sudo's stdin. Closing it, or this process dying, ends the unit and
 * systemd kills its whole cgroup. Nothing here signals a PID.
 *
 * Customer code starts only on tickets (e4 plan v3 §2.1): `start` waits for the
 * jail's authenticated `ready`, then in one synchronous step asks the supervisor
 * for a ticket (`ticketOf`, null when its lease or stop latch says no) and sends
 * it; init runs the install and answers `installed`. `launch` does the same after
 * `installed`, and init starts the executor. Both are bounded, and both reject on
 * control EOF, the jail's exit or an abort. Control EOF after `ready` is terminal.
 */
import { execFile, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { readFile, realpath } from "node:fs/promises";
import os from "node:os";
import { PassThrough } from "node:stream";
import { StringDecoder } from "node:string_decoder";
import net from "node:net";
import { promisify } from "node:util";
import { sharedClocks } from "./clocks";
import { decode, encode, LineSplitter, relayable, sameNonce, type CtlFrame, type RefusedReason, type Ticket } from "./jail/ctl";
import { IN_JAIL, neutralize, RELAY_UID, rootDir, socketDir, specProblems, systemdRunArgs, unitName, type JailSpec } from "./jail/spec";

const exec = promisify(execFile);
/** Host tools run by absolute path with a fixed PATH: nothing the job put on its PATH is found first. */
const HOST_ENV = { PATH: "/usr/sbin:/usr/bin:/sbin:/bin" };
const HEARTBEAT_MS = 1000;
const STOP_GRACE_MS = 2000;
const EMPTY_WAIT_MS = 3000;
const READY_MS = 60_000;
const CALL_MS = 15_000;
/** How long the in-jail install may take before `start` gives up. */
const INSTALL_MS = 15 * 60_000;

/** The URL the executor's Playwright uses as its proxy: the relay, the jail's only way out. */
export const RELAY_URL = `http://127.0.0.1:${IN_JAIL.relayPort}`;

/** What init answers when the install has run. */
export interface Installed {
  code: number | null;
  signal: string | null;
  ms: number;
}

/** Init refused a ticket; nothing ran for it. */
export class TicketRefused extends Error {
  constructor(readonly reason: RefusedReason) {
    super(`load jail: init refused the ticket (${reason})`);
    this.name = "TicketRefused";
  }
}

/** The supervisor had no ticket to give: its lease or its stop latch said no. */
export class NoTicket extends Error {
  constructor() {
    super("load jail: no ticket (the lease is not held, or a stop was asked for)");
    this.name = "NoTicket";
  }
}

export interface JailExit {
  code: number | null;
  signal: string | null;
}

export interface JailEnd {
  /** The unit's cgroup is empty or gone. */
  clean: boolean;
  ms: number;
}

export interface JailHandle {
  unit: string;
  /** The jail is isolated and its relay is up; customer code has not started. */
  ready: Promise<void>;
  /** After `ready`: mint a ticket at the send, then the install runs. Call once, or again after a `TicketRefused`. */
  start(ticketOf: () => Ticket | null, signal?: AbortSignal): Promise<Installed>;
  /** After `installed`: mint a ticket at the send, then the executor starts. Call once, or again after a `TicketRefused`. */
  launch(ticketOf: () => Ticket | null, signal?: AbortSignal): Promise<void>;
  /** A frame for the executor (init, turn, cancel, stop); anything else throws. */
  send(frame: CtlFrame): void;
  /** Every frame init sends after `hello`, the executor's included. Returns an unsubscribe. */
  onFrame(listener: (frame: CtlFrame) => void): () => void;
  /** The executor's proxy URL, as the jail sees it. */
  relayUrl: string;
  /** The executor's exit, from init; or null fields when the jail ended without one. */
  exited: Promise<JailExit>;
  /** Closes the lifeline, stops the unit if it lingers, and checks its cgroup is empty. */
  end(): Promise<JailEnd>;
  /** The jail's stdout, when asked for with `stdout: "pipe"`. */
  stdout: NodeJS.ReadableStream | null;
}

export interface StartJailOptions {
  /** Binds the gate's listener at this path. The jail's relay is its only client. */
  listenProxy(path: string): Promise<net.Server>;
  /** "pipe" exposes the jail's stdout on the handle; by default it goes to this process's. Either way workflow commands in it are neutralized. */
  stdout?: "inherit" | "pipe";
}

export async function startJail(spec: JailSpec, options: StartJailOptions, signal?: AbortSignal): Promise<JailHandle> {
  if (signal?.aborted) throw abortError(signal);
  const problems = specProblems(spec);
  if (problems.length > 0) throw new Error(`load jail: ${problems.join("; ")}`);
  for (const tree of [spec.workspace, spec.nodeDir, spec.actionDir]) await refuseSpecialFiles(tree);
  const unit = unitName(spec.runId);
  const dir = socketDir(spec.runId);
  const nonce = randomBytes(32).toString("hex");
  await removeStale(unit, dir, spec.runId);

  // Bind both sockets in place, then lock the folder: moving a listening socket
  // across file systems leaves it with no listener (E0 run 3).
  let proxy: net.Server | undefined;
  const ctlServer = net.createServer();
  const proxySockets = new Set<net.Socket>();
  try {
    await sudo("/usr/bin/mkdir", "-m", "0700", dir);
    await sudo("/usr/bin/chown", String(process.getuid!()), dir);
    signal?.throwIfAborted();
    proxy = await options.listenProxy(`${dir}/proxy.sock`);
    proxy.on("connection", (socket: net.Socket) => {
      proxySockets.add(socket);
      socket.once("close", () => proxySockets.delete(socket));
    });
    await new Promise<void>((resolve, reject) => ctlServer.once("error", reject).listen(`${dir}/ctl.sock`, resolve));
    await sudo("/usr/bin/chown", `root:${RELAY_UID}`, dir, `${dir}/proxy.sock`);
    await sudo("/usr/bin/chown", "root:root", `${dir}/ctl.sock`);
    await sudo("/usr/bin/chmod", "0660", `${dir}/proxy.sock`);
    await sudo("/usr/bin/chmod", "0600", `${dir}/ctl.sock`);
    await sudo("/usr/bin/chmod", "0710", dir);
    signal?.throwIfAborted();
  } catch (error) {
    proxy?.close();
    ctlServer.close();
    await sudo("/usr/bin/rm", "-rf", dir).catch(() => undefined);
    throw error;
  }
  const gate = proxy;

  const ctl = acceptCtl(ctlServer, nonce);
  ctl.catch(() => undefined);
  // Never hand the job's log the jail's raw output: the runner reads workflow commands there.
  const child = spawn("/usr/bin/sudo", ["-n", ...systemdRunArgs(spec)], { env: HOST_ENV, stdio: ["pipe", "pipe", "pipe"] });
  const stdout = neutralized(child.stdout!);
  const stderr = neutralized(child.stderr!);
  if (options.stdout !== "pipe") stdout.pipe(process.stdout);
  stderr.pipe(process.stderr);
  const lifeline = child.stdin!;
  lifeline.on("error", () => undefined);
  lifeline.write(`${nonce}\n`);
  const heartbeat = setInterval(() => lifeline.write("\n"), HEARTBEAT_MS);
  const cgroup = controlGroup(unit);

  let ending: Promise<JailEnd> | undefined;
  const end = (): Promise<JailEnd> =>
    (ending ??= (async () => {
      const t0 = performance.now();
      clearInterval(heartbeat);
      // Close the gate first: nothing the jail still holds may reach upstream.
      gate.close();
      for (const socket of proxySockets) socket.destroy();
      lifeline.destroy();
      ctlServer.close();
      const group = await cgroup;
      if (!group || !(await becomesInactive(unit, STOP_GRACE_MS))) await sudo("/usr/bin/systemctl", "stop", `${unit}.service`).catch(() => undefined);
      // With no cgroup path the unit may not have registered yet: clean only once systemd-run itself is gone too.
      const clean = group ? await cgroupEmpties(group, EMPTY_WAIT_MS) : (await childGone(child, EMPTY_WAIT_MS)) && (await becomesInactive(unit, 0));
      await sudo("/usr/bin/rm", "-rf", dir, rootDir(spec.runId)).catch(() => undefined);
      return { clean, ms: Math.round(performance.now() - t0) };
    })());

  const died = new Promise<never>((_, reject) => {
    child.once("exit", (code) => reject(new Error(`load jail ended before it was ready (${code})`)));
    child.once("error", reject);
  });
  died.catch(() => undefined);
  child.once("exit", () => void end());
  child.once("error", () => void end());

  const late = new Promise<never>((_, reject) => {
    const timer = setTimeout(() => reject(new Error(`load jail was not ready within ${READY_MS / 1000} s`)), READY_MS);
    timer.unref();
    void Promise.race([ctl.then((c) => c.ready), died]).finally(() => clearTimeout(timer)).catch(() => undefined);
  });
  const ready = Promise.race([ctl.then((c) => c.ready), died, late]);
  ready.catch(() => undefined);
  const exited = new Promise<JailExit>((resolve) => {
    ctl.then((c) => c.exit.then(resolve), () => resolve({ code: null, signal: null }));
    died.catch(() => setTimeout(() => resolve({ code: null, signal: null }), 100));
  });

  // Terminal: the jail died, its control socket closed after ready, or it was ended. Latched.
  let terminal: Error | undefined;
  const terminalWaiters = new Set<(e: Error) => void>();
  const latch = (error: Error) => {
    if (terminal) return;
    terminal = error;
    for (const w of terminalWaiters) w(error);
    terminalWaiters.clear();
  };
  died.catch((e: Error) => latch(e));
  child.once("exit", () => latch(new Error("load jail ended")));
  void ctl.then((c) => c.closed.then(() => latch(new Error("load jail's control socket closed"))), (e: Error) => latch(e));
  void exited.then(() => latch(new Error("load jail's executor exited")));

  /** Waits for `p`, rejecting on the terminal latch, the abort signal or the time limit. */
  const bounded = <T>(p: Promise<T>, ms: number, what: string, signal?: AbortSignal): Promise<T> =>
    new Promise<T>((resolve, reject) => {
      if (terminal) return reject(terminal);
      if (signal?.aborted) return reject(abortError(signal));
      const timer = setTimeout(() => done(() => reject(new Error(`load jail: no ${what} within ${Math.round(ms / 1000)} s`))), ms);
      const onTerminal = (e: Error) => done(() => reject(e));
      const onAbort = () => done(() => reject(abortError(signal!)));
      const done = (settle: () => void) => {
        clearTimeout(timer);
        terminalWaiters.delete(onTerminal);
        signal?.removeEventListener("abort", onAbort);
        settle();
      };
      terminalWaiters.add(onTerminal);
      signal?.addEventListener("abort", onAbort, { once: true });
      p.then((v) => done(() => resolve(v)), (e: unknown) => done(() => reject(e)));
    });

  /** The next frame of one of `types` from init. */
  const nextOf = (types: CtlFrame["type"][]): Promise<CtlFrame> =>
    ctl.then(
      (c) =>
        new Promise<CtlFrame>((resolve) => {
          const off = c.onFrame((f) => {
            if (!types.includes(f.type)) return;
            off();
            resolve(f);
          });
        }),
    );

  let installed: Promise<Installed> | undefined;
  let launched: Promise<void> | undefined;
  /** In one synchronous step: ask for a ticket, then send it. */
  const sendTicket = (c: Ctl, type: "start" | "launch", ticketOf: () => Ticket | null): void => {
    if (ending !== undefined) throw new Error("load jail is ending");
    const ticket = ticketOf();
    if (ticket === null) throw new NoTicket();
    c.send({ type, ticket });
  };
  const start = (ticketOf: () => Ticket | null, signal?: AbortSignal): Promise<Installed> => {
    if (installed) return Promise.reject(new Error("load jail: start was already called"));
    installed = (async () => {
      await bounded(ready, READY_MS, "ready", signal);
      const c = await ctl;
      const answer = nextOf(["installed", "refused"]);
      sendTicket(c, "start", ticketOf);
      const f = await bounded(answer, INSTALL_MS, "install", signal);
      if (f.type === "refused") {
        // Nothing ran and init did not use the ticket up: a fresh one may follow.
        installed = undefined;
        throw new TicketRefused(f.reason);
      }
      if (f.type !== "installed") throw new Error(`load jail: unexpected ${f.type}`);
      return { code: f.code, signal: f.signal, ms: f.ms };
    })();
    installed.catch(() => undefined);
    return installed;
  };
  const launch = (ticketOf: () => Ticket | null, signal?: AbortSignal): Promise<void> => {
    if (!installed) return Promise.reject(new Error("load jail: launch before start"));
    if (launched) return Promise.reject(new Error("load jail: launch was already called"));
    const after = installed;
    launched = (async () => {
      await bounded(after, INSTALL_MS, "install", signal);
      const c = await ctl;
      const answer = nextOf(["launched", "refused"]);
      sendTicket(c, "launch", ticketOf);
      const f = await bounded(answer, CALL_MS, "launch", signal);
      if (f.type === "refused") {
        launched = undefined;
        throw new TicketRefused(f.reason);
      }
    })();
    launched.catch(() => undefined);
    return launched;
  };

  // Frames sent before init's ready queue on the control promise; after the end, nothing goes.
  const handle: JailHandle = {
    unit,
    ready,
    start,
    launch,
    send: (frame) => {
      if (!relayable(frame, "supervisor")) throw new Error(`load jail: ${frame.type} is not a frame for the executor`);
      void ctl.then((c) => ending === undefined && c.send(frame), () => undefined);
    },
    onFrame: (listener) => {
      let off: (() => void) | undefined;
      let removed = false;
      void ctl.then((c) => {
        if (!removed) off = c.onFrame(listener);
      }, () => undefined);
      return () => {
        removed = true;
        off?.();
      };
    },
    relayUrl: RELAY_URL,
    exited,
    end,
    stdout: options.stdout === "pipe" ? stdout : null,
  };
  // A handle produced after the signal aborted is ended at once; a later abort ends it too.
  if (signal) {
    if (signal.aborted) {
      await end();
      throw abortError(signal);
    }
    signal.addEventListener("abort", () => void end(), { once: true });
  }
  return handle;
}

/** Peeps' own self-test of the fence (plan v3 §3, row 4): before the claim, in a throwaway unit. */
export interface ProbeReport {
  passed: boolean;
  failures: string[];
  /** What the probe saw inside the jail; null when it printed nothing. */
  seen: Record<string, unknown> | null;
}

/** The mounts a jail may show: the manifest's, and nothing of the overlay's backing folders. */
const PROBE_MOUNTS = /^\/(usr|bin|sbin|lib\w*|etc\/[\w.]+|dev(\/\w+)?|tmp|proc|run\/peeps\/[\w-]+)?$/;

/**
 * Runs Peeps' probe (`load-init.js --probe`) as the executor would run, against a listener on
 * this runner's non-loopback address that the relay also forwards to. Only the relay may reach
 * it. The probe's unit takes its own two tickets, minted here: it runs no customer code.
 */
export async function probe(base: Omit<JailSpec, "command" | "claimId" | "install" | "runId">, runId: string, signal?: AbortSignal): Promise<ProbeReport> {
  const ip = nonLoopbackIPv4();
  const hits: string[] = [];
  const listener = net.createServer((c) => {
    c.once("data", (d) => {
      hits.push(String(d).split("\r\n")[0]!);
      c.end("HTTP/1.0 200 OK\r\nContent-Length: 2\r\n\r\nok");
    });
    c.on("error", () => undefined);
  });
  await new Promise<void>((resolve) => listener.listen(0, ip, resolve));
  const target = `${ip}:${(listener.address() as net.AddressInfo).port}`;
  const forward = (path: string) =>
    new Promise<net.Server>((resolve) => {
      const server = net.createServer((c) => {
        const u = net.connect((listener.address() as net.AddressInfo).port, ip);
        c.pipe(u).pipe(c);
        u.on("error", () => c.destroy());
        c.on("error", () => u.destroy());
      });
      server.listen(path, () => resolve(server));
    });
  const spec: JailSpec = { ...base, runId, claimId: `probe-${runId}`, command: [`${IN_JAIL.node}/bin/node`, `${IN_JAIL.action}/load-init.js`, "--probe", target] };
  let out = "";
  try {
    const handle = await startJail(spec, { listenProxy: forward, stdout: "pipe" }, signal);
    handle.stdout!.setEncoding("utf8");
    handle.stdout!.on("data", (d: string) => (out += d));
    const ticket = (): Ticket => {
      const now = sharedClocks();
      return { claimId: spec.claimId, epoch: 0, planHash: "probe", leaseSeq: 0, nonce: randomBytes(16).toString("hex"), monoDeadline: now.monoMs + CALL_MS, wallDeadline: now.wallMs + CALL_MS };
    };
    try {
      await handle.start(ticket, signal);
      await handle.launch(ticket, signal);
      await handle.exited;
    } finally {
      const end = await handle.end();
      if (!end.clean) out += "\nPEEPS-PROBE-UNCLEAN\n";
    }
  } finally {
    listener.close();
  }
  const line = out.split("\n").map((l) => l.replace(/^jail\| /, "")).find((l) => l.startsWith("PEEPS-PROBE "));
  let seen: Record<string, unknown> | null = null;
  try {
    seen = line ? (JSON.parse(line.slice("PEEPS-PROBE ".length)) as Record<string, unknown>) : null;
  } catch {
    seen = null;
  }
  const failures: string[] = [];
  if (!seen) failures.push("the probe printed no report");
  else {
    const expect = (ok: boolean, what: string) => !ok && failures.push(what);
    expect(seen.uid === base.executorUid, "it did not run as the executor's uid");
    expect(seen.relay === "connected", "the relay did not connect");
    expect(seen.direct !== "connected", "a direct connection got out");
    expect(seen.dns !== "resolved", "DNS resolved");
    expect(seen.unixProxy === "EACCES", "the proxy socket was reachable");
    expect(Array.isArray(seen.hostPaths) && seen.hostPaths.length === 0, "host paths are visible");
    expect(seen.procOne === "EACCES" && seen.procOneRoot === "EACCES", "init's /proc entry is readable");
    expect(seen.procSelf === "readable", "/proc does not work");
    expect(Array.isArray(seen.mounts) && (seen.mounts as string[]).every((m) => PROBE_MOUNTS.test(m) && !/ws-lower|\/up$/.test(m)), "mounts outside the manifest are visible");
    expect(seen.workspaceWrite === "written" && !existsSync(`${base.workspace}/.peeps-probe`), "a write reached the checkout");
  }
  if (out.includes("PEEPS-PROBE-UNCLEAN")) failures.push("the unit's cgroup was not empty after end()");
  if (hits.length !== 1 || hits[0] !== "GET /probe-relay HTTP/1.0") failures.push(`the listener saw ${JSON.stringify(hits)}`);
  return { passed: failures.length === 0, failures, seen };
}

function nonLoopbackIPv4(): string {
  for (const list of Object.values(os.networkInterfaces())) {
    for (const a of list ?? []) if (a.family === "IPv4" && !a.internal) return a.address;
  }
  throw new Error("load jail probe: no non-loopback IPv4 address");
}

function abortError(signal: AbortSignal): Error {
  const reason = signal.reason as unknown;
  return reason instanceof Error ? reason : new Error("load jail: aborted");
}

/**
 * Every line gets a fixed prefix so the runner never reads a workflow command in it. A line
 * longer than 64 KiB is cut, and the jail's pipe is paused while the output is backed up, so
 * customer output cannot grow this process's memory.
 */
const MAX_LINE = 64 * 1024;
function neutralized(source: NodeJS.ReadableStream): PassThrough {
  const out = new PassThrough();
  const decoder = new StringDecoder("utf8");
  let pending = "";
  const emit = (line: string) => {
    if (!out.write(`${neutralize(line.endsWith("\r") ? line.slice(0, -1) : line)}\n`)) {
      source.pause();
      out.once("drain", () => source.resume());
    }
  };
  source.on("data", (chunk: Buffer) => {
    pending += decoder.write(chunk);
    let nl: number;
    while ((nl = pending.indexOf("\n")) !== -1) {
      emit(pending.slice(0, nl));
      pending = pending.slice(nl + 1);
    }
    while (pending.length > MAX_LINE) {
      emit(pending.slice(0, MAX_LINE));
      pending = pending.slice(MAX_LINE);
    }
  });
  source.on("end", () => {
    pending += decoder.end();
    if (pending) emit(pending);
    out.end();
  });
  return out;
}

/** Sockets and FIFOs in the checkout would stay usable through a read-only bind: a way round the gate. */
async function refuseSpecialFiles(tree: string): Promise<void> {
  if ((await realpath(tree)) !== tree) throw new Error(`load jail: ${tree} must not go through a symlink`);
  const { stdout } = await exec("/usr/bin/find", [tree, "-xdev", "(", "-type", "s", "-o", "-type", "p", "-o", "-type", "b", "-o", "-type", "c", ")", "-print", "-quit"], { env: HOST_ENV, timeout: CALL_MS });
  if (stdout.trim()) throw new Error(`load jail: ${tree} holds a socket, FIFO or device (${stdout.trim()})`);
}

/** A supervisor that was killed leaves its folders; reuse is safe only once its unit is gone. */
async function removeStale(unit: string, dir: string, runId: string): Promise<void> {
  if (!(await becomesInactive(unit, 0))) throw new Error(`load jail: ${unit} is still running`);
  await sudo("/usr/bin/rm", "-rf", dir, rootDir(runId));
}

export interface Ctl {
  ready: Promise<void>;
  exit: Promise<JailExit>;
  /** The control socket closed (EOF or error). */
  closed: Promise<void>;
  send(frame: CtlFrame): void;
  /** Every frame after `hello`. Returns an unsubscribe. */
  onFrame(listener: (frame: CtlFrame) => void): () => void;
}

/** Accepts exactly one connection that presents the nonce, then stops listening. Any other is dropped. Exported for tests. */
export function acceptCtl(server: net.Server, nonce: string): Promise<Ctl> {
  const others = new Set<net.Socket>();
  return new Promise((resolve, reject) => {
    server.on("error", reject);
    server.on("connection", (socket) => {
      others.add(socket);
      socket.once("close", () => others.delete(socket));
      const lines = new LineSplitter();
      let hello = false;
      let markReady!: () => void;
      let failReady!: (error: Error) => void;
      let markExit!: (exit: JailExit) => void;
      let markClosed!: () => void;
      const ready = new Promise<void>((r, j) => ((markReady = r), (failReady = j)));
      ready.catch(() => undefined);
      const exit = new Promise<JailExit>((r) => (markExit = r));
      const closed = new Promise<void>((r) => (markClosed = r));
      const listeners = new Set<(frame: CtlFrame) => void>();
      socket.setEncoding("utf8");
      socket.setTimeout(10_000, () => !hello && socket.destroy());
      socket.on("error", () => socket.destroy());
      socket.on("data", (chunk: string) => {
        const got = lines.push(chunk);
        if (got === null) return socket.destroy();
        for (const line of got) {
          const frame = decode(line);
          if (!hello) {
            if (frame?.type !== "hello" || !sameNonce(frame.nonce, nonce)) return socket.destroy();
            hello = true;
            socket.setTimeout(0);
            // Init closing its control socket before ready means it will never be ready.
            socket.once("close", () => {
              failReady(new Error("load jail's init closed its control socket before ready"));
              markClosed();
            });
            server.close();
            others.delete(socket);
            for (const other of others) other.destroy();
            resolve({
              ready,
              exit,
              closed,
              send: (f) => void (socket.writable && socket.write(encode(f))),
              onFrame: (l) => (listeners.add(l), () => void listeners.delete(l)),
            });
            continue;
          }
          // A line init would never send: the channel is not to be trusted any more.
          if (!frame) return socket.destroy();
          if (frame.type === "ready") markReady();
          else if (frame.type === "exit") markExit({ code: frame.code, signal: frame.signal });
          for (const l of [...listeners]) l(frame);
        }
      });
    });
  });
}

async function sudo(...args: string[]): Promise<void> {
  await exec("/usr/bin/sudo", ["-n", ...args], { env: HOST_ENV, timeout: CALL_MS });
}

async function controlGroup(unit: string): Promise<string> {
  for (let i = 0; i < 50; i++) {
    const { stdout } = await exec("/usr/bin/systemctl", ["show", "-p", "ControlGroup", "--value", `${unit}.service`], { env: HOST_ENV, timeout: CALL_MS }).catch(() => ({ stdout: "" }));
    if (stdout.trim()) return stdout.trim();
    await sleep(100);
  }
  return "";
}

async function becomesInactive(unit: string, ms: number): Promise<boolean> {
  const until = performance.now() + ms;
  do {
    const { stdout } = await exec("/usr/bin/systemctl", ["is-active", `${unit}.service`], { env: HOST_ENV, timeout: CALL_MS }).catch((e: { stdout?: string }) => ({ stdout: e.stdout ?? "" }));
    if (["inactive", "failed"].includes(stdout.trim())) return true;
    await sleep(100);
  } while (performance.now() < until);
  return false;
}

async function cgroupEmpties(cgroup: string, ms: number): Promise<boolean> {
  const until = performance.now() + ms;
  do {
    const events = await readFile(`/sys/fs/cgroup${cgroup}/cgroup.events`, "utf8").catch((e: NodeJS.ErrnoException) => (e.code === "ENOENT" ? "gone" : ""));
    if (events === "gone" || /^populated 0$/m.test(events)) return true;
    await sleep(100);
  } while (performance.now() < until);
  return false;
}

async function childGone(child: ReturnType<typeof spawn>, ms: number): Promise<boolean> {
  if (child.exitCode !== null || child.signalCode !== null) return true;
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(false), ms);
    child.once("exit", () => (clearTimeout(timer), resolve(true)));
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
