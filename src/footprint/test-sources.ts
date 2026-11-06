/** The workspace's files from the disk, for `test-trace.ts`. */
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { testsMaySetTrace } from "./test-trace";

function listFiles(root: string, dir = ""): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(path.join(root, dir), { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name === ".git") continue;
    const relative = dir ? `${dir}/${entry.name}` : entry.name;
    if (entry.isDirectory()) out.push(...listFiles(root, relative));
    else if (entry.isFile()) out.push(relative);
  }
  return out;
}

export function workspaceTestsMaySetTrace(workspace: string, specs: string[]): boolean {
  try {
    return testsMaySetTrace(specs, listFiles(workspace), (file) => readFileSync(path.join(workspace, file), "utf8"));
  } catch {
    return true;
  }
}
