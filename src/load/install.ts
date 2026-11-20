/**
 * The pre-claim install (e4 plan v3 §2.2). It runs on the runner, outside the jail, before
 * the claim, and runs no customer code: npm is started only after the root manifest and the
 * lockfile pass validation, only with config the action writes, and only from the trusted
 * toolchain (setup-node's, never one in or through the checkout). Lifecycle scripts run later,
 * offline, inside the jail (`npm rebuild`).
 *
 * The checkout is then recorded: `treeDigest` over everything that will be mounted, and
 * `checkoutHead` read from `.git` as files, so no git binary reads the checkout's own config.
 *
 * Not in E4 (PQA-3580): a network fence for the install that does not depend on npm, private
 * registries, other package managers.
 */
import { execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, readlinkSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { lstat, readdir, readlink } from "node:fs/promises";
import path from "node:path";
import { neutralize } from "./jail/spec";

/** The toolchains CI pins (`ci.yml`): node and the npm it ships with. */
export const SUPPORTED_TOOLCHAIN: readonly { node: string; npm: string }[] = [{ node: "24.22.3", npm: "11.19.1" }];
export const REGISTRY = "https://registry.npmjs.org/";
const INSTALL_MS = 10 * 60_000;
const DEP_FIELDS = ["dependencies", "devDependencies", "optionalDependencies", "peerDependencies"] as const;

/** Refused before anything ran. The message starts with the reason code. */
export class InstallRefused extends Error {
  constructor(readonly problems: string[]) {
    super(`install_unsupported: ${problems.join("; ")}`);
    this.name = "InstallRefused";
  }
}

export interface Toolchain {
  nodeDir: string;
  node: string;
  npmCli: string;
  nodeVersion: string;
  npmVersion: string;
}

export interface InstallDigests {
  /** sha256 of package-lock.json. */
  lock: string;
  /** sha256 of node_modules/.package-lock.json, npm's record of what it installed. */
  hiddenLock: string;
  tree: string;
}

interface WorkspaceManifest {
  /** Relative to the root, with forward slashes. */
  rel: string;
  manifest?: unknown;
  problem?: string;
}

/** What `installProblems` reads, gathered from the file system once. */
export interface WorkspaceFiles {
  root: string;
  manifest?: unknown;
  lock?: unknown;
  /** Why a file that is present could not be read as JSON. */
  unreadable: string[];
  shrinkwrap: boolean;
  npmrc: boolean;
  workspaces: WorkspaceManifest[];
  /** Symlinks (relative paths) whose target is outside the checkout. */
  externalLinks: string[];
}

/** A JSON file the checkout holds: a regular file, inside it by real path, never followed out or read when special. */
function readJson(root: string, file: string, unreadable: string[], name: string): unknown {
  if (!lstatExists(file)) return undefined;
  try {
    const resolved = realpathSync(file);
    if (!inside(resolved, root) || !statSync(resolved).isFile()) {
      unreadable.push(name);
      return undefined;
    }
    return JSON.parse(readFileSync(resolved, "utf8"));
  } catch {
    unreadable.push(name);
    return undefined;
  }
}

function inside(child: string, root: string): boolean {
  return child === root || child.startsWith(`${root}/`);
}

function workspacePatterns(manifest: unknown): unknown[] {
  if (typeof manifest !== "object" || manifest === null) return [];
  const w = (manifest as { workspaces?: unknown }).workspaces;
  if (w === undefined) return [];
  if (Array.isArray(w)) return w;
  if (typeof w === "object" && w !== null && Array.isArray((w as { packages?: unknown }).packages)) return (w as { packages: unknown[] }).packages;
  return [w];
}

export function readWorkspace(dir: string): WorkspaceFiles {
  const root = realpathSync(dir);
  const unreadable: string[] = [];
  const manifest = readJson(root, path.join(root, "package.json"), unreadable, "package.json");
  const lock = readJson(root, path.join(root, "package-lock.json"), unreadable, "package-lock.json");
  const workspaces: WorkspaceManifest[] = [];
  for (const pattern of workspacePatterns(manifest)) {
    if (typeof pattern !== "string" || !/^[A-Za-z0-9._@/-]+(\/\*)?$/.test(pattern) || pattern.startsWith("/")) {
      workspaces.push({ rel: String(pattern), problem: "workspace pattern not supported (a folder, or a folder followed by /*)" });
      continue;
    }
    const base = pattern.endsWith("/*") ? pattern.slice(0, -2) : pattern;
    const lexical = path.resolve(root, base);
    let dirs: string[] = [];
    try {
      const real = realpathSync(lexical);
      if (!inside(real, root) || !inside(lexical, root)) {
        workspaces.push({ rel: pattern, problem: "workspace is outside the checkout" });
        continue;
      }
      // A symlinked workspace folder is listed too: its real path is checked below.
      dirs = pattern.endsWith("/*")
        ? readdirSync(real, { withFileTypes: true }).filter((entry) => entry.isDirectory() || entry.isSymbolicLink()).map((entry) => path.join(lexical, entry.name))
        : [lexical];
    } catch {
      if (!inside(lexical, root)) workspaces.push({ rel: pattern, problem: "workspace is outside the checkout" });
      continue;
    }
    for (const d of dirs) {
      const rel = path.relative(root, d).split(path.sep).join("/");
      let real: string;
      try {
        real = realpathSync(d);
      } catch {
        continue;
      }
      if (!inside(real, root)) {
        workspaces.push({ rel, problem: "workspace is outside the checkout" });
        continue;
      }
      if (!statSync(real).isDirectory() || !lstatExists(path.join(real, "package.json"))) continue;
      workspaces.push({ rel, manifest: readJson(root, path.join(real, "package.json"), unreadable, `${rel}/package.json`) });
    }
  }
  return {
    root,
    manifest,
    lock,
    unreadable,
    shrinkwrap: existsSync(path.join(root, "npm-shrinkwrap.json")),
    npmrc: lstatExists(path.join(root, ".npmrc")),
    workspaces,
    externalLinks: externalLinks(root),
  };
}

function lstatExists(file: string): boolean {
  try {
    lstatSync(file);
    return true;
  } catch {
    return false;
  }
}

/** Symlinks whose target leaves the checkout. `.git` and the inside of `node_modules` are not walked: npm ci replaces node_modules. */
function externalLinks(root: string): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isSymbolicLink()) {
        let target: string;
        try {
          target = realpathSync(full);
        } catch {
          target = path.resolve(dir, readlinkSync(full));
        }
        if (!inside(target, root)) out.push(path.relative(root, full));
      } else if (entry.isDirectory() && entry.name !== ".git" && entry.name !== "node_modules") walk(full);
    }
  };
  walk(root);
  return out;
}

