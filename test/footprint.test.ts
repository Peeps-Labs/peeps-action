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

test("a trace's requests and navigations are the footprint", async (t) => {
  const file = await traceFile(t, {
    "trace.network": {
      text: network(
        ["https://app.example.com/cart?x=1#y", "text/html; charset=utf-8"],
        ["https://app.example.com/api/cart", "application/json"],
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

const PW = 'import { test, expect } from "@playwright/test";\n';

function sources(tree: Record<string, string>, specs: string[], globalSetups: string[] = []) {
  return readTestSources(specs, globalSetups, Object.keys(tree), (file) => {
    const text = tree[file];
    if (text === undefined) throw new Error("gone");
    return text;
  });
}
const one = (text: string, extra: Record<string, string> = {}) => sources({ "e/a.spec.ts": text, ...extra }, ["e/a.spec.ts"]);

for (const [why, text] of [
  ["Playwright's test", `${PW}test("x", async () => {});`],
  ["aliased", 'import { test as it } from "@playwright/test";\nit("x", async () => {});'],
  ["a namespace", 'import * as pw from "@playwright/test";\npw.test("x", async () => {});'],
  ["required", 'const { test } = require("@playwright/test");\ntest("x", async () => {});'],
  ["a library's extend", `${PW}import dayjs from "dayjs";\ndayjs.extend(utc);\napp.use(cors());\ntest("x", async () => {});`],
  ["a package's helpers", `${PW}import AxeBuilder from "@axe-core/playwright";\nimport "dotenv/config";\ntest("x", async ({ page }) => { await new AxeBuilder({ page }).analyze(); });`],
  ["a device spread", `import { test, devices } from "@playwright/test";\ntest.use({ ...devices["iPhone 13"] });\ntest("x", async () => {});`],
  ["a literal use", `${PW}test.use({ viewport: { width: 1, height: 2 }, locale: "en" });\ntest("x", async () => {});`],
  ["an array in value position", `${PW}test.use({ permissions: ["clipboard-read"], launchOptions: { args: ["--x"] } });\ntest("x", async () => {});`],
  ["a helper with a title and a callback", `${PW}function step(t, f) {}\nstep("a", () => {});\ntest("x", async () => {});`],
  ["its own trace mentioned in a string", `${PW}// test.use({ trace: "on" })\nconst t = "trace: on";\ntest("x", async () => {});`],
] as const) {
  test(`records: ${why}`, () => {
    assert.deepEqual(one(text).reasons, []);
  });
}

const FIXTURES = `import { test as base } from "@playwright/test";
export const test = base.extend({ a: async ({}, use) => { await use(1); }, b: [async ({}, use) => { await use(2); }, { auto: true }] });
export { expect } from "@playwright/test";
`;

test("records: a local file extending Playwright's test, through a re-export, a star, an alias and merged tests", () => {
  const cases: Array<Record<string, string>> = [
    { "e/f.ts": FIXTURES },
    { "e/f.ts": 'export { test } from "./g";\n', "e/g.ts": FIXTURES },
    { "e/f.ts": 'export { test, expect } from "@playwright/test";\n' },
    { "e/f.ts": 'export * from "./g";\n', "e/g.ts": FIXTURES },
    { "e/f.ts": 'import { test as base } from "@playwright/test";\nconst more = base.extend({});\nexport { more as test };\n' },
    { "e/f.ts": 'import { test as a, mergeTests } from "@playwright/test";\nexport const test = mergeTests(a, a.extend({}));\n' },
    { "e/f.ts": 'import { test as a } from "@playwright/test";\nexport const test = a.extend({}).extend({});\n' },
  ];
  for (const extra of cases) {
    assert.deepEqual(one('import { test } from "./f";\ntest("x", async () => {});', extra).reasons, [], JSON.stringify(extra));
  }
});

for (const [why, text, extra] of [
  ["a package's test", 'import { test } from "@acme/fixtures";\ntest("x", async () => {});', {}],
  ["a package's test beside Playwright's", `${PW}import { authedTest } from "@acme/e2e";\ntest("x", async () => {});\nauthedTest("y", async () => {});`, {}],
  ["a package's test under another name", 'import { authedTest } from "@acme/e2e";\nauthedTest("x", async () => {});', {}],
  ["a package's namespace", 'import * as e2e from "@acme/e2e";\ne2e.test("x", async () => {});', {}],
  ["a package's default", 'import test from "@acme/fixtures";\ntest("x", async () => {});', {}],
  ["required from a package", 'const { test } = require("@acme/fixtures");\ntest("x", async () => {});', {}],
  ["re-exported from a package", 'import { test } from "./f";\ntest("x", async () => {});', { "e/f.ts": 'export { test } from "@acme/e2e";\n' }],
  ["imported late", 'const { test } = await import("@acme/e2e");\ntest("x", async () => {});', {}],
  ["no test at all", 'import { helper } from "@acme/e2e";\nhelper();', {}],
  ["a local wrapper around something else", 'import { test } from "./f";\ntest("x", async () => {});', { "e/f.ts": 'export const test = make();\n' }],
  ["its own trace", `${PW}test.use({ trace: "on" });\ntest("x", async () => {});`, {}],
  ["a shorthand trace", `${PW}const trace = "on";\ntest.use({ trace });\ntest("x", async () => {});`, {}],
  ["a quoted key", `${PW}test.use({ "trace": "on" });\ntest("x", async () => {});`, {}],
  ["a computed literal key", `${PW}test.use({ ["trace"]: "on" });\ntest("x", async () => {});`, {}],
  ["a computed key", `${PW}test.use({ [k]: "on" });\ntest("x", async () => {});`, {}],
  ["a spread", `${PW}import cfg from "./cfg.json";\ntest.use({ ...cfg });\ntest("x", async () => {});`, { "e/cfg.json": "{}" }],
  ["a value", `${PW}test.use(options);\ntest("x", async () => {});`, {}],
  ["extend with a value", `${PW}const t = test.extend(fixtures);\nt("x", async () => {});`, {}],
  ["extend with a trace fixture", `${PW}const t = test.extend({ trace: "on" });\nt("x", async () => {});`, {}],
  ["a helper's use", 'import { test } from "./f";\ntest("x", async () => {});', { "e/f.ts": 'import { test } from "@playwright/test";\ntest.use({ trace: "on" });\nexport { test };\n' }],
  ["its own tracing", `${PW}test("x", async ({ context }) => { await context.tracing.start(); });`, {}],
  ["tracing off a call", `${PW}test("x", async ({ page }) => { await page.context().tracing.start(); });`, {}],
] as const) {
  test(`doesn't record: ${why}, and says where`, () => {
    const found = one(text, extra);
    assert.ok(found.reasons.length > 0, "should read as a doubt");
    assert.match(found.reasons[0]!.file, /^e\//);
    assert.ok(found.reasons[0]!.why.length > 0);
  });
}

test("a spec that can't be read, or doesn't parse, is a doubt", () => {
  assert.ok(sources({}, ["e/gone.spec.ts"]).reasons.length > 0);
  assert.ok(one("export default function P( {{{").reasons.length > 0);
});

for (const [why, text, extra] of [
  ["a beforeAll", `${PW}test.beforeAll(async () => {});\ntest("x", async () => {});`, {}],
  ["Node's fetch", `${PW}test("x", async () => { await fetch("http://x/y"); });`, {}],
  ["globalThis.fetch", `${PW}test("x", async () => { await globalThis.fetch("http://x/y"); });`, {}],
  ["axios", `${PW}import axios from "axios";\ntest("x", async () => { await axios.get("/x"); });`, {}],
  ["got", `${PW}import got from "got";\ntest("x", async () => { await got("/x"); });`, {}],
  ["ky", `${PW}import ky from "ky";\ntest("x", async () => { await ky.get("/x"); });`, {}],
  ["ofetch", `${PW}import { ofetch as $f } from "ofetch";\ntest("x", async () => { await $f("/x"); });`, {}],
  ["supertest", `${PW}import st from "supertest";\ntest("x", async () => { await st(app).get("/x"); });`, {}],
  ["a named node:http", `${PW}import { request as r } from "node:http";\ntest("x", async () => { r("x"); });`, {}],
  ["an aliased https", `${PW}import { get as g } from "https";\ntest("x", async () => { g("x"); });`, {}],
  ["curl", `${PW}import { execSync } from "node:child_process";\ntest("x", async () => { execSync("curl x"); });`, {}],
  ["a required client", `${PW}const got = require("got");\ntest("x", async () => { await got("/x"); });`, {}],
  ["a standalone request context", `import { test, request } from "@playwright/test";\ntest("x", async () => { await request.newContext(); });`, {}],
  ["a worker fixture", 'import { test } from "./f";\ntest("x", async () => {});', { "e/f.ts": 'import { test as b } from "@playwright/test";\nexport const test = b.extend({ w: [async ({}, use) => { await use(1); }, { scope: "worker" }] });\n' }],
  ["a helper it calls", `${PW}import { h } from "./f";\ntest("x", async () => { await h(); });`, { "e/f.ts": 'export const h = () => fetch("/x");\n' }],
] as const) {
  test(`hidden requests: ${why}`, () => {
    const found = one(text, extra);
    assert.deepEqual(found.hiddenRequests, ["e/a.spec.ts"]);
    assert.deepEqual(found.reasons, [], "they don't turn recording off");
  });
}

for (const [why, text, extra] of [
  ["a browser's fetch", `${PW}test("x", async ({ page }) => { await page.evaluate(() => fetch("/x")); });`, {}],
  ["a route's fetch", `${PW}test("x", async ({ page }) => { await page.route("**", (r) => r.fetch()); });`, {}],
  ["the request fixture", `${PW}test("x", async ({ request }) => { await request.get("/x"); });`, {}],
  ["a test-scoped auto fixture", 'import { test } from "./f";\ntest("x", async () => {});', { "e/f.ts": FIXTURES }],
  ["a helper with a fetch it doesn't call", `${PW}import { other } from "./f";\ntest("x", async () => { other(); });`, { "e/f.ts": 'export const h = () => fetch("/x");\nexport const other = () => 1;\n' }],
] as const) {
  test(`not hidden: ${why}`, () => {
    assert.deepEqual(one(text, extra).hiddenRequests, []);
  });
}

test("one fetch in shared fixtures marks only the specs reaching it", () => {
  const found = sources(
    {
      "e/f.ts": `${FIXTURES}export const magic = () => fetch("/m");\nexport const plain = () => 1;\n`,
      "e/a.spec.ts": 'import { test, magic } from "./f";\ntest("x", async () => { await magic(); });',
      "e/b.spec.ts": 'import { test, plain } from "./f";\ntest("x", async () => { plain(); });',
    },
    ["e/a.spec.ts", "e/b.spec.ts"],
  );
  assert.deepEqual(found.hiddenRequests, ["e/a.spec.ts"]);
});

test("a helper put on globalThis counts only for the specs calling it by name", () => {
  const f = `${FIXTURES}async function magic() { await fetch("/m"); }\nObject.assign(globalThis, { magic, other: magic });\n`;
  const found = sources(
    {
      "e/f.ts": f,
      "e/a.spec.ts": 'import { test } from "./f";\ntest("x", async () => { await magic(); });',
      "e/b.spec.ts": 'import { test } from "./f";\ntest("x", async () => {});',
    },
    ["e/a.spec.ts", "e/b.spec.ts"],
  );
  assert.deepEqual(found.hiddenRequests, ["e/a.spec.ts"]);
});

test("a global setup making requests hides them from every test", () => {
  const tree = { "e/a.spec.ts": `${PW}test("x", async () => {});`, "e/b.spec.ts": `${PW}test("y", async () => {});` };
  assert.deepEqual(sources({ ...tree, "e/setup.ts": 'export default async () => { await fetch("/login"); };\n' }, ["e/a.spec.ts", "e/b.spec.ts"], ["e/setup.ts"]).hiddenRequests.sort(), ["e/a.spec.ts", "e/b.spec.ts"]);
  assert.deepEqual(sources({ ...tree, "e/setup.ts": 'import { chromium } from "@playwright/test";\nexport default async () => { await chromium.launch(); };\n' }, ["e/a.spec.ts"], ["e/setup.ts"]).hiddenRequests, ["e/a.spec.ts"]);
  assert.deepEqual(sources({ ...tree, "e/setup.ts": 'import { rmSync } from "node:fs";\nexport default () => rmSync("x");\n' }, ["e/a.spec.ts"], ["e/setup.ts"]).hiddenRequests, []);
});

test("a WebSocket's route is in the footprint: a trace holds it", async (t) => {
  const file = await traceFile(t, { "trace.network": { text: network(["wss://app.example.com/live/updates", undefined], ["https://app.example.com/a", "text/html"]) } });
  assert.deepEqual(footprintFromTrace([file], app), { paths: ["/a", "/live/updates"], complete: true });
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

test("neither a type nor an extension proves a file: only the framework's own assets go", async (t) => {
  const file = await traceFile(t, {
    "trace.network": {
      text: network(
        ["https://app.example.com/api/avatar", "image/png"],
        ["https://app.example.com/env.js", "application/javascript"],
        ["https://app.example.com/og.png", "image/png"],
        ["https://app.example.com/report.css", "text/css"],
        ["https://app.example.com/_next/static/chunk.js", "application/javascript"],
      ),
    },
  });
  assert.deepEqual(footprintFromTrace([file], app), { paths: ["/api/avatar", "/env.js", "/og.png", "/report.css"], complete: true });
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
