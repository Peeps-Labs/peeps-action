/**
 * The targeted runs handshake: what the preflight's answer lets this job do. Only a
 * server that answers protocol 2 or later gets `canNarrow`, a reach or footprints;
 * anything else is today's full run.
 */
import { test } from "node:test";
import { setImmediate as flush } from "node:timers/promises";
import assert from "node:assert/strict";

import { announceFieldsOf, negotiateTargetedRuns, readPreflight } from "../src/reach/preflight";

const NONE = { protocol: false, scan: false };

for (const [name, answer] of [
  ["an older server's { scan: true }", { scan: true }],
  ["protocol 1", { scan: true, protocolVersion: 1 }],
  ["the protocol as a string", { scan: true, protocolVersion: "2" }],
  ["a fractional protocol", { scan: true, protocolVersion: 2.5 }],
  ["a null protocol", { scan: true, protocolVersion: null }],
  ["no object", "<html>"],
  ["null", null],
  ["an array", [2]],
] as const) {
  test(`${name} negotiates nothing`, () => {
    assert.deepEqual(readPreflight(answer), NONE);
  });
}

test("protocol 2 negotiates, and scans only with scan: true", () => {
  assert.deepEqual(readPreflight({ scan: true, protocolVersion: 2, projects: [] }), { protocol: true, scan: true });
  assert.deepEqual(readPreflight({ scan: false, protocolVersion: 2 }), { protocol: true, scan: false });
  assert.deepEqual(readPreflight({ scan: "yes", protocolVersion: 2 }), { protocol: true, scan: false });
});

test("a later protocol negotiates, and this action still says it speaks 2", () => {
  const negotiated = readPreflight({ scan: true, protocolVersion: 3 });
  assert.deepEqual(negotiated, { protocol: true, scan: true });
  assert.deepEqual(announceFieldsOf(negotiated), { canNarrow: true, protocolVersion: 2 });
});

test("without the handshake the announce carries neither canNarrow nor a version", () => {
  assert.deepEqual(announceFieldsOf(NONE), {});
});

function fakePeeps(answer: () => Promise<unknown>) {
  const asked: string[] = [];
  return {
    asked,
    peeps: {
      get: async <T>(path: string) => {
        asked.push(path);
        return (await answer()) as T;
      },
    },
  };
}

const github = (eventName: string | null) => ({ platform: "github" as const, eventName });

test("a push asks too, and never scans", async () => {
  const { asked, peeps } = fakePeeps(async () => ({ scan: true, protocolVersion: 2 }));
  assert.deepEqual(await negotiateTargetedRuns(github("push"), peeps), { protocol: true, scan: false });
  assert.deepEqual(asked, ["/api/v1/ci/targeted-runs"]);
});

test("a pull request scans when the server says so", async () => {
  const { peeps } = fakePeeps(async () => ({ scan: true, protocolVersion: 2 }));
  assert.deepEqual(await negotiateTargetedRuns(github("pull_request"), peeps), { protocol: true, scan: true });
});

test("GitLab asks nothing", async () => {
  const { asked, peeps } = fakePeeps(async () => ({ scan: true, protocolVersion: 2 }));
  assert.deepEqual(await negotiateTargetedRuns({ platform: "gitlab", eventName: "merge_request" }, peeps), NONE);
  assert.deepEqual(asked, []);
});

test("a failed preflight negotiates nothing", async () => {
  const { peeps } = fakePeeps(async () => {
    throw new Error("404");
  });
  assert.deepEqual(await negotiateTargetedRuns(github("pull_request"), peeps), NONE);
});

test("a preflight that never answers, a stalled token included, negotiates nothing at 3 s", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const { peeps } = fakePeeps(() => new Promise(() => {}));
  let settled: unknown;
  void negotiateTargetedRuns(github("pull_request"), peeps).then((negotiated) => {
    settled = negotiated;
  });
  await flush();
  t.mock.timers.tick(2999);
  await flush();
  assert.equal(settled, undefined, "still waiting just before 3 s");
  t.mock.timers.tick(1);
  await flush();
  assert.deepEqual(settled, NONE);
});