// ---------------------------------------------------------------- semver (the subset npm ranges use)

interface Version {
  major: number;
  minor: number;
  patch: number;
  pre: (string | number)[];
}
type Op = "<" | "<=" | ">" | ">=" | "=";
interface Comparator {
  op: Op;
  v: Version;
}

const NUM = "0|[1-9]\\d*";
const PRE = "(?:-((?:0|[1-9]\\d*|\\d*[A-Za-z-][0-9A-Za-z-]*)(?:\\.(?:0|[1-9]\\d*|\\d*[A-Za-z-][0-9A-Za-z-]*))*))?";
const BUILD = "(?:\\+[0-9A-Za-z-]+(?:\\.[0-9A-Za-z-]+)*)?";
const FULL = new RegExp(`^v?(${NUM})\\.(${NUM})\\.(${NUM})${PRE}${BUILD}$`);
const XR = "x|X|\\*|" + NUM;
const PARTIAL = new RegExp(`^[v=]*(${XR})(?:\\.(${XR})(?:\\.(${XR})${PRE}${BUILD})?)?$`);

function preIds(s: string | undefined): (string | number)[] {
  return s ? s.split(".").map((id) => (/^\d+$/.test(id) ? Number(id) : id)) : [];
}

export function parseVersion(s: string): Version | null {
  const m = FULL.exec(s.trim());
  if (!m) return null;
  const [major, minor, patch] = [Number(m[1]), Number(m[2]), Number(m[3])];
  if (![major, minor, patch].every(Number.isSafeInteger)) return null;
  return { major, minor, patch, pre: preIds(m[4]) };
}

