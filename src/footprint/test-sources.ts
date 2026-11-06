/** The workspace's files from the disk, for `test-trace.ts`. Bounded: past its budget, it can't tell. */
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { readTestSources, type TestSources } from "./test-trace";

const SKIPPED = new Set(["node_modules", ".git", ".next", ".nuxt", ".turbo", ".cache", "dist", "build", "out", "coverage"]);
const MAX_ENTRIES = 200_000;
const BUDGET_MS = 10_000;

function listFiles(root: string, deadline: number, limit = { left: MAX_ENTRIES }, dir = ""): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(path.join(root, dir), { withFileTypes: true })) {
    if (--limit.left < 0 || Date.now() > deadline) throw new Error("Too many files to read");
    const relative = dir ? `${dir}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      if (!SKIPPED.has(entry.name)) out.push(...listFiles(root, deadline, limit, relative));
    } else if (entry.isFile()) out.push(relative);
  }
  return out;
}

export function workspaceTestSources(workspace: string, specs: string[], budgetMs = BUDGET_MS): TestSources {
  try {
    return readTestSources(specs, listFiles(workspace, Date.now() + budgetMs), (file) => readFileSync(path.join(workspace, file), "utf8"));
  } catch {
    return { maySetTrace: true, hiddenRequests: specs };
  }
}
