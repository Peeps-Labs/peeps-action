/**
 * Footprints and the trace policy, through the committed action, real Playwright and
 * real Chromium: what the reporter sends, and that the customer's report and upload
 * are what their own policy would have left.
 */
import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { mkdir, mkdtemp, readdir, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";

import { readRunnerEnv } from "../src/env";
import { gunzipSync } from "node:zlib";
import { decodePayload } from "../src/evidence/codec";
import { parseProjectKey, pathToken, tokenOf } from "../src/evidence/hash";
import { readZip } from "../src/footprint/trace-file";
import { computeReach } from "../src/reach";
import { BASE as NEXT_BUILD, nextBuild } from "./support/next-build";

const action = path.resolve(__dirname, "../dist/index.js");
const modules = path.resolve(__dirname, "../node_modules");

interface Sent { type: string; status?: string; retry?: number; footprint?: { paths: string[]; complete: boolean; attempt?: { retry: number }; origins?: string[] } }
interface Planned { path: string; titlePath: string; pwProject: string }

/** The application under test: a page that calls an API and loads an image. */
async function appServer(t: TestContext) {
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    if (url.pathname === "/cart") {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(`<h1>Cart</h1><img src="/logo.png"><script>fetch("/api/cart?secret=1")</script>`);
    } else if (url.pathname === "/api/cart") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end("{}");
    } else if (url.pathname === "/logo.png") {
      res.writeHead(200, { "Content-Type": "image/png" });
      res.end(Buffer.alloc(8));
    } else {
      res.writeHead(404);
      res.end();
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

const SPEC = `
import { test, expect } from "@playwright/test";
test("passes", async ({ page }) => {
  await page.goto("/cart");
  await page.waitForLoadState("networkidle");
  await expect(page.getByRole("heading")).toHaveText("Cart");
});
test("fails", async ({ page }) => {
  await page.goto("/cart");
  await expect(page.getByRole("heading")).toHaveText("Not this", { timeout: 200 });
});
`;

async function suite(t: TestContext, config: string, spec = SPEC) {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), "peeps-targeted-")));
  t.after(() => rm(root, { recursive: true, force: true }));
  await symlink(modules, path.join(root, "node_modules"), "dir");
  await mkdir(path.join(root, "suite/specs"), { recursive: true });
  await writeFile(path.join(root, "suite/playwright.config.ts"), `import { defineConfig } from "@playwright/test";\nexport default defineConfig(${config});\n`);
  await writeFile(path.join(root, "suite/specs/cart.spec.ts"), spec);
  return root;
}

/**
 * `on` and `off`: a server that speaks protocol 2, with or without the switch. `legacy`:
 * one from before it, which answers `scan` alone. `v3`: a later protocol, with the switch.
 */
type Preflight = "on" | "off" | "legacy" | "v3" | "missing" | "error" | "hang" | "garbage" | "collect" | "collect-tables";
/** The project key a `collect` preflight hands over: masked, and never printed otherwise. */
const COLLECT_KEY = "c03dd504d33c33f55a570a1a758d442e1cda0793b1a480482f0d67f9437320a6";

async function fakePeeps(t: TestContext, batchExtra: Record<string, unknown>, leaveOut: (test: Planned) => boolean = () => false, preflight: Preflight = "off", refuseReach = 0, refuseImpact = 0) {
  const preflights: string[] = [];
  const fingerprints: string[] = [];
  /** Evidence parts and finalize, in order, with what else the job said to Peeps between them. */
  const evidence: Array<{ path: string; bytes: Buffer }> = [];
  const order: string[] = [];
  const announces: Array<Record<string, unknown>> = [];
  const completes: Array<Record<string, unknown>> = [];
  const artifacts = new Map<string, Buffer>();
  const sent = new Map<string, Sent[]>();
  const names = new Map<string, string>();
  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    const bytes = Buffer.concat(chunks);
    let response: unknown = {};
    if (url.pathname === "/api/v1/ci/targeted-runs") {
      preflights.push(req.method ?? "");
      if (preflight === "hang") return;
      if (preflight === "missing" || preflight === "error") {
        res.writeHead(preflight === "missing" ? 404 : 500);
        res.end();
        return;
      }
      if (preflight === "garbage") {
        res.writeHead(200);
        res.end("<html>");
        return;
      }
      response = preflight === "legacy" ? { scan: true } : preflight === "v3" ? { scan: true, protocolVersion: 3 } : { scan: preflight === "on" || preflight.startsWith("collect"), protocolVersion: 2, projects: [{ projectId: "project", executionMode: "shadow" }] };
      if (preflight.startsWith("collect")) response = { ...(response as object), projects: [{ projectId: "project", executionMode: "shadow", collect: { coverage: true, fingerprint: true, ...(preflight === "collect-tables" ? { tables: true } : {}), key: COLLECT_KEY, keyVersion: "V1", codecVersions: [1, 2] } }] };
    } else if (url.pathname === "/api/v1/ci/impact/fingerprint") {
      fingerprints.push(url.search);
      response = { uploadId: "upload-1" };
    } else if (url.pathname === "/api/v1/ci/batches") {
      const input = JSON.parse(bytes.toString()) as { tests: Planned[] };
      announces.push(input as unknown as Record<string, unknown>);
      if ((refuseReach && (input as { reach?: unknown }).reach) || (refuseImpact && (input as { impact?: unknown }).impact)) {
        res.writeHead(refuseReach || refuseImpact);
        res.end();
        return;
      }
      const planned = input.tests.filter((v) => !leaveOut(v));
      const runs = planned.map((v, i) => {
        names.set(`run-${i}`, `${v.pwProject}|${v.titlePath}`);
        return { ...v, runId: `run-${i}`, credential: { exp: 99, sig: "signature" } };
      });
      response = { batches: [{ projectId: "project", batchId: "batch", batchNumber: 1, runs, unmatched: input.tests.filter(leaveOut), ...batchExtra }], failures: [] };
    } else if (url.pathname.includes("/evidence")) {
      order.push("evidence");
      evidence.push({ path: `${url.pathname}${url.search}`, bytes });
    } else if (url.pathname.endsWith("/complete")) {
      order.push("complete");
      completes.push(JSON.parse(bytes.toString()) as Record<string, unknown>);
    } else if (url.pathname.endsWith("/artifacts")) {
      artifacts.set(url.searchParams.get("path") ?? "", bytes);
    } else if (url.pathname.endsWith("/events")) {
      // The events route's own limit.
      if (bytes.length > 1_000_000) {
        res.writeHead(413);
        res.end();
        return;
      }
      const name = names.get(url.pathname.split("/")[4]!) ?? url.pathname;
      sent.set(name, [...(sent.get(name) ?? []), ...(JSON.parse(bytes.toString()) as { events: Sent[] }).events]);
    }
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(response));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise<void>((resolve) => {
    server.closeAllConnections();
    server.close(() => resolve());
  }));
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, announces, completes, artifacts, sent, preflights, fingerprints, evidence, order };
}

async function runAction(root: string, url: string, extra: NodeJS.ProcessEnv = {}) {
  const env = { ...process.env };
  for (const name of Object.keys(env)) {
    if (/^(?:GITHUB_|GITLAB_|CI_|ACTIONS_|INPUT_|PEEPS_|BASE_URL)/.test(name)) delete env[name];
  }
  Object.assign(env, {
    GITHUB_WORKSPACE: root, GITHUB_SHA: "0123456789abcdef0123456789abcdef01234567",
    GITHUB_REF: "refs/heads/main", INPUT_MODE: "report", INPUT_FRAMEWORK: "playwright",
    INPUT_CONFIG: "suite/playwright.config.ts", PEEPS_API_URL: url, PEEPS_API_KEY: "fake-test-key",
    RUNNER_TEMP: root, ...extra,
  });
  const child = spawn(process.execPath, [action], { cwd: root, env, stdio: ["ignore", "pipe", "pipe"] });
  let output = "";
  child.stdout.on("data", (v: Buffer) => { output += v.toString(); });
  child.stderr.on("data", (v: Buffer) => { output += v.toString(); });
  const timer = setTimeout(() => child.kill("SIGKILL"), 120_000);
  const code = await new Promise<number | null>((resolve, reject) => {
    child.on("error", reject);
    child.on("close", resolve);
  }).finally(() => clearTimeout(timer));
  return { code, output };
}