function compare(a: Version, b: Version): number {
  for (const k of ["major", "minor", "patch"] as const) if (a[k] !== b[k]) return a[k] < b[k] ? -1 : 1;
  if (!a.pre.length || !b.pre.length) return a.pre.length === b.pre.length ? 0 : a.pre.length ? -1 : 1;
  for (let i = 0; i < Math.max(a.pre.length, b.pre.length); i++) {
    const x = a.pre[i];
    const y = b.pre[i];
    if (x === undefined) return -1;
    if (y === undefined) return 1;
    if (x === y) continue;
    if (typeof x === "number" && typeof y === "number") return x < y ? -1 : 1;
    if (typeof x === "number") return -1;
    if (typeof y === "number") return 1;
    return x < y ? -1 : 1;
  }
  return 0;
}

const v = (major: number, minor: number, patch: number, pre: (string | number)[] = []): Version => ({ major, minor, patch, pre });
const ZERO_PRE = [0];
const isX = (s: string | undefined) => s === undefined || s === "x" || s === "X" || s === "*";

/** One comparator token (`^1.2`, `>=1`, `1.x`, ...) as plain comparators; null when not understood. */
function desugar(token: string): Comparator[] | null {
  const m = /^(\^|~>?|>=|<=|>|<|=)?(.*)$/.exec(token)!;
  const op = m[1] ?? "";
  const p = PARTIAL.exec(m[2]!);
  if (!p) return null;
  const [M, mi, pa] = [p[1], p[2], p[3]];
  const pre = preIds(p[4]);
  // An x may be followed only by more x: `x.1.0` is not a range npm reads the same way.
  if ((isX(M) && (!isX(mi) || !isX(pa))) || (isX(mi) && !isX(pa))) return null;
  if (isX(M)) {
    if (op === "" || op === "=" || op === ">=" || op === "^" || op.startsWith("~")) return [];
    return null;
  }
  const maj = Number(M);
  const min = isX(mi) ? undefined : Number(mi);
  const pat = isX(pa) ? undefined : Number(pa);
  if (min === undefined && !isX(pa) && pa !== undefined) return null;
  const lower = v(maj, min ?? 0, pat ?? 0, pat === undefined ? [] : pre);
  if (op === "" || op === "=") {
    if (min === undefined) return [{ op: ">=", v: lower }, { op: "<", v: v(maj + 1, 0, 0, ZERO_PRE) }];
    if (pat === undefined) return [{ op: ">=", v: lower }, { op: "<", v: v(maj, min + 1, 0, ZERO_PRE) }];
    return [{ op: "=", v: lower }];
  }
  if (op.startsWith("~")) {
    if (min === undefined) return [{ op: ">=", v: lower }, { op: "<", v: v(maj + 1, 0, 0, ZERO_PRE) }];
    return [{ op: ">=", v: lower }, { op: "<", v: v(maj, min + 1, 0, ZERO_PRE) }];
  }
  if (op === "^") {
    if (maj > 0 || min === undefined) return [{ op: ">=", v: lower }, { op: "<", v: v(maj + 1, 0, 0, ZERO_PRE) }];
    if (min > 0 || pat === undefined) return [{ op: ">=", v: lower }, { op: "<", v: v(0, min + 1, 0, ZERO_PRE) }];
    return [{ op: ">=", v: lower }, { op: "<", v: v(0, 0, pat + 1, ZERO_PRE) }];
  }
  if (pat !== undefined) return [{ op: op as Op, v: lower }];
  // A partial version with an operator.
  const next = min === undefined ? v(maj + 1, 0, 0, ZERO_PRE) : v(maj, min + 1, 0, ZERO_PRE);
  switch (op) {
    case ">=":
      return [{ op: ">=", v: lower }];
    case ">":
      return [{ op: ">=", v: { ...next, pre: [] } }];
    case "<":
      return [{ op: "<", v: v(maj, min ?? 0, 0, ZERO_PRE) }];
    case "<=":
      return [{ op: "<", v: next }];
    default:
      return null;
  }
}

/** A range as sets of comparators (any set may match), or null when it is not a range npm reads the same way. */
export function parseRange(range: string): Comparator[][] | null {
  if (range.length > 256 || !/^[\sA-Za-z0-9.^~<>=|*+-]*$/.test(range)) return null;
  const sets: Comparator[][] = [];
  for (const part of range.split("||")) {
    const text = part.trim().replace(/(\^|~>?|>=|<=|>|<|=)\s+/g, "$1");
    const hyphen = /^(\S+)\s+-\s+(\S+)$/.exec(text);
    if (hyphen) {
      const lo = desugar(`>=${hyphen[1]}`);
      const hi = PARTIAL.exec(hyphen[2]!);
      if (!lo || !hi || isX(hi[1])) return null;
      const upper = desugar(`<=${hyphen[2]}`);
      if (!upper) return null;
      sets.push([...lo, ...upper]);
      continue;
    }
    const set: Comparator[] = [];
    for (const token of text === "" ? [] : text.split(/\s+/)) {
      const c = desugar(token);
      if (!c) return null;
      set.push(...c);
    }
    sets.push(set);
  }
  return sets;
}

