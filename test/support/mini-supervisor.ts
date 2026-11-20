/**
 * The first draft of E4b's turn loop (e4 plan v3 §2.1), for the executor's and the jail's
 * tests: a real `Gate`, a real `GateProxy` and a per-run CA in front of the HTTPS sink. Only
 * the dial mapping is a fixture (the sink's name resolves to loopback, and its fixture CA is
 * trusted for the dial).
 *
 * A turn: the gate opens it for a slot, a fresh credential maps to it, the `turn` frame goes
 * out with its monotonic deadline. At the deadline the gate side closes (`closeTurn`) and
 * `cancel` is sent; the slot stays busy until the turn's `outcome`. The credential keeps
 * mapping to the closed turn, so a late CONNECT on it is refused `turn_closed`.
 */
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import type { TestContext } from "node:test";
import { sharedClocks } from "../../src/load/clocks";
import { Gate, type GateLimits, type LeaseGrant, type PhaseCaps } from "../../src/load/gate/admission";
import { createRunCa, type RunCa } from "../../src/load/gate/ca";
import { Journal } from "../../src/load/gate/journal";
import { canonicalOrigin, type RequestPolicy } from "../../src/load/gate/normalize";
import { GateProxy, type Dial, type ProxyLimits } from "../../src/load/gate/proxy";
import { connectVerified } from "../../src/load/gate/resolve";
import { decode, encode, LineSplitter, type CtlFrame } from "../../src/load/jail/ctl";
import { startSink, type Sink, type SinkOptions } from "./load-sink";

export const EXECUTOR = path.resolve(__dirname, "../../dist/load-executor.js");
export const SINK_HOST = "sink.test";

/** How frames reach an executor: a plain process here, the jail in load-jail. */
export interface ExecutorLink {
  send(frame: CtlFrame): void;
  onFrame(listener: (frame: CtlFrame) => void): void;
  /** The executor (or its jail) ended: with its code, or a protocol verdict. */
  exited: Promise<{ code: number | null; signal: string | null }>;
  end(): Promise<void>;
  stderr(): string;
}

export interface LinkContext {
  /** The proxy URL the executor must use. */
  proxyUrl: string;
  /** The run CA's certificate, as a file. */
  caFile: string;
}

export interface MiniOptions {
  journey: { module: string; export: string };
  /** The executor's working directory: the checkout. */
  workspace: string;
  respond?: SinkOptions["respond"];
  parallel?: number;
  renewEveryMs?: number;
  phase?: Partial<PhaseCaps>;
  lease?: Partial<LeaseGrant>;
  gate?: Partial<GateLimits>;
  proxyLimits?: Partial<ProxyLimits>;
  policy?: Partial<RequestPolicy>;
  /** Wraps the fixture dial (to slow it, for example). */
  dial?: (inner: Dial) => Dial;
  /** The base URL the executor is given; the sink's origin by default. */
  baseURL?: string;
  /** Starts the executor; a plain child process by default. */
  link?: (ctx: LinkContext, proxy: GateProxy) => Promise<ExecutorLink>;
  /** Extra environment for the default process link. */
  env?: Record<string, string>;
  /** Extra Node options for the default process link (`--inspect=...`). */
  nodeArgs?: string[];
}

export interface Outcome {
  turn: number;
  kind: string;
  message?: string;
  location?: string;
}

export interface TurnOptions {
  deadlineMs?: number;
  /** Send `cancel` at the deadline (the default), as the supervisor does. */
  cancelAtDeadline?: boolean;
}

export interface OpenedTurn {
  turn: number;
  slot: number;
  password: string;
  credential: string;
  outcome: Promise<Outcome>;
}

