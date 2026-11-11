/** A fingerprint as JSON, as the scanner's process answers it (`reach/main.ts`). No parser here: the action's own bundle imports this. */
import type { Fingerprint, ScriptIndex } from "./rules";

export interface WireFingerprint {
  entities: Array<[string, string]>;
  files: Array<[string, string]>;
  global: string[];
  scripts: Array<[string, ScriptIndex]>;
  sheets: Array<[string, ScriptIndex]>;
}

export function toWire(fingerprint: Fingerprint): WireFingerprint {
  return {
    entities: [...fingerprint.entities],
    files: [...fingerprint.files],
    global: fingerprint.global,
    scripts: [...fingerprint.scripts],
    sheets: [...fingerprint.sheets],
  };
}

export function fromWire(wire: WireFingerprint): Fingerprint {
  return {
    entities: new Map(wire.entities),
    files: new Map(wire.files),
    global: wire.global,
    scripts: new Map(wire.scripts),
    sheets: new Map(wire.sheets),
  };
}
