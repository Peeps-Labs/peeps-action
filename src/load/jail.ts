/**
 * Starts and ends the load jail (plan v3 §3). The jail is a transient systemd
 * unit whose main process, the outer watcher, holds the lifeline: this process's
 * pipe to sudo's stdin. Closing it, or this process dying, ends the unit and
 * systemd kills its whole cgroup. Nothing here signals a PID.
 */
import { execFile, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import net from "node:net";
import { promisify } from "node:util";
import { decode, encode, LineSplitter, sameNonce, type CtlFrame } from "./jail/ctl";
import { RELAY_UID, socketDir, specProblems, systemdRunArgs, unitName, type JailSpec } from "./jail/spec";

const exec = promisify(execFile);
const HEARTBEAT_MS = 1000;
const STOP_GRACE_MS = 2000;
const EMPTY_WAIT_MS = 3000;

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
  /** Lets the executor start. Call once, after admission. */
  start(): void;
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
  /** "pipe" exposes the jail's stdout on the handle; by default it is this process's. */
  stdout?: "inherit" | "pipe";
}

export async function startJail(spec: JailSpec, options: StartJailOptions): Promise<JailHandle> {
  const problems = specProblems(spec);
  if (problems.length > 0) throw new Error(`load jail: ${problems.join("; ")}`);
  const unit = unitName(spec.runId);
  const dir = socketDir(spec.runId);
  const nonce = randomBytes(32).toString("hex");

  // Bind both sockets in place, then lock the folder: moving a listening socket
  // across file systems leaves it with no listener (E0 run 3).
  await sudo("mkdir", "-m", "0700", dir);
  await sudo("chown", String(process.getuid!()), dir);
  const proxy = await options.listenProxy(`${dir}/proxy.sock`);
  const ctlServer = net.createServer();
  await new Promise<void>((resolve, reject) => ctlServer.once("error", reject).listen(`${dir}/ctl.sock`, resolve));
  await sudo("chown", `root:${RELAY_UID}`, dir, `${dir}/proxy.sock`);
  await sudo("chown", "root:root", `${dir}/ctl.sock`);
  await sudo("chmod", "0660", `${dir}/proxy.sock`);
  await sudo("chmod", "0600", `${dir}/ctl.sock`);
  await sudo("chmod", "0710", dir);

  const ctl = acceptCtl(ctlServer, nonce);
  const child = spawn("sudo", ["-n", ...systemdRunArgs(spec)], { stdio: ["pipe", options.stdout ?? "inherit", "inherit"] });
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
      lifeline.destroy();
      ctlServer.close();
      if (!(await becomesInactive(unit, STOP_GRACE_MS))) await sudo("systemctl", "stop", `${unit}.service`).catch(() => undefined);
      const group = await cgroup;
      const clean = group ? await cgroupEmpties(group, EMPTY_WAIT_MS) : await becomesInactive(unit, 0);
      proxy.close();
      await sudo("rm", "-rf", dir).catch(() => undefined);
      return { clean, ms: Math.round(performance.now() - t0) };
    })());

  child.once("exit", () => void end());

  const ready = ctl.then((c) => c.ready);
  const exited = new Promise<JailExit>((resolve) => {
    ctl.then((c) => c.exit.then(resolve), () => resolve({ code: null, signal: null }));
    child.once("exit", () => setTimeout(() => resolve({ code: null, signal: null }), 100));
  });
  return {
    unit,
    ready,
    start: () => void ctl.then((c) => c.send({ type: "start" })),
    exited,
    end,
    stdout: child.stdout,
  };
}

interface Ctl {
  ready: Promise<void>;
  exit: Promise<JailExit>;
  send(frame: CtlFrame): void;
}

/** Accepts exactly one connection that presents the nonce, then stops listening. Any other is dropped. */
function acceptCtl(server: net.Server, nonce: string): Promise<Ctl> {
  return new Promise((resolve, reject) => {
    server.on("error", reject);
    server.on("connection", (socket) => {
      const lines = new LineSplitter();
      let hello = false;
      let markReady!: () => void;
      let markExit!: (exit: JailExit) => void;
      const ready = new Promise<void>((r) => (markReady = r));
      const exit = new Promise<JailExit>((r) => (markExit = r));
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
            server.close();
            resolve({ ready, exit, send: (f) => socket.write(encode(f)) });
          } else if (frame?.type === "ready") markReady();
          else if (frame?.type === "exit") markExit({ code: frame.code, signal: frame.signal });
        }
      });
    });
  });
}

async function sudo(...args: string[]): Promise<void> {
  await exec("sudo", ["-n", ...args]);
}

async function controlGroup(unit: string): Promise<string> {
  for (let i = 0; i < 50; i++) {
    const { stdout } = await exec("systemctl", ["show", "-p", "ControlGroup", "--value", `${unit}.service`]).catch(() => ({ stdout: "" }));
    if (stdout.trim()) return stdout.trim();
    await sleep(100);
  }
  return "";
}

async function becomesInactive(unit: string, ms: number): Promise<boolean> {
  const until = performance.now() + ms;
  do {
    const { stdout } = await exec("systemctl", ["is-active", `${unit}.service`]).catch((e: { stdout?: string }) => ({ stdout: e.stdout ?? "" }));
    if (!["active", "activating", "deactivating", "reloading"].includes(stdout.trim())) return true;
    await sleep(100);
  } while (performance.now() < until);
  return false;
}

async function cgroupEmpties(cgroup: string, ms: number): Promise<boolean> {
  const until = performance.now() + ms;
  do {
    const events = await readFile(`/sys/fs/cgroup${cgroup}/cgroup.events`, "utf8").catch(() => "gone");
    if (events === "gone" || /^populated 0$/m.test(events)) return true;
    await sleep(100);
  } while (performance.now() < until);
  return false;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
