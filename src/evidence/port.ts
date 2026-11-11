/**
 * The action's collection port: what one collector saw of one test attempt. Each
 * collector is an adapter (`footprint/collector.ts` the HAR footprint, `browser/collector.ts`
 * browser coverage), and an attempt's evidence is their union. Plaintext here; `hash.ts`
 * keys it before anything leaves the job. Pure.
 */

/** Which evidence a collector couldn't see whole, as Peeps' `ImpactEvidenceKind`. */
export type EvidenceKind = "code" | "out" | "css" | "route" | "table";

import { LAYERS, type Layer } from "./codec";

export interface AttemptEvidence {
  /** `fn:`, `file:`, `css:` and `out:` keys. */
  keys: string[];
  /** The paths the attempt requested, read as routes on the path side. */
  paths: string[];
  partial: EvidenceKind[];
  /** The layers its partial holds for (PQA-3430): the browser's coverage says nothing of the server. Absent: every layer. */
  layers?: Layer[];
  reasons: string[];
}

export interface EvidenceCollector<Attempt> {
  collect(attempt: Attempt): AttemptEvidence;
}

const sortedUnique = <T extends string>(values: T[]): T[] => [...new Set(values)].sort();

export function unionEvidence(parts: AttemptEvidence[]): AttemptEvidence {
  const partial = sortedUnique(parts.flatMap((p) => p.partial));
  // Only a partial part says where it's partial; one that doesn't say is partial everywhere.
  const layers = new Set(parts.filter((p) => p.partial.length > 0).flatMap((p) => p.layers ?? LAYERS));
  return {
    keys: sortedUnique(parts.flatMap((p) => p.keys)),
    paths: sortedUnique(parts.flatMap((p) => p.paths)),
    partial,
    ...(partial.length > 0 ? { layers: LAYERS.filter((layer) => layers.has(layer)) } : {}),
    reasons: sortedUnique(parts.flatMap((p) => p.reasons)),
  };
}