function test(version: Version, c: Comparator): boolean {
  const d = compare(version, c.v);
  switch (c.op) {
    case "<":
      return d < 0;
    case "<=":
      return d <= 0;
    case ">":
      return d > 0;
    case ">=":
      return d >= 0;
    case "=":
      return d === 0;
  }
}

/** Whether `version` satisfies `range` as npm decides it, for the ranges `parseRange` reads; anything else is false. */
export function satisfies(version: string, range: string): boolean {
  const ver = parseVersion(version);
  const sets = parseRange(range);
  if (!ver || !sets) return false;
  return sets.some((set) => {
    if (!set.every((c) => test(ver, c))) return false;
    if (!ver.pre.length) return true;
    // A prerelease matches only a comparator naming the same version with a prerelease.
    return set.some((c) => c.v.pre.length > 0 && c.v.major === ver.major && c.v.minor === ver.minor && c.v.patch === ver.patch);
  });
}

// ---------------------------------------------------------------- validation

const NAME = /^(?:@[a-z0-9][a-z0-9._~-]*\/)?[a-z0-9][a-z0-9._~-]*$/;

/** The registry name and range a manifest spec asks for, or why it is refused. */
function specOf(name: string, spec: unknown): { name: string; range: string } | string {
  if (typeof spec !== "string") return `${name}: the spec is not a string`;
  if (spec.startsWith("npm:")) {
    const rest = spec.slice(4);
    const at = rest.lastIndexOf("@");
    if (at <= 0) return `${name}: an npm: alias must name a version range`;
    const target = rest.slice(0, at);
    const range = rest.slice(at + 1);
    if (!NAME.test(target) || parseRange(range) === null) return `${name}: ${spec} is not an npm: alias to a semver range`;
    return { name: target, range };
  }
  if (parseRange(spec) === null) return `${name}: ${spec} is not a semver range (git, file, link, URL and tag specs are refused)`;
  return { name, range: spec };
}

function depsOf(manifest: unknown, field: (typeof DEP_FIELDS)[number]): Record<string, unknown> {
  const d = typeof manifest === "object" && manifest !== null ? (manifest as Record<string, unknown>)[field] : undefined;
  return typeof d === "object" && d !== null && !Array.isArray(d) ? (d as Record<string, unknown>) : {};
}

function manifestProblems(manifest: unknown, where: string): string[] {
  if (typeof manifest !== "object" || manifest === null || Array.isArray(manifest)) return [`${where}: not a JSON object`];
  const out: string[] = [];
  for (const field of DEP_FIELDS) {
    const raw = (manifest as Record<string, unknown>)[field];
    if (raw !== undefined && (typeof raw !== "object" || raw === null || Array.isArray(raw))) out.push(`${where}: ${field} is not an object`);
    for (const [name, spec] of Object.entries(depsOf(manifest, field))) {
      if (!NAME.test(name)) out.push(`${where}: ${name} is not a package name`);
      const parsed = specOf(name, spec);
      if (typeof parsed === "string") out.push(`${where}: ${field} ${parsed}`);
    }
  }
  // npm applies overrides while it builds the tree, before it checks the tree against the lock.
  if (Object.hasOwn(manifest, "overrides")) validateOverrides((manifest as Record<string, unknown>).overrides, where, out);
  return out;
}

function validateOverrides(overrides: unknown, where: string, out: string[], depth = 0): void {
  if (typeof overrides !== "object" || overrides === null || Array.isArray(overrides) || depth > 64) {
    out.push(`${where}: invalid overrides object`);
    return;
  }
  for (const [name, value] of Object.entries(overrides)) {
    if (typeof value === "object" && value !== null) validateOverrides(value, where, out, depth + 1);
    else if (!(typeof value === "string" && value.startsWith("$") && NAME.test(value.slice(1)))) {
      const spec = specOf(name, value);
      if (typeof spec === "string") out.push(`${where}: overrides ${spec}`);
    }
  }
}

