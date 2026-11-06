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
    const wanted = readable(segment);
    const had = readable(have[i]!);
    // What can't be decoded could be anything, so it meets.
    if (wanted !== null && had !== null && wanted !== had) return false;
  }
  return want.length === have.length;
}

/** A footprint's path is percent-encoded and a route's isn't, and a `;parameter` isn't the path. */
function segments(path: string): string[] {
  return path
    .split("/")
    .map((segment) => segment.split(";")[0]!)
    .filter((segment) => segment !== "");
}

function readable(segment: string): string | null {
  try {
    return decodeURIComponent(segment).toLowerCase();
  } catch {
    return null;
  }
}
