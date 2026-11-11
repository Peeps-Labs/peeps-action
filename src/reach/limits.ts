/** What the announce takes: a reach over this would risk being refused, so its lists go. */
import type { Reach } from "./types";

export const MAX_REACH_BYTES = 256 * 1024;

export function capReach(reach: Reach): Reach {
  if (Buffer.byteLength(JSON.stringify(reach)) <= MAX_REACH_BYTES) return reach;
  return { ...reach, global: true, why: reach.why ?? "too_many_surfaces", surfaces: [], reasons: reach.reasons.slice(0, 1), changedFiles: [], changedTestFiles: [] };
}