const ended = (events: Sent[] | undefined) => (events ?? []).filter((e) => e.type === "test_end");

/** Traces uploaded in the report, and what each holds. */
function uploadedTraces(artifacts: Map<string, Buffer>) {
  return [...artifacts.keys()].filter((name) => name.endsWith(".zip"));
}

/** The trace attachments the HTML report links, read from the data it embeds. */
async function reportTraceLinks(artifacts: Map<string, Buffer>, root: string): Promise<number> {
  const html = artifacts.get("index.html")?.toString() ?? "";
  const match = /data:application\/zip;base64,([A-Za-z0-9+/=]+)/.exec(html);
  assert.ok(match, "the report embeds its data");
  const file = path.join(root, "report-data.zip");
  await writeFile(file, Buffer.from(match[1]!, "base64"));
  const texts = readZip(file, (name) => name.endsWith(".json"));
  const linked = new Set(texts.join("\n").match(/data\/[0-9a-f]+\.zip/g) ?? []);
  for (const link of linked) assert.ok(artifacts.has(link), `a dead link: ${link}`);
  return linked.size;
}

async function reportTraceNames(artifacts: Map<string, Buffer>, root: string): Promise<number> {
  const match = /data:application\/zip;base64,([A-Za-z0-9+/=]+)/.exec(artifacts.get("index.html")?.toString() ?? "");
  const file = path.join(root, "report-names.zip");
  await writeFile(file, Buffer.from(match![1]!, "base64"));
  return readZip(file, (name) => name.endsWith(".json")).join("\n").split('"name":"trace"').length - 1;
}

async function traceHolds(artifacts: Map<string, Buffer>, name: string, root: string) {
  const file = path.join(root, "one-trace.zip");
  await writeFile(file, artifacts.get(name)!);
  const names: string[] = [];
  readZip(file, (entry) => { names.push(entry); return false; });
  return { sources: names.some((n) => n.includes("src/") || n.includes("src@")), screencast: names.some((n) => n.endsWith(".jpeg")) };
}

const COMMON = (use: string, rest = "") => `{ testDir: "./specs", outputDir: "./results", workers: 1, retries: 0, timeout: 15000, ${rest} use: { baseURL: process.env.BASE_URL, ...{ ${use} } } }`;

test("off, the default: a footprint of what the app served, and no trace anywhere the customer looks", async (t) => {
  const app = await appServer(t);
  const root = await suite(t, COMMON(""));
  const peeps = await fakePeeps(t, { collectFootprints: true });
  const result = await runAction(root, peeps.url, { BASE_URL: app });
  assert.equal(result.code, 1, result.output);
  for (const name of ["|passes", "|fails"]) {
    const [event] = ended(peeps.sent.get(name));
    assert.deepEqual(event!.footprint, { paths: ["/api/cart", "/cart", "/logo.png"], complete: true, attempt: { retry: 0 }, origins: [] }, `${name}: ${result.output}`);
  }
  assert.deepEqual(uploadedTraces(peeps.artifacts), [], "nothing of ours is uploaded");
  assert.equal(await reportTraceLinks(peeps.artifacts, root), 0, "no dead link in the report");
  assert.equal(await reportTraceNames(peeps.artifacts, root), 0, "and no trace attachment listed at all");
  const left = await readdir(path.join(root, "suite/results"), { recursive: true }).catch(() => [] as string[]);
  assert.deepEqual(left.filter((name) => String(name).endsWith(".zip")), [], "and none left on the runner");
});

test("nothing changes when Peeps doesn't ask: an old server strips the field, and the trace stays off", async (t) => {
  const app = await appServer(t);
  const root = await suite(t, COMMON(""));
  const peeps = await fakePeeps(t, {});
  const result = await runAction(root, peeps.url, { BASE_URL: app });
  assert.equal(result.code, 1, result.output);
  assert.equal(ended(peeps.sent.get("|passes"))[0]!.footprint, undefined);
  assert.deepEqual(uploadedTraces(peeps.artifacts), []);
  assert.deepEqual(peeps.completes, [{ reportUploaded: true }], "no executed: no reach was sent");
  assert.equal(peeps.announces[0]!.reach, undefined, "a push sends no reach");
});

test("a server from before protocol 2 that asks for footprints gets none, and no trace", async (t) => {
  const app = await appServer(t);
  const root = await suite(t, COMMON(""));
  const peeps = await fakePeeps(t, { collectFootprints: true }, undefined, "legacy");
  const result = await runAction(root, peeps.url, { BASE_URL: app });
  assert.equal(result.code, 1, result.output);
  for (const name of ["|passes", "|fails"]) assert.equal(ended(peeps.sent.get(name))[0]!.footprint, undefined, `${name}: ${result.output}`);
  assert.deepEqual(uploadedTraces(peeps.artifacts), []);
  assert.equal(peeps.announces[0]!.canNarrow, undefined);
});

test("retain-on-failure: the failure's trace stays with the customer's options, the pass's is gone", async (t) => {
  const app = await appServer(t);
  const root = await suite(t, COMMON('trace: { mode: "retain-on-failure", sources: false },'));
  const peeps = await fakePeeps(t, { collectFootprints: true });
  const result = await runAction(root, peeps.url, { BASE_URL: app });
  assert.equal(result.code, 1, result.output);
  assert.equal(ended(peeps.sent.get("|passes"))[0]!.footprint?.complete, true, "the pass still leaves its footprint");
  assert.equal(ended(peeps.sent.get("|fails"))[0]!.footprint?.complete, true);
  const traces = uploadedTraces(peeps.artifacts);
  assert.equal(traces.length, 1, `only the failure's: ${traces.join(", ")}`);
  assert.equal(await reportTraceLinks(peeps.artifacts, root), 1);
  const holds = await traceHolds(peeps.artifacts, traces[0]!, root);
  assert.equal(holds.sources, false, "the customer said no sources");
  assert.equal(holds.screencast, true, "and left screenshots on");
});

test("on-first-retry with two retries: only retry 1's trace stays, with screenshots and sources", async (t) => {
  const app = await appServer(t);
  const root = await suite(t, COMMON('trace: "on-first-retry",').replace("retries: 0", "retries: 2"));
  const peeps = await fakePeeps(t, { collectFootprints: true });
  const result = await runAction(root, peeps.url, { BASE_URL: app });
  assert.equal(result.code, 1, result.output);
  const attempts = ended(peeps.sent.get("|fails"));
  assert.deepEqual(
    attempts.map((e) => [e.status, e.retry, e.footprint?.complete, e.footprint?.attempt]),
    [["failed", 0, true, { retry: 0 }], ["failed", 1, true, { retry: 1 }], ["failed", 2, true, { retry: 2 }]],
  );
  const traces = uploadedTraces(peeps.artifacts);
  assert.equal(traces.length, 1, `the first retry's alone: ${traces.join(", ")}`);
  assert.equal(await reportTraceLinks(peeps.artifacts, root), 1);
  const holds = await traceHolds(peeps.artifacts, traces[0]!, root);
  assert.equal(holds.sources, true);
  assert.equal(holds.screencast, true);
});

test("a customer's own on is untouched: every trace stays", async (t) => {
  const app = await appServer(t);
  const root = await suite(t, COMMON('trace: "on",'));
  const peeps = await fakePeeps(t, { collectFootprints: true });
  const result = await runAction(root, peeps.url, { BASE_URL: app });
  assert.equal(result.code, 1, result.output);
  assert.equal(ended(peeps.sent.get("|passes"))[0]!.footprint?.complete, true);
  assert.equal(uploadedTraces(peeps.artifacts).length, 2);
});

