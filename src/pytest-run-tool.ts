/**
 * `run_tests` for a pytest suite, in `agent` mode: the healer's way to run the
 * one test it is fixing, and Peeps' way to verify the fix.
 *
 * The result has the Playwright tool's shape (`results: [{ title, file,
 * status, error }]`, `title` the test's title path), so Peeps reads both the
 * same way. Results come from a JUnit file, for two reasons: pytest writes one
 * with nothing of ours loaded, and it is what a customer's own lab runner
 * already produces.
 *
 * ## The customer's hook: `.peeps/run-tests`
 *
 * Some suites cannot run on a CI runner at all: device tests need hardware a
 * lab service reserves. When the repository has an executable
 * `.peeps/run-tests`, it runs instead of pytest, as
 *
 *     .peeps/run-tests <junit-path> <node-id>...
 *
 * from the working directory, with the job's environment. It must write a
 * JUnit file to `<junit-path>` (pytest's own `--junitxml` output works) and
 * may take as long as the lab does, up to the tool's timeout. Its exit code is
 * reported but not trusted: the JUnit file is the verdict. The hook is the
 * customer's: `.peeps/` is refused to the agent's writes, what runs is a copy
 * of `.peeps/` taken from the commit under test, and it runs only while the
 * checkout's `.peeps/` still matches that commit.
 *
 * ## A hook that cannot wait: `peeps:pending`
 *
 * A lab run can take longer than any heal may wait (a reservation alone can
 * take 30 minutes). Such a hook may start the run and return at once: it exits
 * 0, writes no JUnit file, and prints a line that is exactly `peeps:pending`,
 * optionally followed by a space and a note (the lab run's link, say). The
 * result is then `pending: true` with `results: null`, and the verdict reaches
 * Peeps later, through the lab's own results upload. A JUnit file always wins
 * over the marker, and the marker counts only from the hook, never from pytest.
 */

import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { RunnerEnv } from "./env";
import { TITLE_PATH_SEPARATOR, configArgs, spawnPytest } from "./pytest";

/** The customer's hook, repo-relative. */
export const RUN_TESTS_HOOK = ".peeps/run-tests";

/** How long one run may take: a lab reservation alone can wait 30 minutes. */
export const RUN_TESTS_TIMEOUT_MS = 90 * 60 * 1000;

export interface PytestToolResult {
  title: string;
  file: string;
  line?: number;
  status: "passed" | "failed" | "skipped";
  error?: string;
}

/**
 * The node id that selects one test: the module path relative to where pytest
 * runs, then the title path with each ` › ` spelled `::`. With no title, the
 * whole module.
 */
export function pytestNodeArgument(
  fileRelativeToCwd: string,
  titlePath: string | null,
  browser: string | null = null,
): string {
  if (!titlePath) return fileRelativeToCwd;
  const scopes = titlePath.split(TITLE_PATH_SEPARATOR);
  if (browser) {
    // pytest-playwright puts the browser into the parameter id, and Peeps'
    // title path leaves it out, so `test_x[admin]` names no collected node.
    // Select the function instead; `--browser` keeps it to that browser.
    const last = scopes.length - 1;
    const bracket = scopes[last]!.indexOf("[");
    if (bracket !== -1) scopes[last] = scopes[last]!.slice(0, bracket);
  }
  return `${fileRelativeToCwd}::${scopes.join("::")}`;
}

/** How much of a run's output is kept: its tail. */
export const OUTPUT_TAIL_CHARS = 20_000;

/** The line a hook prints when it started a lab run and will not wait for it. */
export const PENDING_MARKER = "peeps:pending";

/**
 * The note on the hook's last `peeps:pending` line: `""` for a bare marker,
 * `null` when no line is the marker. A line counts only when, trimmed, it is
 * the marker alone or the marker, whitespace, and a note.
 */
export function pendingMarkerNote(output: string): string | null {
  let note: string | null = null;
  for (const raw of output.split(/\r?\n/)) {
    const line = raw.trim();
    if (line === PENDING_MARKER) note = "";
    else if (line.startsWith(PENDING_MARKER) && /\s/.test(line[PENDING_MARKER.length] ?? "")) {
      // Whole: the caller redacts it, and a cut could split a secret.
      note = line.slice(PENDING_MARKER.length).trim();
    }
  }
  return note;
}

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };

function decodeEntities(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#[0-9]+|[a-z]+);/gi, (whole, code: string) => {
    if (code.startsWith("#x") || code.startsWith("#X")) return String.fromCodePoint(parseInt(code.slice(2), 16));
    if (code.startsWith("#")) return String.fromCodePoint(parseInt(code.slice(1), 10));
    return ENTITIES[code.toLowerCase()] ?? whole;
  });
}

function attributes(tag: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const m of tag.matchAll(/([A-Za-z_:][-\w:.]*)\s*=\s*"([^"]*)"/g)) out[m[1]!] = decodeEntities(m[2]!);
  return out;
}

/**
 * The title path pytest's JUnit names a test by. The legacy family carries the
 * module's path in `file`, so the module's dotted name is cut from the front
 * of `classname` and what is left is the class nesting. Without `file`, only
 * the segments that look like classes (`Test…`, by pytest's default rule) are
 * kept. A collection error has an empty classname: its title is empty, and it
 * stands for the whole module.
 */
export function junitTitlePath(
  classname: string,
  name: string,
  file: string | undefined,
  requestedFile: string | null = null,
): string {
  if (classname === "") return "";
  let scopes: string[];
  const dotted = file?.replace(/\.py$/, "").split(/[\\/]/).join(".");
  const parts = classname.split(".");
  const stem = requestedFile ? path.basename(requestedFile).replace(/\.py$/, "") : null;
  if (dotted && (classname === dotted || classname.startsWith(`${dotted}.`))) {
    scopes = classname.slice(dotted.length).split(".").filter(Boolean);
  } else if (stem && parts.includes(stem)) {
    // No `file` (pytest's default xunit2 family): the module is the one the
    // run was asked for, so the scopes are what follows its name.
    scopes = parts.slice(parts.lastIndexOf(stem) + 1);
  } else {
    scopes = parts.filter((segment) => /^Test/.test(segment));
  }
  return [...scopes, name].join(TITLE_PATH_SEPARATOR);
}

/** Every `<testcase>` in a JUnit document, as `run_tests` reports it. */
export function parseJunitResults(xml: string, requestedFile: string | null = null): PytestToolResult[] {
  const results: PytestToolResult[] = [];
  const cases = xml.matchAll(/<testcase\b([^>]*?)(?:\/>|>([\s\S]*?)<\/testcase>)/g);
  for (const m of cases) {
    const attrs = attributes(m[1] ?? "");
    const body = m[2] ?? "";
    const outcome = body.match(/<(failure|error|skipped)\b([^>]*?)(?:\/>|>([\s\S]*?)<\/\1>)/);
    const status = !outcome ? "passed" : outcome[1] === "skipped" ? "skipped" : "failed";
    const name = attrs.name ?? "";
    const file =
      attrs.file ?? (attrs.classname === "" ? `${name.split(".").join("/")}.py` : (requestedFile ?? ""));
    const error = outcome
      ? [attributes(outcome[2] ?? "").message, decodeEntities(outcome[3] ?? "")]
          .filter((part) => part && part.trim())
          .join("\n")
          .slice(0, 4000)
      : undefined;
    results.push({
      title: junitTitlePath(attrs.classname ?? "", name, attrs.file, requestedFile),
      file,
      ...(attrs.line ? { line: Number(attrs.line) } : {}),
      status,
      ...(error ? { error } : {}),
    });
  }
  return results;
}

/**
 * What runs for the customer's hook: nothing (no hook at the commit under
 * test), a refusal (the checkout's `.peeps/` differs from that commit), or the
 * path of the hook copied out of that commit.
 */
export type HookPlan = { kind: "none" } | { kind: "changed" } | { kind: "ready"; path: string };

// A run must not leave `__pycache__` in the checkout: a heal commits every
// change, and bytecode would make its fix touch files it may not change.
const RUN_ENV = { CI: "1", PYTHONDONTWRITEBYTECODE: "1" };

export interface PytestRunDeps {
  /** Runs a command and resolves with its exit code and the tail of its output. */
  run: (cmd: string, args: string[], cwd: string, timeoutMs: number) => Promise<{ code: number; output: string }>;
  pytest: (args: string[], cwd: string) => Promise<{ code: number; output: string }>;
}

