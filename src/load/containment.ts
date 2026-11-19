/**
 * Invocation-owned containment for the executor, set up before it runs any customer code
 * (T4). In order of preference:
 *
 *   pid-namespace  `unshare --pid --fork --kill-child`, as root or through `sudo -n`. The
 *                  executor is the namespace's init; when it dies the kernel kills every
 *                  process in the namespace, double-forked and `setsid` ones included.
 *   cgroup         a cgroup v2 directory created for this invocation under our own cgroup.
 *                  The executor is moved into it before it is told to go, so every process in
 *                  it is ours, and stop writes `cgroup.kill`.
 *   limited        a process-group kill only. A descendant that calls `setsid` escapes it;
 *                  the result says so.
 *
 * Nothing is ever killed by scanning `/proc` for processes we did not start.
 */
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmdirSync, writeFileSync } from "node:fs";
import path from "node:path";

export type ContainmentLevel = "pid-namespace" | "cgroup" | "limited";

export interface ContainmentOptions {
  /** Force a level (tests, and a runner that is known not to support the others). */
  prefer?: ContainmentLevel | "auto";
  /** A name unique to this invocation, used for the cgroup directory. */
  name: string;
}

export interface Privilege {
  /** Whether we are root. */
  root: boolean;
  /** Whether `sudo -n` works without a password. */
  sudo: boolean;
}

export interface ContainedProcess {
  child: ChildProcess;
  level: ContainmentLevel;
  /** Why a better level was not available, when it was not. */
  limitedBecause: string | null;
  /** Whether the executor started as root inside the containment (so it can drop to 65534). */
  startsAsRoot: boolean;
  /** Puts the process where it can be killed whole; call before telling it to go. */
  enclose(): void;
  /** Learns the executor's pid as the host sees it (the namespace init's). */
  setHostPid(pid: number): void;
  /** Kills everything inside. Safe to call more than once. */
  kill(): void;
  /** Removes what was created for this invocation (the cgroup directory). */
  dispose(): void;
}

let privilegeCache: Privilege | null = null;

export function privilege(): Privilege {
  if (privilegeCache) return privilegeCache;
  const root = typeof process.getuid === "function" && process.getuid() === 0;
  let sudo = false;
  if (!root) {
    const probe = spawnSync("sudo", ["-n", "true"], { stdio: "ignore", timeout: 5_000 });
    sudo = probe.status === 0;
  }
  privilegeCache = { root, sudo };
  return privilegeCache;
}

function canUnshare(p: Privilege): boolean {
  const prefix = p.root ? [] : ["sudo", "-n"];
  if (!p.root && !p.sudo) return false;
  const [cmd, ...args] = [...prefix, "unshare", "--pid", "--fork", "--kill-child", "true"];
  const probe = spawnSync(cmd!, args, { stdio: "ignore", timeout: 5_000 });
  return probe.status === 0;
}

/** Our own cgroup v2 directory, when one is mounted and writable. */
export function cgroupV2Dir(): string | null {
  let mountinfo: string;
  let self: string;
  try {
    mountinfo = readFileSync("/proc/self/mountinfo", "utf8");
    self = readFileSync("/proc/self/cgroup", "utf8");
  } catch {
    return null;
  }
  const mount = mountinfo
    .split("\n")
    .map((line) => line.split(" "))
    .find((fields) => fields[fields.indexOf("-") + 1] === "cgroup2");
  const relative = self.split("\n").find((line) => line.startsWith("0::"))?.slice(3);
  if (!mount || relative === undefined) return null;
  return path.join(mount[4]!, relative);
}

function makeCgroup(name: string): string | null {
  const base = cgroupV2Dir();
  if (!base) return null;
  const dir = path.join(base, `peeps-load-${name}`);
  try {
    mkdirSync(dir);
  } catch {
    return null;
  }
  if (!existsSync(path.join(dir, "cgroup.procs"))) {
    try {
      rmdirSync(dir);
    } catch {
      // nothing to undo
    }
    return null;
  }
  return dir;
}

function killCgroup(dir: string): void {
  if (existsSync(path.join(dir, "cgroup.kill"))) {
    try {
      writeFileSync(path.join(dir, "cgroup.kill"), "1");
      return;
    } catch {
      // fall through to killing what is listed: every pid there is ours
    }
  }
  try {
    for (const pid of readFileSync(path.join(dir, "cgroup.procs"), "utf8").split("\n").filter(Boolean)) {
      try {
        process.kill(Number(pid), "SIGKILL");
      } catch {
        // already gone
      }
    }
  } catch {
    // directory gone
  }
}

interface SpawnSpec {
  command: string;
  args: string[];
  env: NodeJS.ProcessEnv;
  cwd: string;
}

