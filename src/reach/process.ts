/**
 * Runs the scanner's bundle in its own process: the parser isn't in every job's memory,
 * work past its budget can be killed mid-parse, and a crash or an out-of-memory is an
 * answer of "couldn't tell", never a failed job.
 */
import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

/** A scan with parent nodes reached 3.2 GB in the plan's measurement; one with none stays under this. */
const HEAP_MB = 512;

export async function runBundled<T>(scanner: string, input: unknown, budgetMs: number): Promise<T | "timeout" | null> {
  const scratch = await mkdtemp(path.join(process.env.RUNNER_TEMP ?? tmpdir(), "peeps-reach-"));
  try {
    const inputFile = path.join(scratch, "input.json");
    await writeFile(inputFile, JSON.stringify(input), { mode: 0o600 });
    return await new Promise((resolve) => {
      const child = spawn(process.execPath, [`--max-old-space-size=${HEAP_MB}`, scanner, inputFile], { stdio: ["ignore", "pipe", "pipe"] });
      const chunks: Buffer[] = [];
      let timedOut = false;
      const timer = setTimeout(() => {
        timedOut = true;
        child.kill("SIGKILL");
      }, budgetMs);
      child.stdout.on("data", (chunk: Buffer) => chunks.push(chunk));
      child.stderr.resume();
      child.on("error", () => {
        clearTimeout(timer);
        resolve(null);
      });
      child.on("close", (code) => {
        clearTimeout(timer);
        if (timedOut) return resolve("timeout");
        if (code !== 0) return resolve(null);
        try {
          resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")) as T);
        } catch {
          resolve(null);
        }
      });
    });
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}
