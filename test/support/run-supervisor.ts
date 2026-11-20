/**
 * The supervisor end to end for its tests (e4 plan v3 §3.2): a checkout with a workload, the
 * HTTPS sink behind its approved origin, the fake Peeps and a jail (the fake one by default).
 * The clock seam shifts the supervisor's monotonic and wall clocks on their own, so a test can
 * step one without the other.
 */
import { chmodSync, cpSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { preinstall, trustedToolchain } from "../../src/load/install";
import os from "node:os";
import path from "node:path";
import assert from "node:assert/strict";
import type { TestContext } from "node:test";
import { sharedClocks } from "../../src/load/clocks";
import type { Binding } from "../../src/load/control-port";
import type { Clocks } from "../../src/load/gate/admission";
import { canonicalOrigin } from "../../src/load/gate/normalize";
import type { Dial } from "../../src/load/gate/proxy";
import { connectVerified } from "../../src/load/gate/resolve";
import type { JailHandle, StartJailOptions } from "../../src/load/jail";
import type { JailSpec } from "../../src/load/jail/spec";
import { scheduleStageStarts } from "../../src/load/scheduler";
import { bindingOf, runLoad, type LoadEvent, type LoadResult, type LoadSeams } from "../../src/load/supervisor";
import { FakeControlPort, type FakeSetup, type PortScript } from "./fake-control-port";
import { fakeJail, type FakeJailOptions } from "./fake-jail";
import { FIXTURES, respond as fixtureRespond } from "./e4-fixtures";
import { SEQ_HEADER, startSink, type Sink, type SinkOptions } from "./load-sink";

export const SINK_HOST = "sink.test";
const FLOOR_DIR = process.env.PEEPS_LOAD_PLAYWRIGHT_DIR;
const REPO = path.resolve(__dirname, "../..");
export const WORKLOAD_PATH = "peeps/load/smoke.workload.yaml";
/** The dispatch's grant reference every rig claims with. */
export const GRANT_REF = "q2Jx7Vf0bH1kR8sTzW4uYg";
const LABELS = { image: "test", kernel: "test", tools: "test", chrony: "test" };

/** A plan of `users` users, one start per user per `pacingMs`, for `durationMs`. */
export function smallPlan(o: { exportName: string; users?: number; durationMs?: number; pacingMs?: number; perJourneyMax?: number; allowedRequests?: { method: string; path: string }[] }) {
  const users = o.users ?? 2;
  const durationMs = o.durationMs ?? 3000;
  const pacingEveryMs = o.pacingMs ?? 1000;
  const perJourneyMax = o.perJourneyMax ?? 2;
  const stages = [{ name: "Hold", kind: "hold" as const, startMs: 0, durationMs, fromUsers: users, toUsers: users, plannedStarts: 0 }];
  stages[0]!.plannedStarts = scheduleStageStarts({ pacingEveryMs, stages })[0]!;
  const plannedStarts = stages[0]!.plannedStarts;
  return {
    protocolVersion: 1,
    journey: { module: "journeys.ts", export: o.exportName },
    cohort: { kind: "protocol", demand: "users", pacingEveryMs, stages },
    durationMs,
    peakUsers: users,
    plannedStarts,
    requests: { perJourneyMax, ceiling: perJourneyMax * plannedStarts },
    allowedRequests: o.allowedRequests ?? [],
    onReduced: "refuse",
  };
}

/** A checkout: the journeys, a workload file, a lockfile, `.git/HEAD`, and Playwright linked in. */
export function workspace(t: TestContext): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), "peeps-sup-ws-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  cpSync(FIXTURES, dir, { recursive: true });
  writeFileSync(path.join(dir, "package-lock.json"), '{"lockfileVersion":3}\n');
  checkoutBits(dir);
  if (FLOOR_DIR) {
    mkdirSync(path.join(dir, "node_modules"));
    symlinkSync(path.join(FLOOR_DIR, "node_modules/playwright-core"), path.join(dir, "node_modules/playwright-core"));
    // npm's record of the install, which the claim binds.
    writeFileSync(path.join(dir, "node_modules/.package-lock.json"), '{"lockfileVersion":3}\n');
  } else symlinkSync(path.join(REPO, "node_modules"), path.join(dir, "node_modules"));
  return dir;
}

/** What a checkout needs besides the journeys: `.git/HEAD` and the workload file. */
export function checkoutBits(dir: string): void {
  mkdirSync(path.join(dir, ".git"), { recursive: true });
  writeFileSync(path.join(dir, ".git/HEAD"), "a".repeat(40) + "\n");
  mkdirSync(path.join(dir, "peeps/load"), { recursive: true });
  writeFileSync(path.join(dir, WORKLOAD_PATH), "journey: journeys.ts\n");
}

/**
 * A checkout as the real jail needs it: under the runner's home (0755), the journeys, the
 * pinned Playwright installed as the pre-claim step would, and the checkout bits.
 */
