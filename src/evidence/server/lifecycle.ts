/**
 * The app for one invocation (PQA-3201 PR 3): the action runs the customer's reset, starts
 * the app under the coverage preload in a process group of its own, waits until it answers,
 * runs the invocation's tests, then stops the whole group and reads what its processes ran.
 * Nothing here fails the job: whatever goes wrong is a named problem, which makes the
 * invocation's footprint partial, and the tests still run.
 */
import { spawn } from "node:child_process";
import { mkdirSync, readdirSync, readFileSync, renameSync, rmSync } from "node:fs";
import path from "node:path";
import type { InvocationCoverage, V8Script } from "./rules";

export interface AppCommand {
  /** The customer's start command, run with `sh -c` in `cwd`. */
  start: string;
  /** Answers 2xx once the app can serve. */
  readyUrl: string;
  /** Run before every invocation, with `PEEPS_INVOCATION` set; null for none. */
  reset: string | null;
  cwd: string;
  env: NodeJS.ProcessEnv;
}

/** Where one invocation's time went: the reset, the app's start to ready, the tests, the stop and coverage read. */
export interface InvocationTimings {
  resetMs: number;
  readyMs: number;
  testsMs: number;
  stopMs: number;
}

export interface InvocationOptions {
  /** Where the app's processes write coverage: created, read, then removed. */
  dir: string;
  /** The preload's absolute path. */
  preload: string;
  /** `ambient` is the run with no tests; `spec` one spec file's. */
  kind: "ambient" | "spec";
  readyTimeoutMs?: number;
  stopTimeoutMs?: number;
  /** Set the coverage aside at the stop and return a reader, instead of parsing it then. */
  defer?: boolean;
  /** Runs right after the app is spawned, while it starts: work that can overlap it. */
  whileStarting?: () => void;
}

const READY_TIMEOUT_MS = 180_000;
const STOP_TIMEOUT_MS = 30_000;
const say = (line: string) => console.log(`[peeps] ${line}`);

function shell(command: string, cwd: string, env: NodeJS.ProcessEnv): Promise<number> {
  return new Promise((resolve) => {
    const child = spawn("sh", ["-c", command], { cwd, env, stdio: ["ignore", "inherit", "inherit"] });
    child.on("error", () => resolve(1));
    child.on("close", (code) => resolve(code ?? 1));
  });
}

const groupAlive = (pid: number) => {
  try {
    process.kill(-pid, 0);
    return true;
  } catch {
    return false;
  }
};

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitUntil(done: () => boolean | Promise<boolean>, timeoutMs: number, everyMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await done()) return true;
    if (Date.now() >= deadline) return false;
    await sleep(everyMs);
  }
}

/** The markers and coverage files the app's processes left, read, then removed. */
export function readInvocationCoverage(dir: string, problems: string[]): InvocationCoverage {
  const names = (() => {
    try {
      return readdirSync(dir);
    } catch {
      return [];
    }
  })();
  const pids = (prefix: string) => names.filter((n) => n.startsWith(prefix)).map((n) => Number(n.slice(prefix.length, -".json".length))).filter(Number.isInteger);
  const files: InvocationCoverage["files"] = [];
  let unreadable = 0;
  for (const name of names.filter((n) => n.startsWith("coverage-"))) {
    try {
      const parsed = JSON.parse(readFileSync(path.join(dir, name), "utf8")) as { result?: V8Script[] };
      if (!Array.isArray(parsed.result)) throw new Error("no result");
      files.push({ result: parsed.result });
    } catch {
      unreadable++;
    }
  }
  rmSync(dir, { recursive: true, force: true });
  // V8 names each file coverage-<pid>-<time>-<n>.json.
  const covered = [...new Set(names.filter((n) => n.startsWith("coverage-")).map((n) => Number(n.split("-")[1])).filter(Number.isInteger))];
  return { started: pids("pid-"), taken: pids("taken-"), covered, files, unreadable, problems };
}

