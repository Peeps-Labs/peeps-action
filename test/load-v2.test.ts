/**
 * V2: the engine judges a journey the way Playwright does. The bench's robots check runs
 * twice against the sink: once as a Playwright test (`--reporter=json`) and once in the
 * engine's Checking phase. On the baseline both pass; on the paginated variant both fail,
 * with the same first line of the message and the same file:line. Also run by CI's
 * `load-stock-image` job.
 */
import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";

import { newSink, startRun } from "./support/load-run";
import type { Variant } from "./support/load-sink";

const V2 = path.resolve(__dirname, "fixtures/load-engine/v2");
const CLI = require.resolve("@playwright/test/cli");

interface Verdict {
  ok: boolean;
  firstLine: string | null;
  location: string | null;
}

const stripAnsi = (s: string) => s.replace(/\u001b\[[0-9;]*m/g, "");
const firstLine = (message: string) => stripAnsi(message).replace(/^Error: /, "").split("\n")[0]!.trim();

interface JsonError {
  message?: string;
  location?: { file: string; line: number };
}
interface JsonReport {
  suites: { specs: { tests: { results: { status: string; errors: JsonError[] }[] }[] }[]; suites?: JsonReport["suites"] }[];
}

async function playwrightVerdict(baseURL: string): Promise<Verdict> {
  const run = await promisify(execFile)(process.execPath, [CLI, "test", "--config", path.join(V2, "playwright.config.ts"), "--reporter=json"], {
    cwd: V2,
    env: { ...process.env, BASE_URL: baseURL, FORCE_COLOR: "0" },
    maxBuffer: 16 * 1024 * 1024,
  }).catch((error: { stdout?: string; stderr?: string }) => ({ stdout: error.stdout ?? "", stderr: error.stderr ?? "" }));
  const report = JSON.parse(run.stdout) as JsonReport;
  const results = report.suites.flatMap(function walk(s): { status: string; errors: JsonError[] }[] {
    return [...s.specs.flatMap((spec) => spec.tests.flatMap((t) => t.results)), ...(s.suites ?? []).flatMap(walk)];
  });
  assert.equal(results.length, 1, run.stderr);
  const [result] = results;
  if (result!.status === "passed") return { ok: true, firstLine: null, location: null };
  const error = result!.errors[0]!;
  return {
    ok: false,
    firstLine: firstLine(error.message ?? ""),
    location: error.location ? `${path.relative(V2, error.location.file)}:${error.location.line}` : null,
  };
}

async function engineVerdict(t: TestContext, variant: Variant): Promise<Verdict> {
  const sink = await newSink(t);
  sink.variant = variant;
  const run = await startRun(t, sink, {
    plan: { module: "robots.ts", export: "soughtRobotIsCharging", users: 1, holdMs: 2_000 },
    options: { repositoryRoot: V2 },
  });
  const done = await run.finished();
  const failure = done.result.checking.failures[0];
  if (!failure) {
    assert.equal(done.result.checking.success, done.result.checking.users, run.stderr);
    return { ok: true, firstLine: null, location: null };
  }
  return { ok: false, firstLine: firstLine(failure.message), location: failure.location };
}

for (const variant of ["baseline", "paginated"] as const) {
  test(`the robots check on the ${variant} variant: the engine agrees with Playwright`, async (t) => {
    const sink = await newSink(t);
    sink.variant = variant;
    const playwright = await playwrightVerdict(sink.url);
    const engine = await engineVerdict(t, variant);
    assert.equal(playwright.ok, variant === "baseline", JSON.stringify(playwright));
    assert.deepEqual(engine, playwright);
    if (variant === "paginated") assert.ok(engine.location?.startsWith("robots.ts:"), String(engine.location));
  });
}
