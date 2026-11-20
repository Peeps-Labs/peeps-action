/**
 * The jail's init (bundled as load-init.js). It runs as root and pid 1 in fresh
 * net, pid, mount, ipc and uts namespaces, built by the outer watcher.
 *
 * - `isolate` builds a minimal root from read-only staged inputs and pivots into it.
 * - `serveControl` serves the control socket (e4 plan v3 §2.1): a `start` ticket runs the
 *   install (`npm rebuild`, offline) as the executor's uid and answers `installed`; a `launch`
 *   ticket, accepted only after that, starts the executor with frames in on its fd 0 and out on
 *   its fd 3, and answers `launched`. Each ticket is used once, for this claim, before both of
 *   its deadlines; a stale or foreign one is refused without being used up. Then init relays
 *   the executor's frames both ways. A line that is malformed, unknown, in the wrong
 *   direction or too long, a queue over 1 MiB, or a broken pipe ends the jail with
 *   `exit {signal: "protocol"}`: init exits, and the pid namespace takes every process with it.
 * - `--relay` is the relay: uid 65533, 127.0.0.1:3128 to the supervisor's proxy socket.
 * - `--probe <host:port>` is Peeps' own self-test, run as the executor would be.
 *
 * Init never imports the loader, a journey or Playwright.
 */
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { chmodSync, chownSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, readlinkSync, rmdirSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import net from "node:net";
import type { Duplex, Readable, Writable } from "node:stream";
import { consumeTicket, decode, encode, LineSplitter, newTicketState, relayable, type CtlFrame, type RefusedReason } from "./ctl";
import { dropArgs, executorEnv, IN_JAIL, rebuildEnv, RELAY_UID, rootDir, type InitConfig } from "./spec";

/** A relay queue (to the executor's stdin, or to the control socket) longer than this ends the jail. */
export const MAX_QUEUE_BYTES = 1024 * 1024;

function run(cmd: string, args: string[]): void {
  execFileSync(cmd, args, { stdio: ["ignore", "ignore", "inherit"] });
}

function bindReadOnly(source: string, target: string): void {
  run("mount", ["--bind", source, target]);
  run("mount", ["-o", "remount,bind,ro,nosuid,nodev", target]);
}

/** Builds the jail's root and pivots into it. Inputs are staged before anything is masked (Sol r2 1). */
export function isolate(config: InitConfig): void {
  run("mount", ["--make-rprivate", "/"]);
  const root = rootDir(config.runId);
  mkdirSync(root, { recursive: true });
  run("mount", ["-t", "tmpfs", "-o", "mode=755,nosuid,nodev,size=16m", "tmpfs", root]);
  const at = (p: string) => `${root}${p}`;
  for (const dir of ["/usr", "/etc", "/dev", "/proc", "/tmp", "/oldroot", "/run/peeps/ws-lower", IN_JAIL.workspace, IN_JAIL.node, IN_JAIL.action, IN_JAIL.home, "/run/peeps/up", IN_JAIL.sockets]) {
    mkdirSync(at(dir), { recursive: true });
  }

  // 1. Staged inputs, read-only.
  bindReadOnly(config.workspace, at("/run/peeps/ws-lower"));
  bindReadOnly(config.nodeDir, at(IN_JAIL.node));
  bindReadOnly(config.actionDir, at(IN_JAIL.action));
  if (config.caPem) {
    writeFileSync(at(IN_JAIL.ca), "");
    bindReadOnly(config.caPem, at(IN_JAIL.ca));
  }
  run("mount", ["--bind", config.socketDir, at(IN_JAIL.sockets)]);
  run("mount", ["-o", "remount,bind,nosuid,nodev,noexec", at(IN_JAIL.sockets)]);

  // 2. A minimal system.
  bindReadOnly("/usr", at("/usr"));
  for (const name of ["bin", "sbin", "lib", "lib64", "lib32", "libx32"]) {
    const host = `/${name}`;
    if (!existsSync(host)) continue;
    if (lstatSync(host).isSymbolicLink()) symlinkSync(readlinkSync(host), at(host));
    else {
      mkdirSync(at(host));
      bindReadOnly(host, at(host));
    }
  }
  for (const dir of ["ssl", "alternatives"]) {
    if (!existsSync(`/etc/${dir}`)) continue;
    mkdirSync(at(`/etc/${dir}`));
    bindReadOnly(`/etc/${dir}`, at(`/etc/${dir}`));
  }
  for (const file of ["ld.so.cache", "passwd", "group", "nsswitch.conf", "hosts"]) {
    if (!existsSync(`/etc/${file}`)) continue;
    writeFileSync(at(`/etc/${file}`), "");
    bindReadOnly(`/etc/${file}`, at(`/etc/${file}`));
  }
  run("mount", ["-t", "tmpfs", "-o", "mode=755,nosuid", "tmpfs", at("/dev")]);
  for (const node of ["null", "zero", "urandom", "random", "tty"]) {
    writeFileSync(at(`/dev/${node}`), "");
    run("mount", ["--bind", `/dev/${node}`, at(`/dev/${node}`)]);
  }
  run("mount", ["-t", "tmpfs", "-o", "mode=1777,nosuid,nodev,size=256m", "tmpfs", at("/tmp")]);
  run("mount", ["-t", "tmpfs", "-o", "mode=1777,nosuid,nodev,size=256m", "tmpfs", at(IN_JAIL.home)]);

  // 3. The workspace: writes land in a capped tmpfs, never in the checkout.
  run("mount", ["-t", "tmpfs", "-o", "size=512m,mode=755,nosuid,nodev", "tmpfs", at("/run/peeps/up")]);
  mkdirSync(at("/run/peeps/up/upper"));
  // The overlay's root takes the upper folder's owner and mode, so match the checkout's.
  const lower = statSync(config.workspace);
  chownSync(at("/run/peeps/up/upper"), lower.uid, lower.gid);
  chmodSync(at("/run/peeps/up/upper"), lower.mode & 0o7777);
  mkdirSync(at("/run/peeps/up/work"));
  run("mount", ["-t", "overlay", "overlay", "-o", `nosuid,nodev,lowerdir=${at("/run/peeps/ws-lower")},upperdir=${at("/run/peeps/up/upper")},workdir=${at("/run/peeps/up/work")}`, at(IN_JAIL.workspace)]);
  // The overlay holds its own references: hide its backing folders from the executor.
  run("umount", ["-l", at("/run/peeps/up")]);
  run("umount", ["-l", at("/run/peeps/ws-lower")]);
  rmdirSync(at("/run/peeps/up"));
  rmdirSync(at("/run/peeps/ws-lower"));

  // 4. Loopback, then pivot. /proc is mounted before the old root goes: umount reads it.
  run("ip", ["link", "set", "lo", "up"]);
  process.chdir(root);
  run("pivot_root", [".", "oldroot"]);
  process.chdir("/");
  run("mount", ["-t", "proc", "-o", "nosuid,nodev,noexec", "proc", "/proc"]);
  run("umount", ["-l", "/oldroot"]);
  rmdirSync("/oldroot");
}

function connectCtl(nonce: string): Promise<net.Socket> {
  return new Promise((resolve, reject) => {
    const socket = net.connect(`${IN_JAIL.sockets}/ctl.sock`);
    socket.once("connect", () => {
      socket.write(encode({ type: "hello", nonce }));
      resolve(socket);
    });
    socket.once("error", reject);
  });
}

function startRelay(config: InitConfig): Promise<ChildProcess> {
  return new Promise((resolve, reject) => {
    const relay = spawn("/usr/bin/setpriv", [...dropArgs(RELAY_UID, RELAY_UID), config.nodeInJail, config.initInJail, "--relay"], {
      stdio: ["ignore", "pipe", "inherit"],
      env: {},
      cwd: "/",
    });
    relay.stdout!.setEncoding("utf8");
    relay.stdout!.once("data", (line: string) => (line.startsWith("relay ready") ? resolve(relay) : reject(new Error(line))));
    relay.once("exit", (code) => reject(new Error(`relay exited ${code}`)));
  });
}

export interface ControlIo {
  /** Starts the install as the executor's uid; null when the spec has none. */
  install(): ChildProcess | null;
  /** Starts the executor, its fd 0 and fd 3 piped. */
  executor(): ChildProcess;
  /** CLOCK_MONOTONIC and the wall clock, in ms. */
  now(): { monoMs: number; wallMs: number };
  /** The jail is over: init exits, and the pid namespace ends every process in it. */
  end(): void;
}

const REFUSED: Record<"stale" | "used" | "foreign" | "early", RefusedReason> = { stale: "stale_ticket", used: "used_ticket", foreign: "foreign_ticket", early: "early_ticket" };

/** Serves the control socket after `ready`: tickets, the install, the executor, and the relay. */
export function serveControl(ctl: Duplex, config: Pick<InitConfig, "claimId">, io: ControlIo): void {
  const tickets = newTicketState();
  let executor: ChildProcess | undefined;
  let over = false;
  const finish = (code: number | null, signal: string | null) => {
    if (over) return;
    over = true;
    ctl.write(encode({ type: "exit", code, signal }));
    io.end();
  };
  const violation = () => finish(null, "protocol");
  /** Writes one frame to the supervisor; false when the socket is backed up. */
  const send = (frame: CtlFrame): boolean => {
    if (over) return true;
    const flowing = ctl.write(encode(frame));
    if (ctl.writableLength > MAX_QUEUE_BYTES) violation();
    return flowing;
  };

  const install = () => {
    const t0 = io.now().monoMs;
    const child = io.install();
    if (!child) {
      tickets.installed = true;
      send({ type: "installed", code: 0, signal: null, ms: 0 });
      return;
    }
    let done = false;
    const report = (code: number | null, signal: string | null) => {
      if (done) return;
      done = true;
      if (code === 0) tickets.installed = true;
      send({ type: "installed", code, signal, ms: Math.max(0, Math.round(io.now().monoMs - t0)) });
    };
    child.once("error", () => report(null, "spawn_error"));
    child.once("exit", (code, signal) => report(code, signal));
  };

  const launch = () => {
    const child = io.executor();
    executor = child;
    const stdin = child.stdin as Writable;
    const fd3 = child.stdio[3] as Readable;
    stdin.on("error", () => child.exitCode === null && child.signalCode === null && violation());
    const lines = new LineSplitter();
    fd3.setEncoding("utf8");
    fd3.on("error", violation);
    // An exit after half a frame is not a clean exit.
    fd3.once("end", () => {
      if (lines.incomplete) violation();
    });
    fd3.on("data", (chunk: string) => {
      if (over) return;
      const got = lines.push(chunk);
      if (got === null) return violation();
      for (const line of got) {
        const frame = decode(line);
        if (!frame || !relayable(frame, "executor")) return violation();
        // The supervisor is behind: stop reading the executor until it catches up.
        if (!send(frame)) {
          fd3.pause();
          ctl.once("drain", () => fd3.resume());
        }
        if (over) return;
      }
    });
    child.once("error", () => finish(null, "spawn_error"));
    // After its stdio closed, so every frame it wrote is relayed first.
    child.once("close", (code, signal) => finish(code, signal));
    send({ type: "launched" });
  };

  const lines = new LineSplitter();
  ctl.setEncoding("utf8");
  ctl.once("end", () => {
    if (lines.incomplete) violation();
  });
  ctl.on("data", (chunk: string) => {
    if (over) return;
    const got = lines.push(chunk);
    if (got === null) return violation();
    for (const line of got) {
      const frame = decode(line);
      if (!frame) return violation();
      if (frame.type === "start" || frame.type === "launch") {
        const verdict = consumeTicket(frame.type, frame.ticket, io.now(), config, tickets);
        if (verdict !== "ok") send({ type: "refused", reason: REFUSED[verdict] });
        else if (frame.type === "start") install();
        else launch();
        if (over) return;
        continue;
      }
      if (!relayable(frame, "supervisor") || !executor) return violation();
      const stdin = executor.stdin as Writable;
      stdin.write(encode(frame));
      if (stdin.writableLength > MAX_QUEUE_BYTES) return violation();
    }
  });
}

function monoNow(): { monoMs: number; wallMs: number } {
  return { monoMs: Number(process.hrtime.bigint()) / 1e6, wallMs: Date.now() };
}

async function init(): Promise<void> {
  const config = JSON.parse(process.env.PEEPS_JAIL_CONFIG ?? "") as InitConfig;
  const nonce = process.env.PEEPS_CTL_NONCE ?? "";
  delete process.env.PEEPS_CTL_NONCE;
  isolate(config);
  const ctl = await connectCtl(nonce);
  ctl.on("close", () => process.exit(0));
  ctl.on("error", () => process.exit(0));
  await startRelay(config);
  ctl.write(encode({ type: "ready" }));
  const asExecutor = (env: string[], command: string[], stdio: ("pipe" | "inherit" | "ignore")[]) =>
    spawn("/usr/bin/setpriv", [...dropArgs(config.executorUid, config.executorGid), "/usr/bin/env", "-i", ...env, ...command], { stdio, cwd: IN_JAIL.workspace, env: {} });
  serveControl(ctl, config, {
    install: () => (config.install ? asExecutor(rebuildEnv(config), config.install, ["ignore", "inherit", "inherit"]) : null),
    executor: () => asExecutor(executorEnv(config), config.command, ["pipe", "inherit", "inherit", "pipe"]),
    now: monoNow,
    end: () => {
      ctl.end(() => process.exit(0));
      setTimeout(() => process.exit(0), 1000).unref();
    },
  });
}

/** 127.0.0.1:3128 to the supervisor's proxy socket. Runs as uid 65533. */
const RELAY_MAX_CONNECTIONS = 1024;
const RELAY_IDLE_MS = 120_000;

function relay(): void {
  const server = net.createServer((client) => {
    const upstream = net.connect(`${IN_JAIL.sockets}/proxy.sock`);
    const close = () => {
      client.destroy();
      upstream.destroy();
    };
    client.pipe(upstream).pipe(client);
    for (const side of [client, upstream]) {
      side.on("error", close);
      side.on("close", close);
      side.setTimeout(RELAY_IDLE_MS, close);
    }
  });
  server.maxConnections = RELAY_MAX_CONNECTIONS;
  server.listen(IN_JAIL.relayPort, "127.0.0.1", () => process.stdout.write("relay ready\n"));
}

function errno(read: () => unknown): string {
  try {
    read();
    return "readable";
  } catch (e) {
    return (e as NodeJS.ErrnoException).code ?? "error";
  }
}

/** Peeps' own self-test: every way out but the relay must fail. Prints one JSON line. */
async function probe(target: string): Promise<void> {
  const [host, port] = [target.slice(0, target.lastIndexOf(":")), Number(target.slice(target.lastIndexOf(":") + 1))];
  const tcp = (h: string, p: number, path: string) =>
    new Promise<string>((resolve) => {
      const s = net.connect(p, h);
      s.setTimeout(3000, () => (s.destroy(), resolve("timeout")));
      s.once("error", (e: NodeJS.ErrnoException) => resolve(e.code ?? "error"));
      s.once("connect", () => {
        s.write(`GET ${path} HTTP/1.0\r\nHost: ${host}\r\n\r\n`);
        resolve("connected");
        s.once("data", () => s.destroy());
        s.setTimeout(3000, () => s.destroy());
      });
    });
  const dns = await import("node:dns/promises").then((d) => d.lookup("example.com").then(() => "resolved", (e: NodeJS.ErrnoException) => e.code ?? "error"));
  const unixProxy = await new Promise<string>((resolve) => {
    const s = net.connect(`${IN_JAIL.sockets}/proxy.sock`);
    s.once("error", (e: NodeJS.ErrnoException) => resolve(e.code ?? "error"));
    s.once("connect", () => (s.destroy(), resolve("connected")));
  });
  let workspaceWrite = "written";
  try {
    writeFileSync(`${IN_JAIL.workspace}/.peeps-probe`, "x");
  } catch (e) {
    workspaceWrite = (e as NodeJS.ErrnoException).code ?? "error";
  }
  const result = {
    uid: process.getuid?.(),
    direct: await tcp(host, port, "/probe-direct"),
    relay: await tcp("127.0.0.1", IN_JAIL.relayPort, "/probe-relay"),
    dns,
    unixProxy,
    workspaceWrite,
    hostPaths: ["/home", "/oldroot", "/etc/shadow", "/var", "/root", "/mnt", "/opt"].filter((p) => existsSync(p)),
    mounts: readFileSync("/proc/self/mountinfo", "utf8").split("\n").filter(Boolean).map((l) => l.split(" ")[4]),
    procOne: errno(() => readFileSync("/proc/1/environ")),
    procOneRoot: errno(() => readdirSync("/proc/1/root")),
    procSelf: errno(() => readFileSync("/proc/self/status")),
  };
  process.stdout.write(`PEEPS-PROBE ${JSON.stringify(result)}\n`);
}

// Run as a program (the bundle), never on import (the tests import `serveControl`).
if (require.main === module) {
  const mode = process.argv[2];
  if (mode === "--relay") relay();
  else if (mode === "--probe") void probe(process.argv[3] ?? "");
  else
    init().catch((error: unknown) => {
      process.stderr.write(`peeps load jail init: ${error instanceof Error ? error.message : String(error)}\n`);
      process.exit(1);
    });
}
