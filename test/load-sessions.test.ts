/**
 * The executor's user sessions, driven over frames: each user keeps its own cookies across
 * turns, a turn's deadline cancels the request it has in flight, and thousands of turns
 * dispose what they made, so the heap does not grow with the run.
 */
import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";

import { ExecutorDriver } from "./support/executor-driver";
import { newSink } from "./support/load-run";

async function driver(t: TestContext, url: string, exportName: string, module = "sessions.ts") {
  const d = new ExecutorDriver(url, { module, export: exportName });
  t.after(() => d.close());
  await d.start();
  return d;
}

test("two users keep separate cookies, and each keeps its own across turns", async (t) => {
  const sink = await newSink(t);
  const d = await driver(t, sink.url, "cookie");
  for (const [turn, user] of [["a1", 1], ["b1", 2], ["a2", 1], ["b2", 2]] as const) {
    assert.equal((await d.turn(turn, user)).kind, "success");
  }
  const byUser = (user: number) => sink.requests.filter((r) => d.permits.get(r.permit!)?.user === user).map((r) => r.cookie);
  const [first1, again1] = byUser(1);
  const [first2, again2] = byUser(2);
  assert.equal(first1, null);
  assert.equal(first2, null);
  assert.ok(again1 && again2, "a user lost its cookie between turns");
  assert.notEqual(again1, again2, "two users shared a cookie");
});

test("a turn's deadline cancels the request it has in flight", async (t) => {
  const sink = await newSink(t);
  const d = await driver(t, sink.url, "slow", "basic.ts");
  const started = Date.now();
  const outcome = await d.turn("slow1", 1, 500);
  assert.equal(outcome.kind, "timeout");
  await new Promise((r) => setTimeout(r, 300));
  assert.equal(sink.requests.length, 1);
  const [request] = sink.requests;
  assert.equal(request!.aborted, true, "the request was not cancelled");
  assert.ok(request!.endMs! - started < 1_500, `cancelled ${request!.endMs! - started} ms after the start`);
});

test("2000 turns dispose what they make: the heap stays bounded and cookies survive", async (t) => {
  const sink = await newSink(t);
  const d = await driver(t, sink.url, "cookie");
  const users = 10;
  let turn = 0;
  const round = async () => {
    const outcomes = await Promise.all(Array.from({ length: users }, (_, u) => d.turn(`t${++turn}`, u + 1)));
    for (const o of outcomes) assert.equal(o.kind, "success", o.message);
  };
  for (let i = 0; i < 20; i++) await round();
  const warm = await d.heapUsed();
  for (let i = 20; i < 200; i++) await round();
  const after = await d.heapUsed();
  assert.equal(turn, 2000);
  assert.equal(after.sessions, users);
  const growthMb = (after.heapUsed - warm.heapUsed) / 1024 / 1024;
  assert.ok(growthMb < 16, `heap grew ${growthMb.toFixed(1)} MB over 1800 turns`);
  // Each user was given one session cookie, on its first turn, and sent it on every other.
  const fresh = sink.requests.filter((r) => r.cookie === null);
  assert.equal(fresh.length, users);
});