/** A tarball on the public registry itself: its origin, with no credentials in the URL. */
function registryTarball(value: unknown): boolean {
  if (typeof value !== "string" || !value.startsWith(REGISTRY)) return false;
  try {
    const url = new URL(value);
    return url.origin === new URL(REGISTRY).origin && url.username === "" && url.password === "";
  } catch {
    return false;
  }
}

const BAD_LEGACY = /^(?:git\b|git\+|github:|gist:|bitbucket:|gitlab:|file:|link:|https?:|[^@/:]+\/[^@/:])/;

function legacyProblems(deps: unknown, trail: string, out: string[], depth = 0): void {
  if (typeof deps !== "object" || deps === null || depth > 64) return;
  for (const [name, entry] of Object.entries(deps as Record<string, unknown>)) {
    if (typeof entry !== "object" || entry === null) {
      out.push(`package-lock.json: dependencies ${trail}${name} is not an object`);
      continue;
    }
    const e = entry as Record<string, unknown>;
    for (const key of ["version", "from"] as const) {
      if (typeof e[key] === "string" && BAD_LEGACY.test(e[key] as string)) out.push(`package-lock.json: dependencies ${trail}${name} ${key} ${String(e[key])} is not from the registry`);
    }
    legacyProblems(e.dependencies, `${trail}${name} > `, out, depth + 1);
  }
}

