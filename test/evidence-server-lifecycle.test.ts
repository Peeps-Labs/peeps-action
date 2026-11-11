/** The action owns the app for one invocation: reset, start under the preload, ready, stop, coverage read (PQA-3201 PR 3). */
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createServer } from "node:net";

import { runInvocation, type AppCommand } from "../src/evidence/server/lifecycle";

/** One invocation, its coverage read whichever way it was taken. */
async function runOnce(...args: Parameters<typeof runInvocation>) {
  const run = await runInvocation(...args);
  return { ...run, coverage: run.coverage ?? run.read!() };
}

const PRELOAD = path.join(__dirname, "..", "src", "evidence", "server", "preload.cjs");

async function freePort(): Promise<number> {
  return new Promise((resolve) => {
    const server = createServer().listen(0, () => {
      const { port } = server.address() as { port: number };
      server.close(() => resolve(port));
    });
  });
}

/** An app: answers `/ready`, runs `work` on `/work`, and with `CHILD=1` starts a second Node process. */
function appDir(): string {
  const dir = realpathSync(mkdtempSync(path.join(tmpdir(), "peeps-app-")));
  writeFileSync(
    path.join(dir, "server.js"),
    `const http = require("node:http");
function work() { return "worked"; }
function never() { return "never"; }
if (process.env.CHILD === "1") require("node:child_process").spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
http.createServer((req, res) => res.end(req.url === "/work" ? work() : "ok")).listen(Number(process.env.PORT));
`,
  );
  return dir;
}

async function app(over: Partial<AppCommand> = {}, env: Record<string, string> = {}): Promise<AppCommand> {
  const port = await freePort();
  const cwd = appDir();
  return { start: "node server.js", readyUrl: `http://127.0.0.1:${port}/ready`, reset: null, cwd, env: { ...process.env, PORT: String(port), ...env }, ...over };
}

const ranIn = (coverage: { files: Array<{ result: Array<{ url: string; functions: Array<{ functionName: string; ranges: Array<{ count: number }> }> }> }> }, name: string) =>
  coverage.files.some(({ result }) => result.some((s) => s.url.endsWith("/server.js") && s.functions.some((f) => f.functionName === name && f.ranges[0]!.count > 0)));

test("the app runs for the invocation's tests: what they reached ran, its coverage taken on SIGTERM", async () => {
  const command = await app();
  const dir = path.join(command.cwd, "cov");
  const { exitCode, coverage } = await runOnce(command, { dir, preload: PRELOAD, kind: "spec" }, async () => {
    assert.equal(await (await fetch(command.readyUrl.replace("/ready", "/work"))).text(), "worked");
    return 3;
  });
  assert.equal(exitCode, 3);
  assert.equal(coverage.started.length, 1);
  assert.deepEqual(coverage.taken, coverage.started);
  assert.deepEqual([coverage.unreadable, coverage.problems], [0, []]);
  assert.equal(coverage.files.length, 1, "one take per process: no second full write at exit");
  assert.ok(ranIn(coverage, "work"));
  assert.ok(!ranIn(coverage, "never"));
  assert.ok(!existsSync(dir), "raw coverage is removed once read");
});

test("every Node process the app starts registers, and the whole group is stopped and taken", async () => {
  const command = await app({}, { CHILD: "1" });
  const dir = path.join(command.cwd, "cov");
  const { coverage } = await runOnce(command, { dir, preload: PRELOAD, kind: "spec" }, async () => {
    // The child starts after the app answers: wait until it has registered too.
    for (let i = 0; i < 100 && require("node:fs").readdirSync(dir).filter((n: string) => n.startsWith("pid-")).length < 2; i++) await new Promise((r) => setTimeout(r, 50));
    return 0;
  });
  assert.equal(coverage.started.length, 2);
  assert.deepEqual([...coverage.taken].sort(), [...coverage.started].sort());
});

test("the reset runs first, told which invocation it is; its failure is a named problem, and the tests still run", async () => {
  const command = await app({ reset: 'echo "$PEEPS_INVOCATION" > reset.txt' });
  await runOnce(command, { dir: path.join(command.cwd, "cov"), preload: PRELOAD, kind: "ambient" }, async () => 0);
  assert.equal(require("node:fs").readFileSync(path.join(command.cwd, "reset.txt"), "utf8").trim(), "ambient");
  const failing = await app({ reset: "exit 4" });
  let ran = false;
  const { coverage } = await runOnce(failing, { dir: path.join(failing.cwd, "cov"), preload: PRELOAD, kind: "spec" }, async () => ((ran = true), 0));
  assert.ok(ran);
  assert.deepEqual(coverage.problems, ["reset_failed"]);
});

test("an app that never answers is not ready; one that exits early says so; the tests still run", async () => {
  const deaf = await app({ readyUrl: "http://127.0.0.1:9/never" });
  const slow = await runOnce(deaf, { dir: path.join(deaf.cwd, "cov"), preload: PRELOAD, kind: "spec", readyTimeoutMs: 1_500 }, async () => 0);
  assert.ok(slow.coverage.problems.includes("not_ready"));
  const quitter = await app({ start: "node -e 'process.exit(0)'" });
  const gone = await runOnce(quitter, { dir: path.join(quitter.cwd, "cov"), preload: PRELOAD, kind: "spec", readyTimeoutMs: 5_000 }, async () => 0);
  assert.ok(gone.coverage.problems.includes("app_exited"), JSON.stringify(gone.coverage.problems));
});

