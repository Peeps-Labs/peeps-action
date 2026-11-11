/**
 * The scanner's process: `node dist/reach.js <input.json>`, answering on stdout: a reach,
 * what a suite's specs may do, or a Next build's plaintext fingerprint (keyed by the
 * action's own process, so the project key is never in this input). See `process.ts`.
 */
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fingerprintNextDir } from "../evidence/fingerprint/read-build";
import { toWire } from "../evidence/fingerprint/wire";
import { readTestSources } from "../footprint/test-trace";
import { scan } from "./scan";
import type { FileChange } from "./types";

type Input =
  | { kind?: "reach"; root: string; files: string[]; changes: FileChange[]; specFiles: string[]; base: string; deadlineMs: number }
  | { kind: "testSources"; root: string; specs: string[]; globalSetups: string[]; deadlineMs: number }
  | { kind: "fingerprint"; root: string; nextDir: string; sourcePrefix: string };

const SKIPPED = new Set(["node_modules", ".git", ".next", ".nuxt", ".turbo", ".cache", "dist", "build", "out", "coverage"]);

function listFiles(root: string, tick: () => void, dir = ""): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(path.join(root, dir), { withFileTypes: true })) {
    tick();
    const relative = dir ? `${dir}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      if (!SKIPPED.has(entry.name)) out.push(...listFiles(root, tick, relative));
    } else if (entry.isFile()) out.push(relative);
  }
  return out;
}

const input = JSON.parse(readFileSync(process.argv[2]!, "utf8")) as Input;
const read = (file: string) => readFileSync(path.join(input.root, file), "utf8");

if (input.kind === "fingerprint") {
  process.stdout.write(JSON.stringify(toWire(fingerprintNextDir(input.nextDir, input.sourcePrefix))));
} else if (input.kind === "testSources") {
  const started = Date.now();
  const tick = () => {
    if (Date.now() - started > input.deadlineMs) throw new Error("Out of time");
  };
  process.stdout.write(JSON.stringify(readTestSources(input.specs, input.globalSetups, listFiles(input.root, tick), read, tick)));
} else {
  process.stdout.write(JSON.stringify(scan({ files: input.files, read, changes: input.changes, specFiles: input.specFiles, base: input.base, deadlineMs: input.deadlineMs })));
}
