/**
 * Drives the committed `dist/load-executor.js` over its frame channel the way the supervisor
 * does, without the supervisor: init, go, heartbeats, turns, and a permit for every ask. For
 * tests of what the executor does with sessions, deadlines and memory.
 */
import { spawn, type ChildProcess } from "node:child_process";
import path from "node:path";

import { encodeFrame, FrameReader, type Frame } from "../../src/load/frames";
import { JOURNEYS } from "./load-run";

const EXECUTOR = path.resolve(__dirname, "../../dist/load-executor.js");

export interface Outcome {
  turn: string;
  kind: "success" | "failure" | "timeout";
  message?: string;
  durationUs: number;
}

export class ExecutorDriver {
  readonly child: ChildProcess;
  stderr = "";
  /** Each permit issued, by id: the turn and user it was for. */
  readonly permits = new Map<string, { turn: string; user: number }>();
  private readonly reader = new FrameReader();
  private readonly waiters: { match: (f: Frame) => boolean; resolve: (f: Frame) => void }[] = [];
  private readonly turnUsers = new Map<string, number>();
  private seq = 0;
  private heartbeat: NodeJS.Timeout;

  constructor(
    private readonly baseURL: string,
    private readonly journey: { module: string; export: string },
  ) {
    this.child = spawn(process.execPath, ["--expose-gc", EXECUTOR], {
      env: { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: JOURNEYS },
      cwd: JOURNEYS,
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.child.stderr!.on("data", (chunk: Buffer) => (this.stderr += chunk.toString()));
    this.child.stdout!.on("data", (chunk: Buffer) => {
      for (const frame of this.reader.push(chunk)) this.onFrame(frame);
    });
    this.heartbeat = setInterval(() => this.send({ t: "hb" }), 100);
  }

  private send(frame: Frame): void {
    if (this.child.stdin!.writable) this.child.stdin!.write(encodeFrame(frame));
  }

  private onFrame(frame: Frame): void {
    if (frame.t === "ask") {
      const id = `driver.m.${++this.seq}`;
      this.permits.set(id, { turn: String(frame.turn), user: this.turnUsers.get(String(frame.turn)) ?? 0 });
      this.send({ t: "permit", req: frame.req, id });
      return;
    }
    const i = this.waiters.findIndex((w) => w.match(frame));
    if (i >= 0) this.waiters.splice(i, 1)[0]!.resolve(frame);
  }

  private next(match: (f: Frame) => boolean, timeoutMs = 30_000): Promise<Frame> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`no frame in time\n${this.stderr}`)), timeoutMs);
      this.waiters.push({
        match,
        resolve: (f) => {
          clearTimeout(timer);
          resolve(f);
        },
      });
    });
  }

  async start(): Promise<void> {
    const hello = this.next((f) => f.t === "hello");
    await hello;
    this.send({
      t: "init",
      runId: "driver",
      repositoryRoot: JOURNEYS,
      workingDirectory: JOURNEYS,
      journey: this.journey,
      baseURL: this.baseURL,
      deadManMs: 5_000,
      permitTtlMs: 5_000,
    });
    const ready = this.next((f) => f.t === "ready" || f.t === "fatal");
    this.send({ t: "go" });
    const answer = await ready;
    if (answer.t !== "ready") throw new Error(`executor did not start: ${JSON.stringify(answer)}`);
  }

  turn(id: string, user: number, deadlineInMs = 10_000): Promise<Outcome> {
    this.turnUsers.set(id, user);
    const outcome = this.next((f) => f.t === "outcome" && f.turn === id, deadlineInMs + 30_000);
    this.send({ t: "start", turn: id, user, deadlineInMs });
    return outcome as unknown as Promise<Outcome>;
  }

  async heapUsed(): Promise<{ heapUsed: number; sessions: number }> {
    const stats = this.next((f) => f.t === "stats");
    this.send({ t: "stats?" });
    return (await stats) as unknown as { heapUsed: number; sessions: number };
  }

  async close(): Promise<void> {
    clearInterval(this.heartbeat);
    if (this.child.exitCode !== null) return;
    const exited = new Promise((resolve) => this.child.on("exit", resolve));
    this.send({ t: "exit" });
    const timer = setTimeout(() => this.child.kill("SIGKILL"), 5_000);
    await exited;
    clearTimeout(timer);
  }
}