test("an app that dies while its tests run says so: it may have served only some of them", async () => {
  const command = await app({ start: "node server.js & pid=$!; sleep 0.5; while kill -0 $pid 2>/dev/null; do sleep 0.1; done" });
  const { coverage } = await runOnce(command, { dir: path.join(command.cwd, "cov"), preload: PRELOAD, kind: "spec" }, async () => {
    // Ready, then the app goes away mid-run.
    for (const pid of require("node:fs").readdirSync(path.join(command.cwd, "cov")).filter((n: string) => n.startsWith("pid-"))) process.kill(Number(pid.slice(4, -5)), "SIGKILL");
    await new Promise((resolve) => setTimeout(resolve, 1_000));
    return 0;
  });
  assert.ok(coverage.problems.includes("app_exited"), JSON.stringify(coverage.problems));
});

test("something already answering the ready URL before the app starts can't vouch for it: partial", async () => {
  const command = await app();
  const squatter = require("node:http").createServer((_req: unknown, res: { end: (body: string) => void }) => res.end("ok")).listen(Number(command.env.PORT), "127.0.0.1");
  await new Promise((resolve) => squatter.once("listening", resolve));
  try {
    const { coverage } = await runOnce(command, { dir: path.join(command.cwd, "cov"), preload: PRELOAD, kind: "spec", readyTimeoutMs: 3_000 }, async () => 0);
    assert.ok(coverage.problems.includes("ready_before_start"), JSON.stringify(coverage.problems));
  } finally {
    squatter.close();
  }
});

test("an app that stopped coverage itself has no final take: not taken, so partial", async () => {
  const command = await app({ start: `node -e 'require("node:v8").takeCoverage(); require("node:v8").stopCoverage(); require("./server.js")'` });
  const { coverage } = await runOnce(command, { dir: path.join(command.cwd, "cov"), preload: PRELOAD, kind: "spec" }, async () => {
    await fetch(command.readyUrl.replace("/ready", "/work"));
    return 0;
  });
  assert.equal(coverage.started.length, 1);
  assert.deepEqual(coverage.taken, [], "the final take wrote nothing, so no marker");
});

test("a signal to the action while a run owns the app stops the app's group too", async () => {
  const command = await app();
  const dir = path.join(command.cwd, "cov");
  const runner = path.join(command.cwd, "runner.ts");
  writeFileSync(
    runner,
    `import { runInvocation } from ${JSON.stringify(path.join(__dirname, "..", "src", "evidence", "server", "lifecycle"))};
runInvocation({ ...${JSON.stringify({ ...command, env: undefined })}, env: process.env } as never, { dir: ${JSON.stringify(dir)}, preload: ${JSON.stringify(PRELOAD)}, kind: "spec" }, () => { console.log("TESTS"); return new Promise<number>(() => {}); });
`,
  );
  const child = require("node:child_process").spawn(process.execPath, ["--import", "tsx", runner], { cwd: path.join(__dirname, ".."), env: command.env, stdio: ["ignore", "pipe", "inherit"] });
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("the runner never reached its tests")), 30_000);
    child.stdout.on("data", (d: Buffer) => d.toString().includes("TESTS") && (clearTimeout(timer), resolve()));
    child.on("exit", (code: number) => reject(new Error(`the runner exited first (${code})`)));
  });
  const appPid = Number(require("node:fs").readdirSync(dir).find((n: string) => n.startsWith("pid-"))!.slice(4, -5));
  child.kill("SIGTERM");
  await new Promise((resolve) => child.on("exit", resolve));
  // A surviving app holds the pipe the runner gave it: let go, so a regression fails, not hangs.
  child.stdout.destroy();
  let alive = true;
  for (let i = 0; i < 50 && alive; i++) {
    try {
      process.kill(appPid, 0);
      await new Promise((r) => setTimeout(r, 100));
    } catch {
      alive = false;
    }
  }
  assert.equal(alive, false, "the app outlived the action");
});

test("a worker thread's own take can't vouch for a main thread that stopped coverage", async () => {
  const start = `node -e 'require("node:v8").takeCoverage(); require("node:v8").stopCoverage(); new (require("node:worker_threads").Worker)("1", { eval: true }); require("./server.js")'`;
  const command = await app({ start });
  const { coverage } = await runOnce(command, { dir: path.join(command.cwd, "cov"), preload: PRELOAD, kind: "spec" }, async () => {
    await new Promise((r) => setTimeout(r, 500));
    return 0;
  });
  assert.deepEqual(coverage.taken, []);
});

test("a deferred read sets the coverage aside at the stop and reads it later; the app starts only after startAfter, the reset before", async () => {
  const command = await app({ reset: 'echo reset >> order.log' });
  const dir = path.join(command.cwd, "cov");
  let release!: () => void;
  const fingerprinted = new Promise<void>((resolve) => (release = resolve));
  const running = runInvocation(command, { dir, preload: PRELOAD, kind: "spec", defer: true, startAfter: fingerprinted }, async () => {
    await fetch(command.readyUrl.replace("/ready", "/work"));
    return 0;
  });
  await new Promise((r) => setTimeout(r, 800));
  const log = () => require("node:fs").readFileSync(path.join(command.cwd, "order.log"), "utf8").trim();
  assert.equal(log(), "reset", "the reset ran");
  assert.ok(!existsSync(dir) || require("node:fs").readdirSync(dir).length === 0, "no app process yet");
  release();
  const run = await running;
  assert.equal(run.coverage, undefined, "nothing parsed at the stop");
  assert.ok(!existsSync(dir), "the directory is free for the next run");
  const coverage = run.read!();
  assert.equal(coverage.started.length, 1);
  assert.ok(ranIn(coverage, "work"));
});
