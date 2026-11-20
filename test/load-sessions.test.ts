/**
 * The executor's slots and turns (e4 plan v3 §3.1 `load-sessions`): each slot keeps its own
 * cookies across turns, a turn's deadline cancels what it has in flight, a slot is busy until
 * its outcome, a late answer never writes the jar, and 2000 turns dispose what they make.
 */
import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import type { ServerResponse } from "node:http";
import { MiniSupervisor, type MiniOptions } from "./support/mini-supervisor";
import type { Arrival } from "./support/load-sink";
import { fixtureWorkspace } from "./support/e4-fixtures";
import { DENIED_HEADER, Sessions, type RealResponse } from "../src/load/session";

function turnSpec(turn: number) {
  return { turn, slot: turn, password: "A".repeat(43), deadlineMono: performance.now() + 60_000 };
}

const sessionOptions = {
  baseURL: "https://fixture.test",
  proxy: "http://127.0.0.1:3128",
  parallel: 1,
  renewEveryMs: 3_000,
  now: () => performance.now(),
};

test("cancel wakes a paced retry and removes a queued retry from another slot", { timeout: 2_000 }, async () => {
  let fetched!: () => void;
  let nextFetch = new Promise<void>((resolve) => {
    fetched = resolve;
  });
  let disposedResponses = 0;
  let disposedContexts = 0;
  const reply: RealResponse = {
    status: () => 503,
    statusText: () => "Service Unavailable",
    headers: () => ({ [DENIED_HEADER]: "ceiling" }),
    dispose: async () => {
      disposedResponses++;
    },
  };
  const sessions = new Sessions({
    ...sessionOptions,
    playwright: {
      newContext: async () => ({
        fetch: async () => {
          fetched();
          return reply;
        },
        storageState: async () => ({}),
        dispose: async () => {
          disposedContexts++;
        },
      }),
    },
  });
  const journey = (api: Record<string, unknown>) => (api.get as (url: string) => Promise<unknown>)("/");
  const first = sessions.run(turnSpec(1), journey);
  await nextFetch;
  await new Promise<void>((resolve) => setImmediate(resolve));
  nextFetch = new Promise<void>((resolve) => {
    fetched = resolve;
  });
  const second = sessions.run(turnSpec(2), journey);
  await nextFetch;
  await new Promise<void>((resolve) => setImmediate(resolve));

  const earlyDisposals = disposedResponses;
  try {
    sessions.cancel(2);
    assert.deepEqual(await second, { kind: "cancelled" });
    assert.equal(sessions.busy(1), true, "the head is still waiting");
    assert.equal(sessions.busy(2), false);
  } finally {
    sessions.cancel(2);
    sessions.cancel(1);
  }
  assert.deepEqual(await first, { kind: "cancelled" });
  assert.equal(earlyDisposals, 2, "denials are disposed before either retry");
  assert.equal(disposedContexts, 2);
});

test("cancel during cleanup waits for the one context disposal and returns cancelled", async () => {
  let finishDisposal!: () => void;
  const disposal = new Promise<void>((resolve) => {
    finishDisposal = resolve;
  });
  let started!: () => void;
  const cleanupStarted = new Promise<void>((resolve) => {
    started = resolve;
  });
  let disposals = 0;
  const sessions = new Sessions({
    ...sessionOptions,
    playwright: {
      newContext: async () => ({
        fetch: async () => {
          throw new Error("no fetch expected");
        },
        storageState: async () => ({}),
        dispose: () => {
          disposals++;
          started();
          return disposal;
        },
      }),
    },
  });
  const outcome = sessions.run(turnSpec(1), () => undefined);
  await cleanupStarted;
  sessions.cancel(1);
  assert.equal(sessions.busy(1), true);
  finishDisposal();
  assert.deepEqual(await outcome, { kind: "cancelled" });
  assert.equal(disposals, 1);
});

