/**
 * The scanner's process: `node dist/reach.js <input.json>`, answering a reach on
 * stdout. Its own process so the parser isn't in every job's memory, so a slow scan can
 * be killed mid-parse, and so a crash or an out-of-memory reads as global, not as a
 * failed job.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { scan } from "./scan";
import type { FileChange } from "./types";

const input = JSON.parse(readFileSync(process.argv[2]!, "utf8")) as {
  root: string;
  files: string[];
  changes: FileChange[];
  rootDir: string;
  specFiles: string[];
  base: string;
  deadlineMs: number;
};

process.stdout.write(
  JSON.stringify(
    scan({
      files: input.files,
      read: (file) => readFileSync(path.join(input.root, file), "utf8"),
      changes: input.changes,
      rootDir: input.rootDir,
      specFiles: input.specFiles,
      base: input.base,
      deadlineMs: input.deadlineMs,
    }),
  ),
);
