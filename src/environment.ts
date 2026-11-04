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
 * For the job log, which may be public: a control character in a name could
 * start a workflow command on a line of its own, and a URL's credentials stay out.
 */
function forLog(text: string): string {
  return text
    .replace(/[\p{Cc}\p{Zl}\p{Zp}]+/gu, " ")
    .replace(/https?:\/\/[^@\s/]+@/g, (prefix) => `${prefix.split("//")[0]}//***@`);
}

export function planEnvironmentVariables(
  planEnv: PlanEnvironment | null | undefined,
  current: NodeJS.ProcessEnv,
): { vars: Record<string, string>; log: string } {
  if (!planEnv) return { vars: {}, log: "" };
  const vars: Record<string, string> = { PEEPS_ENVIRONMENT: planEnv.name };
  const name = forLog(planEnv.name);
  if (!planEnv.baseUrl) {
    return { vars, log: `[peeps] environment ${name} (no BASE_URL in Peeps)` };
  }
  vars.PEEPS_BASE_URL = planEnv.baseUrl;
  const url = forLog(planEnv.baseUrl);
  if (current.BASE_URL) {
    return {
      vars,
      log: `[peeps] environment ${name}; the workflow's BASE_URL runs, not ${url} (also in PEEPS_BASE_URL)`,
    };
  }
  vars.BASE_URL = planEnv.baseUrl;
  return { vars, log: `[peeps] environment ${name}, BASE_URL ${url}` };
}
