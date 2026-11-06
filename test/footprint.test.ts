/** What a test's footprint keeps from a trace, and the trace policy's rule. Real traces are in targeted-action.test.ts. */
import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { deflateRawSync } from "node:zlib";

import { eventBatches, foldPath, hostsFor, keepsTrace, MAX_FOOTPRINT_PATHS, requestPaths, sentFootprint } from "../src/footprint/rules";
import { readTestSources } from "../src/footprint/test-trace";
import { footprintFromTrace, readZip } from "../src/footprint/trace-file";

/** A zip the way yazl writes one: local headers, central directory, end record. */
function zip(entries: Record<string, { text: string; stored?: boolean }>): Buffer {
  const locals: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const [name, { text, stored }] of Object.entries(entries)) {
    const raw = Buffer.from(text);
    const data = stored ? raw : deflateRawSync(raw);
    const nameBytes = Buffer.from(name);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(stored ? 0 : 8, 8);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(nameBytes.length, 26);
    locals.push(local, nameBytes, data);
    const entry = Buffer.alloc(46);
    entry.writeUInt32LE(0x02014b50, 0);
    entry.writeUInt16LE(stored ? 0 : 8, 10);
    entry.writeUInt32LE(data.length, 20);
    entry.writeUInt32LE(raw.length, 24);
    entry.writeUInt16LE(nameBytes.length, 28);
    entry.writeUInt32LE(offset, 42);
    central.push(entry, nameBytes);
    offset += local.length + nameBytes.length + data.length;
  }
  const directory = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(Object.keys(entries).length, 8);
  end.writeUInt16LE(Object.keys(entries).length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, directory, end]);
}

const network = (...entries: Array<[string, string?]>) =>
  entries
    .map(([url, mimeType]) => JSON.stringify({ type: "resource-snapshot", snapshot: { request: { url }, response: { content: { mimeType } } } }))
    .join("\n");

async function traceFile(t: TestContext, entries: Record<string, { text: string; stored?: boolean }>) {
  const dir = await mkdtemp(path.join(tmpdir(), "peeps-footprint-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, "trace.zip");
  await writeFile(file, zip(entries));
  return file;
}

const app = { baseUrls: ["https://app.example.com"], origins: [] };

test("readZip finds the entries by suffix, deflated or stored, and leaves the rest unread", async (t) => {
  const file = await traceFile(t, {
    "0-trace.network": { text: "one" },
    "1-trace.network": { text: "two", stored: true },
    "resources/big.png": { text: "x".repeat(10) },
  });
  assert.deepEqual(readZip(file, (name) => name.endsWith(".network")).sort(), ["one", "two"]);
});

test("a file that isn't a zip throws, so the caller reads it as unknown", async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), "peeps-footprint-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, "trace.zip");
  await writeFile(file, "not a zip");
  assert.throws(() => readZip(file, () => true));
});

test("a trace's requests and navigations are the footprint; assets are dropped by mime type and prefix", async (t) => {
  const file = await traceFile(t, {
    "trace.network": {
      text: network(
        ["https://app.example.com/cart?x=1#y", "text/html; charset=utf-8"],
        ["https://app.example.com/api/cart", "application/json"],
        ["https://app.example.com/logo.png", "image/png"],
        ["https://app.example.com/f.woff2", "font/woff2"],
        ["https://app.example.com/s.css", "text/css"],
        ["https://app.example.com/a.js", "application/javascript"],
        ["https://app.example.com/b.js", "text/javascript; charset=UTF-8"],
        ["https://app.example.com/_next/static/chunk.bin", "application/octet-stream"],
        ["https://app.example.com/redirected", undefined],
      ),
    },
    "trace.trace": {
      text: [
        JSON.stringify({ type: "before", class: "Frame", method: "goto", params: { url: "https://app.example.com/landing" } }),
        JSON.stringify({ type: "before", class: "Frame", method: "click", params: { selector: "x" } }),
      ].join("\n"),
    },
  });
  assert.deepEqual(footprintFromTrace([file], app), {
    paths: ["/api/cart", "/cart", "/landing", "/redirected"],
    complete: true,
  });
});

test("a navigation written relative to the base URL counts", async (t) => {
  const file = await traceFile(t, {
    "trace.network": { text: network(["https://app.example.com/a", "text/html"]) },
    "trace.trace": { text: JSON.stringify({ type: "before", class: "Frame", method: "goto", params: { url: "/landing" } }) },
  });
  assert.deepEqual(footprintFromTrace([file], app), { paths: ["/a", "/landing"], complete: true });
});

