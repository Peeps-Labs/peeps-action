/**
 * The gate's proxy, request rebuilding and dialling (plan v3 §5, §10 `load-proxy`).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { connect as netConnect } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { connect as tlsConnect, createServer as createTlsServer } from "node:tls";
import type { AddressInfo } from "node:net";
import { Gate, type Clocks } from "../src/load/gate/admission";
import { createRunCa } from "../src/load/gate/ca";
import { Journal } from "../src/load/gate/journal";
import { canonicalOrigin, normalize, parseAuthority, type ArrivedRequest, type RequestPolicy } from "../src/load/gate/normalize";
import { DENIED_HEADER, GateProxy, type Dial } from "../src/load/gate/proxy";
import { ResponseReader } from "../src/load/gate/response";
import { checkedAddress, classify, connectVerified, DialRefused, type ApprovedOrigin } from "../src/load/gate/resolve";
import { startSink, type Sink, type SinkOptions } from "./support/load-sink";

// ---------------------------------------------------------------- normalize

const A = parseAuthority("shop.test:443")!;
const POLICY: RequestPolicy = { allowedOrigins: ["https://shop.test"], allowedRequests: [{ method: "POST", path: "/cart" }] };
const arrived = (over: Partial<ArrivedRequest> = {}): ArrivedRequest => ({ method: "GET", target: "/", httpVersion: "1.1", rawHeaders: ["Host", "shop.test"], body: Buffer.alloc(0), ...over });
const norm = (over: Partial<ArrivedRequest> = {}, servername: string | null = "shop.test", policy = POLICY) => normalize(arrived(over), { authority: A, servername: servername ?? undefined }, policy);
const why = (n: ReturnType<typeof normalize>) => (n.ok ? "ok" : n.reason);

test("a CONNECT authority must be exactly host:port, a lower-case approved name", () => {
  assert.deepEqual(parseAuthority("shop.test:443"), { host: "shop.test", port: 443, origin: "https://shop.test" });
  assert.equal(parseAuthority("shop.test:8443")?.origin, "https://shop.test:8443");
  for (const bad of ["SHOP.test:443", "shop.test", "shop.test:0443", "shop.test:70000", "127.0.0.1:443", "[::1]:443", "user@shop.test:443", "shop.test.:443", "localhost:443", "*.shop.test:443", "shop.test:443/x"]) {
    assert.equal(parseAuthority(bad), undefined, bad);
  }
  assert.equal(canonicalOrigin("shop.test", 443), new URL("https://shop.test:443").origin);
  assert.equal(canonicalOrigin("shop.test", 8443), new URL("https://shop.test:8443").origin);
});

test("normalize rebuilds the request: fixed headers, own framing, Connection: close", () => {
  const n = norm({ rawHeaders: ["Host", "shop.test", "Accept", "*/*", "Cookie", "a=1", "X-Secret", "s", "Connection", "keep-alive", "Proxy-Authorization", "Basic x"] });
  assert.ok(n.ok);
  assert.equal(n.head, "GET / HTTP/1.1\r\nhost: shop.test\r\naccept: */*\r\ncookie: a=1\r\nconnection: close\r\n\r\n");
  const post = norm({ method: "POST", target: "/cart", rawHeaders: ["Host", "shop.test:443", "Content-Type", "application/json", "Content-Length", "2"], body: Buffer.from("{}") });
  assert.ok(post.ok);
  assert.match(post.head, /^POST \/cart HTTP\/1\.1\r\nhost: shop\.test\r\ncontent-type: application\/json\r\ncontent-length: 2\r\nconnection: close\r\n\r\n$/);
  const named = norm({ rawHeaders: ["Host", "shop.test", "X-Api-Key", "k"] }, "shop.test", { ...POLICY, headers: ["X-Api-Key"] });
  assert.ok(named.ok && named.head.includes("x-api-key: k\r\n"), "a header the policy names passes");
});

