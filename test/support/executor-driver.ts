/**
 * Drives the committed `dist/load-executor.js` over its frame channel the way the supervisor
 * does, without the supervisor: init, go, heartbeats, turns, and a permit for every ask. For
 * tests of what the executor does with sessions, deadlines and memory.
 */
import { spawn, type ChildProcess } from "node:child_process";
import path from "node:path";

import { encodeFrame, FrameReader, type Frame } from "../../src/load/frames";
import { sharedNowMs } from "../../src/load/transport";
import { JOURNEYS } from "./load-run";

const EXECUTOR = path.resolve(__dirname, "../../dist/load-executor.js");

export interface Outcome {
  turn: string;
  kind: "success" | "failure" | "timeout" | "interrupted";
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
  /** The lease generation the driver plays the supervisor at. */
  generation = 1;
  /** Hold asks for the test to answer, instead of permitting each at once. */
  holdAsks = false;
  readonly asks: Frame[] = [];
  readonly frames: Frame[] = [];

  constructor(
    private readonly baseURL: string,
    private readonly journey: { module: string; export: string },
    private readonly deadManMs = 5_000,
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
    this.heartbeat = setInterval(() => this.send({ t: "hb", generation: this.generation }), 100);
  }

  send(frame: Frame): void {
    if (this.child.stdin!.writable) this.child.stdin!.write(encodeFrame(frame));
  }

  private onFrame(frame: Frame): void {
    this.frames.push(frame);
    if (frame.t === "ask") {
      if (this.holdAsks) this.asks.push(frame);
      else this.permit(frame);
    }
    const i = this.waiters.findIndex((w) => w.match(frame));
    if (i >= 0) this.waiters.splice(i, 1)[0]!.resolve(frame);
  }

  /** Answers an ask with a permit, by default good for 5 s at the current generation. */
  permit(ask: Frame, opts: { expiresInMs?: number; generation?: number } = {}): string {
    const id = `driver.m.${++this.seq}`;
    this.permits.set(id, { turn: String(ask.turn), user: this.turnUsers.get(String(ask.turn)) ?? 0 });
    this.send({ t: "permit", req: ask.req, id, expiresAt: sharedNowMs() + (opts.expiresInMs ?? 5_000), generation: opts.generation ?? this.generation });
    return id;
  }

  /** Waits for a frame matching `match`, among those already seen too. */
  async waitFrame(match: (f: Frame) => boolean, timeoutMs = 10_000): Promise<Frame> {
    const seen = this.frames.find(match);
    if (seen) return seen;
    return this.next(match, timeoutMs);
  }

  /** Freezes the executor (SIGSTOP) for `ms`, running `during` while it is frozen. */
  async freeze(ms: number, during: () => void = () => undefined): Promise<void> {
    this.child.kill("SIGSTOP");
    during();
    await new Promise((r) => setTimeout(r, ms));
    this.child.kill("SIGCONT");
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
      deadManMs: this.deadManMs,
      env: { BASE_URL: this.baseURL },
    });
    const ready = this.next((f) => f.t === "ready" || f.t === "fatal");
    this.send({ t: "go" });
    const answer = await ready;
    if (answer.t !== "ready") throw new Error(`executor did not start: ${JSON.stringify(answer)}`);
  }

  turn(id: string, user: number, deadlineInMs = 10_000, during?: () => void): Promise<Outcome> {
    this.turnUsers.set(id, user);
    const outcome = this.next((f) => f.t === "outcome" && f.turn === id, deadlineInMs + 30_000);
    const now = sharedNowMs();
    this.send({ t: "start", turn: id, user, deadlineAt: now + deadlineInMs, leaseEndsAt: now + 60_000, generation: this.generation });
    during?.();
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
