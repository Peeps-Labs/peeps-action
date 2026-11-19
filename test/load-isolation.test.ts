/**
 * Isolation (T4): the executor runs the journey as uid 65534 with an allowlisted environment.
 * A journey cannot read the supervisor's environment, cannot write its spool, and cannot
 * speak on the frame channel by logging. A journey that writes garbage to fd 1 fails the run
 * as a protocol error. Also run by CI's `load-stock-image` job, in the stock Playwright image.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { privilege } from "../src/load/containment";
import { alive, JOURNEYS, newSink, startRun } from "./support/load-run";

const ALLOWED = ["BASE_URL", "HOME", "LANG", "LC_ALL", "PATH", "TZ"];
const STOCK_IMAGE = process.env.PEEPS_LOAD_STOCK_IMAGE === "1";
const linux = process.platform === "linux";
/** What the executor process may start with: nothing Node reads at startup, no journey variable. */
const STARTUP_ALLOWED = ["HOME", "LANG", "LC_ALL", "PATH", "TZ", "PEEPS_LOAD_DROP_UID"];

test("a journey cannot reach the supervisor's environment, its spool or the frame channel", async (t) => {
  const sink = await newSink(t);
  const spool = mkdtempSync(path.join(tmpdir(), "peeps-load-spool-test-"));
  t.after(() => rmSync(spool, { recursive: true, force: true }));
  const run = await startRun(t, sink, {
    plan: { module: "isolation.ts", export: "probe", users: 1, holdMs: 2_000 },
    options: { spoolDir: spool },
    env: { PEEPS_SECRET_PROBE: "do-not-leak", GITHUB_TOKEN: "ghs_not_for_the_journey" },
  });
  sink.info = { supervisorPid: run.child.pid, spool };
  const done = await run.finished();

  assert.equal(done.result.status, "finished", `${done.result.reason ?? ""}\n${run.stderr}`);
  assert.ok(sink.reports.length > 0, "the journey reported nothing");
  for (const report of sink.reports) {
    const keys = report.env!.split(",").filter(Boolean);
    // The exact allowlist holds on Linux; elsewhere the runtime adds its own (macOS's
    // __CF_USER_TEXT_ENCODING), so only the secrets are checked there.
    if (linux) {
      assert.deepEqual(
        keys.filter((k) => !ALLOWED.includes(k)),
        [],
        "the journey saw an environment variable outside the allowlist",
      );
    }
    assert.ok(!keys.includes("PEEPS_SECRET_PROBE") && !keys.includes("GITHUB_TOKEN"));
  }
  // Logging a frame-shaped line reaches stderr, never the channel.
  assert.deepEqual(run.events().filter((e) => e.type === "outcome" && e.turn === "forged"), []);

  // Root (the stock image) or sudo (a hosted runner) can drop to 65534; the one reason not
  // to is a workspace 65534 cannot read (a home directory closed to others), and it says so.
  const p = privilege();
  if (STOCK_IMAGE) assert.equal(done.result.isolation.level, "uid-65534", String(done.result.isolation.limitedBecause));
  else if (p.root || p.sudo) {
    assert.ok(
      done.result.isolation.level === "uid-65534" || /cannot read the workspace/.test(String(done.result.isolation.limitedBecause)),
      String(done.result.isolation.limitedBecause),
    );
  }
  if (done.result.isolation.level === "uid-65534") {
    for (const report of sink.reports) {
      assert.equal(report.uid, "65534");
      assert.equal(report.gid, "65534");
      assert.equal(report.environ, "EACCES", "the journey read the supervisor's environment");
      assert.equal(report.spool, "EACCES", "the journey wrote to the supervisor's spool");
    }
    assert.deepEqual(readdirSync(spool).filter((f) => f === "planted"), []);
  } else {
    assert.ok(done.result.isolation.limitedBecause, "limited isolation without a reason");
  }
});

test("garbage on the frame channel fails the run as a protocol error", async (t) => {
  const sink = await newSink(t);
  const run = await startRun(t, sink, {
    plan: { module: "isolation.ts", export: "corruptFrames", users: 1, holdMs: 10_000 },
    constants: { turnDeadlineMs: 8_000, checkingDeadlineMs: 10_000 },
  });
  const done = await run.finished();
  assert.equal(done.result.status, "failed");
  assert.match(done.result.reason ?? "", /^executor protocol/);
  for (const pid of run.executorPids()) assert.equal(alive(pid), false, `executor process ${pid} still running`);
});


