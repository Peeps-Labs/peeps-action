/**
 * The job's identity from its own OIDC token (CW plan §4.4, §6.2): minted for
 * `peeps-load-identity` over the shared transport, read as strings, compared with the job's run,
 * and dropped. The claim still mints its own `peeps-load` token.
 */
import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { randomBytes } from "node:crypto";
import { decodeJobClaims, identityOf, LOAD_IDENTITY_AUDIENCE, readJobIdentity } from "../src/load/oidc";
import { HttpControlPort } from "../src/load/http-control-port";
import type { HttpControlSeams } from "../src/load/transport";
import { json, loopbackLookup, startTestServer, type TestServer } from "./support/control-server";

const REQUEST_TOKEN = `REQTOKEN-${randomBytes(12).toString("hex")}`;
const MARKER = `IDMARKER-${randomBytes(12).toString("hex")}`;

/** The claim set S0 saw from a JS action's token: every id a JSON string. */
const S0_CLAIMS = {
  aud: LOAD_IDENTITY_AUDIENCE,
  check_run_id: "52000000001",
  run_id: "18000000001",
  run_attempt: "1",
  runner_environment: "github-hosted",
  event_name: "workflow_dispatch",
  repository_id: "910000001",
  marker: MARKER,
};

function token(claims: Record<string, unknown>, payload?: string): string {
  const part = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
  return `${part({ alg: "RS256", typ: "JWT" })}.${payload ?? part(claims)}.${Buffer.from(MARKER).toString("base64url")}`;
}

const ENV = { GITHUB_RUN_ID: "18000000001", GITHUB_RUN_ATTEMPT: "1" };

test("decodeJobClaims reads the S0 claim set as strings", () => {
  assert.deepEqual(decodeJobClaims(token(S0_CLAIMS)), {
    checkRunId: "52000000001", runId: "18000000001", runAttempt: "1", runnerEnvironment: "github-hosted", eventName: "workflow_dispatch", repositoryId: "910000001",
  });
});

test("decodeJobClaims refuses a numeric id, a missing claim, a token not in three parts, and a payload past 16 KiB", () => {
  assert.equal(decodeJobClaims(token({ ...S0_CLAIMS, check_run_id: 52000000001 })), null);
  const { check_run_id: _gone, ...missing } = S0_CLAIMS;
  assert.equal(decodeJobClaims(token(missing)), null);
  assert.equal(decodeJobClaims(token(S0_CLAIMS).split(".").slice(0, 2).join(".")), null);
  assert.equal(decodeJobClaims(`${token(S0_CLAIMS)}.x`), null);
  assert.equal(decodeJobClaims(token({ ...S0_CLAIMS, pad: "x".repeat(17 * 1024) })), null);
  assert.equal(decodeJobClaims(token({}, "not json!")), null);
  assert.equal(decodeJobClaims(token({}, Buffer.from("[1,2]").toString("base64url"))), null);
});

test("identityOf compares the token with the run: id, attempt, event, then the runner", () => {
  const read = (over: Record<string, unknown>) => identityOf(decodeJobClaims(token({ ...S0_CLAIMS, ...over })), ENV);
  assert.deepEqual(read({}), { ok: true, checkRunId: 52000000001, runAttempt: 1 });
  assert.deepEqual(read({ run_id: "18000000002" }), { ok: false, refused: "identity" });
  assert.deepEqual(read({ run_attempt: "2" }), { ok: false, refused: "identity" });
  assert.deepEqual(read({ event_name: "push" }), { ok: false, refused: "identity" });
  for (const id of ["0", "012", "99999999999999999999", "1.5", ""]) assert.deepEqual(read({ check_run_id: id }), { ok: false, refused: "identity" }, id);
  assert.deepEqual(read({ check_run_id: "9007199254740993" }), { ok: false, refused: "identity" }, "not a safe integer");
  assert.deepEqual(read({ runner_environment: "self-hosted" }), { ok: false, refused: "self_hosted" });
  assert.deepEqual(identityOf(null, ENV), { ok: false, refused: "identity" });
});

interface Oidc {
  server: TestServer;
  seams: HttpControlSeams;
  requestUrl: string;
  audiences: string[];
}

async function oidcServer(t: TestContext, answer: () => string = () => token(S0_CLAIMS)): Promise<Oidc> {
  const audiences: string[] = [];
  const server = await startTestServer("oidc.test", (a, res) => {
    audiences.push(new URL(a.url, "https://oidc.test").searchParams.get("audience") ?? "");
    json(res, 200, { count: 1, value: answer() });
  });
  t.after(() => server.close());
  return { server, audiences, seams: { ca: [server.caPem], lookup: loopbackLookup, oidcHosts: [`oidc.test:${server.port}`] }, requestUrl: `${server.url}/_apis/idtoken?api-version=2.0` };
}