test("normalize refuses every request it cannot rebuild one way only", () => {
  const cases: [string, Partial<ArrivedRequest>, string][] = [
    ["absolute-form", { target: "https://shop.test/" }, "form"],
    ["authority-form", { target: "shop.test:443" }, "form"],
    ["asterisk", { method: "OPTIONS", target: "*" }, "form"],
    ["HTTP/1.0", { httpVersion: "1.0" }, "version"],
    ["CONNECT inside the tunnel", { method: "CONNECT", target: "/" }, "method"],
    ["TRACE", { method: "TRACE" }, "method"],
    ["Transfer-Encoding", { rawHeaders: ["Host", "shop.test", "Transfer-Encoding", "identity"] }, "header"],
    ["TE", { rawHeaders: ["Host", "shop.test", "TE", "trailers"] }, "header"],
    ["Trailer", { rawHeaders: ["Host", "shop.test", "Trailer", "x"] }, "header"],
    ["Upgrade", { rawHeaders: ["Host", "shop.test", "Upgrade", "websocket"] }, "header"],
    ["Expect", { rawHeaders: ["Host", "shop.test", "Expect", "100-continue"] }, "header"],
    ["no Host", { rawHeaders: [] }, "host"],
    ["two Hosts", { rawHeaders: ["Host", "shop.test", "Host", "shop.test"] }, "host"],
    ["another Host", { rawHeaders: ["Host", "evil.test"] }, "host"],
    ["Host with another port", { rawHeaders: ["Host", "shop.test:8443"] }, "host"],
    ["two Content-Lengths", { method: "POST", target: "/cart", rawHeaders: ["Host", "shop.test", "Content-Length", "0", "Content-Length", "0"] }, "length"],
    ["a wrong Content-Length", { method: "POST", target: "/cart", rawHeaders: ["Host", "shop.test", "Content-Length", "5"], body: Buffer.from("{}") }, "length"],
    ["a body on GET", { body: Buffer.from("x") }, "length"],
    ["a header value with CR", { rawHeaders: ["Host", "shop.test", "Cookie", "a\rb"] }, "header"],
    ["a body over 1 MiB", { method: "POST", target: "/cart", body: Buffer.alloc(1024 * 1024 + 1) }, "too_large"],
    ["a write not in the plan", { method: "POST", target: "/admin" }, "not_allowed"],
    ["the right path, the wrong method", { method: "DELETE", target: "/cart" }, "not_allowed"],
  ];
  for (const [label, over, reason] of cases) assert.equal(why(norm(over)), reason, label);
  for (const p of ["//cart", "/a//b", "/a/./b", "/a/../cart", "/..", "/%2e%2e/cart", "/a%2Fb", "/a%5cb", "/a\\b", "/a%00", "/a%zz", "/a b", "/a#f"]) {
    assert.equal(why(norm({ target: p })), "path", p);
  }
  assert.equal(why(norm({ target: "/a/b/?q=1&r=/x" })), "ok", "a query may hold slashes");
  assert.equal(why(norm({ method: "POST", target: "/cart?x=1", rawHeaders: ["Host", "shop.test", "Content-Length", "0"] })), "ok", "policy checks the path without its query");
  assert.equal(why(norm({}, null)), "sni", "no SNI");
  assert.equal(why(norm({}, "other.test")), "sni", "SNI for another host");
  assert.equal(why(normalize(arrived(), { authority: parseAuthority("other.test:443")!, servername: "other.test" }, POLICY)), "origin");
});

// ---------------------------------------------------------------- resolve

test("the address table: only public, or private where approved, is reachable", () => {
  const table: [string, string][] = [
    ["93.184.216.34", "public"],
    ["2606:4700::1111", "public"],
    ["10.0.0.1", "private"],
    ["172.16.5.4", "private"],
    ["192.168.1.1", "private"],
    ["100.64.0.1", "private"],
    ["fd12::1", "private"],
    ["0.0.0.0", "unspecified"],
    ["::", "unspecified"],
    ["0.1.2.3", "this_network"],
    ["127.0.0.1", "loopback"],
    ["127.9.9.9", "loopback"],
    ["::1", "loopback"],
    ["::ffff:127.0.0.1", "loopback"],
    ["::ffff:7f00:1", "loopback"],
    ["169.254.1.1", "link_local"],
    ["fe80::1", "link_local"],
    ["169.254.169.254", "metadata"],
    ["168.63.129.16", "metadata"],
    ["100.100.100.200", "metadata"],
    ["fd00:ec2::254", "metadata"],
    ["::ffff:169.254.169.254", "metadata"],
    ["64:ff9b::a9fe:a9fe", "metadata"],
    ["2002:a9fe:a9fe::", "metadata"],
    ["224.0.0.1", "multicast"],
    ["ff02::1", "multicast"],
    ["240.0.0.1", "reserved"],
    ["2001:db8::1", "reserved"],
    ["fe80::1%eth0", "invalid"],
    ["not-an-ip", "invalid"],
  ];
  for (const [address, expected] of table) assert.equal(classify(address), expected, address);
});

