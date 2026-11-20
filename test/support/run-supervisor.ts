/**
 * The supervisor end to end for its tests (e4 plan v3 §3.2): a checkout with a workload, the
 * HTTPS sink behind its approved origin, the fake Peeps and a jail (the fake one by default).
 * The clock seam shifts the supervisor's monotonic and wall clocks on their own, so a test can
 * step one without the other.
 */
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync, cpSync } from "node:fs";
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
import { startSink, type Sink, type SinkOptions } from "./load-sink";

export const SINK_HOST = "sink.test";
const FLOOR_DIR = process.env.PEEPS_LOAD_PLAYWRIGHT_DIR;
const REPO = path.resolve(__dirname, "../..");
export const WORKLOAD_PATH = "peeps/load/smoke.workload.yaml";

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
  jail?: FakeJailOptions;
  /** Starts the jail some other way (the real jail in load-jail). */
  launch?: (spec: JailSpec, options: StartJailOptions, signal?: AbortSignal) => Promise<JailHandle>;
  seams?: Partial<LoadSeams>;
  /** Wraps the fixture dial. */
  dial?: (inner: Dial) => Dial;
  signal?: AbortSignal;
  /** Runs with every event, in order. */
  observer?: (e: LoadEvent, rig: Rig) => void;
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
  startSlackMs: 1_000,
  reportingMs: 4_000,
  loadedMs: 30_000,
  tickMs: 20,
  renewAttemptMs: 500,
};

export async function rig(t: TestContext, o: RigOptions = {}): Promise<Rig> {
  const sink = o.sink ?? (await startSink({ host: SINK_HOST, respond: o.respond ?? fixtureRespond }));
  if (!o.sink) t.after(() => sink.close());
  const ws = o.ws ?? workspace(t);
  const origin = canonicalOrigin(SINK_HOST, sink.port);
  const plan = o.plan ?? smallPlan({ exportName: o.exportName ?? "get" });
  const binding: Binding = await bindingOf(ws, WORKLOAD_PATH);
  o.afterBinding?.(ws);
  const setup: FakeSetup = {
    plan,
    limits: { allowedOrigins: [origin], privateOrigins: { [origin]: ["127.0.0.0/8"] }, maxUsers: 10, requestBudget: 1000, policyRevision: 1, phases: {}, ...o.limits },
    workload: { path: WORKLOAD_PATH, digest: binding.workload.digest, module: plan.journey.module, export: plan.journey.export },
    baseURL: origin,
    binding,
    ttlMs: 3000,
    renewEveryMs: 500,
    ...o.setup,
  };
  const port = new FakeControlPort(setup, o.script);
  const seam = new ClockSeam();
  const jails = fakeJail(o.jail);
  const real: Dial = (orig, signal, _pin, ready) => connectVerified("127.0.0.1", orig, { ca: [sink.caPem], signal, ready });
  const events: LoadEvent[] = [];
  const self = { ws, sink, port, seam, events, jails, origin } as Rig;
  self.result = runLoad(
    { runId: `t${Math.random().toString(36).slice(2, 10)}`, workspace: ws, workloadPath: WORKLOAD_PATH, nodeDir: path.dirname(path.dirname(process.execPath)), actionDir: path.join(REPO, "dist"), port, signal: o.signal, observer: (e) => {
      events.push(e);
      o.observer?.(e, self);
    } },
    {
      clocks: seam.clocks,
      // The real jail's callers install before the run (as the action's pre-claim step would); the digest is read here.
      preinstall: async (w: string) => ({ lock: "", hiddenLock: "", tree: (await bindingOf(w, WORKLOAD_PATH)).treeDigest }),
      ...(o.real ? {} : { launch: o.launch ?? jails.launch, probe: async () => ({ passed: true, failures: [], seen: null }) }),
      dial: o.dial ? o.dial(real) : real,
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
    assert.ok(res.handoffs.unattempted.every((s) => snap.handoffs.unattempted.includes(s)), "no attempt after terminate");
    assert.ok(r.sink.arrivals.length <= res.handoffs.debited - res.handoffs.unattempted.length, "arrivals ≤ attempted");
  }
  for (const rec of r.port.renewals) assert.notEqual(rec.fields.state, "closed", "no closed renewal");
  assert.equal(r.events.filter((e) => e.type === "terminate").length, 1, "one terminal reason");
}

