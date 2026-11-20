/**
 * The jail's shape, as pure data: what `jail.ts` asks systemd for, and what the
 * outer watcher and init are told. No file system, process or network here.
 * Plan: spok-load-testing/impl/engine-redesign-plan-v3.md §3; facts from E0.
 */

/** The relay's uid inside the jail. Only it may open the supervisor's proxy socket. */
export const RELAY_UID = 65533;

/** Socket families any process in the unit may create. vsock and packet sockets are refused (E0: vsock is reachable from an empty netns without this). */
export const ADDRESS_FAMILIES = ["AF_UNIX", "AF_INET", "AF_INET6", "AF_NETLINK"] as const;

/** System calls refused to the whole unit. They fail with EPERM: systemd's default kills, and Node's libuv probes io_uring at start (E0 run 1). */
export const DENIED_SYSCALLS = [
  "@debug",
  "bpf",
  "keyctl",
  "add_key",
  "request_key",
  "pidfd_getfd",
  "setns",
  "io_uring_setup",
  "io_uring_enter",
  "io_uring_register",
] as const;

/** Paths inside the jail. */
export const IN_JAIL = {
  workspace: "/run/peeps/ws",
  home: "/run/peeps/home",
  node: "/run/peeps/node",
  action: "/run/peeps/action",
  sockets: "/run/peeps/sock",
  ca: "/run/peeps/ca.pem",
  relayPort: 3128,
} as const;

export interface JailLimits {
  /** The unit is stopped after this, whatever its processes do. */
  maxRunMs: number;
  /** systemd MemoryMax, for example "2G". */
  memoryMax: string;
  tasksMax: number;
  /** CPUQuota as a percentage of one core, for example 300 for three cores. */
  cpuQuotaPercent: number;
}

export interface JailSpec {
  /** Names the unit and the socket directory: lowercase letters, digits and dashes. */
  runId: string;
  /** The trusted Node binary, never one from the checkout. */
  node: string;
  /** The folder holding the trusted Node (staged read-only as /run/peeps/node). */
  nodeDir: string;
  /** The action's own bundles: `outer` and `init` sit in this folder. */
  actionDir: string;
  outer: string;
  init: string;
  /** The checkout, staged read-only under a writable overlay. */
  workspace: string;
  /** The run CA's public certificate, when the executor talks TLS through the gate. */
  caPem?: string;
  /** The executor's uid and gid inside the jail: the runner's own (E0: lifecycle scripts must write their package folders). */
  executorUid: number;
  executorGid: number;
  /** The claim this jail serves: init refuses tickets for any other. */
  claimId: string;
  /** The in-jail install (`npm rebuild --foreground-scripts`), run after the start ticket, before launch. */
  install?: string[];
  /** The executor's command, with paths as the jail sees them. */
  command: string[];
  /** Extra environment for the executor, by name. Nothing else reaches it. */
  env: Record<string, string>;
  limits: JailLimits;
}

/** What the outer watcher and init read from PEEPS_JAIL_CONFIG. */
export interface InitConfig {
  runId: string;
  socketDir: string;
  workspace: string;
  nodeDir: string;
  actionDir: string;
  caPem?: string;
  /** Init's own bundle, as the jail sees it (the relay runs it with --relay). */
  initInJail: string;
  /** The trusted Node, as the jail sees it. */
  nodeInJail: string;
  executorUid: number;
  executorGid: number;
  claimId: string;
  install?: string[];
  command: string[];
  env: Record<string, string>;
}

const RUN_ID = /^[a-z0-9][a-z0-9-]{0,39}$/;
const ENV_NAME = /^[A-Z_][A-Z0-9_]*$/;
const RESERVED_ENV = new Set(["PATH", "HOME", "NODE_EXTRA_CA_CERTS", "NODE_OPTIONS", "LD_PRELOAD", "LD_LIBRARY_PATH"]);

export function unitName(runId: string): string {
  return `peeps-load-${runId}`;
}

export function socketDir(runId: string): string {
  return `/run/peeps-load-${runId}`;
}