const ORIGIN: ApprovedOrigin = { host: "shop.test", port: 443, allowPrivate: false };
const lookupOf = (...addresses: string[]) => async () => addresses.map((address) => ({ address, family: address.includes(":") ? 6 : 4 }));
const refusal = async (p: Promise<unknown>) => {
  try {
    await p;
    return "ok";
  } catch (e) {
    assert.ok(e instanceof DialRefused, String(e));
    return e.reason;
  }
};

test("a name is refused if any address it resolves to is out of reach", async () => {
  assert.equal(await checkedAddress(ORIGIN, { lookup: lookupOf("93.184.216.34") }), "93.184.216.34");
  assert.equal(await refusal(checkedAddress(ORIGIN, { lookup: lookupOf("93.184.216.34", "169.254.169.254") })), "address", "one bad address refuses the name");
  assert.equal(await refusal(checkedAddress(ORIGIN, { lookup: lookupOf("10.0.0.5") })), "address", "private needs the Owner's approval");
  assert.equal(await checkedAddress({ ...ORIGIN, allowPrivate: true }, { lookup: lookupOf("10.0.0.5") }), "10.0.0.5");
  assert.equal(await refusal(checkedAddress({ ...ORIGIN, allowPrivate: true }, { lookup: lookupOf("fd00:ec2::254") })), "address", "metadata, never");
  assert.equal(await refusal(checkedAddress({ ...ORIGIN, allowPrivate: true }, { lookup: lookupOf("::ffff:127.0.0.1") })), "address", "a mapped loopback");
  assert.equal(await refusal(checkedAddress(ORIGIN, { lookup: lookupOf() })), "resolve");
  assert.equal(await refusal(checkedAddress(ORIGIN, { lookup: async () => Promise.reject(new Error("NXDOMAIN")) })), "resolve");
  assert.equal(await refusal(checkedAddress({ ...ORIGIN, host: "93.184.216.34" }, { lookup: lookupOf("93.184.216.34") })), "resolve", "an address literal");
});

test("the dial verifies the approved name, requires HTTP/1.1, and ignores the job's TLS settings", async (t) => {
  const sink = await startSink();
  const other = await startSink({ host: "other.test" });
  // A TLS server that agrees to no application protocol.
  const noAlpnCa = createRunCa({ hosts: ["sink.test"], nowMs: Date.now(), validForMs: 3_600_000 });
  const noAlpnLeaf = noAlpnCa.leaf("sink.test")!;
  const noAlpnServer = createTlsServer({ cert: noAlpnLeaf.certPem, key: noAlpnLeaf.key.export({ type: "pkcs8", format: "pem" }) }, (s) => s.destroy());
  await new Promise<void>((resolve) => noAlpnServer.listen(0, "127.0.0.1", resolve));
  const noAlpn = { port: (noAlpnServer.address() as AddressInfo).port, caPem: noAlpnCa.certPem } as Sink;
  t.after(() => Promise.all([sink.close(), other.close(), new Promise((resolve) => noAlpnServer.close(resolve))]));
  const at = (s: Sink, host = "sink.test"): ApprovedOrigin => ({ host, port: s.port, allowPrivate: false });

  const ok = await connectVerified("127.0.0.1", at(sink), { ca: [sink.caPem] });
  assert.equal(ok.socket.alpnProtocol, "http/1.1");
  ok.reset();
  assert.equal(await refusal(connectVerified("127.0.0.1", at(other), { ca: [other.caPem] })), "tls", "a certificate for another name");
  assert.equal(await refusal(connectVerified("127.0.0.1", at(noAlpn), { ca: [noAlpn.caPem] })), "alpn");

  const saved = process.env.NODE_TLS_REJECT_UNAUTHORIZED;
  process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";
  try {
    assert.equal(await refusal(connectVerified("127.0.0.1", at(sink))), "tls", "NODE_TLS_REJECT_UNAUTHORIZED=0 is ignored; the fixture CA is not a bundled root");
  } finally {
    if (saved === undefined) delete process.env.NODE_TLS_REJECT_UNAUTHORIZED;
    else process.env.NODE_TLS_REJECT_UNAUTHORIZED = saved;
  }
  const aborted = new AbortController();
  aborted.abort();
  assert.equal(await refusal(connectVerified("127.0.0.1", at(sink), { ca: [sink.caPem], signal: aborted.signal })), "aborted");
});

