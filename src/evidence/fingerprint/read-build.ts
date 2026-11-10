/** Reading a `.next` directory for `rules.ts`: the file half of a build fingerprint. */
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fingerprintBuild, type Fingerprint } from "./rules";

/** Never read: caches, traces of the build itself, and copies of the app. */
const SKIP_DIRS = new Set(["cache", "standalone", "trace", "trace-build", "diagnostics", "types", "turbopack", "node_modules"]);

function walk(dir: string, prefix: string, out: string[]): void {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      if (!(prefix === "" && SKIP_DIRS.has(entry.name))) walk(path.join(dir, entry.name), rel, out);
    } else if (entry.isFile()) {
      out.push(rel);
    }
  }
}

/** The fingerprint of the build in `nextDir`, its sources repo-relative under `sourcePrefix`. */
export function fingerprintNextDir(nextDir: string, sourcePrefix: string): Fingerprint {
  const files: string[] = [];
  walk(nextDir, "", files);
  return fingerprintBuild({
    files,
    sourcePrefix,
    read: (file) => {
      try {
        return readFileSync(path.join(nextDir, ...file.split("/")), "utf8");
      } catch {
        return null;
      }
    },
  });
}
