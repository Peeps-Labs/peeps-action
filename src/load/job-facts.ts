/**
 * Gathers the customer load job's facts (CW plan §4.3) for `customerRefusal`. Its only I/O is
 * two existence checks and the host name: nothing on PATH is executed, no variable's value is
 * kept but the ones the refusals compare, and nothing reaches the network.
 */
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { PRELOAD_VARS, loadNodeDir, type JobFacts } from "./customer";

export interface JobFactsDeps {
  /** The file system root `/.dockerenv` is looked up under (tests: a temp folder). */
  root?: string;
  exists?: (file: string) => boolean;
  hostname?: () => string;
  arch?: string;
}

const VERSION = /^\d{1,3}\.\d{1,3}\.\d{1,3}$/;
const DIGITS = /^[1-9][0-9]{0,18}$/;

export function readJobFacts(env: NodeJS.ProcessEnv, deps: JobFactsDeps = {}): JobFacts {
  const exists = deps.exists ?? existsSync;
  const arch = deps.arch ?? process.arch;
  const value = (name: string) => {
    const v = env[name];
    return typeof v === "string" && v.length > 0 ? v : null;
  };
  const input = (name: string) => {
    const v = env[name]?.trim();
    return v ? v : null;
  };
  const workspace = value("GITHUB_WORKSPACE");
  const toolCache = value("RUNNER_TOOL_CACHE");
  let hostname: string | null = null;
  try {
    hostname = (deps.hostname ?? os.hostname)();
  } catch {
    hostname = null;
  }
  return {
    github: env.GITHUB_ACTIONS === "true" && workspace !== null && path.isAbsolute(workspace) && DIGITS.test(value("GITHUB_RUN_ID") ?? ""),
    oidcUrl: value("ACTIONS_ID_TOKEN_REQUEST_URL") !== null,
    oidcToken: value("ACTIONS_ID_TOKEN_REQUEST_TOKEN") !== null,
    actionRef: value("GITHUB_ACTION_REF"),
    job: value("GITHUB_JOB"),
    eventName: value("GITHUB_EVENT_NAME"),
    runAttempt: value("GITHUB_RUN_ATTEMPT"),
    dockerenv: exists(path.join(deps.root ?? "/", ".dockerenv")),
    workspace,
    hostname,
    toolCache,
    trustedNodePresent: toolCache !== null && path.isAbsolute(toolCache) && exists(loadNodeDir(toolCache, arch)),
    pathNodeVersions: toolCache === null ? [] : pathNodeVersions(env.PATH ?? "", toolCache, arch),
    preloadVars: PRELOAD_VARS.filter((name) => value(name) !== null),
    grant: input("INPUT_LOAD-GRANT"),
    workload: input("INPUT_LOAD-WORKLOAD"),
    apiUrl: value("PEEPS_API_URL"),
  };
}

/** `<toolCache>/node/<v>/<arch>/bin` entries of PATH, as versions: text only, well-formed, at most five. */
export function pathNodeVersions(pathVar: string, toolCache: string, arch: string): string[] {
  const prefix = `${toolCache.replace(/\/+$/, "")}/node/`;
  const suffix = `/${arch}/bin`;
  const out: string[] = [];
  for (const entry of pathVar.split(":")) {
    const dir = entry.replace(/\/+$/, "");
    if (!dir.startsWith(prefix) || !dir.endsWith(suffix)) continue;
    const version = dir.slice(prefix.length, dir.length - suffix.length);
    if (VERSION.test(version) && !out.includes(version)) out.push(version);
    if (out.length === 5) break;
  }
  return out;
}