/** Where init builds the jail's root. The folder stays behind on the host's /run, empty. */
export function rootDir(runId: string): string {
  return `/run/peeps-root-${runId}`;
}

/**
 * The runner reads `::name::` after any leading whitespace (its own idea of it, U+0085
 * included) and `##[name]` anywhere in a line as a workflow command. A fixed, visible
 * prefix keeps every line from starting with `::`, and no `##[` survives.
 */
export const OUTPUT_PREFIX = "jail| ";
export function neutralize(line: string): string {
  return OUTPUT_PREFIX + line.replaceAll("##[", "## [");
}

/** Why a spec cannot be launched, or nothing. */
export function specProblems(spec: JailSpec): string[] {
  const problems: string[] = [];
  if (!RUN_ID.test(spec.runId)) problems.push("runId must be 1-40 lowercase letters, digits or dashes");
  for (const [name, value] of Object.entries({
    node: spec.node,
    nodeDir: spec.nodeDir,
    actionDir: spec.actionDir,
    outer: spec.outer,
    init: spec.init,
    workspace: spec.workspace,
    ...(spec.caPem ? { caPem: spec.caPem } : {}),
  })) {
    if (!isPlainAbsolute(value)) problems.push(`${name} must be an absolute path without "..", newlines or NUL`);
  }
  if (!within(spec.node, spec.nodeDir)) problems.push("node must sit inside nodeDir");
  if (dirOf(spec.outer) !== spec.actionDir || dirOf(spec.init) !== spec.actionDir) problems.push("outer and init must sit directly in actionDir");
  if (!Number.isInteger(spec.executorUid) || spec.executorUid <= 0 || spec.executorUid === RELAY_UID) problems.push("executorUid must be a non-root uid other than the relay's");
  if (!Number.isInteger(spec.executorGid) || spec.executorGid <= 0 || spec.executorGid === RELAY_UID) problems.push("executorGid must be a non-root gid other than the relay's");
  if (spec.command.length === 0 || spec.command.some((arg) => arg.includes("\0"))) problems.push("command must be non-empty, without NUL");
  if (spec.install && (spec.install.length === 0 || spec.install.some((arg) => arg.includes("\0")))) problems.push("install must be non-empty, without NUL");
  if (typeof spec.claimId !== "string" || !/^[\x21-\x7e]{1,256}$/.test(spec.claimId)) problems.push("claimId must be 1-256 printable characters");
  for (const [name, value] of Object.entries(spec.env)) {
    if (!ENV_NAME.test(name) || RESERVED_ENV.has(name)) problems.push(`env ${name} is not allowed`);
    if (/[\0\n]/.test(value)) problems.push(`env ${name} has a newline or NUL`);
  }
  const { maxRunMs, memoryMax, tasksMax, cpuQuotaPercent } = spec.limits;
  if (!Number.isInteger(maxRunMs) || maxRunMs < 1000) problems.push("maxRunMs must be at least 1000");
  if (!/^[1-9][0-9]*[KMG]$/.test(memoryMax)) problems.push("memoryMax must look like 512M or 2G");
  if (!Number.isInteger(tasksMax) || tasksMax < 16) problems.push("tasksMax must be at least 16");
  if (!Number.isInteger(cpuQuotaPercent) || cpuQuotaPercent < 50) problems.push("cpuQuotaPercent must be at least 50");
  return problems;
}

export function initConfig(spec: JailSpec): InitConfig {
  return {
    runId: spec.runId,
    socketDir: socketDir(spec.runId),
    workspace: spec.workspace,
    nodeDir: spec.nodeDir,
    actionDir: spec.actionDir,
    ...(spec.caPem ? { caPem: spec.caPem } : {}),
    initInJail: `${IN_JAIL.action}/${baseOf(spec.init)}`,
    nodeInJail: `${IN_JAIL.node}/${spec.node.slice(spec.nodeDir.length + 1)}`,
    executorUid: spec.executorUid,
    executorGid: spec.executorGid,
    claimId: spec.claimId,
    ...(spec.install ? { install: spec.install } : {}),
    command: spec.command,
    env: spec.env,
  };
}