/** Starts `spec` inside the best containment available (or the one preferred). */
export function spawnContained(spec: SpawnSpec, options: ContainmentOptions): ContainedProcess {
  const p = privilege();
  const prefer = options.prefer ?? "auto";
  const reasons: string[] = [];

  if (prefer === "auto" || prefer === "pid-namespace") {
    if (canUnshare(p)) return spawnInPidNamespace(spec, p);
    reasons.push(p.root || p.sudo ? "unshare --pid is not permitted here" : "neither root nor sudo");
  }
  if (prefer === "auto" || prefer === "cgroup") {
    const dir = makeCgroup(options.name);
    if (dir) return spawnInCgroup(spec, dir, p);
    reasons.push("no writable cgroup v2 directory");
  }
  return spawnLimited(spec, reasons.join("; ") || "limited containment was requested", p);
}

const STDIO: ("pipe")[] = ["pipe", "pipe", "pipe"];

function spawnInPidNamespace(spec: SpawnSpec, p: Privilege): ContainedProcess {
  const unshare = ["unshare", "--pid", "--fork", "--kill-child", "--", spec.command, ...spec.args];
  let child: ChildProcess;
  if (p.root) {
    child = spawn(unshare[0]!, unshare.slice(1), { env: spec.env, cwd: spec.cwd, stdio: STDIO, detached: true });
  } else {
    // sudo resets the environment; `env -i` hands over exactly the allowlisted one.
    const assignments = Object.entries(spec.env).flatMap(([k, v]) => (v === undefined ? [] : [`${k}=${v}`]));
    child = spawn("sudo", ["-n", "env", "-i", ...assignments, ...unshare], { cwd: spec.cwd, stdio: STDIO, detached: true });
  }
  let hostPid: number | null = null;
  let killed = false;
  return {
    child,
    level: "pid-namespace",
    limitedBecause: null,
    startsAsRoot: true,
    enclose() {},
    setHostPid(pid) {
      hostPid = pid;
    },
    kill() {
      if (killed) return;
      killed = true;
      // Once unshare has been reaped, its namespace's init is long gone (--kill-child) and the
      // pids it had may belong to someone else now: signal nothing.
      if (child.exitCode !== null || child.signalCode !== null) return;
      // The namespace's init dies, so the kernel kills everything in the namespace.
      if (hostPid !== null) {
        if (p.root) {
          try {
            process.kill(hostPid, "SIGKILL");
          } catch {
            // already gone
          }
        } else {
          spawnSync("sudo", ["-n", "kill", "-KILL", String(hostPid)], { stdio: "ignore", timeout: 5_000 });
        }
      }
      // And unshare (or sudo) itself: --kill-child kills init when unshare dies.
      try {
        if (child.pid) process.kill(-child.pid, "SIGKILL");
      } catch {
        // already gone, or (sudo) not ours to signal
      }
      if (!p.root && child.pid) spawnSync("sudo", ["-n", "kill", "-KILL", String(child.pid)], { stdio: "ignore", timeout: 5_000 });
    },
    dispose() {},
  };
}

function spawnInCgroup(spec: SpawnSpec, dir: string, p: Privilege): ContainedProcess {
  const child = spawn(spec.command, spec.args, { env: spec.env, cwd: spec.cwd, stdio: STDIO, detached: true });
  let enclosed = false;
  return {
    child,
    level: "cgroup",
    limitedBecause: null,
    startsAsRoot: p.root,
    enclose() {
      if (enclosed || !child.pid) return;
      writeFileSync(path.join(dir, "cgroup.procs"), String(child.pid));
      enclosed = true;
    },
    setHostPid() {},
    kill() {
      killCgroup(dir);
      try {
        if (child.pid) process.kill(-child.pid, "SIGKILL");
      } catch {
        // already gone
      }
    },
    dispose() {
      for (let i = 0; i < 50; i++) {
        try {
          rmdirSync(dir);
          return;
        } catch {
          killCgroup(dir);
          spawnSync("sleep", ["0.02"]);
        }
      }
    },
  };
}

function spawnLimited(spec: SpawnSpec, because: string, p: Privilege): ContainedProcess {
  const child = spawn(spec.command, spec.args, { env: spec.env, cwd: spec.cwd, stdio: STDIO, detached: true });
  return {
    child,
    level: "limited",
    limitedBecause: because,
    startsAsRoot: p.root,
    enclose() {},
    setHostPid() {},
    kill() {
      try {
        if (child.pid) process.kill(-child.pid, "SIGKILL");
      } catch {
        // already gone
      }
    },
    dispose() {},
  };
}
