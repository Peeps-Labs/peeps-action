/** What the scanner reads from git and sends to Peeps. No source, no patch. */

export interface Hunk {
  /** Line in the merge commit's tree. With no lines added: where the removal was. */
  newStart: number;
  newCount: number;
  removed: string[];
  added: string[];
}

export interface FileChange {
  path: string;
  oldPath?: string;
  status: "added" | "modified" | "deleted" | "renamed";
  binary: boolean;
  hunks: Hunk[];
}

/**
 * What this pull request can affect. A surface is a route matcher (`match.ts`):
 * `/orders/:id`, `/docs/*` at any depth below, `/settings/**` for a layout, which
 * also meets `/settings`. `global` means Peeps can't bound it, and `why` says
 * how: every test runs.
 */
export interface Reach {
  global: boolean;
  why: string | null;
  surfaces: string[];
  /** Each surface and the changed file behind it; a global reach's file has a null surface. */
  reasons: Array<{ surface: string | null; file: string }>;
  changedFiles: string[];
  /** The changed files a test depends on: its spec, a page object, a fixture. */
  changedTestFiles: string[];
  /** The commit this pull request is based on: the merge commit's first parent. */
  base: string | null;
}