test("readJobIdentity mints one token for peeps-load-identity with the request token; the claim later mints peeps-load", async (t) => {
  const o = await oidcServer(t);
  const id = await readJobIdentity({ requestUrl: o.requestUrl, requestToken: REQUEST_TOKEN }, ENV, o.seams);
  assert.deepEqual(id, { ok: true, checkRunId: 52000000001, runAttempt: 1 });
  assert.deepEqual(o.audiences, ["peeps-load-identity"]);
  assert.equal(o.server.arrivals[0]!.headers.authorization, `Bearer ${REQUEST_TOKEN}`);
  assert.ok(!JSON.stringify(id).includes(MARKER), "the token is dropped");

  const peeps = await startTestServer("peeps.test", (_a, res) => json(res, 200, { refused: "grant" }));
  t.after(() => peeps.close());
  const port = new HttpControlPort({ peepsUrl: peeps.url, oidc: { requestUrl: o.requestUrl, requestToken: REQUEST_TOKEN } }, { ...o.seams, ca: [o.server.caPem, peeps.caPem] });
  t.after(() => port.close());
  await port.claim({} as never, AbortSignal.timeout(5_000)).catch(() => undefined);
  assert.deepEqual(o.audiences, ["peeps-load-identity", "peeps-load"]);
});

test("a token naming another run or a self-hosted runner is refused; a failed mint is a failure, not a refusal", async (t) => {
  for (const [over, expected] of [
    [{ run_id: "1" }, { ok: false, refused: "identity" }],
    [{ event_name: "push" }, { ok: false, refused: "identity" }],
    [{ runner_environment: "self-hosted" }, { ok: false, refused: "self_hosted" }],
  ] as const) {
    const o = await oidcServer(t, () => token({ ...S0_CLAIMS, ...over }));
    assert.deepEqual(await readJobIdentity({ requestUrl: o.requestUrl, requestToken: REQUEST_TOKEN }, ENV, o.seams), expected);
  }
  const o = await oidcServer(t);
  o.server.answer((_a, res) => json(res, 403, { message: "no" }));
  assert.deepEqual(await readJobIdentity({ requestUrl: o.requestUrl, requestToken: REQUEST_TOKEN }, ENV, o.seams), { ok: false, failed: "oidc" });
  assert.deepEqual(await readJobIdentity({ requestUrl: "https://attacker.example.com/idtoken", requestToken: REQUEST_TOKEN }, ENV, o.seams), { ok: false, failed: "oidc" });
});

test("the identity mint goes through the hardened transport: the job's proxy is ignored and a redirect is never followed", async (t) => {
  const proxyHits: string[] = [];
  const proxy = createServer((req, res) => {
    proxyHits.push(String(req.url));
    res.writeHead(502).end();
  });
  proxy.on("connect", (req, socket) => {
    proxyHits.push(`CONNECT ${req.url}`);
    socket.destroy();
  });
  await new Promise<void>((resolve) => proxy.listen(0, "127.0.0.1", resolve));
  t.after(() => proxy.close());
  const o = await oidcServer(t);
  const saved = { HTTPS_PROXY: process.env.HTTPS_PROXY, https_proxy: process.env.https_proxy, NODE_USE_ENV_PROXY: process.env.NODE_USE_ENV_PROXY };
  process.env.HTTPS_PROXY = process.env.https_proxy = `http://127.0.0.1:${(proxy.address() as AddressInfo).port}`;
  process.env.NODE_USE_ENV_PROXY = "1";
  try {
    assert.equal((await readJobIdentity({ requestUrl: o.requestUrl, requestToken: REQUEST_TOKEN }, ENV, o.seams)).ok, true);
  } finally {
    for (const [k, v] of Object.entries(saved)) if (v === undefined) delete process.env[k]; else process.env[k] = v;
  }
  assert.deepEqual(proxyHits, []);

  const elsewhere = await startTestServer("elsewhere.test", (_a, res) => json(res, 200, { value: token(S0_CLAIMS) }));
  t.after(() => elsewhere.close());
  o.server.answer((_a, res) => {
    res.writeHead(302, { location: `${elsewhere.url}/idtoken` });
    res.end();
  });
  assert.deepEqual(await readJobIdentity({ requestUrl: o.requestUrl, requestToken: REQUEST_TOKEN }, ENV, { ...o.seams, ca: [o.server.caPem, elsewhere.caPem] }), { ok: false, failed: "oidc" });
  assert.deepEqual(elsewhere.arrivals, []);
});

test("an untrusted certificate is refused: only the transport's roots are trusted", async (t) => {
  const o = await oidcServer(t);
  const other = await startTestServer("other.test");
  t.after(() => other.close());
  assert.deepEqual(await readJobIdentity({ requestUrl: o.requestUrl, requestToken: REQUEST_TOKEN }, ENV, { ...o.seams, ca: [other.caPem] }), { ok: false, failed: "oidc" });
  assert.deepEqual(o.server.arrivals, []);
});
