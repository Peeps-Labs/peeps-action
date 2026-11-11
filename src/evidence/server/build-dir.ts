/**
 * Next writes into its build directory while it serves: on-demand pages and route-handler
 * bodies under `server/app`, and the fetch and `unstable_cache` data under `cache/`. A
 * later run's app would serve them without running the code that made them, and that
 * code would be missing from its footprint (PQA-3201 PR 3). So after each run, what it
 * created is removed; a file it rewrote can't be put back, and every later run then
 * reads partial. A file it removed serves nothing, so it's harmless.
 */
import { lstatSync, readdirSync, rmSync } from "node:fs";
import path from "node:path";

export type BuildSnapshot = ReadonlyMap<string, string>;

function walk(dir: string, rel: string, out: Map<string, string>): void {
  let entries;
  try {
    entries = readdirSync(path.join(dir, rel), { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const child = rel === "" ? entry.name : `${rel}/${entry.name}`;
    if (entry.isDirectory()) walk(dir, child, out);
    else {
      const stat = lstatSync(path.join(dir, child));
      out.set(child, `${stat.size}:${stat.mtimeMs}`);
    }
  }
}

/** Every file under the build directory, by its size and modification time. */
export function snapshotBuildDir(dir: string): BuildSnapshot {
  const out = new Map<string, string>();
  walk(dir, "", out);
  return out;
}

/** Removes what was created since the snapshot; names it, and what was rewritten. */
export function settleBuildDir(dir: string, snapshot: BuildSnapshot): { created: string[]; changed: string[] } {
  const now = snapshotBuildDir(dir);
  const created: string[] = [];
  const changed: string[] = [];
  for (const [file, stamp] of now) {
    const before = snapshot.get(file);
    if (before === undefined) created.push(file);
    else if (before !== stamp) changed.push(file);
  }
  for (const file of created) rmSync(path.join(dir, file), { force: true });
  return { created: created.sort(), changed: changed.sort() };
}
