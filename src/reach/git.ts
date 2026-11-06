/** The repository through real git: the adapter of `checkout.ts`'s port. */
import { execFile } from "node:child_process";
import { realpath } from "node:fs/promises";
import { promisify } from "node:util";
import type { Repository } from "./checkout";

const execFileAsync = promisify(execFile);

/** A diff over this is not read: more than the limit of changed files, or generated output. */
const MAX_OUTPUT_BYTES = 256 * 1024 * 1024;

export async function localRepository(workspace: string): Promise<Repository> {
  return {
    workspace: await realpath(workspace),
    async git(...args) {
      const { stdout } = await execFileAsync("git", args, {
        cwd: workspace,
        maxBuffer: MAX_OUTPUT_BYTES,
        timeout: 60_000,
        env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
      });
      return stdout;
    },
  };
}