export async function runInvocation(
  app: AppCommand,
  options: InvocationOptions,
  tests: () => Promise<number>,
): Promise<{ exitCode: number; coverage?: InvocationCoverage; read?: () => InvocationCoverage; timings?: InvocationTimings }> {
  const problems: string[] = [];
  const at = [Date.now()];
  rmSync(options.dir, { recursive: true, force: true });
  mkdirSync(options.dir, { recursive: true, mode: 0o700 });
  const env = { ...app.env, PEEPS_INVOCATION: options.kind };
  if (app.reset !== null && (await shell(app.reset, app.cwd, env)) !== 0) {
    say(`app-reset failed before this ${options.kind} invocation: its server evidence reads partial`);
    problems.push("reset_failed");
  }
  // Whatever answers before the app starts (a server left running, another job's) isn't it.
  try {
    if ((await fetch(app.readyUrl, { signal: AbortSignal.timeout(2_000) })).ok) {
      say(`something already answers ${app.readyUrl} before the app starts: this ${options.kind} invocation's server evidence reads partial`);
      problems.push("ready_before_start");
    }
  } catch {
    // Nothing listening: as it should be.
  }
  at.push(Date.now());
  const child = spawn("sh", ["-c", app.start], {
    cwd: app.cwd,
    detached: true,
    stdio: ["ignore", "inherit", "inherit"],
    env: {
      ...env,
      NODE_V8_COVERAGE: options.dir,
      PEEPS_SERVER_COVERAGE: options.dir,
      NODE_OPTIONS: `${app.env.NODE_OPTIONS ?? ""} --require ${JSON.stringify(options.preload)}`.trim(),
    },
  });
  // The app is detached in its own group: if the action is told to stop, the app must too.
  const signals = ["SIGTERM", "SIGINT"] as const;
  const onSignal = (signal: NodeJS.Signals) => {
    if (child.pid !== undefined) {
      try {
        process.kill(-child.pid, "SIGTERM");
      } catch {
        // Already gone.
      }
    }
    for (const s of signals) process.off(s, onSignal);
    // Nothing else listening: end as the signal would have.
    if (process.listenerCount(signal) === 0) process.kill(process.pid, signal);
  };
  for (const s of signals) process.on(s, onSignal);
  let exited = false;
  child.on("exit", () => (exited = true));
  options.whileStarting?.();
  child.on("error", () => (exited = true));
  const ready = await waitUntil(
    async () => {
      if (exited) return true;
      try {
        return (await fetch(app.readyUrl, { signal: AbortSignal.timeout(5_000) })).ok;
      } catch {
        return false;
      }
    },
    options.readyTimeoutMs ?? READY_TIMEOUT_MS,
    250,
  );
  if (exited) problems.push("app_exited");
  else if (!ready) {
    say(`the app didn't answer ${app.readyUrl} in time: this invocation's server evidence reads partial`);
    problems.push("not_ready");
  }
  at.push(Date.now());
  let exitCode: number;
  try {
    exitCode = await tests();
    at.push(Date.now());
  } finally {
    for (const s of signals) process.off(s, onSignal);
    // An app that ended before its tests did may have served only some of them.
    if (exited && !problems.includes("app_exited")) problems.push("app_exited");
    const pid = child.pid;
    if (pid !== undefined && groupAlive(pid)) {
      process.kill(-pid, "SIGTERM");
      if (!(await waitUntil(() => !groupAlive(pid), options.stopTimeoutMs ?? STOP_TIMEOUT_MS, 100))) {
        process.kill(-pid, "SIGKILL");
        problems.push("killed");
        await waitUntil(() => !groupAlive(pid), 5_000, 100);
      }
    }
  }
  let coverage: InvocationCoverage | undefined;
  let read: (() => InvocationCoverage) | undefined;
  if (options.defer) {
    // Out of the way of the next run's directory, read when the caller is ready to.
    const aside = `${options.dir}.done`;
    rmSync(aside, { recursive: true, force: true });
    renameSync(options.dir, aside);
    read = () => readInvocationCoverage(aside, problems);
  } else coverage = readInvocationCoverage(options.dir, problems);
  at.push(Date.now());
  const [t0, t1, t2, t3, t4] = at as [number, number, number, number, number];
  return { exitCode, coverage, read, timings: { resetMs: t1 - t0, readyMs: t2 - t1, testsMs: t3 - t2, stopMs: t4 - t3 } };
}
