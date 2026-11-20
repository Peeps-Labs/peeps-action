/**
 * A jail with no isolation, for the supervisor's tests on every platform (e4 plan v3 §2.3). It
 * keeps the real jail's contract: `ready`, tickets checked by init's own rule (`consumeTicket`),
 * the install, `launch`, frames relayed through `relayable` with `MAX_FRAME_BYTES` and the 1 MiB
 * queue rule, a latched terminal on control EOF or the executor's exit, and `end()`. The
 * executor's proxy is a TCP listener piped to the gate's socket.
 *
 * It runs only trusted fixtures (the committed executor, or a fixture script), and is never used
 * for a fence claim.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { sharedClocks } from "../../src/load/clocks";
import { NoTicket, TicketRefused, type Installed, type JailEnd, type JailExit, type JailHandle, type StartJailOptions } from "../../src/load/jail";
import { consumeTicket, decode, encode, LineSplitter, MAX_FRAME_BYTES, newTicketState, relayable, type CtlFrame, type Ticket } from "../../src/load/jail/ctl";
import type { JailSpec } from "../../src/load/jail/spec";

export const EXECUTOR = path.resolve(__dirname, "../../dist/load-executor.js");
const MAX_QUEUE = 1024 * 1024;

export interface FakeJailOptions {
  /** The executor: the committed one by default. */
  command?: string[];
  env?: Record<string, string>;
  readyDelayMs?: number;
  /** `ready` never comes. */
  neverReady?: boolean;
  installMs?: number;
  installCode?: number;
  /** Runs when init has consumed a ticket, before it acts on it (an install, a launch). */
  onTicket?: (kind: "start" | "launch") => void | Promise<void>;
  /** The control channel closes this long after ready. */
  eofAfterReadyMs?: number;
}

export interface FakeJail extends JailHandle {
  /** Tickets init was offered, and what it answered. */
  tickets: { kind: "start" | "launch"; answer: string }[];
  child: ChildProcess | undefined;
  stderr(): string;
  /** Close the control channel now (control EOF). */
  eof(): void;
  ended: boolean;
}

