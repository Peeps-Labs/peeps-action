/**
 * A recording's server evidence (PQA-3201 PR 3): the suite as one invocation per spec file,
 * each with the app to itself, after one ambient invocation with no tests (start, readiness,
 * global setup, stop). Which tests ran in an invocation is whatever new test ids the
 * reporter recorded during it.
 */
import path from "node:path";
import type { ScriptIndex } from "../fingerprint/rules";
import type { ServerEvidence } from "../members";
import { settleBuildDir, snapshotBuildDir } from "./build-dir";
import { runInvocation, type AppCommand } from "./lifecycle";
import { serverFootprint, type InvocationCoverage, type ServerFootprint } from "./rules";

export type Invoke = typeof runInvocation;

const say = (line: string) => console.log(`[peeps] ${line}`);

/**
 * Test files per run. Each run costs an app start and stop, a reset, Playwright's start and
 * global setup; a test holds its whole run's footprint, so more files per run narrows less,
 * never unsoundly.
 */
export const FILES_PER_RUN = 2;

/** How long after a run's tests start to map the previous run's coverage. */
const MAP_AFTER_MS = 300;

/** The suite's test files in runs of `perRun`, in order. */
export function groupsOf(specs: readonly string[], perRun: number = FILES_PER_RUN): string[][] {
  const groups: string[][] = [];
  const size = Math.max(1, Math.floor(perRun));
  for (let i = 0; i < specs.length; i += size) groups.push(specs.slice(i, i + size));
  return groups;
}

type BuildDir = { snapshot(): unknown; settle(): { created: string[]; changed: string[] } };

function realBuildDir(nextDir: string): BuildDir {
  let snapshot = snapshotBuildDir(nextDir);
  return { snapshot: () => (snapshot = snapshotBuildDir(nextDir)), settle: () => settleBuildDir(nextDir, snapshot) };
}

/** What the app wrote into its build directory during a run: removes what it created, and says whether it rewrote any built file. */
function settleBuild(build: BuildDir): boolean {
  const { created, changed } = build.settle();
  if (created.length > 0) say(`removed ${created.length} file(s) the app wrote into its build directory, before the next run`);
  if (changed.length > 0) say(`the app rewrote ${changed.length} built file(s) (${changed.slice(0, 3).join(", ")}): later runs' server evidence reads partial`);
  return changed.length > 0;
}

type Timings = { resetMs: number; readyMs: number; testsMs: number; stopMs: number };
const timing = (name: string, t: Timings | undefined) =>
  t && say(`${name}: reset ${(t.resetMs / 1000).toFixed(1)} s, ready ${(t.readyMs / 1000).toFixed(1)} s, tests ${(t.testsMs / 1000).toFixed(1)} s, stop ${(t.stopMs / 1000).toFixed(1)} s`);

/** The ambient run, done: its coverage still to read, and the build directory it left. */
export interface AmbientRun {
  exitCode: number;
  read: () => InvocationCoverage;
  timings?: Timings;
  build: BuildDir;
  /** It rewrote a built file: every later run may serve what it wrote. */
  rewrote: boolean;
}

export interface AmbientInput {
  app: AppCommand;
  preload: string;
  /** A private directory for its raw coverage. */
  coverageDir: string;
  nextDir: string;
  /** Playwright with no test: global setup and teardown only. */
  runTests: () => Promise<number>;
  invoke?: Invoke;
  buildDir?: BuildDir;
  /** The app starts once this settles (the fingerprint reading `.next`); the reset needn't wait. */
  startAfter?: Promise<unknown>;
}

/**
 * The run with no tests (start, readiness, global setup, stop). It needs nothing the
 * announce gives, so the job can start it beside the fingerprint and the announce.
 */
export async function runAmbient(input: AmbientInput): Promise<AmbientRun> {
  const invoke = input.invoke ?? runInvocation;
  const build = input.buildDir ?? realBuildDir(input.nextDir);
  build.snapshot();
  const run = await invoke(input.app, { dir: path.join(input.coverageDir, "ambient"), preload: input.preload, kind: "ambient", defer: true, startAfter: input.startAfter }, input.runTests);
  timing("ambient", run.timings);
  const rewrote = settleBuild(build);
  return { exitCode: run.exitCode, read: run.read ?? (() => run.coverage!), timings: run.timings, build, rewrote };
}

