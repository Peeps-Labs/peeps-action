/**
 * The jail's init (bundled as load-init.js). It runs as root and pid 1 in fresh
 * net, pid, mount, ipc and uts namespaces, built by the outer watcher.
 *
 * - `isolate` builds a minimal root from read-only staged inputs and pivots into it.
 * - `--relay` is the relay: uid 65533, 127.0.0.1:3128 to the supervisor's proxy socket.
 * - `--probe <host:port>` is Peeps' own self-test, run as the executor would be.
 *
 * Init never imports the loader, a journey or Playwright.
 */
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { chmodSync, chownSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, readlinkSync, rmdirSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import net from "node:net";
import { decode, encode, LineSplitter, type CtlFrame } from "./ctl";
import { dropArgs, executorEnv, IN_JAIL, RELAY_UID, rootDir, type InitConfig } from "./spec";

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

async function init(): Promise<void> {
  const config = JSON.parse(process.env.PEEPS_JAIL_CONFIG ?? "") as InitConfig;
  const nonce = process.env.PEEPS_CTL_NONCE ?? "";
  delete process.env.PEEPS_CTL_NONCE;
  isolate(config);
  const ctl = await connectCtl(nonce);
  const send = (frame: CtlFrame) => ctl.write(encode(frame));
  ctl.on("close", () => process.exit(0));
  ctl.on("error", () => process.exit(0));
  await startRelay(config);
  send({ type: "ready" });

  const lines = new LineSplitter();
  let started = false;
  ctl.setEncoding("utf8");
  ctl.on("data", (chunk: string) => {
    const got = lines.push(chunk);
    if (got === null) process.exit(1);
    for (const line of got) {
      if (decode(line)?.type !== "start" || started) continue;
      started = true;
      const executor = spawn(
        "/usr/bin/setpriv",
        [...dropArgs(config.executorUid, config.executorGid), "/usr/bin/env", "-i", ...executorEnv(config), ...config.command],
        { stdio: ["ignore", "inherit", "inherit"], cwd: IN_JAIL.workspace, env: {} },
      );
      executor.on("exit", (code, signal) => {
        send({ type: "exit", code, signal });
        ctl.end(() => process.exit(0));
      });
    }
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

const mode = process.argv[2];
if (mode === "--relay") relay();
else if (mode === "--probe") void probe(process.argv[3] ?? "");
else
  init().catch((error: unknown) => {
    process.stderr.write(`peeps load jail init: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  });