export function fakeJail(o: FakeJailOptions = {}) {
  const made: FakeJail[] = [];
  const launch = async (spec: JailSpec, options: StartJailOptions, signal?: AbortSignal): Promise<JailHandle> => {
    signal?.throwIfAborted();
    const dir = mkdtempSync(path.join(os.tmpdir(), "peeps-fake-jail-"));
    const sock = path.join(dir, "proxy.sock");
    const gate = await options.listenProxy(sock);
    const pipes = new Set<net.Socket>();
    const relay = net.createServer((c) => {
      const u = net.connect(sock);
      pipes.add(c).add(u);
      c.pipe(u).pipe(c);
      const done = () => {
        c.destroy();
        u.destroy();
        pipes.delete(c);
        pipes.delete(u);
      };
      c.on("error", done).on("close", done);
      u.on("error", done).on("close", done);
    });
    await new Promise<void>((resolve) => relay.listen(0, "127.0.0.1", resolve));
    const relayUrl = `http://127.0.0.1:${(relay.address() as net.AddressInfo).port}`;
    const state = newTicketState();
    const listeners = new Set<(f: CtlFrame) => void>();
    const tickets: FakeJail["tickets"] = [];
    let child: ChildProcess | undefined;
    let stderr = "";
    let terminal: Error | undefined;
    const terminalWaiters = new Set<(e: Error) => void>();
    const latch = (e: Error) => {
      if (terminal) return;
      terminal = e;
      for (const w of terminalWaiters) w(e);
      terminalWaiters.clear();
    };
    let resolveExit!: (e: JailExit) => void;
    const exited = new Promise<JailExit>((resolve) => (resolveExit = resolve));
    void exited.then(() => latch(new Error("load jail's executor exited")));
    const emit = (f: CtlFrame) => {
      if (terminal && f.type !== "exit") return;
      for (const l of [...listeners]) l(f);
    };
    const protocol = () => {
      child?.kill("SIGKILL");
      emit({ type: "exit", code: null, signal: "protocol" });
      resolveExit({ code: null, signal: "protocol" });
    };

    let readyResolve!: () => void;
    const ready = new Promise<void>((resolve) => (readyResolve = resolve));
    if (!o.neverReady) setTimeout(() => {
      readyResolve();
      if (o.eofAfterReadyMs !== undefined) setTimeout(() => handle.eof(), o.eofAfterReadyMs);
    }, o.readyDelayMs ?? 0);

    const bounded = <T>(p: Promise<T>, signal?: AbortSignal): Promise<T> =>
      new Promise<T>((resolve, reject) => {
        if (terminal) return reject(terminal);
        if (signal?.aborted) return reject(signal.reason);
        const onTerminal = (e: Error) => done(() => reject(e));
        const onAbort = () => done(() => reject(signal!.reason));
        const done = (settle: () => void) => {
          terminalWaiters.delete(onTerminal);
          signal?.removeEventListener("abort", onAbort);
          settle();
        };
        terminalWaiters.add(onTerminal);
        signal?.addEventListener("abort", onAbort, { once: true });
        p.then((v) => done(() => resolve(v)), (e: unknown) => done(() => reject(e)));
      });
    const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

    const offer = async (kind: "start" | "launch", ticketOf: () => Ticket | null): Promise<void> => {
      if (handle.ended) throw new Error("load jail is ending");
      // In one synchronous step: ask for a ticket, then "send" it: init checks it on arrival.
      const ticket = ticketOf();
      if (ticket === null) throw new NoTicket();
      const answer = consumeTicket(kind, ticket, sharedClocks(), { claimId: spec.claimId }, state);
      tickets.push({ kind, answer });
      if (answer !== "ok") throw new TicketRefused(`${answer}_ticket` as never);
      await o.onTicket?.(kind);
    };

    let installed: Promise<Installed> | undefined;
    let launched: Promise<void> | undefined;
    const handle: FakeJail = {
      unit: `fake-${spec.runId}`,
      ready,
      relayUrl,
      exited,
      stdout: null,
      tickets,
      get child() {
        return child;
      },
      ended: false,
      stderr: () => stderr,
      eof: () => latch(new Error("load jail's control socket closed")),
      start(ticketOf, sig) {
        if (installed) return Promise.reject(new Error("load jail: start was already called"));
        installed = (async () => {
          await bounded(ready, sig);
          await offer("start", ticketOf);
          if (o.installMs) await bounded(sleep(o.installMs), sig);
          if (terminal) throw terminal;
          state.installed = true;
          return { code: o.installCode ?? 0, signal: null, ms: o.installMs ?? 0 };
        })();
        installed.catch(() => undefined);
        installed.catch((e) => {
          if (e instanceof TicketRefused) installed = undefined;
        });
        return installed;
      },
      launch(ticketOf, sig) {
        if (!installed) return Promise.reject(new Error("load jail: launch before start"));
        if (launched) return Promise.reject(new Error("load jail: launch was already called"));
        const after = installed;
        launched = (async () => {
          await bounded(after, sig);
          await offer("launch", ticketOf);
          if (terminal) throw terminal;
          const [cmd, ...args] = o.command ?? [process.execPath, EXECUTOR];
          child = spawn(cmd!, args, {
            cwd: spec.workspace,
            env: { PATH: path.dirname(process.execPath) + ":/usr/bin:/bin", HOME: os.tmpdir(), ...(spec.caPem ? { NODE_EXTRA_CA_CERTS: spec.caPem } : {}), ...spec.env, ...o.env },
            stdio: ["pipe", "pipe", "pipe", "pipe"],
          });
          child.stderr!.setEncoding("utf8");
          child.stderr!.on("data", (d: string) => (stderr = (stderr + d).slice(-20_000)));
          child.stdout!.resume();
          child.stdin!.on("error", () => undefined);
          const lines = new LineSplitter();
          const fd3 = child.stdio[3] as NodeJS.ReadableStream;
          fd3.setEncoding("utf8");
          fd3.on("data", (chunk: string) => {
            const got = lines.push(chunk);
            if (!got) return protocol();
            for (const line of got) {
              const frame = decode(line);
              if (!frame || !relayable(frame, "executor") || Buffer.byteLength(line) > MAX_FRAME_BYTES) return protocol();
              emit(frame);
            }
          });
          child.once("exit", (code, sig2) => {
            emit({ type: "exit", code, signal: sig2 });
            resolveExit({ code, signal: sig2 });
          });
        })();
        launched.catch(() => undefined);
        launched.catch((e) => {
          if (e instanceof TicketRefused) launched = undefined;
        });
        return launched;
      },
      send(frame) {
        if (!relayable(frame, "supervisor")) throw new Error(`load jail: ${frame.type} is not a frame for the executor`);
        if (handle.ended || terminal || !child?.stdin) return;
        child.stdin.write(encode(frame));
        if (child.stdin.writableLength > MAX_QUEUE) protocol();
      },
      onFrame(listener) {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
      async end(): Promise<JailEnd> {
        const t0 = Date.now();
        if (!handle.ended) {
          handle.ended = true;
          latch(new Error("load jail ended"));
          gate.close();
          relay.close();
          for (const p of pipes) p.destroy();
          if (child && child.exitCode === null && child.signalCode === null) {
            child.kill("SIGKILL");
            await exited;
          }
          resolveExit({ code: null, signal: null });
          rmSync(dir, { recursive: true, force: true });
        }
        return { clean: true, ms: Date.now() - t0 };
      },
    };
    made.push(handle);
    if (signal) {
      if (signal.aborted) {
        await handle.end();
        throw signal.reason;
      }
      signal.addEventListener("abort", () => void handle.end(), { once: true });
    }
    return handle;
  };
  return { launch, made };
}