test("journey variables never reach a command line or the executor's startup environment", { skip: !linux && "reads /proc" }, async (t) => {
  const sink = await newSink(t);
  const secret = "journey-secret-7f3a91";
  const run = await startRun(t, sink, {
    plan: { module: "basic.ts", export: "readValue", users: 1, holdMs: 3_000 },
    options: { executorEnv: { JOURNEY_TOKEN: secret } },
  });
  const seen: string[] = [];
  const startup = new Map<number, string[]>();
  const scan = setInterval(() => {
    for (const pid of readdirSync("/proc").filter((p) => /^\d+$/.test(p))) {
      try {
        if (readFileSync(`/proc/${pid}/cmdline`, "utf8").includes(secret)) seen.push(`cmdline of ${pid}`);
      } catch {
        // gone, or not ours to read
      }
    }
    for (const pid of run.executorPids()) {
      try {
        startup.set(pid, readFileSync(`/proc/${pid}/environ`, "utf8").split("\0").filter(Boolean));
      } catch {
        // gone
      }
    }
  }, 50);
  const done = await run.finished();
  clearInterval(scan);
  assert.equal(done.result.status, "finished", `${done.result.reason ?? ""}\n${run.stderr}`);
  assert.deepEqual(seen, [], "the secret was on a command line");
  assert.ok(startup.size > 0, "never saw the executor's environment");
  for (const [pid, env] of startup) {
    assert.ok(!env.some((kv) => kv.includes(secret)), `the secret was in ${pid}'s startup environment`);
    const keys = env.map((kv) => kv.slice(0, kv.indexOf("=")));
    assert.deepEqual(keys.filter((k) => !STARTUP_ALLOWED.includes(k)), [], `${pid} started with more than the minimal environment`);
  }
});

test("a journey variable that Node or the loader reads at startup is refused before anything runs", async (t) => {
  const sink = await newSink(t);
  const run = await startRun(t, sink, {
    plan: { module: "basic.ts", export: "readValue", users: 1, holdMs: 3_000 },
    options: { executorEnv: { NODE_OPTIONS: "--require /tmp/evil.js" } },
  });
  const done = await run.finished();
  assert.notEqual(done.result.status, "finished");
  assert.match(done.result.reason ?? "", /NODE_OPTIONS/);
  assert.deepEqual(run.executorPids(), [], "an executor was started");
  assert.equal(sink.requests.length, 0);
});

test("a node_modules uid 65534 cannot read falls back to limited isolation, and says so", { skip: !(privilege().root || privilege().sudo) && "needs root or sudo -n" }, async (t) => {
  const sink = await newSink(t);
  // A workspace anyone can read whose node_modules only its owner can open.
  const repo = mkdtempSync(path.join(tmpdir(), "peeps-load-closed-"));
  t.after(() => rmSync(repo, { recursive: true, force: true }));
  chmodSync(repo, 0o755);
  copyFileSync(path.join(JOURNEYS, "basic.ts"), path.join(repo, "basic.ts"));
  chmodSync(path.join(repo, "basic.ts"), 0o644);
  const modules = path.join(repo, "node_modules");
  mkdirSync(path.join(modules, "@playwright"), { recursive: true });
  const real = path.resolve(__dirname, "../node_modules");
  symlinkSync(path.join(real, "@playwright/test"), path.join(modules, "@playwright/test"));
  for (const name of ["playwright", "playwright-core"]) symlinkSync(path.join(real, name), path.join(modules, name));
  chmodSync(modules, 0o700);
  const run = await startRun(t, sink, {
    plan: { module: "basic.ts", export: "readValue", users: 1, holdMs: 2_000 },
    options: { repositoryRoot: repo },
  });
  const done = await run.finished();
  assert.equal(done.result.status, "finished", `${done.result.reason ?? ""}\n${run.stderr}`);
  assert.equal(done.result.isolation.level, "limited");
  assert.match(String(done.result.isolation.limitedBecause), /node_modules/);
});
