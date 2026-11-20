/**
 * The gate's proxy, request rebuilding and dialling (plan v3 §5, §10 `load-proxy`).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { connect as netConnect, createServer as createNetServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { connect as tlsConnect, createServer as createTlsServer } from "node:tls";
import type { AddressInfo } from "node:net";
import { Gate, type Clocks } from "../src/load/gate/admission";
import { buildCa, createRunCa, issueLeaf } from "../src/load/gate/ca";
import { Journal } from "../src/load/gate/journal";
import { receivedOutsideGate } from "../src/load/gate/reconcile";
import { canonicalOrigin, normalize, parseAuthority, validatePolicy, type ArrivedRequest, type RequestPolicy } from "../src/load/gate/normalize";
import { CUT_HEADER, DENIED_HEADER, GateProxy, makeDial, RETRY_HEADER, type Dial, type ProxyLimits } from "../src/load/gate/proxy";
import { ResponseReader } from "../src/load/gate/response";
import { bundledRoots, canonical, checkedAddresses, classify, connectVerified, DialRefused, reachable, unmap, type ApprovedOrigin, type Upstream } from "../src/load/gate/resolve";
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
    ["a method override in the query", { method: "POST", target: "/cart?_method=DELETE", rawHeaders: ["Host", "shop.test", "Content-Length", "0"] }, "not_allowed"],
    ["a method override in a form body", { method: "POST", target: "/cart", rawHeaders: ["Host", "shop.test", "Content-Type", "application/x-www-form-urlencoded", "Content-Length", "14"], body: Buffer.from("_method=DELETE") }, "not_allowed"],
    ["an encoded method override in a form body", { method: "POST", target: "/cart", rawHeaders: ["Host", "shop.test", "Content-Type", "application/x-www-form-urlencoded", "Content-Length", "16"], body: Buffer.from("%5Fmethod=DELETE") }, "not_allowed"],
    ["a method override in a JSON body", { method: "POST", target: "/cart", rawHeaders: ["Host", "shop.test", "Content-Type", "application/json", "Content-Length", "20"], body: Buffer.from("{\"_method\":\"DELETE\"}") }, "not_allowed"],
    ["an escaped method override in a JSON body", { method: "POST", target: "/cart", rawHeaders: ["Host", "shop.test", "Content-Type", "application/json", "Content-Length", "25"], body: Buffer.from("{\"\\u005fmethod\":\"DELETE\"}") }, "not_allowed"],
    ["a method override in a multipart body", { method: "POST", target: "/cart", rawHeaders: ["Host", "shop.test", "Content-Type", "multipart/form-data; boundary=b", "Content-Length", "70"], body: Buffer.from("--b\r\nContent-Disposition: form-data; name=\"_method\"\r\n\r\nDELETE\r\n--b--\r\n") }, "not_allowed"],
    ["a method override under a lying Content-Type", { method: "POST", target: "/cart", rawHeaders: ["Host", "shop.test", "Content-Type", "text/plain", "Content-Length", "14"], body: Buffer.from("_method=DELETE") }, "not_allowed"],
    ...(
      [
        ["a percent-encoded letter of the override's name", "application/x-www-form-urlencoded", "_%6Dethod=DELETE"],
        ["the override's name percent-encoded throughout", "application/x-www-form-urlencoded", "%5F%6D%65%74%68%6F%64=DELETE"],
        ["a JSON escape of a letter of the override's name", "application/json", '{"_\\u006dethod":"DELETE"}'],
        ["a backslash escape in a multipart name", "multipart/form-data; boundary=b", '--b\r\nContent-Disposition: form-data; name="_\\method"\r\n\r\nDELETE\r\n--b--\r\n'],
        ["PHP's spelling of the override in a form body", "application/x-www-form-urlencoded", "a=1&.method=DELETE"],
        ["PHP's spelling, percent-encoded", "application/x-www-form-urlencoded", "%2Emethod=DELETE"],
      ] as const
    ).map(([label, type, body]): [string, Partial<ArrivedRequest>, string] => [label, { method: "POST", target: "/cart", rawHeaders: ["Host", "shop.test", "Content-Type", type, "Content-Length", String(body.length)], body: Buffer.from(body) }, "not_allowed"]),
    ...["/cart?.method=DELETE", "/cart?%2Emethod=DELETE", "/cart?+.method=DELETE", "/cart?_method[]=DELETE"].map((target): [string, Partial<ArrivedRequest>, string] => [`a method override in the query as PHP reads it: ${target}`, { method: "POST", target, rawHeaders: ["Host", "shop.test", "Content-Length", "0"] }, "not_allowed"]),
    ["a target over 2 KiB", { target: "/" + "a".repeat(2048) }, "too_long"],
    ["more than 100 headers", { rawHeaders: ["Host", "shop.test", ...Array.from({ length: 100 }, (_, i) => [`X-${i}`, "v"]).flat()] }, "header"],
  ];
  for (const [label, over, reason] of cases) assert.equal(why(norm(over)), reason, label);
  const plain = '{"method":"x"}';
  assert.equal(why(norm({ method: "POST", target: "/cart", rawHeaders: ["Host", "shop.test", "Content-Type", "application/json", "Content-Length", String(plain.length)], body: Buffer.from(plain) })), "ok", "a body without the override passes");
  for (const p of ["/cart;jsessionid=1", "//cart", "/a//b", "/a/./b", "/a/../cart", "/..", "/%2e%2e/cart", "/a%2Fb", "/a%5cb", "/a\\b", "/a%00", "/a%zz", "/a b", "/a#f"]) {
    assert.equal(why(norm({ target: p })), "path", p);
  }
  for (const ok of ['{"shipping.method":"post","note":"50%25 off"}', "shipping.method=post&x=%zz"]) {
    assert.equal(why(norm({ method: "POST", target: "/cart?shipping.method=post", rawHeaders: ["Host", "shop.test", "Content-Length", String(ok.length)], body: Buffer.from(ok) })), "ok", ok);
  }
  assert.equal(why(norm({ target: "/a/b/?q=1&r=/x" })), "ok", "a query may hold slashes");
  assert.equal(why(norm({ method: "POST", target: "/cart?x=1", rawHeaders: ["Host", "shop.test", "Content-Length", "0"] })), "ok", "policy checks the path without its query");
  assert.equal(why(norm({}, null)), "sni", "no SNI");
  assert.equal(why(norm({}, "other.test")), "sni", "SNI for another host");
  assert.equal(why(normalize(arrived(), { authority: parseAuthority("other.test:443")!, servername: "other.test" }, POLICY)), "origin");
  const named = norm({ rawHeaders: ["Host", "shop.test", "X-HTTP-Method-Override", "DELETE"] }, "shop.test", { ...POLICY, headers: ["X-HTTP-Method-Override"] });
  assert.ok(named.ok && !named.head.includes("override"), "an override header never passes, even if named");
});

test("a policy may not name framing, gate or override headers, nor allow an ambiguous path", () => {
  for (const h of ["content_length", "Transfer-Encoding", "host", "X-HTTP-Method-Override", "x-original-url", "forwarded", "x-forwarded-for", "bad header"]) {
    assert.throws(() => validatePolicy({ ...POLICY, headers: [h] }), /may not name/, h);
  }
  assert.throws(() => validatePolicy({ ...POLICY, allowedRequests: [{ method: "POST", path: "/a;b" }] }), /ambiguous/);
  validatePolicy({ ...POLICY, headers: ["X-Api-Key"] });
});

// ---------------------------------------------------------------- resolve

test("the address table", () => {
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
    ["100.100.1.1", "metadata"],
    ["fd00:ec2::254", "metadata"],
    ["fd00:ec2::253", "metadata"],
    ["fd00:ec2::23", "metadata"],
    ["::ffff:169.254.169.254", "metadata"],
    ["64:ff9b::a9fe:a9fe", "reserved"],
    ["64:ff9b:1::a9fe:a9fe", "reserved"],
    ["2002:a9fe:a9fe::", "reserved"],
    ["2002:0a00:0001::", "reserved"],
    ["::1.2.3.4", "reserved"],
    ["::ffff:0:a9fe:a9fe", "reserved"],
    ["2001::1", "reserved"],
    ["2001:2::1", "reserved"],
    ["2001:20::1", "reserved"],
    ["2001:db8::1", "reserved"],
    ["3fff::1", "reserved"],
    ["224.0.0.1", "multicast"],
    ["ff02::1", "multicast"],
    ["240.0.0.1", "reserved"],
    ["255.255.255.255", "reserved"],
    ["192.0.0.192", "reserved"],
    ["192.88.99.1", "reserved"],
    ["fe80::1%eth0", "invalid"],
    ["not-an-ip", "invalid"],
  ];
  for (const [address, expected] of table) assert.equal(classify(address), expected, address);
  assert.equal(unmap("::ffff:93.184.216.34"), "93.184.216.34");
  assert.equal(unmap("::ffff:5db8:d822"), "93.184.216.34");
  assert.equal(unmap("2606:4700::1111"), "2606:4700::1111");
});

const ORIGIN: ApprovedOrigin = { host: "shop.test", port: 443, privateCidrs: [] };
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

test("private addresses are reachable only inside the Owner's ranges, and never the runner's own", () => {
  const own = new Set(["10.1.0.5"]);
  const lan = { privateCidrs: ["10.20.0.0/16", "fd12::/16"] };
  assert.equal(reachable("93.184.216.34", ORIGIN, own), true);
  assert.equal(reachable("10.20.3.4", ORIGIN, own), false, "no ranges, no private");
  assert.equal(reachable("10.20.3.4", lan, own), true);
  assert.equal(reachable("::ffff:10.20.3.4", lan, own), true, "mapped is checked as IPv4");
  assert.equal(reachable("10.21.0.1", lan, own), false, "outside the range");
  assert.equal(reachable("fd12::9", lan, own), true);
  assert.equal(reachable("10.1.0.5", { privateCidrs: ["10.0.0.0/8"] }, own), false, "the runner itself");
  assert.equal(reachable("169.254.169.254", { privateCidrs: ["0.0.0.0/0"] }, own), false, "metadata, never");
  // The runner's own IPv6 address, however it is spelled.
  const own6 = new Set([canonical("2606:4700:0:0:0:0:0:1111")]);
  for (const spelling of ["2606:4700::1111", "2606:4700:0000::1111", "2606:4700:0:0::1111", "2606:4700::0:1111"]) {
    assert.equal(reachable(spelling, ORIGIN, own6), false, spelling);
  }
  assert.equal(canonical("::FFFF:10.1.0.5"), "10.1.0.5");
});

test("a name is resolved as an absolute name and refused if any address it gives is out of reach", async () => {
  const asked: string[] = [];
  assert.deepEqual(await checkedAddresses(ORIGIN, { lookup: async (name) => (asked.push(name), [{ address: "93.184.216.34", family: 4 }]) }), ["93.184.216.34"]);
  assert.deepEqual(asked, ["shop.test."], "no resolver search list");
  assert.deepEqual(await checkedAddresses(ORIGIN, { lookup: lookupOf("::ffff:93.184.216.34", "93.184.216.34", "2606:4700::1111") }), ["93.184.216.34"], "IPv4 only: every answer is checked, only IPv4 is dialled");
  assert.equal(await refusal(checkedAddresses(ORIGIN, { lookup: lookupOf("2606:4700::1111") })), "address", "a name with only IPv6 answers is refused for now");
  assert.equal(await refusal(checkedAddresses(ORIGIN, { lookup: lookupOf("93.184.216.34", "fd00:ec2::254") })), "address", "a bad IPv6 answer still refuses the name");
  assert.equal(await refusal(checkedAddresses(ORIGIN, { lookup: lookupOf("93.184.216.34", "169.254.169.254") })), "address", "one bad address refuses the name");
  assert.equal(await refusal(checkedAddresses(ORIGIN, { lookup: lookupOf("10.0.0.5") })), "address");
  assert.deepEqual(await checkedAddresses({ ...ORIGIN, privateCidrs: ["10.0.0.0/24"] }, { lookup: lookupOf("10.0.0.5") }), ["10.0.0.5"]);
  assert.equal(await refusal(checkedAddresses(ORIGIN, { lookup: lookupOf() })), "resolve");
  assert.equal(await refusal(checkedAddresses(ORIGIN, { lookup: async () => Promise.reject(new Error("NXDOMAIN")) })), "resolve");
  assert.equal(await refusal(checkedAddresses({ ...ORIGIN, host: "93.184.216.34" }, { lookup: lookupOf("93.184.216.34") })), "resolve", "an address literal");
  const stuck = new AbortController();
  const pending = checkedAddresses(ORIGIN, { lookup: () => new Promise(() => undefined), signal: stuck.signal });
  stuck.abort();
  assert.equal(await refusal(pending), "aborted", "an abort frees the caller from a stuck lookup");
});

/** A TLS server for one-off certificates. */
async function tlsFixture(t: import("node:test").TestContext, cert: string, key: string, alpn?: string[]) {
  const server = createTlsServer({ cert, key, ...(alpn ? { ALPNProtocols: alpn } : {}) }, (s) => s.end());
  server.on("tlsClientError", () => undefined);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  return (server.address() as AddressInfo).port;
}

