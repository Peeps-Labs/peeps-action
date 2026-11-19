/**
 * The one clock the supervisor and the executor share: absolute expiries on starts and permits
 * are read on it in both processes.
 *
 * Pure: no file system, network or Playwright.
 */

/** Milliseconds on CLOCK_MONOTONIC, which every process on the machine shares. */
export function sharedNowMs(): number {
  return Number(process.hrtime.bigint()) / 1e6;
}
