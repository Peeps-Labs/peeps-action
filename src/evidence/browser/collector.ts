/** Browser coverage as a collector of the port: an attempt's coverage read against the build's fingerprint. */
import type { EvidenceCollector } from "../port";
import { browserFootprint, type AttemptCoverage, type CoverageIndex } from "./rules";

export function browserCollector(index: CoverageIndex): EvidenceCollector<AttemptCoverage> {
  return {
    collect(coverage) {
      const { keys, partial, reasons } = browserFootprint(coverage, index);
      return { keys, paths: [], partial, reasons };
    },
  };
}
