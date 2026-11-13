/**
 * "Send to CI" variables: values a person stored in a Peeps environment and
 * switched on for this repository's CI runs. The job asks for them before it
 * collects its tests, so a test file or config that reads one when it loads
 * sees it: a run Peeps started names its batch (`session-id`), and a run the
 * workflow started names the environment with the `peeps-environment` input.
 *
 * Each value is masked in the job log (`::add-mask::`) before anything else
 * runs, then set for the test process. A variable the workflow already sets
 * wins, the same rule as `BASE_URL`, and the log names variables, never their
 * values. GitHub only: GitLab has no way to mask a value while a job runs.
 *
 * Agent mode never gets them: its tools read the environment on Peeps' agent's
 * behalf. The run that checks a fix is a run Peeps started, so it does.
 */

import type { RunnerEnv } from "./env";
import { nameForLog } from "./environment";
import { PeepsHttpError, type PeepsClient } from "./peeps";

export interface SharedVariable {
  key: string;
  value: string;
}

const KEY = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * Names Peeps may not set, whatever an environment holds: what Peeps itself
 * sets, what the CI system sets, and what changes how a program starts rather
 * than what a test reads (a shell's startup options, a runtime's flags, a
 * loader, a certificate store). Peeps refuses the same names before it sends
 * anything (`isCiSendableKey`); this is the second check.
 */
const RESERVED =
  /^(?:BASE_URL|PEEPS_.*|GITHUB_.*|RUNNER_.*|ACTIONS_.*|INPUT_.*|CI|PATH|HOME|SHELL|USER|TMPDIR|IFS|CDPATH|GLOBIGNORE|SHELLOPTS|BASHOPTS|PS[0-4]|BASH_.*|PROMPT_COMMAND|ENV|EDITOR|VISUAL|PAGER|BROWSER|SSH_.*|NODE_.*|NPM_.*|YARN_.*|PNPM_.*|BUN_.*|DENO_.*|ELECTRON_.*|LD_.*|DYLD_.*|GCONV_PATH|LOCPATH|MALLOC_.*|PYTHON.*|PIP_.*|PYTEST_.*|UV_.*|VIRTUAL_ENV|CONDA_.*|PERL.*|RUBY.*|GEM_.*|BUNDLE_.*|JAVA_.*|JDK_JAVA_OPTIONS|_JAVA_OPTIONS|MAVEN_.*|GRADLE_.*|DOTNET_.*|COMPLUS_.*|CORECLR_.*|HTTPS?_PROXY|ALL_PROXY|NO_PROXY|SSL_CERT_.*|OPENSSL_.*|REQUESTS_CA_BUNDLE|CURL_CA_BUNDLE|PLAYWRIGHT_.*|PW_.*|GIT_.*|XDG_.*)$/i;

/** GitHub's workflow-command escaping for a command's data. */
function escapeCommandData(value: string): string {
  return value.replace(/%/g, "%25").replace(/\r/g, "%0D").replace(/\n/g, "%0A");
}

/** The `::add-mask::` lines for one value: the whole of it, and each line on its own. */
export function maskCommands(value: string): string[] {
  const parts = new Set([value, ...value.split(/\r?\n/)].filter((p) => p.trim() !== ""));
  return [...parts].map((p) => `::add-mask::${escapeCommandData(p)}`);
}

/**
 * Mask every value, then set each one the workflow has not set. Masks first,
 * all of them, so no later line can print a value before it is masked.
 * Returns what it set, what the workflow's own value kept, and the names it
 * refused; logs those names only.
 */