test("a project's own use.trace is overridden too, and each project keeps its own policy; two projects send two footprints", async (t) => {
  const app = await appServer(t);
  const root = await suite(
    t,
    `{ testDir: "./specs", outputDir: "./results", workers: 1, retries: 0, timeout: 15000, projects: [
      { name: "off-project", use: { trace: "off" } },
      { name: "keeps-failures", use: { trace: "retain-on-failure" } },
      { name: "inherits" },
    ], use: { baseURL: process.env.BASE_URL, trace: "on" } }`,
  );
  const peeps = await fakePeeps(t, { collectFootprints: true });
  const result = await runAction(root, peeps.url, { BASE_URL: app });
  assert.equal(result.code, 1, result.output);
  for (const project of ["off-project", "keeps-failures", "inherits"]) {
    assert.equal(ended(peeps.sent.get(`${project}|passes`))[0]!.footprint?.complete, true, `${project} recorded: ${result.output}`);
  }
  // inherits: on, both tests. keeps-failures: the failure. off-project: none.
  assert.equal(uploadedTraces(peeps.artifacts).length, 3);
  assert.equal(await reportTraceLinks(peeps.artifacts, root), 3);
});

test("the base URL comes from the project's use when BASE_URL is unset; another host is dropped", async (t) => {
  const app = await appServer(t);
  const spec = `
import { test } from "@playwright/test";
test("passes", async ({ page }) => {
  await page.route("https://stripe.com/**", (route) => route.fulfill({ status: 200, contentType: "application/json", body: "{}" }));
  await page.goto("/cart");
  await page.evaluate(async () => { await new Promise((done) => { const x = new XMLHttpRequest(); x.onloadend = done; x.open("GET", "https://stripe.com/v1/charges"); x.send(); }); });
});
`;
  const root = await suite(t, COMMON(`baseURL: ${JSON.stringify(app)},`), spec);
  const peeps = await fakePeeps(t, { collectFootprints: true });
  const result = await runAction(root, peeps.url);
  assert.equal(result.code, 0, result.output);
  const footprint = ended(peeps.sent.get("|passes"))[0]!.footprint!;
  assert.equal(footprint.complete, true, result.output);
  assert.ok(footprint.paths.includes("/cart"));
  assert.ok(!footprint.paths.some((p) => p.includes("charges")), footprint.paths.join());
});

test("an origin Peeps lists counts as the application's", async (t) => {
  const app = await appServer(t);
  const spec = `
import { test } from "@playwright/test";
test("passes", async ({ page }) => {
  await page.route("https://api.other.io/**", (route) => route.fulfill({ status: 200, contentType: "application/json", body: "{}" }));
  await page.goto("/cart");
  await page.evaluate(() => fetch("https://api.other.io/v1/orders", { mode: "no-cors" }).catch(() => {}));
});
`;
  const root = await suite(t, COMMON(""), spec);
  const peeps = await fakePeeps(t, { collectFootprints: true, footprintOrigins: ["https://api.other.io"] });
  const result = await runAction(root, peeps.url, { BASE_URL: app });
  assert.equal(result.code, 0, result.output);
  const footprint = ended(peeps.sent.get("|passes"))[0]!.footprint!;
  assert.ok(footprint.paths.includes("/v1/orders"), result.output);
  assert.deepEqual(footprint.origins, ["https://api.other.io"], "it says what it filtered with");
});

test("no base URL at all is unknown, and the recording is still deleted", async (t) => {
  const app = await appServer(t);
  const spec = `
import { test } from "@playwright/test";
test("passes", async ({ page }) => { await page.goto(${JSON.stringify(`${app}/cart`)}); });
`;
  const root = await suite(t, COMMON(""), spec);
  const peeps = await fakePeeps(t, { collectFootprints: true });
  const result = await runAction(root, peeps.url);
  assert.equal(result.code, 0, result.output);
  assert.deepEqual(ended(peeps.sent.get("|passes"))[0]!.footprint, { paths: [], complete: false, attempt: { retry: 0 }, origins: [] });
  assert.deepEqual(uploadedTraces(peeps.artifacts), []);
});

test("a test Peeps didn't plan loses Peeps' recording too", async (t) => {
  const app = await appServer(t);
  const root = await suite(t, COMMON(""));
  const peeps = await fakePeeps(t, { collectFootprints: true }, (v) => v.titlePath === "fails");
  const result = await runAction(root, peeps.url, { BASE_URL: app });
  assert.equal(result.code, 1, result.output);
  assert.equal(peeps.sent.get("|fails"), undefined);
  assert.deepEqual(uploadedTraces(peeps.artifacts), []);
  assert.equal(await reportTraceLinks(peeps.artifacts, root), 0);
});

test("a test with no browser has no footprint to give", async (t) => {
  const app = await appServer(t);
  const spec = `import { test } from "@playwright/test";\ntest("passes", async () => {});\n`;
  const root = await suite(t, COMMON(""), spec);
  const peeps = await fakePeeps(t, { collectFootprints: true });
  const result = await runAction(root, peeps.url, { BASE_URL: app });
  assert.equal(result.code, 0, result.output);
  assert.deepEqual(ended(peeps.sent.get("|passes"))[0]!.footprint, { paths: [], complete: false, attempt: { retry: 0 }, origins: [] }, "and still says which attempt it was");
});

test("the request fixture's calls are in the footprint", async (t) => {
  const app = await appServer(t);
  const spec = `
import { test, expect } from "@playwright/test";
test("passes", async ({ request }) => { expect((await request.get("/api/cart")).ok()).toBe(true); });
`;
  const root = await suite(t, COMMON(""), spec);
  const peeps = await fakePeeps(t, { collectFootprints: true });
  const result = await runAction(root, peeps.url, { BASE_URL: app });
  assert.equal(result.code, 0, result.output);
  assert.deepEqual(ended(peeps.sent.get("|passes"))[0]!.footprint, { paths: ["/api/cart"], complete: true, attempt: { retry: 0 }, origins: [] }, result.output);
});

test("eight attempts of the largest footprint fit the events route's limit", async (t) => {
  const app = await appServer(t);
  const spec = `
import { test } from "@playwright/test";
test("fails", async ({ page }) => {
  await page.route("**/api/big/**", (route) => route.fulfill({ status: 200, contentType: "application/json", body: "{}" }));
  await page.goto("/cart");
  await page.evaluate(async () => {
    const segment = "a".repeat(60);
    const seen = [];
    for (let i = 0; i < 300; i++) {
      const name = Array.from(String(i).padStart(3, "0"), (d) => "abcdefghij"[Number(d)]).join("");
      seen.push(fetch("/api/big/" + name + "/" + Array(7).fill(segment).join("/")));
    }
    await Promise.all(seen);
  });
  throw new Error("again");
});
`;
  const root = await suite(t, COMMON("").replace("retries: 0", "retries: 7").replace("timeout: 15000", "timeout: 30000"), spec);
  const peeps = await fakePeeps(t, { collectFootprints: true });
  const result = await runAction(root, peeps.url, { BASE_URL: app });
  assert.equal(result.code, 1, result.output);
  const events = peeps.sent.get("|fails") ?? [];
  assert.equal(ended(events).length, 8, result.output.slice(-800));
  assert.ok(ended(events).every((e) => (e.footprint?.paths.length ?? 0) >= 300), "each attempt's paths, capped");
  assert.equal(events.at(-1)!.type, "run_end", "in order, the close last");
});

test("a repeated test's footprint is never whole: --repeat-each repeats share a run", async (t) => {
  const app = await appServer(t);
  const root = await suite(t, COMMON("").replace("retries: 0", "retries: 0, repeatEach: 2"));
  const peeps = await fakePeeps(t, { collectFootprints: true });
  const result = await runAction(root, peeps.url, { BASE_URL: app });
  assert.equal(result.code, 1, result.output);
  const attempts = ended(peeps.sent.get("|passes"));
  assert.ok(attempts.length >= 1, result.output);
  assert.ok(attempts.every((e) => e.footprint?.complete === false && e.footprint.paths.includes("/cart")), JSON.stringify(attempts));
});

const USES_OWN_TRACE = `
import { test } from "@playwright/test";
test.use({ trace: "on" });
test("passes", async ({ page }) => { await page.goto("/cart"); });
`;