test("the dial verifies the approved name in a SAN, and ignores the job's TLS settings", async (t) => {
  const sink = await startSink();
  const other = await startSink({ host: "other.test" });
  t.after(() => Promise.all([sink.close(), other.close()]));
  const at = (port: number, host = "sink.test"): ApprovedOrigin => ({ host, port, privateCidrs: [] });

  const ok = await connectVerified("127.0.0.1", at(sink.port), { ca: [sink.caPem] });
  assert.equal(ok.socket.alpnProtocol, "http/1.1");
  assert.equal(ok.address, "127.0.0.1");
  ok.reset();
  assert.equal(await refusal(connectVerified("127.0.0.1", at(other.port), { ca: [other.caPem] })), "tls", "a certificate for another name");

  // A leaf with no ALPN on the server: HTTP/1.1 all the same, so accepted.
  const plainCa = createRunCa({ hosts: ["sink.test"], nowMs: Date.now(), validForMs: 3_600_000 });
  const plainLeaf = plainCa.leaf("sink.test")!;
  const plain = await tlsFixture(t, plainLeaf.certPem, plainLeaf.key.export({ type: "pkcs8", format: "pem" }) as string);
  const noAlpn = await connectVerified("127.0.0.1", at(plain), { ca: [plainCa.certPem] });
  assert.equal(noAlpn.socket.alpnProtocol, false);
  noAlpn.reset();

  const saved = process.env.NODE_TLS_REJECT_UNAUTHORIZED;
  process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";
  try {
    assert.equal(await refusal(connectVerified("127.0.0.1", at(sink.port))), "tls", "NODE_TLS_REJECT_UNAUTHORIZED=0 is ignored; the fixture CA is not a bundled root");
  } finally {
    if (saved === undefined) delete process.env.NODE_TLS_REJECT_UNAUTHORIZED;
    else process.env.NODE_TLS_REJECT_UNAUTHORIZED = saved;
  }
  assert.equal(bundledRoots(), bundledRoots(), "the bundled roots are built once");
});

test("a certificate naming the host only in its Common Name is refused; the same CA's SAN leaf connects", async (t) => {
  const dir = mkdtempSync(path.join(tmpdir(), "load-cn-"));
  const ca = buildCa(["sink.test"], Date.now() - 60_000, Date.now() + 3_600_000);
  const caKey = path.join(dir, "ca.key");
  const caCert = path.join(dir, "ca.pem");
  writeFileSync(caKey, ca.key.export({ type: "pkcs8", format: "pem" }));
  writeFileSync(caCert, ca.certPem);
  const openssl = (args: string[]) => execFileSync("openssl", args, { stdio: "pipe" });
  try {
    openssl(["version"]);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return t.skip("openssl is not installed");
    throw e;
  }
  // Any failure past this point fails the test: the fixture must really be built.
  const leafFor = (name: string, san: boolean) => {
    const key = path.join(dir, `${name}.key`);
    const csr = path.join(dir, `${name}.csr`);
    const pem = path.join(dir, `${name}.pem`);
    openssl(["req", "-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:P-256", "-nodes", "-sha256", "-keyout", key, "-subj", "/CN=sink.test", "-out", csr]);
    const args = ["x509", "-req", "-sha256", "-in", csr, "-CA", caCert, "-CAkey", caKey, "-CAcreateserial", "-days", "1", "-out", pem];
    if (san) {
      const ext = path.join(dir, `${name}.ext`);
      writeFileSync(ext, "subjectAltName=DNS:sink.test\n");
      args.push("-extfile", ext);
    }
    openssl(args);
    return { cert: readFileSync(pem, "utf8"), key: readFileSync(key, "utf8") };
  };
  const control = leafFor("san", true);
  const controlPort = await tlsFixture(t, control.cert, control.key, ["http/1.1"]);
  assert.equal(await refusal(connectVerified("127.0.0.1", { host: "sink.test", port: controlPort, privateCidrs: [] }, { ca: [ca.certPem] }).then((u) => u.reset())), "ok", "control: the same CA and toolchain, with a SAN");

  const cn = leafFor("cn", false);
  const port = await tlsFixture(t, cn.cert, cn.key, ["http/1.1"]);
  try {
    await connectVerified("127.0.0.1", { host: "sink.test", port, privateCidrs: [] }, { ca: [ca.certPem] });
    assert.fail("a CN-only certificate connected");
  } catch (e) {
    assert.ok(e instanceof DialRefused && e.reason === "tls", String(e));
    assert.match(e.message, /certificate is not for sink\.test/, "refused by the name check, not by chain validation");
  }
});

test("the CA's name constraints hold in a real handshake; descendants are allowed, so no key outlives setup", async (t) => {
  const ca = buildCa(["sink.test"], Date.now() - 60_000, Date.now() + 3_600_000);
  const issue = (host: string) => issueLeaf({ host, issuer: ca.name, issuerKeyId: ca.keyId, signer: ca.key, notBefore: Date.now() - 60_000, notAfter: Date.now() + 3_600_000 });
  for (const [host, expected] of [["evil.test", "tls"], ["sink.test.evil.test", "tls"], ["a.sink.test", "ok"]] as const) {
    const leaf = issue(host);
    const port = await tlsFixture(t, leaf.certPem, leaf.key.export({ type: "pkcs8", format: "pem" }) as string, ["http/1.1"]);
    const got = await refusal(connectVerified("127.0.0.1", { host, port, privateCidrs: [] }, { ca: [ca.certPem] }).then((u) => u.reset()));
    assert.equal(got, expected, host);
  }
});

