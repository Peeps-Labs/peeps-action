/**
 * A pull request run Peeps narrowed to its smoke tests. Everything here applies
 * only when the announce's answer says `narrowed`: an older server, or a run
 * Peeps did not narrow, runs exactly as it always has. A dispatched run keeps
 * `grepFor` (`run.ts`). A narrowing that can't be trusted falls back to that same
 * full run: it never fails the job, and never runs fewer tests than were selected.
 */

/**
 * Longer than this, a grep is not tried. Linux caps one argument at 128 KiB, and
 * npx quotes it into an `sh -c` string first, so the quoting needs room.
 */
export const MAX_GREP_BYTES = 64 * 1024;

interface Identity {
  path: string;
  titlePath: string;
  pwProject?: string;
}

/** One test as Playwright lists it. */
export interface GrepTarget extends Identity {
  /** Relative to the config's rootDir. */
  file: string;
  /** Its describes' titles and its own, as written. */
  titles: string[];
  /** Every tag it carries, each with its `@`, whole. */
  tags: string[];
}

/**
 * Narrow only when every batch said so and no project's batch failed: a failed
 * project's tests are in no batch, so selecting from the batches would drop them.
 */
export function isNarrowed(response: {
  batches: Array<{ narrowed?: unknown }>;
  failures?: unknown[];
}): boolean {
  return (
    response.batches.length > 0 &&
    response.batches.every((b) => b.narrowed === true) &&
    (response.failures ?? []).length === 0
  );
}

/** Any batch said so: its snapshot then holds only the selection, whether or not this run narrows. */
export function answeredNarrowed(response: { batches: Array<{ narrowed?: unknown }> }): boolean {
  return response.batches.some((b) => b.narrowed === true);
}

/**
 * The plan's runs under the title the reporter computes for them. Playwright's
 * JSON lists an anonymous describe as an empty title, so the announce says
 * ` › title` and Peeps keys on that, as its inventory does; the reporter drops it.
 */
export function withReporterTitles<T extends Identity>(runs: T[], listed: GrepTarget[]): T[] {
  const reporterTitles = new Map(listed.map((test) => [identity(test), test.titles.filter((title) => title !== "").join(" › ")]));
  return runs.map((run) => ({ ...run, titlePath: reporterTitles.get(identity(run)) ?? run.titlePath }));
}

function escapeRegex(value: string): string {
  return value
    .replace(/[.*+?^${}()|[\]\\/]/g, "\\$&")
    // Playwright parses a delimited grep with `/(.*)/`, which stops at a line terminator.
    .replace(/\n/g, "\\n")
    .replace(/\r/g, "\\r")
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029");
}

/**
 * A `--grep` that admits exactly the selected tests, read from Playwright's own
 * list: a joined identity can't say where a title ends or what a tag holds.
 * Playwright matches it against ` <project> <file> <describes and title>`, the
 * file relative to the config's rootDir (a project's own testDir does not change
 * that), with each describe's and the test's `{ tag }`s after its title. Each
 * test is bound whole, so selecting `a/X` and `b/Y` does not admit `b/X`.
 *
 * Delimited with `/`, because Playwright reads an undelimited grep as
 * case-insensitive, which would admit a test differing only by case.
 *
 * What a grep cannot tell apart, in one file and project: `X` tagged `@wip` from a
 * test titled `X @wip`, and `X` tagged `@team` from
 * `test.describe("@team foo", () => test("X"))`. Listing the grep before running it
 * (`verifiedGrep`, `report.ts`) finds both, and the run falls back.
 */
export function exactGrepFor(selected: Identity[], listed: GrepTarget[]): string {
  const wanted = new Set(selected.map(identity));
  const alternatives = new Set(
    listed.filter((test) => wanted.has(identity(test))).map((test) => {
      const values = test.tags.map(escapeRegex).join("|");
      const own = values ? `(?: (?:${values}))*` : "";
      // The list cuts a describe's tag at its first space, so the words after it can't be named.
      const inherited = values ? `(?: (?:${values})(?: [^@ ][^ ]*)*)*` : "";
      const parts = [test.pwProject ?? "", test.file, ...test.titles].filter((part) => part !== "");
      return parts.map(escapeRegex).join(`${inherited} `) + own;
    }),
  );
  return `/^ *(?:${[...alternatives].join("|")})$/`;
}

/** How a list differs from the selection: selected tests it lacks, and tests it adds. */
export function selectionDifference(selected: Identity[], listed: Identity[]): { missing: Identity[]; extra: Identity[] } {
  const wanted = new Set(selected.map(identity));
  const found = new Set(listed.map(identity));
  return {
    missing: selected.filter((test) => !found.has(identity(test))),
    extra: listed.filter((test) => !wanted.has(identity(test))),
  };
}

function identity(test: Identity): string {
  return JSON.stringify([test.pwProject ?? "", test.path, test.titlePath]);
}
