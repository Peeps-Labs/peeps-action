/** The HAR footprint as a collector of the evidence port: the paths an attempt requested. */
import type { EvidenceCollector } from "../evidence/port";
import { takeFootprint } from "./trace-file";

export interface HarAttempt {
  attempt: Parameters<typeof takeFootprint>[0];
  use: Parameters<typeof takeFootprint>[1];
  origins: string[];
}

export const harCollector: EvidenceCollector<HarAttempt> = {
  collect({ attempt, use, origins }) {
    const footprint = takeFootprint(attempt, use, origins);
    return footprint.complete
      ? { keys: [], paths: footprint.paths, partial: [], reasons: [] }
      : { keys: [], paths: footprint.paths, partial: ["route"], reasons: ["har_incomplete"] };
  },
};
