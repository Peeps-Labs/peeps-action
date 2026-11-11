/**
 * A fingerprint and a job's footprints as the codec's values, every id keyed under the
 * project key (`hash.ts`): what leaves the job holds no source path, function name or
 * route. Pure.
 */
import { LAYERS, type FingerprintEntity, type Layer, type RecordedMember, type RecordingBlob } from "./codec";
import type { Fingerprint } from "./fingerprint/rules";
import { evidenceTokens, keyedId, tokenOf } from "./hash";
import { unionEvidence, type AttemptEvidence, type EvidenceKind } from "./port";

const VALUE_HEX = 16;

function layerOf(plain: string): Layer {
  if (plain.startsWith("fn:browser:") || plain.startsWith("css:")) return "browser";
  if (plain.startsWith("out:")) return "build";
  return "server";
}

export function fingerprintRecording(fingerprint: Fingerprint, key: Buffer): RecordingBlob {
  const entities: FingerprintEntity[] = [];
  for (const [plain, values] of fingerprint.entities) {
    const source = fingerprint.files.get(plain);
    entities.push({
      id: tokenOf(key, plain),
      file: source === undefined ? null : tokenOf(key, `file:${source}`),
      layer: layerOf(plain),
      valueHash: keyedId(key, "value", values).slice(0, VALUE_HEX),
    });
  }
  // Only what the upload names: a global id that is no entity can't be read.
  const global = fingerprint.global.filter((plain) => fingerprint.entities.has(plain)).map((plain) => tokenOf(key, plain));
  return { kind: "fingerprint", entities, global };
}

export interface MemberEvidence {
  run: string;
  attempts: Array<{ retry: number; passed: boolean }>;
  /** Every collector's answer for every attempt of the test. */
  evidence: AttemptEvidence[];
}

export interface FootprintsInput {
  layers: Layer[];
  measured: EvidenceKind[];
  members: MemberEvidence[];
  /** Plaintext `file:` keys of what a measured process loaded, run or not. */
  loadedFiles?: string[];
  /** Plaintext keys every test shares: the app's code with no test running (`fn:`, `file:`), and the job's `table:r:` / `table:w:` keys. */
  ambient?: string[];
  /** The browser build that recorded: recording metadata, never the binding. */
  browser?: { name: string; version: string } | null;
  /** The codec version Peeps reads (`Collect.codecVersion`): 2 says each member's partial layers. */
  codecVersion?: number;
}

export function footprintsRecording(key: Buffer, input: FootprintsInput): RecordingBlob {
  const members: RecordedMember[] = input.members.map(({ run, attempts, evidence }) => {
    // No evidence from any collector proves nothing: every measured kind is unknown.
    const layered = input.codecVersion === 2;
    if (evidence.length === 0) return { run, attempts, partial: [...input.measured], ...(layered && input.measured.length > 0 ? { partialLayers: [...LAYERS] } : layered ? { partialLayers: [] } : {}), tokens: [] };
    const union = unionEvidence(evidence);
    return { run, attempts, partial: union.partial, ...(layered ? { partialLayers: union.layers ?? [] } : {}), tokens: evidenceTokens(key, union) };
  });
  return { kind: "footprints", browser: input.browser ?? null, universe: { layers: input.layers, measured: input.measured, loadedFiles: (input.loadedFiles ?? []).map((f) => tokenOf(key, f)), ambient: (input.ambient ?? []).map((k) => tokenOf(key, k)) }, members };
}