// ---------------------------------------------------------------- the proxy, end to end

const CREDENTIAL = `Basic ${Buffer.from("turn:secret").toString("base64")}`;

interface Rig {
  proxy: GateProxy;
  gate: Gate;
  journal: Journal;
  sink: Sink;
  socketPath: string;
  runCaPem: string;
  turn: number;
  authority: string;
  clock: Clocks;
}

async function rig(t: import("node:test").TestContext, opts: { dial?: (inner: Dial) => Dial; maxPendingDialsPerTurn?: number; respond?: SinkOptions["respond"] } = {}): Promise<Rig> {
  const sink = await startSink({ respond: opts.respond });
  const origin = canonicalOrigin("sink.test", sink.port);
  const clock: Clocks = { monoMs: 0, wallMs: 1_700_000_000_000 };
  const gate = new Gate({
    origins: { [origin]: 1000 },
    methods: ["GET", "POST"],
    maxOutstandingPerTurn: 4,
    runTotal: 1000,
    turnDeadlineMs: 60_000,
    runEndMono: 1_000_000,
    phase: { ratePerSecond: 100, burst: 50, maxUsers: 4, total: 1000 },
  });
  gate.applyLease({ seq: 1, monoUntil: 10_000, wallUntil: clock.wallMs + 10_000, ceiling: 1000 });
  const opened = gate.openTurn("s1", clock);
  assert.ok(opened.ok);
  const journal = new Journal();
  const ca = createRunCa({ hosts: ["sink.test"], nowMs: Date.now(), validForMs: 60 * 60 * 1000 });
  const base: Dial = (o, signal) => connectVerified("127.0.0.1", o, { ca: [sink.caPem], signal });
  const proxy = new GateProxy({
    gate,
    journal,
    ca,
    policy: { allowedOrigins: [origin], allowedRequests: [{ method: "POST", path: "/cart" }] },
    origins: new Map([[origin, { host: "sink.test", port: sink.port, allowPrivate: false }]]),
    authorize: (c) => (c === CREDENTIAL ? opened.turn : undefined),
    maxPendingDialsPerTurn: opts.maxPendingDialsPerTurn ?? 4,
    maxPendingDials: 16,
    clocks: () => ({ ...clock }),
    dial: opts.dial ? opts.dial(base) : base,
  });
  const socketPath = path.join(mkdtempSync(path.join(tmpdir(), "load-proxy-")), "proxy.sock");
  await proxy.listen(socketPath);
  t.after(async () => {
    await proxy.close();
    await sink.close();
  });
  return { proxy, gate, journal, sink, socketPath, runCaPem: ca.certPem, turn: opened.turn, authority: `sink.test:${sink.port}`, clock };
}

