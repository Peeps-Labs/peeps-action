/**
 * The Peeps environment a dispatched run was started in, as the test process
 * sees it. Peeps' plan names the environment and its `BASE_URL` (nothing else:
 * secrets stay in Peeps, and the workflow holds its own). Run mode exports
 * them as `PEEPS_ENVIRONMENT` and `PEEPS_BASE_URL`, and as `BASE_URL` only when
 * the workflow has not set one: a value the workflow set is the customer's own
 * choice, and Peeps never edits the workflow. Agent mode reads the same two
 * fields from the attach answer and gives the same variables to what `run_tests`
 * starts, never to its own `process.env` (see `createToolServer`).
 */

export interface PlanEnvironment {
  name: string;
  baseUrl: string | null;
}

/**
 * A name for the job log, which may be public: a control character could start
 * a workflow command on a line of its own, and GitHub's legacy `##[` command
 * works anywhere in a line.
 */
export function nameForLog(name: string): string {
  return name.replace(/[\p{Cc}\p{Zl}\p{Zp}]+/gu, " ").replace(/##\[/g, "## [");
}

/**
 * A URL for the job log, so credentials can't slip past however they are
 * spelled. Any `@` hides the whole URL: a `/` or `\` in a password parses as a
 * path, so a parser can't tell where the secret ends, and this is only a log
 * line. Query and fragment stay out too. The test process still gets the value
 * Peeps sent.
 */
export function urlForLog(baseUrl: string): string {
  if (baseUrl.includes("@")) return "<unreadable URL>";
  try {
    const url = new URL(baseUrl);
    if (url.protocol !== "http:" && url.protocol !== "https:") return "<unreadable URL>";
    return url.pathname === "/" ? url.origin : `${url.origin}${url.pathname}`;
  } catch {
    return "<unreadable URL>";
  }
}

/**
 * For a job-log line that may quote what a test process or the WebdriverIO
 * config saw: each of the environment's values with an `@` (one `urlForLog`
 * would hide) reads `<unreadable URL>`. Apply it before cutting the line, so
 * no part of a value survives. What goes back to Peeps is unchanged: Peeps
 * sent it.
 */
export function hideEnvironmentUrls(vars: Record<string, string>): (text: string) => string {
  const hidden = [...new Set(Object.values(vars).filter((v) => v.includes("@")))].sort((a, b) => b.length - a.length);
  return (text) => hidden.reduce((out, value) => out.split(value).join("<unreadable URL>"), text);
}

export function planEnvironmentVariables(
  planEnv: PlanEnvironment | null | undefined,
  current: NodeJS.ProcessEnv,
): { vars: Record<string, string>; log: string } {
  // `preview: vercel` in a job Peeps started: the checked-out commit's
  // preview, used only where neither Peeps nor the workflow names a BASE_URL.
  const preview = current.PEEPS_PREVIEW_URL;
  const previewFallback = (prefix: string) =>
    preview && !current.BASE_URL
      ? { BASE_URL: preview, log: `${prefix}BASE_URL ${urlForLog(preview)} (the Vercel preview of the checked-out commit)` }
      : null;
  if (!planEnv) {
    const fallback = previewFallback("[peeps] no Peeps environment; ");
    return fallback ? { vars: { BASE_URL: fallback.BASE_URL }, log: fallback.log } : { vars: {}, log: "" };
  }
  const vars: Record<string, string> = { PEEPS_ENVIRONMENT: planEnv.name };
  const name = nameForLog(planEnv.name);
  if (!planEnv.baseUrl) {
    const fallback = previewFallback(`[peeps] environment ${name} (no BASE_URL in Peeps); `);
    if (fallback) return { vars: { ...vars, BASE_URL: fallback.BASE_URL }, log: fallback.log };
    return { vars, log: `[peeps] environment ${name} (no BASE_URL in Peeps)` };
  }
  vars.PEEPS_BASE_URL = planEnv.baseUrl;
  const url = urlForLog(planEnv.baseUrl);
  if (current.BASE_URL) {
    return {
      vars,
      log: `[peeps] environment ${name}; the workflow's BASE_URL runs, not ${url} (also in PEEPS_BASE_URL)`,
    };
  }
  vars.BASE_URL = planEnv.baseUrl;
  return { vars, log: `[peeps] environment ${name}, BASE_URL ${url}` };
}
