/**
 * `attach-start` / `attach-finish`: report a workflow's OWN Playwright run to Peeps without
 * running it, so a customer keeps their test command and their reporters (Zephyr, say).
 *
 *   - uses: Peeps-Labs/peeps-action@v1      # mode: attach-start
 *     continue-on-error: true
 *   - run: npx playwright test ${PEEPS_ATTACH_CONFIG:+--config "$PEEPS_ATTACH_CONFIG"}
 *   - uses: Peeps-Labs/peeps-action@v1      # mode: attach-finish
 *     if: always()
 *     continue-on-error: true
 *
 * attach-start writes a config beside the customer's that loads it unchanged and adds the
 * Peeps reporter to its reporters, and exports its path as PEEPS_ATTACH_CONFIG. The reporter,
 * inside their run, plans the run with Peeps from the tests Playwright is about to execute
 * and streams the results (`reporter.ts`, attach mode). attach-finish uploads their HTML
 * report and closes the batches. A run without attach-start runs exactly as before; nothing
 * here can fail the customer's job (see `runAttachStep`).
 */
import { randomUUID } from "node:crypto";
import { appendFile, mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { configLocation, isModule } from "./capture-config";
import type { RunnerEnv } from "./env";
import type { PeepsClient } from "./peeps";
import { uploadReport } from "./report";

/** What the reporter leaves for attach-finish in the state directory. */
export interface AttachState {
  batches: Array<{ batchId: string; batchNumber: number }>;
  /** The HTML report's directory, absolute, when the run has an HTML reporter. */
  reportDir: string | null;
}

export const ATTACH_STATE_FILE = "state.json";
const CONFIG_RECORD = "config-path";

/** Append `NAME=value` lines to the step's exported environment (GITHUB_ENV). */
async function exportVariables(vars: Record<string, string>): Promise<void> {
  const file = process.env.GITHUB_ENV;
  const lines = Object.entries(vars).map(([k, v]) => `${k}=${v}`).join("\n") + "\n";
  if (!file) {
    console.log(`[peeps] GITHUB_ENV is not set; export these yourself:\n${lines}`);
    return;
  }
  await appendFile(file, lines);
}

/**
 * The wrapper config's source: loads the original exactly as capture-config does (same
 * module format, default unwrapped once) and appends the Peeps reporter, keeping every
 * reporter the customer configured.
 */
export function attachConfigSource(input: {
  original: string | undefined;
  esm: boolean;
  reporterPath: string;
  stateDir: string;
}): string {
  const load = !input.original
    ? "const loaded = {};"
    : input.esm
      ? `import * as loaded from ${JSON.stringify(pathToFileURL(input.original).href)};`
      : `const loaded = await require(${JSON.stringify(input.original)});`;
  const body = `
const config = await (loaded && typeof loaded === "object" && "default" in loaded ? loaded.default : loaded);
if (!config || typeof config !== "object") throw new Error("Playwright config must export a single object");
const reporters = config.reporter === undefined
  ? [[process.env.CI ? "dot" : "list"]]
  : typeof config.reporter === "string"
    ? [[config.reporter]]
    : config.reporter;
const withPeeps = {
  ...config,
  reporter: [...reporters, [${JSON.stringify(input.reporterPath)}, { attachDir: ${JSON.stringify(input.stateDir)} }]],
};
`;
  return input.esm
    ? `import { createRequire } from "node:module";\nconst require = createRequire(import.meta.url);\n${load}\n${body}\nexport default withPeeps;\n`
    : `module.exports = (async () => {\n${load}\n${body}\nreturn { default: withPeeps };\n})();\n`;
}

export async function runAttachStart(env: RunnerEnv): Promise<void> {
  const stateDir = path.join(process.env.RUNNER_TEMP ?? tmpdir(), `peeps-attach-${randomUUID()}`);
  await mkdir(stateDir, { recursive: true, mode: 0o700 });
  const { dir, file } = await configLocation(env);
  const esm = file ? await isModule(file) : false;
  const configPath = path.join(dir, `.peeps-attach-${randomUUID()}.config.${esm ? "mjs" : "cjs"}`);
  const reporterPath = path.join(__dirname, "reporter.js");
  try {
    await writeFile(configPath, attachConfigSource({ original: file, esm, reporterPath, stateDir }), {
      flag: "wx",
      mode: 0o600,
    });
  } catch (error) {
    // As capture-config: never leave a partial wrapper, never remove someone else's file.
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") await unlink(configPath).catch(() => {});
    throw error;
  }
  await writeFile(path.join(stateDir, CONFIG_RECORD), configPath, { mode: 0o600 });
  // PEEPS_API_URL too: the reporter runs in the customer's test step, which sees the job's
  // environment but not this step's.
  await exportVariables({
    PEEPS_ATTACH_CONFIG: configPath,
    PEEPS_ATTACH_DIR: stateDir,
    PEEPS_API_URL: env.peepsUrl,
  });
  console.log(`[peeps] attach: the run reports to Peeps when Playwright is given --config ${configPath}`);
}

export async function runAttachFinish(_env: RunnerEnv, peeps: PeepsClient): Promise<void> {
  const stateDir = process.env.PEEPS_ATTACH_DIR;
  if (!stateDir) {
    console.log("[peeps] attach: no PEEPS_ATTACH_DIR (attach-start did not run); nothing to finish");
    return;
  }
  // The wrapper config goes whatever happened: it was only ever for this job's run.
  const configPath = await readFile(path.join(stateDir, CONFIG_RECORD), "utf8").catch(() => null);
  if (configPath) await unlink(configPath).catch(() => {});

  const raw = await readFile(path.join(stateDir, ATTACH_STATE_FILE), "utf8").catch(() => null);
  if (!raw) {
    console.log("[peeps] attach: the run planned nothing with Peeps (no tests ran, or Peeps was unreachable)");
    return;
  }
  const state = JSON.parse(raw) as AttachState;
  for (const b of state.batches) {
    let reportUploaded = false;
    if (state.reportDir) {
      try {
        const uploaded = await uploadReport(peeps, b.batchId, state.reportDir);
        reportUploaded = uploaded > 0;
        console.log(`[peeps] uploaded ${uploaded} report file(s) for batch ${b.batchNumber}`);
      } catch (error) {
        console.log(`[peeps] report upload failed for batch ${b.batchId}: ${String(error)}`);
      }
    }
    try {
      await peeps.post(`/api/v1/ci/batches/${b.batchId}/complete`, { reportUploaded });
    } catch (error) {
      console.log(`[peeps] could not complete batch ${b.batchId}: ${String(error)}`);
    }
  }
}

/** attach-start writes two files; attach-finish uploads a report, so it gets longer. */
export const ATTACH_START_DEADLINE_MS = 60_000;
export const ATTACH_FINISH_DEADLINE_MS = 8 * 60_000;

/**
 * An attach step never fails the customer's job: whatever goes wrong, including a Peeps that
 * never answers (PeepsClient's calls have no timeout of their own), is a warning in the log
 * once `deadlineMs` passes, and the step exits 0, with or without `continue-on-error` on it.
 * The caller exits the process afterwards, since a hung request would hold it open.
 */
export async function runAttachStep(step: () => Promise<void>, deadlineMs: number): Promise<void> {
  let timer: NodeJS.Timeout | undefined;
  const expired = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`gave up after ${deadlineMs / 1000}s without an answer from Peeps`)), deadlineMs);
  });
  try {
    await Promise.race([step(), expired]);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.log(`::warning::Peeps could not report this run: ${message}`);
  } finally {
    clearTimeout(timer);
  }
}
