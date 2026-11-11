/**
 * The commit a pull request job tests, and what the pull request changed in it.
 *
 * It must be GitHub's synthetic merge commit: then `HEAD^1` is what the pull
 * request is based on, and every hunk of `HEAD^1..HEAD` is in the coordinates of
 * the tree the scanner parses. A workflow checking out the pull request's head
 * makes `HEAD^1` the previous commit, which would silently under-pick, so
 * anything but that merge is `not_merge` and everything runs.
 */
import type { FileChange, Hunk } from "./types";

/** The repository, as this needs it. `git.ts` is the adapter. */
export interface Repository {
  /** The workspace's real path. */
  workspace: string;
  /** A git command's stdout; it throws when the command fails. */
  git(...args: string[]): Promise<string>;
}

export type Checkout =
  | { ok: true; root: string; base: string; changes: FileChange[] }
  | { ok: false; why: "not_merge" | "dirty_checkout" | "unreadable_diff" };

export async function readCheckout(repository: Repository, sha: string): Promise<Checkout> {
  const { git, workspace } = repository;
  let root: string;
  let base: string;
  try {
    root = (await git("rev-parse", "--show-toplevel")).trim();
    if (root !== workspace) return { ok: false, why: "not_merge" };
    if ((await git("rev-parse", "HEAD")).trim() !== sha) return { ok: false, why: "not_merge" };
    // On a full clone `--deepen=1` is not a no-op, and on a shallow one nothing else finds the parents.
    if ((await git("rev-parse", "--is-shallow-repository")).trim() === "true") {
      await git("fetch", "--quiet", "--no-tags", "--no-recurse-submodules", "--deepen=1", "origin", sha);
    }
    await git("rev-parse", "--verify", "--quiet", "HEAD^2");
    base = (await git("rev-parse", "--verify", "--quiet", "HEAD^1")).trim();
  } catch {
    return { ok: false, why: "not_merge" };
  }
  let changes: FileChange[];
  try {
    changes = parseDiff(
      await git(
        "-c", "core.quotePath=false",
        "diff", "--no-color", "--no-ext-diff", "-U0", "-M", "--src-prefix=a/", "--dst-prefix=b/", "HEAD^1", "HEAD",
      ),
    );
    // A build step that rewrote a changed file moved the lines the hunks point at.
    const present = changes.filter((c) => c.status !== "deleted").map((c) => c.path);
    if (present.length > 0 && present.length <= 300) {
      const dirty = await git("diff", "--name-only", "HEAD", "--", ...present);
      if (dirty.trim() !== "") return { ok: false, why: "dirty_checkout" };
    }
  } catch {
    return { ok: false, why: "unreadable_diff" };
  }
  return { ok: true, root, base, changes };
}

/** The new path. Unless a rename line says otherwise, both halves of the header name one file. */
function headerPath(line: string): string {
  const rest = line.slice("diff --git a/".length);
  const middle = (rest.length - " b/".length) / 2;
  if (rest.slice(middle, middle + 3) === " b/" && rest.slice(0, middle) === rest.slice(middle + 3)) return rest.slice(0, middle);
  const match = /^(.+) b\/(.+)$/.exec(rest);
  if (!match) throw new Error(`An unreadable diff header: ${line}`);
  return match[2]!;
}

/**
 * `git diff -U0` as changes. Hunk bodies are consumed by the counts in their
 * header, because a removed `-- x` reads `--- x`. Git quotes a path holding a
 * tab, newline or quote even with `core.quotePath=false`: `headerPath` can't read
 * that, it throws, and the caller reads it as a diff it can't place.
 */
export function parseDiff(diff: string): FileChange[] {
  const lines = diff.split("\n");
  const out: FileChange[] = [];
  let current: FileChange | null = null;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (line.startsWith("diff --git ")) {
      current = { path: headerPath(line), status: "modified", binary: false, hunks: [] };
      out.push(current);
    } else if (!current) {
      if (line !== "") throw new Error(`Diff text outside a file: ${line}`);
    } else if (line.startsWith("rename from ")) {
      current.status = "renamed";
      current.oldPath = line.slice("rename from ".length);
    } else if (line.startsWith("rename to ")) {
      current.path = line.slice("rename to ".length);
    } else if (line.startsWith("deleted file mode ")) {
      current.status = "deleted";
    } else if (line.startsWith("new file mode ")) {
      current.status = "added";
    } else if (line.startsWith("Binary files ")) {
      current.binary = true;
    } else if (line.startsWith("@@ ")) {
      const header = /^@@ -\d+(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line);
      if (!header) throw new Error(`An unreadable hunk header: ${line}`);
      const hunk: Hunk = { newStart: Number(header[2]), newCount: Number(header[3] ?? 1), removed: [], added: [] };
      const removed = Number(header[1] ?? 1);
      for (let n = 0; n < removed; n++) hunk.removed.push(lines[++i]!.slice(1));
      for (let n = 0; n < hunk.newCount; n++) hunk.added.push(lines[++i]!.slice(1));
      // `\ No newline at end of file`
      while (lines[i + 1]?.startsWith("\\")) i++;
      current.hunks.push(hunk);
    }
  }
  return out;
}
