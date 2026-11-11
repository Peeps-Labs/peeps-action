/**
 * A recording's server evidence (PQA-3201 PR 3): the suite as one invocation per spec file,
 * each with the app to itself, after one ambient invocation with no tests (start, readiness,
 * global setup, stop). Which tests ran in an invocation is whatever new test ids the
 * reporter recorded during it.
 */
import path from "node:path";
import type { ScriptIndex } from "../fingerprint/rules";
import type { ServerEvidence } from "../members";
import { runInvocation, type AppCommand } from "./lifecycle";
import { serverFootprint, type ServerFootprint } from "./rules";

export type Invoke = typeof runInvocation;

export interface RecordServerInput {
  app: AppCommand;
  /** Absolute paths of the suite's spec files. */
  specs: string[];
  preload: string;
  /** A private directory: each invocation's raw coverage passes through a subdirectory of it. */
  coverageDir: string;
  scripts: ReadonlyMap<string, ScriptIndex>;
  /** The job's `.next`, real path. */
  nextDir: string;
  /** Run Playwright on one spec file, or on none (null) for the ambient invocation. */
  runTests: (spec: string | null, index: number) => Promise<number>;
  /** Every attempt the reporter has recorded so far: its test id, and the real path of the test's file. */
  attempts: () => Array<{ testId: string; file: string | null }>;
  invoke?: Invoke;
}

/** The filter that selects exactly this file: Playwright reads each file argument as a case-insensitive regex. */
export function specFilter(file: string): string {
  return `^${file.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`;
}

/** An attempt recorded during another file's invocation: that app served more than one file's tests. */
const elsewhere: ServerFootprint = { keys: [], loaded: [], partial: ["code"], reasons: ["other_invocation"] };

export async function recordServer(input: RecordServerInput): Promise<{ exitCode: number; server: ServerEvidence }> {
  const invoke = input.invoke ?? runInvocation;
  const footprint = (coverage: Parameters<typeof serverFootprint>[0]) => serverFootprint(coverage, input.scripts, input.nextDir);
  let exitCode = 0;
  const ambientRun = await invoke(input.app, { dir: path.join(input.coverageDir, "ambient"), preload: input.preload, kind: "ambient" }, () => input.runTests(null, 0));
  if (ambientRun.exitCode !== 0) exitCode = ambientRun.exitCode;
  const ambient = footprint(ambientRun.coverage);
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
    const own = footprint(run.coverage);
    for (const [id, { count, file }] of counts()) {
      if (count === (before.get(id)?.count ?? 0)) continue;
      // Each attempt is recorded once (the reporter never overwrites one), so a test that ran in the
      // wrong invocation is caught where it first ran, and stays unknown.
      byTest.set(id, file === spec && !byTest.has(id) ? own : elsewhere);
    }
  }
  return { exitCode, server: { ambient, byTest } };
}
