/**
 * A test attempt's browser coverage, the decisions (spike 3): which fingerprint keys it
 * ran, and when it can't be read whole. Pure: `cdp-coverage.ts` collects it.
 *
 * Partial on any of: a target detached before its final take, a setup or take error, a
 * cross-document navigation (the old document's CSS, and its JS cross-site, are gone),
 * an asset the browser loaded that coverage never saw, a built function or rule no key names,
 * or a browser other than Chromium, which has no precise coverage to read. A partial
 * footprint is unknown for code and CSS: that test always runs.
 */
import type { ScriptIndex } from "../fingerprint/rules";

export interface RanFunction {
  name: string;
  start: number;
  end: number;
}

export interface AttemptCoverage {
  /** Playwright's `browserName`. */
  browser: string;
  /** Functions that ran in this attempt, per script. */
  scripts: Array<{ url: string; functions: RanFunction[] }>;
  /** Stylesheet ranges this attempt used, per sheet. */
  sheets: Array<{ url: string; used: Array<{ start: number; end: number }> }>;
  /** Every script and stylesheet the browser loaded. */
  assets: string[];
  /** Every script and stylesheet coverage saw. */
  covered: string[];
  /** Targets that detached before their final take. */
  lost: number;
  /** Targets the app ran code in before coverage started there. */
  late?: number;
  /** Which, for diagnosis only. */
  lateDetail?: Array<{ type: string; held: boolean; ranBefore: boolean }>;
  /** Popups that may share an opener's isolate, whose earlier counts their start reset. */
  sharedIsolate?: number;
  /** Why each lost target is lost: diagnosis only, never uploaded. */
  lostDetail?: Array<{ type: string; targetId: string; url: string; context: string | null; inScope: boolean; profiler: boolean; css: boolean; detached: boolean }>;
  errors: string[];
  /** Cross-document navigations of a frame that already had a document. */
  navigations: number;
  /** Why nothing was collected at all, e.g. another precise-coverage user. */
  refused?: string;
}

export interface BrowserFootprint {
  /** Plaintext keys, sorted: `hash.ts` keys them before upload. */
  keys: string[];
  partial: Array<"code" | "css">;
  reasons: string[];
  mapped: number;
  unmapped: number;
}

export interface CoverageIndex {
  scripts: Map<string, ScriptIndex>;
  sheets: Map<string, ScriptIndex>;
}

const BUILT = "/_next/static/";
const PRECISE_COVERAGE = new Set(["chromium"]);

/** A built asset's file under `.next`, from its URL, whatever basePath or asset prefix serves it. */
export function builtFileOf(url: string): string | null {
  let pathname: string;
  try {
    pathname = decodeURIComponent(new URL(url).pathname);
  } catch {
    return null;
  }
  const at = pathname.indexOf(BUILT);
  return at < 0 ? null : `static/${pathname.slice(at + BUILT.length)}`;
}

const withoutFragment = (url: string) => url.split("#", 1)[0]!;

export function partialReasons(coverage: AttemptCoverage): string[] {
  if (coverage.refused) return [`refused:${coverage.refused}`];
  const reasons: string[] = [];
  if (coverage.lost > 0) reasons.push("target_lost");
  if ((coverage.late ?? 0) > 0) reasons.push("started_late");
  if ((coverage.sharedIsolate ?? 0) > 0) reasons.push("shared_isolate");
  if (coverage.errors.length > 0) reasons.push("take_error");
  if (coverage.navigations > 0) reasons.push("navigation");
  const covered = new Set(coverage.covered.map(withoutFragment));
  if (coverage.assets.some((url) => !covered.has(withoutFragment(url)))) reasons.push("asset_missing");
  return reasons;
}

/** V8's own functions for a class's fields and static members: no source function starts where they do. */
const SYNTHETIC = /^<(?:static_initializer|instance_members_initializer)>$/;

function spanAt(index: ScriptIndex, fn: RanFunction) {
  const exact = index.spans.find((span) => span.start === fn.start) ?? index.spans.find((span) => span.end === fn.end);
  if (exact || !SYNTHETIC.test(fn.name)) return exact;
  // The innermost function holding it: the class's code is that function's.
  let inner: (typeof index.spans)[number] | undefined;
  for (const span of index.spans) if (span.start <= fn.start && fn.end <= span.end && (!inner || span.end - span.start < inner.end - inner.start)) inner = span;
  return inner;
}

export function browserFootprint(coverage: AttemptCoverage, index: CoverageIndex): BrowserFootprint {
  if (!PRECISE_COVERAGE.has(coverage.browser)) {
    return { keys: [], partial: ["code", "css"], reasons: ["browser_unsupported"], mapped: 0, unmapped: 0 };
  }
  const keys = new Set<string>();
  let mapped = 0;
  let unmapped = 0;
  for (const script of coverage.scripts) {
    const file = builtFileOf(script.url);
    if (file === null) continue;
    const scriptIndex = index.scripts.get(file);
    for (const fn of script.functions) {
      // The script's own top level, which V8 reports as a function.
      if (fn.start === 0 && fn.name === "") continue;
      if (scriptIndex?.whole) {
        keys.add(scriptIndex.whole);
        mapped++;
        continue;
      }
      const span = scriptIndex && spanAt(scriptIndex, fn);
      if (!span) {
        unmapped++;
        continue;
      }
      // Chunk scaffolding: it runs, and is no one's code.
      if (span.key === null) continue;
      keys.add(span.key);
      if (span.source !== null) keys.add(`file:${span.source}`);
      mapped++;
    }
  }
  for (const sheet of coverage.sheets) {
    const file = builtFileOf(sheet.url);
    if (file === null) continue;
    const sheetIndex = index.sheets.get(file);
    for (const used of sheet.used) {
      if (sheetIndex?.whole) {
        keys.add(sheetIndex.whole);
        continue;
      }
      const span = sheetIndex?.spans.find((s) => s.start <= used.start && used.start < s.end);
      if (span?.key) keys.add(span.key);
      else unmapped++;
    }
  }
  const reasons = partialReasons(coverage);
  if (unmapped > 0) reasons.push("unmapped");
  return { keys: [...keys].sort(), partial: reasons.length > 0 ? ["code", "css"] : [], reasons, mapped, unmapped };
}