export function exportSharedVariables(
  variables: ReadonlyArray<SharedVariable>,
  options: {
    current?: NodeJS.ProcessEnv;
    write?: (line: string) => void;
    source: string;
  },
): { set: string[]; kept: string[]; refused: string[] } {
  const current = options.current ?? process.env;
  const write = options.write ?? ((line: string) => console.log(line));
  const set: string[] = [];
  const kept: string[] = [];
  const refused: string[] = [];
  if (current.GITHUB_ACTIONS !== "true") {
    if (variables.length > 0) {
      write(
        `[peeps] ${variables.length} variable(s) from Peeps not set: only GitHub Actions can mask them in the job log.`,
      );
    }
    return { set, kept, refused: variables.map((v) => v.key) };
  }
  const usable = variables.filter((v) => typeof v.key === "string" && typeof v.value === "string");
  for (const v of usable) for (const line of maskCommands(v.value)) write(line);
  for (const v of usable) {
    if (!KEY.test(v.key) || RESERVED.test(v.key)) {
      refused.push(v.key);
    } else if (current[v.key] !== undefined) {
      kept.push(v.key);
    } else {
      current[v.key] = v.value;
      set.push(v.key);
    }
  }
  const names = (keys: string[]) => keys.map(nameForLog).join(", ");
  if (set.length > 0) write(`[peeps] variables from ${options.source}, masked: ${names(set)}`);
  if (kept.length > 0) write(`[peeps] the workflow's own value runs for ${names(kept)}`);
  if (refused.length > 0) write(`[peeps] not set (reserved name): ${names(refused)}`);
  return { set, kept, refused };
}

interface VariablesAnswer {
  project: string;
  environment: string;
  variables: SharedVariable[];
}

/**
 * Ask Peeps for the variables and export them. Never fails the job: a test
 * that needs one fails on its own. `quietWhenNotFound` is for a run Peeps
 * started, which asks on every run: one with no environment, or a Peeps that
 * predates this, answers 404, and that is not worth a warning.
 */
async function fetchAndExport(
  peeps: PeepsClient,
  body: Record<string, unknown>,
  options: { asked: string; quietWhenNotFound: boolean },
): Promise<void> {
  let answer: VariablesAnswer;
  try {
    answer = await peeps.post<VariablesAnswer>("/api/v1/ci/environment-variables", body);
  } catch (error) {
    if (options.quietWhenNotFound && error instanceof PeepsHttpError && error.status === 404) {
      console.log("[peeps] no variables from Peeps for this run");
      return;
    }
    const message = error instanceof Error ? error.message : String(error);
    console.log(
      `::warning::Could not get the variables of ${options.asked}; the tests run without them. ${nameForLog(message)}`,
    );
    return;
  }
  const variables = Array.isArray(answer.variables) ? answer.variables : [];
  const where = `Peeps ${nameForLog(answer.project ?? "")} environment ${nameForLog(answer.environment ?? "")}`;
  if (variables.length === 0) {
    console.log(`[peeps] ${where} has no variables switched on for CI`);
    return;
  }
  exportSharedVariables(variables, { source: where });
}

/**
 * A run the workflow started: ask Peeps for the `peeps-environment` input's
 * variables and export them.
 */
export async function exportWorkflowVariables(env: RunnerEnv, peeps: PeepsClient): Promise<void> {
  const from = env.sharedVariablesFrom;
  if (!from) return;
  if (env.platform !== "github") {
    console.log("[peeps] peeps-environment is ignored outside GitHub Actions: GitLab cannot mask a value in the job log.");
    return;
  }
  await fetchAndExport(
    peeps,
    { environment: from.environment, project: from.project },
    { asked: `Peeps environment ${nameForLog(from.environment)}`, quietWhenNotFound: false },
  );
}

/**
 * A run Peeps started: ask for its batch's environment's variables, before the
 * run mode lists or collects any test. GitHub only, like the rest.
 */
export async function exportDispatchedVariables(env: RunnerEnv, peeps: PeepsClient): Promise<void> {
  if (env.platform !== "github" || !env.sessionId) return;
  await fetchAndExport(
    peeps,
    { batchId: env.sessionId },
    { asked: "this run's Peeps environment", quietWhenNotFound: true },
  );
}
