/** The repository through real git: the adapter of `checkout.ts`'s port. */
import { execFile } from "node:child_process";
import { realpath } from "node:fs/promises";
import { promisify } from "node:util";
import type { Repository } from "./checkout";

const execFileAsync = promisify(execFile);

/** A diff over this is not read: more than the limit of changed files, or generated output. */
const MAX_OUTPUT_BYTES = 256 * 1024 * 1024;

/** Every command stops at `deadline`, and past it none starts. */
export async function localRepository(workspace: string, deadline = Number.POSITIVE_INFINITY): Promise<Repository> {
  return {
    workspace: await realpath(workspace),
    async git(...args) {
      const left = deadline - Date.now();
      if (left <= 0) throw new Error("Out of time");
      const { stdout } = await execFileAsync("git", args, {
        cwd: workspace,
        maxBuffer: MAX_OUTPUT_BYTES,
        timeout: Math.min(60_000, left),
        env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
      });
      return stdout;
    },
  };
}
