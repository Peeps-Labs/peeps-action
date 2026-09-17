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
import { mkdtemp, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import type { RunnerEnv } from "./env";

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

class ToolError extends Error {}

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
  if (rel === ".github/workflows" || rel.startsWith(".github/workflows/")) {
    throw new ToolError(`workflow files are not writable by Peeps: ${relative}`);
  }
  return abs;
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
  return !/^(GITHUB|RUNNER|ACTIONS|INPUT)_/.test(key);
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
  const runGit = (args: string[], options: { maxBuffer?: number } = {}) =>
    execFileAsync("git", ["-c", `safe.directory=${workspace}`, ...args], {
      cwd: workspace,
      ...options,
    });

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
        results: summarizeReport(report),
        stderr: redact(stderr.slice(-8000)),
        stdoutTail: report ? undefined : redact(stdout.slice(-4000)),
      };
    },

    async git_status() {
      const { stdout } = await runGit(["status", "--porcelain"]);
      // Redacted like every other result: a path can carry a secret (a branch
      // or fixture named after one), and `git_diff` next door already did this.
      return { changedFiles: stdout.trim().split("\n").filter(Boolean).map(redact) };
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
      const remote = await runGit(["remote", "get-url", "origin"]);
      const url = remote.stdout.trim().replace(/^https:\/\/(?:[^@]+@)?github\.com\//, `https://x-access-token:${token}@github.com/`);
      // Via `runGit`, so these carry `-c safe.directory` like every other git
      // call: inside the Playwright container the checkout is owned by another
      // uid and git refuses to touch it without that.
      const git = (...a: string[]) => runGit(a);
      await git("config", "user.name", "peeps[bot]");
      await git("config", "user.email", "peeps[bot]@users.noreply.github.com");
      await git("checkout", "-B", branch);
      await git("add", "-A");
      const commit = await git("commit", "-m", message).catch((e: { stderr?: string }) => {
        throw new ToolError(`nothing to commit? ${redact((e.stderr ?? "").slice(0, 500))}`);
      });
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
        const stderr = (e.stderr ?? e.message ?? "").replaceAll(token, "***").replace(/https:\/\/x-access-token:[^@\s]+@/g, "https://***@");
        throw new ToolError(`git push refused: ${stderr.slice(-600)}`);
      });
      const sha = (await git("rev-parse", "HEAD")).stdout.trim();
      return { branch, sha, summary: redact(commit.stdout.split("\n")[0] ?? "") };
    },
  };

  const specs: ToolSpec[] = [
    { name: "read_file", description: "Read a file in the repository (repo-relative path). Up to 512 KB.", inputSchema: obj({ path: s("Repo-relative path") }, ["path"]) },
    { name: "list_files", description: "List files under a repository directory, recursively.", inputSchema: obj({ path: s("Repo-relative directory; default the repository root") }, []) },
    { name: "grep", description: "Search source files for a regular expression; returns matching lines.", inputSchema: obj({ pattern: s("JavaScript regular expression"), path: s("Repo-relative directory to search; default the root"), ignoreCase: { type: "boolean" } }, ["pattern"]) },
    { name: "write_file", description: "Replace a file's contents (repo-relative path). Creates the file if missing.", inputSchema: obj({ path: s("Repo-relative path"), content: s("Full new contents") }, ["path", "content"]) },
    { name: "apply_patch", description: "Apply a unified diff to the repository with git apply.", inputSchema: obj({ patch: s("Unified diff text") }, ["patch"]) },
    { name: "run_tests", description: "Run one Playwright spec file with the repository's own config; optionally filter by --grep or project. Returns per-test results and errors.", inputSchema: obj({ file: s("Repo-relative spec path"), grep: s("Optional --grep regular expression"), project: s("Optional Playwright project name") }, ["file"]) },
    { name: "git_status", description: "Files changed in the working tree.", inputSchema: obj({}, []) },
    { name: "git_diff", description: "Unified diff of the working tree against HEAD.", inputSchema: obj({}, []) },
    { name: "git_commit_push", description: "Commit every change on a new peeps/* branch and push it, using the GitHub token Peeps provides for this call.", inputSchema: obj({ branch: s("Branch name starting with peeps/"), message: s("Commit message"), token: s("Installation token Peeps minted for this push") }, ["branch", "message", "token"]) },
  ];

  return { specs, handlers };
}

function obj(properties: Record<string, unknown>, required: string[]): Record<string, unknown> {
  return { type: "object", properties, required, additionalProperties: false };
}
function s(description: string) {
  return { type: "string", description };
}

function summarizeReport(report: unknown) {
  if (!report || typeof report !== "object" || !("suites" in report)) return null;
  const tests: Array<{ title: string; file: string; line: number; status: string; error?: string; errorSnippet?: string }> = [];
  const walk = (suite: { title: string; file?: string; specs?: Array<{ title: string; file: string; line: number; tests?: Array<{ results?: Array<{ status: string; error?: { message?: string; snippet?: string } }> }> }>; suites?: unknown[] }, titles: string[], isFile: boolean) => {
    const next = isFile ? titles : [...titles, suite.title];
    for (const spec of suite.specs ?? []) {
      const last = spec.tests?.[0]?.results?.at(-1);
      tests.push({
        title: [...next, spec.title].join(" › "),
        file: spec.file,
        line: spec.line,
        status: last?.status ?? "unknown",
        error: last?.error?.message?.slice(0, 2000),
        errorSnippet: last?.error?.snippet?.slice(0, 2000),
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
