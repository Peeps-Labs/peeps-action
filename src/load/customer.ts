/**
 * The customer load job's refusals (CW plan §4.3): what a `uses: Peeps-Labs/peeps-action@<sha>`
 * step with `mode: load` checks before any network, cheapest first, first match wins. Pure: it
 * takes the job's facts (`job-facts.ts` gathers them) and reads no file, clock or environment.
 *
 * Only fixed copy and four bounded, sanitized values are ever printed: `{id}` (a 12-hex host
 * name), `{vars}` (names from a fixed list), `{found}` (at most five `n.n.n` versions) and
 * `{name}` (fixed input names). Never a token, a grant, a variable's value or a checkout path.
 *
 * The copy is load-job-v1's `refusal-copy.json` (unhashed, cheap to change); the codes and slots
 * are its hashed `refusal-codes.json`. `test/load-job-fixture.test.ts` compares both.
 */
import { loadControlOrigin } from "./control-origin";

/** The Node the customer path runs on, from the runner's toolcache (`SUPPORTED_TOOLCHAIN` holds its hashes). */
export const LOAD_NODE_VERSION = "24.22.3";

/** The variables that change how Node or the dynamic loader starts. The job blanks all six. */
export const PRELOAD_VARS = ["NODE_OPTIONS", "NODE_DEBUG", "NODE_PATH", "LD_PRELOAD", "LD_AUDIT", "LD_LIBRARY_PATH"] as const;

/** What the job looks like, gathered once with no network. */
export interface JobFacts {
  /** `GITHUB_ACTIONS` is "true", with an absolute workspace and a numeric run id. */
  github: boolean;
  oidcUrl: boolean;
  oidcToken: boolean;
  /** `GITHUB_ACTION_REF`: the commit for a commit pin, the tag's name for a tag. */
  actionRef: string | null;
  job: string | null;
  eventName: string | null;
  runAttempt: string | null;
  dockerenv: boolean;
  workspace: string | null;
  hostname: string | null;
  toolCache: string | null;
  /** `$RUNNER_TOOL_CACHE/node/24.22.3/<arch>` exists. */
  trustedNodePresent: boolean;
  /** The versions of the toolcache Node folders on PATH, read as text, each `n.n.n`, at most five. */
  pathNodeVersions: string[];
  /** The names (never the values) of the `PRELOAD_VARS` that are set and not empty. */
  preloadVars: string[];
  grant: string | null;
  workload: string | null;
  apiUrl: string | null;
}

export type CustomerRefusalCode =
  | "action_not_pinned"
  | "not_github"
  | "job"
  | "rerun"
  | "fence_unverified"
  | "node_options"
  | "node_version"
  | "input"
  | "control_origin"
  | "identity"
  | "self_hosted";

/** The copy for each refusal, `{slot}` marking a value. The same text as load-job-v1's `refusal-copy.json`. */
export const REFUSAL_COPY: Readonly<Record<CustomerRefusalCode, string>> = {
  action_not_pinned: "Load testing isn't available for this repository yet.",
  not_github: "Load runs need GitHub Actions with `id-token: write`.",
  job: "Load runs start only in the `peeps-load` job of a workflow Peeps dispatched.",
  rerun: "Load runs can't be re-run. Start a new run from Peeps.",
  fence_unverified: "This load job runs in a container ({id}). Load runs need the runner itself: remove `container:` from the `peeps-load` job.",
  node_options: "Unset {vars} for load runs: they change how Node starts.",
  node_version: "Load runs need Node 24.22.3 from `actions/setup-node`. This job set up Node {found}.",
  input: "Peeps' dispatch inputs are missing or malformed: {name}.",
  control_origin: "PEEPS_API_URL must be set to one of Peeps' own addresses for load runs.",
  identity: "This job's GitHub identity token doesn't match its run.",
  self_hosted: "Load runs need a GitHub-hosted runner for now. This job ran on a self-hosted runner.",
};

/**
 * Fixed copy for the refusals the run itself reaches, before any claim: the install, the
 * toolchain and the jail probe. Action-local for now: load-job-v1's hashed codes don't hold them,
 * so they join the corpus with load-job-v2. Their cause follows on plain, neutralized lines,
 * never inside the `::error` line (it may hold lockfile text).
 */
export const RUN_REFUSAL_COPY = {
  install_unsupported: "This repository's install isn't supported for load runs. The lines after this one say why.",
  install_failed: "Installing this repository's dependencies failed before the load run started. The lines after this one say why. Start a new run from Peeps.",
  fence_unverified: "This job's jail check failed: load runs need the runner itself. The lines after this one say why.",
} as const;

/** A job whose identity token couldn't be minted at all (an unreachable or off-host endpoint, or GitHub failing). */
export const IDENTITY_FAILED_COPY = "Couldn't read this job's identity from GitHub. Start a new run from Peeps.";

/** Today's `mode: load` line, printed alone, byte for byte, for anything not pinned to a commit. */
export const NOT_PINNED_LINE = `::error::${REFUSAL_COPY.action_not_pinned}`;

export interface CustomerRefusal {
  code: CustomerRefusalCode;
  /** The copy with its slots filled. */
  message: string;
}

const COMMIT = /^[0-9a-f]{40}$/;
const GRANT_REF = /^[A-Za-z0-9_-]{22}$/;
/** Peeps' `WORKLOAD_FILE` (`github-workload-source.ts`). */
const WORKLOAD_FILE = /^peeps\/load\/[^/]+\.workload\.ya?ml$/;
const CONTAINER_ID = /^[0-9a-f]{12}$/;

export function refusal(code: CustomerRefusalCode, slots: Record<string, string> = {}): CustomerRefusal {
  return { code, message: REFUSAL_COPY[code].replace(/\{(\w+)\}/g, (_m, name: string) => slots[name] ?? "") };
}

/** The first refusal that applies, or null. Every check is local; none needs the network. */
export function customerRefusal(f: JobFacts): CustomerRefusal | null {
  if (f.actionRef === null || !COMMIT.test(f.actionRef)) return refusal("action_not_pinned");
  if (!f.github || !f.oidcUrl || !f.oidcToken) return refusal("not_github");
  if (f.job !== "peeps-load" || f.eventName !== "workflow_dispatch") return refusal("job");
  if (f.runAttempt !== "1") return refusal("rerun");
  if (f.dockerenv || (f.workspace ?? "").startsWith("/__w/")) {
    return refusal("fence_unverified", { id: f.hostname !== null && CONTAINER_ID.test(f.hostname) ? f.hostname : "the job's container" });
  }
  if (f.preloadVars.length > 0) return refusal("node_options", { vars: f.preloadVars.join(", ") });
  if (!f.trustedNodePresent) return refusal("node_version", { found: f.pathNodeVersions.length > 0 ? f.pathNodeVersions.join(", ") : "no Node" });
  const bad = [
    ...(f.grant !== null && GRANT_REF.test(f.grant) ? [] : ["loadGrant"]),
    ...(f.workload !== null && WORKLOAD_FILE.test(f.workload) ? [] : ["loadWorkload"]),
  ];
  if (bad.length > 0) return refusal("input", { name: bad.join(", ") });
  if (!loadControlOrigin(f.apiUrl ?? undefined).ok) return refusal("control_origin");
  return null;
}

/** setup-node's folder for the pinned Node: computed, never taken from PATH or `process.execPath`. */
export function loadNodeDir(toolCache: string, arch: string): string {
  return `${toolCache.replace(/\/+$/, "")}/node/${LOAD_NODE_VERSION}/${arch}`;
}