/** The argv after `sudo -n`: a transient unit whose main process is the outer watcher. */
export function systemdRunArgs(spec: JailSpec): string[] {
  const { maxRunMs, memoryMax, tasksMax, cpuQuotaPercent } = spec.limits;
  const property = (value: string) => ["-p", value];
  return [
    "/usr/bin/systemd-run",
    `--unit=${unitName(spec.runId)}`,
    "--pipe",
    "--wait",
    "--collect",
    "--quiet",
    "--service-type=exec",
    "--working-directory=/",
    ...property("KillMode=control-group"),
    // No grace on stop: the gate is already closed, and customer code gets no last word.
    ...property("KillSignal=SIGKILL"),
    ...property("TimeoutStopSec=2s"),
    ...property(`RuntimeMaxSec=${Math.ceil(maxRunMs / 1000)}s`),
    ...property(`MemoryMax=${memoryMax}`),
    ...property(`TasksMax=${tasksMax}`),
    ...property("LimitNOFILE=4096"),
    ...property(`CPUQuota=${cpuQuotaPercent}%`),
    ...property(`RestrictAddressFamilies=${ADDRESS_FAMILIES.join(" ")}`),
    ...property("SystemCallErrorNumber=EPERM"),
    // RestrictAddressFamilies does not cover i386 socketcall(); without this, int 0x80 opens vsock.
    ...property("SystemCallArchitectures=native"),
    ...property(`SystemCallFilter=~${DENIED_SYSCALLS.join(" ")}`),
    `--setenv=PEEPS_JAIL_CONFIG=${JSON.stringify(initConfig(spec))}`,
    spec.node,
    spec.outer,
  ];
}

/** The executor's environment: nothing from the job, only what the spec names. */
export function executorEnv(config: InitConfig): string[] {
  return [
    `PATH=${dirOf(config.nodeInJail)}:/usr/bin:/bin`,
    `HOME=${IN_JAIL.home}`,
    ...(config.caPem ? [`NODE_EXTRA_CA_CERTS=${IN_JAIL.ca}`] : []),
    ...Object.entries(config.env).map(([name, value]) => `${name}=${value}`),
  ];
}

/**
 * The in-jail install's environment: offline, the public registry named, no git, a cache in
 * the jail's own home, and nothing from the job or the journey. Scripts run (that is what the
 * rebuild is for), as the executor's uid, in the overlay, with no route out.
 */
export function rebuildEnv(config: InitConfig): string[] {
  return [
    `PATH=${dirOf(config.nodeInJail)}:/usr/bin:/bin`,
    `HOME=${IN_JAIL.home}`,
    "npm_config_offline=true",
    "npm_config_registry=https://registry.npmjs.org/",
    `npm_config_userconfig=${IN_JAIL.home}/.npmrc-none`,
    `npm_config_globalconfig=${IN_JAIL.home}/.npmrc-global-none`,
    "npm_config_git=/bin/false",
    `npm_config_cache=${IN_JAIL.home}/.npm`,
    "npm_config_install_links=false",
    "npm_config_audit=false",
    "npm_config_fund=false",
    "npm_config_update_notifier=false",
  ];
}

/** setpriv's argv for dropping to `uid`: no groups, no capabilities, no way back. */
export function dropArgs(uid: number, gid: number): string[] {
  return [
    `--reuid=${uid}`,
    `--regid=${gid}`,
    "--clear-groups",
    "--bounding-set=-all",
    "--inh-caps=-all",
    "--ambient-caps=-all",
    "--no-new-privs",
  ];
}

function isPlainAbsolute(value: string): boolean {
  return value.startsWith("/") && !/[\0\n]/.test(value) && !value.split("/").includes("..") && !value.endsWith("/");
}

function within(file: string, dir: string): boolean {
  return file.startsWith(`${dir}/`);
}

function dirOf(file: string): string {
  return file.slice(0, file.lastIndexOf("/")) || "/";
}

function baseOf(file: string): string {
  return file.slice(file.lastIndexOf("/") + 1);
}
