/**
 * The action's collection port: what one collector saw of one test attempt. Each
 * collector is an adapter (`footprint/collector.ts` the HAR footprint, `browser/collector.ts`
 * browser coverage), and an attempt's evidence is their union. Plaintext here; `hash.ts`
 * keys it before anything leaves the job. Pure.
 */

/** Which evidence a collector couldn't see whole, as Peeps' `ImpactEvidenceKind`. */
export type EvidenceKind = "code" | "out" | "css" | "route" | "table";

export interface AttemptEvidence {
  /** `fn:`, `file:`, `css:` and `out:` keys. */
  keys: string[];
  /** The paths the attempt requested, read as routes on the path side. */
  paths: string[];
  partial: EvidenceKind[];
  reasons: string[];
}

export interface EvidenceCollector<Attempt> {
  collect(attempt: Attempt): AttemptEvidence;
}

const sortedUnique = <T extends string>(values: T[]): T[] => [...new Set(values)].sort();

export function unionEvidence(parts: AttemptEvidence[]): AttemptEvidence {
  return {
    keys: sortedUnique(parts.flatMap((p) => p.keys)),
    paths: sortedUnique(parts.flatMap((p) => p.paths)),
    partial: sortedUnique(parts.flatMap((p) => p.partial)),
    reasons: sortedUnique(parts.flatMap((p) => p.reasons)),
  };
}