function lockProblems(ws: WorkspaceFiles): string[] {
  const lock = ws.lock as Record<string, unknown> | undefined;
  if (lock === undefined) return ws.unreadable.includes("package-lock.json") ? [] : ["package-lock.json is required"];
  if (typeof lock !== "object" || lock === null) return ["package-lock.json: not a JSON object"];
  if ((lock.lockfileVersion !== 2 && lock.lockfileVersion !== 3) || typeof lock.packages !== "object" || lock.packages === null || Array.isArray(lock.packages)) {
    return [`package-lock.json: lockfileVersion ${String(lock.lockfileVersion)} is not supported (2 or 3 with packages)`];
  }
  const out: string[] = [];
  const packages = lock.packages as Record<string, Record<string, unknown> | null>;
  const workspaceFolders = new Set(ws.workspaces.filter((w) => !w.problem).map((w) => w.rel));
  // npm decides what to fetch by its own reading of an entry, so each rule here follows npm's
  // (arborist), not the flag's name: any truthy `link` is a link; `inBundle` is not read from a
  // v2 or v3 lock, so an entry with a `resolved` is fetched from it whatever else it says, and
  // one without is asked of the registry as name@version; `hasShrinkwrap` makes npm install the
  // package's dependencies from the URLs in the package's own shrinkwrap, which nothing here sees.
  // Every entry's own dependency specs are read too: npm builds its tree from them before it
  // compares the tree with the lock, so a git or URL spec in a transitive package reaches out.
  for (const [key, entry] of Object.entries(packages)) {
    const inModules = key.includes("node_modules/");
    const name = key === "" ? "<root>" : inModules ? key.slice(key.lastIndexOf("node_modules/") + "node_modules/".length) : key;
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
      out.push(`package-lock.json: ${name} is not an object`);
      continue;
    }
    out.push(...manifestProblems(entry, `package-lock.json: ${key || "<root>"}`));
    if (key === "") continue;
    if (entry.hasShrinkwrap) {
      out.push(`package-lock.json: ${name} carries its own shrinkwrap, which is not supported`);
      continue;
    }
    if (entry.link) {
      const target = inModules && entry.link === true && typeof entry.resolved === "string" ? path.posix.normalize(entry.resolved) : "";
      const ok = target !== "" && !target.startsWith("..") && !path.posix.isAbsolute(target) && workspaceFolders.has(target) && packages[target] !== undefined;
      if (!ok) out.push(`package-lock.json: ${name} links to ${String(entry.resolved)}, not a workspace folder in the checkout`);
      continue;
    }
    if (!inModules) {
      if (!workspaceFolders.has(key)) out.push(`package-lock.json: ${name} is not a workspace`);
      continue;
    }
    if (entry.inBundle === true && entry.resolved !== undefined) {
      // npm does not read inBundle from a v2 or v3 lock and fetches `resolved`: a bundled entry names no source.
      out.push(`package-lock.json: bundled ${name} has an explicit source (${String(entry.resolved)}), not resolved from ${REGISTRY} by its parent`);
      continue;
    }
    if (entry.resolved === undefined && entry.inBundle === true) {
      // Shipped inside its parent's tarball. Should npm fetch it after all, it asks the registry for name@version.
      const plainName = entry.name === undefined || (typeof entry.name === "string" && NAME.test(entry.name));
      if (!plainName || typeof entry.version !== "string" || parseVersion(entry.version) === null) {
        out.push(`package-lock.json: ${name} is bundled but is not a plain name and version (${String(entry.name ?? name)}@${String(entry.version)})`);
      }
      continue;
    }
    if (!registryTarball(entry.resolved) || typeof entry.integrity !== "string" || !entry.integrity) {
      out.push(`package-lock.json: ${name} is not resolved from ${REGISTRY} with an integrity hash (${String(entry.resolved)})`);
    }
  }
  legacyProblems(lock.dependencies, "", out);

  // Each declared workspace's lock record agrees with its manifest: npm reads the record.
  for (const workspace of ws.workspaces) {
    if (workspace.problem || typeof workspace.manifest !== "object" || workspace.manifest === null) continue;
    const manifest = workspace.manifest as Record<string, unknown>;
    const locked = packages[workspace.rel];
    if (!locked || manifest.version !== locked.version) out.push(`package-lock.json: ${workspace.rel} has a different locked version`);
    for (const field of DEP_FIELDS) {
      const wanted = depsOf(manifest, field);
      const actual = depsOf(locked, field);
      if ([...new Set([...Object.keys(wanted), ...Object.keys(actual)])].some((dep) => wanted[dep] !== actual[dep])) {
        out.push(`package-lock.json: ${workspace.rel} has different ${field}`);
      }
    }
  }

  // The root entry agrees with the manifest, and each locked version satisfies its range.
  const rootEntry = packages[""] ?? {};
  for (const field of DEP_FIELDS) {
    const wanted = depsOf(ws.manifest, field);
    const locked = depsOf(rootEntry, field);
    const names = new Set([...Object.keys(wanted), ...Object.keys(locked)]);
    for (const name of names) {
      if (wanted[name] !== locked[name]) {
        out.push(`package-lock.json: ${field} ${name} is ${JSON.stringify(locked[name])} in the lock and ${JSON.stringify(wanted[name])} in package.json`);
        continue;
      }
      const spec = specOf(name, wanted[name]);
      if (typeof spec === "string") continue;
      const optionalPeer = field === "peerDependencies" && (ws.manifest as { peerDependenciesMeta?: Record<string, { optional?: boolean }> }).peerDependenciesMeta?.[name]?.optional === true;
      // A link records only `link` and `resolved`: the version is on the workspace's own record.
      const dependency = packages[`node_modules/${name}`];
      const entry = dependency?.link === true && typeof dependency.resolved === "string" ? packages[path.posix.normalize(dependency.resolved)] : dependency;
      if (!entry) {
        if (!optionalPeer) out.push(`package-lock.json: ${field} ${name} has no locked version`);
        continue;
      }
      const lockedName = typeof entry.name === "string" ? entry.name : name;
      if (lockedName !== spec.name) out.push(`package-lock.json: ${name} is locked as ${lockedName}, not ${spec.name}`);
      if (typeof entry.version !== "string" || !satisfies(entry.version, spec.range)) {
        out.push(`package-lock.json: ${name} is locked at ${String(entry.version)}, outside ${spec.range}`);
      }
    }
  }
  return out;
}

/** Why the checkout cannot be installed by E4's rules; empty when it can. */
export function installProblems(ws: WorkspaceFiles): string[] {
  const out: string[] = [];
  for (const name of ws.unreadable) out.push(`${name} must be a valid JSON file inside the checkout`);
  if (ws.manifest === undefined && !ws.unreadable.includes("package.json")) out.push("package.json is required");
  else if (ws.manifest !== undefined) out.push(...manifestProblems(ws.manifest, "package.json"));
  for (const w of ws.workspaces) {
    if (w.problem) out.push(`${w.rel}: ${w.problem}`);
    else if (w.manifest !== undefined) out.push(...manifestProblems(w.manifest, `${w.rel}/package.json`));
  }
  if (ws.shrinkwrap) out.push("npm-shrinkwrap.json is not supported");
  if (ws.npmrc) out.push("a project .npmrc is not supported (private registries are not supported)");
  for (const link of ws.externalLinks) out.push(`${link} is a symlink that leaves the checkout`);
  out.push(...lockProblems(ws));
  return out;
}

