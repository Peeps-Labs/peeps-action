/**
 * The executor's independent watchdog. The executor's own dead-man runs on the journey's
 * event loop and can only end the executor itself; a journey that blocks that loop, or a
 * descendant outside it (a cgroup member, a `setsid` grandchild), outlives it. The watchdog
 * is a separate process in its own process group with the authority to kill the whole
 * containment: it does so when the supervisor falls silent for the dead-man interval, or goes
 * away (its pipe closes). A gap in its own timer means it was paused itself (the whole job
 * was stopped), so it gives the supervisor a fresh interval then rather than killing.
 *
 * No customer input reaches it: its argument is the targets, built by the supervisor.
 */
import { spawn, type ChildProcess } from "node:child_process";

export interface WatchdogTargets {
  deadManMs: number;
  /** A cgroup to write `cgroup.kill` in (or kill each member of). */
  cgroupDir: string | null;
  /** Pids to SIGKILL; a negative one is a process group. */
  pids: number[];
  /** Whether to retry a refused kill through `sudo -n`. */
  sudo: boolean;
}

const SOURCE = `
const fs = require("fs");
const cp = require("child_process");
const t = JSON.parse(process.argv[1]);
const now = () => Number(process.hrtime.bigint()) / 1e6;
let heard = now();
let last = now();
let over = false;
function kill(why) {
  if (over) return;
  over = true;
  if (t.cgroupDir) {
    try {
      fs.writeFileSync(t.cgroupDir + "/cgroup.kill", "1");
    } catch {
      try {
        for (const p of fs.readFileSync(t.cgroupDir + "/cgroup.procs", "utf8").split("\\n").filter(Boolean)) {
          try { process.kill(Number(p), "SIGKILL"); } catch {}
        }
      } catch {}
    }
  }
  for (const pid of t.pids) {
    try {
      process.kill(pid, "SIGKILL");
    } catch (error) {
      if (t.sudo && error.code === "EPERM") cp.spawnSync("sudo", ["-n", "kill", "-KILL", "--", String(pid)], { stdio: "ignore", timeout: 5000 });
    }
  }
  try { process.stderr.write("peeps load watchdog: " + why + "\\n"); } catch {}
  process.exit(0);
}
process.stdin.on("data", (chunk) => {
  heard = now();
  if (chunk.includes(100)) { over = true; process.exit(0); }
});
process.stdin.on("end", () => kill("the supervisor went away"));
process.stdin.on("error", () => kill("the supervisor went away"));
setInterval(() => {
  const at = now();
  // Paused itself: the supervisor may have been paused with it, so it gets a fresh interval.
  if (at - last > Math.max(500, t.deadManMs / 2)) heard = at;
  last = at;
  if (at - heard > t.deadManMs) kill("the supervisor fell silent");
}, 100);
`;

export interface Watchdog {
  child: ChildProcess;
  /** The supervisor is alive. */
  beat(): void;
  /** The supervisor has stopped everything itself: the watchdog leaves without killing. */
  release(): void;
}

export function spawnWatchdog(targets: WatchdogTargets): Watchdog {
  const child = spawn(process.execPath, ["-e", SOURCE, JSON.stringify(targets)], {
    env: { PATH: process.env.PATH ?? "/usr/bin:/bin" },
    cwd: "/",
    stdio: ["pipe", "ignore", "ignore"],
    detached: true,
  });
  child.unref();
  child.stdin!.on("error", () => undefined);
  const write = (s: string) => {
    if (!child.stdin!.destroyed) child.stdin!.write(s);
  };
  return {
    child,
    beat: () => write("h"),
    release: () => {
      write("d");
      child.stdin!.end();
    },
  };
}
