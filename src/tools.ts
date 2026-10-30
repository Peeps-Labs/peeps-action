/**
 * The tools an `agent`-mode job offers to a Peeps agent, executed on the
 * customer's runner.
 *
 * ## What this is, stated honestly
 *
 * A Peeps agent chooses which of these to call and with what arguments. The
 * tools compose: `write_file` (or `apply_patch`) can change a file, and
 * `run_tests` then runs `npx playwright test`, which LOADS the customer's
 * Playwright config as Node code. So an agent that can write a config and then
 * run tests can execute code on the runner with the job's full environment.
 *
 * The limits below are therefore a guardrail against accident and mistake, NOT
 * a sandbox that contains a hostile or compromised Peeps. Anyone deciding
 * whether to install this should read it that way, and `SECURITY.md` says so
 * in those words. Do not re-describe these as a security boundary.
 *
 * What the limits do buy:
 *  - Paths are resolved inside the workspace; `..` and absolute paths are
 *    refused, as are `.git`, `node_modules` and `.env*`. Writes additionally
 *    refuse `.github/workflows`, because Peeps promises never to touch
 *    workflow files and both write paths must honour that equally.
 *  - Tool results are passed through `redact`, which masks values present in
 *    the job's environment. That covers the common accident of a test printing
 *    a secret. It cannot mask a secret this process never sees in its own
 *    environment, so it is a mitigation, not a guarantee.
 *
 * What leaves the runner from here: the tool results, which include file
 * contents, diffs, and test output. `run_tests` also runs the customer's
 * browser tests, and `git_commit_push` pushes a `peeps/*` branch to the
 * customer's own repository. Nothing else opens a network connection.
 */

