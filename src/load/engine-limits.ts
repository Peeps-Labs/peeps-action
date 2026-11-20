/**
 * The engine's own budgets: per-phase rate, burst, concurrency and request totals, and the
 * deadlines around them. Peeps' `Limits` carries origins, users and one request budget; these
 * per-phase numbers stay engine constants until PR 3 puts them on the grant (PR 2 plan §2).
 * Starting values are the product spec's §10.3 proposals. `test/fixtures/load-engine/
 * limits-mapping.json` pins how a `{plan, limits}` becomes these budgets.
 *
 * Pure: no file system, network or Playwright.
 */
import type { GrantLimits, GrantPhaseCaps } from "./control-port";
import type { GateLimits, PhaseCaps } from "./gate/admission";
import { canonicalOrigin, type RequestPolicy } from "./gate/normalize";
import type { ProxyLimits } from "./gate/proxy";
import type { ApprovedOrigin } from "./gate/resolve";
import type { PlanInput } from "./plan-input";

export const ENGINE_LIMITS = {
  /** Checking proves the journey with at most 5 users (§10.3). */
  checkingMaxUsers: 5,
  /** Checking and rehearsal budget: 10,000 requests a day per environment (§10.3). */
  checkingDailyRequests: 10_000,
  /** How long Checking may take before the run "didn't start". */
  checkingDeadlineMs: 120_000,
  /** The most a single turn (one journey invocation) may take. */
  turnDeadlineMs: 30_000,
  /** Ramp-down and Stop grace (§10.3). */
  stopGraceMs: 30_000,
  /** How long after a due tick a start may still begin. */
  startSlackMs: 1_000,
  /** A sustained request-rate cap per phase, whatever the plan asks. */
  maxRatePerSecond: 200,
  /** The bucket's size: how many requests may go at once after a quiet spell (never more
   * than every user's whole turn). */
  maxBurst: 50,
  /** The lease (§9.1, 30–60 s). */
  leaseMs: 45_000,
} as const;

export type EngineConstants = { -readonly [K in keyof typeof ENGINE_LIMITS]: number };

export interface PhaseBudget {
  users: number;
  totalRequests: number;
  ratePerSecond: number;
  burst: number;
  /** One request in flight per user: never more than `users`. */
  concurrency: number;
  phaseDeadlineMs: number;
  turnDeadlineMs: number;
}

export interface EngineBudgets {
  checking: PhaseBudget;
  measurement: PhaseBudget;
  stopGraceMs: number;
  startSlackMs: number;
  leaseMs: number;
  /** From the engine's start: Checking, the measured stages and the stop grace, never more. */
  absoluteEndMs: number;
}

function rateFor(users: number, perJourneyMax: number, pacingEveryMs: number, constants: EngineConstants): number {
  // What the plan could need on average with every user busy, capped.
  const need = Math.ceil((users * perJourneyMax * 1000) / pacingEveryMs);
  return Math.max(1, Math.min(constants.maxRatePerSecond, need));
}

/** A valid `{plan, limits}` as the engine's budgets. */
export function engineBudgets(input: PlanInput, constants: EngineConstants = ENGINE_LIMITS): EngineBudgets {
  const { plan, limits } = input;
  const perJourney = plan.requests.perJourneyMax;
  const pacing = plan.cohort.pacingEveryMs;
  const turnDeadlineMs = Math.min(constants.turnDeadlineMs, constants.checkingDeadlineMs);

  const checkingUsers = Math.min(constants.checkingMaxUsers, plan.peakUsers, limits.maxUsers);
  const checking: PhaseBudget = {
    users: checkingUsers,
    // One turn per Checking user.
    totalRequests: Math.min(checkingUsers * perJourney, constants.checkingDailyRequests, limits.requestBudget),
    ratePerSecond: rateFor(checkingUsers, perJourney, pacing, constants),
    burst: Math.min(constants.maxBurst, checkingUsers * perJourney),
    concurrency: checkingUsers,
    phaseDeadlineMs: constants.checkingDeadlineMs,
    turnDeadlineMs,
  };

  const users = Math.min(plan.peakUsers, limits.maxUsers);
  const measurement: PhaseBudget = {
    users,
    // The request budget is per run: the supervisor takes Checking's issued permits off this
    // when measurement begins.
    totalRequests: Math.min(plan.requests.ceiling, limits.requestBudget),
    ratePerSecond: rateFor(users, perJourney, pacing, constants),
    burst: Math.min(constants.maxBurst, users * perJourney),
    concurrency: users,
    phaseDeadlineMs: plan.durationMs + constants.stopGraceMs,
    turnDeadlineMs: Math.min(constants.turnDeadlineMs, plan.durationMs + constants.stopGraceMs),
  };

  return {
    checking,
    measurement,
    stopGraceMs: constants.stopGraceMs,
    startSlackMs: Math.min(constants.startSlackMs, pacing),
    leaseMs: constants.leaseMs,
    absoluteEndMs: checking.phaseDeadlineMs + measurement.phaseDeadlineMs,
  };
}

// ---------------------------------------------------------------- the run's gate limits (e4 plan v3 §2.3)

/** Per-turn dial limit: the same whatever the grant. */
export const DIALS_PER_TURN = 4;
/** Requests in flight per turn (the session's `parallel` is at most this). */
export const OUTSTANDING_PER_TURN = 8;
const MAX_PENDING_DIALS = 256;

