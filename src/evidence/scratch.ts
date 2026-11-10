/**
 * The private directory raw evidence passes through (W6): covered URLs and offsets from
 * Playwright's workers, each attempt's requested paths from the reporter. Plaintext,
 * though never the key: the action process keys it, then removes the directory. Made
 * with `mkdtemp` (0700), each file 0600, and removed in `dispose` and on SIGTERM and
 * SIGINT, which then still end the process. Trust: on a self-hosted runner shared between
 * jobs, `RUNNER_TEMP` is as private as the job's own checkout and secrets.
 */
import { readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import path from "node:path";

export interface Scratch {
  dir: string;
  write(name: string, value: unknown): string;
  /** Every file whose name starts with `prefix`, parsed; one that doesn't parse is skipped. */
  read(prefix: string): unknown[];
  dispose(): Promise<void>;
}

export async function openScratch(parent: string): Promise<Scratch> {
  const dir = await mkdtemp(path.join(parent, "peeps-evidence-"));
  const signals = ["SIGTERM", "SIGINT"] as const;
  const onSignal = (signal: NodeJS.Signals) => {
    rmSync(dir, { recursive: true, force: true });
    for (const s of signals) process.off(s, onSignal);
    process.kill(process.pid, signal);
  };
  for (const s of signals) process.on(s, onSignal);
  return {
    dir,
    write(name, value) {
      const file = path.join(dir, path.basename(name));
      writeFileSync(file, JSON.stringify(value), { mode: 0o600, flag: "wx" });
      return file;
    },
    read(prefix) {
      const out: unknown[] = [];
      for (const name of readdirSync(dir).filter((n) => n.startsWith(prefix)).sort()) {
        try {
          out.push(JSON.parse(readFileSync(path.join(dir, name), "utf8")));
        } catch {
          // A worker killed mid-write leaves half a file: that attempt has no evidence.
        }
      }
      return out;
    },
    async dispose() {
      for (const s of signals) process.off(s, onSignal);
      await rm(dir, { recursive: true, force: true });
    },
  };
}