export interface RecordServerInput {
  app: AppCommand;
  /** Absolute paths of the suite's test files. */
  specs: string[];
  preload: string;
  /** A private directory: each invocation's raw coverage passes through a subdirectory of it. */
  coverageDir: string;
  scripts: ReadonlyMap<string, ScriptIndex>;
  /** Every source the fingerprint names: workspace code the server ran is keyed by its file. */
  sources?: ReadonlySet<string>;
  /** Whether git tracks a real absolute path. */
  tracked?: (file: string) => boolean;
  /** The job's `.next`, real path. */
  nextDir: string;
  /** Run Playwright on these test files, or on none (null) for the ambient invocation. */
  runTests: (files: string[] | null, index: number) => Promise<number>;
  /** Every attempt the reporter has recorded so far: its test id, and the real path of the test's file. */
  attempts: () => Array<{ testId: string; file: string | null }>;
  invoke?: Invoke;
  /** The build directory between runs (`build-dir.ts`); by default the real `nextDir`. */
  buildDir?: BuildDir;
  /** The ambient run, already started; by default it runs first, here. */
  ambient?: Promise<AmbientRun>;
  /** Test files per run (`FILES_PER_RUN`). */
  perRun?: number;
}

/** The filter that selects exactly this file: Playwright reads each file argument as a case-insensitive regex. */
export function specFilter(file: string): string {
  return `^${file.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`;
}

/** An attempt recorded during another run: that app served more than its own files' tests. */
const elsewhere: ServerFootprint = { keys: [], loaded: [], partial: ["code"], reasons: ["other_invocation"] };

export async function recordServer(input: RecordServerInput): Promise<{ exitCode: number; server: ServerEvidence }> {
  const invoke = input.invoke ?? runInvocation;
  // The preload runs in every app process, from wherever the action is installed: it's no one's code.
  const preload = input.preload.split(path.sep).join("/");
  const ownCode = (file: string) => file === preload;
  const footprint = (coverage: InvocationCoverage) => serverFootprint(coverage, input.scripts, input.nextDir, input.sources, ownCode, input.tracked);
  const ambientRun = await (input.ambient ??
    runAmbient({ app: input.app, preload: input.preload, coverageDir: input.coverageDir, nextDir: input.nextDir, runTests: () => input.runTests(null, 0), invoke, buildDir: input.buildDir }));
  let exitCode = ambientRun.exitCode;
  // Once a run rewrote a built file, every later run may serve what it wrote.
  let tainted = ambientRun.rewrote;
  const taint = (fp: ServerFootprint): ServerFootprint => ({ ...fp, partial: ["code"], reasons: [...fp.reasons, "build_dir_changed"] });
  let ambient: ServerFootprint | undefined;
  // Mapping a run's coverage (a parse of ~140 MB on a Next app) waits for the next run's
  // tests, which run in Playwright's own process: done while the app starts, it would hold
  // up the readiness check instead.
  let deferred: (() => void) | null = () => {
    ambient = footprint(ambientRun.read());
    if (ambient.reasons.length > 0) say(`the ambient run's server evidence is partial (${ambient.reasons.join(", ")}): every test's is`);
  };
  const flush = () => {
    const work = deferred;
    deferred = null;
    work?.();
  };
  const byTest = new Map<string, ServerFootprint>();
  const counts = () => {
    const out = new Map<string, { count: number; file: string | null }>();
    for (const { testId, file } of input.attempts()) out.set(testId, { count: (out.get(testId)?.count ?? 0) + 1, file });
    return out;
  };
  for (const [i, files] of groupsOf(input.specs, input.perRun).entries()) {
    const before = counts();
    const run = await invoke(input.app, { dir: path.join(input.coverageDir, `spec-${i}`), preload: input.preload, kind: "spec", defer: true }, () => {
      const tests = input.runTests(files, i + 1);
      // Once Playwright has started; it takes longer than that to start its first test. A
      // mapping that throws there fails the run when its tests end, as it would have inline.
      let failed: unknown;
      const work = setTimeout(() => {
        try {
          flush();
        } catch (error) {
          failed = error;
        }
      }, MAP_AFTER_MS);
      return tests.finally(() => {
        clearTimeout(work);
        if (failed !== undefined) throw failed;
        flush();
      });
    });
    if (run.exitCode !== 0) exitCode = run.exitCode;
    const label = files.map((file) => path.basename(file)).join(", ");
    timing(label, run.timings);
    const after = counts();
    const servedTainted = tainted;
    if (settleBuild(input.buildDir ?? ambientRun.build)) tainted = true;
    const read = run.read ?? (() => run.coverage!);
    flush();
    deferred = () => {
      const mapped = footprint(read());
      const own = servedTainted ? taint(mapped) : mapped;
      if (own.reasons.length > 0) say(`${label}: server evidence partial (${own.reasons.join(", ")})`);
      for (const [id, { count, file }] of after) {
        if (count === (before.get(id)?.count ?? 0)) continue;
        // Each attempt is recorded once (the reporter never overwrites one), so a test that ran in the
        // wrong invocation is caught where it first ran, and stays unknown.
        byTest.set(id, file !== null && files.includes(file) && !byTest.has(id) ? own : elsewhere);
      }
    };
  }
  flush();
  return { exitCode, server: { ambient: ambient!, byTest } };
}
