/**
 * One phase's request budget (Checking, or measurement), on an injected clock: a total, a
 * token bucket for rate and burst, a concurrency ceiling, the phase deadline, the run's
 * absolute end and each turn's deadline. Every network send asks it first and gets a permit
 * or a refusal with its reason.
 *
 * A refusal is `final` when waiting cannot change it (the total is spent, a deadline has
 * passed); `rate` and `concurrency` refusals say how long to wait, and the supervisor holds
 * the request until then, within the turn's deadline. Tokens are counted in integer
 * thousandths, so the same calls always give the same answers.
 *
 * Pure: no file system, network or Playwright.
 */
import type { PhaseBudget } from "./engine-limits";

export type DenyReason = "absolute_end" | "phase_deadline" | "turn_deadline" | "total" | "concurrency" | "rate";

export type PermitAnswer =
  | { ok: true; seq: number }
  | { ok: false; reason: DenyReason; final: boolean; retryInMs?: number };

const MILLI = 1000;

export class PhaseGate {
  private milliTokens: number;
  private lastRefillMs: number;
  private issuedCount = 0;
  private inFlightCount = 0;

  constructor(
    readonly budget: PhaseBudget,
    /** When the phase began, on the engine's clock. */
    readonly phaseStartMs: number,
    /** The run's absolute end, on the same clock. */
    readonly absoluteEndMs: number,
  ) {
    this.milliTokens = budget.burst * MILLI;
    this.lastRefillMs = phaseStartMs;
  }

  get issued(): number {
    return this.issuedCount;
  }

  get inFlight(): number {
    return this.inFlightCount;
  }

  get phaseEndMs(): number {
    return Math.min(this.phaseStartMs + this.budget.phaseDeadlineMs, this.absoluteEndMs);
  }

  private refill(nowMs: number): void {
    if (nowMs <= this.lastRefillMs) return;
    const added = (nowMs - this.lastRefillMs) * this.budget.ratePerSecond;
    this.milliTokens = Math.min(this.budget.burst * MILLI, this.milliTokens + added);
    this.lastRefillMs = nowMs;
  }

  /** Whether a turn that began at `turnStartMs` may send now; takes the permit when it may. */
  permit(nowMs: number, turnStartMs: number): PermitAnswer {
    if (nowMs >= this.absoluteEndMs) return { ok: false, reason: "absolute_end", final: true };
    if (nowMs >= this.phaseStartMs + this.budget.phaseDeadlineMs) return { ok: false, reason: "phase_deadline", final: true };
    if (nowMs >= turnStartMs + this.budget.turnDeadlineMs) return { ok: false, reason: "turn_deadline", final: true };
    if (this.issuedCount >= this.budget.totalRequests) return { ok: false, reason: "total", final: true };
    if (this.inFlightCount >= this.budget.concurrency) return { ok: false, reason: "concurrency", final: false, retryInMs: 1 };
    this.refill(nowMs);
    if (this.milliTokens < MILLI) {
      const retryInMs = Math.ceil((MILLI - this.milliTokens) / this.budget.ratePerSecond);
      return { ok: false, reason: "rate", final: false, retryInMs };
    }
    this.milliTokens -= MILLI;
    this.issuedCount += 1;
    this.inFlightCount += 1;
    return { ok: true, seq: this.issuedCount };
  }

  /** A permitted request has finished (answered, failed or abandoned). */
  release(): void {
    if (this.inFlightCount > 0) this.inFlightCount -= 1;
  }
}