export interface RunLimits {
  checking: PhaseCaps;
  measurement: PhaseCaps;
  /** Everything the gate needs but the run's end and the first phase, which the supervisor sets. */
  gate: Omit<GateLimits, "runEndMono" | "runEndWall" | "phase">;
  policy: RequestPolicy;
  /** Canonical origin → how it is dialled. */
  approved: Map<string, ApprovedOrigin>;
  proxy: Pick<ProxyLimits, "maxPendingDials" | "maxPendingDialsPerTurn">;
  budgets: EngineBudgets;
}

export type RunLimitsResult = { ok: true; value: RunLimits } | { ok: false; reason: "reduced" | "origin_unsupported" | "invalid"; detail: string };

/**
 * A validated `{plan, limits}` and the grant's limits as the run's gate limits. Phase caps are the
 * componentwise minimum of the engine's and the grant's. `onReduced: "refuse"`: a run whose
 * measurement caps, or whose run budget left after Checking's maximum, fall short of the plan is
 * refused.
 */
export function runLimits(input: PlanInput, grant: GrantLimits, o: { parallel: number; constants?: EngineConstants }): RunLimitsResult {
  const budgets = engineBudgets({ plan: input.plan, limits: { ...input.limits, maxUsers: Math.min(input.limits.maxUsers, grant.maxUsers), requestBudget: Math.min(input.limits.requestBudget, grant.requestBudget) } }, o.constants);
  const engine = (b: PhaseBudget): PhaseCaps => ({ ratePerSecond: b.ratePerSecond, burst: b.burst, maxUsers: b.users, total: b.totalRequests });
  const lower = (mine: PhaseCaps, theirs: GrantPhaseCaps | undefined): PhaseCaps | string => {
    const out = { ...mine };
    for (const key of ["ratePerSecond", "burst", "maxUsers", "total"] as const) {
      const v = theirs?.[key];
      if (v === undefined) continue;
      const okValue = key === "ratePerSecond" ? Number.isFinite(v) && v > 0 : Number.isSafeInteger(v) && v >= (key === "burst" ? 1 : 0);
      if (!okValue) return `phase ${key} ${String(v)}`;
      out[key] = Math.min(out[key], v);
    }
    return out;
  };
  const checking = lower(engine(budgets.checking), grant.phases.checking);
  const measurement = lower(engine(budgets.measurement), grant.phases.measurement);
  if (typeof checking === "string") return { ok: false, reason: "invalid", detail: checking };
  if (typeof measurement === "string") return { ok: false, reason: "invalid", detail: measurement };

  const { plan } = input;
  const runTotal = Math.min(input.limits.requestBudget, grant.requestBudget);
  const reduced: string[] = [];
  if (measurement.maxUsers < plan.peakUsers) reduced.push(`users ${measurement.maxUsers} < ${plan.peakUsers}`);
  if (measurement.total < plan.requests.ceiling) reduced.push(`measurement total ${measurement.total} < ${plan.requests.ceiling}`);
  if (measurement.ratePerSecond < budgets.measurement.ratePerSecond) reduced.push(`rate ${measurement.ratePerSecond} < ${budgets.measurement.ratePerSecond}`);
  if (runTotal - checking.total < plan.requests.ceiling) reduced.push(`budget after Checking ${runTotal - checking.total} < ${plan.requests.ceiling}`);
  if (plan.onReduced === "refuse" && reduced.length) return { ok: false, reason: "reduced", detail: reduced.join("; ") };

  const origins: Record<string, number> = {};
  const approved = new Map<string, ApprovedOrigin>();
  for (const raw of grant.allowedOrigins) {
    let url: URL;
    try {
      url = new URL(raw);
    } catch {
      return { ok: false, reason: "invalid", detail: `origin ${raw}` };
    }
    if (url.protocol !== "https:") return { ok: false, reason: "origin_unsupported", detail: raw };
    const port = url.port ? Number(url.port) : 443;
    const origin = canonicalOrigin(url.hostname, port);
    origins[origin] = grant.originCaps ? Math.min(runTotal, grant.originCaps[origin] ?? grant.originCaps[raw] ?? 0) : runTotal;
    approved.set(origin, { host: url.hostname, port, privateCidrs: [...(grant.privateOrigins[raw] ?? grant.privateOrigins[origin] ?? [])] });
  }
  const users = Math.max(checking.maxUsers, measurement.maxUsers);
  return {
    ok: true,
    value: {
      checking,
      measurement,
      gate: {
        origins,
        methods: [...new Set(["GET", "HEAD", ...plan.allowedRequests.map((r) => r.method)])],
        maxOutstandingPerTurn: OUTSTANDING_PER_TURN,
        maxRequestsPerTurn: plan.requests.perJourneyMax,
        runTotal,
        turnDeadlineMs: budgets.measurement.turnDeadlineMs,
      },
      policy: { allowedOrigins: Object.keys(origins), allowedRequests: plan.allowedRequests.map((r) => ({ ...r })) },
      approved,
      proxy: { maxPendingDialsPerTurn: DIALS_PER_TURN, maxPendingDials: Math.min(users * o.parallel, MAX_PENDING_DIALS) },
      budgets,
    },
  };
}
