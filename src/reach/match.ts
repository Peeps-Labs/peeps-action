/**
 * Whether a route matcher meets a path a test touched. The matcher is applied to
 * the raw path, so `/peepsai/test-cases` meets `/:orgSlug/test-cases` without
 * anyone folding `peepsai`. A footprint's folded `:id` was an opaque segment and
 * could have been anything, so it meets a literal too.
 */
export function surfaceMeetsPath(surface: string, path: string): boolean {
  const want = segments(surface);
  const have = segments(path);
  for (let i = 0; i < want.length; i++) {
    const segment = want[i]!;
    if (segment === "**") return true;
    if (segment === "*") return i < have.length;
    if (i >= have.length) return false;
    if (segment.startsWith(":") || have[i] === ":id") continue;
    if (segment.toLowerCase() !== have[i]!.toLowerCase()) return false;
  }
  return want.length === have.length;
}

function segments(path: string): string[] {
  return path.split("/").filter((segment) => segment !== "");
}
