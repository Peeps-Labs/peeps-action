/**
 * The executor's transport against a fake Playwright: a send goes out exactly as its permit
 * says (method, origin, path and query), with only the options the transport allows, once,
 * and only while its permit is valid; the journey never reaches Playwright's own objects;
 * a user's context is made once, and a turn's sends are drained before the user is free.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { LoadRefusal, PERMIT_HEADER, UserSession, type PermitGrant, type RealContext, type RealResponse, type Turn } from "../src/load/transport";

interface Sent {
  url: string;
  options: Record<string, unknown>;
}

function fakePlaywright(opts: { hold?: () => Promise<void> } = {}) {
  const sent: Sent[] = [];
  const disposed: string[] = [];
  let contexts = 0;
  const secret = { reachable: "the real context" };
  const playwright = {
    async newContext(): Promise<RealContext> {
      contexts += 1;
      await new Promise((r) => setTimeout(r, 5));
      const context: RealContext = {
        async fetch(url, options) {
          sent.push({ url, options });
          if (opts.hold) await opts.hold();
          const response = {
            _requestContext: secret,
            status: () => 200,
            statusText: () => "OK",
            ok: () => true,
            url: () => url,
            headers: () => ({ "content-type": "application/json" }),
            headersArray: () => [{ name: "content-type", value: "application/json" }],
            body: async () => Buffer.from('{"value":42}'),
            text: async () => '{"value":42}',
            json: async () => ({ value: 42 }),
            dispose: async () => {
              disposed.push(url);
            },
          };
          return response as unknown as RealResponse;
        },
        storageState: async () => ({ cookies: [] }),
        dispose: async () => undefined,
      };
      return context;
    },
  };
  return { playwright, sent, disposed, contexts: () => contexts, secret };
}

function session(fake: ReturnType<typeof fakePlaywright>, clock: { now: number }, extra: Partial<{ usable: (p: PermitGrant) => boolean; expiresIn: number }> = {}) {
  let n = 0;
  const asked: { method: string; url: string }[] = [];
  const done: string[] = [];
  const s = new UserSession(fake.playwright, {
    baseURL: "http://app.test:8080",
    now: () => clock.now,
    usable: extra.usable ?? (() => true),
    ask: async ({ method, url }) => {
      asked.push({ method, url });
      return { id: `p${++n}`, expiresAt: clock.now + (extra.expiresIn ?? 1_000), generation: 1 };
    },
    done: (id) => done.push(id),
  });
  return { s, asked, done };
}

const turnOf = (clock: { now: number }, id = "t1"): Turn => ({ id, deadlineAt: clock.now + 5_000, ended: false });

type Api = Record<string, (...a: unknown[]) => Promise<Record<string, (...a: unknown[]) => unknown>>>;

test("a send goes to the permitted URL with only allowed options, once, with its permit", async () => {
  const fake = fakePlaywright();
  const clock = { now: 0 };
  const { s, asked, done } = session(fake, clock);
  const api = s.guarded(turnOf(clock)) as Api;
  await api.post!("/orders?x=1", { data: { sku: "a" }, headers: { "x-trace": "1" }, params: { page: 2 }, timeout: 60_000 });
  assert.deepEqual(asked, [{ method: "POST", url: "http://app.test:8080/orders?x=1&page=2" }]);
  assert.equal(fake.sent.length, 1);
  const { url, options } = fake.sent[0]!;
  assert.equal(url, "http://app.test:8080/orders?x=1&page=2");
  assert.equal(options.method, "POST");
  assert.equal(options.maxRetries, 0);
  assert.equal(options.maxRedirects, 0);
  assert.ok((options.timeout as number) <= 5_000, `timeout ${String(options.timeout)}`);
  assert.deepEqual(options.data, { sku: "a" });
  assert.equal("params" in options, false, "params must be in the permitted URL, not sent apart");
  assert.deepEqual(options.headers, { "x-trace": "1", [PERMIT_HEADER]: "p1" });
  assert.deepEqual(Object.keys(options).sort(), ["data", "headers", "maxRedirects", "maxRetries", "method", "timeout"]);
  assert.deepEqual(done, ["p1"]);
});

for (const [name, call] of [
  ["a url option, which Playwright would send instead", (api: Api) => api.get!("/value", { url: "http://evil.test/steal" })],
  ["a method option on a named verb", (api: Api) => api.get!("/value", { method: "DELETE" })],
  ["an option the transport doesn't know", (api: Api) => api.get!("/value", { proxy: { server: "http://evil.test" } })],
  ["a Host header", (api: Api) => api.get!("/value", { headers: { Host: "evil.test" } })],
  ["its own permit header", (api: Api) => api.get!("/value", { headers: { "x-peeps-load-permit": "forged" } })],
  ["retries", (api: Api) => api.get!("/value", { maxRetries: 3 })],
  ["redirects", (api: Api) => api.get!("/value", { maxRedirects: 2 })],
  ["a URL that isn't a string", (api: Api) => api.get!(new URL("http://app.test:8080/value"))],
  ["a URL with credentials", (api: Api) => api.get!("http://user:pw@app.test:8080/value")],
] as const) {
  test(`a send with ${name} is refused before any permit is asked`, async () => {
    const fake = fakePlaywright();
    const clock = { now: 0 };
    const { s, asked } = session(fake, clock);
    await assert.rejects(call(s.guarded(turnOf(clock)) as Api), LoadRefusal);
    assert.deepEqual(asked, []);
    assert.deepEqual(fake.sent, []);
  });
}

test("fetch takes its method from the options, and only a known one", async () => {
  const fake = fakePlaywright();
  const clock = { now: 0 };
  const { s, asked } = session(fake, clock);
  const api = s.guarded(turnOf(clock)) as Api;
  await api.fetch!("/value", { method: "put" });
  assert.deepEqual(asked, [{ method: "PUT", url: "http://app.test:8080/value" }]);
  await assert.rejects(api.fetch!("/value", { method: "CONNECT" }), LoadRefusal);
});

test("a permit that expired between the grant and the send is never used", async () => {
  const fake = fakePlaywright();
  const clock = { now: 0 };
  let n = 0;
  const done: string[] = [];
  const s = new UserSession(fake.playwright, {
    baseURL: "http://app.test:8080",
    now: () => clock.now,
    usable: () => true,
    ask: async () => {
      const grant = { id: `p${++n}`, expiresAt: clock.now + 100, generation: 1 };
      clock.now += 150; // a pause after the grant, before the send
      return grant;
    },
    done: (id) => done.push(id),
  });
  await assert.rejects((s.guarded(turnOf(clock)) as Api).get!("/value"), /permit expired/);
  assert.deepEqual(fake.sent, []);
  assert.deepEqual(done, ["p1"]);
});

test("a permit from a fenced generation is never used", async () => {
  const fake = fakePlaywright();
  const clock = { now: 0 };
  const { s, done } = session(fake, clock, { usable: () => false });
  await assert.rejects((s.guarded(turnOf(clock)) as Api).get!("/value"), /permit/);
  assert.deepEqual(fake.sent, []);
  assert.deepEqual(done, ["p1"]);
});

test("the journey gets a response it can read, never Playwright's own object", async () => {
  const fake = fakePlaywright();
  const clock = { now: 0 };
  const { s } = session(fake, clock);
  const res = await (s.guarded(turnOf(clock)) as Api).get!("/value");
  assert.equal(res.status!(), 200);
  assert.equal(res.ok!(), true);
  assert.deepEqual(await res.json!(), { value: 42 });
  assert.equal(await res.text!(), '{"value":42}');
  assert.deepEqual(res.headers!(), { "content-type": "application/json" });
  for (const value of Object.values(res)) assert.notEqual(value, fake.secret);
  assert.equal((res as Record<string, unknown>)._requestContext, undefined);
  assert.equal(Object.getPrototypeOf(res), Object.prototype);
});

test("parallel first sends share one context", async () => {
  const fake = fakePlaywright();
  const clock = { now: 0 };
  const { s } = session(fake, clock);
  const api = s.guarded(turnOf(clock)) as Api;
  await Promise.all([api.get!("/a"), api.get!("/b"), api.get!("/c")]);
  assert.equal(fake.contexts(), 1);
});

test("a turn's sends are drained before its user is free, and only its own responses disposed", async () => {
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  let holding = true;
  const fake = fakePlaywright({ hold: () => (holding ? gate : Promise.resolve()) });
  const clock = { now: 0 };
  const { s } = session(fake, clock);
  const first = turnOf(clock, "t1");
  // The journey returns with a send still outstanding.
  void (s.guarded(first) as Api).get!("/slow");
  await new Promise((r) => setTimeout(r, 20));
  first.ended = true;
  let drained = false;
  const draining = s.afterTurn(first).then(() => (drained = true));
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(drained, false, "the user was freed with a send outstanding");
  // A send the turn makes after it ended is refused.
  await assert.rejects((s.guarded(first) as Api).get!("/late"), /turn has ended/);
  holding = false;
  release();
  await draining;
  assert.deepEqual(fake.disposed, ["http://app.test:8080/slow"]);
  // The next turn's response stays until that turn ends.
  const second = turnOf(clock, "t2");
  await (s.guarded(second) as Api).get!("/next");
  assert.deepEqual(fake.disposed, ["http://app.test:8080/slow"]);
  second.ended = true;
  await s.afterTurn(second);
  assert.deepEqual(fake.disposed, ["http://app.test:8080/slow", "http://app.test:8080/next"]);
});
