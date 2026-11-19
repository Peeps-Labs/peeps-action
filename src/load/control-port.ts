/**
 * How the engine talks to whoever controls it: the lease, and where its evidence goes. Only a
 * fake adapter ships in this release (`test/support/fake-control-port.ts`); PR 3 adds the
 * HTTP adapter. No transport here.
 *
 * Pure: types only.
 */
import type { CohortRecord, IntervalRecord } from "./accounting";

export interface LeaseRequest {
  /** Increases by one with every request. */
  seq: number;
  /** When the request was sent, on the engine's qualified clock. */
  sentAtMs: number;
}

export interface LeaseAnswer {
  /** The `seq` this answers. An answer for an older seq than one accepted is ignored. */
  seq: number;
  granted: boolean;
  /** How long from the request's send time this grant lasts; the engine never takes more than
   * its own lease, and a shorter grant is honoured. */
  validForMs?: number;
  /** Set when someone asked the run to stop. */
  stop?: "graceful" | "now";
}

export type Phase = "checking" | "measurement";

export type MarkerKind =
  | "phase_started"
  | "stop_requested"
  | "starts_fenced"
  | "lease_lost"
  | "resume_fence"
  | "resume_cleared"
  | "executor_killed"
  | "traffic_stopped"
  | "bypass";

export interface Marker {
  kind: MarkerKind;
  /** On the engine's qualified clock. */
  atMs: number;
  detail?: string;
}

export interface PublishedInterval extends IntervalRecord {
  phase: Phase;
}

export interface PublishedCohort extends CohortRecord {
  phase: Phase;
}

export interface ControlPort {
  renewLease(request: LeaseRequest): Promise<LeaseAnswer>;
  publishInterval(record: PublishedInterval): Promise<void>;
  publishCohort(record: PublishedCohort): Promise<void>;
  publishMarker(marker: Marker): Promise<void>;
  publishFinal(result: unknown): Promise<void>;
}