test("an empty .network is not a footprint: the trace had no snapshots", async (t) => {
  const file = await traceFile(t, {
    "trace.network": { text: "" },
    "trace.trace": { text: JSON.stringify({ type: "before", class: "Frame", method: "goto", params: { url: "https://app.example.com/x" } }) },
  });
  assert.deepEqual(footprintFromTrace([file], app), { paths: ["/x"], complete: false });
});

test("no trace, an unreadable trace, no baseURL, and nothing of the app are all incomplete", async (t) => {
  assert.deepEqual(footprintFromTrace([], app), { paths: [], complete: false });
  assert.deepEqual(footprintFromTrace(["/no/such/file.zip"], app), { paths: [], complete: false });
  const file = await traceFile(t, { "trace.network": { text: network(["https://app.example.com/cart", "text/html"]) } });
  assert.deepEqual(footprintFromTrace([file], { baseUrls: [], origins: [] }), { paths: [], complete: false });
  const other = await traceFile(t, { "trace.network": { text: network(["https://stripe.com/v1", "application/json"]) } });
  assert.deepEqual(footprintFromTrace([other], app), { paths: [], complete: false }, "a request, none of them the app's");
});

test("the 301st path makes the footprint incomplete and the request stays bounded", async (t) => {
  const many = Array.from({ length: MAX_FOOTPRINT_PATHS + 1 }, (_, i) => [`https://app.example.com/p${i}`, "text/html"] as [string, string]);
  const file = await traceFile(t, { "trace.network": { text: network(...many) } });
  const out = footprintFromTrace([file], app);
  assert.equal(out.complete, false);
  assert.equal(out.paths.length, MAX_FOOTPRINT_PATHS);
  const exact = await traceFile(t, { "trace.network": { text: network(...many.slice(1)) } });
  assert.equal(footprintFromTrace([exact], app).complete, true);
});

test("a corrupt .network line makes it incomplete", async (t) => {
  const file = await traceFile(t, { "trace.network": { text: `${network(["https://app.example.com/a", "text/html"])}\n{not json` } });
  assert.equal(footprintFromTrace([file], app).complete, false);
});

test("origins: the last two labels, a job network's single labels, loopback, listed origins", () => {
  const keeps = (baseUrls: string[], origins: string[], url: string) => hostsFor({ baseUrls, origins })?.(new URL(url).hostname);
  assert.equal(keeps(["https://app.example.com"], [], "https://api.example.com/x"), true, "a sibling");
  assert.equal(keeps(["https://app.example.com"], [], "https://example.com/x"), true);
  assert.equal(keeps(["https://app.example.com"], [], "https://stripe.com/x"), false);
  assert.equal(keeps(["https://app.example.com"], ["https://api.other.io:8443"], "https://api.other.io/x"), true, "listed");
  assert.equal(keeps(["https://app.example.com"], ["not a url"], "https://stripe.com/x"), false, "a bad listing adds nothing");
  assert.equal(keeps(["http://app:3000"], [], "http://api:4000/x"), true, "job network names");
  assert.equal(keeps(["http://app:3000"], [], "https://stripe.com/x"), false);
  assert.equal(keeps(["http://localhost:3000"], [], "http://127.0.0.1:4000/x"), true, "loopback is one machine");
  assert.equal(keeps(["http://127.0.0.1:3000"], [], "http://localhost:4000/x"), true);
  assert.equal(keeps(["http://10.1.2.3:3000"], [], "http://10.1.2.3:4000/x"), true);
  assert.equal(keeps(["http://10.1.2.3:3000"], [], "http://10.9.2.3:4000/x"), false, "an address has no parent domain");
  assert.equal(hostsFor({ baseUrls: [], origins: [] }), null, "no baseURL");
  assert.equal(hostsFor({ baseUrls: ["relative/not-a-url"], origins: [] }), null);
  assert.equal(keeps(["https://a.example.com", "https://b.other.org"], [], "https://x.other.org/"), true, "both of BASE_URL and use.baseURL");
});

test("folding keeps a route's shape and nothing private", () => {
  assert.equal(foldPath("/orders/123456/items"), "/orders/:id/items", "6 digits");
  assert.equal(foldPath("/orders/12345/items"), "/orders/12345/items", "5 digits stay");
  assert.equal(foldPath("/o/3f2504e0-4f89-41d3-9a0c-0305e82c3301"), "/o/:id");
  assert.equal(foldPath(`/invite/${"a1B2".repeat(8)}`), "/invite/:id", "a 32-character token");
  assert.equal(foldPath("/a/this-is-a-readable-slug"), "/a/this-is-a-readable-slug");
  assert.equal(foldPath(`/a/${"long-readable-".repeat(8)}`), `/a/${"long-readable-".repeat(8)}`, "no digit: a long route's name, as the server folds");
  assert.equal(foldPath("/a/release-2024-sum"), "/a/release-2024-sum", "under 20: the server's rule");
  assert.equal(foldPath("/a/release-2024-summary"), "/a/:id", "20 with a digit");
  assert.equal(foldPath("/users/me%40example.com"), "/users/:id", "an address");
  assert.equal(foldPath("/users/me@example.com"), "/users/:id");
  assert.equal(foldPath("/"), "/");
});

