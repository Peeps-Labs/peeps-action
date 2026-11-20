/**
 * The clocks every check in the supervisor samples (e4 plan v3 §2.1). `monoMs` is
 * CLOCK_MONOTONIC, which `process.hrtime` reads and which is shared by every process in the
 * unit: the jail has no time namespace, so a deadline the supervisor writes in a ticket means
 * the same instant to init. `performance.now()` is not used: its origin is per process.
 */
import type { Clocks } from "./gate/admission";

export function sharedClocks(): Clocks {
  return { monoMs: Number(process.hrtime.bigint()) / 1e6, wallMs: Date.now() };
}