import { execFile, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, mkdir, mkdtemp, open, readdir, readFile, realpath, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import type { RunnerEnv } from "./env";
import { resolveFramework } from "./pytest";
import { RUN_TESTS_HOOK, runPytestTool } from "./pytest-run-tool";

const execFileAsync = promisify(execFile);

export interface ToolSpec {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export type ToolHandler = (args: Record<string, unknown>) => Promise<unknown>;

export interface ToolServer {
  specs: ToolSpec[];
  handlers: Record<string, ToolHandler>;
}

const MAX_FILE_BYTES = 512 * 1024;
const MAX_LIST = 2000;
const MAX_GREP_MATCHES = 500;
const MAX_PATTERN_CHARS = 500;
const DENY_SEGMENTS = new Set([".git", "node_modules"]);

/** A refusal the agent sees as the tool's error: a clear message, nothing raw. */
export class ToolError extends Error {}

function str(args: Record<string, unknown>, key: string, required = true): string {
  const v = args[key];
  if (typeof v === "string" && v.length > 0) return v;
  if (!required) return "";
  throw new ToolError(`argument "${key}" must be a non-empty string`);
}

/** Resolve a repo-relative path inside the workspace; refuse anything else. */
export function jail(workspace: string, relative: string): string {
  const cleaned = relative.replace(/\\/g, "/").replace(/^\/+/, "");
  const abs = path.resolve(workspace, cleaned);
  const rel = path.relative(workspace, abs);
  if (rel.startsWith("..") || path.isAbsolute(rel)) {
    throw new ToolError(`path escapes the workspace: ${relative}`);
  }
  for (const seg of rel.split(path.sep)) {
    if (DENY_SEGMENTS.has(seg)) throw new ToolError(`path is off limits: ${relative}`);
    if (/^\.env(\..*)?$/.test(seg)) throw new ToolError(`path is off limits: ${relative}`);
  }
  return abs;
}

/**
 * `jail`, plus the paths nothing here may WRITE even though reading them is
 * fine and often useful.
 *
 * Workflow files are the case that matters: Peeps' whole promise is that it
 * never edits them, and a workflow it could rewrite is also the easiest way to
 * turn a file write into arbitrary execution on the next push. Reading them
 * stays allowed, because an agent reasoning about a failure may legitimately
 * need to see how the job is configured.
 */
export function jailForWrite(workspace: string, relative: string): string {
  const abs = jail(workspace, relative);
  const rel = path.relative(workspace, abs).split(path.sep).join("/");
  if (isCiConfiguration(rel)) {
    throw new ToolError(`workflow files are not writable by Peeps: ${relative}`);
  }
  // The customer's own hooks (`.peeps/run-tests` runs a heal's verification):
  // a heal that could rewrite them could change what verifies it.
  const folded = rel.toLowerCase();
  if (folded === ".peeps" || folded.startsWith(".peeps/")) {
    throw new ToolError(`.peeps/ holds your own hooks and is not writable by Peeps: ${relative}`);
  }
  return abs;
}

/**
 * GitHub's workflows, and GitLab's CI configuration: `.gitlab-ci.yml`, any
 * file named like one, and the `.gitlab/` directory where included
 * configuration conventionally lives. The project can point GitLab at
 * another path; `PEEPS_CI_CONFIG_PATH` names it so it is refused too.
 */
function isCiConfiguration(rel: string): boolean {
  if (rel === ".github/workflows" || rel.startsWith(".github/workflows/")) return true;
  if (rel === ".gitlab" || rel.startsWith(".gitlab/")) return true;
  const base = rel.split("/").pop() ?? "";
  if (base === ".gitlab-ci.yml" || base.endsWith(".gitlab-ci.yml")) return true;
  const configured = process.env.PEEPS_CI_CONFIG_PATH?.replace(/^\.?\/+/, "");
  return !!configured && rel === configured;
}

/**
 * The remote to push a `peeps/*` branch to, with Peeps' token in it in
 * place of whatever credentials the checkout used. GitHub takes an
 * installation token as `x-access-token`; GitLab takes an access token as
 * `oauth2`. The host and path stay the checkout's own.
 */
export function authenticatedPushUrl(
  remote: string,
  token: string,
  platform: "github" | "gitlab",
): string {
  const match = /^https:\/\/(?:[^@/]+@)?(.+)$/.exec(remote.trim());
  if (!match) throw new ToolError("the checkout's origin is not an https remote");
  const user = platform === "gitlab" ? "oauth2" : "x-access-token";
  return `https://${user}:${token}@${match[1]}`;
}

/** Any credentials in an https URL, masked: for git's error output. */
export function maskUrlCredentials(text: string): string {
  return text.replace(/https:\/\/[^@\s/]+@/g, "https://***@");
}

/**
 * Create the missing parent directories of `abs` (already jailed), refusing if
 * the nearest EXISTING ancestor resolves outside the workspace.
 *
 * `jail` is lexical, so a directory inside the checkout that is a symlink to
 * somewhere else would let a recursive mkdir create directories outside the
 * workspace. Resolving the deepest ancestor that exists and checking it against
 * the resolved workspace closes that: every directory mkdir then creates is a
 * real new directory beneath a checked one.
 *
 * Without this, `write_file` on a spec in a new directory (e2e/auth/x.spec.ts)
 * failed with ENOENT although its description promises "Creates the file if
 * missing", and generation gave up (PQA-1838).
 */
export async function ensureParentDirInside(workspace: string, abs: string): Promise<void> {
  const parent = path.dirname(abs);
  let existing = parent;
  for (;;) {
    try {
      await stat(existing);
      break;
    } catch {
      const up = path.dirname(existing);
      if (up === existing) break;
      existing = up;
    }
  }
  const [realWorkspace, realExisting] = await Promise.all([realpath(workspace), realpath(existing)]);
  const rel = path.relative(realWorkspace, realExisting);
  if (rel.startsWith("..") || path.isAbsolute(rel)) {
    throw new ToolError(`path escapes the workspace: ${path.relative(workspace, abs)}`);
  }
  if (existing !== parent) await mkdir(parent, { recursive: true });
}

/**
 * The repo-relative paths a patch touches, according to git's own diff parser.
 *
 * `git apply --numstat` prints `added<TAB>deleted<TAB>path` per file and
 * applies nothing, so this agrees with what a later `git apply` would really
 * touch instead of re-implementing diff parsing here.
 *
 * Two shapes need care. A rename prints `old => new`, possibly with the common
 * prefix and suffix factored out as `dir/{a => b}/file`, and both sides have to
 * be checked. A path with unusual bytes is printed in C-style double quotes;
 * rather than risk mis-decoding a path this is about to security-check, that is
 * refused outright.
 */
export async function patchPaths(
  runGit: (args: string[]) => Promise<{ stdout: string }>,
  patchFile: string,
): Promise<string[]> {
  let stdout: string;
  try {
    ({ stdout } = await runGit(["apply", "--numstat", patchFile]));
  } catch (error) {
    const e = error as { stderr?: string; message: string };
    throw new ToolError(`patch is not a valid diff: ${(e.stderr ?? e.message).slice(0, 500)}`);
  }
  const paths: string[] = [];
  for (const line of stdout.split("\n")) {
    if (!line.trim()) continue;
    // Only the first two tabs are field separators; a path may contain tabs.
    const field = line.split("\t").slice(2).join("\t");
    if (!field) continue;
    if (field.startsWith('"')) {
      throw new ToolError("patch touches a path this tool will not parse");
    }
    paths.push(...renameSides(field));
  }
  return paths;
}

/** Both sides of a numstat rename field; a single path otherwise. */
function renameSides(field: string): string[] {
  if (!field.includes(" => ")) return [field];
  const brace = /^(.*)\{(.*) => (.*)\}(.*)$/.exec(field);
  if (brace) {
    const [, pre = "", oldMid = "", newMid = "", post = ""] = brace;
    // A side can be empty (`dir/{ => sub}/f`), which would leave `dir//f`.
    return [`${pre}${oldMid}${post}`, `${pre}${newMid}${post}`].map((p) =>
      p.replace(/\/{2,}/g, "/"),
    );
  }
  const [oldPath = "", newPath = ""] = field.split(" => ");
  return [oldPath, newPath];
}

/**
 * One changed file in `git_status`'s `files`.
 *
 * `kind` says what is in the working tree at `path` now: a regular `file`,
 * nothing (`deleted`), a `symlink`, something `other` (a directory, e.g. a
 * nested repository), or a path the tools may not touch (`off_limits`, e.g.
 * `.env.local`: listed so the change is visible, never hashed).
 *
 * No symlink is followed, as the last component or as a leading directory: it
 * can point anywhere on the runner, and git does not look through one either.
 * A path under a symlinked directory is `symlink`, or `off_limits` when that
 * directory leads out of the workspace.
 *
 * `sha256` is the lowercase hex sha256 of a `file`'s bytes, and null for every
 * other kind. A `file` can also have a null `sha256`, with `reason` saying why
 * (unreadable, over the size cap, past the time budget). `from` is a rename's
 * or copy's source.
 */
export interface ChangedFile {
  path: string;
  /** git's porcelain XY code, e.g. `??`, ` M`, `D `, `R `. */
  status: string;
  kind: "file" | "deleted" | "symlink" | "other" | "off_limits";
  sha256: string | null;
  from?: string;
  reason?: string;
}

type RunGit = (
  args: string[],
  options?: { maxBuffer?: number; timeout?: number },
) => Promise<{ stdout: string }>;

/** Larger files are listed but not hashed. The agent's own writes are capped at 512 KB. */
const MAX_HASH_BYTES = 5 * 1024 * 1024;
/** Peeps gives `git_status` 60 s; the digests get a third of it. */
const DIGEST_BUDGET_MS = 20_000;

/**
 * Every changed file, one entry per file, for Peeps to check the writes it
 * made against what is really in the tree (and to refuse a change it cannot
 * account for, such as a file a test run rewrote).
 *
 * `-z` so paths arrive unquoted and exact, and `--untracked-files=all` so a
 * new directory is listed file by file rather than collapsed to `dir/`.
 *
 * Throws only when the listing itself fails (too big for its buffer, or too
 * slow); `git_status` then leaves `files` out. Each file's digest is best
 * effort.
 */
export async function changedFilesWithDigests(
  workspace: string,
  runGit: RunGit,
  limits: { maxHashBytes?: number; budgetMs?: number } = {},
): Promise<{ files: ChangedFile[]; truncated: boolean }> {
  const started = Date.now();
  const { stdout } = await runGit(
    ["status", "--porcelain=v1", "-z", "--untracked-files=all"],
    { maxBuffer: 8 * 1024 * 1024, timeout: DIGEST_BUDGET_MS },
  );
  const fields = stdout.split("\0");
  const files: ChangedFile[] = [];
  let truncated = false;
  const realWorkspace = await realpath(workspace);
  const hashing = {
    maxBytes: limits.maxHashBytes ?? MAX_HASH_BYTES,
    outOfTime: () => Date.now() - started >= (limits.budgetMs ?? DIGEST_BUDGET_MS),
  };
  for (let i = 0; i < fields.length; i++) {
    const field = fields[i]!;
    if (field.length < 4) continue;
    if (files.length >= MAX_LIST) {
      truncated = true;
      break;
    }
    const status = field.slice(0, 2);
    const entry: ChangedFile = { path: field.slice(3), status, kind: "other", sha256: null };
    // A rename or copy is followed by its source, as its own field.
    if (status.includes("R") || status.includes("C")) entry.from = fields[++i];
    Object.assign(entry, await digestOf(workspace, realWorkspace, entry.path, hashing));
    files.push(entry);
  }
  return { files, truncated };
}

function errorCode(error: unknown): string {
  return (error as { code?: string }).code ?? String(error).slice(0, 100);
}

async function digestOf(
  workspace: string,
  realWorkspace: string,
  relative: string,
  hashing: { maxBytes: number; outOfTime: () => boolean },
): Promise<Pick<ChangedFile, "kind" | "sha256" | "reason">> {
  let abs: string;
  try {
    abs = jail(workspace, relative);
  } catch {
    return { kind: "off_limits", sha256: null };
  }
  // `jail` is lexical and `lstat` follows symlinks in the leading
  // directories, so resolve the parent and require it to be exactly where the
  // path says: otherwise a directory replaced by a symlink would have a file
  // outside the workspace hashed under this path.
  const parent = path.dirname(abs);
  let realParent: string;
  try {
    realParent = await realpath(parent);
  } catch (error) {
    const code = errorCode(error);
    if (code === "ENOENT" || code === "ENOTDIR") return { kind: "deleted", sha256: null };
    return { kind: "other", sha256: null, reason: `parent unreadable: ${code}` };
  }
  const resolved = path.relative(realWorkspace, realParent);
  if (resolved !== path.relative(workspace, parent)) {
    return resolved.startsWith("..") || path.isAbsolute(resolved)
      ? { kind: "off_limits", sha256: null, reason: "under a symlinked directory that leads out of the workspace" }
      : { kind: "symlink", sha256: null, reason: "under a symlinked directory" };
  }
  let info;
  try {
    info = await lstat(abs);
  } catch (error) {
    const code = errorCode(error);
    if (code === "ENOENT") return { kind: "deleted", sha256: null };
    return { kind: "other", sha256: null, reason: `unreadable: ${code}` };
  }
  if (info.isSymbolicLink()) return { kind: "symlink", sha256: null };
  if (!info.isFile()) return { kind: "other", sha256: null };
  if (info.size > hashing.maxBytes) {
    return { kind: "file", sha256: null, reason: `larger than ${hashing.maxBytes} bytes` };
  }
  if (hashing.outOfTime()) return { kind: "file", sha256: null, reason: "time budget for digests spent" };
  try {
    const hash = createHash("sha256");
    for await (const chunk of createReadStream(abs)) hash.update(chunk as Buffer);
    return { kind: "file", sha256: hash.digest("hex") };
  } catch (error) {
    return { kind: "file", sha256: null, reason: `unreadable: ${errorCode(error)}` };
  }
}

const MAX_COMMIT_PATHS = 200;

/**
 * `git_commit_push`'s `paths`, checked and normalized to repo-relative form.
 *
 * Each goes through the same jail as a write (no `..`, absolute paths, `.git`,
 * `node_modules`, `.env*` or CI configuration), and no symlink: neither the
 * path itself nor any directory above it, since committing through one would
 * commit something other than the file the path names. A directory is
 * refused too: `git add` would take everything under it. Any bad path
 * refuses the whole call.
 */
export async function commitPaths(workspace: string, value: unknown): Promise<string[]> {
  if (
    !Array.isArray(value) ||
    value.length < 1 ||
    value.length > MAX_COMMIT_PATHS ||
    !value.every((p) => typeof p === "string" && p.length > 0)
  ) {
    throw new ToolError(`argument "paths" must be an array of 1 to ${MAX_COMMIT_PATHS} non-empty strings`);
  }
  const realWorkspace = await realpath(workspace);
  const out = new Set<string>();
  for (const relative of value as string[]) {
    // `jail` re-roots a leading slash; here an absolute path is a caller bug
    // to refuse, not a path to guess at.
    if (path.isAbsolute(relative) || /^[\\/]/.test(relative) || /^[A-Za-z]:/.test(relative)) {
      throw new ToolError(`path must be repo-relative, not absolute: ${relative}`);
    }
    const abs = jailForWrite(workspace, relative);
    const info = await lstat(abs).catch(() => null);
    if (info?.isSymbolicLink()) throw new ToolError(`path is a symlink: ${relative}`);
    if (info?.isDirectory()) throw new ToolError(`path is a directory, not a file: ${relative}`);
    // The path itself if it exists, else the deepest directory above it that
    // does, must resolve to exactly where the path says. Otherwise a symlinked
    // directory is in the way, or (on a case-insensitive filesystem) the path
    // names an existing file in another case.
    let existing = info ? abs : path.dirname(abs);
    for (;;) {
      const found = await lstat(existing).then(() => true, () => false);
      if (found || path.dirname(existing) === existing) break;
      existing = path.dirname(existing);
    }
    const real = await realpath(existing).catch(() => null);
    if (real === null || path.relative(realWorkspace, real) !== path.relative(workspace, existing)) {
      throw new ToolError(
        `path does not resolve to itself (it is under a symlinked directory, or differs in case): ${relative}`,
      );
    }
    out.add(path.relative(workspace, abs).split(path.sep).join("/"));
  }
  return [...out];
}

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

export function createToolServer(env: RunnerEnv): ToolServer {
  const workspace = env.workspace;
  const redact = makeRedactor(process.env);

  /**
   * Every git call here goes through this, so each one carries
   * `-c safe.directory=<workspace>`.
   *
   * Inside the Playwright container the checkout is owned by another uid and
   * git refuses to touch it ("dubious ownership") until the path is trusted.
   * This used to be a fire-and-forget `git config --global --add`, which had
   * two problems: it was not awaited, so the first tool call could race ahead
   * of it and fail; and on a self-hosted runner `--global` appends to
   * `~/.gitconfig`, which outlives the job and gained one duplicate line per
   * Peeps run forever. A per-invocation `-c` trusts exactly this path for
   * exactly this process.
   */
  const runGit = (args: string[], options: { maxBuffer?: number; timeout?: number } = {}) =>
    execFileAsync("git", ["-c", `safe.directory=${workspace}`, ...args], {
      cwd: workspace,
      ...options,
    });

  // The commit under test, read before any tool can move HEAD:
  // `git_commit_push` commits before it pushes (and keeps the commit when the
  // push fails), so HEAD alone would let a heal's own commit vouch for a
  // `.peeps/run-tests` it rewrote.
  const commitUnderTest: Promise<string | null> = runGit(["rev-parse", "HEAD"]).then(
    (r) => r.stdout.trim() || null,
    () => null,
  );

  const handlers: Record<string, ToolHandler> = {
    async read_file(args) {
      const abs = jail(workspace, str(args, "path"));
      const info = await stat(abs);
      if (!info.isFile()) throw new ToolError("not a file");
      if (info.size > MAX_FILE_BYTES) throw new ToolError(`file is ${info.size} bytes; limit ${MAX_FILE_BYTES}`);
      return { path: str(args, "path"), content: redact(await readFile(abs, "utf8")) };
    },

    async list_files(args) {
      const dir = jail(workspace, str(args, "path", false) || ".");
      const out: string[] = [];
      const walk = async (d: string, rel: string, depth: number) => {
        if (out.length >= MAX_LIST || depth > 12) return;
        let entries;
        try {
          entries = await readdir(d, { withFileTypes: true });
        } catch {
          return;
        }
        for (const e of entries) {
          if (DENY_SEGMENTS.has(e.name) || e.name.startsWith(".env")) continue;
          const r = rel ? `${rel}/${e.name}` : e.name;
          if (e.isDirectory()) await walk(path.join(d, e.name), r, depth + 1);
          else if (e.isFile()) {
            out.push(r);
            if (out.length >= MAX_LIST) return;
          }
        }
      };
      await walk(dir, str(args, "path", false).replace(/^\.\/?$/, ""), 0);
      return { files: out.sort(), truncated: out.length >= MAX_LIST };
    },

    async grep(args) {
      const source = str(args, "pattern");
      // A pattern from the network, tested line by line across up to MAX_LIST
      // files: an unbounded one can backtrack catastrophically and burn the
      // job's whole timeout. A length cap is not a real defence against that,
      // but it keeps an accident from costing an hour of the customer's CI.
      if (source.length > MAX_PATTERN_CHARS) {
        throw new ToolError(`pattern is longer than ${MAX_PATTERN_CHARS} characters`);
      }
      let pattern: RegExp;
      try {
        pattern = new RegExp(source, args.ignoreCase ? "i" : "");
      } catch (error) {
        throw new ToolError(`pattern is not a valid regular expression: ${String(error).slice(0, 200)}`);
      }
      const matches: Array<{ path: string; line: number; text: string }> = [];
      const listed = (await handlers.list_files!({ path: str(args, "path", false) || "." })) as { files: string[] };
      for (const rel of listed.files) {
        if (matches.length >= MAX_GREP_MATCHES) break;
        if (!/\.(ts|tsx|js|jsx|mjs|cjs|json|md|yml|yaml)$/.test(rel)) continue;
        let text: string;
        try {
          // Jailed rather than joined: `rel` comes from `list_files`, which
          // jails, but re-deriving an absolute path outside the jail is how
          // this becomes a traversal bug on some later edit.
          text = await readFile(jail(workspace, rel), "utf8");
        } catch {
          continue;
        }
        const lines = text.split("\n");
        for (let i = 0; i < lines.length && matches.length < MAX_GREP_MATCHES; i++) {
          if (pattern.test(lines[i]!)) matches.push({ path: rel, line: i + 1, text: redact(lines[i]!.slice(0, 300)) });
        }
      }
      return { matches, truncated: matches.length >= MAX_GREP_MATCHES };
    },

    async write_file(args) {
      const rel = str(args, "path");
      const abs = jailForWrite(workspace, rel);
      const content = str(args, "content");
      if (content.length > MAX_FILE_BYTES) throw new ToolError("content too large");
      await ensureParentDirInside(workspace, abs);
      await writeFile(abs, content, "utf8");
      return { path: rel, bytes: Buffer.byteLength(content) };
    },

    async apply_patch(args) {
      // A unified diff applied with git so hunks, renames and new files all work.
      const patch = str(args, "patch");
      const dir = await mkdtemp(path.join(tmpdir(), "peeps-patch-"));
      const file = path.join(dir, "change.patch");
      await writeFile(file, patch, "utf8");
      // Jail every path the patch touches, the same way `write_file` jails its
      // one path. Without this, `apply_patch` was the hole in the deny-list:
      // git refuses `..` and `.git` on its own, but `.env`, `.env.local` and
      // `.github/workflows/*` were all writable through a diff while an
      // identical `write_file` was refused. `--numstat` makes git itself parse
      // the diff, so this agrees with what apply would actually do.
      for (const touched of await patchPaths(runGit, file)) {
        jailForWrite(workspace, touched);
      }
      try {
        await runGit(["apply", "--whitespace=nowarn", file]);
      } catch (error) {
        const e = error as { stderr?: string; message: string };
        // Redacted: `git apply` echoes patch context, which is file content.
        throw new ToolError(`git apply failed: ${redact((e.stderr ?? e.message).slice(0, 2000))}`);
      }
      const { stdout } = await runGit(["status", "--porcelain"]);
      return {
        applied: true,
        changedFiles: stdout.trim().split("\n").filter(Boolean).map(redact),
      };
    },

    async run_tests(args) {
      const file = str(args, "file");
      if (resolveFramework(env) === "pytest") {
        const ran = await runPytestTool(env, {
          fileAbs: jail(workspace, file),
          titlePath: typeof args.test === "string" && args.test ? args.test : null,
          keyword: typeof args.grep === "string" && args.grep ? args.grep : null,
          browser: typeof args.project === "string" && args.project ? args.project : null,
          hook: async (scratchDir) => {
            const sha = await commitUnderTest;
            if (!sha) return { kind: "none" };
            const listed = await runGit(["ls-tree", sha, "--", RUN_TESTS_HOOK]);
            if (!listed.stdout.startsWith("100755 blob ")) return { kind: "none" };
            // The agent's writes are refused under .peeps/; this catches one
            // that reached it another way (through a symlink, say), since a
            // hook may read its own files from the checkout.
            try {
              await runGit(["diff", "--quiet", sha, "--", ".peeps"]);
              const untracked = await runGit(["ls-files", "--others", "--", ".peeps"]);
              if (untracked.stdout.trim() !== "") return { kind: "changed" };
            } catch {
              return { kind: "changed" };
            }
            // What runs is a copy out of the commit, so nothing written to the
            // checkout after that check reaches it.
            const archive = path.join(scratchDir, "peeps.tar");
            const copy = path.join(scratchDir, "hook");
            await mkdir(copy);
            await runGit(["archive", "--format=tar", "-o", archive, sha, ".peeps"]);
            await execFileAsync("tar", ["-xf", archive, "-C", copy]);
            return { kind: "ready", path: path.join(copy, RUN_TESTS_HOOK) };
          },
        });
        return {
          ...ran,
          // Redacted whole, then cut, so no secret is split past the redactor.
          pendingNote: ran.pendingNote === null ? null : redact(ran.pendingNote).slice(0, 500),
          results: ran.results?.map((r) => ({ ...r, title: redact(r.title), ...(r.error ? { error: redact(r.error) } : {}) })) ?? null,
          outputTail: redact(ran.outputTail),
        };
      }
      // `file` arrives repo-relative and is jailed against the workspace, but
      // Playwright runs with `workingDirectory` as its cwd. In any monorepo
      // those differ, and passing the repo-relative path straight through made
      // Playwright resolve nothing, run zero tests, and report "no tests
      // found" — a confusing success. Re-express it relative to the cwd.
      const abs = jail(workspace, file);
      const rel = path.relative(env.workingDirectory, abs).split(path.sep).join("/");
      const cmd = ["playwright", "test", "--reporter=json"];
      if (typeof args.grep === "string" && args.grep) cmd.push("--grep", args.grep);
      if (typeof args.project === "string" && args.project) cmd.push("--project", args.project);
      if (env.configPath) cmd.push("--config", env.configPath);
      // `--` last, so a path that begins with a dash is a file argument and not
      // an option Playwright would honour.
      cmd.push("--", rel);
      const started = Date.now();
      const { code, stdout, stderr } = await runCapture("npx", cmd, env.workingDirectory, 10 * 60 * 1000);
      let report: unknown = null;
      try {
        report = JSON.parse(stdout);
      } catch {
        // Not JSON: Playwright failed before running (config error, syntax error).
      }
      return {
        exitCode: code,
        durationMs: Date.now() - started,
        results: await withEvidence(summarizeReport(report), report, env, redact),
        stderr: redact(stderr.slice(-8000)),
        stdoutTail: report ? undefined : redact(stdout.slice(-4000)),
      };
    },

    async git_status() {
      const { stdout } = await runGit(["status", "--porcelain"]);
      // Redacted like every other result: a path can carry a secret (a branch
      // or fixture named after one), and `git_diff` next door already did this.
      // As before, for every Peeps server that reads only this.
      const changedFiles = stdout.trim().split("\n").filter(Boolean).map(redact);
      // `files` is additive and must never cost a caller `changedFiles`: when
      // the listing fails, it is left out and the failure said.
      let digests;
      try {
        digests = await changedFilesWithDigests(workspace, runGit);
      } catch (error) {
        const e = error as { message?: string };
        return { changedFiles, filesTruncated: true, filesError: redact(String(e.message ?? error).slice(0, 300)) };
      }
      return {
        changedFiles,
        files: digests.files.map((f) => ({
          ...f,
          path: redact(f.path),
          ...(f.from === undefined ? {} : { from: redact(f.from) }),
        })),
        filesTruncated: digests.truncated,
      };
    },

    async git_diff() {
      const { stdout } = await runGit(["diff"], { maxBuffer: 8 * 1024 * 1024 });
      return { diff: redact(stdout.slice(0, MAX_FILE_BYTES)) };
    },

    async git_commit_push(args) {
      const branch = str(args, "branch");
      const message = str(args, "message");
      const token = str(args, "token");
      if (!branch.startsWith("peeps/")) throw new ToolError("branch must start with peeps/");
      // HEAD is read before this commit can move it (see `commitUnderTest`).
      await commitUnderTest;
      // Checked in full before anything is touched: one bad path refuses the
      // call. They pass `jailForWrite`, so `.peeps/` (the customer's own
      // hooks, which verify a heal) can never be listed.
      const paths = args.paths === undefined ? null : await commitPaths(workspace, args.paths);
      const remote = await runGit(["remote", "get-url", "origin"]);
      const url = authenticatedPushUrl(remote.stdout, token, env.platform);
      // Via `runGit`, so these carry `-c safe.directory` like every other git
      // call: inside the Playwright container the checkout is owned by another
      // uid and git refuses to touch it without that.
      const git = (...a: string[]) => runGit(a);
      // Literal pathspecs everywhere a listed path is passed: a `*` is a
      // character, not a pattern, and `:(…)` is not magic.
      const lit = (...a: string[]) => runGit(["--literal-pathspecs", ...a], { maxBuffer: 8 * 1024 * 1024 });
      /** git's own words only, never the command line (it holds the workspace path). */
      const gitSaid = (error: unknown) => {
        const e = error as { stderr?: string; stdout?: string };
        return redact(maskUrlCredentials(`${e.stderr ?? ""}${e.stdout ?? ""}`.trim())).slice(-500);
      };

      let skippedPaths: string[] = [];
      let stage: string[] = [];
      // What `git add` is given: paths in the tree or the index. A deletion
      // already staged is in neither (git add would refuse it as unmatched),
      // yet `commit --only` still commits it, matching it against HEAD.
      let add: string[] = [];
      if (paths !== null) {
        try {
          // Tracked = in the index OR in HEAD, so a deletion already staged
          // (gone from both the tree and the index) still counts.
          const tracked = new Set(
            (await lit("ls-files", "-z", "--with-tree=HEAD", "--", ...paths)).stdout.split("\0").filter(Boolean),
          );
          const present = await Promise.all(
            paths.map((p) => lstat(path.join(workspace, p)).then(() => true, () => false)),
          );
          const indexed = new Set(
            (await lit("ls-files", "-z", "--", ...paths)).stdout.split("\0").filter(Boolean),
          );
          stage = paths.filter((p, i) => present[i] || tracked.has(p));
          add = paths.filter((p, i) => present[i] || indexed.has(p));
          // A listed path with nothing to stage: one the heal wrote and then
          // removed. Dropped, and named, so a caller can tell it from a change.
          skippedPaths = paths.filter((p) => !stage.includes(p));
          if (stage.length > 0) {
            const ignored = (await lit("ls-files", "-z", "--others", "--ignored", "--exclude-standard", "--", ...stage))
              .stdout.split("\0").filter(Boolean);
            if (ignored.length > 0) {
              throw new ToolError(`path is not committed because it is ignored by .gitignore: ${ignored.slice(0, 10).map(redact).join(", ")}`);
            }
          }
        } catch (error) {
          if (error instanceof ToolError) throw error;
          throw new ToolError(`could not read the listed paths' state: ${gitSaid(error)}`);
        }
        if (stage.length === 0) {
          throw new ToolError(`nothing to commit? none of the listed paths exists or is tracked: ${skippedPaths.slice(0, 10).map(redact).join(", ")}`);
        }
      }

      await git("config", "user.name", "peeps[bot]");
      await git(
        "config",
        "user.email",
        env.platform === "gitlab" ? "peeps-bot@noreply.peepsai.com" : "peeps[bot]@users.noreply.github.com",
      );
      await git("checkout", "-B", branch);
      let commit;
      if (paths === null) {
        await git("add", "-A");
        commit = await git("commit", "-m", message).catch((e: { stderr?: string }) => {
          throw new ToolError(`nothing to commit? ${redact((e.stderr ?? "").slice(0, 500))}`);
        });
      } else {
        // Undo this call's staging: the listed paths, and anything a hook or
        // a pathspec added beside them.
        const unstage = (extra: string[] = []) => lit("reset", "-q", "--", ...stage, ...extra).catch(() => undefined);
        // The commit this call builds on, to undo back to: a post-commit hook
        // can add commits of its own, so `HEAD~1` is not necessarily it.
        const base = (await git("rev-parse", "HEAD")).stdout.trim();
        try {
          // `add -A` stages a listed deletion; `commit --only` commits those
          // paths and nothing else already staged. The customer's hooks run.
          if (add.length > 0) await lit("add", "-A", "--", ...add);
          commit = await lit("commit", "-m", message, "--only", "--", ...stage);
        } catch (error) {
          await unstage();
          const said = gitSaid(error);
          if (/did not match/.test(said)) {
            throw new ToolError(
              `a listed path did not match a file git knows (a different case, or a file in a nested repository): ${said}`,
            );
          }
          if (/nothing to commit|nothing added to commit|no changes added to commit/.test(said)) {
            throw new ToolError(`nothing to commit? ${said}`);
          }
          throw new ToolError(
            `git commit refused: ${said || "no output from git or a commit hook (a hook such as pre-commit may have failed)"}`,
          );
        }
        // Before anything leaves the runner: the commit must hold the listed
        // paths and nothing else. A pre-commit hook that runs `git add`, or a
        // listed file that replaced a tracked folder (whose files' deletions
        // the pathspec then matches), would otherwise be pushed.
        const listed = new Set(stage);
        // Everything between the base and HEAD, so a commit a hook added
        // after ours is counted too.
        let contains: string[] | null = null;
        let oneCommit = false;
        try {
          oneCommit = (await git("rev-parse", "HEAD~1")).stdout.trim() === base;
          contains = await commitContents(base);
        } catch {
          // Unknown contents are treated as unlisted ones.
        }
        const unlisted = (contains ?? []).filter((p) => !listed.has(p));
        if (contains === null || unlisted.length > 0 || !oneCommit) {
          await git("reset", "-q", "--soft", base).catch(() => undefined);
          await unstage(unlisted);
          if (contains === null) {
            throw new ToolError("the commit could not be listed, so it is not pushed; the commit was undone");
          }
          if (unlisted.length > 0) {
            throw new ToolError(
              `the commit holds paths that were not listed: ${unlisted.slice(0, 10).map(redact).join(", ")}` +
                `${unlisted.length > 10 ? ` and ${unlisted.length - 10} more` : ""}` +
                " (a commit hook staged or committed them, or a listed file replaced a folder); nothing was pushed",
            );
          }
          throw new ToolError("a commit hook made another commit after this one; both were undone and nothing was pushed");
        }
      }
      // What the commit contains, read before the push so a failure here can
      // never follow a push that happened. Relative to the workspace, the
      // base `paths` uses.
      let committed: string[] = [];
      let committedPathsTruncated = false;
      try {
        committed = await commitContents();
      } catch {
        committedPathsTruncated = true;
      }
      if (committed.length > MAX_COMMIT_PATHS) committedPathsTruncated = true;
      // actions/checkout persists the job's GITHUB_TOKEN as an `http.extraheader`
      // Authorization header, which git sends INSTEAD of the credentials in the
      // URL — and that token is usually `contents: read`. Blank the header for
      // this one push so Peeps's token is the one GitHub sees.
      // `peeps/*` branches are Peeps's own and named by the base sha, so a
      // retry of the same session legitimately replaces an earlier push;
      // `--force-with-lease` cannot work here (the runner never fetched it).
      await git(
        "-c", "http.extraheader=",
        "-c", "http.https://github.com/.extraheader=",
        "push", "--force", url, `HEAD:refs/heads/${branch}`,
      ).catch((e: { stderr?: string; message?: string }) => {
        // Never echo the URL: it carries the token.
        const stderr = maskUrlCredentials((e.stderr ?? e.message ?? "").replaceAll(token, "***"));
        throw new ToolError(`git push refused: ${stderr.slice(-600)}`);
      });
      const sha = (await git("rev-parse", "HEAD")).stdout.trim();
      return {
        branch,
        sha,
        summary: redact(commit.stdout.split("\n")[0] ?? ""),
        committedPaths: committed.slice(0, MAX_COMMIT_PATHS).map(redact),
        ...(committedPathsTruncated ? { committedPathsTruncated: true } : {}),
        ...(paths === null ? {} : { skippedPaths: skippedPaths.map(redact) }),
      };
    },
  };

  /**
   * The paths HEAD's commit changes (or, with `since`, every commit after
   * that one), relative to the workspace. git names them from the
   * repository's top level; a workspace below it (rare)
   * gets them re-based, so a path outside the workspace reads `../…`.
   */
  async function commitContents(since?: string): Promise<string[]> {
    const prefix = (await runGit(["rev-parse", "--show-prefix"])).stdout.trim().replace(/\/+$/, "");
    // `--no-renames`: a rename is its deletion and its addition, both named.
    const { stdout } = await runGit(
      since
        ? ["diff", "--name-only", "--no-renames", "-z", since, "HEAD"]
        : ["diff-tree", "-r", "--no-commit-id", "--name-only", "-z", "--root", "HEAD"],
      { maxBuffer: 8 * 1024 * 1024 },
    );
    return stdout.split("\0").filter(Boolean).map((p) => (prefix ? path.posix.relative(prefix, p) : p));
  }

  const specs: ToolSpec[] = [
    { name: "read_file", description: "Read a file in the repository (repo-relative path). Up to 512 KB.", inputSchema: obj({ path: s("Repo-relative path") }, ["path"]) },
    { name: "list_files", description: "List files under a repository directory, recursively.", inputSchema: obj({ path: s("Repo-relative directory; default the repository root") }, []) },
    { name: "grep", description: "Search source files for a regular expression; returns matching lines.", inputSchema: obj({ pattern: s("JavaScript regular expression"), path: s("Repo-relative directory to search; default the root"), ignoreCase: { type: "boolean" } }, ["pattern"]) },
    { name: "write_file", description: "Replace a file's contents (repo-relative path). Creates the file if missing.", inputSchema: obj({ path: s("Repo-relative path"), content: s("Full new contents") }, ["path", "content"]) },
    { name: "apply_patch", description: "Apply a unified diff to the repository with git apply.", inputSchema: obj({ patch: s("Unified diff text") }, ["patch"]) },
    { name: "run_tests", description: "Run one test file with the repository's own config: a Playwright spec, or in a pytest suite a test module (through the repository's .peeps/run-tests hook when it has one). Optionally narrow it: Playwright by --grep or project; pytest by test (the title path, e.g. TestClass › test_name[param]) or grep (a pytest -k expression). Returns per-test results and errors.", inputSchema: obj({ file: s("Repo-relative spec or test module path"), grep: s("Optional filter: Playwright --grep regular expression, or pytest -k expression"), project: s("Optional Playwright project name"), test: s("Optional pytest title path of one test, scopes joined by ' › '") }, ["file"]) },
    { name: "git_status", description: "Files changed in the working tree: git's porcelain lines, and each changed file with its kind and the sha256 of its bytes.", inputSchema: obj({}, []) },
    { name: "git_diff", description: "Unified diff of the working tree against HEAD.", inputSchema: obj({}, []) },
    { name: "git_commit_push", description: "Commit on a new peeps/* branch and push it, using the token Peeps provides for this call: every change, or with `paths` only those files. Returns the paths the commit contains.", inputSchema: obj({ branch: s("Branch name starting with peeps/"), message: s("Commit message"), token: s("The token Peeps minted for this push"), paths: { type: "array", items: { type: "string" }, minItems: 1, maxItems: MAX_COMMIT_PATHS, description: "Optional. Repo-relative paths to commit; nothing else is staged or committed. Omit to commit every change." } }, ["branch", "message", "token"]) },
  ];

  return { specs, handlers };
}

function obj(properties: Record<string, unknown>, required: string[]): Record<string, unknown> {
  return { type: "object", properties, required, additionalProperties: false };
}
function s(description: string) {
  return { type: "string", description };
}

/** What `error-context.md` a failed result carries, at most (PQA-2737). */
export const ERROR_CONTEXT_MAX_BYTES = 16 * 1024;

/**
 * Playwright's `error-context.md` for a failed test: the error, the test's
 * source and, when the test had a page, the page's ARIA snapshot at the
 * failure. Redacted whole, then cut to `ERROR_CONTEXT_MAX_BYTES` at a
 * character boundary. Null when there is no regular file to read.
 */
export async function readErrorContext(file: string, redact: (text: string) => string): Promise<string | null> {
  let handle;
  try {
    if (!(await stat(file)).isFile()) return null;
    handle = await open(file, "r");
    // Read a little past the cap, so redaction sees a secret that straddles it.
    const buffer = Buffer.alloc(ERROR_CONTEXT_MAX_BYTES * 2);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    const text = redact(buffer.subarray(0, bytesRead).toString("utf8"));
    const bytes = Buffer.from(text, "utf8");
    if (bytes.length <= ERROR_CONTEXT_MAX_BYTES) return text;
    let end = ERROR_CONTEXT_MAX_BYTES;
    // Back off continuation bytes (10xxxxxx) to the start of a character.
    while (end > 0 && (bytes[end]! & 0xc0) === 0x80) end--;
    return bytes.subarray(0, end).toString("utf8");
  } catch {
    return null;
  } finally {
    await handle?.close();
  }
}

type ReportAttachment = { name?: string; path?: string };
type ReportResult = {
  status: string;
  retry?: number;
  error?: { message?: string; snippet?: string };
  attachments?: ReportAttachment[];
};
type SummarizedTest = {
  title: string;
  file?: string;
  line: number;
  status: string;
  retry?: number;
  error?: string;
  errorSnippet?: string;
  errorContext?: string;
};
type Summary = { test: SummarizedTest; specFile: string; errorContextPath: string | null };

/**
 * Each result's `file` repo-relative (Playwright names it relative to its
 * rootDir, which says nothing about which spec ran in a monorepo), and for a
 * failed one its `errorContext`. A file outside the workspace is left out.
 */
async function withEvidence(
  summaries: Summary[] | null,
  report: unknown,
  env: RunnerEnv,
  redact: (text: string) => string,
): Promise<SummarizedTest[] | null> {
  if (summaries === null) return null;
  const rootDir = (report as { config?: { rootDir?: string } }).config?.rootDir ?? env.workingDirectory;
  // Playwright reports real paths, and a workspace may be reached through a
  // symlink (macOS's /var is /private/var), so both sides are made real.
  const real = (p: string) => realpath(p).catch(() => p);
  const workspace = await real(env.workspace);
  return Promise.all(
    summaries.map(async ({ test, specFile, errorContextPath }) => {
      const rel = path.relative(workspace, await real(path.resolve(rootDir, specFile)));
      const inside = specFile !== "" && rel !== "" && !rel.startsWith("..") && !path.isAbsolute(rel);
      const errorContext = errorContextPath ? await readErrorContext(errorContextPath, redact) : null;
      return {
        ...test,
        ...(inside ? { file: redact(rel.split(path.sep).join("/")) } : {}),
        ...(errorContext === null ? {} : { errorContext }),
      };
    }),
  );
}

function summarizeReport(report: unknown): Summary[] | null {
  if (!report || typeof report !== "object" || !("suites" in report)) return null;
  const tests: Summary[] = [];
  const walk = (suite: { title: string; file?: string; specs?: Array<{ title: string; file: string; line: number; tests?: Array<{ results?: ReportResult[] }> }>; suites?: unknown[] }, titles: string[], isFile: boolean) => {
    const next = isFile ? titles : [...titles, suite.title];
    for (const spec of suite.specs ?? []) {
      const last = spec.tests?.[0]?.results?.at(-1);
      const failed = last !== undefined && last.status !== "passed" && last.status !== "skipped";
      const context = failed ? last.attachments?.find((a) => a.name === "error-context" && typeof a.path === "string") : undefined;
      tests.push({
        specFile: typeof spec.file === "string" ? spec.file : "",
        errorContextPath: context?.path ?? null,
        test: {
          title: [...next, spec.title].join(" › "),
          line: spec.line,
          status: last?.status ?? "unknown",
          // The final attempt's index (0 = no retry), so a pass after a retry
          // is not read as a clean one. Absent when Playwright ran no attempt.
          ...(typeof last?.retry === "number" ? { retry: last.retry } : {}),
          error: last?.error?.message?.slice(0, 2000),
          errorSnippet: last?.error?.snippet?.slice(0, 2000),
        },
      });
    }
    for (const child of suite.suites ?? []) walk(child as never, next, false);
  };
  for (const suite of (report as { suites: unknown[] }).suites) walk(suite as never, [], true);
  return tests;
}

function runCapture(cmd: string, args: string[], cwd: string, timeoutMs: number): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { cwd, env: { ...process.env, CI: "1" }, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
    child.stdout.on("data", (d: Buffer) => (stdout += d.toString()));
    child.stderr.on("data", (d: Buffer) => (stderr += d.toString()));
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code: code ?? 1, stdout, stderr });
    });
  });
}
