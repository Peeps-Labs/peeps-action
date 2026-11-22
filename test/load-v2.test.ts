/**
 * V2: the engine judges a journey the way Playwright does (e4 plan v3 §3.2 `load-v2`). The
 * bench's robots check runs twice against one sink: as a Playwright test (`--reporter=json`) and
 * in the engine's Checking (the supervisor, fake jail). On the baseline both pass; on the
 * paginated variant both fail with the same assertion id (CW plan §4.6), which is the id of the
 * robots check's `expect` line, so two missing ids can't agree.
 */
import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { cpSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import { assertionIdOf } from "./helpers/assertion-id";
import { startSink, type Arrival } from "./support/load-sink";
import { checkoutBits, rig, SINK_HOST, smallPlan } from "./support/run-supervisor";

const REPO = path.resolve(__dirname, "..");
const V2 = path.resolve(__dirname, "fixtures/load-engine/v2");
const CLI = require.resolve("@playwright/test/cli");

type Variant = "baseline" | "paginated";

const FLEET = Array.from({ length: 14 }, (_, i) => ({
  id: `RR-C30-${String(i + 1).padStart(4, "0")}`,
  status: i + 1 === 11 ? "charging" : i % 3 === 0 ? "idle" : "working",
}));

/** The bench's `/c/api/robots`: the whole fleet, or its first page in an envelope. */
function robots(variant: Variant) {
  return (arrival: Arrival, res: import("node:http").ServerResponse): void => {
    const url = new URL(arrival.url, "https://sink.test");
    let body: unknown = { ok: true, path: url.pathname };
    if (url.pathname === "/c/api/robots") {
      const cursor = Number(url.searchParams.get("cursor") ?? 0);
      body = variant === "baseline" ? FLEET : { items: FLEET.slice(cursor, cursor + 5), nextCursor: cursor + 5 < FLEET.length ? String(cursor + 5) : null };
    }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify(body));
  };
}

interface Verdict {
  ok: boolean;
  assertionId: string | null;
}

/** The robots check's `expect` that the paginated envelope fails (`fixtures/load-engine/v2/robots.ts`). */
const EXPECTED_LINE = "robots.ts:12";

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
  if (result!.status === "passed") return { ok: true, assertionId: null };
  const error = result!.errors[0]!;
  return { ok: false, assertionId: error.location ? assertionIdOf(`${path.relative(V2, error.location.file)}:${error.location.line}`) : null };
}

/** A checkout holding the V2 journeys, with Playwright linked in. */
function v2Workspace(t: TestContext): string {
  const ws = mkdtempSync(path.join(os.tmpdir(), "peeps-v2-ws-"));
  t.after(() => rmSync(ws, { recursive: true, force: true }));
  cpSync(V2, ws, { recursive: true });
  writeFileSync(path.join(ws, "package-lock.json"), '{"lockfileVersion":3}\n');
  checkoutBits(ws);
  symlinkSync(path.join(REPO, "node_modules"), path.join(ws, "node_modules"));
  return ws;
}

async function engineVerdict(t: TestContext, sink: Awaited<ReturnType<typeof startSink>>): Promise<Verdict> {
  const plan = { ...smallPlan({ exportName: "soughtRobotIsCharging", users: 1, durationMs: 1_000 }), journey: { module: "robots.ts", export: "soughtRobotIsCharging" } };
  const logged: string[] = [];
  const r = await rig(t, { ws: v2Workspace(t), sink, plan, seams: { log: (line) => logged.push(line) } });
  const res = await r.result;
  // The verdict must come from real Checking traffic.
  assert.equal(res.checking.turns, 1, JSON.stringify({ reason: res.reason, failures: res.failures }));
  assert.ok(sink.arrivals.some((a) => a.url === "/c/api/robots"), "Checking reached the sink");
  if (res.checking.success === 1) return { ok: true, assertionId: null };
  // The location is the journey's own text: it reaches the job log, never the result.
  const location = logged.map((l) => /^peeps load: journey failure at (\S+): /.exec(l)?.[1]).find((x) => x !== undefined);
  return { ok: false, assertionId: location ? assertionIdOf(location) : null };
}

for (const variant of ["baseline", "paginated"] as const) {
  test(`the robots check on the ${variant} variant: the engine agrees with Playwright`, async (t) => {
    const sink = await startSink({ host: SINK_HOST, respond: robots(variant) });
    t.after(() => sink.close());
    const playwright = await playwrightVerdict(`https://127.0.0.1:${sink.port}`);
    const engine = await engineVerdict(t, sink);
    assert.equal(playwright.ok, variant === "baseline", JSON.stringify(playwright));
    t.diagnostic(JSON.stringify({ playwright, engine }));
    assert.deepEqual(engine, playwright);
    if (variant === "paginated") {
      assert.notEqual(engine.assertionId, null);
      assert.equal(engine.assertionId, assertionIdOf(EXPECTED_LINE));
    }
  });
}
