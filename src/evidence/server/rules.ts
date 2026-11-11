/**
 * One invocation's server footprint (PQA-3201 PR 3): what the app's processes ran while
 * one spec file's tests (or none, for ambient) ran against them, as fingerprint keys. The
 * invocation owns those processes for their whole life, so everything they ran is its
 * tests'; nothing is attributed by time. Pure: `lifecycle.ts` collects it.
 *
 * Partial on anything unknown: no process registered, one whose coverage was never taken,
 * a coverage file that didn't parse, a function that ran in the job's build with no key,
 * or trouble around the app (its reset, readiness, an early exit). A partial footprint is
 * unknown for code: those tests always run. Code outside the job's `.next` (the Next
 * runtime, `node_modules`, Node itself) is the runtime, which the fingerprint treats as
 * global, so it is neither keyed nor partial.
 */
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spanAt } from "../browser/rules";
import type { ScriptIndex } from "../fingerprint/rules";

/** One script of a V8 coverage file (`NODE_V8_COVERAGE`), as V8 writes it. */
export interface V8Script {
  url: string;
  functions: Array<{ functionName: string; ranges: Array<{ startOffset: number; endOffset: number; count: number }> }>;
}

export interface InvocationCoverage {
  /** Every app process that registered (the preload's `pid-` marker). */
  started: number[];
  /** Every process whose coverage was taken before it ended (`taken-`). */
  taken: number[];
  /** Every coverage file the processes wrote: each take, and each exit. */
  files: Array<{ result: V8Script[] }>;
  /** Coverage files that didn't parse. */
  unreadable: number;
  /** What went wrong around the app, named: `reset_failed`, `not_ready`, `app_exited`, … */
  problems: string[];
}

export interface ServerFootprint {
  /** Plaintext keys, sorted: `hash.ts` keys them before upload. */
  keys: string[];
  /** Every source of every built script a process loaded, run or not. */
  loaded: string[];
  partial: Array<"code">;
  reasons: string[];
}

/** The script's path under the job's `.next`, or null when it's anything else. */
function builtFileOf(url: string, nextDir: string): string | null {
  if (!url.startsWith("file:")) return null;
  let file: string;
  try {
    file = fileURLToPath(url);
  } catch {
    return null;
  }
  const rel = path.relative(nextDir, file);
  if (rel === "" || rel.startsWith("..") || path.isAbsolute(rel)) return null;
  return rel.split(path.sep).join("/");
}

export function serverFootprint(coverage: InvocationCoverage, scripts: ReadonlyMap<string, ScriptIndex>, nextDir: string): ServerFootprint {
  const keys = new Set<string>();
  const loaded = new Set<string>();
  let unmapped = 0;
  for (const { result } of coverage.files) {
    for (const script of result) {
      const file = builtFileOf(script.url, nextDir);
      if (file === null) continue;
      const index = scripts.get(file);
      if (index?.whole) loaded.add(index.whole);
      for (const span of index?.spans ?? []) if (span.source !== null) loaded.add(`file:${span.source}`);
      for (const fn of script.functions) {
        const range = fn.ranges[0];
        if (!range || range.count === 0) continue;
        // The script's own top level, which V8 reports as a function.
        if (range.startOffset === 0 && fn.functionName === "") continue;
        if (index?.whole) {
          keys.add(index.whole);
          continue;
        }
        const span = index && spanAt(index, { name: fn.functionName, start: range.startOffset, end: range.endOffset });
        if (!span) {
          unmapped++;
          continue;
        }
        // Chunk scaffolding: it runs, and is no one's code.
        if (span.key === null) continue;
        keys.add(span.key);
        if (span.source !== null) keys.add(`file:${span.source}`);
      }
    }
  }
  const reasons = [...coverage.problems];
  if (coverage.started.length === 0) reasons.push("no_process");
  const taken = new Set(coverage.taken);
  if (coverage.started.some((pid) => !taken.has(pid))) reasons.push("not_taken");
  if (coverage.unreadable > 0) reasons.push("unreadable");
  if (unmapped > 0) reasons.push("unmapped");
  return { keys: [...keys].sort(), loaded: [...loaded].sort(), partial: reasons.length > 0 ? ["code"] : [], reasons };
}
