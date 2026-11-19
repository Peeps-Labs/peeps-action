/**
 * Starts the committed engine against the sink in its own process (`run-engine.ts`) and
 * gives the test what it needs to judge it: the sink's records, the engine's events, the
 * final result and the processes, so it can stop, freeze or kill them.
 */
import type { TestContext } from "node:test";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { scheduleStageStarts } from "../../src/load/scheduler";
import type { EngineResult } from "../../src/load/supervisor";
import type { PortScript, RenewalRecord } from "./fake-control-port";
import { LoadSink } from "./load-sink";

export const JOURNEYS = path.resolve(__dirname, "../fixtures/load-engine/journeys");
const harness = path.resolve(__dirname, "run-engine.ts");

export interface PlanSpec {
  module: string;
  export: string;
  users: number;
  holdMs: number;
  pacingMs?: number;
  perJourneyMax?: number;
  allowedRequests?: { method: "POST" | "PUT" | "PATCH" | "DELETE"; path: string }[];
  /** Extra origins beyond the sink's. */
  origins?: string[];
  /** Limits' request budget (default: the plan's ceiling). */
  requestBudget?: number;
}

export function makePlan(spec: PlanSpec, origin: string) {
  const pacingEveryMs = spec.pacingMs ?? 1000;
  const stages = [
    { name: "Hold", kind: "hold" as const, startMs: 0, durationMs: spec.holdMs, fromUsers: spec.users, toUsers: spec.users, plannedStarts: 0 },
  ];
  stages[0]!.plannedStarts = scheduleStageStarts({ pacingEveryMs, stages })[0]!;
  const perJourneyMax = spec.perJourneyMax ?? 5;
  const plannedStarts = stages[0]!.plannedStarts;
  return {
    plan: {
      protocolVersion: 1,
      journey: { module: spec.module, export: spec.export },
      cohort: { kind: "protocol", demand: "users", pacingEveryMs, stages },
      durationMs: spec.holdMs,
      peakUsers: spec.users,
      plannedStarts,
      requests: { perJourneyMax, ceiling: plannedStarts * perJourneyMax },
      allowedRequests: spec.allowedRequests ?? [],
      onReduced: "refuse",
    },
    limits: {
      allowedOrigins: [origin, ...(spec.origins ?? [])],
      maxUsers: 100,
      requestBudget: spec.requestBudget ?? plannedStarts * perJourneyMax,
      policyRevision: 1,
    },
  };
}

/** Short engine timings for tests; every one can be overridden. */
export const FAST = {
  leaseMs: 3_000,
  stopGraceMs: 1_500,
  turnDeadlineMs: 3_000,
  checkingDeadlineMs: 8_000,
  startSlackMs: 500,
};

export interface RunSpec {
  plan: PlanSpec;
  constants?: Partial<typeof FAST> & Record<string, number>;
  options?: Record<string, unknown>;
  port?: PortScript;
  stopAfterMs?: number;
  stopMode?: "graceful" | "now";
  /** Extra environment for the engine's own process (the job's), never meant to reach the journey. */
  env?: Record<string, string>;
}

export interface EngineEventLine {
  type: string;
  at: number;
  [key: string]: unknown;
}

export interface Finished {
  result: EngineResult;
  renewals: RenewalRecord[];
  markers: { kind: string; atMs: number; wallMs: number; detail?: string }[];
  intervals: unknown[];
  cohorts: unknown[];
  final: boolean;
}

export class EngineRun {
  readonly child: ChildProcess;
  readonly exited: Promise<number | null>;
  stderr = "";

  constructor(
    readonly dir: string,
    readonly eventsFile: string,
    readonly resultFile: string,
    configFile: string,
    env: Record<string, string> = {},
  ) {
    this.child = spawn(process.execPath, ["--import", "tsx", harness, configFile], {
      env: { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: dir, ...env },
      stdio: ["ignore", "ignore", "pipe"],
      detached: true,
    });
    this.child.stderr!.on("data", (chunk: Buffer) => (this.stderr += chunk.toString()));
    this.exited = new Promise((resolve) => this.child.on("exit", (code) => resolve(code)));
  }