/** The default link: the committed executor as a child process, frames on stdin and fd 3. */
export function processLink(workspace: string, env: Record<string, string> = {}, nodeArgs: string[] = []) {
  return async (ctx: LinkContext): Promise<ExecutorLink> => {
    const child = spawn(process.execPath, [...nodeArgs, EXECUTOR], {
      cwd: workspace,
      env: { PATH: path.dirname(process.execPath) + ":/usr/bin:/bin", HOME: os.tmpdir(), NODE_EXTRA_CA_CERTS: ctx.caFile, ...env },
      stdio: ["pipe", "pipe", "pipe", "pipe"],
    });
    let stderr = "";
    child.stderr!.setEncoding("utf8");
    child.stderr!.on("data", (d: string) => (stderr += d));
    child.stdout!.resume();
    child.stdin!.on("error", () => undefined);
    const listeners: ((f: CtlFrame) => void)[] = [];
    const lines = new LineSplitter();
    const fd3 = child.stdio[3] as NodeJS.ReadableStream;
    fd3.setEncoding("utf8");
    fd3.on("data", (chunk: string) => {
      for (const line of lines.push(chunk) ?? ["<oversized>"]) {
        const frame = decode(line);
        if (!frame) throw new Error(`executor sent a line that is not a frame: ${line.slice(0, 200)}`);
        for (const l of listeners) l(frame);
      }
    });
    const exited = new Promise<{ code: number | null; signal: string | null }>((resolve) => child.once("exit", (code, signal) => resolve({ code, signal })));
    return {
      send: (frame) => void child.stdin!.write(encode(frame)),
      onFrame: (l) => void listeners.push(l),
      exited,
      end: async () => {
        child.stdin!.end();
        const timer = setTimeout(() => child.kill("SIGKILL"), 3000);
        await exited;
        clearTimeout(timer);
      },
      stderr: () => stderr,
    };
  };
}

export class MiniSupervisor {
  readonly frames: CtlFrame[] = [];
  readonly outcomes = new Map<number, Outcome[]>();
  /** CONNECTs the proxy received, with their credential. */
  readonly connects: string[] = [];
  private readonly credentials = new Map<string, number>();
  private readonly waiters: { match: (f: CtlFrame) => boolean; resolve: (f: CtlFrame) => void }[] = [];
  private readonly timers = new Set<NodeJS.Timeout>();
  link!: ExecutorLink;

  private constructor(
    readonly gate: Gate,
    readonly proxy: GateProxy,
    readonly journal: Journal,
    readonly sink: Sink,
    readonly ca: RunCa,
    readonly origin: string,
    readonly baseURL: string,
    private readonly o: MiniOptions,
  ) {}

  static async start(t: TestContext, o: MiniOptions): Promise<MiniSupervisor> {
    const sink = await startSink({ host: SINK_HOST, respond: o.respond });
    const origin = canonicalOrigin(SINK_HOST, sink.port);
    const now = sharedClocks();
    const gate = new Gate({
      origins: { [origin]: 100_000 },
      methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD"],
      maxOutstandingPerTurn: 8,
      runTotal: 100_000,
      turnDeadlineMs: 600_000,
      runEndMono: now.monoMs + 3_600_000,
      phase: { ratePerSecond: 10_000, burst: 1000, maxUsers: 64, total: 100_000, ...o.phase },
      ...o.gate,
    });
    gate.applyLease({ seq: 1, monoUntil: now.monoMs + 3_600_000, wallUntil: now.wallMs + 3_600_000, ceiling: 100_000, ...o.lease });
    const journal = new Journal();
    const ca = createRunCa({ hosts: [SINK_HOST], nowMs: Date.now(), validForMs: 60 * 60 * 1000 });
    const real: Dial = (orig, signal, _pin, ready) => connectVerified("127.0.0.1", orig, { ca: [sink.caPem], signal, ready });
    let self: MiniSupervisor | undefined;
    const proxy = new GateProxy({
      gate,
      journal,
      ca,
      policy: { allowedOrigins: [origin], allowedRequests: [{ method: "POST", path: "/cart" }], ...o.policy },
      origins: new Map([[origin, { host: SINK_HOST, port: sink.port, privateCidrs: [] }]]),
      authorize: (c) => self?.credentials.get(c),
      limits: o.proxyLimits,
      clocks: sharedClocks,
      dial: o.dial ? o.dial(real) : real,
    });
    proxy.server.on("connect", (req: import("node:http").IncomingMessage) => self!.connects.push(String(req.headers["proxy-authorization"] ?? "")));
    const dir = mkdtempSync(path.join(os.tmpdir(), "peeps-mini-"));
    const caFile = path.join(dir, "ca.pem");
    writeFileSync(caFile, ca.certPem);
    const baseURL = o.baseURL ?? origin;
    self = new MiniSupervisor(gate, proxy, journal, sink, ca, origin, baseURL, o);
    let proxyUrl = "";
    if (!o.link) {
      await new Promise<void>((resolve) => proxy.server.listen(0, "127.0.0.1", resolve));
      proxyUrl = `http://127.0.0.1:${(proxy.server.address() as AddressInfo).port}`;
    }
    // Teardown is registered before the link starts: a link that fails to start still frees the rest.
    let link: ExecutorLink | undefined;
    t.after(async () => {
      for (const timer of self!.timers) clearTimeout(timer);
      try {
        await link?.end();
      } finally {
        await proxy.close();
        await sink.close();
        rmSync(dir, { recursive: true, force: true });
      }
    });
    link = await (o.link ?? ((ctx) => processLink(o.workspace, o.env, o.nodeArgs)(ctx)))({ proxyUrl, caFile }, proxy);
    self.link = link;
    link.onFrame((f) => self!.onFrame(f));
    return self;
  }