export async function installedWorkspace(): Promise<string> {
  const ws = mkdtempSync(path.join(os.homedir(), "peeps-jail-ws-"));
  chmodSync(ws, 0o755);
  cpSync(FIXTURES, ws, { recursive: true });
  cpSync(path.join(REPO, "test/fixtures/load-engine/slice"), ws, { recursive: true });
  const scratch = mkdtempSync(path.join(os.tmpdir(), "peeps-slice-npm-"));
  try {
    await preinstall(ws, trustedToolchain(path.dirname(path.dirname(process.execPath)), ws), scratch);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
  checkoutBits(ws);
  return ws;
}

/** The supervisor's clocks, with each shiftable on its own. */
export class ClockSeam {
  monoShift = 0;
  wallShift = 0;
  /** When set, the monotonic clock reads this (frozen). */
  frozenMono: number | undefined;
  readonly clocks = (): Clocks => {
    const real = sharedClocks();
    return { monoMs: this.frozenMono ?? real.monoMs + this.monoShift, wallMs: real.wallMs + this.wallShift };
  };
}

export interface RigOptions {
  /** The checkout; a fresh one with the fixtures by default. */
  ws?: string;
  /** The real jail and probe (load-jail, load-freeze on Linux); the checkout is installed beforehand. */
  real?: boolean;
  /** An external sink (a sink in another process). */
  sink?: Sink;
  plan?: ReturnType<typeof smallPlan>;
  exportName?: string;
  script?: PortScript;
  setup?: Partial<FakeSetup>;
  /** Changes the grant's limits. */
  limits?: Partial<FakeSetup["limits"]>;
  respond?: SinkOptions["respond"];
  stall?: SinkOptions["stall"];
  jail?: FakeJailOptions;
  /** Starts the jail some other way (the real jail in load-jail). */
  launch?: (spec: JailSpec, options: StartJailOptions, signal?: AbortSignal) => Promise<JailHandle>;
  seams?: Partial<LoadSeams>;
  /** Wraps the fixture dial. */
  dial?: (inner: Dial) => Dial;
  signal?: AbortSignal;
  /** The hard cancel (SIGTERM). */
  hardSignal?: AbortSignal;
  /** The hosts a grant may name (the direct entry's PEEPS_LOAD_SINK_HOSTS). */
  harnessHosts?: string[];
  /** The dispatch's grant reference; `GRANT_REF` by default. */
  grantRef?: string;
  /** Runs with every event, in order. */
  observer?: (e: LoadEvent, rig: Rig) => void;
  /** Shifts the supervisor's clocks before the run starts. */
  monoShift?: number;
  /** Rewrites the checkout before the run (after the binding the fake expects is read). */
  afterBinding?: (ws: string) => void;
}

export interface Rig {
  ws: string;
  sink: Sink;
  port: FakeControlPort;
  seam: ClockSeam;
  events: LoadEvent[];
  jails: ReturnType<typeof fakeJail>;
  origin: string;
  result: Promise<LoadResult>;
}

/** Fast engine and supervisor constants: a run takes seconds. */
export const FAST = {
  turnDeadlineMs: 5_000,
  checkingDeadlineMs: 15_000,
  stopGraceMs: 1_500,
  outcomeTimeoutMs: 1_500,
  startSlackMs: 1_000,
  reportingMs: 4_000,
  loadedMs: 30_000,
  tickMs: 20,
  renewAttemptMs: 500,
};

export async function rig(t: TestContext, o: RigOptions = {}): Promise<Rig> {
  const sink = o.sink ?? (await startSink({ host: SINK_HOST, respond: o.respond ?? fixtureRespond, stall: o.stall }));
  if (!o.sink) t.after(() => sink.close());
  const ws = o.ws ?? workspace(t);
  const origin = canonicalOrigin(SINK_HOST, sink.port);
  const plan = o.plan ?? smallPlan({ exportName: o.exportName ?? "get" });
  const binding: Binding = await bindingOf(ws, WORKLOAD_PATH);
  o.afterBinding?.(ws);
  const setup: FakeSetup = {
    plan,
    limits: { allowedOrigins: [origin], privateOrigins: { [origin]: ["127.0.0.0/8"] }, maxUsers: 10, requestBudget: 100_000, policyRevision: 1, phases: {}, ...o.limits },
    workload: { path: WORKLOAD_PATH, digest: binding.workload.digest, module: plan.journey.module, export: plan.journey.export },
    baseURL: origin,
    binding,
    ttlMs: 3000,
    renewEveryMs: 500,
    graceMs: 1_500,
    ...o.setup,
  };
  const port = new FakeControlPort(setup, o.script);
  const seam = new ClockSeam();
  seam.monoShift = o.monoShift ?? 0;
  const jails = fakeJail(o.jail);
  const real: Dial = (orig, signal, _pin, ready) => connectVerified("127.0.0.1", orig, { ca: [sink.caPem], signal, ready });
  const events: LoadEvent[] = [];
  const self = { ws, sink, port, seam, events, jails, origin } as Rig;
  self.result = runLoad(
    { runId: `t${Math.random().toString(36).slice(2, 10)}`, grantRef: o.grantRef ?? GRANT_REF, workspace: ws, workloadPath: WORKLOAD_PATH, nodeDir: path.dirname(path.dirname(process.execPath)), actionDir: path.join(REPO, "dist"), port, signal: o.signal, hardSignal: o.hardSignal, harnessHosts: o.harnessHosts, observer: (e) => {
      events.push(e);
      o.observer?.(e, self);
    } },
    {
      clocks: seam.clocks,
      // The real jail's callers install before the run (as the action's pre-claim step would); the digest is read here.
      preinstall: async (w: string) => ({ lock: "", hiddenLock: "", tree: (await bindingOf(w, WORKLOAD_PATH)).observed.treeDigest }),
      labels: async () => LABELS,
      ...(o.real ? {} : { launch: o.launch ?? jails.launch, probe: async () => ({ passed: true, failures: [], seen: null }) }),
      dial: o.dial ? o.dial(real) : real,
      seqHeader: SEQ_HEADER,
      constants: FAST,
      ...o.seams,
    },
  );
  return self;
}

/** I1/I2 as counts: nothing was debited after terminate, and nothing unattempted reached the target. */
export function invariants(r: Rig, res: LoadResult): void {
  const snap = r.events.find((e): e is Extract<LoadEvent, { type: "snapshot" }> => e.type === "snapshot");
  if (snap && res.handoffs) {
    assert.equal(res.handoffs.debited, snap.handoffs.debited, "no debit after terminate");
    assert.deepEqual(res.handoffs.unattempted, snap.handoffs.unattempted, "no attempt after terminate");
    assert.ok(r.sink.arrivals.length <= res.handoffs.debited - res.handoffs.unattempted.length, "arrivals ≤ attempted");
  }
  closedInvariants(r, res);
  assert.equal(r.events.filter((e) => e.type === "terminate").length, 1, "one terminal reason");
}

/**
 * `closed` (e5 plan §2.4): at most one seq, every send the same bytes, after `gate_closed`, only
 * when cleanup was proven, carrying the final debit, after every other renewal, and acknowledged
 * when Peeps accepted it.
 */
export function closedInvariants(r: Rig, res: LoadResult): void {
  const closed = r.port.renewals.filter((x) => x.fields.state === "closed");
  if (closed.length === 0) {
    assert.ok(res.closed.state !== "acked" && res.closed.state !== "refused", res.closed.state);
    return;
  }
  assert.equal(new Set(closed.map((x) => x.body)).size, 1, "one closed, identical bytes on every send");
  assert.equal(res.cleanup === "clean" || res.cleanup === "not_started", true, `closed only with cleanup proven (${res.cleanup})`);
  const gateClosedAt = r.events.findIndex((e) => e.type === "gate_closed");
  const closedAt = r.events.findIndex((e) => e.type === "closed");
  if (r.events.some((e) => e.type === "gate_closed")) assert.ok(gateClosedAt < closedAt || closedAt < 0, "closed after gate_closed");
  const first = r.port.renewals.indexOf(closed[0]!);
  assert.ok(r.port.renewals.slice(first).every((x) => x.fields.state === "closed"), "no renewal after closed");
  const seqs = r.port.renewals.filter((x) => x.fields.state !== "closed").map((x) => x.seq);
  assert.ok(closed[0]!.seq > Math.max(0, ...seqs), "closed follows every renewal sent");
  assert.equal(closed[0]!.fields.inFlight, 0);
  if (res.handoffs) assert.equal(closed[0]!.fields.debited, res.handoffs.debited, "closed carries the final debit");
  if (res.final !== "missing") assert.equal(closed[0]!.fields.debited, res.final.watermark, "closed and the final watermark share one debit");
  if (res.closed.state === "acked") assert.ok(r.port.closed, "acknowledged only what Peeps accepted");
}


const SCRIPTED = path.resolve(__dirname, "../fixtures/load-engine/e4/scripted-executor.js");
/** The scripted executor (test/fixtures/load-engine/e4), told what to do by its environment. */
export const scripted = (env: Record<string, string>): RigOptions["jail"] => ({ command: [process.execPath, SCRIPTED], env });

export function why(r: Rig, res: LoadResult): string {
  return JSON.stringify({ status: res.status, reason: res.reason, failures: res.failures.slice(0, 3), checking: res.checking, stderr: r.jails.made[0]?.stderr().slice(-2000) });
}

/** An observer that acts once the run enters `phase`. */
export const onPhase = (phase: "checking" | "measurement", act: (r: Rig) => void) => (e: LoadEvent, r: Rig) => {
  if (e.type === "phase" && e.phase === phase) act(r);
};

/** Resolves once Peeps has seen a draining renewal. */
export async function waitDraining(r: Rig): Promise<void> {
  for (let i = 0; i < 200; i++) {
    if (r.port.renewals.some((x) => x.fields.state === "draining" && x.answered)) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}
