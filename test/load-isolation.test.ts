/**
 * Isolation (T4): the executor runs the journey as uid 65534 with an allowlisted environment.
 * A journey cannot read the supervisor's environment, cannot write its spool, and cannot
 * speak on the frame channel by logging. A journey that writes garbage to fd 1 fails the run
 * as a protocol error. Also run by CI's `load-stock-image` job, in the stock Playwright image.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { privilege } from "../src/load/containment";
import { alive, newSink, startRun } from "./support/load-run";

const ALLOWED = ["BASE_URL", "HOME", "LANG", "LC_ALL", "PATH", "TZ"];
const STOCK_IMAGE = process.env.PEEPS_LOAD_STOCK_IMAGE === "1";

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
    assert.deepEqual(
      keys.filter((k) => !ALLOWED.includes(k)),
      [],
      "the journey saw an environment variable outside the allowlist",
    );
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