test("eventBatches keeps the order and stays under both of the route's limits", () => {
  const big = { type: "test_end", pad: "x".repeat(400_000) };
  const small = { type: "run_end" };
  const batches = eventBatches([big, big, big, small]);
  assert.deepEqual(batches.map((b) => b.length), [2, 2]);
  assert.deepEqual(batches.flat(), [big, big, big, small]);
  assert.deepEqual(eventBatches([]), []);
  assert.equal(eventBatches(Array.from({ length: 501 }, () => small)).length, 2, "500 events a request");
  assert.equal(eventBatches([{ type: "x", pad: "x".repeat(2_000_000) }]).length, 1, "one too large goes alone, and the route says so");
});

test("what's sent says its attempt, and a repeated test is never whole", () => {
  const whole = { paths: ["/a"], complete: true };
  assert.deepEqual(sentFootprint(whole, ["https://api.x.io"], { retry: 2, repeatEachIndex: 0, repeatEach: 1, hiddenRequests: false }), { paths: ["/a"], complete: true, attempt: { retry: 2 }, origins: ["https://api.x.io"] });
  assert.equal(sentFootprint(whole, [], { retry: 0, repeatEachIndex: 1, repeatEach: 2, hiddenRequests: false }).complete, false);
  assert.equal(sentFootprint(whole, [], { retry: 0, repeatEachIndex: 0, repeatEach: 2, hiddenRequests: false }).complete, false, "the first repeat collides too");
  assert.equal(sentFootprint({ paths: [], complete: false }, [], { retry: 0, repeatEachIndex: 0, repeatEach: 1, hiddenRequests: false }).complete, false);
});

function sources(tree: Record<string, string>, ...specs: string[]) {
  return readTestSources(specs, Object.keys(tree), (file) => {
    const text = tree[file];
    if (text === undefined) throw new Error("gone");
    return text;
  });
}

test("whether a test may set its own trace, through what specs import", () => {
  const tree: Record<string, string> = {
    "e2e/a.spec.ts": 'import { h } from "./h";\ntest("x", h);\n',
    "e2e/h.ts": "export const h = 1;\n",
    "e2e/own.spec.ts": 'test.use({ trace: "on" });\n',
    "e2e/quiet.spec.ts": '// test.use({ trace: "on" })\nconst text = "trace";\n',
    "e2e/short.spec.ts": "const trace = 'on';\ntest.use({ trace });\n",
    "e2e/imports.spec.ts": 'import "./own.spec";\n',
    "unrelated.ts": 'x({ trace: "on" });\n',
  };
  const ask = (...specs: string[]) => sources(tree, ...specs).maySetTrace;
  assert.equal(ask("e2e/a.spec.ts", "e2e/quiet.spec.ts"), false, "nothing reachable sets it; comments and strings don't count");
  assert.equal(ask("e2e/own.spec.ts"), true);
  assert.equal(ask("e2e/short.spec.ts"), true, "shorthand");
  assert.equal(ask("e2e/imports.spec.ts"), true, "through an import");
  assert.equal(ask("e2e/gone.spec.ts"), true, "a file it can't read is a doubt");
});

