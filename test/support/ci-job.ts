/**
 * Runs the committed action around real Playwright or pytest against a fake Peeps that behaves
 * as the real one does where it matters here: one batch per project, and each run's credential
 * good for that run alone (a mismatch answers 401). Nothing here starts a browser.
 */
import { type TestContext } from "node:test";
import { spawn, spawnSync } from "node:child_process";
import { cp, mkdir, mkdtemp, readdir, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";

const action = path.resolve(__dirname, "../../dist/index.js");
const modules = path.resolve(__dirname, "../../node_modules");
const cli = path.join(modules, "playwright/cli.js");
export const SHA = "0123456789abcdef0123456789abcdef01234567";

export interface Planned { path: string; titlePath: string; pwProject: string }
export interface Sent {
  type: string;
  timestamp?: number;
  testName?: string;
  status?: string;
  duration?: number;
  error?: string;
  errorStack?: string;
  retry?: number;
}
export interface PeepsRequest { pathname: string; artifact: string | null; authorization: string | null; text: string }
export interface BatchSpec { name: string; picks: (test: Planned) => boolean }

const KEPT_FROM_THE_MACHINE = ["PLAYWRIGHT_BROWSERS_PATH", "PEEPS_PYTHON"];

export const signatureOf = (runId: string) => `signature-of-${runId}`;
const everyTest = (): boolean => true;

/** The suite under `suite/`, with node_modules reachable as a customer's would be. */
export async function suite(t: TestContext, files: Record<string, string>): Promise<string> {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), "peeps-job-")));
  t.after(() => rm(root, { recursive: true, force: true }));
  await symlink(modules, path.join(root, "node_modules"), "dir");
  for (const [name, content] of Object.entries(files)) {
    const file = path.join(root, "suite", name);
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, content);
  }
  return root;
}

export interface FakePeepsOptions {
  /** One entry per project the repository's job reaches, in the order Peeps answers. */
  batches?: BatchSpec[];
  /** An events POST for these runs answers this status, whatever its credential. */
  refuseEvents?: (runId: string) => number | null;
  /** Called on each report file received, before it is answered. */
  onArtifact?: (batchId: string, artifact: string) => Promise<void>;
  /** Holds the plan's answer, so a run's first events arrive before it. */
  planDelayMs?: number;
  /** Holds each events POST, so overlapping deliveries can be seen. */
  eventDelayMs?: number;
}

export async function fakePeeps(t: TestContext, options: FakePeepsOptions = {}) {
  const batches = options.batches ?? [{ name: "only", picks: everyTest }];
  const requests: PeepsRequest[] = [];
  let eventsInFlight = 0;
  let widest = 0;
  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    const text = Buffer.concat(chunks).toString();
    const authorization = req.headers.authorization ?? null;
    const artifact = url.searchParams.get("path");
    requests.push({ pathname: url.pathname, artifact, authorization, text });
    const answer = (status: number, body: unknown) => {
      res.writeHead(status, { "Content-Type": "application/json" });
      res.end(JSON.stringify(body));
    };
    if (url.pathname === "/api/v1/ci/batches") {
      const input = JSON.parse(text) as { tests: Planned[] };
      if (options.planDelayMs) await new Promise((r) => setTimeout(r, options.planDelayMs));
      answer(200, {
        batches: batches.map((b, n) => ({
          projectId: `project-${b.name}`,
          batchId: `batch-${b.name}`,
          batchNumber: n + 1,
          runs: input.tests.filter(b.picks).map((v) => {
            const runId = `${b.name}-${v.titlePath.replace(/\W+/g, "_")}`;
            return { ...v, runId, credential: { exp: 99, sig: signatureOf(runId) } };
          }),
          unmatched: [],
        })),
      });
      return;
    }
    const eventsFor = /^\/api\/v1\/runs\/([^/]+)\/events$/.exec(url.pathname)?.[1];
    if (eventsFor) {
      if (options.eventDelayMs) {
        widest = Math.max(widest, ++eventsInFlight);
        await new Promise((r) => setTimeout(r, options.eventDelayMs));
        eventsInFlight -= 1;
      }
      const refused = options.refuseEvents?.(eventsFor) ?? null;
      if (refused !== null) return answer(refused, { error: "refused" });
      if (authorization !== `Bearer v1.99.${signatureOf(eventsFor)}`) return answer(401, { error: "invalid_token" });
      return answer(200, {});
    }
    const uploadTo = /^\/api\/v1\/ci\/batches\/([^/]+)\/artifacts$/.exec(url.pathname)?.[1];
    if (uploadTo && artifact) await options.onArtifact?.(uploadTo, artifact);
    answer(200, {});
  });
  server.keepAliveTimeout = 1;
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise<void>((resolve) => {
    server.closeAllConnections();
    server.close(() => resolve());
  }));
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, requests, widestEventDelivery: () => widest };
}

/** The suite under `suite/`, copied from a fixture directory. */
export async function suiteFrom(t: TestContext, fixture: string): Promise<string> {
  const root = await suite(t, {});
  await cp(fixture, path.join(root, "suite"), { recursive: true });
  return root;
}

