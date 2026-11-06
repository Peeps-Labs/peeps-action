/**
 * The reach a pull request job sends on its announce. Only on GitHub, only on a
 * `pull_request` event: anything else sends none, and Peeps reads that as everything.
 * Nothing here can fail the job, and no source or patch leaves it.
 */
import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { RunnerEnv } from "../env";
import { readCheckout } from "./checkout";
import { localRepository } from "./git";
import { capReach } from "./limits";
import type { Reach } from "./types";

export const REACH_BUDGET_MS = 90_000;
/** A scan with parent nodes reached 3.2 GB in the plan's measurement; one with none stays under this. */
const REACH_HEAP_MB = 512;

const widened = (why: string, base: string | null = null, changedFiles: string[] = []): Reach =>
  capReach({ global: true, why, surfaces: [], reasons: [], changedFiles, changedTestFiles: [], base });

export async function computeReach(
  env: RunnerEnv,
  input: { specFiles: string[] },
  options: { budgetMs?: number; scanner?: string } = {},
): Promise<Reach | undefined> {
  if (env.platform !== "github" || env.eventName !== "pull_request" || !env.sha) return undefined;
  const budgetMs = options.budgetMs ?? REACH_BUDGET_MS;
  const started = Date.now();
  try {
    const repository = await localRepository(env.workspace, started + budgetMs);
    const checkout = await readCheckout(repository, env.sha);
    if (!checkout.ok) return widened(checkout.why);
    const changedFiles = checkout.changes.map((change) => change.path);
    const files = (await repository.git("ls-files", "-z")).split("\0").filter(Boolean);
    const remaining = budgetMs - (Date.now() - started);
    if (remaining <= 0) return widened("timeout", checkout.base, changedFiles);
    const scratch = await mkdtemp(path.join(process.env.RUNNER_TEMP ?? tmpdir(), "peeps-reach-"));
    try {
      const inputFile = path.join(scratch, "input.json");
      await writeFile(
        inputFile,
        JSON.stringify({ root: checkout.root, files, changes: checkout.changes, specFiles: input.specFiles, base: checkout.base, deadlineMs: remaining }),
        { mode: 0o600 },
      );
      const answer = await runScanner(options.scanner ?? path.join(__dirname, "reach.js"), inputFile, remaining);
      if (answer === "timeout") return widened("timeout", checkout.base, changedFiles);
      if (answer === null) return widened("scan_failed", checkout.base, changedFiles);
      return capReach(answer);
    } finally {
      await rm(scratch, { recursive: true, force: true });
    }
  } catch (error) {
    console.log(`[peeps] could not read what this pull request reaches, so everything runs: ${String(error).slice(0, 300)}`);
    return widened("scan_failed");
  }
}

/** The scanner's answer; "timeout" past the budget, however busy it is; null when it failed. */
function runScanner(scanner: string, inputFile: string, budgetMs: number): Promise<Reach | "timeout" | null> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [`--max-old-space-size=${REACH_HEAP_MB}`, scanner, inputFile], { stdio: ["ignore", "pipe", "pipe"] });
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
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")) as Reach);
      } catch {
        resolve(null);
      }
    });
  });
}