for (const [why, text, expected] of [
  ["its own tracing", "test('x', async ({ context }) => { await context.tracing.start(); });", true],
  ["a quoted key", `test.use({ 'trace': 'on' });`, true],
  ["a double-quoted key", `test.use({ "trace": "on" });`, true],
  ["a computed literal key", `test.use({ ["trace"]: "on" });`, true],
  ["a computed key", `const k = "tr" + "ace"; test.use({ [k]: "on" });`, true],
  ["a spread", `import cfg from "./cfg.json";\ntest.use({ ...cfg });`, true],
  ["a spread of the environment", `test.use({ ...JSON.parse(process.env.X!) });`, true],
  ["a value that isn't a literal", `test.use(options);`, true],
  ["extend with a value", `const t = base.extend(fixtures);`, true],
  ["extend with a spread", `const t = base.extend({ ...fixtures });`, true],
  ["a package's test", `import { test } from "@acme/fixtures";\ntest("x", () => {});`, true],
  ["a package's test by another name", `import { fixtures as test } from "acme";`, true],
  ["a package's default", `import test from "@acme/fixtures";`, true],
  ["a required test", `const { test } = require("@acme/fixtures");`, true],
  ["a package with no bindings", `import "@acme/setup";`, true],
  ["a relative import that resolves nowhere", `import x from "./generated";`, true],
  ["a rule hidden after a regex", `const a = x.replace(/\\/*$/, "");\ntest.use({ trace: "on" });`, true],
  ["Playwright's own test", `import { test, expect } from "@playwright/test";\ntest("x", () => {});`, false],
  ["a library", `import { faker } from "@faker-js/faker";\nimport path from "node:path";`, false],
  ["a literal use", `test.use({ viewport: { width: 1, height: 2 }, locale: "en" });`, false],
  ["extend with fixtures that spread inside", `const t = base.extend({ page: async ({ page }, use) => { const a = [...b]; await use(page); } });`, false],
  ["a fixture calling use", `await use(page);`, false],
] as const) {
  test(`own trace: ${why} reads ${expected}`, () => {
    assert.equal(sources({ "e/a.spec.ts": text }, "e/a.spec.ts").maySetTrace, expected);
  });
}

test("requests a trace can't see: a spec whose closure may make them can't claim a whole footprint", () => {
  const tree: Record<string, string> = {
    "e/hook.spec.ts": `test.beforeAll(async () => {});`,
    "e/node.spec.ts": `import { api } from "./client";\ntest("x", api);`,
    "e/client.ts": `export const api = () => fetch("http://x/y");`,
    "e/axios.spec.ts": `import axios from "axios";\naxios.get("/x");`,
    "e/http.spec.ts": `import http from "node:http";\nhttp.request("x");`,
    "e/clean.spec.ts": `test("x", async ({ page, request }) => { await page.route("**", (r) => r.fetch()); await request.get("/x"); });`,
  };
  assert.deepEqual(sources(tree, "e/hook.spec.ts", "e/node.spec.ts", "e/axios.spec.ts", "e/http.spec.ts", "e/clean.spec.ts").hiddenRequests.sort(), ["e/axios.spec.ts", "e/hook.spec.ts", "e/http.spec.ts", "e/node.spec.ts"]);
});

test("a repeated test and a spec with hidden requests are never whole", () => {
  const whole = { paths: ["/a"], complete: true };
  assert.equal(sentFootprint(whole, [], { retry: 0, repeatEachIndex: 0, repeatEach: 1, hiddenRequests: true }).complete, false);
  assert.equal(sentFootprint(whole, [], { retry: 0, repeatEachIndex: 0, repeatEach: 1, hiddenRequests: false }).complete, true);
});

test("a Pages Router client navigation is the page's own path", () => {
  assert.deepEqual(requestPaths("https://a.co/_next/data/abc123/cart.json?x=1"), ["/_next/data/abc123/cart.json", "/cart"]);
  assert.deepEqual(requestPaths("https://a.co/_next/data/abc123/index.json"), ["/_next/data/abc123/index.json", "/"]);
  assert.deepEqual(requestPaths("https://a.co/_next/data/abc123/orders/7.json"), ["/_next/data/abc123/orders/7.json", "/orders/7"]);
});

test("a type doesn't prove a resource is static: an endpoint serving an image stays, a file doesn't", async (t) => {
  const file = await traceFile(t, {
    "trace.network": {
      text: network(
        ["https://app.example.com/api/avatar", "image/png"],
        ["https://app.example.com/report", "text/css"],
        ["https://app.example.com/bundle", "application/javascript"],
        ["https://app.example.com/logo.png", "image/png"],
        ["https://app.example.com/page", "text/html"],
      ),
    },
  });
  assert.deepEqual(footprintFromTrace([file], app), { paths: ["/api/avatar", "/bundle", "/page", "/report"], complete: true });
});

