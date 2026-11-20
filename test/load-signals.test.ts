/**
 * The process signals a runner sends a cancelled job (e4 plan v3 §3.3 F5): SIGINT, then
 * SIGTERM 7.5 s later, then SIGKILL at 10 s. A handler for each keeps Node's default (exit,
 * the kernel then flushing what was queued) from running: SIGINT cancels the run, SIGTERM
 * cancels it hard (every upstream reset at once, no draining).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { loadSignals } from "../src/load/signals";

test("SIGINT cancels; SIGTERM cancels hard; repeats change nothing; dispose removes the handlers", () => {
  const proc = new EventEmitter();
  const s = loadSignals(proc as never);
  assert.equal(proc.listenerCount("SIGINT"), 1);
  assert.equal(proc.listenerCount("SIGTERM"), 1);
  proc.emit("SIGINT");
  assert.equal(s.signal.aborted, true);
  assert.equal(s.hard.aborted, false);
  proc.emit("SIGINT");
  assert.equal(proc.listenerCount("SIGINT"), 1, "a second SIGINT is still ours, not Node's default exit");
  proc.emit("SIGTERM");
  assert.equal(s.hard.aborted, true);
  assert.deepEqual(s.received, ["SIGINT", "SIGINT", "SIGTERM"]);
  s.dispose();
  assert.equal(proc.listenerCount("SIGINT") + proc.listenerCount("SIGTERM"), 0);
});

test("SIGTERM alone is a hard cancel", () => {
  const proc = new EventEmitter();
  const s = loadSignals(proc as never);
  proc.emit("SIGTERM");
  assert.equal(s.signal.aborted, true);
  assert.equal(s.hard.aborted, true);
  s.dispose();
});
