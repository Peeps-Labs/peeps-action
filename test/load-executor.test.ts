/**
 * The executor holds the supervisor's word only while it is still true: a start or a permit
 * carries absolute expiries on the shared monotonic clock and the lease generation it was
 * given under. One queued in the pipe while the executor was frozen, and stale when read,
 * never runs or sends; and after the executor sees its own pause, nothing given before it is
 * used until a newer generation arrives.
 */
import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";

import { sharedNowMs } from "../src/load/transport";
import { ExecutorDriver } from "./support/executor-driver";
import { newSink } from "./support/load-run";

async function driver(t: TestContext, url: string, exportName: string, deadManMs = 5_000) {
  const d = new ExecutorDriver(url, { module: "basic.ts", export: exportName }, deadManMs);
  t.after(() => d.close());
  await d.start();
  return d;
}

test("a start queued across a suspension, whose permission ended meanwhile, never runs", async (t) => {
  const sink = await newSink(t);
  const d = await driver(t, sink.url, "readValue");
  let outcome!: Promise<{ kind: string }>;
  await d.freeze(600, () => {
    const now = sharedNowMs();
    outcome = new Promise((resolve) => {
      void d.waitFrame((f) => f.t === "outcome" && f.turn === "late").then((f) => resolve(f as unknown as { kind: string }));
    });
    d.send({ t: "start", turn: "late", user: 1, deadlineAt: now + 5_000, leaseEndsAt: now + 300, generation: d.generation });
  });
  assert.equal((await outcome).kind, "interrupted");
  assert.equal(d.frames.some((f) => f.t === "started" && f.turn === "late"), false, "the stale start ran");
  assert.equal(sink.requests.length, 0);
});

test("a permit queued across a suspension, expired when read, is never used", async (t) => {
  const sink = await newSink(t);
  const d = await driver(t, sink.url, "readValue");
  d.holdAsks = true;
  const outcome = d.turn("t1", 1);
  const ask = await d.waitFrame((f) => f.t === "ask");
  await d.freeze(600, () => d.permit(ask, { expiresInMs: 300 }));
  assert.equal((await outcome).kind, "failure");
  await d.waitFrame((f) => f.t === "done");
  assert.equal(sink.requests.length, 0, "an expired permit was used");
});

test("after its own pause the executor uses no permit from an older generation", async (t) => {
  const sink = await newSink(t);
  const d = await driver(t, sink.url, "readValue", 1_000);
  d.holdAsks = true;
  const first = d.turn("t1", 1);
  const ask = await d.waitFrame((f) => f.t === "ask");
  // Frozen past the executor's own pause threshold; the permit (good for 10 s) was given before.
  await d.freeze(1_500, () => d.permit(ask, { expiresInMs: 10_000 }));
  assert.equal((await first).kind, "failure");
  assert.equal(sink.requests.length, 0, "a permit from before the pause was used");
  // A newer generation (a renewal after the pause) makes permits good again.
  d.generation += 1;
  await new Promise((r) => setTimeout(r, 250));
  d.holdAsks = false;
  assert.equal((await d.turn("t2", 1)).kind, "success");
  assert.equal(sink.requests.length, 1);
});