  events(): EngineEventLine[] {
    if (!existsSync(this.eventsFile)) return [];
    return readFileSync(this.eventsFile, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as EngineEventLine);
  }

  async waitFor(predicate: (events: EngineEventLine[]) => boolean, timeoutMs = 30_000): Promise<EngineEventLine[]> {
    const started = Date.now();
    for (;;) {
      const events = this.events();
      if (predicate(events)) return events;
      if (Date.now() - started > timeoutMs) throw new Error(`timed out waiting; events: ${events.map((e) => e.type).join(",")}\n${this.stderr}`);
      await new Promise((r) => setTimeout(r, 25));
    }
  }

  async finished(timeoutMs = 90_000): Promise<Finished> {
    const timer = setTimeout(() => this.child.kill("SIGKILL"), timeoutMs);
    await this.exited;
    clearTimeout(timer);
    if (!existsSync(this.resultFile)) throw new Error(`the engine wrote no result\n${this.stderr}`);
    return JSON.parse(readFileSync(this.resultFile, "utf8")) as Finished;
  }

  /** The executor's processes as the host sees them: [unshare/wrapper pid, executor host pid]. */
  executorPids(): number[] {
    const event = this.events().find((e) => e.type === "executor");
    if (!event) return [];
    return [event.pid as number, event.hostPid as number].filter((p, i, all) => typeof p === "number" && all.indexOf(p) === i);
  }
}

export async function startRun(t: TestContext, sink: LoadSink, spec: RunSpec): Promise<EngineRun> {
  const dir = await mkdtemp(path.join(tmpdir(), "peeps-load-run-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const eventsFile = path.join(dir, "events.jsonl");
  const resultFile = path.join(dir, "result.json");
  const configFile = path.join(dir, "config.json");
  await writeFile(
    configFile,
    JSON.stringify({
      planInput: makePlan(spec.plan, sink.url),
      options: {
        repositoryRoot: JOURNEYS,
        constants: { ...FAST, ...spec.constants },
        intervalMs: 1_000,
        killGraceMs: 1_000,
        deadManMs: 1_500,
        ...spec.options,
      },
      port: spec.port,
      eventsFile,
      resultFile,
      stopAfterMs: spec.stopAfterMs,
      stopMode: spec.stopMode,
    }),
  );
  const run = new EngineRun(dir, eventsFile, resultFile, configFile, spec.env);
  t.after(() => {
    try {
      if (run.child.pid) process.kill(-run.child.pid, "SIGKILL");
    } catch {
      // gone
    }
  });
  return run;
}

/** Feeds the engine's start events to the sink, which records them apart from requests. */
export function recordStarts(sink: LoadSink, events: EngineEventLine[]): void {
  for (const e of events) {
    if (e.type === "started") sink.recordStart({ turn: String(e.turn), user: Number(e.user), phase: String(e.phase), wallMs: Number(e.wallMs) });
  }
}

export function permitIds(events: EngineEventLine[]): string[] {
  return events.filter((e) => e.type === "permit").map((e) => String(e.id));
}

/** Signals a whole process group, through `sudo -n` when it runs as root and we don't. */
export function signalGroup(pgid: number, signal: "SIGSTOP" | "SIGCONT"): void {
  try {
    process.kill(-pgid, signal);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EPERM") throw error;
    const result = spawnSync("sudo", ["-n", "kill", `-${signal.slice(3)}`, "--", `-${pgid}`], { stdio: "ignore" });
    if (result.status !== 0) throw error;
  }
}

/** Whether `pid` is still running. A zombie runs nothing: it is dead, waiting for a parent
 * (here often a container's init that never reaps) to collect it. */
export function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
  } catch (error) {
    // EPERM: it exists, but runs as someone else (the executor as root, under sudo).
    if ((error as NodeJS.ErrnoException).code !== "EPERM") return false;
  }
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    return stat.slice(stat.lastIndexOf(")") + 2, stat.lastIndexOf(")") + 3) !== "Z";
  } catch {
    return false;
  }
}

export async function newSink(t: TestContext): Promise<LoadSink> {
  const sink = new LoadSink();
  await sink.start();
  t.after(() => sink.close());
  return sink;
}
