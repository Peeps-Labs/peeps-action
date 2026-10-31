/**
 * The Peeps environment a dispatched run was started in, as the test process
 * sees it. Peeps' plan names the environment and its `BASE_URL` (nothing else:
 * secrets stay in Peeps, and the workflow holds its own). Run mode exports
 * them as `PEEPS_ENVIRONMENT` and `PEEPS_BASE_URL`, and as `BASE_URL` only when
 * the workflow has not set one: a value the workflow set is the customer's own
 * choice, and Peeps never edits the workflow.
 */

export interface PlanEnvironment {
  name: string;
  baseUrl: string | null;
}

export function planEnvironmentVariables(
  planEnv: PlanEnvironment | null | undefined,
  current: NodeJS.ProcessEnv,
): { vars: Record<string, string>; log: string } {
  if (!planEnv) return { vars: {}, log: "" };
  const vars: Record<string, string> = { PEEPS_ENVIRONMENT: planEnv.name };
  if (!planEnv.baseUrl) {
    return { vars, log: `[peeps] environment ${planEnv.name} (no BASE_URL in Peeps)` };
  }
  vars.PEEPS_BASE_URL = planEnv.baseUrl;
  if (current.BASE_URL) {
    return {
      vars,
      log: `[peeps] environment ${planEnv.name}; the workflow's BASE_URL runs, not ${planEnv.baseUrl} (also in PEEPS_BASE_URL)`,
    };
  }
  vars.BASE_URL = planEnv.baseUrl;
  return { vars, log: `[peeps] environment ${planEnv.name}, BASE_URL ${planEnv.baseUrl}` };
}