/** Sends a raw CONNECT, then (if it is answered 200) raw bytes inside TLS; returns what came back. */
async function exchange(r: Rig, inner: string | undefined, o: { credential?: string | null; authority?: string; servername?: string; verify?: boolean } = {}): Promise<{ connect: string; response: string }> {
  const raw = netConnect(r.socketPath);
  const credential = o.credential === undefined ? CREDENTIAL : o.credential;
  raw.write(`CONNECT ${o.authority ?? r.authority} HTTP/1.1\r\nHost: ${o.authority ?? r.authority}\r\n${credential === null ? "" : `Proxy-Authorization: ${credential}\r\n`}\r\n`);
  const connect = await new Promise<string>((resolve) => {
    let got = "";
    const onData = (c: Buffer) => {
      got += c.toString("latin1");
      if (got.includes("\r\n\r\n")) {
        raw.off("data", onData);
        resolve(got);
      }
    };
    raw.on("data", onData);
    raw.on("close", () => resolve(got));
  });
  if (!connect.startsWith("HTTP/1.1 200") || inner === undefined) {
    raw.destroy();
    return { connect, response: "" };
  }
  const tls = tlsConnect({ socket: raw, servername: o.servername ?? "sink.test", ca: [r.runCaPem], rejectUnauthorized: o.verify ?? true, ALPNProtocols: ["http/1.1"] });
  return new Promise((resolve, reject) => {
    let response = "";
    tls.on("secureConnect", () => tls.write(inner));
    tls.on("data", (c: Buffer) => (response += c.toString("latin1")));
    tls.on("error", (e) => (response ? resolve({ connect, response }) : reject(e)));
    tls.on("close", () => resolve({ connect, response }));
  });
}

const get = (r: Rig, target = "/", extra = "") => `GET ${target} HTTP/1.1\r\nHost: ${r.authority}\r\nAccept: */*\r\n${extra}\r\n`;
const statusOf = (s: string) => Number(/^HTTP\/1\.1 (\d{3})/.exec(s)?.[1]);
const deniedOf = (s: string) => new RegExp(`${DENIED_HEADER}: ([a-z_]+)`).exec(s)?.[1];

test("a GET is rebuilt, admitted, sent once and answered; the journal and gate agree", async (t) => {
  const r = await rig(t);
  const { response } = await exchange(r, get(r, "/robots?x=1", "X-Secret: s\r\nCookie: a=1\r\n"));
  assert.equal(statusOf(response), 200);
  assert.match(response, /\r\n\r\n2\r\nok\r\n0\r\n\r\n$/, "the body, re-framed for the journey");
  assert.match(response, /set-cookie: s=1/i, "cookies come back to the journey");
  assert.equal(r.sink.arrivals.length, 1);
  const a = r.sink.arrivals[0]!;
  assert.equal(a.url, "/robots?x=1");
  assert.equal(a.headers.host, r.authority);
  assert.equal(a.headers.connection, "close");
  assert.equal(a.headers.cookie, "a=1");
  assert.equal(a.headers["x-secret"], undefined, "a header the policy does not name is dropped");
  assert.equal(r.gate.admitted, 1);
  assert.equal(r.gate.inFlight, 0, "the exchange finished");
  assert.deepEqual(r.journal.snapshot(), { debited: 1, accepted: 1, received: 1, unresolved: 0, denied: {} });
});

test("a planned POST carries its body; an unplanned one never reaches the target", async (t) => {
  const r = await rig(t);
  const post = (p: string) => `POST ${p} HTTP/1.1\r\nHost: ${r.authority}\r\nContent-Type: application/json\r\nContent-Length: 7\r\n\r\n{"a":1}`;
  assert.equal(statusOf((await exchange(r, post("/cart"))).response), 200);
  assert.equal(r.sink.arrivals[0]!.body, '{"a":1}');
  assert.equal(r.sink.arrivals[0]!.headers["content-length"], "7");
  const refused = (await exchange(r, post("/admin"))).response;
  assert.equal(statusOf(refused), 403);
  assert.equal(deniedOf(refused), "not_allowed");
  assert.equal(r.sink.arrivals.length, 1);
  assert.equal(r.gate.admitted, 1);
  assert.deepEqual(r.journal.snapshot().denied, { not_allowed: 1 });
});

