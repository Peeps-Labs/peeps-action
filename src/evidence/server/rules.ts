/**
 * One invocation's server footprint (PQA-3201 PR 3): what the app's processes ran while
 * one spec file's tests (or none, for ambient) ran against them, as fingerprint keys. The
 * invocation owns those processes for their whole life, so everything they ran is its
 * tests'; nothing is attributed by time. Pure: `lifecycle.ts` collects it.
 *
 * Partial on anything unknown: no process registered, one whose coverage was never taken,
 * a coverage file that didn't parse, a function that ran in the job's build with no key,
 * or trouble around the app (its reset, readiness, an early exit). A partial footprint is
 * unknown for code: those tests always run. `node_modules` and Node itself are the runtime,
 * which the fingerprint treats as global: neither keyed nor partial. Other code that ran
 * outside `.next` is keyed by the fingerprinted source it is; tracked source the fingerprint
 * doesn't name needs nothing (a change to it is unaccounted); anything else, such as a
 * compiled custom server's output, is unknown (`outside_build`).
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
  /** Every process that wrote at least one coverage file. */
  covered: number[];
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

/**
 * Code the server ran from source outside `.next` and `node_modules`: what `next.config`
 * imports, a custom server running source the build also bundles, or a monorepo sibling
 * package. Its absolute path, or null for anything else.
 */
function sourceFileOf(url: string): string | null {
  if (!url.startsWith("file:")) return null;
  let file: string;
  try {
    file = fileURLToPath(url);
  } catch {
    return null;
  }
  const posix = file.split(path.sep).join("/");
  return posix.includes("/node_modules/") ? null : posix;
}

/**
 * The fingerprinted sources a file is. A source is repo-relative, so it's a suffix of the
 * file's absolute path wherever the app sits; matching more than one only over-attributes.
 * A file the fingerprint doesn't name needs nothing: a change to it is a file no entity
 * accounts for, which runs everything.
 */
/** Next's own config, and the copy it compiles beside it: a change to it runs everything anyway. */
const NEXT_CONFIG = /^next\.config(?:\.compiled)?\.(?:js|mjs|cjs|ts|mts)$/;

function sourcesOf(file: string, sources: ReadonlySet<string>): string[] {
  return [...sources].filter((source) => file === source || file.endsWith(`/${source}`));
}

export function serverFootprint(
  coverage: InvocationCoverage,
  scripts: ReadonlyMap<string, ScriptIndex>,
  nextDir: string,
  /** Every source the fingerprint names (`Fingerprint.files`' values). */
  sources: ReadonlySet<string> = new Set(),
  /** Whether git tracks this absolute path: by default nothing is, so unmatched code reads unknown. */
  tracked: (file: string) => boolean = () => false,
): ServerFootprint {
  const keys = new Set<string>();
  const loaded = new Set<string>();
  let unmapped = 0;
  let outside = 0;
  for (const { result } of coverage.files) {
    for (const script of result) {
      const file = builtFileOf(script.url, nextDir);
      if (file === null) {
        const rel = sourceFileOf(script.url);
        if (rel === null) continue;
        // The join is by file until PR 4: a test whose run ran it holds its file.
        const ran = script.functions.some((fn) => (fn.ranges[0]?.count ?? 0) > 0);
        const named = sourcesOf(rel, sources);
        for (const source of named) {
          loaded.add(`file:${source}`);
          if (ran) keys.add(`file:${source}`);
        }
        // Built output of a fingerprinted source (dist/), which no change names: unknown.
        if (ran && named.length === 0 && !tracked(rel) && !NEXT_CONFIG.test(path.posix.basename(rel))) outside++;
        continue;
      }
      const index = scripts.get(file);
      if (index?.whole) loaded.add(index.whole);
      for (const span of index?.spans ?? []) if (span.source !== null) loaded.add(`file:${span.source}`);
      for (const fn of script.functions) {
        const range = fn.ranges[0];
        if (!range || range.count === 0) continue;
        // A script with no map is one entity: its top level running is it running.
        if (index?.whole) {
          keys.add(index.whole);
          continue;
        }
        // A built script the fingerprint doesn't know ran: whatever it ran is unknown.
        if (!index) {
          unmapped++;
          continue;
        }
        // The script's own top level, which V8 reports as a function.
        if (range.startOffset === 0 && fn.functionName === "") continue;
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
  // A take reports an app's own stopCoverage on stderr, and writes nothing: the marker isn't enough.
  const covered = new Set(coverage.covered);
  if (coverage.started.some((pid) => !covered.has(pid))) reasons.push("no_coverage");
  if (coverage.unreadable > 0) reasons.push("unreadable");
  if (unmapped > 0) reasons.push("unmapped");
  if (outside > 0) reasons.push("outside_build");
  return { keys: [...keys].sort(), loaded: [...loaded].sort(), partial: reasons.length > 0 ? ["code"] : [], reasons };
}