// ---------------------------------------------------------------- running npm

/** npm's whole environment: the action's config only, nothing from the job. Writes the config file. */
export function installEnv(tc: Toolchain, scratch: string): Record<string, string> {
  // npm refuses one file as both user and global config, so each gets its own copy.
  const npmrc = path.join(scratch, "npmrc");
  const globalNpmrc = path.join(scratch, "npmrc-global");
  mkdirSync(path.join(scratch, "home"), { recursive: true });
  for (const file of [npmrc, globalNpmrc]) writeFileSync(file, `registry=${REGISTRY}\n`);
  return {
    PATH: `${path.join(tc.nodeDir, "bin")}:/usr/bin:/bin`,
    HOME: path.join(scratch, "home"),
    npm_config_userconfig: npmrc,
    npm_config_globalconfig: globalNpmrc,
    npm_config_registry: REGISTRY,
    npm_config_git: "/bin/false",
    npm_config_script_shell: "/bin/false",
    npm_config_ignore_scripts: "true",
    npm_config_cache: path.join(scratch, "cache"),
    npm_config_install_links: "false",
    npm_config_audit: "false",
    npm_config_fund: "false",
    npm_config_update_notifier: "false",
  };
}

/**
 * The node and npm in `nodeDir`, by real path, never in or through the workspace, at a
 * version CI pins. `nodeDir` must be setup-node's folder for a pinned version under the
 * runner's toolcache, checked before anything in it runs. Throws `install_unsupported` otherwise.
 */
export function trustedToolchain(
  nodeDir: string,
  ws: string,
  supported: readonly { node: string; npm: string }[] = SUPPORTED_TOOLCHAIN,
  toolCache = process.env.RUNNER_TOOL_CACHE,
): Toolchain {
  const fail = (why: string): never => {
    throw new InstallRefused([why]);
  };
  const root = realpathSync(ws);
  if (!toolCache) return fail("RUNNER_TOOL_CACHE is required");
  let dir: string;
  let node: string;
  let npmCli: string;
  let npmPkg: string;
  try {
    const cache = realpathSync(toolCache);
    dir = realpathSync(nodeDir);
    if (inside(cache, root) || inside(root, cache) || !supported.some(({ node: version }) => dir === path.join(cache, "node", version, process.arch))) {
      return fail("Node must come from the runner's pinned setup-node toolcache");
    }
  } catch (error) {
    if (error instanceof InstallRefused) throw error;
    return fail(`cannot resolve the runner toolcache or ${nodeDir}`);
  }
  try {
    node = realpathSync(path.join(nodeDir, "bin/node"));
    npmCli = realpathSync(path.join(nodeDir, "lib/node_modules/npm/bin/npm-cli.js"));
    npmPkg = realpathSync(path.join(nodeDir, "lib/node_modules/npm/package.json"));
  } catch {
    return fail(`no node and npm in ${nodeDir}`);
  }
  for (const [label, file] of [["node", node], ["npm", npmCli], ["npm", npmPkg], ["the toolchain", dir]] as const) {
    if (inside(file, root) || inside(root, file)) fail(`${label} must not come from the workspace (${file})`);
    if (!inside(file, dir)) fail(`${label} must sit inside ${dir} (${file})`);
  }
  const nodeVersion = execFileSync(node, ["--version"], { encoding: "utf8", env: {}, timeout: 10_000 }).trim().replace(/^v/, "");
  const npmVersion = String((JSON.parse(readFileSync(npmPkg, "utf8")) as { version?: unknown }).version);
  if (path.basename(path.dirname(dir)) !== nodeVersion) fail(`node ${nodeVersion} disagrees with its pinned toolcache directory`);
  if (!supported.some((s) => s.node === nodeVersion && s.npm === npmVersion)) fail(`npm ${npmVersion} with node ${nodeVersion} is not a supported toolchain`);
  return { nodeDir: dir, node, npmCli, nodeVersion, npmVersion };
}

async function sha256File(file: string, signal?: AbortSignal): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(file, { signal })) hash.update(chunk as Buffer);
  return hash.digest("hex");
}

/**
 * Validate, then `npm ci --ignore-scripts` with the trusted toolchain and config only, then
 * record the digests. Refuses with `install_unsupported` before npm runs.
 */
