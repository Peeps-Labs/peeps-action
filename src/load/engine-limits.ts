/**
 * The engine's own budgets: per-phase rate, burst, concurrency and request totals, and the
 * deadlines around them. Peeps' `Limits` carries origins, users and one request budget; these
 * per-phase numbers stay engine constants until PR 3 puts them on the grant (PR 2 plan §2).
 * Starting values are the product spec's §10.3 proposals. `test/fixtures/load-engine/
 * limits-mapping.json` pins how a `{plan, limits}` becomes these budgets.
 *
 * Pure: no file system, network or Playwright.
 */
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