/** The job's environment: fake CI only, nothing from this machine's own CI or Peeps setup. */
function jobEnv(root: string, peepsUrl: string, extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  const env = { ...process.env };
  for (const name of Object.keys(env)) {
    if (/^(?:GITHUB_|GITLAB_|CI_|ACTIONS_|INPUT_|PEEPS_|PLAYWRIGHT_)/.test(name) && !KEPT_FROM_THE_MACHINE.includes(name)) delete env[name];
  }
  return {
    ...env,
    CI: "1", GITHUB_WORKSPACE: root, GITHUB_SHA: SHA, GITHUB_REF: "refs/heads/feature",
    GITHUB_ENV: path.join(root, "github-env"), RUNNER_TEMP: root,
    PEEPS_API_URL: peepsUrl, PEEPS_API_KEY: "fake-test-key", ...extra,
  };
}

async function spawnNode(args: string[], cwd: string, env: NodeJS.ProcessEnv) {
  const child = spawn(process.execPath, args, { cwd, env, stdio: ["ignore", "pipe", "pipe"] });
  let output = "";
  child.stdout.on("data", (v: Buffer) => { output += v.toString(); });
  child.stderr.on("data", (v: Buffer) => { output += v.toString(); });
  const timer = setTimeout(() => child.kill("SIGKILL"), 120_000);
  try {
    const code = await new Promise<number | null>((resolve, reject) => {
      child.on("error", reject);
      child.on("close", resolve);
    });
    return { code, output };
  } finally { clearTimeout(timer); }
}

/** `mode: report`: the action lists the tests, plans them and runs Playwright itself. */
export function reportJob(root: string, peepsUrl: string) {
  return spawnNode([action], root, {
    ...jobEnv(root, peepsUrl),
    INPUT_MODE: "report", INPUT_FRAMEWORK: "playwright", INPUT_CONFIG: "suite/playwright.config.ts",
  });
}

/** `mode: report` for a pytest suite under `suite/`. */
export function pytestJob(root: string, peepsUrl: string, extra: NodeJS.ProcessEnv = {}) {
  return spawnNode([action], root, {
    ...jobEnv(root, peepsUrl, extra),
    INPUT_MODE: "report", INPUT_FRAMEWORK: "pytest", "INPUT_WORKING-DIRECTORY": "suite",
  });
}

/** attach-start, the customer's own test step, attach-finish. */
export async function attachJob(root: string, peepsUrl: string) {
  const env = jobEnv(root, peepsUrl, { PEEPS_ATTACH_DEADLINE_MS: "20000" });
  const stepDir = path.join(root, "suite");
  const start = await spawnNode([action], root, { ...env, INPUT_MODE: "attach-start", "INPUT_WORKING-DIRECTORY": "suite" });
  const exported = Object.fromEntries(
    (await readFile(path.join(root, "github-env"), "utf8")).split("\n").filter(Boolean).map((line) => {
      const at = line.indexOf("=");
      return [line.slice(0, at), line.slice(at + 1)];
    }),
  );
  const stepEnv = { ...env, ...exported };
  const run = await spawnNode([cli, "test", "--config", exported.PEEPS_ATTACH_CONFIG!], stepDir, stepEnv);
  const finish = await spawnNode([action], root, { ...stepEnv, INPUT_MODE: "attach-finish" });
  return { code: run.code, output: [start.output, run.output, finish.output].join("\n") };
}

/** Where `mode: report` put this job's HTML report. */
export async function reportDirOf(root: string): Promise<string> {
  const scratch = (await readdir(root)).find((name) => name.startsWith("peeps-") && !name.startsWith("peeps-attach-"));
  if (!scratch) throw new Error(`no report scratch directory in ${root}`);
  return path.join(root, scratch, "report");
}

export function eventsByRun(requests: PeepsRequest[]): Map<string, Sent[]> {
  const out = new Map<string, Sent[]>();
  for (const request of requests) {
    const runId = /^\/api\/v1\/runs\/([^/]+)\/events$/.exec(request.pathname)?.[1];
    if (!runId) continue;
    const { events } = JSON.parse(request.text) as { events: Sent[] };
    out.set(runId, [...(out.get(runId) ?? []), ...events]);
  }
  return out;
}

/** A run's events as a short readable list. */
export const shape = (events: Sent[] | undefined) =>
  (events ?? []).map((e) => (e.type === "test_end" ? `test_end(${e.status},${e.retry})` : e.type));

/** Whether this machine can run the pytest jobs; CI sets PEEPS_REQUIRE_PYTEST, so there it must. */
export function pytestAvailable(): { skip?: string } {
  const python = process.env.PEEPS_PYTHON ?? "python3";
  const found = spawnSync(python, ["-c", "import pytest"]).status === 0;
  if (!found && process.env.PEEPS_REQUIRE_PYTEST) throw new Error(`PEEPS_REQUIRE_PYTEST is set, but ${python} has no pytest`);
  return found ? {} : { skip: "no Python with pytest (set PEEPS_PYTHON; CI sets PEEPS_REQUIRE_PYTEST)" };
}

export const announceOf = (requests: PeepsRequest[]) => {
  const request = requests.find((v) => v.pathname === "/api/v1/ci/batches");
  if (!request) throw new Error("the job announced nothing");
  return JSON.parse(request.text) as Record<string, unknown>;
};