test("CONNECT needs the turn's one credential and an approved origin", async (t) => {
  const r = await rig(t);
  assert.match((await exchange(r, undefined, { credential: null })).connect, /^HTTP\/1\.1 407/);
  assert.match((await exchange(r, undefined, { credential: "Basic d3Jvbmc=" })).connect, /^HTTP\/1\.1 407/);
  assert.match((await exchange(r, undefined, { authority: "other.test:443" })).connect, /^HTTP\/1\.1 403/);
  assert.match((await exchange(r, undefined, { authority: "SINK.test:" + r.sink.port })).connect, /^HTTP\/1\.1 403/);
  assert.match((await exchange(r, undefined, { authority: "127.0.0.1:" + r.sink.port })).connect, /^HTTP\/1\.1 403/);
  assert.equal(r.sink.arrivals.length, 0);
});

test("inside the tunnel: wrong SNI, Transfer-Encoding, Expect, Upgrade and absolute-form are refused, and none reaches the target", async (t) => {
  const r = await rig(t);
  const cases: [string, string, { servername?: string; verify?: boolean }, number][] = [
    ["SNI for another host", get(r), { servername: "other.test", verify: false }, 421],
    ["Transfer-Encoding", `POST /cart HTTP/1.1\r\nHost: ${r.authority}\r\nTransfer-Encoding: chunked\r\n\r\n0\r\n\r\n`, {}, 400],
    ["Expect", `POST /cart HTTP/1.1\r\nHost: ${r.authority}\r\nContent-Length: 2\r\nExpect: 100-continue\r\n\r\n`, {}, 417],
    ["Upgrade", `GET / HTTP/1.1\r\nHost: ${r.authority}\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n`, {}, 400],
    ["absolute-form", `GET https://${r.authority}/ HTTP/1.1\r\nHost: ${r.authority}\r\n\r\n`, {}, 400],
    ["a body over 1 MiB, by its Content-Length", `POST /cart HTTP/1.1\r\nHost: ${r.authority}\r\nContent-Length: 2000000\r\n\r\n`, {}, 413],
    ["an ambiguous path", get(r, "/a/../cart"), {}, 400],
  ];
  for (const [label, inner, o, status] of cases) assert.equal(statusOf((await exchange(r, inner, o)).response), status, label);
  assert.equal(r.sink.arrivals.length, 0);
  assert.equal(r.gate.admitted, 0);
});

test("one request per tunnel: a pipelined second request never reaches the target", async (t) => {
  const r = await rig(t);
  const { response } = await exchange(r, get(r, "/one") + get(r, "/two"));
  assert.equal(statusOf(response), 200);
  assert.deepEqual(r.sink.arrivals.map((a) => a.url), ["/one"]);
  assert.equal(r.gate.admitted, 1);
});

test("a dial that completes after the lease ran out sends zero bytes", async (t) => {
  let release!: () => void;
  const held = new Promise<void>((resolve) => (release = resolve));
  let dialled!: () => void;
  const started = new Promise<void>((resolve) => (dialled = resolve));
  const r = await rig(t, {
    dial: (inner) => async (o, signal) => {
      const s = await inner(o, signal);
      dialled();
      await held;
      return s;
    },
  });
  const pending = exchange(r, get(r));
  await started;
  r.clock.monoMs = 10_000; // the lease's monotonic deadline
  release();
  const { response } = await pending;
  assert.equal(statusOf(response), 503);
  assert.equal(deniedOf(response), "lease");
  assert.equal(r.sink.arrivals.length, 0);
  assert.equal(r.gate.admitted, 0);
  assert.deepEqual(r.journal.snapshot(), { debited: 0, accepted: 0, received: 0, unresolved: 0, denied: { lease: 1 } });
});

test("pending dials are bounded per turn, and closing the turn abandons them", async (t) => {
  let dialled!: () => void;
  const started = new Promise<void>((resolve) => (dialled = resolve));
  const r = await rig(t, {
    maxPendingDialsPerTurn: 1,
    dial: () => (_o, signal) =>
      new Promise((_resolve, reject) => {
        dialled();
        signal.addEventListener("abort", () => reject(new Error("aborted")));
      }),
  });
  const first = exchange(r, get(r, "/first"));
  await started;
  const second = await exchange(r, get(r, "/second"));
  assert.equal(deniedOf(second.response), "dials");
  r.proxy.closeTurn(r.turn);
  await first;
  assert.equal(r.sink.arrivals.length, 0);
  assert.equal(r.gate.admitted, 0);
  assert.match((await exchange(r, get(r, "/after"))).connect, /^HTTP\/1\.1 403/, "a closed turn opens no tunnel");
  assert.equal(r.sink.arrivals.length, 0);
});