test("failOnStatusCode accepts a returned redirect and fails on a target 503", async () => {
  let status = 302;
  const reply: RealResponse = {
    status: () => status,
    statusText: () => "fixture",
    headers: () => ({}),
    dispose: async () => undefined,
  };
  const sessions = new Sessions({
    ...sessionOptions,
    playwright: {
      newContext: async () => ({
        fetch: async (_url, options) => {
          assert.equal(options.maxRedirects, 0);
          assert.equal(options.failOnStatusCode, false);
          return reply;
        },
        storageState: async () => ({}),
        dispose: async () => undefined,
      }),
    },
  });
  const journey = (api: Record<string, unknown>) =>
    (api.get as (url: string, options: { failOnStatusCode: boolean }) => Promise<unknown>)("/", { failOnStatusCode: true });
  assert.deepEqual(await sessions.run(turnSpec(1), journey), { kind: "success" });
  status = 503;
  assert.equal((await sessions.run(turnSpec(2), journey)).kind, "failure");
});

interface Script {
  /** What `/script` tells the next turn to do. */
  step: string;
  /** Requests the sink saw end before it answered. */
  aborted: string[];
  cookies: (string | null)[];
}

function scripted(state: Script) {
  let n = 0;
  return (arrival: Arrival, res: ServerResponse): void => {
    const path = new URL(arrival.url, "https://sink.test").pathname;
    const cookie = (arrival.headers.cookie as string | undefined) ?? null;
    res.on("close", () => !res.writableFinished && state.aborted.push(path));
    if (path === "/script") {
      state.cookies.push(cookie);
      res.writeHead(200, { "content-type": "application/json", ...(cookie ? {} : { "set-cookie": `u=${++n}-${Math.random().toString(36).slice(2, 8)}; Path=/` }) });
      return void res.end(JSON.stringify({ step: state.step }));
    }
    if (path === "/hold") return;
    if (path === "/late-cookie") {
      setTimeout(() => {
        if (res.destroyed) return;
        res.writeHead(200, { "set-cookie": "u=late; Path=/" });
        res.end("late");
      }, 1500);
      return;
    }
    res.writeHead(404).end();
  };
}

async function mini(t: TestContext, state: Script, o: Partial<MiniOptions> = {}): Promise<MiniSupervisor> {
  const m = await MiniSupervisor.start(t, { journey: { module: "journeys.ts", export: "script" }, workspace: fixtureWorkspace(t), respond: scripted(state), ...o });
  const loaded = await m.init();
  assert.equal(loaded.type, "loaded", JSON.stringify(loaded) + m.link.stderr());
  return m;
}

const fresh = (): Script => ({ step: "done", aborted: [], cookies: [] });

test("two users keep separate cookies, and each keeps its own across turns", async (t) => {
  const s = fresh();
  const m = await mini(t, s);
  const seen = new Map<number, (string | null)[]>();
  for (const slot of [1, 2, 1, 2, 1]) {
    const before = s.cookies.length;
    assert.equal((await m.turn(slot)).kind, "success");
    seen.set(slot, [...(seen.get(slot) ?? []), s.cookies[before]!]);
  }
  const [a1, a2, a3] = seen.get(1)!;
  const [b1, b2] = seen.get(2)!;
  assert.equal(a1, null);
  assert.equal(b1, null);
  assert.ok(a2 && a2 === a3, `slot 1 kept its cookie: ${a2} ${a3}`);
  assert.ok(b2, "slot 2 kept its cookie");
  assert.notEqual(a2, b2, "two users shared a cookie");
});

test("a turn's deadline cancels the request it has in flight", async (t) => {
  const s = fresh();
  s.step = "hang";
  const m = await mini(t, s);
  const started = performance.now();
  const o = await m.turn(1, { deadlineMs: 800 });
  assert.equal(o.kind, "cancelled");
  await new Promise((r) => setTimeout(r, 200));
  assert.deepEqual(s.aborted, ["/hold"], "the held request was cancelled");
  assert.ok(performance.now() - started < 3000, `the turn took ${Math.round(performance.now() - started)} ms`);
});