test("aborting a dial that is still connecting sends nothing", async (t) => {
  let bytes = 0;
  let connections = 0;
  const server = createNetServer((s) => {
    connections += 1;
    s.on("data", (d) => (bytes += d.length));
    s.on("error", () => undefined);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const port = (server.address() as AddressInfo).port;
  const controller = new AbortController();
  const pending = connectVerified("127.0.0.1", { host: "sink.test", port, privateCidrs: [] }, { signal: controller.signal });
  controller.abort();
  assert.equal(await refusal(pending), "aborted");
  await new Promise((r) => setTimeout(r, 300));
  assert.equal(bytes, 0, "no ClientHello");
  assert.equal(connections <= 1, true);
});

// ---------------------------------------------------------------- the proxy, end to end

const CREDENTIAL = `Basic ${Buffer.from("turn:secret").toString("base64")}`;
const CREDENTIAL_2 = `Basic ${Buffer.from("turn2:secret").toString("base64")}`;

interface Rig {
  proxy: GateProxy;
  gate: Gate;
  journal: Journal;
  sink: Sink;
  socketPath: string;
  runCaPem: string;
  turn: number;
  turn2: number;
  authority: string;
  clock: Clocks;
  dials: { count: number; pinned: (string | undefined)[]; signals: AbortSignal[]; resets: number };
  /** Times the proxy called `onLeaseExpired`. */
  expiries: { count: number };
}

interface RigOptions {
  dial?: (inner: Dial) => Dial;
  limits?: Partial<ProxyLimits>;
  respond?: SinkOptions["respond"];
  phase?: { ratePerSecond: number; burst: number };
  seqHeader?: string;
  /** Replaces the rig's clock: called at every check the proxy makes. */
  clocks?: (clock: Clocks) => Clocks;
  onLeaseExpired?: (r: { proxy: GateProxy }) => void;
  gate?: Partial<import("../src/load/gate/admission").GateLimits>;
}

async function rig(t: import("node:test").TestContext, opts: RigOptions = {}): Promise<Rig> {
  const sink = await startSink({ respond: opts.respond });
  const origin = canonicalOrigin("sink.test", sink.port);
  const clock: Clocks = { monoMs: 0, wallMs: 1_700_000_000_000 };
  const gate = new Gate({
    origins: { [origin]: 1000 },
    methods: ["GET", "POST"],
    maxOutstandingPerTurn: 100,
    runTotal: 1000,
    turnDeadlineMs: 60_000,
    runEndMono: 1_000_000,
    phase: { ratePerSecond: opts.phase?.ratePerSecond ?? 100, burst: opts.phase?.burst ?? 50, maxUsers: 4, total: 1000 },
    ...opts.gate,
  });
  gate.applyLease({ seq: 1, monoUntil: 10_000, wallUntil: clock.wallMs + 10_000, ceiling: 1000 });
  const opened = gate.openTurn("s1", clock);
  const opened2 = gate.openTurn("s2", clock);
  assert.ok(opened.ok && opened2.ok);
  const journal = new Journal();
  const ca = createRunCa({ hosts: ["sink.test"], nowMs: Date.now(), validForMs: 60 * 60 * 1000 });
  const dials: Rig["dials"] = { count: 0, pinned: [], signals: [], resets: 0 };
  const expiries = { count: 0 };
  const real: Dial = (o, signal, _pin, ready) => connectVerified("127.0.0.1", o, { ca: [sink.caPem], signal, ready });
  const record = (inner: Dial): Dial => (o, signal, pinned, ready) => {
    dials.count += 1;
    dials.pinned.push(pinned);
    dials.signals.push(signal);
    return inner(o, signal, pinned, ready).then((u) => ({
      ...u,
      reset: () => {
        dials.resets += 1;
        u.reset();
      },
    }));
  };
  const proxy = new GateProxy({
    gate,
    journal,
    ca,
    policy: { allowedOrigins: [origin], allowedRequests: [{ method: "POST", path: "/cart" }] },
    origins: new Map([[origin, { host: "sink.test", port: sink.port, privateCidrs: [] }]]),
    authorize: (c) => (c === CREDENTIAL ? opened.turn : c === CREDENTIAL_2 ? opened2.turn : undefined),
    limits: opts.limits,
    clocks: () => (opts.clocks ? opts.clocks(clock) : { ...clock }),
    onLeaseExpired: () => {
      expiries.count += 1;
      opts.onLeaseExpired?.({ proxy });
    },
    dial: record(opts.dial ? opts.dial(real) : real),
    seqHeader: opts.seqHeader,
  });
  const socketPath = path.join(mkdtempSync(path.join(tmpdir(), "load-proxy-")), "proxy.sock");
  await proxy.listen(socketPath);
  t.after(async () => {
    await proxy.close();
    await sink.close();
  });
  return { proxy, gate, journal, sink, socketPath, runCaPem: ca.certPem, turn: opened.turn, turn2: opened2.turn, authority: `sink.test:${sink.port}`, clock, dials, expiries };
}

interface ExchangeOptions {
  credential?: string | null;
  authority?: string;
  servername?: string;
  verify?: boolean;
  /** Stop reading after this many response bytes. */
  readLimit?: number;
}

/** Sends a raw CONNECT, then (if it is answered 200) raw bytes inside TLS; returns what came back. */
async function exchange(r: Rig, inner: string | Buffer | undefined, o: ExchangeOptions = {}): Promise<{ connect: string; response: string }> {
  const raw = netConnect(r.socketPath);
  raw.on("error", () => undefined);
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
    tls.on("data", (c: Buffer) => {
      response += c.toString("latin1");
      if (o.readLimit !== undefined && response.length >= o.readLimit) {
        tls.pause();
        resolve({ connect, response });
      }
    });
    tls.on("error", (e) => (response ? resolve({ connect, response }) : reject(e)));
    tls.on("close", () => resolve({ connect, response }));
  });
}

const get = (r: Rig, target = "/", extra = "") => `GET ${target} HTTP/1.1\r\nHost: ${r.authority}\r\nAccept: */*\r\n${extra}\r\n`;
const statusOf = (s: string) => Number(/^HTTP\/1\.1 (\d{3})/.exec(s)?.[1]);
const deniedOf = (s: string) => new RegExp(`${DENIED_HEADER}: ([a-z_]+)`).exec(s)?.[1];
const cutOf = (s: string) => new RegExp(`${CUT_HEADER}: ([a-z_]+)`).exec(s)?.[1];
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

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
  assert.deepEqual(r.journal.snapshot(), { debited: 1, attempted: 1, accepted: 1, responded: 1, received: 0, unresolved: 0, denied: {}, cut: {} });
  assert.equal(r.journal.openCount, 0);
  assert.equal(r.proxy.pinned.get(canonicalOrigin("sink.test", r.sink.port)), "127.0.0.1", "the origin's address is pinned");
  await exchange(r, get(r));
  assert.deepEqual(r.dials.pinned, [undefined, "127.0.0.1"], "later dials go to the pinned address");
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
  assert.equal(r.dials.count, 1, "no dial for a refused request");
  assert.deepEqual(r.journal.snapshot().denied, { not_allowed: 1 });
});

test("CONNECT needs the turn's one credential and an approved origin; every refusal is counted", async (t) => {
  const r = await rig(t);
  assert.match((await exchange(r, undefined, { credential: null })).connect, /^HTTP\/1\.1 407/);
  assert.match((await exchange(r, undefined, { credential: "Basic d3Jvbmc=" })).connect, /^HTTP\/1\.1 407/);
  assert.match((await exchange(r, undefined, { authority: "other.test:443" })).connect, /^HTTP\/1\.1 403/);
  assert.match((await exchange(r, undefined, { authority: "SINK.test:" + r.sink.port })).connect, /^HTTP\/1\.1 403/);
  assert.match((await exchange(r, undefined, { authority: "127.0.0.1:" + r.sink.port })).connect, /^HTTP\/1\.1 403/);
  assert.equal(r.sink.arrivals.length, 0);
  assert.deepEqual(r.journal.snapshot().denied, { credential: 2, origin: 3 });
});

test("inside the tunnel: wrong SNI, Transfer-Encoding, Expect, Upgrade, absolute-form and the rest are refused, and none reaches the target", async (t) => {
  const r = await rig(t);
  const cases: [string, string, Omit<ExchangeOptions, "readLimit">, number][] = [
    ["SNI for another host", get(r), { servername: "other.test", verify: false }, 421],
    ["Transfer-Encoding", `POST /cart HTTP/1.1\r\nHost: ${r.authority}\r\nTransfer-Encoding: chunked\r\n\r\n0\r\n\r\n`, {}, 400],
    ["Expect", `POST /cart HTTP/1.1\r\nHost: ${r.authority}\r\nContent-Length: 2\r\nExpect: 100-continue\r\n\r\n`, {}, 417],
    ["Upgrade", `GET / HTTP/1.1\r\nHost: ${r.authority}\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n`, {}, 400],
    ["absolute-form", `GET https://${r.authority}/ HTTP/1.1\r\nHost: ${r.authority}\r\n\r\n`, {}, 400],
    ["a body over 1 MiB, by its Content-Length", `POST /cart HTTP/1.1\r\nHost: ${r.authority}\r\nContent-Length: 2000000\r\n\r\n`, {}, 413],
    ["an ambiguous path", get(r, "/a/../cart"), {}, 400],
    ["a late duplicate Host behind 120 filler headers", `GET / HTTP/1.1\r\nHost: ${r.authority}\r\n${Array.from({ length: 120 }, (_, i) => `X-F${i}: v\r\n`).join("")}Host: evil.test\r\n\r\n`, {}, 431],
  ];
  for (const [label, inner, o, status] of cases) assert.equal(statusOf((await exchange(r, inner, o)).response), status, label);
  assert.equal(r.sink.arrivals.length, 0);
  assert.equal(r.sink.stats.connections, 0, "not even a connection");
  assert.equal(r.gate.admitted, 0);
});

test("one request per tunnel: a second request, even one pipelined behind a held dial, revokes the tunnel", async (t) => {
  let release!: () => void;
  const held = new Promise<void>((resolve) => (release = resolve));
  const r = await rig(t, {
    dial: (inner) => async (o, signal, pinned) => {
      await held;
      return inner(o, signal, pinned);
    },
  });
  const pending = exchange(r, get(r, "/one") + get(r, "/two"));
  await sleep(100);
  release();
  await pending;
  await sleep(100);
  assert.deepEqual(r.sink.arrivals.map((a) => a.url), []);
  assert.equal(r.gate.admitted, 0);
  assert.equal(r.journal.snapshot().denied.pipelined, 1);
});

test("the gate is asked before dialling: no connection for a request it would refuse", async (t) => {
  const r = await rig(t);
  r.clock.monoMs = 10_000; // past the lease
  for (let i = 0; i < 5; i++) assert.equal(deniedOf((await exchange(r, get(r))).response), "lease");
  assert.equal(r.dials.count, 0);
  assert.equal(r.sink.stats.connections, 0);

  const s = await rig(t);
  s.gate.stop();
  assert.match((await exchange(s, get(s))).response, /x-peeps-load-denied: stopped/);
  assert.equal(s.dials.count, 0);
});

test("dials started never exceed what the bucket allows, counting dials still in flight", async (t) => {
  const r = await rig(t, { phase: { ratePerSecond: 1, burst: 5 }, limits: { maxPendingDialsPerTurn: 50, maxPendingDials: 50, maxTunnelsPerTurn: 50 } });
  const results = await Promise.all(Array.from({ length: 12 }, () => exchange(r, get(r))));
  const denied = results.map((x) => deniedOf(x.response)).filter(Boolean);
  assert.equal(r.dials.count <= 5, true, `dials: ${r.dials.count}`);
  assert.equal(r.gate.admitted, 5);
  assert.equal(denied.length, 7);
  assert.equal(denied.every((d) => d === "rate"), true);
  assert.match(results.find((x) => deniedOf(x.response) === "rate")!.response, new RegExp(`${RETRY_HEADER}: \\d+`), "a rate denial says when to retry");
});