test("close() resets upstream sockets that are still waiting", async (t) => {
  let arrived!: () => void;
  const reached = new Promise<void>((resolve) => (arrived = resolve));
  const r = await rig(t, { respond: () => arrived() });
  const pending = exchange(r, get(r));
  await reached;
  assert.equal(r.gate.inFlight, 1);
  await r.proxy.close();
  await pending;
  assert.equal(r.journal.snapshot().unresolved + r.journal.snapshot().accepted, 1, "it stays debited");
  assert.equal(r.gate.inFlight, 0, "the exchange is over once its socket closed");
});

test("architecture: nothing is awaited between admit( and .write(", () => {
  const source = readFileSync(path.join(__dirname, "..", "src", "load", "gate", "proxy.ts"), "utf8").replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, "");
  const start = source.indexOf("private send(");
  assert.ok(start > 0, "send() exists");
  const end = source.indexOf("\n  private ", start + 1);
  const body = source.slice(start, end);
  const admit = body.indexOf(".admit(");
  const write = body.indexOf(".write(");
  assert.ok(admit > 0 && write > admit, "admit comes before write in send()");
  assert.doesNotMatch(body, /\bawait\b|\.then\(|\basync\b/, "send() is synchronous");
  assert.equal((source.match(/\.admit\(/g) ?? []).length, 1, "admit is called in one place");
  assert.equal((source.match(/\.write\(Buffer\.concat/g) ?? []).length, 1, "the request is written in one place");
});

// ---------------------------------------------------------------- the upstream response reader


function read(method: string, ...chunks: string[]) {
  const out = { status: 0, body: "", ended: false, error: "" };
  const r = new ResponseReader(method, {
    head: (h) => (out.status = h.status),
    data: (c) => (out.body += c.toString()),
    end: () => (out.ended = true),
    error: (e) => (out.error = e.message),
  });
  for (const c of chunks) r.push(Buffer.from(c, "latin1"));
  return { out, r };
}

test("the response reader knows when an exchange is over, however the body is framed", () => {
  assert.deepEqual(read("GET", "HTTP/1.1 200 OK\r\nContent-Length: 5\r\n\r\nhel", "lo").out, { status: 200, body: "hello", ended: true, error: "" });
  assert.deepEqual(read("GET", "HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n3;x=y\r\nhel\r\n2\r\nlo\r\n0\r\nX-T: 1\r\n\r\n").out, { status: 200, body: "hello", ended: true, error: "" });
  assert.deepEqual(read("GET", "HTTP/1.1 103 Early Hints\r\nLink: </a>\r\n\r\nHTTP/1.1 204 No Content\r\n\r\n").out, { status: 204, body: "", ended: true, error: "" });
  assert.deepEqual(read("HEAD", "HTTP/1.1 200 OK\r\nContent-Length: 99\r\n\r\n").out, { status: 200, body: "", ended: true, error: "" });
  const close = read("GET", "HTTP/1.1 200 OK\r\n\r\nall of it");
  assert.equal(close.out.ended, false);
  close.r.end();
  assert.deepEqual(close.out, { status: 200, body: "all of it", ended: true, error: "" });
  const cut = read("GET", "HTTP/1.1 200 OK\r\nContent-Length: 10\r\n\r\nshort");
  cut.r.end();
  assert.match(cut.out.error, /closed before/);
  assert.match(read("GET", "HTTP/1.1 101 Switching Protocols\r\n\r\n").out.error, /switched/);
  assert.match(read("GET", "HTTP/1.1 200 OK\r\nContent-Length: 1\r\nContent-Length: 2\r\n\r\n").out.error, /content-length/);
  assert.match(read("GET", "HTTP/1.1 200 OK\r\nTransfer-Encoding: gzip, chunked\r\n\r\n").out.error, /transfer-coding/);
  assert.match(read("GET", "garbage\r\n\r\n").out.error, /status line/);
  assert.match(read("GET", "HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\nzz\r\n").out.error, /chunk size/);
});
