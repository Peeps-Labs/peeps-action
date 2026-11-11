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
import { serverFootprint, type ServerFootprint } from "./rules";

export type Invoke = typeof runInvocation;

const say = (line: string) => console.log(`[peeps] ${line}`);

export interface RecordServerInput {
  app: AppCommand;
  /** Absolute paths of the suite's spec files. */
  specs: string[];
  preload: string;
  /** A private directory: each invocation's raw coverage passes through a subdirectory of it. */
  coverageDir: string;
  scripts: ReadonlyMap<string, ScriptIndex>;
  /** Every source the fingerprint names: workspace code the server ran is keyed by its file. */
  sources?: ReadonlySet<string>;
  /** Whether git tracks an absolute path: unmatched untracked code reads unknown. */
  tracked?: (file: string) => boolean;
  /** The job's `.next`, real path. */
  nextDir: string;
  /** Run Playwright on one spec file, or on none (null) for the ambient invocation. */
  runTests: (spec: string | null, index: number) => Promise<number>;
  /** Every attempt the reporter has recorded so far: its test id, and the real path of the test's file. */
  attempts: () => Array<{ testId: string; file: string | null }>;
  invoke?: Invoke;
  /** The build directory between runs (`build-dir.ts`); by default the real `nextDir`. */
  buildDir?: { snapshot(): unknown; settle(): { created: string[]; changed: string[] } };
}

/** The filter that selects exactly this file: Playwright reads each file argument as a case-insensitive regex. */
export function specFilter(file: string): string {
  return `^${file.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`;
}

/** An attempt recorded during another file's invocation: that app served more than one file's tests. */
const elsewhere: ServerFootprint = { keys: [], loaded: [], partial: ["code"], reasons: ["other_invocation"] };

export async function recordServer(input: RecordServerInput): Promise<{ exitCode: number; server: ServerEvidence }> {
  const invoke = input.invoke ?? runInvocation;
  // The preload runs in every app process, from wherever the action is installed: it's no one's code.
  const preload = input.preload.split(path.sep).join("/");
  const ownCode = (file: string) => file === preload || (input.tracked?.(file) ?? false);
  const footprint = (coverage: Parameters<typeof serverFootprint>[0]) => serverFootprint(coverage, input.scripts, input.nextDir, input.sources, ownCode);
  const build =
    input.buildDir ??
    (() => {
      let snapshot = snapshotBuildDir(input.nextDir);
      return { snapshot: () => (snapshot = snapshotBuildDir(input.nextDir)), settle: () => settleBuildDir(input.nextDir, snapshot) };
    })();
  build.snapshot();
  // Once a run rewrote a built file, every later run may serve what it wrote.
  let tainted = false;
  const settle = () => {
    const { created, changed } = build.settle();
    if (created.length > 0) say(`removed ${created.length} file(s) the app wrote into its build directory, before the next run`);
    if (changed.length > 0 && !tainted) {
      say(`the app rewrote ${changed.length} built file(s) (${changed.slice(0, 3).join(", ")}): later runs' server evidence reads partial`);
      tainted = true;
    }
  };
  const taint = (fp: ServerFootprint): ServerFootprint => (tainted ? { ...fp, partial: ["code"], reasons: [...fp.reasons, "build_dir_changed"] } : fp);
  let exitCode = 0;
  const ambientRun = await invoke(input.app, { dir: path.join(input.coverageDir, "ambient"), preload: input.preload, kind: "ambient" }, () => input.runTests(null, 0));
  if (ambientRun.exitCode !== 0) exitCode = ambientRun.exitCode;
  const ambient = footprint(ambientRun.coverage);
  const timing = (name: string, t: { resetMs: number; readyMs: number; testsMs: number; stopMs: number } | undefined) =>
    t && say(`${name}: reset ${(t.resetMs / 1000).toFixed(1)} s, ready ${(t.readyMs / 1000).toFixed(1)} s, tests ${(t.testsMs / 1000).toFixed(1)} s, stop ${(t.stopMs / 1000).toFixed(1)} s`);
  timing("ambient", ambientRun.timings);
  if (ambient.reasons.length > 0) say(`the ambient run's server evidence is partial (${ambient.reasons.join(", ")}): every test's is`);
  settle();
  const byTest = new Map<string, ServerFootprint>();
  const counts = () => {
    const out = new Map<string, { count: number; file: string | null }>();
    for (const { testId, file } of input.attempts()) out.set(testId, { count: (out.get(testId)?.count ?? 0) + 1, file });
    return out;
  };
  for (const [i, spec] of input.specs.entries()) {
    const before = counts();
    const run = await invoke(input.app, { dir: path.join(input.coverageDir, `spec-${i}`), preload: input.preload, kind: "spec" }, () => input.runTests(spec, i + 1));
    if (run.exitCode !== 0) exitCode = run.exitCode;
    timing(path.basename(spec), run.timings);
    const own = taint(footprint(run.coverage));
    if (own.reasons.length > 0) say(`${path.basename(spec)}: server evidence partial (${own.reasons.join(", ")})`);
    settle();
    for (const [id, { count, file }] of counts()) {
      if (count === (before.get(id)?.count ?? 0)) continue;
      // Each attempt is recorded once (the reporter never overwrites one), so a test that ran in the
      // wrong invocation is caught where it first ran, and stays unknown.
      byTest.set(id, file === spec && !byTest.has(id) ? own : elsewhere);
    }
  }
  return { exitCode, server: { ambient, byTest } };
}