export async function preinstall(ws: string, tc: Toolchain, scratch: string, timeoutMs = INSTALL_MS, signal?: AbortSignal): Promise<InstallDigests> {
  signal?.throwIfAborted();
  const problems = installProblems(readWorkspace(ws));
  if (problems.length > 0) throw new InstallRefused(problems);
  const env = installEnv(tc, scratch);
  await new Promise<void>((resolve, reject) => {
    const child = spawn(tc.node, [tc.npmCli, "ci", "--ignore-scripts"], { cwd: ws, env, stdio: ["ignore", "pipe", "pipe"], shell: false, timeout: timeoutMs, killSignal: "SIGKILL", signal });
    for (const stream of [child.stdout!, child.stderr!]) {
      stream.setEncoding("utf8");
      let pending = "";
      stream.on("data", (chunk: string) => {
        pending += chunk;
        const lines = pending.split("\n");
        pending = lines.pop() ?? "";
        for (const line of lines) process.stderr.write(`${neutralize(line.slice(0, 4096))}\n`);
      });
    }
    let spawnError: Error | undefined;
    child.once("error", (error) => { spawnError = error; });
    child.once("close", (code, exitSignal) => {
      if (signal?.aborted) reject(signal.reason);
      else if (spawnError) reject(spawnError);
      else if (code === 0) resolve();
      else reject(new Error(`install_failed: npm ci exited ${code ?? exitSignal}`));
    });
  });
  signal?.throwIfAborted();
  return {
    lock: await sha256File(path.join(ws, "package-lock.json"), signal),
    hiddenLock: existsSync(path.join(ws, "node_modules/.package-lock.json")) ? await sha256File(path.join(ws, "node_modules/.package-lock.json"), signal) : "",
    tree: await treeDigest(ws, signal),
  };
}

/**
 * sha256 over the sorted walk of the checkout, node_modules included and `.git` excluded:
 * each entry's path, type, mode, size, and content hash or symlink target.
 */
export async function treeDigest(ws: string, signal?: AbortSignal): Promise<string> {
  signal?.throwIfAborted();
  const root = realpathSync(ws);
  const hash = createHash("sha256");
  const walk = async (dir: string, rel: string): Promise<void> => {
    const names = (await readdir(dir)).sort();
    for (const name of names) {
      signal?.throwIfAborted();
      if (rel === "" && name === ".git") continue;
      const full = path.join(dir, name);
      const relPath = rel ? `${rel}/${name}` : name;
      const st = await lstat(full);
      const mode = (st.mode & 0o7777).toString(8);
      if (st.isSymbolicLink()) hash.update(`L\0${relPath}\0${mode}\0${await readlink(full)}\n`);
      else if (st.isDirectory()) {
        hash.update(`D\0${relPath}\0${mode}\n`);
        await walk(full, relPath);
      } else if (st.isFile()) hash.update(`F\0${relPath}\0${mode}\0${st.size}\0${await sha256File(full, signal)}\n`);
      else hash.update(`O\0${relPath}\0${mode}\0${st.mode >>> 12}\n`);
    }
  };
  await walk(root, "");
  signal?.throwIfAborted();
  return hash.digest("hex");
}

const SHA = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/;
const REF = /^refs\/[A-Za-z0-9._/-]+$/;

/** HEAD, read from `.git` as files: no git binary runs, so the checkout's git config runs nothing. */
export function checkoutHead(ws: string): string {
  const git = path.join(ws, ".git");
  const head = readFileSync(path.join(git, "HEAD"), "utf8").trim();
  if (SHA.test(head)) return head;
  const m = /^ref: (\S+)$/.exec(head);
  const ref = m?.[1];
  if (!ref || !REF.test(ref) || ref.split("/").some((part) => part === ".." || part === "." || part === "")) throw new Error(`checkout_changed: HEAD is not a ref this action reads (${head.slice(0, 100)})`);
  const loose = path.join(git, ref);
  if (existsSync(loose)) {
    const sha = readFileSync(loose, "utf8").trim();
    if (SHA.test(sha)) return sha;
    throw new Error(`checkout_changed: ${ref} does not hold a commit`);
  }
  const packed = existsSync(path.join(git, "packed-refs")) ? readFileSync(path.join(git, "packed-refs"), "utf8").split("\n") : [];
  for (const line of packed) {
    const [sha, name] = line.split(" ");
    if (name === ref && sha && SHA.test(sha)) return sha;
  }
  throw new Error(`checkout_changed: ${ref} is not found`);
}
