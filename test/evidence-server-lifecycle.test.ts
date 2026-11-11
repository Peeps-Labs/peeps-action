/** The action owns the app for one invocation: reset, start under the preload, ready, stop, coverage read (PQA-3201 PR 3). */
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createServer } from "node:net";

import { runInvocation, type AppCommand } from "../src/evidence/server/lifecycle";

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

const ranIn = (coverage: Awaited<ReturnType<typeof runInvocation>>["coverage"], name: string) =>
  coverage.files.some(({ result }) => result.some((s) => s.url.endsWith("/server.js") && s.functions.some((f) => f.functionName === name && f.ranges[0]!.count > 0)));

test("the app runs for the invocation's tests: what they reached ran, its coverage taken on SIGTERM", async () => {
  const command = await app();
  const dir = path.join(command.cwd, "cov");
  const { exitCode, coverage } = await runInvocation(command, { dir, preload: PRELOAD, kind: "spec" }, async () => {
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
  const { coverage } = await runInvocation(command, { dir: path.join(command.cwd, "cov"), preload: PRELOAD, kind: "spec" }, async () => 0);
  assert.equal(coverage.started.length, 2);
  assert.deepEqual([...coverage.taken].sort(), [...coverage.started].sort());
});

test("the reset runs first, told which invocation it is; its failure is a named problem, and the tests still run", async () => {
  const command = await app({ reset: 'echo "$PEEPS_INVOCATION" > reset.txt' });
  await runInvocation(command, { dir: path.join(command.cwd, "cov"), preload: PRELOAD, kind: "ambient" }, async () => 0);
  assert.equal(require("node:fs").readFileSync(path.join(command.cwd, "reset.txt"), "utf8").trim(), "ambient");
  const failing = await app({ reset: "exit 4" });
  let ran = false;
  const { coverage } = await runInvocation(failing, { dir: path.join(failing.cwd, "cov"), preload: PRELOAD, kind: "spec" }, async () => ((ran = true), 0));
  assert.ok(ran);
  assert.deepEqual(coverage.problems, ["reset_failed"]);
});

test("an app that never answers is not ready; one that exits early says so; the tests still run", async () => {
  const deaf = await app({ readyUrl: "http://127.0.0.1:9/never" });
  const slow = await runInvocation(deaf, { dir: path.join(deaf.cwd, "cov"), preload: PRELOAD, kind: "spec", readyTimeoutMs: 1_500 }, async () => 0);
  assert.ok(slow.coverage.problems.includes("not_ready"));
  const quitter = await app({ start: "node -e 'process.exit(0)'" });
  const gone = await runInvocation(quitter, { dir: path.join(quitter.cwd, "cov"), preload: PRELOAD, kind: "spec", readyTimeoutMs: 5_000 }, async () => 0);
  assert.ok(gone.coverage.problems.includes("app_exited"), JSON.stringify(gone.coverage.problems));
});

test("an app that dies while its tests run says so: it may have served only some of them", async () => {
  const command = await app({ start: "node server.js & pid=$!; sleep 0.5; while kill -0 $pid 2>/dev/null; do sleep 0.1; done" });
  const { coverage } = await runInvocation(command, { dir: path.join(command.cwd, "cov"), preload: PRELOAD, kind: "spec" }, async () => {
    // Ready, then the app goes away mid-run.
    for (const pid of require("node:fs").readdirSync(path.join(command.cwd, "cov")).filter((n: string) => n.startsWith("pid-"))) process.kill(Number(pid.slice(4, -5)), "SIGKILL");
    await new Promise((resolve) => setTimeout(resolve, 1_000));
    return 0;
  });
  assert.ok(coverage.problems.includes("app_exited"), JSON.stringify(coverage.problems));
});