test("nothing private leaves in a path", () => {
  const jwt = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.abc-def_123";
  assert.equal(foldPath(`/s/${jwt}`), "/s/:id", "a JWT");
  assert.equal(foldPath("/call/+15551234567"), "/call/:id", "a phone number");
  assert.equal(foldPath("/call/%2B15551234567"), "/call/:id", "encoded");
  assert.equal(foldPath("/call/555-123-4567"), "/call/:id", "with dashes");
  assert.equal(foldPath("/invite/aB3xY9qZ"), "/invite/:id", "a short mixed token");
  assert.equal(foldPath("/t/deadbeef1234"), "/t/:id", "hex");
  assert.equal(foldPath("/t/AbCdEfGhIjKlMnOpQ"), "/t/:id", "long mixed letters");
  assert.equal(foldPath("/o/order-1234567"), "/o/:id", "a long number inside");
  assert.equal(foldPath("/reset/aGVsbG8xMjM0NTY3ODk="), "/reset/:id", "base64 padding");
  assert.equal(foldPath("/reset/aGVsbG8xMjM0NTY3ODk%3D"), "/reset/:id", "encoded");
  assert.equal(foldPath("/cart;jsessionid=A1B2C3D4E5F6A7B8"), "/cart", "a path parameter never leaves");
  assert.equal(foldPath("/cart;jsessionid=A1B2/items"), "/cart/items");
  assert.equal(foldPath("/u/+1%20555%20123%204567"), "/u/:id", "a phone number with spaces");
  assert.equal(foldPath("/u/4111%201111%201111%201111"), "/u/:id", "a card number");
  assert.equal(foldPath("/t/1234_5678_9012_3456_7890"), "/t/:id", "digits between underscores");
  assert.equal(foldPath("/t/1234_5678_9012"), "/t/:id", "shorter");
  assert.equal(foldPath("/x/%E0%A4%A"), "/x/:id", "what can't be decoded");
  assert.equal(foldPath("/api/trpc/runs.list"), "/api/trpc/runs.list", "a procedure stays");
  assert.equal(foldPath("/oauth2/callback/step1"), "/oauth2/callback/step1", "a route's name stays");
  assert.equal(foldPath("/settings/api-keys/v2"), "/settings/api-keys/v2");
  assert.equal(foldPath("/blog/2026-11-06"), "/blog/2026-11-06", "a date");
});

test("a budget across a trace's entries: over it reads as unknown", async (t) => {
  const file = await traceFile(t, { "a.network": { text: "x".repeat(100) }, "b.network": { text: "y".repeat(100) } });
  assert.equal(readZip(file, (n) => n.endsWith(".network"), { left: 250 }).length, 2);
  assert.throws(() => readZip(file, (n) => n.endsWith(".network"), { left: 150 }));
});

test("requestPaths: no host or query, and a tRPC batch is one path per procedure", () => {
  assert.deepEqual(requestPaths("https://a.co/api/trpc/a.b,c.d?batch=1&input=%7B%7D"), ["/api/trpc/a.b", "/api/trpc/c.d"]);
  assert.deepEqual(requestPaths("https://a.co/cart/?x=secret"), ["/cart"]);
  assert.deepEqual(requestPaths("https://a.co/"), ["/"]);
});

test("each policy keeps exactly the attempts Playwright would have kept", () => {
  const attempt = (status: string, retry: number) => ({ status, retry, expectedStatus: "passed" });
  const table: Array<[string, ReturnType<typeof attempt>, boolean]> = [
    ["off", attempt("failed", 0), false],
    ["off", attempt("passed", 0), false],
    ["on", attempt("passed", 0), true],
    ["on", attempt("failed", 1), true],
    ["retain-on-failure", attempt("passed", 0), false],
    ["retain-on-failure", attempt("failed", 0), true],
    ["retain-on-failure", attempt("timedOut", 1), true],
    ["on-first-retry", attempt("failed", 0), false],
    ["on-first-retry", attempt("failed", 1), true],
    ["on-first-retry", attempt("passed", 1), true],
    ["on-first-retry", attempt("failed", 2), false],
    ["on-all-retries", attempt("failed", 0), false],
    ["on-all-retries", attempt("passed", 2), true],
    ["retain-on-first-failure", attempt("failed", 0), true],
    ["retain-on-first-failure", attempt("passed", 0), false],
    ["retain-on-first-failure", attempt("failed", 1), false],
    ["retain-on-failure-and-retries", attempt("passed", 0), false],
    ["retain-on-failure-and-retries", attempt("failed", 0), true],
    ["retain-on-failure-and-retries", attempt("passed", 1), true],
  ];
  for (const [policy, at, keep] of table) {
    assert.equal(keepsTrace(policy, at), keep, `${policy} ${at.status} retry ${at.retry}`);
  }
  assert.equal(keepsTrace("failed", { status: "passed", retry: 0, expectedStatus: "failed" }), true, "a mode from a later Playwright is left alone");
  assert.equal(keepsTrace(undefined, attempt("passed", 0)), true, "the wrapper didn't apply: nothing of ours to delete");
  assert.equal(keepsTrace("retain-on-failure", { status: "failed", retry: 0, expectedStatus: "failed" }), false, "a test.fail() that failed went as expected");
});
