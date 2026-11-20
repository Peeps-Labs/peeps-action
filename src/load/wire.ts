/**
 * The control wire's numbers and closed vocabularies, protocol 1 (e5 plan v3 §2.3–§2.4). They
 * are P1's `wire.ts` constants, and `test/load-wire-v1.test.ts` checks every one against the
 * shared corpus's `constants.json` (`test/fixtures/load-wire/v1/`, a byte-for-byte copy of
 * peeps'). A value Peeps sends outside these lists is never passed on: a refusal code becomes
 * `unknown`, and a stop reason makes the renew reply unreadable, which fails closed.
 *
 * Pure: constants and guards only.
 */

export const WIRE_PROTOCOL = 1 as const;

/** The claim body, as the UTF-8 of its canonical JSON. */
export const CLAIM_BODY_MAX_BYTES = 16 * 1024;
export const RENEW_BODY_MAX_BYTES = 4 * 1024;
/** The encoded events envelope. */
export const EVENTS_BODY_MAX_BYTES = 300 * 1024;
/** One events batch string, as UTF-8. */
export const EVENTS_BATCH_MAX_BYTES = 256 * 1024;

export const CLAIM_REFUSALS = [
  "auth",
  "unknown_grant",
  "wrong_workflow",
  "wrong_commit",
  "binding",
  "rerun",
  "duplicate_claim",
  "claim_superseded",
  "identity",
  "self_hosted",
  "fence_unverified",
  "expired",
  "stopped",
  "not_enabled",
  "policy_changed",
  "environment_changed",
  "outside_harness",
  "unsupported_protocol",
  "malformed",
] as const;
export type ClaimRefusal = (typeof CLAIM_REFUSALS)[number];

export const RENEW_REFUSALS = ["auth", "epoch", "hash", "gap", "changed_payload", "debited", "closed", "malformed"] as const;
export type RenewRefusal = (typeof RENEW_REFUSALS)[number];

export const EVENTS_REFUSALS = ["auth", "expired", "malformed", "hash", "stream", "gap", "conflict", "after_final", "budget"] as const;
export type EventsRefusal = (typeof EVENTS_REFUSALS)[number];

/** The only stop reasons a renew reply may carry (e5 plan v3 §2.4). */
export const STOP_REASONS = ["load_testing_off", "policy_changed", "environment_changed", "user_stop", "scope_deleted", "identity_conflict"] as const;
export type StopReason = (typeof STOP_REASONS)[number];

export const PHASES = ["starting", "checking", "measurement"] as const;
export type Phase = (typeof PHASES)[number];

const member = <T extends string>(list: readonly T[]) => (v: unknown): v is T => typeof v === "string" && (list as readonly string[]).includes(v);

export const isClaimRefusal = member(CLAIM_REFUSALS);
export const isStopReason = member(STOP_REASONS);