test("a dial that completes after the lease ran out sends no request bytes", async (t) => {
  let release!: () => void;
  const held = new Promise<void>((resolve) => (release = resolve));
  let dialled!: () => void;
  const started = new Promise<void>((resolve) => (dialled = resolve));
  const r = await rig(t, {
    dial: (inner) => async (o, signal, pinned) => {
      const s = await inner(o, signal, pinned);
      dialled();
      await held;
      return s;
    },
  });
  const pending = exchange(r, get(r));
  await started;
  r.clock.monoMs = 10_000;
  release();
  const { response } = await pending;
  assert.equal(cutOf(response), "lease", "debited before the dial: a cut, not a denial");
  assert.equal(r.sink.arrivals.length, 0);
  assert.equal(r.gate.admitted, 1, "the debit stays");
  assert.equal(r.gate.unresolved, 0);
  assert.equal(r.proxy.pinned.size, 0);
  assert.equal(r.expiries.count, 1, "the handoff saw the lease gone");
  assert.deepEqual(r.journal.snapshot(), { debited: 1, attempted: 0, accepted: 0, responded: 0, received: 0, unresolved: 1, denied: {}, cut: { lease: 1 } });
  assert.deepEqual([...r.journal.handoffs().unattempted], [1]);
});

const stuckDial: () => Dial = () => (_o, signal) =>
  new Promise((_resolve, reject) => {
    signal.addEventListener("abort", () => reject(new Error("aborted")));
  });

test("pending dials are bounded per turn and for the run; closing the turn aborts them", async (t) => {
  const r = await rig(t, { limits: { maxPendingDialsPerTurn: 1, maxPendingDials: 1 }, dial: stuckDial });
  const first = exchange(r, get(r, "/first"));
  await sleep(100);
  assert.equal(deniedOf((await exchange(r, get(r, "/second"))).response), "dials", "per turn");
  assert.equal(deniedOf((await exchange(r, get(r, "/other"), { credential: CREDENTIAL_2 })).response), "dials", "for the run");
  r.proxy.closeTurn(r.turn);
  await first;
  assert.equal(r.dials.signals[0]!.aborted, true, "the dial was abandoned");
  assert.equal(r.proxy.pendingDials, 0);
  assert.match((await exchange(r, get(r, "/after"))).connect, /^HTTP\/1\.1 403/, "a closed turn opens no tunnel");
  assert.equal(r.sink.arrivals.length, 0);
  assert.equal(r.gate.admitted, 1, "the abandoned dial keeps its debit");
  assert.deepEqual(r.journal.snapshot().cut, { turn_closed: 1 }, "a dial abandoned by closeTurn is cut turn_closed");
});

test("a dial has a deadline, and a journey that leaves abandons its dial", async (t) => {
  const r = await rig(t, { limits: { dialMs: 150 }, dial: stuckDial });
  assert.equal(cutOf((await exchange(r, get(r))).response), "dial_timeout");
  assert.equal(r.proxy.pendingDials, 0);
  assert.equal(r.gate.admitted, 1, "a dial_timeout keeps its debit");
  assert.deepEqual([...r.journal.handoffs().unattempted], [1]);

  const s = await rig(t, { dial: stuckDial });
  const raw = netConnect(s.socketPath);
  raw.write(`CONNECT ${s.authority} HTTP/1.1\r\nHost: ${s.authority}\r\nProxy-Authorization: ${CREDENTIAL}\r\n\r\n`);
  await new Promise((resolve) => raw.once("data", resolve));
  const tls = tlsConnect({ socket: raw, servername: "sink.test", ca: [s.runCaPem], ALPNProtocols: ["http/1.1"] });
  await new Promise((resolve) => tls.once("secureConnect", resolve));
  tls.write(get(s));
  await sleep(100);
  assert.equal(s.proxy.pendingDials, 1);
  tls.destroy();
  await sleep(100);
  assert.equal(s.dials.signals[0]!.aborted, true);
  assert.equal(s.proxy.pendingDials, 0);
});

test("tunnels are capped per turn, and a tunnel that never sends its request is closed", async (t) => {
  const r = await rig(t, { limits: { maxTunnelsPerTurn: 2, setupMs: 150 } });
  const open = async () => {
    const raw = netConnect(r.socketPath);
    raw.on("error", () => undefined);
    raw.write(`CONNECT ${r.authority} HTTP/1.1\r\nHost: ${r.authority}\r\nProxy-Authorization: ${CREDENTIAL}\r\n\r\n`);
    const answer = await new Promise<string>((resolve) => raw.once("data", (d: Buffer) => resolve(d.toString())));
    return { raw, answer };
  };
  const a = await open();
  const b = await open();
  const c = await open();
  assert.match(a.answer, /^HTTP\/1\.1 200/);
  assert.match(b.answer, /^HTTP\/1\.1 200/);
  assert.match(c.answer, /x-peeps-load-denied: tunnels/);
  assert.equal(r.proxy.openTunnels, 2);
  await sleep(300);
  assert.equal(r.proxy.openTunnels, 0, "both closed at the setup deadline");
  assert.equal(r.journal.snapshot().denied.setup_timeout, 2);
  for (const x of [a, b, c]) x.raw.destroy();
});

