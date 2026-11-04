/**
 * Playwright's JSON report, read from a file rather than stdout.
 *
 * `--reporter=json` writes to stdout by default, and anything else the customer's config or
 * global setup prints goes there too: dotenv 17 logs "injected env (N) from .env" on every
 * load, so a config that calls `dotenv.config()` turned every list and run into unparseable
 * JSON. The reporter writes to PLAYWRIGHT_JSON_OUTPUT_FILE instead (PLAYWRIGHT_JSON_OUTPUT_NAME
 * for Playwright before 1.46, which resolves an absolute name the same way), and only an old
 * Playwright that honours neither falls back to stdout, past any lines printed before the
 * report.
 */
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

export interface JsonReportTarget {
  /** Add to the Playwright child's environment. */
  env: Record<string, string>;
  /** The report, from the file or else from stdout; null when there is none. */
  read(stdout: string): Promise<unknown>;
  cleanup(): Promise<void>;
}

export async function jsonReportTarget(): Promise<JsonReportTarget> {
  const dir = await mkdtemp(path.join(process.env.RUNNER_TEMP ?? tmpdir(), "peeps-json-"));
  const file = path.join(dir, "report.json");
  return {
    env: { PLAYWRIGHT_JSON_OUTPUT_FILE: file, PLAYWRIGHT_JSON_OUTPUT_NAME: file },
    async read(stdout: string) {
      const text = await readFile(file, "utf8").catch(() => null);
      return parseJsonReport(text ?? stdout);
    },
    cleanup: () => rm(dir, { recursive: true, force: true }),
  };
}

/** The JSON report in `text`, skipping lines printed before it; null when there is none. */
export function parseJsonReport(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    // The report starts on its own line with `{`; whatever came first is someone's log.
    const start = text.search(/^\{/m);
    if (start <= 0) return null;
    try {
      return JSON.parse(text.slice(start));
    } catch {
      return null;
    }
  }
}
