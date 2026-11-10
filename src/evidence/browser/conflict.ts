/**
 * Whether the suite may run precise coverage itself. Another user's take or start resets
 * this collector's counters: a reset after a page loads drops what ran before it, yet the
 * final take still succeeds, so the attempt would look whole and could be excluded wrongly.
 * That can't be told reliably at run time, so a suite that might do it is not collected at
 * all (fail safe): its tests read unknown, and always run.
 *
 * Read: the suite's own source files and its `package.json`s, never `node_modules`. A
 * suite past the reading budget is refused rather than assumed clean.
 */
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";

const SOURCE = /\.(?:[cm]?[jt]sx?)$/;
const STARTS_COVERAGE = /\b(?:startJSCoverage|startCSSCoverage)\b|Profiler\.(?:start|take)PreciseCoverage/;
/** Packages that collect browser coverage through Playwright. */
const COVERAGE_PACKAGE = /monocart|playwright[\w./@-]*coverage|coverage[\w./@-]*playwright/i;
const SKIP = new Set(["node_modules", ".git", ".next", "dist", "build", "out", "coverage", "playwright-report", "test-results"]);

/** The first reason the suite may collect coverage itself, or null. Pure. */
export function coverageConflict(sources: Array<{ path: string; text: string }>, packages: Array<{ path: string; text: string }>): string | null {
  for (const source of sources) if (STARTS_COVERAGE.test(source.text)) return `${source.path} runs precise coverage itself`;
  for (const pkg of packages) {
    let json: { dependencies?: object; devDependencies?: object };
    try {
      json = JSON.parse(pkg.text) as typeof json;
    } catch {
      continue;
    }
    const name = Object.keys({ ...json.dependencies, ...json.devDependencies }).find((dep) => COVERAGE_PACKAGE.test(dep));
    if (name) return `${pkg.path} depends on ${name}, which collects browser coverage`;
  }
  return null;
}

/** The same, read from disk under each directory (the suite's root, the config's). */
export async function coverageConflictIn(dirs: string[], budget: { maxFiles?: number; maxBytes?: number } = {}): Promise<string | null> {
  const maxFiles = budget.maxFiles ?? 5_000;
  let bytesLeft = budget.maxBytes ?? 64 * 1024 * 1024;
  const sources: Array<{ path: string; text: string }> = [];
  const packages: Array<{ path: string; text: string }> = [];
  const seen = new Set<string>();
  const walk = async (dir: string): Promise<string | null> => {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return null;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (SKIP.has(entry.name)) continue;
        const refused = await walk(full);
        if (refused) return refused;
      } else if (entry.isFile() && (SOURCE.test(entry.name) || entry.name === "package.json") && !seen.has(full)) {
        seen.add(full);
        if (seen.size > maxFiles) return `the suite has too many files to read (over ${maxFiles})`;
        const text = await readFile(full, "utf8").catch(() => "");
        bytesLeft -= text.length;
        if (bytesLeft < 0) return "the suite is too large to read";
        (entry.name === "package.json" ? packages : sources).push({ path: full, text });
      }
    }
    return null;
  };
  for (const dir of dirs) {
    const refused = await walk(dir);
    if (refused) return refused;
  }
  return coverageConflict(sources, packages);
}
