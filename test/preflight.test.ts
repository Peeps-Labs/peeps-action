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

const KEY_HEX = "c03dd504d33c33f55a570a1a758d442e1cda0793b1a480482f0d67f9437320a6";
const OTHER_HEX = "ab".repeat(32);
const collect = { coverage: true, fingerprint: true, key: KEY_HEX, keyVersion: "V1" };
const answer = (projects: unknown[]) => ({ scan: true, protocolVersion: 2, projects });

test("collect: per project, only with protocol 2, a 64-hex key and a key version (contract §1)", () => {
  const negotiated = readPreflight(answer([{ projectId: "p1", executionMode: "shadow", collect }, { projectId: "p2", executionMode: "shadow" }]));
  assert.deepEqual(negotiated.collect, [{ projectId: "p1", coverage: true, fingerprint: true, tables: false, key: Buffer.from(KEY_HEX, "hex"), keyVersion: "V1" }]);
  for (const bad of [
    { ...collect, key: "short" },
    { ...collect, key: Buffer.from(KEY_HEX, "hex").toString("base64url") },
    { ...collect, key: undefined },
    { ...collect, keyVersion: "1" },
    { ...collect, keyVersion: undefined },
    { ...collect, coverage: false, fingerprint: false },
    "yes",
    null,
  ]) {
    assert.equal("collect" in readPreflight(answer([{ projectId: "p1", collect: bad }])), false, JSON.stringify(bad));
  }
  assert.equal("collect" in readPreflight(answer([{ collect }])), false, "no project id");
  assert.deepEqual(readPreflight({ scan: true, protocolVersion: 1, projects: [{ projectId: "p1", collect }] }), NONE);
  // A top-level collect is no project's.
  assert.equal("collect" in readPreflight({ scan: true, protocolVersion: 2, collect }), false);
});

test("collect.tables: read the job's Postgres log only when Peeps says exactly true", () => {
  const tablesOf = (value: unknown) => readPreflight(answer([{ projectId: "p1", collect: { ...collect, tables: value } }])).collect?.[0]?.tables;
  assert.equal(tablesOf(true), true);
  for (const value of [undefined, false, "true", 1, null]) assert.equal(tablesOf(value), false, JSON.stringify(value));
  // Tables alone ask for nothing: they ride on a fingerprint's recording.
  assert.equal("collect" in readPreflight(answer([{ projectId: "p1", collect: { ...collect, coverage: false, fingerprint: false, tables: true } }])), false);
});

test("two projects, two keys", () => {
  const negotiated = readPreflight(answer([{ projectId: "p1", collect }, { projectId: "p2", collect: { ...collect, key: OTHER_HEX, coverage: false } }]));
  assert.deepEqual(negotiated.collect?.map((c) => [c.projectId, c.key.toString("hex"), c.coverage]), [["p1", KEY_HEX, true], ["p2", OTHER_HEX, false]]);
});

test("a server that doesn't ask collects nothing: today's answer reads exactly as before", () => {
  assert.deepEqual(readPreflight({ scan: true, protocolVersion: 2, projects: [{ projectId: "p1", executionMode: "shadow" }] }), { protocol: true, scan: true });
});

test("every key is masked in the job's log the moment it arrives, and never printed", async () => {
  const lines: string[] = [];
  const { peeps } = fakePeeps(async () => answer([{ projectId: "p1", collect }, { projectId: "p2", collect: { ...collect, key: OTHER_HEX } }]));
  const negotiated = await negotiateTargetedRuns(github("push"), peeps, (line) => lines.push(line));
  assert.equal(negotiated.collect?.length, 2);
  const spellings = (hex: string) => [`::add-mask::${hex}`, `::add-mask::${Buffer.from(hex, "hex").toString("base64url")}`];
  assert.deepEqual(lines, [...spellings(KEY_HEX), ...spellings(OTHER_HEX)]);
  const quiet: string[] = [];
  await negotiateTargetedRuns(github("push"), fakePeeps(async () => ({ scan: false, protocolVersion: 2 })).peeps, (line) => quiet.push(line));
  assert.deepEqual(quiet, []);
});

test("the key never reaches the announce", () => {
  const negotiated = readPreflight(answer([{ projectId: "p1", collect }]));
  assert.doesNotMatch(JSON.stringify(announceFieldsOf(negotiated)), new RegExp(KEY_HEX.slice(0, 16)));
});