  private onFrame(frame: CtlFrame): void {
    this.frames.push(frame);
    if (frame.type === "outcome") {
      const list = this.outcomes.get(frame.turn) ?? [];
      list.push({ turn: frame.turn, kind: frame.kind, message: frame.message, location: frame.location });
      this.outcomes.set(frame.turn, list);
      // The gate side of the turn ends at its outcome.
      this.proxy.closeTurn(frame.turn);
    }
    for (const w of [...this.waiters]) {
      if (w.match(frame)) {
        this.waiters.splice(this.waiters.indexOf(w), 1);
        w.resolve(frame);
      }
    }
  }

  waitFrame(match: (f: CtlFrame) => boolean, ms = 20_000): Promise<CtlFrame> {
    const seen = this.frames.find(match);
    if (seen) return Promise.resolve(seen);
    return new Promise((resolve, reject) => {
      const timer = this.timer(() => reject(new Error(`no matching frame in ${ms} ms; frames: ${JSON.stringify(this.frames).slice(0, 2000)}\nstderr: ${this.link.stderr().slice(-2000)}`)), ms);
      this.waiters.push({ match, resolve: (f) => (clearTimeout(timer), resolve(f)) });
    });
  }

  /** Sends `init`; resolves with `loaded` or `fatal`. */
  async init(over: Partial<Extract<CtlFrame, { type: "init" }>> = {}, proxyUrl = this.proxyUrl()): Promise<CtlFrame> {
    this.link.send({ type: "init", journey: this.o.journey, baseURL: this.baseURL, proxy: proxyUrl, renewEveryMs: this.o.renewEveryMs ?? 2000, parallel: this.o.parallel ?? 4, ...over });
    return this.waitFrame((f) => f.type === "loaded" || f.type === "fatal");
  }

  proxyUrl(): string {
    const address = this.proxy.server.address();
    return address && typeof address === "object" ? `http://127.0.0.1:${address.port}` : "http://127.0.0.1:3128";
  }

  /** Opens a turn in the gate and sends it; the outcome resolves after the turn's cleanup. */
  open(slot: number, o: TurnOptions = {}): OpenedTurn {
    const opened = this.gate.openTurn(`s${slot}`, sharedClocks());
    if (!opened.ok) throw new Error(`the gate would not open a turn for slot ${slot}: ${opened.reason}`);
    const turn = opened.turn;
    const password = randomBytes(32).toString("base64url");
    const credential = `Basic ${Buffer.from(`${turn}:${password}`).toString("base64")}`;
    this.credentials.set(credential, turn);
    const deadlineMs = o.deadlineMs ?? 30_000;
    const deadlineMono = sharedClocks().monoMs + deadlineMs;
    const outcome = this.waitFrame((f) => f.type === "outcome" && f.turn === turn, deadlineMs + 30_000).then((f) => {
      clearTimeout(timer);
      const x = f as Extract<CtlFrame, { type: "outcome" }>;
      return { turn, kind: x.kind, message: x.message, location: x.location };
    });
    const timer = this.timer(() => {
      this.proxy.closeTurn(turn);
      if (o.cancelAtDeadline !== false) this.link.send({ type: "cancel", turn });
    }, deadlineMs);
    this.link.send({ type: "turn", turn, slot, password, deadlineMono });
    return { turn, slot, password, credential, outcome };
  }

  /** A timer cleared when the test ends. */
  private timer(fn: () => void, ms: number): NodeJS.Timeout {
    const timer = setTimeout(() => {
      this.timers.delete(timer);
      fn();
    }, ms);
    this.timers.add(timer);
    return timer;
  }

  /** One turn on a slot, to its outcome. */
  turn(slot: number, o: TurnOptions = {}): Promise<Outcome> {
    return this.open(slot, o).outcome;
  }
}