const defaultDeps: PytestRunDeps = {
  run: async (cmd, args, cwd, timeoutMs) => {
    const { spawn } = await import("node:child_process");
    return new Promise((resolve) => {
      const child = spawn(cmd, args, { cwd, env: { ...process.env, ...RUN_ENV }, stdio: ["ignore", "pipe", "pipe"] });
      let output = "";
      const keep = (chunk: Buffer) => {
        output = (output + chunk.toString("utf8")).slice(-OUTPUT_TAIL_CHARS);
      };
      const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
      child.stdout.on("data", keep);
      child.stderr.on("data", keep);
      child.on("error", (error) => {
        clearTimeout(timer);
        resolve({ code: 127, output: `could not start ${cmd}: ${error.message}` });
      });
      child.on("close", (code) => {
        clearTimeout(timer);
        resolve({ code: code ?? 1, output });
      });
    });
  },
  pytest: (args, cwd) =>
    spawnPytest(args, { cwd, env: { ...process.env, ...RUN_ENV }, capture: true }),
};

/**
 * Run one module, or one test in it, and report each JUnit testcase.
 * `fileAbs` is already jailed to the workspace.
 */
export async function runPytestTool(
  env: RunnerEnv,
  input: {
    fileAbs: string;
    titlePath: string | null;
    keyword: string | null;
    /** The Playwright browser a pytest-playwright test ran in, if any. */
    browser?: string | null;
    /** Finds the customer's hook, copying it into the run's scratch directory. */
    hook?: (scratchDir: string) => Promise<HookPlan>;
  },
  deps: PytestRunDeps = defaultDeps,
) {
  const rel = path.relative(env.workingDirectory, input.fileAbs).split(path.sep).join("/");
  const repoRel = path.relative(env.workspace, input.fileAbs).split(path.sep).join("/");
  const browser = input.browser ?? null;
  const target = pytestNodeArgument(rel, input.titlePath, browser);
  const dir = await mkdtemp(path.join(tmpdir(), "peeps-pytest-"));
  const junit = path.join(dir, "junit.xml");
  const started = Date.now();
  try {
    const plan: HookPlan = input.hook ? await input.hook(dir) : { kind: "none" };
    if (plan.kind === "changed") {
      return {
        exitCode: 1,
        durationMs: Date.now() - started,
        ranWith: RUN_TESTS_HOOK,
        pending: false,
        pendingNote: null,
        results: null,
        outputTail: `${RUN_TESTS_HOOK} differs from the commit under test, so Peeps did not run it. Undo the change under .peeps/ and run the test again.`,
      };
    }
    const hook = plan.kind === "ready" ? plan.path : null;
    const ran = hook
      ? await deps.run(hook, [junit, target], env.workingDirectory, RUN_TESTS_TIMEOUT_MS)
      : await deps.pytest(
          [
            ...configArgs(env),
            `--junitxml=${junit}`,
            "-o",
            "junit_family=legacy",
            ...(input.keyword ? ["-k", input.keyword] : []),
            ...(browser ? ["--browser", browser] : []),
            "--",
            target,
          ],
          env.workingDirectory,
        );
    let xml: string | null = null;
    try {
      xml = await readFile(junit, "utf8");
    } catch {
      // No JUnit: pytest or the hook failed before writing one.
    }
    // A verdict wins: the marker means something only when no JUnit came back.
    // Output cut to its tail may start mid-line, so that first line is no line;
    // a full tail with no line break is all cut line.
    const firstBreak = ran.output.indexOf("\n");
    const whole =
      ran.output.length < OUTPUT_TAIL_CHARS ? ran.output : firstBreak < 0 ? "" : ran.output.slice(firstBreak + 1);
    const note = hook && xml === null && ran.code === 0 ? pendingMarkerNote(whole) : null;
    return {
      exitCode: ran.code,
      durationMs: Date.now() - started,
      ranWith: hook ? RUN_TESTS_HOOK : "pytest",
      pending: note !== null,
      pendingNote: note ? note : null,
      results: xml === null ? null : parseJunitResults(xml, repoRel),
      outputTail: ran.output.slice(-8000),
    };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
