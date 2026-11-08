/**
 * The job-environment redactor, on its own so the dependency-free WebdriverIO
 * reporter bundle (dist/appium-reporter.js) can use it without pulling in the
 * agent's tool server. `tools.ts` re-exports it.
 */

/**
 * Mask every non-trivial value present in the job's environment: that set IS
 * the secrets the customer exposed to this job. Cheap, and it closes the
 * obvious leak (a test printing `process.env.TOKEN` into a trace or stdout).
 */
export function makeRedactor(env: NodeJS.ProcessEnv): (text: string) => string {
  const values = Object.entries(env)
    .filter(([k, v]) => v && v.length >= 8 && isSecretish(k))
    .map(([, v]) => v!)
    .sort((a, b) => b.length - a.length);
  if (values.length === 0) return (t) => t;
  const pattern = new RegExp(values.map((v) => v.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|"), "g");
  return (text) => text.replace(pattern, "[redacted]");
}

function isSecretish(key: string): boolean {
  if (ALWAYS_MASK_KEYS.has(key)) return true;
  if (SAFE_ENV_KEYS.has(key)) return false;
  return !/^(GITHUB|RUNNER|ACTIONS|INPUT|CI)_/.test(key);
}

/**
 * The `GITHUB_`/`ACTIONS_` prefixes are skipped wholesale because masking
 * things like `GITHUB_REPOSITORY` mangles otherwise useful output. But three of
 * those variables are live credentials, and they are exactly the ones worth
 * masking:
 *
 *  - `ACTIONS_ID_TOKEN_REQUEST_TOKEN` mints an OIDC token for ANY audience,
 *    so it is as good as a key to whatever else trusts this repository.
 *  - `ACTIONS_RUNTIME_TOKEN` grants cache and artifact writes for the run.
 *  - `GITHUB_TOKEN` is set by the very common
 *    `env: GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}`.
 *
 * Listed by name so the prefix exemption stays a convenience and stops being a
 * hole. `BASE_URL` is NOT masked, by the same convenience argument, and note
 * that report mode sends it to Peeps: a `BASE_URL` carrying basic-auth
 * credentials is therefore visible to Peeps. `SECURITY.md` says so.
 */
const ALWAYS_MASK_KEYS = new Set([
  "ACTIONS_ID_TOKEN_REQUEST_TOKEN",
  "ACTIONS_RUNTIME_TOKEN",
  "GITHUB_TOKEN",
  // GitLab's `CI_` variables are exempt by prefix like GitHub's, except the
  // ones that are credentials: the job token (and the clone URL it is in),
  // the legacy job JWTs, and the registry, deploy and proxy passwords.
  "CI_JOB_TOKEN",
  "CI_REPOSITORY_URL",
  "CI_JOB_JWT",
  "CI_JOB_JWT_V1",
  "CI_JOB_JWT_V2",
  "CI_REGISTRY_PASSWORD",
  "CI_DEPLOY_PASSWORD",
  "CI_DEPENDENCY_PROXY_PASSWORD",
]);
const SAFE_ENV_KEYS = new Set(["PATH", "HOME", "PWD", "SHELL", "LANG", "TERM", "NODE_OPTIONS", "CI", "BASE_URL", "PEEPS_API_URL"]);
