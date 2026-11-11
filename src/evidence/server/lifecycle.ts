/**
 * The app for one invocation (PQA-3201 PR 3): the action runs the customer's reset, starts
 * the app under the coverage preload in a process group of its own, waits until it answers,
 * runs the invocation's tests, then stops the whole group and reads what its processes ran.
 * Nothing here fails the job: whatever goes wrong is a named problem, which makes the
 * invocation's footprint partial, and the tests still run.
 */
import { spawn } from "node:child_process";
import { mkdirSync, readdirSync, readFileSync, rmSync } from "node:fs";
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

export interface InvocationOptions {
  /** Where the app's processes write coverage: created, read, then removed. */
  dir: string;
  /** The preload's absolute path. */
  preload: string;
  /** `ambient` is the run with no tests; `spec` one spec file's. */
  kind: "ambient" | "spec";
  readyTimeoutMs?: number;
  stopTimeoutMs?: number;
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
  return { started: pids("pid-"), taken: pids("taken-"), files, unreadable, problems };
}

export async function runInvocation(
  app: AppCommand,
  options: InvocationOptions,
  tests: () => Promise<number>,
): Promise<{ exitCode: number; coverage: InvocationCoverage }> {
  const problems: string[] = [];
  rmSync(options.dir, { recursive: true, force: true });
  mkdirSync(options.dir, { recursive: true, mode: 0o700 });
  const env = { ...app.env, PEEPS_INVOCATION: options.kind };
  if (app.reset !== null && (await shell(app.reset, app.cwd, env)) !== 0) {
    say(`app-reset failed before this ${options.kind} invocation: its server evidence reads partial`);
    problems.push("reset_failed");
  }
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
  let exited = false;
  child.on("exit", () => (exited = true));
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
  let exitCode: number;
  try {
    exitCode = await tests();
  } finally {
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
  return { exitCode, coverage: readInvocationCoverage(options.dir, problems) };
}