test("a test starting its own tracing still passes on a recorded push", async (t) => {
  const app = await appServer(t);
  const spec = `
import { test } from "@playwright/test";
test("passes", async ({ page, context }) => {
  await context.tracing.start({ screenshots: false });
  await page.goto("/cart");
  await context.tracing.stop();
});
`;
  const root = await suite(t, COMMON(""), spec);
  const peeps = await fakePeeps(t, { collectFootprints: true });
  const result = await runAction(root, peeps.url, { BASE_URL: app });
  assert.equal(result.code, 0, result.output);
  assert.equal(ended(peeps.sent.get("|passes"))[0]!.footprint?.complete, false, "unknown, so it always runs");
});

test("a beforeAll's requests aren't in the trace, so its spec can't claim a whole footprint", async (t) => {
  const app = await appServer(t);
  const spec = `
import { test } from "@playwright/test";
test.beforeAll(async ({ request }) => { await request.get("/api/cart"); });
test("passes", async ({ page }) => { await page.goto("/cart"); });
`;
  const root = await suite(t, COMMON(""), spec);
  const peeps = await fakePeeps(t, { collectFootprints: true });
  const result = await runAction(root, peeps.url, { BASE_URL: app });
  assert.equal(result.code, 0, result.output);
  const footprint = ended(peeps.sent.get("|passes"))[0]!.footprint!;
  assert.equal(footprint.complete, false, JSON.stringify(footprint));
  assert.ok(footprint.paths.includes("/cart"));
});

test("a server that refuses the reach still gets the announce, and the job runs", async (t) => {
  const pr = await mergedPullRequest(t);
  const peeps = await fakePeeps(t, {}, undefined, "on", 413);
  const result = await runAction(pr.root, peeps.url, { GITHUB_SHA: pr.merge, GITHUB_REF: "refs/pull/1/merge", GITHUB_EVENT_NAME: "pull_request" });
  assert.equal(result.code, 0, result.output);
  assert.equal(peeps.announces.at(-1)!.reach, undefined, "sent again without it");
  assert.deepEqual(peeps.completes, [{ reportUploaded: true }], "and says nothing of a reach it didn't send");
});

test("Peeps asks to record: the build's fingerprint goes up first, and a refused receipt still announces and runs", async (t) => {
  const pr = await mergedPullRequest(t);
  for (const [file, text] of nextBuild(NEXT_BUILD)) {
    await mkdir(path.dirname(path.join(pr.root, ".next", file)), { recursive: true });
    await writeFile(path.join(pr.root, ".next", file), text);
  }
  const peeps = await fakePeeps(t, {}, undefined, "collect", 0, 422);
  const result = await runAction(pr.root, peeps.url, { GITHUB_SHA: pr.merge, GITHUB_REF: "refs/pull/1/merge", GITHUB_EVENT_NAME: "pull_request" });
  assert.equal(result.code, 0, result.output);
  assert.equal(peeps.fingerprints.length, 1, "uploaded before the announce");
  assert.equal(new URLSearchParams(peeps.fingerprints[0]).get("base"), pr.base);
  assert.deepEqual((peeps.announces[0]!.impact as { receipts: Array<{ uploadId: string; digest: string }> }).receipts.map((r) => r.uploadId), ["upload-1"]);
  assert.equal(peeps.announces.at(-1)!.impact, undefined, "sent again without it");
  assert.equal(peeps.announces.at(-1)!.reach, undefined);
  assert.deepEqual(peeps.evidence, [], "nothing follows a receipt Peeps refused");
  assert.deepEqual(peeps.completes, [{ reportUploaded: true }]);
  // The key is printed only to mask it, and reaches no announce.
  assert.deepEqual(result.output.split("\n").filter((line) => line.includes(COLLECT_KEY)), [`::add-mask::${COLLECT_KEY}`]);
  assert.ok(peeps.announces.every((announce) => !JSON.stringify(announce).includes(COLLECT_KEY)));
});

