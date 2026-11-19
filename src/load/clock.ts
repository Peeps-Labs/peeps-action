/**
 * The qualified clock (Sol): elapsed time the engine can trust to bound permission.
 *
 * Each `tick` reads both the monotonic clock and the wall clock. Elapsed time advances by the
 * larger of the two steps, so permission time remaining is the shorter of what the two clocks
 * say is left: if either says a lease is over, it is over. If the two diverge beyond a bound,
 * or the gap between ticks exceeds a bound (a suspend, a `SIGSTOP`, a VM pause, a frozen
 * event loop), the clock raises a **resume fence**. While fenced nothing may start and no
 * permit may be given, until a lease renewal *sent after the fence was raised* comes back:
 * an answer to a request sent before the pause proves nothing about now.
 *
 * Pure: the clocks are handed in.
 */

export interface ClockSources {
  /** Monotonic milliseconds (`performance.now()`, `process.hrtime`). */
  monoMs(): number;
  /** Wall-clock milliseconds (`Date.now()`). */
  wallMs(): number;
}

export interface ClockBounds {
  /** The most the two clocks' steps may differ by in one tick. */
  maxDivergenceMs: number;
  /** The longest acceptable gap between two ticks. */
  maxGapMs: number;
}

export type FenceReason = "divergence" | "gap" | "backwards";

export class QualifiedClock {
  private lastMono: number;
  private lastWall: number;
  private elapsed = 0;
  private fencedAt: number | null = null;
  private reason: FenceReason | null = null;

  constructor(
    private readonly sources: ClockSources,
    private readonly bounds: ClockBounds,
  ) {
    this.lastMono = sources.monoMs();
    this.lastWall = sources.wallMs();
  }

  /** Elapsed milliseconds since the clock was made, as permission counts them. */
  get nowMs(): number {
    return this.elapsed;
  }

  get fenced(): boolean {
    return this.fencedAt !== null;
  }

  get fenceReason(): FenceReason | null {
    return this.reason;
  }

  /** When the current fence was raised, on this clock; null when not fenced. */
  get fencedAtMs(): number | null {
    return this.fencedAt;
  }

  tick(): number {
    const mono = this.sources.monoMs();
    const wall = this.sources.wallMs();
    const dMono = mono - this.lastMono;
    const dWall = wall - this.lastWall;
    this.lastMono = mono;
    this.lastWall = wall;
    this.elapsed += Math.max(0, dMono, dWall);
    let reason: FenceReason | null = null;
    if (dMono < 0 || dWall < 0) reason = "backwards";
    else if (dMono > this.bounds.maxGapMs || dWall > this.bounds.maxGapMs) reason = "gap";
    else if (Math.abs(dWall - dMono) > this.bounds.maxDivergenceMs) reason = "divergence";
    if (reason) {
      // A later fence moves the bar: only a renewal sent after it lifts it.
      this.fencedAt = this.elapsed;
      this.reason = reason;
    }
    return this.elapsed;
  }

  /**
   * A renewal came back for a request sent at `sentAtMs` (this clock). It lifts the fence
   * only when that request was sent after the fence was raised. Returns whether the clock is
   * clear now.
   */
  renewed(sentAtMs: number): boolean {
    if (this.fencedAt !== null && sentAtMs >= this.fencedAt) {
      this.fencedAt = null;
      this.reason = null;
    }
    return this.fencedAt === null;
  }
}