test("a timed-out slot gets no new turn before its cancelled outcome, and its next turn keeps the earlier cookies", async (t) => {
  const s = fresh();
  const m = await mini(t, s);
  assert.equal((await m.turn(1)).kind, "success");
  const earlier = s.cookies.length;
  s.step = "hang";
  const hung = m.open(1, { deadlineMs: 800 });
  await new Promise((r) => setTimeout(r, 400));
  assert.equal(m.outcomes.has(hung.turn), false, "the slot is still busy before its deadline");
  const o = await hung.outcome;
  assert.equal(o.kind, "cancelled");
  s.step = "done";
  assert.equal((await m.turn(1)).kind, "success");
  const [first, hungCookie, next] = s.cookies.slice(earlier - 1);
  assert.ok(first === null || typeof first === "string");
  assert.ok(hungCookie && hungCookie === next, `the next turn kept the slot's cookie: ${hungCookie} → ${next}`);
});

test("a late response does not overwrite the jar", async (t) => {
  const s = fresh();
  const m = await mini(t, s);
  assert.equal((await m.turn(1)).kind, "success");
  s.step = "late";
  const late = await m.turn(1, { deadlineMs: 600 });
  assert.ok(late.kind === "timeout" || late.kind === "cancelled", late.kind);
  await new Promise((r) => setTimeout(r, 1500));
  s.step = "done";
  assert.equal((await m.turn(1)).kind, "success");
  const last = s.cookies.at(-1)!;
  assert.ok(last && !last.includes("late"), `the jar holds ${last}`);
});

/** The executor's heap, read through its inspector after a full collection. */
async function heapUsed(m: MiniSupervisor): Promise<number> {
  const url = /ws:\/\/[^\s]+/.exec(m.link.stderr())?.[0];
  assert.ok(url, m.link.stderr());
  const ws = new WebSocket(url);
  await new Promise((resolve, reject) => ((ws.onopen = resolve), (ws.onerror = reject)));
  let id = 0;
  const call = (method: string) =>
    new Promise<Record<string, unknown>>((resolve) => {
      const mine = ++id;
      ws.addEventListener("message", function on(e: MessageEvent) {
        const msg = JSON.parse(String(e.data)) as { id?: number; result?: Record<string, unknown> };
        if (msg.id === mine) {
          ws.removeEventListener("message", on);
          resolve(msg.result ?? {});
        }
      });
      ws.send(JSON.stringify({ id: mine, method }));
    });
  await call("HeapProfiler.collectGarbage");
  await call("HeapProfiler.collectGarbage");
  const usage = await call("Runtime.getHeapUsage");
  ws.close();
  return Number(usage.usedSize);
}

test("2000 turns: the heap stays bounded after a 200-context warm-up, and cookies survive", { timeout: 120_000 }, async (t) => {
  const s = fresh();
  const m = await mini(t, s, { nodeArgs: ["--inspect=127.0.0.1:0"] });
  const users = 10;
  let turns = 0;
  const round = async () => {
    const outcomes = await Promise.all(Array.from({ length: users }, (_, u) => m.turn(u + 1)));
    turns += users;
    for (const o of outcomes) assert.equal(o.kind, "success", o.message);
  };
  for (let i = 0; i < 20; i++) await round();
  const warm = await heapUsed(m);
  for (let i = 20; i < 200; i++) await round();
  const after = await heapUsed(m);
  assert.equal(turns, 2000);
  const growthMb = (after - warm) / 1024 / 1024;
  assert.ok(growthMb < 16, `heap grew ${growthMb.toFixed(1)} MB over 1800 turns`);
  assert.equal(s.cookies.filter((c) => c === null).length, users, "each slot was given one cookie, on its first turn, and sent it on every other");
});
