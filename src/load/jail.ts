/**
 * Starts and ends the load jail (plan v3 §3). The jail is a transient systemd
 * unit whose main process, the outer watcher, holds the lifeline: this process's
 * pipe to sudo's stdin. Closing it, or this process dying, ends the unit and
 * systemd kills its whole cgroup. Nothing here signals a PID.
 */
import { execFile, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { readFile, realpath } from "node:fs/promises";
import { PassThrough } from "node:stream";
import { StringDecoder } from "node:string_decoder";
import net from "node:net";
import { promisify } from "node:util";
import { decode, encode, LineSplitter, sameNonce, type CtlFrame } from "./jail/ctl";
import { neutralize, RELAY_UID, rootDir, socketDir, specProblems, systemdRunArgs, unitName, type JailSpec } from "./jail/spec";

const exec = promisify(execFile);
const HEARTBEAT_MS = 1000;
const STOP_GRACE_MS = 2000;
const EMPTY_WAIT_MS = 3000;
const READY_MS = 60_000;
const CALL_MS = 15_000;

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
  /** "pipe" exposes the jail's stdout on the handle; by default it goes to this process's. Either way workflow commands in it are neutralized. */
  stdout?: "inherit" | "pipe";
}

export async function startJail(spec: JailSpec, options: StartJailOptions): Promise<JailHandle> {
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
    await sudo("mkdir", "-m", "0700", dir);
    await sudo("chown", String(process.getuid!()), dir);
    proxy = await options.listenProxy(`${dir}/proxy.sock`);
    proxy.on("connection", (socket: net.Socket) => {
      proxySockets.add(socket);
      socket.once("close", () => proxySockets.delete(socket));
    });
    await new Promise<void>((resolve, reject) => ctlServer.once("error", reject).listen(`${dir}/ctl.sock`, resolve));
    await sudo("chown", `root:${RELAY_UID}`, dir, `${dir}/proxy.sock`);
    await sudo("chown", "root:root", `${dir}/ctl.sock`);
    await sudo("chmod", "0660", `${dir}/proxy.sock`);
    await sudo("chmod", "0600", `${dir}/ctl.sock`);
    await sudo("chmod", "0710", dir);
  } catch (error) {
    proxy?.close();
    ctlServer.close();
    await sudo("rm", "-rf", dir).catch(() => undefined);
    throw error;
  }
  const gate = proxy;

  const ctl = acceptCtl(ctlServer, nonce);
  ctl.catch(() => undefined);
  // Never hand the job's log the jail's raw output: the runner reads workflow commands there.
  const child = spawn("sudo", ["-n", ...systemdRunArgs(spec)], { stdio: ["pipe", "pipe", "pipe"] });
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
      if (!group || !(await becomesInactive(unit, STOP_GRACE_MS))) await sudo("systemctl", "stop", `${unit}.service`).catch(() => undefined);
      // With no cgroup path the unit may not have registered yet: clean only once systemd-run itself is gone too.
      const clean = group ? await cgroupEmpties(group, EMPTY_WAIT_MS) : (await childGone(child, EMPTY_WAIT_MS)) && (await becomesInactive(unit, 0));
      await sudo("rm", "-rf", dir, rootDir(spec.runId)).catch(() => undefined);
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
  return {
    unit,
    ready,
    start: () => void ready.then(() => ctl).then((c) => ending === undefined && c.send({ type: "start" }), () => undefined),
    exited,
    end,
    stdout: options.stdout === "pipe" ? stdout : null,
  };
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
  const { stdout } = await exec("find", [tree, "-xdev", "(", "-type", "s", "-o", "-type", "p", "-o", "-type", "b", "-o", "-type", "c", ")", "-print", "-quit"]);
  if (stdout.trim()) throw new Error(`load jail: ${tree} holds a socket, FIFO or device (${stdout.trim()})`);
}

/** A supervisor that was killed leaves its folders; reuse is safe only once its unit is gone. */
async function removeStale(unit: string, dir: string, runId: string): Promise<void> {
  if (!(await becomesInactive(unit, 0))) throw new Error(`load jail: ${unit} is still running`);
  await sudo("rm", "-rf", dir, rootDir(runId));
}

export interface Ctl {
  ready: Promise<void>;
  exit: Promise<JailExit>;
  send(frame: CtlFrame): void;
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
      const ready = new Promise<void>((r, j) => ((markReady = r), (failReady = j)));
      ready.catch(() => undefined);
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
            // Init closing its control socket before ready means it will never be ready.
            socket.once("close", () => failReady(new Error("load jail's init closed its control socket before ready")));
            server.close();
            others.delete(socket);
            for (const other of others) other.destroy();
            resolve({ ready, exit, send: (f) => socket.write(encode(f)) });
          } else if (frame?.type === "ready") markReady();
          else if (frame?.type === "exit") markExit({ code: frame.code, signal: frame.signal });
        }
      });
    });
  });
}

async function sudo(...args: string[]): Promise<void> {
  await exec("sudo", ["-n", ...args], { timeout: CALL_MS });
}

async function controlGroup(unit: string): Promise<string> {
  for (let i = 0; i < 50; i++) {
    const { stdout } = await exec("systemctl", ["show", "-p", "ControlGroup", "--value", `${unit}.service`], { timeout: CALL_MS }).catch(() => ({ stdout: "" }));
    if (stdout.trim()) return stdout.trim();
    await sleep(100);
  }
  return "";
}

async function becomesInactive(unit: string, ms: number): Promise<boolean> {
  const until = performance.now() + ms;
  do {
    const { stdout } = await exec("systemctl", ["is-active", `${unit}.service`], { timeout: CALL_MS }).catch((e: { stdout?: string }) => ({ stdout: e.stdout ?? "" }));
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
