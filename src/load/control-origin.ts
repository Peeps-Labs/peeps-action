/**
 * Where a customer load run talks to Peeps (CW plan §4.2). The `peeps-load` job writes
 * `PEEPS_API_URL` for every stage, production included, and the action accepts only one of
 * Peeps' own three origins: unset or empty is refused, never production by default, and nothing
 * is normalized beyond one trailing slash. Pure: it reads nothing but its argument.
 *
 * The harness entry (`dist/load.js` run directly) keeps its `PEEPS_URL` as its own workflow writes it.
 */

/** Peeps' origins, per stage (prod, rc, dev). The same list as load-job-v1's `control-origins.json`. */
export const LOAD_CONTROL_ORIGINS: readonly string[] = ["https://app.peepsai.com", "https://rc.peepsai.com", "https://dev.peepsai.com"];

export function loadControlOrigin(raw: string | undefined): { ok: true; origin: string } | { ok: false; refused: "control_origin" } {
  if (!raw) return { ok: false, refused: "control_origin" };
  const origin = raw.endsWith("/") ? raw.slice(0, -1) : raw;
  return LOAD_CONTROL_ORIGINS.includes(origin) ? { ok: true, origin } : { ok: false, refused: "control_origin" };
}
