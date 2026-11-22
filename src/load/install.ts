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
 * The load path installs offline (e5 plan v3 §2.10): `npm ci --offline` from the recipe's
 * tarball cache, which npm checks against the lockfile's integrity, in a fresh network namespace
 * with no interface up, as the runner's own user; a cache miss is refused, never fetched.
 * `preinstall` (with the registry) is `mode: check`'s only.
 *
 * Not in E4 (PQA-3580): private registries, other package managers.
 */
import { execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { closeSync, createReadStream, existsSync, lstatSync, mkdirSync, openSync, readdirSync, readFileSync, readlinkSync, readSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { lstat, readdir, readlink } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { neutralize } from "./jail/spec";

export interface ToolchainHashes {
  /** sha256 of `bin/node`. */
  nodeSha256: string;
  /** sha256 of `lib/node_modules/npm/bin/npm-cli.js`. */
  npmCliSha256: string;
}

export interface SupportedToolchain {
  node: string;
  npm: string;
  /** The files' sha256 on linux x64; with none for this host, the toolchain is refused. */
  linuxX64?: ToolchainHashes;
}

/**
 * The toolchains CI pins (`ci.yml`): node and the npm it ships with, and their files' sha256.
 *
 * Provenance of the linux x64 hashes (2026-11-22): nodejs.org's `node-v24.22.3-linux-x64.tar.xz`,
 * whose sha256 4f2b175a6d53a5c617a80dba2676238a0688cef28c6da4eba35c7d844e66fcfb matched its line
 * in https://nodejs.org/dist/v24.22.3/SHASUMS256.txt (fetched over HTTPS; the signature on
 * SHASUMS256.txt.asc was not checked), extracted, then `sha256sum bin/node` and
 * `lib/node_modules/npm/bin/npm-cli.js`. CW's gate (plan §8 step 1.2) compares them with what
 * setup-node v6 installs at `$RUNNER_TOOL_CACHE/node/24.22.3/x64` on ubuntu-24.04 and 22.04; a
 * runner whose files differ is refused `install_unsupported`, and the refusal names what it read.
 */
export const SUPPORTED_TOOLCHAIN: readonly SupportedToolchain[] = [
  {
    node: "24.22.3",
    npm: "11.19.1",
    linuxX64: {
      nodeSha256: "a7ec1b37e6ff9d187e4198c5b6df9a4eb1c74dd31804fb3bac55cc4ceca1ac01",
      npmCliSha256: "8e5f6f3429f8cdbe693cdc29904e9d5a7b127a494bd15c804bd54c7403bfcbe7",
    },
  },
];
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
  /** Another package manager's lockfile at the root (by `lstat`). */
  otherLockfiles: string[];
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

/** Lockfiles of other package managers: the install reads package-lock.json only. */
const OTHER_LOCKFILES = ["yarn.lock", "pnpm-lock.yaml", "bun.lock", "bun.lockb"] as const;

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
    otherLockfiles: OTHER_LOCKFILES.filter((name) => lstatExists(path.join(root, name))),
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

/** A package name: scoped ones lowercase; legacy unscoped ones (JSONStream) may carry capitals, as npm still serves them. */
const NAME = /^(?:@[a-z0-9][a-z0-9._~-]*\/[a-z0-9][a-z0-9._~-]*|[A-Za-z0-9][A-Za-z0-9._~-]*)$/;

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

/** Scoped names are lowercase; legacy unscoped ones (JSONStream, Base64) may carry capitals, and so may their file. */
const TARBALL_PATH = /^\/(?:@[a-z0-9][a-z0-9._~-]*\/[a-z0-9._~-]+|[A-Za-z0-9._~-]+)\/-\/[A-Za-z0-9._~-]+-[0-9A-Za-z.+_-]+\.tgz$/;

/**
 * A tarball on the public registry, in its one canonical form (CW plan §4.5): the text parses
 * as a URL whose `href` is the text itself; https, host registry.npmjs.org, no port, userinfo,
 * query or fragment; no `%` anywhere; one leading slash, then `[@scope/]name/-/file.tgz`.
 */
export function canonicalRegistryTarball(value: unknown): value is string {
  if (typeof value !== "string" || value.includes("%")) return false;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  return url.href === value && url.protocol === "https:" && url.hostname === "registry.npmjs.org" && url.port === "" &&
    url.username === "" && url.password === "" && url.search === "" && url.hash === "" && TARBALL_PATH.test(url.pathname);
}

/**
 * The sha512 an SRI string names, as `sha512-<base64>`: the base64 of exactly 64 bytes, which
 * re-encodes to the same text. Other algorithms beside it are ignored; null when there is none.
 */
export function sha512Of(integrity: unknown): string | null {
  if (typeof integrity !== "string") return null;
  for (const part of integrity.trim().split(/\s+/)) {
    if (!part.startsWith("sha512-")) continue;
    const encoded = part.slice("sha512-".length);
    if (!/^[A-Za-z0-9+/]+={0,2}$/.test(encoded)) return null;
    const bytes = Buffer.from(encoded, "base64");
    if (bytes.length !== 64 || bytes.toString("base64") !== encoded) return null;
    return part;
  }
  return null;
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
    if (!canonicalRegistryTarball(entry.resolved) || typeof entry.integrity !== "string" || !entry.integrity) {
      out.push(`package-lock.json: ${name} is not resolved from ${REGISTRY} with an integrity hash (${String(entry.resolved)})`);
    } else if (sha512Of(entry.integrity) === null) {
      out.push(`package-lock.json: ${name} has no sha512 integrity hash (re-lock with npm 7 or later)`);
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
  for (const name of ws.otherLockfiles) out.push(`${name} is not supported: load runs install from package-lock.json only`);
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
    // Offline it changes nothing; online it is one rewrite fewer of a lockfile URL.
    npm_config_replace_registry_host: "never",
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

export interface ToolchainCheck {
  /** `<platform>-<arch>` of the host whose pinned hashes apply (the running process's by default). */
  platform?: string;
  /** Told the two files' sha256, read before either runs (the job log line). */
  log?: (line: string) => void;
}

/**
 * The node and npm in `nodeDir`, by real path, never in or through the workspace, at a
 * version CI pins, with the files CI pins. `nodeDir` must be setup-node's folder for a pinned
 * version under the runner's toolcache; both files' sha256 are checked before either runs.
 * Throws `install_unsupported` otherwise.
 */
export function trustedToolchain(
  nodeDir: string,
  ws: string,
  supported: readonly SupportedToolchain[] = SUPPORTED_TOOLCHAIN,
  toolCache = process.env.RUNNER_TOOL_CACHE,
  check: ToolchainCheck = {},
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
  // The files, by real path, before anything in the folder runs: a replaced binary that prints
  // the right version is still refused.
  const entry = supported.find((s) => path.basename(path.dirname(dir)) === s.node)!;
  const platform = check.platform ?? `${process.platform}-${process.arch}`;
  const pinned = platform === "linux-x64" ? entry.linuxX64 : undefined;
  const nodeSha256 = sha256FileSync(node);
  const npmCliSha256 = sha256FileSync(npmCli);
  check.log?.(`node ${entry.node} sha256 ${nodeSha256} (pinned ${pinned?.nodeSha256 ?? "none"}); npm-cli.js sha256 ${npmCliSha256} (pinned ${pinned?.npmCliSha256 ?? "none"})`);
  if (!pinned) fail(`no pinned sha256 for node ${entry.node} on ${platform} (read node ${nodeSha256}, npm-cli.js ${npmCliSha256})`);
  if (nodeSha256 !== pinned!.nodeSha256) fail(`node's sha256 ${nodeSha256} is not the pinned ${pinned!.nodeSha256}`);
  if (npmCliSha256 !== pinned!.npmCliSha256) fail(`npm-cli.js's sha256 ${npmCliSha256} is not the pinned ${pinned!.npmCliSha256}`);
  const nodeVersion = execFileSync(node, ["--version"], { encoding: "utf8", env: {}, timeout: 10_000 }).trim().replace(/^v/, "");
  const npmVersion = String((JSON.parse(readFileSync(npmPkg, "utf8")) as { version?: unknown }).version);
  if (path.basename(path.dirname(dir)) !== nodeVersion) fail(`node ${nodeVersion} disagrees with its pinned toolcache directory`);
  if (!supported.some((s) => s.node === nodeVersion && s.npm === npmVersion)) fail(`npm ${npmVersion} with node ${nodeVersion} is not a supported toolchain`);
  return { nodeDir: dir, node, npmCli, nodeVersion, npmVersion };
}

/** sha256 of a file, read in 1 MiB pieces. */
export function sha256FileSync(file: string): string {
  const hash = createHash("sha256");
  const fd = openSync(file, "r");
  try {
    const buffer = Buffer.allocUnsafe(1 << 20);
    for (;;) {
      const n = readSync(fd, buffer, 0, buffer.length, null);
      if (n === 0) break;
      hash.update(buffer.subarray(0, n));
    }
  } finally {
    closeSync(fd);
  }
  return hash.digest("hex");
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
  await runNpm(tc.node, [tc.npmCli, "ci", "--ignore-scripts"], { cwd: ws, env }, timeoutMs, signal);
  return digestsOf(ws, signal);
}

export interface OfflineInstall {
  /** The recipe's npm cache: every tarball the lockfile names, which npm checks by integrity. */
  cache: string;
  /** The runner's user: the install drops back to it inside the namespace. */
  uid: number;
  gid: number;
}

/**
 * Runs the rest of the argv in a new network namespace (only a loopback, down) as `uid:gid`, with
 * an empty environment. `--pdeathsig`: killing sudo (a timeout, a cancel) does not reach what it
 * started, and SIGKILL is never relayed; without it npm outlives the kill, holds the output pipes
 * open and the install settles only when npm ends by itself.
 */
export function netnsPrefix(o: { uid: number; gid: number }): string[] {
  if (!Number.isSafeInteger(o.uid) || o.uid < 0 || !Number.isSafeInteger(o.gid) || o.gid < 0) throw new InstallRefused(["the runner's uid and gid must be whole numbers"]);
  return ["/usr/bin/sudo", "-n", "/usr/bin/unshare", "--net", "--", "/usr/bin/setpriv", `--reuid=${o.uid}`, `--regid=${o.gid}`, "--init-groups", "--pdeathsig", "SIGKILL", "/usr/bin/env", "-i"];
}

/** The offline install's command: the namespace prefix, npm's whole environment as arguments, then npm ci offline. */
export function offlineInstallArgv(tc: Toolchain, cache: string, scratch: string, o: { uid: number; gid: number }): { file: string; args: string[]; env: Record<string, string> } {
  const env = { ...installEnv(tc, scratch), npm_config_cache: cache, npm_config_offline: "true", npm_config_logs_dir: path.join(scratch, "logs") };
  const [file, ...prefix] = netnsPrefix(o);
  const vars = Object.entries(env).map(([k, v]) => `${k}=${v}`);
  return { file: file!, args: [...prefix, ...vars, tc.node, tc.npmCli, "ci", "--offline", "--ignore-scripts", "--no-audit", "--no-fund", "--cache", cache], env };
}

type CacheReadStream = AsyncIterable<Buffer> & { destroy(error?: Error): void };

/** Verify all locked registry tarballs, even ones npm might omit (optional or platform-specific). */
async function verifyRecipeCache(cache: string, tc: Toolchain, lock: unknown, signal?: AbortSignal): Promise<void> {
  // installProblems has checked the lock. Use the same cache reader as the pinned npm CLI.
  const { packages } = lock as { packages: Record<string, Record<string, unknown>> };
  const checked = new Set<string>();
  const cacheDir = path.join(cache, "_cacache");
  const requireFromNpm = createRequire(tc.npmCli);
  for (const [name, entry] of Object.entries(packages)) {
    if (!canonicalRegistryTarball(entry.resolved) || typeof entry.integrity !== "string" || checked.has(entry.integrity)) continue;
    signal?.throwIfAborted();
    const cacache = requireFromNpm("cacache") as {
      get: { stream: { byDigest(cacheDir: string, integrity: string): CacheReadStream } };
    };
    const stream = cacache.get.stream.byDigest(cacheDir, entry.integrity);
    const abort = () => stream.destroy(new Error("cache verification cancelled"));
    signal?.addEventListener("abort", abort, { once: true });
    try {
      for await (const _chunk of stream) signal?.throwIfAborted();
      signal?.throwIfAborted();
      checked.add(entry.integrity);
    } catch {
      signal?.throwIfAborted();
      throw new Error(`install_failed: cached tarball missing or corrupt for ${name}`);
    } finally {
      signal?.removeEventListener("abort", abort);
    }
  }
}

/**
 * The load path's pre-claim install: validated as `preinstall` is, then `npm ci --offline` from
 * the recipe cache with no network interface. A cache miss fails `install_failed`; nothing is
 * fetched. Refuses with `install_unsupported` before npm runs.
 */
export async function offlinePreinstall(ws: string, tc: Toolchain, scratch: string, o: OfflineInstall, timeoutMs = INSTALL_MS, signal?: AbortSignal): Promise<InstallDigests> {
  signal?.throwIfAborted();
  let cache: string;
  try {
    cache = realpathSync(o.cache);
    if (!statSync(cache).isDirectory()) throw new Error("not a directory");
  } catch {
    throw new InstallRefused(["the recipe's npm cache is missing"]);
  }
  const workspace = readWorkspace(ws);
  const problems = installProblems(workspace);
  if (problems.length > 0) throw new InstallRefused(problems);
  await verifyRecipeCache(cache, tc, workspace.lock, signal);
  signal?.throwIfAborted();
  const { file, args } = offlineInstallArgv(tc, cache, scratch, o);
  await runNpm(file, args, { cwd: ws, env: { PATH: "/usr/bin:/bin" } }, timeoutMs, signal);
  return digestsOf(ws, signal);
}

async function digestsOf(ws: string, signal?: AbortSignal): Promise<InstallDigests> {
  signal?.throwIfAborted();
  return {
    lock: await sha256File(path.join(ws, "package-lock.json"), signal),
    hiddenLock: existsSync(path.join(ws, "node_modules/.package-lock.json")) ? await sha256File(path.join(ws, "node_modules/.package-lock.json"), signal) : "",
    tree: await treeDigest(ws, signal),
  };
}

/** Runs npm (or its wrapper), its output neutralized onto stderr; rejects `install_failed` on a non-zero exit. */
function runNpm(file: string, args: string[], o: { cwd: string; env: Record<string, string> }, timeoutMs: number, signal?: AbortSignal): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const child = spawn(file, args, { cwd: o.cwd, env: o.env, stdio: ["ignore", "pipe", "pipe"], shell: false, timeout: timeoutMs, killSignal: "SIGKILL", signal });
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