test("an upstream reset is a TCP RST, before and after the handshake", async (t) => {
  const ca = createRunCa({ hosts: ["sink.test"], nowMs: Date.now(), validForMs: 3_600_000 });
  const leaf = ca.leaf("sink.test")!;
  const seen: string[] = [];
  // A bare TLS target: Node's HTTP server reports a reset during a request as a plain end.
  const server = createTlsServer({ cert: leaf.certPem, key: leaf.key.export({ type: "pkcs8", format: "pem" }) as string }, (s) => {
    s.on("error", (e: NodeJS.ErrnoException) => seen.push(e.code ?? e.message));
    s.on("end", () => seen.push("end"));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const port = (server.address() as AddressInfo).port;
  const u = await connectVerified("127.0.0.1", { host: "sink.test", port, privateCidrs: [] }, { ca: [ca.certPem] });
  u.socket.write("GET / HTTP/1.1\r\nhost: sink.test\r\n\r\n");
  await sleep(100);
  u.reset();
  await sleep(200);
  assert.deepEqual(seen, ["ECONNRESET"]);
});

test("close() stops the gate, closes idle connections and resets upstreams with an RST", async (t) => {
  let arrived!: () => void;
  const reached = new Promise<void>((resolve) => (arrived = resolve));
  const r = await rig(t, { respond: () => arrived() });
  const idle = netConnect(r.socketPath);
  idle.on("error", () => undefined);
  idle.write("CONNECT x"); // never finished
  const pending = exchange(r, get(r));
  await reached;
  assert.equal(r.gate.inFlight, 1);
  const closed = await Promise.race([r.proxy.close().then(() => "closed"), sleep(2000).then(() => "hung")]);
  assert.equal(closed, "closed");
  assert.equal(r.gate.stopped, true);
  await pending;
  await sleep(100);
  assert.equal(r.journal.snapshot().debited, 1, "it stays debited");
  assert.equal(r.gate.inFlight, 0, "the exchange is over once its socket closed");
  assert.equal(r.dials.resets >= 1, true, "the upstream was reset, not ended (an RST: see the test above)");
});

test("a journey that stops reading stops the upstream: the response is not buffered in the supervisor", async (t) => {
  let written = 0;
  const total = 64 * 1024 * 1024;
  const chunk = Buffer.alloc(64 * 1024, 120);
  const r = await rig(t, {
    respond: (_a, res) => {
      res.writeHead(200, { "content-length": String(total) });
      const pump = () => {
        while (written < total) {
          written += chunk.length;
          if (!res.write(chunk)) return void res.once("drain", pump);
        }
        res.end();
      };
      pump();
    },
  });
  await exchange(r, get(r), { readLimit: 1 });
  await sleep(800);
  assert.ok(written < 16 * 1024 * 1024, `the target could write only what the pipe holds: ${written >> 20} MiB`);
});

test("a response larger than the limit is cut off", async (t) => {
  const r = await rig(t, {
    limits: { maxResponseBytes: 1024 },
    respond: (_a, res) => {
      res.writeHead(200, { "content-length": "4096" });
      res.end(Buffer.alloc(4096, 97));
    },
  });
  const { response } = await exchange(r, get(r));
  assert.equal(statusOf(response), 502, "a declared oversize body is refused before its 200 head");
  assert.deepEqual(r.journal.snapshot().cut, { response_too_large: 1 }, "an admitted request is cut, not denied");
  assert.deepEqual(r.journal.snapshot().denied, {});
  assert.equal(r.gate.inFlight, 0);

  // Many small chunks in one read: cut once, not once per chunk.
  const c = await rig(t, {
    limits: { maxResponseBytes: 1000 },
    respond: (_a, res) => {
      res.writeHead(200, { "transfer-encoding": "chunked" });
      for (let i = 0; i < 200; i++) res.write(Buffer.alloc(100, 97));
      res.end();
    },
  });
  const cut = await exchange(c, get(c));
  assert.equal(cut.response.endsWith("0\r\n\r\n"), false);
  assert.equal(c.dials.resets, 1);
  assert.deepEqual(c.journal.snapshot().cut, { response_too_large: 1 });
  assert.equal(c.gate.inFlight, 0);
});

test("an abandoned dial still spends its rate token: TCP and TLS reach the target at the bucket's pace", async (t) => {
  const r = await rig(t, {
    phase: { ratePerSecond: 1, burst: 1 },
    limits: { maxPendingDialsPerTurn: 50, maxPendingDials: 50, maxTunnelsPerTurn: 50 },
    // A slow target: the dial finishes 40 ms after its handshake.
    dial: (inner) => async (o, signal, pinned) => {
      const u = await inner(o, signal, pinned);
      await sleep(40);
      return u;
    },
  });
  const answers: (string | undefined)[] = [];
  for (let i = 0; i < 30; i++) {
    const before = r.sink.stats.connections;
    const raw = netConnect(r.socketPath);
    raw.on("error", () => undefined);
    raw.write(`CONNECT ${r.authority} HTTP/1.1\r\nHost: ${r.authority}\r\nProxy-Authorization: ${CREDENTIAL}\r\n\r\n`);
    await new Promise((resolve) => raw.once("data", resolve));
    const tls = tlsConnect({ socket: raw, servername: "sink.test", ca: [r.runCaPem], ALPNProtocols: ["http/1.1"] });
    tls.on("error", () => undefined);
    await new Promise((resolve) => tls.once("secureConnect", resolve));
    let got = "";
    tls.on("data", (d: Buffer) => (got += d.toString("latin1")));
    tls.write(get(r));
    // Leave as soon as the target sees a connection, or the proxy answers.
    for (let k = 0; k < 40 && r.sink.stats.connections === before && !got; k++) await sleep(5);
    tls.destroy();
    answers.push(deniedOf(got));
  }
  await sleep(100);
  assert.equal(r.sink.stats.connections <= 1, true, `connections at the target: ${r.sink.stats.connections}`);
  assert.equal(r.dials.count <= 1, true, `dials: ${r.dials.count}`);
  assert.equal(r.gate.admitted, 1, "the one dial carried a debit, kept when it was abandoned");
  assert.equal(r.sink.stats.connections <= r.gate.admitted, true, "no target connection without a debit");
  assert.equal(answers.filter((a) => a === "rate").length >= 28, true, `answers: ${answers.join(",")}`);
});

test("dials that time out spend their tokens too", async (t) => {
  const r = await rig(t, { phase: { ratePerSecond: 1, burst: 1 }, limits: { dialMs: 50 }, dial: stuckDial });
  const answers: (string | undefined)[] = [];
  for (let i = 0; i < 10; i++) {
    const { response } = await exchange(r, get(r));
    answers.push(cutOf(response) ?? deniedOf(response));
  }
  assert.equal(r.dials.count, 1);
  assert.deepEqual(answers, ["dial_timeout", ...Array(9).fill("rate")]);
  assert.equal(r.gate.admitted, 1, "the timed-out dial keeps its debit");
});

test("a method override in a write's body never reaches the target", async (t) => {
  const r = await rig(t);
  const body = "_method=DELETE";
  const { response } = await exchange(r, `POST /cart HTTP/1.1\r\nHost: ${r.authority}\r\nContent-Type: application/x-www-form-urlencoded\r\nContent-Length: ${body.length}\r\n\r\n${body}`);
  assert.equal(statusOf(response), 403);
  assert.equal(deniedOf(response), "not_allowed");
  assert.equal(r.sink.stats.connections, 0);
  assert.equal(r.dials.count, 0);
});

test("an exchange has a deadline: a target that never answers is reset, and the request stays debited", async (t) => {
  const r = await rig(t, { limits: { exchangeMs: 150 }, respond: () => undefined });
  const { response } = await exchange(r, get(r));
  assert.equal(statusOf(response), 502);
  assert.equal(cutOf(response), "exchange_timeout", "a cut answers x-peeps-load-cut");
  assert.equal(deniedOf(response), undefined, "a cut is never answered as a denial");
  await sleep(50);
  assert.equal(r.gate.inFlight, 0);
  assert.equal(r.dials.resets >= 1, true, "the upstream was reset");
  const snap = r.journal.snapshot();
  assert.equal(snap.debited, 1);
  assert.deepEqual(snap.denied, {}, "an admitted request is never counted as denied");
  assert.equal(snap.cut.exchange_timeout, 1);
});

test("a body that stalls inside the tunnel is closed at the setup deadline, before any dial", async (t) => {
  const r = await rig(t, { limits: { setupMs: 150 } });
  const raw = netConnect(r.socketPath);
  raw.on("error", () => undefined);
  raw.write(`CONNECT ${r.authority} HTTP/1.1\r\nHost: ${r.authority}\r\nProxy-Authorization: ${CREDENTIAL}\r\n\r\n`);
  await new Promise((resolve) => raw.once("data", resolve));
  const tls = tlsConnect({ socket: raw, servername: "sink.test", ca: [r.runCaPem], ALPNProtocols: ["http/1.1"] });
  tls.on("error", () => undefined);
  await new Promise((resolve) => tls.once("secureConnect", resolve));
  tls.write(`POST /cart HTTP/1.1\r\nHost: ${r.authority}\r\nContent-Length: 100\r\n\r\n0123456789`);
  await sleep(300);
  assert.equal(r.proxy.openTunnels, 0);
  assert.equal(r.journal.snapshot().denied.setup_timeout, 1);
  assert.equal(r.sink.stats.connections, 0);
  assert.equal(r.gate.admitted, 0);
  assert.equal(r.proxy.bufferedBodyBytes, 0, "its bytes left the budget");
  tls.destroy();
});

test("request bodies held in memory share one run-wide budget", async (t) => {
  const r = await rig(t, { limits: { maxBufferedBodyBytes: 1024 * 1024, setupMs: 5_000 } });
  const open = async (credential: string) => {
    const raw = netConnect(r.socketPath);
    raw.on("error", () => undefined);
    raw.write(`CONNECT ${r.authority} HTTP/1.1\r\nHost: ${r.authority}\r\nProxy-Authorization: ${credential}\r\n\r\n`);
    await new Promise((resolve) => raw.once("data", resolve));
    const tls = tlsConnect({ socket: raw, servername: "sink.test", ca: [r.runCaPem], ALPNProtocols: ["http/1.1"] });
    tls.on("error", () => undefined);
    await new Promise((resolve) => tls.once("secureConnect", resolve));
    let got = "";
    tls.on("data", (d: Buffer) => (got += d.toString("latin1")));
    return { tls, got: () => got };
  };
  const head = `POST /cart HTTP/1.1\r\nHost: ${r.authority}\r\nContent-Length: ${900 * 1024}\r\n\r\n`;
  const a = await open(CREDENTIAL);
  a.tls.write(head + "a".repeat(800 * 1024));
  await sleep(200);
  const b = await open(CREDENTIAL_2);
  b.tls.write(head + "b".repeat(800 * 1024));
  await sleep(200);
  assert.deepEqual(r.journal.snapshot().denied, { memory: 1 });
  a.tls.write("a".repeat(100 * 1024));
  for (let k = 0; k < 100 && !a.got(); k++) await sleep(10);
  assert.equal(statusOf(a.got()), 200, "the first still completes");
  assert.equal(r.sink.arrivals.length, 1);
  a.tls.destroy();
  b.tls.destroy();
  await sleep(50);
  assert.equal(r.proxy.bufferedBodyBytes, 0);
});

test("tunnels are capped for the run, and connections to the socket are capped", async (t) => {
  const r = await rig(t, { limits: { maxTunnels: 2, maxConnections: 4 } });
  const open = async (credential: string) => {
    const raw = netConnect(r.socketPath);
    raw.on("error", () => undefined);
    raw.write(`CONNECT ${r.authority} HTTP/1.1\r\nHost: ${r.authority}\r\nProxy-Authorization: ${credential}\r\n\r\n`);
    const answer = await new Promise<string>((resolve) => {
      raw.once("data", (d: Buffer) => resolve(d.toString()));
      raw.once("close", () => resolve(""));
    });
    return { raw, answer };
  };
  const a = await open(CREDENTIAL);
  const b = await open(CREDENTIAL_2);
  const c = await open(CREDENTIAL);
  assert.match(a.answer, /^HTTP\/1\.1 200/);
  assert.match(b.answer, /^HTTP\/1\.1 200/);
  assert.match(c.answer, /x-peeps-load-denied: tunnels/, "the run-wide cap, from either turn");
  for (const x of [a, b, c]) x.raw.destroy();
  await sleep(50);

  const held = await Promise.all(Array.from({ length: 4 }, () => new Promise<import("node:net").Socket>((resolve) => {
    const s = netConnect(r.socketPath, () => resolve(s));
    s.on("error", () => undefined);
  })));
  await sleep(50);
  const extra = netConnect(r.socketPath);
  extra.on("error", () => undefined);
  const closed = await Promise.race([new Promise((resolve) => extra.once("close", () => resolve(true))), sleep(1000).then(() => false)]);
  assert.equal(closed, true, "a connection over the cap is closed by the server");
  for (const s of held) s.destroy();
});

test("the production dial shares one lookup among first dials, then goes to the pinned address", async (t) => {
  const sink = await startSink();
  t.after(() => sink.close());
  let lookups = 0;
  const answers = [["93.184.216.34"], ["151.101.1.1"]].map((a) => a.map((address) => ({ address, family: 4 })));
  const connected: string[] = [];
  const dial = makeDial({
    ca: [sink.caPem],
    lookup: async () => {
      lookups += 1;
      await sleep(30);
      return answers[Math.min(lookups - 1, 1)]!;
    },
    // Every address is the fixture sink; the address the dial chose is what is recorded.
    connect: async (address, o, opts) => {
      connected.push(address);
      const u = await connectVerified("127.0.0.1", { ...o, port: sink.port }, opts);
      return { ...u, address };
    },
  });
  const origin: ApprovedOrigin = { host: "sink.test", port: sink.port, privateCidrs: [] };
  const first = await Promise.all(Array.from({ length: 5 }, () => dial(origin, new AbortController().signal, undefined)));
  assert.equal(lookups, 1, "concurrent first dials share one lookup");
  assert.deepEqual(new Set(first.map((u) => u.address)), new Set(["93.184.216.34"]));
  const pinned = await dial(origin, new AbortController().signal, first[0]!.address);
  assert.equal(lookups, 1, "a pinned dial makes no lookup");
  assert.equal(pinned.address, "93.184.216.34");
  for (const u of [...first, pinned]) u.reset();
  assert.deepEqual(connected, Array(6).fill("93.184.216.34"));
});

test("a write the target does not take stays unresolved, and stays debited", async (t) => {
  // The kernel never takes the bytes: write() reports backpressure and its callback never runs.
  // (A real full pipe on a frozen target is E4's load-freeze trial.)
  let wrote: boolean | undefined;
  const r = await rig(t, {
    dial: (real) => async (o, signal, pinned) => {
      const u = await real(o, signal, pinned);
      u.socket.write = (() => (wrote = false)) as typeof u.socket.write;
      return u;
    },
  });
  void exchange(r, get(r, "/stuck")).catch(() => undefined);
  await sleep(300);
  assert.equal(wrote, false, "write() returned false");
  assert.deepEqual({ ...r.journal.snapshot(), denied: undefined, cut: undefined }, { debited: 1, attempted: 1, accepted: 0, responded: 0, received: 0, unresolved: 1, denied: undefined, cut: undefined });
  assert.equal(r.gate.unresolved, 1);
  await r.proxy.close();
  const after = r.journal.snapshot();
  assert.equal(after.debited, 1, "it stays debited");
  assert.equal(after.unresolved, 1, "and its delivery stays unknown");
  assert.ok(r.journal.entry(1), "its entry stays open");
});

test("receipts join the journal: everything the target saw was handed off, once", async (t) => {
  const r = await rig(t, { seqHeader: "x-peeps-load-seq" });
  for (let i = 0; i < 5; i++) await exchange(r, get(r, `/r${i}`));
  const receipts = r.sink.arrivals.map((a) => Number(a.headers["x-peeps-load-seq"]));
  assert.deepEqual(receipts, [1, 2, 3, 4, 5]);
  assert.equal(r.journal.snapshot().received, 0);
  for (const seq of receipts) assert.equal(r.journal.confirmReceipt(seq), true);
  assert.equal(r.journal.snapshot().received, 5);
  assert.deepEqual(receivedOutsideGate(r.journal.handoffs(), receipts), { unknown: [], repeated: [] });
  assert.deepEqual(receivedOutsideGate(r.journal.handoffs(), [...receipts, 9]).unknown, [9], "an arrival the gate never wrote");
});

test("architecture: a fresh sample, handoff, attempt and write in one synchronous function; the debit before any dial", () => {
  const source = readFileSync(path.join(__dirname, "..", "src", "load", "gate", "proxy.ts"), "utf8").replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, "");
  const start = source.indexOf("private send(");
  assert.ok(start > 0, "send() exists");
  const end = source.indexOf("\n  private ", start + 1);
  const body = source.slice(start, end);
  const handoff = body.indexOf(".handoff(permit, this.clocks())");
  const attempt = body.indexOf("journal.attempt(");
  const write = body.indexOf(".write(");
  assert.ok(handoff > 0 && attempt > handoff && write > attempt, "handoff on a fresh sample, then journal.attempt, then write");
  assert.match(body.slice(attempt, write), /^journal\.attempt\([^;]*\);\s*upstream\.socket$/, "nothing between attempt and write");
  assert.doesNotMatch(body, /\bawait\b|\.then\(|\basync\b|nextTick|setImmediate|queueMicrotask|setTimeout/, "send() is synchronous");
  assert.equal((source.match(/\.handoff\(/g) ?? []).length, 1, "handoff is called in one place");
  assert.equal((source.match(/journal\.attempt\(/g) ?? []).length, 1, "attempt is recorded in one place");
  assert.equal((source.match(/socket\.write\(/g) ?? []).length, 1, "the request is written in one place");
  const dispatch = source.slice(source.indexOf("private async dispatch("), start);
  const permit = dispatch.indexOf(".permit(");
  const begin = dispatch.indexOf("journal.begin(");
  assert.ok(permit > 0 && begin > permit && begin < dispatch.indexOf("this.dial("), "the gate debits, and the journal begins, before any dial");
  assert.equal((source.match(/\.permit\(/g) ?? []).length, 1, "permit is called in one place");
});

// ---------------------------------------------------------------- the upstream response reader

function read(method: string, ...chunks: string[]) {
  const out = { status: 0, body: "", ended: false, error: "" };
  const r = new ResponseReader(method, {
    head: (h) => (out.status = h.status),
    data: (c) => { out.body += c.toString(); },
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
  assert.match(read("GET", "HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\nContent-Length: 5\r\n\r\n").out.error, /ambiguous/);
  assert.match(read("GET", "HTTP/1.1 200 OK\r\nTransfer-Encoding: gzip, chunked\r\n\r\n").out.error, /transfer-coding/);
  assert.match(read("GET", "garbage\r\n\r\n").out.error, /status line/);
  assert.match(read("GET", "HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\nzz\r\n").out.error, /chunk size/);
});

test("the production dial: one TCP attempt, the pin checked again, and readiness checked just before connecting", async () => {
  const origin: ApprovedOrigin = { host: "shop.test", port: 443, privateCidrs: [] };
  const tried: string[] = [];
  const refusedConnect: typeof connectVerified = async (address) => {
    tried.push(address);
    throw new DialRefused("tls", "shop.test: connect ECONNREFUSED");
  };
  const two = makeDial({ lookup: lookupOf("93.184.216.34", "151.101.1.1"), connect: refusedConnect });
  assert.equal(await refusal(two(origin, new AbortController().signal, undefined)), "tls");
  assert.deepEqual(tried, ["93.184.216.34"], "no fallback: one dial, one TCP attempt");

  tried.length = 0;
  assert.equal(await refusal(two(origin, new AbortController().signal, "10.0.0.5")), "address", "a pin out of reach is refused");
  assert.equal(await refusal(two(origin, new AbortController().signal, "169.254.169.254")), "address");
  assert.deepEqual(tried, []);

  let lookups = 0;
  const slow = makeDial({
    lookup: async () => {
      lookups += 1;
      await sleep(30);
      return [{ address: "93.184.216.34", family: 4 }];
    },
    connect: refusedConnect,
  });
  let live = true;
  const pending = slow(origin, new AbortController().signal, undefined, () => live);
  live = false; // the lease ran out while DNS was answering
  assert.equal(await refusal(pending), "aborted");
  assert.deepEqual(tried, [], "no TCP once the gate would refuse");
  assert.equal(lookups, 1);
});

test("a lease that runs out while the dial is resolving sends nothing at all to the target", async (t) => {
  const r = await rig(t, {
    dial: () =>
      makeDial({
        lookup: async () => {
          await sleep(300);
          return [{ address: "93.184.216.34", family: 4 }];
        },
        connect: (_address, o, opts) => connectVerified("127.0.0.1", o, { ...opts, ca: [r.sink.caPem] }),
      }),
  });
  const pending = exchange(r, get(r));
  for (let k = 0; k < 100 && r.dials.count === 0; k++) await sleep(5);
  assert.equal(r.dials.count, 1, "the dial started under a live lease");
  r.clock.wallMs += 3_600_000; // the lease runs out on the wall clock while DNS answers
  const { response } = await pending;
  assert.equal(statusOf(response), 503);
  assert.equal(cutOf(response), "lease", "the gate's reason, not a failed dial; a cut, since it was debited");
  assert.deepEqual(r.journal.snapshot().cut, { lease: 1 });
  assert.equal(r.sink.stats.connections, 0, "no SYN after the lease ran out");
  assert.equal(r.gate.admitted, 1, "the debit stays, unattempted");
  assert.equal(r.expiries.count, 1, "checkDial saw the lease gone");
});

test("an early response while the request's write is still pending resets the upstream", async (t) => {
  let liveResets = 0;
  const r = await rig(t, {
    dial: (inner) => async (o, signal, pinned, ready) => {
      const u = await inner(o, signal, pinned, ready);
      const write = u.socket.write.bind(u.socket) as (data: Buffer) => boolean;
      // The bytes go out; the write's callback never confirms them.
      u.socket.write = ((data: Buffer) => write(data)) as typeof u.socket.write;
      return {
        ...u,
        reset: () => {
          if (!u.socket.destroyed) liveResets += 1;
          u.reset();
        },
      };
    },
  });
  const { response } = await exchange(r, get(r));
  assert.equal(statusOf(response), 200);
  await sleep(50);
  assert.equal(liveResets, 1, "reset while the socket was still open, not ended");
  const snap = r.journal.snapshot();
  assert.equal(snap.unresolved, 1, "its delivery stays unknown");
  assert.equal(snap.responded, 1);
  assert.equal(snap.received, 0);
  assert.equal(r.gate.inFlight, 0);
});

test("a close-delimited response cut by the exchange deadline is a failure, not a clean end", async (t) => {
  const r = await rig(t, {
    limits: { exchangeMs: 150 },
    respond: (_a, res) => {
      res.socket!.write("HTTP/1.1 200 OK\r\nconnection: close\r\n\r\npartial");
    },
  });
  // The journey sees the head and part of the body, then the tunnel closes with no clean end.
  const { response } = await exchange(r, get(r));
  assert.equal(statusOf(response), 200);
  assert.match(response, /7\r\npartial\r\n$/);
  assert.equal(response.endsWith("0\r\n\r\n"), false, "no terminating chunk: the journey sees a truncated body");
  assert.deepEqual(r.journal.snapshot().cut, { exchange_timeout: 1 }, "cut once, by its first reason");
  assert.equal(r.gate.inFlight, 0);
  assert.equal(r.dials.resets >= 1, true);
});

test("a response with ambiguous framing is refused before it counts as a response", async (t) => {
  const r = await rig(t, {
    respond: (_a, res) => {
      res.socket!.write("HTTP/1.1 200 OK\r\ncontent-length: 5\r\ntransfer-encoding: chunked\r\n\r\n0\r\n\r\n");
      res.socket!.end();
    },
  });
  const { response } = await exchange(r, get(r));
  assert.equal(statusOf(response), 502);
  assert.equal(r.journal.snapshot().responded, 0);
  assert.deepEqual(r.journal.snapshot().cut, { upstream: 1 });
});

test("a response head Node would refuse to write back is a failed exchange, not a crash", async (t) => {
  const heads = ["HTTP/1.1 200 O\x01K\r\ncontent-length: 0\r\n\r\n", "HTTP/1.1 200 OK\r\nx: a\x00b\r\ncontent-length: 0\r\n\r\n", "HTTP/1.1 200 OK\r\nx(y: 1\r\ncontent-length: 0\r\n\r\n"];
  for (const raw of heads) {
    const seen: string[] = [];
    const reader = new ResponseReader("GET", { head: () => seen.push("head"), data: () => undefined, end: () => seen.push("end"), error: () => seen.push("error") });
    reader.push(Buffer.from(raw, "latin1"));
    assert.deepEqual(seen, ["error"], JSON.stringify(raw));
  }
  const latin: string[] = [];
  new ResponseReader("GET", { head: (h) => latin.push(h.statusText, h.headers[0]![1]), data: () => undefined, end: () => undefined, error: () => latin.push("error") }).push(Buffer.from("HTTP/1.1 200 caf\xe9\r\nx: \ta\xff\r\ncontent-length: 0\r\n\r\n", "latin1"));
  assert.deepEqual(latin, ["caf\xe9", "a\xff"], "tabs and Latin-1 text pass, as Node writes them");

  // End to end: before this was checked, the control character in the reason phrase threw out
  // of the upstream socket's data handler, twice (the 502 reused the bad phrase), and took the process down.
  let n = 0;
  const r = await rig(t, { respond: (_a, res) => void res.socket!.end(Buffer.from(heads[n++]!, "latin1")) });
  for (const _ of heads) {
    const { response } = await exchange(r, get(r));
    assert.equal(statusOf(response), 502);
    assert.equal(cutOf(response), "upstream", "an admitted exchange is cut, not denied");
    assert.equal(deniedOf(response), undefined);
  }
  const snap = r.journal.snapshot();
  assert.equal(snap.received, 0, "never reported as received");
  assert.deepEqual(snap.cut, { upstream: heads.length });
  assert.equal(r.gate.inFlight, 0);
});

test("a dial that lands on another address than the pin is reset and refused; a revoked dial pins nothing", async (t) => {
  let n = 0;
  const r = await rig(t, { dial: (inner) => async (o, signal, pinned, ready) => ({ ...(await inner(o, signal, pinned, ready)), address: ++n === 1 ? "93.184.216.34" : "151.101.1.1" }) });
  assert.equal(statusOf((await exchange(r, get(r))).response), 200);
  assert.equal(cutOf((await exchange(r, get(r))).response), "pin");
  assert.equal(r.sink.arrivals.length, 1);
  assert.equal(r.gate.admitted, 2, "the refused dial keeps its debit");
  assert.deepEqual([...r.proxy.pinned.values()], ["93.184.216.34"]);

  let release!: () => void;
  const held = new Promise<void>((resolve) => (release = resolve));
  const s2 = await rig(t, {
    dial: (inner) => async (o, signal, pinned, ready) => {
      const u = await inner(o, signal, pinned, ready);
      await held;
      return u;
    },
  });
  const pending = exchange(s2, get(s2));
  for (let k = 0; k < 100 && s2.dials.count === 0; k++) await sleep(5);
  s2.proxy.closeTurn(s2.turn);
  release();
  await pending;
  assert.equal(s2.proxy.pinned.size, 0, "only a live dial pins its origin");
});

test("every caller of close() waits on the same close", async (t) => {
  const r = await rig(t);
  const a = r.proxy.close();
  assert.equal(r.proxy.close(), a);
  await a;
});

test("an address with a zone id is never reachable", async () => {
  assert.equal(reachable("fe80::1%eth0", ORIGIN, new Set()), false);
  assert.equal(await refusal(checkedAddresses(ORIGIN, { lookup: lookupOf("93.184.216.34", "fe80::1%eth0") })), "address");
});

test("a second request uses the address established by the first live dial", async (t) => {
  let release!: () => void;
  const held = new Promise<void>((resolve) => { release = resolve; });
  let connected!: () => void;
  const firstConnected = new Promise<void>((resolve) => { connected = resolve; });
  let started = 0;
  const r = await rig(t, {
    dial: (inner) => async (o, signal, pin, ready) => {
      const address = pin ?? (++started === 1 ? "93.184.216.34" : "151.101.1.1");
      const upstream = await inner(o, signal, pin, ready);
      if (address === "93.184.216.34" && pin === undefined) {
        connected();
        await held;
      }
      return { ...upstream, address };
    },
  });
  const first = exchange(r, get(r, "/first"));
  await firstConnected;
  const second = exchange(r, get(r, "/second"), { credential: CREDENTIAL_2 });
  try {
    for (let i = 0; i < 100 && r.proxy.pendingDials < 2; i++) await sleep(5);
    assert.equal(r.proxy.pendingDials, 2);
    assert.equal(r.dials.count, 1, "the second request is queued before TCP starts");
  } finally {
    release();
  }
  assert.deepEqual((await Promise.all([first, second])).map((x) => statusOf(x.response)), [200, 200]);
  assert.deepEqual(r.dials.pinned, [undefined, "93.184.216.34"]);
});

for (const holdAt of ["before TCP", "after TLS"] as const) {
  test(`first-dial queue preserves burst 1 when delayed ${holdAt}`, { timeout: 3000 }, async (t) => {
    let release!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    let entered!: () => void;
    const firstHeld = new Promise<void>((resolve) => { entered = resolve; });
    const hold = () => {
      entered();
      return held;
    };
    const r = await rig(t, {
      phase: { ratePerSecond: 1, burst: 1 },
      dial: (inner) => async (origin, signal, pin, ready) => {
        if (pin === undefined && holdAt === "before TCP") await hold();
        const upstream = await inner(origin, signal, pin, ready);
        if (pin === undefined && holdAt === "after TLS") await hold();
        return upstream;
      },
    });
    const first = exchange(r, get(r, "/first"));
    await firstHeld;
    r.clock.monoMs = 1000; // Refill the reservation bucket, then freeze time.
    const second = exchange(r, get(r, "/second"));
    try {
      for (let i = 0; i < 100 && r.proxy.pendingDials < 2; i++) await sleep(5);
      assert.equal(r.proxy.pendingDials, 2);
    } finally {
      release();
    }
    const firstResult = await first;
    assert.equal(statusOf(firstResult.response), 200);
    // The clock is frozen: the second write waits for the handoff's token, its debit kept.
    for (let i = 0; i < 20 && r.sink.stats.connections < 2; i++) await sleep(10);
    await sleep(100);
    assert.deepEqual(r.sink.arrivals.map((arrival) => arrival.url), ["/first"], "one write per token: burst 1 at the target");
    assert.equal(r.gate.admitted, 2);
    r.clock.monoMs += 1000;
    assert.equal(statusOf((await second).response), 200, "paced, not cut");
    assert.deepEqual(r.sink.arrivals.map((arrival) => arrival.url), ["/first", "/second"]);

    r.clock.monoMs += 1000;
    assert.equal(statusOf((await exchange(r, get(r, "/after-refill"))).response), 200);
  });
}

test("a lower lease ceiling stops new permits; permits already debited go on", { timeout: 3000 }, async (t) => {
  let release!: () => void;
  const held = new Promise<void>((resolve) => { release = resolve; });
  let entered!: () => void;
  const firstHeld = new Promise<void>((resolve) => { entered = resolve; });
  const r = await rig(t, {
    dial: (inner) => async (...args) => {
      const upstream = await inner(...args);
      if (args[2] === undefined) {
        entered();
        await held;
      }
      return upstream;
    },
  });
  const first = exchange(r, get(r, "/first"));
  await firstHeld;
  const later = [exchange(r, get(r, "/second")), exchange(r, get(r, "/third"))];
  try {
    for (let i = 0; i < 100 && r.proxy.pendingDials < 3; i++) await sleep(5);
    assert.equal(r.proxy.pendingDials, 3);
    r.gate.applyLease({ seq: 2, monoUntil: 10_000, wallUntil: r.clock.wallMs + 10_000, ceiling: 2 });
    assert.equal(deniedOf((await exchange(r, get(r, "/fourth"))).response), "ceiling", "three debits are over the new ceiling");
  } finally {
    release();
  }
  assert.equal(statusOf((await first).response), 200);
  const results = await Promise.all(later);
  assert.deepEqual(results.map(({ response }) => statusOf(response)), [200, 200], "already counted: not checked against the ceiling again");
  assert.equal(r.gate.admitted, 3);
  assert.equal(r.sink.stats.connections, 3);
});

test("a canceled DNS waiter leaves the underlying lookup charged until it settles", async () => {
  let answer!: (a: { address: string; family: number }[]) => void;
  const held = new Promise<{ address: string; family: number }[]>((resolve) => { answer = resolve; });
  const calls: string[] = [];
  const dialOptions = {
    maxLookups: 1,
    lookup: (name: string) => {
      calls.push(name);
      return name === "shop.test." ? held : Promise.resolve([{ address: "93.184.216.34", family: 4 }]);
    },
    connect: async () => { throw new DialRefused("tls", "fixture connect"); },
  };
  const dial = makeDial(dialOptions);
  const shop: ApprovedOrigin = { host: "shop.test", port: 443, privateCidrs: [] };
  const other = { ...shop, host: "other.test" };
  for (let i = 0; i < 4; i++) {
    const controller = new AbortController();
    const waiting = dial(shop, controller.signal, undefined);
    await Promise.resolve();
    controller.abort();
    assert.equal(await refusal(waiting), "aborted");
  }
  assert.deepEqual(calls, ["shop.test."]);
  assert.equal(await refusal(dial(other, new AbortController().signal, undefined)), "resolve");
  assert.deepEqual(calls, ["shop.test."]);
  const joined = refusal(dial(shop, new AbortController().signal, undefined));
  answer([{ address: "93.184.216.34", family: 4 }]);
  assert.equal(await joined, "tls");
  assert.equal(await refusal(dial(other, new AbortController().signal, undefined)), "tls");
  assert.deepEqual(calls, ["shop.test.", "other.test."]);
});

test("the verified connector checks the grant again before starting TLS", { timeout: 3000 }, async (t) => {
  let bytes = 0;
  let peerClosed!: () => void;
  const closed = new Promise<void>((resolve) => { peerClosed = resolve; });
  const server = createNetServer((socket) => {
    socket.on("error", () => undefined);
    socket.on("data", (data: Buffer) => { bytes += data.length; });
    socket.once("close", peerClosed);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const port = (server.address() as AddressInfo).port;
  const origin = { host: "sink.test", port, privateCidrs: [] };
  const checks: (string | undefined)[] = [];
  const ready = (boundary?: "tcp" | "tls") => {
    checks.push(boundary);
    return boundary === "tcp";
  };
  const controller = new AbortController();
  const pending = connectVerified("127.0.0.1", origin, { signal: controller.signal, ready });
  const timeout = setTimeout(() => controller.abort(), 250);
  try {
    assert.equal(await refusal(pending), "aborted");
    assert.deepEqual(checks, ["tcp", "tls"], "TCP start and TLS start each check the grant");
    await closed;
    assert.equal(bytes, 0);
  } finally {
    clearTimeout(timeout);
  }
});

test("close waits for a returned transport to be reset and closed", async (t) => {
  let release!: () => void;
  const held = new Promise<void>((resolve) => { release = resolve; });
  let connected!: (upstream: Upstream) => void;
  const firstConnected = new Promise<Upstream>((resolve) => { connected = resolve; });
  const r = await rig(t, {
    dial: (inner) => async (o, signal, pin, ready) => {
      const upstream = await inner(o, signal, pin, ready);
      connected(upstream);
      await held;
      return upstream;
    },
  });
  const pending = exchange(r, get(r));
  const upstream = await firstConnected;
  let transportClosed = false;
  void upstream.closed.then(() => { transportClosed = true; });
  const closing = r.proxy.close();
  let closed = false;
  void closing.then(() => { closed = true; });
  try {
    await pending;
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(closed, false);
  } finally {
    release();
  }
  await closing;
  assert.equal(r.proxy.pendingDials, 0);
  assert.equal(r.dials.resets, 1);
  assert.equal(transportClosed, true);
  assert.equal(r.gate.admitted, 1, "debited before its dial, never attempted");
  assert.deepEqual([...r.journal.handoffs().unattempted], [1]);
  assert.equal(r.sink.arrivals.length, 0);
});

test("an admitted queued body retains its budget until reset", async (t) => {
  let wrote!: () => void;
  const writeStarted = new Promise<void>((resolve) => { wrote = resolve; });
  const r = await rig(t, {
    limits: { maxBufferedBodyBytes: 24 },
    dial: (inner) => async (...args) => {
      const upstream = await inner(...args);
      upstream.socket.write = (() => {
        wrote();
        return false;
      }) as typeof upstream.socket.write;
      return upstream;
    },
  });
  const post = `POST /cart HTTP/1.1\r\nHost: ${r.authority}\r\nContent-Length: 16\r\n\r\n${"a".repeat(16)}`;
  const first = exchange(r, post);
  await writeStarted;
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(r.proxy.bufferedBodyBytes, 16);
  await exchange(r, post, { credential: CREDENTIAL_2 });
  assert.deepEqual(r.journal.snapshot().denied, { memory: 1 });
  assert.equal(r.gate.admitted, 1);
  r.proxy.closeTurn(r.turn);
  assert.equal(r.gate.inFlight, 0, "turn revocation finalizes synchronously");
  await r.proxy.close();
  await first;
  assert.equal(r.proxy.bufferedBodyBytes, 0);
  assert.equal(r.dials.resets, 1);
});

test("one response input yields on backpressure and resumes without dropping decoded bytes", () => {
  const writes: string[] = [];
  let ends = 0;
  const reader = new ResponseReader("GET", {
    head: () => {},
    data: (chunk) => {
      writes.push(chunk.toString());
      return writes.length !== 1;
    },
    end: () => { ends += 1; },
    error: (error) => assert.fail(error.message),
  });
  reader.push(Buffer.from("HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n1\r\na\r\n1\r\nb\r\n1\r\nc\r\n0\r\n\r\n"));
  assert.deepEqual(writes, ["a"]);
  assert.equal(ends, 0);
  reader.resume();
  assert.deepEqual(writes, ["a", "b", "c"]);
  assert.equal(ends, 1);
});

test("the target cannot speak for the gate: its denied, cut and retry headers are stripped", async (t) => {
  const r = await rig(t, {
    respond: (_a, res) => {
      res.writeHead(503, { [DENIED_HEADER]: "rate", [CUT_HEADER]: "upstream", [RETRY_HEADER]: "5", "x-kept": "1" });
      res.end("busy");
    },
  });
  const { response } = await exchange(r, get(r));
  assert.equal(statusOf(response), 503, "the target's own 503 passes");
  assert.match(response, /x-kept: 1/i);
  assert.doesNotMatch(response, /x-peeps-load-/i, "no gate header the target sent reaches the journey");
  assert.deepEqual(r.journal.snapshot().denied, {});
});

// ---------------------------------------------------------------- debit before dial (e4 plan v3 §2.6)

test("a client that closes right after sending its request: target connections never outnumber debits", async (t) => {
  const r = await rig(t, {
    gate: { runTotal: 10 },
    phase: { ratePerSecond: 10_000, burst: 1000 },
    limits: { maxPendingDialsPerTurn: 1000, maxPendingDials: 1000, maxTunnelsPerTurn: 1000, maxTunnels: 1000 },
  });
  for (let i = 0; i < 250; i++) {
    const raw = netConnect(r.socketPath);
    raw.on("error", () => undefined);
    raw.write(`CONNECT ${r.authority} HTTP/1.1\r\nHost: ${r.authority}\r\nProxy-Authorization: ${CREDENTIAL}\r\n\r\n`);
    await new Promise((resolve) => raw.once("data", resolve));
    const tls = tlsConnect({ socket: raw, servername: "sink.test", ca: [r.runCaPem], ALPNProtocols: ["http/1.1"] });
    tls.on("error", () => undefined);
    await new Promise((resolve) => tls.once("secureConnect", resolve));
    // Closed once the request is handed to the kernel: a destroy straight after `end` drops whatever
    // is still queued, and on a slower machine that was the request itself (no debit at all, CI).
    await new Promise<void>((resolve) => tls.end(get(r, `/hit${i}`), resolve));
    tls.destroy();
    r.clock.monoMs += 20;
  }
  for (let k = 0; k < 200 && r.proxy.pendingDials > 0; k++) await sleep(5);
  await sleep(100);
  assert.equal(r.gate.admitted, 10, "the run total");
  assert.ok(r.sink.stats.connections <= 10, `TCP accepts at the target: ${r.sink.stats.connections}`);
  assert.ok(r.sink.stats.connections <= r.gate.admitted, "each accept carries a debit");
});

test("clock seam: live at the permit, expired at the handoff: reset, zero HTTP bytes, the debit unattempted, a cut", async (t) => {
  let expired = false;
  const r = await rig(t, {
    clocks: (clock) => (expired ? { monoMs: 10_000, wallMs: clock.wallMs } : { ...clock }),
    dial: (inner) => async (...args) => {
      const upstream = await inner(...args);
      expired = true;
      return upstream;
    },
  });
  const { response } = await exchange(r, get(r));
  await sleep(50);
  assert.equal(cutOf(response), "lease");
  assert.equal(r.sink.stats.connections, 1, "the dial reached the target");
  assert.equal(r.sink.stats.requestBytes, 0, "zero HTTP bytes");
  assert.equal(r.sink.arrivals.length, 0);
  assert.equal(r.dials.resets, 1, "the upstream is reset");
  assert.equal(r.gate.admitted, 1);
  assert.deepEqual([...r.journal.handoffs().unattempted], [1]);
  assert.equal(r.journal.snapshot().attempted, 0);
  assert.equal(r.expiries.count, 1);
});

test("a dial refused by the target keeps its debit, cut dial", async (t) => {
  const r = await rig(t, { dial: () => () => Promise.reject(new Error("connect ECONNREFUSED")) });
  const { response } = await exchange(r, get(r));
  assert.equal(statusOf(response), 502);
  assert.equal(cutOf(response), "dial");
  assert.equal(r.gate.admitted, 1);
  assert.equal(r.gate.inFlight, 0, "its exchange is over");
  assert.deepEqual(r.journal.snapshot().cut, { dial: 1 });
  assert.deepEqual([...r.journal.handoffs().unattempted], [1]);
});

for (const site of ["permit", "checkDial", "handoff"] as const) {
  test(`onLeaseExpired may close the proxy re-entrantly at ${site}`, async (t) => {
    let expired = site === "permit";
    let closing: Promise<void> | undefined;
    const r = await rig(t, {
      clocks: (clock) => (expired ? { monoMs: 10_000, wallMs: clock.wallMs } : { ...clock }),
      onLeaseExpired: ({ proxy }) => {
        closing = proxy.close();
      },
      dial: (inner) => async (origin, signal, pinned, ready) => {
        if (site === "checkDial") expired = true;
        const upstream = await inner(origin, signal, pinned, ready);
        if (site === "handoff") expired = true;
        return upstream;
      },
    });
    const { response } = await exchange(r, get(r));
    assert.ok(closing, "the hook ran");
    await closing;
    assert.equal(r.expiries.count, 1, "called once");
    assert.equal(r.gate.stopped, true);
    assert.equal(r.sink.arrivals.length, 0);
    assert.equal(r.sink.stats.requestBytes, 0);
    assert.equal(r.proxy.pendingDials, 0);
    if (site === "permit") {
      assert.equal(r.gate.admitted, 0);
      assert.equal(deniedOf(response), "lease");
    } else {
      assert.equal(r.gate.admitted, 1);
      assert.deepEqual([...r.journal.handoffs().unattempted], [1]);
      assert.equal(r.gate.unresolved, 0, "abandoned, not left open");
    }
  });
}

test("a HEAD response keeps its content-length; a head is flushed before its first body byte", async (t) => {
  const r = await rig(t, {
    gate: { methods: ["GET", "HEAD"] },
    limits: { exchangeMs: 300 },
    respond: (arrival, res) => {
      if (arrival.method === "HEAD") {
        res.writeHead(200, { "content-length": "1234" });
        return res.end();
      }
      res.writeHead(200, { "content-type": "text/plain" });
      res.flushHeaders();
    },
  });
  const head = await exchange(r, `HEAD / HTTP/1.1\r\nHost: ${r.authority}\r\n\r\n`);
  assert.match(head.response, /content-length: 1234/i);
  const stalled = await exchange(r, get(r, "/stall"));
  assert.match(stalled.response, /^HTTP\/1\.1 200/, "the journey sees the head the target sent");
});