/** The fixture Next app's client chunk, served as a build serves it, and a page that runs it. */
async function nextApp(t: TestContext): Promise<string> {
  const build = nextBuild(NEXT_BUILD);
  const page = `<!doctype html><html><head><link rel="stylesheet" href="/_next/static/chunks/${NEXT_BUILD.hash}c3.css"></head><body><div class="Badge-module__badge">b</div>
<script src="/_next/static/chunks/${NEXT_BUILD.hash}c1.js"></script>
<script>
  const exported = {};
  const context = { i: () => ({ badge: "b", ok: "o" }), s: (names) => Object.assign(exported, names), v: () => {} };
  for (const factories of globalThis.TURBOPACK) for (const factory of Object.values(factories[1])) factory(context);
  exported.LoginForm()({ token: "t" });
</script></body></html>`;
  const server = createServer((req, res) => {
    const pathname = new URL(req.url ?? "/", "http://localhost").pathname;
    const body = pathname === "/login" ? page : build.get(pathname.replace(/^\/_next\//, ""));
    if (body === undefined) return void res.writeHead(404).end();
    res.writeHead(200, { "Content-Type": pathname.endsWith(".css") ? "text/css" : pathname.endsWith(".js") ? "text/javascript" : "text/html" }).end(body);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

/** Every regular file under a directory, symlinks not followed. */
async function filesUnder(dir: string): Promise<string[]> {
  const out: string[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...(await filesUnder(full)));
    else if (entry.isFile()) out.push(full);
  }
  return out;
}

test("a push recorded: coverage and paths per test, uploaded under the batch before it completes; the key goes nowhere", async (t) => {
  const app = await nextApp(t);
  const root = await suite(t, COMMON(""), `import { test, expect } from "@playwright/test";
import { writeFileSync } from "node:fs";
test("logs in", async ({ page }) => {
  // The probe: everything a test process can see of its environment.
  writeFileSync(${JSON.stringify("ENV_DUMP")}, JSON.stringify(process.env));
  await page.goto("/login");
  await expect(page.locator(".Badge-module__badge")).toHaveText("b");
});
`);
  await writeFile(path.join(root, ".gitignore"), "node_modules\n.next\nsuite/results\nsuite/playwright-report\nreport*\nenv-dump.json\n");
  for (const [file, text] of nextBuild(NEXT_BUILD)) {
    await mkdir(path.dirname(path.join(root, ".next", file)), { recursive: true });
    await writeFile(path.join(root, ".next", file), text);
  }
  const specFile = path.join(root, "suite/specs/cart.spec.ts");
  await writeFile(specFile, (await readFile(specFile, "utf8")).replace("ENV_DUMP", path.join(root, "env-dump.json")));
  git(root, "init", "-q", "-b", "main");
  git(root, "add", ".");
  git(root, "commit", "-qm", "first");
  const sha = git(root, "rev-parse", "HEAD");
  const peeps = await fakePeeps(t, { collectFootprints: true }, undefined, "collect");
  const result = await runAction(root, peeps.url, { GITHUB_SHA: sha, GITHUB_REF: "refs/heads/main", GITHUB_EVENT_NAME: "push", BASE_URL: app });
  assert.equal(result.code, 0, result.output);

  const [receipt] = (peeps.announces[0]!.impact as { receipts: Array<{ uploadId: string; digest: string }> }).receipts;
  assert.equal(receipt!.uploadId, "upload-1");
  assert.match(receipt!.digest, /^[0-9a-f]{64}$/);
  assert.equal(new URLSearchParams(peeps.fingerprints[0]).get("projectId"), "project");
  assert.equal(new URLSearchParams(peeps.fingerprints[0]).has("base"), false, "a push sends no base");
  // One request, which publishes, before the batch completes (contract §4).
  assert.deepEqual(peeps.order, ["evidence", "complete"], result.output);
  assert.equal(peeps.evidence[0]!.path, "/api/v1/ci/batches/batch/evidence?protocolVersion=2");
  const key = parseProjectKey(COLLECT_KEY)!;
  const blob = decodePayload(gunzipSync(peeps.evidence[0]!.bytes));
  assert.equal(blob.kind, "footprints");
  if (blob.kind !== "footprints") return;
  assert.deepEqual([blob.universe.layers, blob.universe.measured], [["browser"], ["code", "css", "route"]]);
  assert.equal(blob.browser?.name, "chromium");
  assert.match(blob.browser?.version ?? "", /^\d+\.\d+\.\d+\.\d+$/);
  assert.ok(blob.universe.loadedFiles.includes(tokenOf(key, "file:src/app/login/LoginForm.tsx")));
  const [member] = blob.members;
  assert.deepEqual([blob.members.length, member!.run, member!.attempts, member!.partial], [1, "run-0", [{ retry: 0, passed: true }], []], result.output);
  for (const plain of ["fn:browser:src/app/login/LoginForm.tsx:onSuccess", "file:src/app/login/LoginForm.tsx", "css:src/components/common/Badge.module.css"]) {
    assert.ok(member!.tokens.includes(tokenOf(key, plain)), plain);
  }
  assert.ok(member!.tokens.includes(pathToken(key, "/login")));

  // V9: in no line but its mask, no child's environment, no file the job left in RUNNER_TEMP.
  const spellings = [COLLECT_KEY, key.toString("base64url"), key.toString("base64")];
  assert.deepEqual(result.output.split("\n").filter((line) => spellings.some((s) => line.includes(s))), [`::add-mask::${COLLECT_KEY}`, `::add-mask::${key.toString("base64url")}`]);
  const dump = await readFile(path.join(root, "env-dump.json"), "utf8");
  assert.ok(spellings.every((s) => !dump.includes(s)), "a test process's environment");
  for (const file of await filesUnder(root)) {
    const bytes = await readFile(file);
    assert.ok(!bytes.includes(key) && spellings.every((s) => !bytes.includes(s)), file);
  }
  // The scratch directory is gone.
  assert.deepEqual((await readdir(root)).filter((name) => name.startsWith("peeps-evidence-")), []);
});

test("Peeps asks for tables and PEEPS_PG_LOG is set: the job's tables are every test's, as tokens; without the log, nothing changes", async (t) => {
  const app = await nextApp(t);
  const root = await suite(t, COMMON(""), `import { test, expect } from "@playwright/test";
test("logs in", async ({ page }) => {
  await page.goto("/login");
  await expect(page.locator(".Badge-module__badge")).toHaveText("b");
});
`);
  await writeFile(path.join(root, ".gitignore"), "node_modules\n.next\nsuite/results\nsuite/playwright-report\nreport*\n");
  for (const [file, text] of nextBuild(NEXT_BUILD)) {
    await mkdir(path.dirname(path.join(root, ".next", file)), { recursive: true });
    await writeFile(path.join(root, ".next", file), text);
  }
  git(root, "init", "-q", "-b", "main");
  git(root, "add", ".");
  git(root, "commit", "-qm", "first");
  const sha = git(root, "rev-parse", "HEAD");
  const key = parseProjectKey(COLLECT_KEY)!;
  const pgLog = path.join(__dirname, "fixtures/evidence/pg-jsonlog");

  const peeps = await fakePeeps(t, { collectFootprints: true }, undefined, "collect-tables");
  const result = await runAction(root, peeps.url, { GITHUB_SHA: sha, GITHUB_EVENT_NAME: "push", BASE_URL: app, PEEPS_PG_LOG: pgLog });
  assert.equal(result.code, 0, result.output);
  const blob = decodePayload(gunzipSync(peeps.evidence[0]!.bytes));
  assert.ok(blob.kind === "footprints");
  assert.deepEqual([blob.universe.layers, blob.universe.measured], [["browser", "database"], ["code", "css", "route", "table"]], result.output);
  assert.ok(blob.universe.ambient.includes(tokenOf(key, "table:w:public.users")) && blob.universe.ambient.includes(tokenOf(key, "table:r:public.orders")));
  assert.ok(blob.universe.ambient.every((token) => token.startsWith("table:")));
  assert.deepEqual(blob.members[0]!.partial, []);
  // Nothing of the log in the job's output: no table name, statement or value.
  for (const plain of ["audit_log", "public.users", "a@x.io", "INSERT INTO"]) assert.ok(!result.output.includes(plain), plain);

  const without = await fakePeeps(t, { collectFootprints: true }, undefined, "collect-tables");
  const plain = await runAction(root, without.url, { GITHUB_SHA: sha, GITHUB_EVENT_NAME: "push", BASE_URL: app });
  assert.equal(plain.code, 0, plain.output);
  const today = decodePayload(gunzipSync(without.evidence[0]!.bytes));
  assert.ok(today.kind === "footprints");
  assert.deepEqual([today.universe.layers, today.universe.measured, today.universe.ambient], [["browser"], ["code", "css", "route"], []]);
});

test("a suite that runs precise coverage itself is not collected: routes only, and it says why", async (t) => {
  const app = await nextApp(t);
  const root = await suite(t, COMMON(""), `import { test, expect } from "@playwright/test";
test("logs in", async ({ page }) => {
  await page.coverage.startJSCoverage();
  await page.goto("/login");
  await expect(page.locator(".Badge-module__badge")).toHaveText("b");
});
`);
  await writeFile(path.join(root, ".gitignore"), "node_modules\n.next\nsuite/results\nsuite/playwright-report\nreport*\n");
  for (const [file, text] of nextBuild(NEXT_BUILD)) {
    await mkdir(path.dirname(path.join(root, ".next", file)), { recursive: true });
    await writeFile(path.join(root, ".next", file), text);
  }
  git(root, "init", "-q", "-b", "main");
  git(root, "add", ".");
  git(root, "commit", "-qm", "first");
  const peeps = await fakePeeps(t, { collectFootprints: true }, undefined, "collect");
  const result = await runAction(root, peeps.url, { GITHUB_SHA: git(root, "rev-parse", "HEAD"), GITHUB_REF: "refs/heads/main", GITHUB_EVENT_NAME: "push", BASE_URL: app });
  assert.equal(result.code, 0, result.output);
  assert.match(result.output, /not recording browser coverage: .*cart\.spec\.ts runs precise coverage itself/);
  const blob = decodePayload(gunzipSync(peeps.evidence[0]!.bytes));
  assert.ok(blob.kind === "footprints" && JSON.stringify(blob.universe.measured) === JSON.stringify(["route"]), JSON.stringify(blob));
});

test("evidence that can't be read is dropped, and the batch still completes", async (t) => {
  const app = await nextApp(t);
  const root = await suite(t, COMMON(""), `import { test, expect } from "@playwright/test";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
test("logs in", async ({ page }) => {
  // A record the action can't read, planted where the worker writes.
  const { evidence } = JSON.parse(readFileSync(process.env.PEEPS_PLAN_FILE, "utf8"));
  writeFileSync(path.join(evidence.dir, "cov-0000000000000000-0-planted.json"), JSON.stringify({ testId: test.info().testId, retry: 0, contextId: "planted", coverage: null }));
  await page.goto("/login");
  await expect(page.locator(".Badge-module__badge")).toHaveText("b");
});
`);
  await writeFile(path.join(root, ".gitignore"), "node_modules\n.next\nsuite/results\nsuite/playwright-report\nreport*\n");
  for (const [file, text] of nextBuild(NEXT_BUILD)) {
    await mkdir(path.dirname(path.join(root, ".next", file)), { recursive: true });
    await writeFile(path.join(root, ".next", file), text);
  }
  git(root, "init", "-q", "-b", "main");
  git(root, "add", ".");
  git(root, "commit", "-qm", "first");
  const peeps = await fakePeeps(t, { collectFootprints: true }, undefined, "collect");
  const result = await runAction(root, peeps.url, { GITHUB_SHA: git(root, "rev-parse", "HEAD"), GITHUB_REF: "refs/heads/main", GITHUB_EVENT_NAME: "push", BASE_URL: app });
  assert.equal(result.code, 0, result.output);
  assert.deepEqual(peeps.evidence, []);
  assert.deepEqual(peeps.completes, [{ reportUploaded: true }]);
  assert.match(result.output, /not recording what this job's tests ran: its evidence couldn't be read/);
});

test("a scratch directory gone by the end drops the evidence, and a passing run still passes and completes", async (t) => {
  const app = await nextApp(t);
  const root = await suite(t, COMMON(""), `import { test, expect } from "@playwright/test";
import { readFileSync, rmSync } from "node:fs";
test("logs in", async ({ page }) => {
  await page.goto("/login");
  await expect(page.locator(".Badge-module__badge")).toHaveText("b");
  // Gone before the action reads it: the runner's temp cleaned, a disk filled.
  rmSync(JSON.parse(readFileSync(process.env.PEEPS_PLAN_FILE, "utf8")).evidence.dir, { recursive: true, force: true });
});
`);
  await writeFile(path.join(root, ".gitignore"), "node_modules\n.next\nsuite/results\nsuite/playwright-report\nreport*\n");
  for (const [file, text] of nextBuild(NEXT_BUILD)) {
    await mkdir(path.dirname(path.join(root, ".next", file)), { recursive: true });
    await writeFile(path.join(root, ".next", file), text);
  }
  git(root, "init", "-q", "-b", "main");
  git(root, "add", ".");
  git(root, "commit", "-qm", "first");
  const peeps = await fakePeeps(t, { collectFootprints: true }, undefined, "collect");
  const result = await runAction(root, peeps.url, { GITHUB_SHA: git(root, "rev-parse", "HEAD"), GITHUB_REF: "refs/heads/main", GITHUB_EVENT_NAME: "push", BASE_URL: app });
  assert.equal(result.code, 0, result.output);
  assert.deepEqual(peeps.evidence, []);
  assert.deepEqual(peeps.completes, [{ reportUploaded: true }]);
  assert.match(result.output, /not recording what this job's tests ran/);
});

test("git runs under the budget: past it, everything runs", async (t) => {
  const pr = await mergedPullRequest(t);
  const env = readRunnerEnv({ GITHUB_WORKSPACE: pr.root, GITHUB_SHA: pr.merge, GITHUB_EVENT_NAME: "pull_request", GITHUB_REF: "refs/pull/1/merge" });
  const late = await computeReach(env, { specFiles: [] }, { budgetMs: 0 });
  assert.equal(late?.global, true);
});

test("a spec setting its own trace keeps it: Peeps can't read that policy, so it records nothing and deletes nothing", async (t) => {
  const app = await appServer(t);
  const root = await suite(t, COMMON(""), USES_OWN_TRACE);
  const peeps = await fakePeeps(t, { collectFootprints: true });
  const result = await runAction(root, peeps.url, { BASE_URL: app });
  assert.equal(result.code, 0, result.output);
  assert.equal(uploadedTraces(peeps.artifacts).length, 1, `the customer's trace stays: ${result.output}`);
});

test("a helper a spec imports setting its own trace counts too; a test with no trace of its own reads unknown", async (t) => {
  const app = await appServer(t);
  const spec = `
import { test } from "./fixtures/base";
test("passes", async ({ page }) => { await page.goto("/cart"); });
`;
  const root = await suite(t, COMMON(""), spec);
  await mkdir(path.join(root, "suite/specs/fixtures"), { recursive: true });
  await writeFile(path.join(root, "suite/specs/fixtures/base.ts"), `import { test as base } from "@playwright/test";\nbase.use({ trace: "retain-on-failure" });\nexport const test = base;\n`);
  const peeps = await fakePeeps(t, { collectFootprints: true });
  const result = await runAction(root, peeps.url, { BASE_URL: app });
  assert.equal(result.code, 0, result.output);
  assert.deepEqual(uploadedTraces(peeps.artifacts), [], "nothing was recorded for Peeps");
  assert.equal(ended(peeps.sent.get("|passes"))[0]!.footprint?.complete, false, "so it always runs");
});

test("a global setup's requests leave every test unknown, and recording stays on", async (t) => {
  const app = await appServer(t);
  const root = await suite(t, COMMON("", `globalSetup: "./setup.ts",`));
  await writeFile(path.join(root, "suite/setup.ts"), `export default async () => { await fetch(process.env.BASE_URL + "/api/cart"); };\n`);
  const peeps = await fakePeeps(t, { collectFootprints: true });
  const result = await runAction(root, peeps.url, { BASE_URL: app });
  assert.equal(result.code, 1, result.output);
  const footprint = ended(peeps.sent.get("|passes"))[0]!.footprint!;
  assert.equal(footprint.complete, false, JSON.stringify(footprint));
  assert.ok(footprint.paths.includes("/cart"), "it still recorded");
});

test("says why it isn't recording", async (t) => {
  const app = await appServer(t);
  const root = await suite(t, COMMON(""), USES_OWN_TRACE);
  const peeps = await fakePeeps(t, { collectFootprints: true });
  const result = await runAction(root, peeps.url, { BASE_URL: app });
  assert.match(result.output, /not recording footprints: suite\/specs\/cart\.spec\.ts: /);
});

test("attach mode's wrapper never loads: no footprint, even when Peeps asks, and the trace stays off", async (t) => {
  const app = await appServer(t);
  const root = await suite(t, COMMON(""));
  const peeps = await fakePeeps(t, { collectFootprints: true });
  const githubEnv = path.join(root, "github-env");
  const started = await runAction(root, peeps.url, { INPUT_MODE: "attach-start", GITHUB_ENV: githubEnv });
  assert.equal(started.code, 0, started.output);
  const config = /PEEPS_ATTACH_CONFIG=(.*)/.exec(await readFile(githubEnv, "utf8"))?.[1];
  assert.ok(config, started.output);
  const child = spawn(process.execPath, [path.join(modules, "@playwright/test/cli.js"), "test", "--config", config], {
    cwd: path.join(root, "suite"),
    env: { ...process.env, CI: "1", GITHUB_WORKSPACE: root, GITHUB_SHA: "0123456789abcdef0123456789abcdef01234567", GITHUB_REF: "refs/heads/main", BASE_URL: app, PEEPS_API_URL: peeps.url, PEEPS_API_KEY: "fake-test-key", GITHUB_EVENT_NAME: "" },
    stdio: "ignore",
  });
  await new Promise((resolve) => child.on("close", resolve));
  const attempts = ended(peeps.sent.get("|passes"));
  assert.equal(attempts.length, 1, "the run was reported");
  assert.equal(attempts[0]!.footprint, undefined);
  assert.equal(peeps.announces[0]!.reach, undefined);
});

// ---------------------------------------------------------------------------
// The reach, on a real merge checkout
// ---------------------------------------------------------------------------

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1", GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@e.com", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@e.com" },
  }).trim();
}

const SERVER = [
  'const express = require("express");',
  "const app = express();",
  'app.get("/cart", (req, res) => {',
  "  res.send(1);",
  "});",
  'app.get("/catalog", (req, res) => res.send(2));',
  "",
].join("\n");

/** A repository with an Express app beside its suite, and a merge commit changing the cart handler. */
async function mergedPullRequest(t: TestContext) {
  const root = await suite(t, COMMON(""), `import { test } from "@playwright/test";\ntest("passes", async () => {});\n`);
  await writeFile(path.join(root, ".gitignore"), "node_modules\nsuite/results\nsuite/playwright-report\nreport*\none-trace.zip\n");
  await writeFile(path.join(root, "package.json"), '{"dependencies":{"express":"5"}}\n');
  await writeFile(path.join(root, "server.js"), SERVER);
  git(root, "init", "-q", "-b", "main");
  git(root, "add", ".");
  git(root, "commit", "-qm", "first");
  const base = git(root, "rev-parse", "HEAD");
  git(root, "checkout", "-qb", "change");
  await writeFile(path.join(root, "server.js"), SERVER.replace("res.send(1)", "res.send(100)"));
  git(root, "commit", "-qam", "cart");
  git(root, "checkout", "-q", "main");
  git(root, "merge", "-q", "--no-ff", "-m", "merge", "change");
  return { root, base, merge: git(root, "rev-parse", "HEAD") };
}

test("a pull request's job sends its reach and says what it ran; no source goes with it", async (t) => {
  const pr = await mergedPullRequest(t);
  const peeps = await fakePeeps(t, {}, undefined, "on");
  const result = await runAction(pr.root, peeps.url, { GITHUB_SHA: pr.merge, GITHUB_REF: "refs/pull/1/merge", GITHUB_EVENT_NAME: "pull_request" });
  assert.equal(result.code, 0, result.output);
  assert.deepEqual(peeps.announces[0]!.reach, {
    global: false,
    why: null,
    surfaces: ["/cart"],
    reasons: [{ surface: "/cart", file: "server.js" }],
    changedFiles: ["server.js"],
    changedTestFiles: [],
    base: pr.base,
  });
  assert.ok(!JSON.stringify(peeps.announces[0]!.reach).includes("res.send"));
  assert.equal(peeps.announces[0]!.canNarrow, true);
  assert.equal(peeps.announces[0]!.protocolVersion, 2, "the protocol this action speaks");
  assert.deepEqual(peeps.completes, [{ reportUploaded: true, executed: { mode: "full", tests: 1 } }]);
});

test("a server on a later protocol hears this action's own version, 2, and gets the reach", async (t) => {
  const pr = await mergedPullRequest(t);
  const peeps = await fakePeeps(t, {}, undefined, "v3");
  const result = await runAction(pr.root, peeps.url, { GITHUB_SHA: pr.merge, GITHUB_REF: "refs/pull/1/merge", GITHUB_EVENT_NAME: "pull_request" });
  assert.equal(result.code, 0, result.output);
  assert.equal(peeps.announces[0]!.canNarrow, true);
  assert.equal(peeps.announces[0]!.protocolVersion, 2);
  assert.notEqual(peeps.announces[0]!.reach, undefined);
});

test("a job that checks out the pull request's head reads not_merge, and the run goes on", async (t) => {
  const pr = await mergedPullRequest(t);
  git(pr.root, "checkout", "-q", "change");
  const head = git(pr.root, "rev-parse", "HEAD");
  const peeps = await fakePeeps(t, {}, undefined, "on");
  const result = await runAction(pr.root, peeps.url, { GITHUB_SHA: head, GITHUB_REF: "refs/pull/1/merge", GITHUB_EVENT_NAME: "pull_request" });
  assert.equal(result.code, 0, result.output);
  assert.deepEqual(peeps.announces[0]!.reach, { global: true, why: "not_merge", surfaces: [], reasons: [], changedFiles: [], changedTestFiles: [], base: null });
});

for (const answer of ["off", "legacy", "missing", "error", "garbage", "hang"] as const) {
  test(`a preflight answering ${answer} means no scan, and a run identical to today's`, async (t) => {
    const pr = await mergedPullRequest(t);
    const peeps = await fakePeeps(t, {}, undefined, answer);
    const started = Date.now();
    const result = await runAction(pr.root, peeps.url, { GITHUB_SHA: pr.merge, GITHUB_REF: "refs/pull/1/merge", GITHUB_EVENT_NAME: "pull_request" });
    assert.equal(result.code, 0, result.output);
    assert.deepEqual(peeps.preflights, ["GET"], "one request");
    assert.equal(peeps.announces[0]!.reach, undefined);
    assert.deepEqual(peeps.completes, [{ reportUploaded: true }], "today's body");
    assert.doesNotMatch(result.output, /\[peeps\] reach/);
    if (answer === "hang") assert.ok(Date.now() - started < 60_000, "bounded");
    // Only a server that answered protocol 2 hears that this job could narrow.
    const negotiated = answer === "off";
    assert.equal(peeps.announces[0]!.canNarrow, negotiated ? true : undefined);
    assert.equal(peeps.announces[0]!.protocolVersion, negotiated ? 2 : undefined);
  });
}

test("a push asks too, so it records with the protocol it'll use, and scans nothing", async (t) => {
  const pr = await mergedPullRequest(t);
  const peeps = await fakePeeps(t, {}, undefined, "on");
  const result = await runAction(pr.root, peeps.url, { GITHUB_SHA: pr.merge, GITHUB_REF: "refs/heads/main", GITHUB_EVENT_NAME: "push" });
  assert.equal(result.code, 0, result.output);
  assert.deepEqual(peeps.preflights, ["GET"]);
  assert.equal(peeps.announces[0]!.reach, undefined);
  assert.equal(peeps.announces[0]!.protocolVersion, 2);
});

test("GitLab sends no reach, whatever its event", async (t) => {
  const pr = await mergedPullRequest(t);
  const peeps = await fakePeeps(t, {}, undefined, "on");
  const result = await runAction(pr.root, peeps.url, {
    GITLAB_CI: "true", CI_PROJECT_DIR: pr.root, CI_COMMIT_SHA: pr.merge, CI_PROJECT_PATH: "test/repo", CI_PIPELINE_SOURCE: "merge_request_event",
    PEEPS_MODE: "report", PEEPS_PLAYWRIGHT_CONFIG: "suite/playwright.config.ts", PEEPS_ID_TOKEN: "fake-gitlab-id-token",
  });
  assert.equal(result.code, 0, result.output);
  assert.equal(peeps.announces[0]!.reach, undefined);
  assert.deepEqual(peeps.preflights, []);
});

test("a targeted run says so", async (t) => {
  const pr = await mergedPullRequest(t);
  await writeFile(path.join(pr.root, "suite/specs/cart.spec.ts"), `import { test } from "@playwright/test";\ntest("passes", async () => {});\ntest("other", async () => { throw new Error("not selected"); });\n`);
  git(pr.root, "commit", "-qam", "two tests", "--amend");
  const merge = git(pr.root, "rev-parse", "HEAD");
  const peeps = await fakePeeps(t, { narrowed: true }, undefined, "on");
  const result = await runAction(pr.root, peeps.url, { GITHUB_SHA: merge, GITHUB_REF: "refs/pull/1/merge", GITHUB_EVENT_NAME: "pull_request" });
  assert.notEqual(peeps.announces[0]!.reach, undefined, result.output);
  assert.deepEqual(peeps.completes[0]!.executed, { mode: "targeted", tests: 2 }, result.output);
});

test("a scanner that dies or overruns reads global, and doesn't fail the job", async (t) => {
  const pr = await mergedPullRequest(t);
  const env = readRunnerEnv({ GITHUB_WORKSPACE: pr.root, GITHUB_SHA: pr.merge, GITHUB_EVENT_NAME: "pull_request", GITHUB_REF: "refs/pull/1/merge" });
  const dead = path.join(pr.root, "dead.js");
  await writeFile(dead, "process.exit(3);\n");
  const failed = await computeReach(env, { specFiles: [] }, { scanner: dead });
  assert.equal(failed?.global, true);
  assert.equal(failed?.why, "scan_failed");
  assert.equal(failed?.base, pr.base);
  const slow = path.join(pr.root, "slow.js");
  await writeFile(slow, "for (;;) {}\n");
  const started = Date.now();
  const late = await computeReach(env, { specFiles: [] }, { scanner: slow, budgetMs: 1500 });
  assert.equal(late?.why, "timeout", "a parse in progress can't be interrupted except by killing it");
  assert.ok(Date.now() - started < 10_000);
  const garbage = path.join(pr.root, "garbage.js");
  await writeFile(garbage, 'process.stdout.write("not json");\n');
  assert.equal((await computeReach(env, { specFiles: [] }, { scanner: garbage }))?.why, "scan_failed");
});

test("a push and a non-GitHub platform compute nothing", async () => {
  const base = { GITHUB_WORKSPACE: "/nowhere", GITHUB_SHA: "a".repeat(40) };
  assert.equal(await computeReach(readRunnerEnv({ ...base, GITHUB_EVENT_NAME: "push" }), { specFiles: [] }), undefined);
  assert.equal(await computeReach(readRunnerEnv({ ...base, GITHUB_EVENT_NAME: "pull_request_target" }), { specFiles: [] }), undefined);
  assert.equal(await computeReach(readRunnerEnv({ GITLAB_CI: "true", CI_COMMIT_SHA: "a".repeat(40), CI_PIPELINE_SOURCE: "merge_request_event" }), { specFiles: [] }), undefined);
});

/**
 * PQA-3201 PR 3. The app the action owns: built server code from the fake `.next`, a factory
 * run at boot (ambient), and per page the server code that page needs.
 */
const OWNED_APP = (ssr: string) => `globalThis.document = { currentScript: null };
globalThis.sessionStorage = { setItem() {} };
require(${JSON.stringify(ssr)});
require("node:fs").appendFileSync("starts.log", process.env.PEEPS_INVOCATION + "\\n");
const factories = Object.assign({}, ...globalThis.TURBOPACK.map((entry) => entry[1]));
const run = (name) => {
  const exported = {};
  factories[name]({ i: () => ({ badge: "b" }), s: (names) => Object.assign(exported, names), v: () => {} });
  return exported;
};
run("[project]/src/components/common/Badge.module.css [ssr] (css module)");
require("node:http").createServer((req, res) => {
  if (req.url === "/login") run("turbopack:///[project]/src/app/login/LoginForm.tsx").LoginForm()({ token: "t" });
  if (req.url === "/badge") run("turbopack:///[project]/src/components/common/Badge.tsx").default()({ variant: "ok" });
  res.writeHead(200, { "Content-Type": "text/html" });
  res.end("<h1>ok</h1>");
}).listen(Number(process.env.APP_PORT), "127.0.0.1");
`;

test("server evidence: one invocation per spec file with the app the action owns; each test holds its own file's server code (PQA-3201 PR 3)", async (t) => {
  const port = await new Promise<number>((resolve) => {
    const probe = createServer().listen(0, "127.0.0.1", () => {
      const { port } = probe.address() as AddressInfo;
      probe.close(() => resolve(port));
    });
  });
  const app = `http://127.0.0.1:${port}`;
  // Two test files per run, in file order: [api, badge] reach /login, [cart, shared] reach /badge.
  const root = await suite(t, COMMON("", "webServer: { command: \"exit 1\", url: \"http://127.0.0.1:9\" },"), `import { test, expect } from "@playwright/test";
test("shows a badge", async ({ page }) => { await page.goto("/badge"); await expect(page.getByRole("heading")).toHaveText("ok"); });
`);
  await writeFile(path.join(root, "suite/specs/badge.spec.ts"), `import { test, expect } from "@playwright/test";
test("logs in", async ({ page }) => {
  require("node:fs").appendFileSync(${JSON.stringify(path.join(root, "test-invocations.log"))}, process.env.PEEPS_INVOCATION + "\\n");
  await page.goto("/login");
  await expect(page.getByRole("heading")).toHaveText("ok");
});
`);
  // A test registered by a shared helper: it runs in the importing file's run, and is that file's.
  await mkdir(path.join(root, "suite/helpers"), { recursive: true });
  await writeFile(path.join(root, "suite/helpers/shared.ts"), `import { test, expect } from "@playwright/test";
export function sharedBadgeTest() { test("shared badge", async ({ page }) => { await page.goto("/badge"); await expect(page.getByRole("heading")).toHaveText("ok"); }); }
`);
  await writeFile(path.join(root, "suite/specs/shared.spec.ts"), `import { sharedBadgeTest } from "../helpers/shared";
sharedBadgeTest();
`);
  await writeFile(path.join(root, "suite/specs/api.spec.ts"), `import { test, expect } from "@playwright/test";
test("calls the api", async ({ request }) => { expect((await request.get("/login")).ok()).toBe(true); });
`);
  await writeFile(path.join(root, ".gitignore"), "node_modules\n.next\nsuite/results\nsuite/playwright-report\nreport*\n*.log\n");
  for (const [file, text] of nextBuild(NEXT_BUILD)) {
    await mkdir(path.dirname(path.join(root, ".next", file)), { recursive: true });
    await writeFile(path.join(root, ".next", file), text);
  }
  // Stands in for `next start`, which runs from node_modules: the runtime, no one's code. (A custom
  // server in the app's own source would read partial, outside_build.)
  await mkdir(path.join(root, "vendor/node_modules/fake-next"), { recursive: true });
  await writeFile(path.join(root, "vendor/node_modules/fake-next/start.cjs"), OWNED_APP(path.join(root, ".next", `server/chunks/ssr/${NEXT_BUILD.hash}s1.js`)));
  git(root, "init", "-q", "-b", "main");
  git(root, "add", ".");
  git(root, "commit", "-qm", "first");
  const peeps = await fakePeeps(t, {}, undefined, "collect");
  const result = await runAction(root, peeps.url, {
    GITHUB_SHA: git(root, "rev-parse", "HEAD"), GITHUB_REF: "refs/heads/main", GITHUB_EVENT_NAME: "push", BASE_URL: app, APP_PORT: String(port),
    "INPUT_APP-START": "node vendor/node_modules/fake-next/start.cjs", "INPUT_APP-READY-URL": `${app}/ready`, "INPUT_APP-RESET": "echo \"$PEEPS_INVOCATION\" >> resets.log",
  });
  assert.equal(result.code, 0, result.output);
  // Ambient first, then each of the three spec files, each reset and started on its own; the config's webServer never ran.
  // Four test files in runs of two, never a file of its own for the helper that registers a test.
  assert.deepEqual((await readFile(path.join(root, "resets.log"), "utf8")).trim().split("\n"), ["ambient", "spec", "spec"]);
  assert.deepEqual((await readFile(path.join(root, "starts.log"), "utf8")).trim().split("\n"), ["ambient", "spec", "spec"]);
  assert.deepEqual((await readFile(path.join(root, "test-invocations.log"), "utf8")).trim().split("\n"), ["spec"], "the tests see which run they're in");
  // The invocations' reports, merged into the one HTML report the batch gets.
  assert.ok([...peeps.artifacts.keys()].includes("index.html"), [...peeps.artifacts.keys()].join(", "));

  const key = parseProjectKey(COLLECT_KEY)!;
  const blob = decodePayload(gunzipSync(peeps.evidence[0]!.bytes));
  assert.ok(blob.kind === "footprints");
  if (blob.kind !== "footprints") return;
  assert.deepEqual([blob.universe.layers, blob.universe.measured], [["browser", "server"], ["code", "css"]]);
  const css = "fn:server:src/components/common/Badge.module.css:[project]/src/components/common/Badge.module.css [ssr] (css module)";
  const login = "fn:server:src/app/login/LoginForm.tsx:onSuccess";
  const badge = "fn:server:src/components/common/Badge.tsx:Badge";
  assert.ok(blob.universe.ambient.includes(tokenOf(key, css)), "what the app ran at boot is ambient");
  assert.ok(!blob.universe.ambient.includes(tokenOf(key, login)));
  const member = (title: string) => {
    const run = [...Array(4).keys()].map((i) => `run-${i}`).find((r) => blob.members.some((m) => m.run === r) && peeps.announces[0] && (peeps.announces[0].tests as Planned[])[Number(r.slice(4))]!.titlePath === title)!;
    return blob.members.find((m) => m.run === run)!;
  };
  const logsIn = member("logs in");
  const showsBadge = member("shows a badge");
  assert.deepEqual([logsIn.partial, showsBadge.partial], [[], []], result.output);
  assert.ok(logsIn.tokens.includes(tokenOf(key, login)) && logsIn.tokens.includes(tokenOf(key, "file:src/app/login/LoginForm.tsx")));
  assert.ok(!logsIn.tokens.includes(tokenOf(key, badge)), "another file's invocation ran Badge, not this one's");
  assert.ok(showsBadge.tokens.includes(tokenOf(key, badge)) && !showsBadge.tokens.includes(tokenOf(key, login)));
  // A test that opens no browser context has no browser coverage: partial in the browser only (PQA-3430),
  // so a server-only change still judges it by its server footprint, which holds what /login ran.
  const api = member("calls the api");
  assert.deepEqual([api.partial, api.partialLayers], [["code", "css"], ["browser"]]);
  assert.ok(api.tokens.includes(tokenOf(key, login)));
  assert.deepEqual([logsIn.partialLayers, showsBadge.partialLayers], [[], []]);
  const shared = member("shared badge");
  assert.deepEqual(shared.partial, [], "its file's run, not another's");
  assert.ok(shared.tokens.includes(tokenOf(key, badge)));
});
