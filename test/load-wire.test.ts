/**
 * The wire with Peeps, over HTTP (e5 plan §4 "load-wire cases", transport half; v2 §4; v3 §2.4
 * and §4). `HttpControlPort` against local HTTPS servers with per-test CAs: one stands in for
 * Peeps' load routes, one for GitHub's OIDC service.
 *
 * The conformance half (shared wire fixtures, byte-identical requests, hash vectors) is A1's,
 * and lands here when P1's fixtures exist. Until then these cases build their answers locally,
 * and the refusal codes the port enumerates are a draft that A1's fixtures replace.
 */
import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer as createTcpServer, type Socket } from "node:net";
import os from "node:os";
import path from "node:path";
import { inspect } from "node:util";
import { sharedClocks } from "../src/load/clocks";
import { canonical, decodeClaimReply, decodeRenewReply, renewBody, type ClaimRequest, type GrantLimits } from "../src/load/control-port";
import { batchHash } from "../src/load/gate/reconcile";
import { ANSWER_MAX_BYTES, CLAIM_ANSWER_MAX_BYTES, CLAIM_RETRY_MS, ControlHttpError, HttpControlPort, type HttpControlSeams } from "../src/load/http-control-port";
import { RunnerLease } from "../src/load/lease";
import { json, jwt, loopbackLookup, startTestServer, type Responder, type TestServer } from "./support/control-server";
import { FakeControlPort } from "./support/fake-control-port";

const REQUEST_TOKEN = `REQTOKEN-${randomBytes(12).toString("hex")}`;
const ID_TOKEN = jwt(`IDTOKEN-${randomBytes(12).toString("hex")}`);
const RUN_TOKEN = `RUNTOKEN-${randomBytes(12).toString("hex")}`;
const EVENTS_TOKEN = `EVTOKEN-${randomBytes(12).toString("hex")}`;
const SENTINELS = [REQUEST_TOKEN, ID_TOKEN, ID_TOKEN.split(".")[2]!, RUN_TOKEN, EVENTS_TOKEN];

const CLAIM: ClaimRequest = {
  protocol: 1,
  actionVersion: "0.0.0-test",
  idempotencyKey: "4b0d5a52-7c1e-4b8f-9e3a-2f6c1d0e9a77",
  runAttempt: 1,
  checkRunId: 42,
  fence: { kind: "netns", probe: { passed: true, failures: [] } },
  checkoutSha: "a".repeat(40),
  lockDigests: { "package-lock.json": "b".repeat(64) },
  treeDigest: "c".repeat(64),
  workload: { path: "peeps/load/smoke.workload.yaml", digest: "d".repeat(64) },
};
const CLAIM_ID = "7d0f6a52-1f1e-4b8e-9a51-3f0b3c1d2e4f";
const GRANT = { claimId: CLAIM_ID, epoch: 1, runToken: RUN_TOKEN, eventsToken: EVENTS_TOKEN };
const RENEW = renewBody({ epoch: 1, seq: 1, nonce: "nonce-é", phase: "starting", debited: 0, unresolved: 0, inFlight: 0, state: "running", lagP99Ms: 0 }).body;
const EVENTS = { streamId: "stream-1", seq: 1, payloadHash: "f".repeat(64), batch: '{"kind":"summary"}' };

interface Harness {
  peeps: TestServer;
  oidc: TestServer;
  port: HttpControlPort;
  seams: HttpControlSeams;
  build(seams?: Partial<HttpControlSeams>): HttpControlPort;
}

/** Peeps answers the grant, `{ok}` to renewals and events; the OIDC service answers `ID_TOKEN`. */
const peepsDefault: Responder = (a, res) => (a.url.endsWith("/claims") ? json(res, 200, GRANT) : json(res, 200, { ok: true, replay: false }));

async function harness(t: TestContext, peepsResponder: Responder = peepsDefault): Promise<Harness> {
  const peeps = await startTestServer("peeps.test", peepsResponder);
  const oidc = await startTestServer("oidc.test", (_a, res) => json(res, 200, { count: 1, value: ID_TOKEN }));
  const seams: HttpControlSeams = { ca: [peeps.caPem, oidc.caPem], lookup: loopbackLookup, oidcHosts: ["oidc.test"] };
  const ports: HttpControlPort[] = [];
  const build = (extra: Partial<HttpControlSeams> = {}) => {
    const p = new HttpControlPort({ peepsUrl: peeps.url, oidc: { requestUrl: `${oidc.url}/_apis/idtoken?api-version=2.0`, requestToken: REQUEST_TOKEN } }, { ...seams, ...extra });
    ports.push(p);
    return p;
  };
  const port = build();
  t.after(async () => {
    for (const p of ports) p.close();
    await peeps.close();
    await oidc.close();
  });
  return { peeps, oidc, port, seams, build };
}

const mono = () => Number(process.hrtime.bigint()) / 1e6;
const signal = (ms = 5000) => AbortSignal.timeout(ms);
const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function failure(p: Promise<unknown>): Promise<ControlHttpError> {
  const error = await p.then(() => undefined, (e: unknown) => e);
  assert.ok(error instanceof ControlHttpError, `expected a ControlHttpError, got ${inspect(error)}`);
  return error;
}

test("the claim mints a peeps-load token once and sends canonical bytes with it", async (t) => {
  const h = await harness(t);
  const answer = await h.port.claim(CLAIM, signal());
  assert.deepEqual(answer, GRANT);
  assert.equal(h.oidc.arrivals.length, 1);
  const mint = h.oidc.arrivals[0]!;
  assert.equal(mint.method, "GET");
  assert.equal(new URL(mint.url, "https://x").searchParams.get("audience"), "peeps-load");
  assert.equal(new URL(mint.url, "https://x").searchParams.get("api-version"), "2.0");
  assert.equal(mint.headers.authorization, `Bearer ${REQUEST_TOKEN}`);
  assert.equal(h.peeps.arrivals.length, 1);
  const sent = h.peeps.arrivals[0]!;
  assert.equal(sent.method, "POST");
  assert.equal(sent.url, "/api/v1/load/claims");
  assert.equal(sent.body, canonical(CLAIM));
  assert.equal(sent.headers.authorization, `Bearer ${ID_TOKEN}`);
  assert.equal(sent.headers["content-type"], "application/json");
  assert.equal(sent.headers["content-length"], String(Buffer.byteLength(sent.body)));
  assert.equal(sent.headers.host, `peeps.test:${h.peeps.port}`);
});

test("a transient claim failure is retried with identical bytes and the same token", async (t) => {
  let n = 0;
  const h = await harness(t, (a, res) => {
    n += 1;
    if (n === 1) return json(res, 503, { error: "deploying" });
    if (n === 2) return void res.socket?.destroy();
    if (n === 3) return void (res.writeHead(502, { "content-type": "text/html" }), res.end("<html>bad gateway</html>"));
    if (n === 4) return json(res, 429, {});
    return json(res, 200, GRANT);
  });
  assert.deepEqual(await h.port.claim(CLAIM, signal()), GRANT);
  assert.equal(h.peeps.arrivals.length, 5);
  for (const a of h.peeps.arrivals) {
    assert.equal(a.body, canonical(CLAIM));
    assert.equal(a.headers.authorization, `Bearer ${ID_TOKEN}`);
  }
  assert.equal(h.oidc.arrivals.length, 1, "minted once");
});

test("the claim stops retrying 4.5 s after the call", async (t) => {
  const h = await harness(t, (_a, res) => json(res, 503, {}));
  const t0 = mono();
  const error = await failure(h.port.claim(CLAIM, signal(30_000)));
  const elapsed = mono() - t0;
  assert.equal(error.code, "status");
  assert.equal(error.status, 503);
  assert.ok(elapsed >= CLAIM_RETRY_MS - 50 && elapsed < CLAIM_RETRY_MS + 400, `stopped after ${elapsed} ms`);
  assert.ok(h.peeps.arrivals.length > 5, "retried");

  // A hung answer: each attempt is cut, and the last ends at the window.
  h.peeps.answer(() => undefined);
  const before = h.peeps.arrivals.length;
  const t1 = mono();
  const hung = await failure(h.port.claim(CLAIM, signal(30_000)));
  const hungElapsed = mono() - t1;
  assert.equal(hung.code, "timeout");
  assert.ok(hungElapsed >= CLAIM_RETRY_MS - 50 && hungElapsed < CLAIM_RETRY_MS + 400, `hung claim stopped after ${hungElapsed} ms`);
  assert.equal(h.peeps.arrivals.length - before, 3, "attempts of 2 s, 2 s and the rest");
});

test("a claim answer read after the 4.5 s window is a timeout, even before the timer fires", async (t) => {
  const h = await harness(t);
  const real = process.hrtime.bigint;
  let skewMs = 0;
  t.mock.method(process.hrtime, "bigint", () => real() + BigInt(skewMs) * 1_000_000n);
  // The monotonic clock moves 3 s while the token is minted and 1.501 s while Peeps answers.
  h.oidc.answer((_a, res) => {
    skewMs += 3_000;
    json(res, 200, { value: ID_TOKEN });
  });
  h.peeps.answer((_a, res) => {
    skewMs += 1_501;
    json(res, 200, GRANT);
  });
  assert.equal((await failure(h.port.claim(CLAIM, signal(30_000)))).code, "timeout");
  assert.equal(h.peeps.arrivals.length, 1, "nothing is sent after the window");
});

test("a permanent claim answer is not retried", async (t) => {
  const h = await harness(t, (_a, res) => json(res, 409, { refused: "rerun" }));
  assert.deepEqual(decodeClaimReply(await h.port.claim(CLAIM, signal())), { ok: false, refused: "rerun" });
  h.peeps.answer((_a, res) => json(res, 401, { refused: "auth" }));
  assert.deepEqual(decodeClaimReply(await h.port.claim(CLAIM, signal())), { ok: false, refused: "auth" });
  h.peeps.answer((_a, res) => (res.writeHead(200, { "content-type": "text/plain" }), res.end("ok")));
  assert.equal((await failure(h.port.claim(CLAIM, signal()))).code, "content_type");
  assert.equal(h.peeps.arrivals.length, 3, "one send each");
});

test("the caller's signal stops the claim at once", async (t) => {
  const h = await harness(t, () => undefined);
  const controller = new AbortController();
  setTimeout(() => controller.abort(), 150);
  const t0 = mono();
  const error = await failure(h.port.claim(CLAIM, controller.signal));
  assert.equal(error.code, "aborted");
  assert.ok(mono() - t0 < 500);
  await wait(300);
  assert.equal(h.peeps.arrivals.length, 1, "nothing is sent after the abort");
});

// The supervisor's retry of a renewal (same bytes after a lost answer) is load-supervisor's "a hung
// renew" case; the port sends what it is given, each time.
test("a renewal sends the given text byte for byte, each time it is called", async (t) => {
  const h = await harness(t);
  await h.port.renew("claim-1", RUN_TOKEN, RENEW, signal());
  await h.port.renew("claim-1", RUN_TOKEN, RENEW, signal());
  assert.equal(h.peeps.arrivals.length, 2);
  for (const a of h.peeps.arrivals) {
    assert.equal(a.method, "POST");
    assert.equal(a.url, "/api/v1/load/claims/claim-1/renew");
    assert.equal(a.body, RENEW);
    assert.equal(a.headers["content-length"], String(Buffer.byteLength(RENEW)));
    assert.equal(a.headers.authorization, `Bearer ${RUN_TOKEN}`);
  }
  assert.equal(h.oidc.arrivals.length, 0, "a renewal mints nothing");
  await h.port.renew("claim/../x", RUN_TOKEN, RENEW, signal());
  assert.equal(h.peeps.arrivals[2]!.url, "/api/v1/load/claims/claim%2F..%2Fx/renew", "the claim id is one path segment");
});

test("events send JSON with the events token, and their answer is reduced to ok or a known reason", async (t) => {
  const h = await harness(t);
  assert.deepEqual(await h.port.events("claim-1", EVENTS_TOKEN, EVENTS, signal()), { ok: true, replay: false });
  const a = h.peeps.arrivals[0]!;
  assert.equal(a.url, "/api/v1/load/claims/claim-1/events");
  assert.equal(a.body, JSON.stringify(EVENTS));
  assert.equal(a.headers.authorization, `Bearer ${EVENTS_TOKEN}`);
  h.peeps.answer((_a, res) => json(res, 200, { ok: true, replay: true, extra: RUN_TOKEN }));
  assert.deepEqual(await h.port.events("claim-1", EVENTS_TOKEN, EVENTS, signal()), { ok: true, replay: true });
  h.peeps.answer((_a, res) => json(res, 200, { ok: false, reason: "conflict" }));
  assert.deepEqual(await h.port.events("claim-1", EVENTS_TOKEN, EVENTS, signal()), { ok: false, reason: "conflict" });
  h.peeps.answer((_a, res) => json(res, 200, { ok: false, reason: EVENTS_TOKEN }));
  assert.deepEqual(await h.port.events("claim-1", EVENTS_TOKEN, EVENTS, signal()), { ok: false, reason: "unknown" });
});

test("a refusal resolves as its code, and one the wire does not name as unknown", async (t) => {
  const h = await harness(t, (_a, res) => json(res, 409, { refused: "gap" }));
  const gap = await h.port.renew("claim-1", RUN_TOKEN, RENEW, signal());
  assert.deepEqual(gap, { refused: "gap" });
  assert.deepEqual(decodeRenewReply(gap), { kind: "unaddressed" });
  h.peeps.answer((_a, res) => json(res, 409, { refused: RUN_TOKEN, detail: RUN_TOKEN }));
  assert.deepEqual(await h.port.renew("claim-1", RUN_TOKEN, RENEW, signal()), { refused: "unknown" });
  h.peeps.answer((_a, res) => json(res, 409, { refused: { nested: true } }));
  assert.deepEqual(await h.port.claim(CLAIM, signal()), { refused: "unknown" });
  // Claim refusals in P1's wire-v1 constants.json.
  for (const refused of ["policy_changed", "outside_harness"]) {
    h.peeps.answer((_a, res) => json(res, 409, { refused }));
    assert.deepEqual(await h.port.claim(CLAIM, signal()), { refused });
  }
});

test("an answer that is not 2xx is a refusal or nothing: a success-shaped 4xx never passes as one", async (t) => {
  const h = await harness(t, (_a, res) => json(res, 403, GRANT));
  assert.deepEqual(await h.port.claim(CLAIM, signal()), { refused: "unknown" });
  const reply = { claimId: CLAIM_ID, epoch: 1, planHash: "p".repeat(64), seq: 1, nonce: "n", lease: "held", ttlMs: 5000, ceiling: 90, leaseUntilServerMs: 1, serverNowMs: 1 };
  h.peeps.answer((_a, res) => json(res, 401, reply));
  assert.deepEqual(decodeRenewReply(await h.port.renew("claim-1", RUN_TOKEN, RENEW, signal())), { kind: "unaddressed" });
  h.peeps.answer((_a, res) => json(res, 401, { ok: true, replay: false }));
  assert.notEqual((await h.port.events("claim-1", EVENTS_TOKEN, EVENTS, signal()) as { ok?: unknown }).ok, true);
  // A refusal at 4xx still resolves as its code.
  h.peeps.answer((_a, res) => json(res, 409, { ok: false, reason: "gap" }));
  assert.deepEqual(await h.port.events("claim-1", EVENTS_TOKEN, EVENTS, signal()), { ok: false, reason: "gap" });
});

test("a grant whose claim id is not a UUID rejects typed, and carries nothing it echoed", async (t) => {
  const h = await harness(t);
  for (const claimId of [ID_TOKEN, `${CLAIM_ID}\n`, "claim-1", 7]) {
    h.peeps.answer((_a, res) => json(res, 200, { ...GRANT, claimId }));
    const error = await failure(h.port.claim(CLAIM, signal()));
    assert.equal(error.code, "malformed");
    assert.ok(!error.transient, "not sent again");
    assert.ok(!inspect(error, { showHidden: true }).includes(ID_TOKEN));
  }
  assert.equal(h.peeps.arrivals.length, 4);
});

test("redirects are never followed", async (t) => {
  const h = await harness(t);
  const elsewhere = await startTestServer("elsewhere.test");
  t.after(() => elsewhere.close());
  const port = h.build({ ca: [h.peeps.caPem, h.oidc.caPem, elsewhere.caPem] });
  for (const status of [301, 302, 303, 307, 308]) {
    const redirect: Responder = (_a, res) => json(res, status, {}, { location: `${elsewhere.url}/api/v1/load/claims` });
    h.peeps.answer(redirect);
    const before = h.peeps.arrivals.length;
    for (const call of [() => port.claim(CLAIM, signal()), () => port.renew("claim-1", RUN_TOKEN, RENEW, signal()), () => port.events("claim-1", EVENTS_TOKEN, EVENTS, signal())]) {
      const error = await failure(call());
      assert.equal(error.code, "redirect");
      assert.equal(error.status, status);
    }
    assert.equal(h.peeps.arrivals.length - before, 3, `${status}: one send per call`);
    h.oidc.answer(redirect);
    assert.equal((await failure(port.claim(CLAIM, signal()))).op, "oidc");
    h.oidc.answer((_a, res) => json(res, 200, { value: ID_TOKEN }));
  }
  assert.equal(elsewhere.arrivals.length, 0);
  assert.equal(elsewhere.stats.connections, 0);
});

test("answers past their cap reject, with or without a declared length", async (t) => {
  const h = await harness(t);
  const padded = (bytes: number) => JSON.stringify({ ...GRANT, plan: { pad: "x".repeat(bytes - JSON.stringify({ ...GRANT, plan: { pad: "" } }).length) } });
  const send = (text: string, declared: boolean): Responder => (_a, res) => {
    res.writeHead(200, { "content-type": "application/json", ...(declared ? { "content-length": String(Buffer.byteLength(text)) } : {}) });
    if (declared) return res.end(text);
    for (let i = 0; i < text.length; i += 65_536) res.write(text.slice(i, i + 65_536));
    res.end();
  };
  for (const declared of [true, false]) {
    h.peeps.answer(send(padded(CLAIM_ANSWER_MAX_BYTES), declared));
    assert.equal(Buffer.byteLength(padded(CLAIM_ANSWER_MAX_BYTES)), CLAIM_ANSWER_MAX_BYTES);
    assert.equal(((await h.port.claim(CLAIM, signal())) as { claimId: string }).claimId, CLAIM_ID, "a plan up to the cap rides in the claim");
    h.peeps.answer(send(padded(CLAIM_ANSWER_MAX_BYTES + 1), declared));
    assert.equal((await failure(h.port.claim(CLAIM, signal()))).code, "too_large");
    h.peeps.answer(send(padded(ANSWER_MAX_BYTES + 1), declared));
    assert.equal((await failure(h.port.renew("claim-1", RUN_TOKEN, RENEW, signal()))).code, "too_large");
    assert.equal((await failure(h.port.events("claim-1", EVENTS_TOKEN, EVENTS, signal()))).code, "too_large");
    h.peeps.answer(send(padded(ANSWER_MAX_BYTES), declared));
    assert.ok(await h.port.renew("claim-1", RUN_TOKEN, RENEW, signal()));
  }
});

test("only a JSON answer below 500 resolves", async (t) => {
  const h = await harness(t);
  const cases: [Responder, string, number | undefined][] = [
    [(_a, res) => (res.writeHead(200, { "content-type": "text/html" }), res.end("<html></html>")), "content_type", 200],
    [(_a, res) => (res.writeHead(200), res.end("{}")), "content_type", 200],
    [(_a, res) => (res.writeHead(200, { "content-type": "application/json" }), res.end("{not json")), "malformed", 200],
    [(_a, res) => json(res, 500, {}), "status", 500],
    [(_a, res) => json(res, 503, {}), "status", 503],
    [(_a, res) => json(res, 408, {}), "status", 408],
    [(_a, res) => json(res, 429, {}), "status", 429],
    [(_a, res) => void res.socket?.destroy(), "network", undefined],
  ];
  for (const [responder, code, status] of cases) {
    h.peeps.answer(responder);
    const error = await failure(h.port.renew("claim-1", RUN_TOKEN, RENEW, signal()));
    assert.equal(error.code, code);
    assert.equal(error.status, status);
    assert.equal(error.transient, code === "status" || code === "network");
  }
  h.peeps.answer((_a, res) => json(res, 404, { error: "not_found" }));
  assert.deepEqual(await h.port.renew("claim-1", RUN_TOKEN, RENEW, signal()), { refused: "unknown" }, "a 4xx without a refusal is an unknown one");
});

test("a token no header can carry, or a claim id no path can, rejects typed before any connection", async (t) => {
  const h = await harness(t);
  const badRequestToken = new HttpControlPort({ peepsUrl: h.peeps.url, oidc: { requestUrl: `${h.oidc.url}/x`, requestToken: `${REQUEST_TOKEN}\r\n` } }, h.seams);
  t.after(() => badRequestToken.close());
  const cases: [string, () => Promise<unknown>][] = [
    ["renew", () => h.port.renew("claim-1", `${RUN_TOKEN}\nx`, RENEW, signal(1000))],
    ["events", () => h.port.events("claim-1", `${EVENTS_TOKEN}\u2603`, EVENTS, signal(1000))],
    ["renew", () => h.port.renew("claim-1\ud800", RUN_TOKEN, RENEW, signal(1000))],
    ["events", () => h.port.events("claim-1\udfff", EVENTS_TOKEN, EVENTS, signal(1000))],
  ];
  for (let i = 0; i < 3; i++) {
    for (const [op, call] of cases) {
      const error = await failure(call());
      assert.equal(error.message, `load control ${op}: malformed`);
      assert.equal(error.cause, undefined);
      for (const sentinel of SENTINELS) assert.ok(!inspect(error, { showHidden: true }).includes(sentinel));
    }
  }
  const oidc = await failure(badRequestToken.claim(CLAIM, signal(1000)));
  assert.equal(oidc.message, "load control oidc: malformed");
  assert.equal(h.peeps.stats.connections + h.oidc.stats.connections, 0, "nothing was opened");
  // Both of the renewals agent's sockets are still free.
  await Promise.all([1, 2].map(() => h.port.renew("claim-1", RUN_TOKEN, RENEW, signal(1000))));
  assert.equal(h.peeps.arrivals.length, 2);
});

test("an abort reason that throws when read still rejects typed", async (t) => {
  const h = await harness(t, () => undefined);
  const hostile = { get name(): string { throw new Error(RUN_TOKEN); } };
  const before = new AbortController();
  before.abort(hostile);
  assert.equal((await failure(h.port.renew("claim-1", RUN_TOKEN, RENEW, before.signal))).message, "load control renew: aborted");
  const during = new AbortController();
  const pending = h.port.renew("claim-1", RUN_TOKEN, RENEW, during.signal);
  await wait(50);
  during.abort(hostile);
  assert.equal((await failure(pending)).message, "load control renew: aborted");
});

test("a hung answer is cut at the signal", async (t) => {
  const h = await harness(t, () => undefined);
  for (const call of [() => h.port.renew("claim-1", RUN_TOKEN, RENEW, signal(200)), () => h.port.events("claim-1", EVENTS_TOKEN, EVENTS, signal(200))]) {
    const t0 = mono();
    const error = await failure(call());
    assert.equal(error.code, "timeout");
    assert.ok(mono() - t0 < 600);
  }
  const controller = new AbortController();
  const pending = h.port.renew("claim-1", RUN_TOKEN, RENEW, controller.signal);
  await wait(50);
  controller.abort();
  assert.equal((await failure(pending)).code, "aborted");
});

test("the claim and 20 renewals share at most 2 TLS sessions; events keep one of their own", async (t) => {
  const h = await harness(t);
  await h.port.claim(CLAIM, signal());
  for (let seq = 1; seq <= 20; seq++) await h.port.renew("claim-1", RUN_TOKEN, RENEW, signal());
  assert.ok(h.peeps.stats.handshakes <= 2, `${h.peeps.stats.handshakes} handshakes`);
  const renewals = h.peeps.stats.handshakes;
  for (let seq = 1; seq <= 5; seq++) await h.port.events("claim-1", EVENTS_TOKEN, { ...EVENTS, seq }, signal());
  assert.equal(h.peeps.stats.handshakes - renewals, 1, "one events connection, kept alive");
  // Two at once: the renewals agent opens a second socket, never a third.
  await Promise.all([1, 2, 3, 4].map(() => h.port.renew("claim-1", RUN_TOKEN, RENEW, signal())));
  assert.ok(h.peeps.stats.handshakes - 1 <= 2);
});

test("Peeps' URL and the OIDC request URL are checked before anything is sent", async (t) => {
  const h = await harness(t);
  const recorder = await startTestServer("evil.test");
  t.after(() => recorder.close());
  const build = (peepsUrl: string, requestUrl: string, oidcHosts?: readonly string[]) => () => new HttpControlPort({ peepsUrl, oidc: { requestUrl, requestToken: REQUEST_TOKEN } }, { ...h.seams, ca: [...h.seams.ca!, recorder.caPem], ...(oidcHosts ? { oidcHosts } : {}) });
  const good = `${h.oidc.url}/idtoken`;
  const refused: [() => HttpControlPort, string][] = [
    [build(`http://peeps.test:${h.peeps.port}`, good), "PEEPS_URL"],
    [build(`https://user:pw@peeps.test:${h.peeps.port}`, good), "PEEPS_URL"],
    [build(`${h.peeps.url}/api`, good), "PEEPS_URL"],
    [build(`${h.peeps.url}/?x=1`, good), "PEEPS_URL"],
    [build("not a url", good), "PEEPS_URL"],
    [build(h.peeps.url, `http://oidc.test:${h.oidc.port}/idtoken`), "ACTIONS_ID_TOKEN_REQUEST_URL"],
    [build(h.peeps.url, `https://u:${REQUEST_TOKEN}@oidc.test:${h.oidc.port}/idtoken`), "ACTIONS_ID_TOKEN_REQUEST_URL"],
    [build(h.peeps.url, `${recorder.url}/idtoken`), "ACTIONS_ID_TOKEN_REQUEST_URL"],
    [build(h.peeps.url, `https://oidc.test.evil.test:${recorder.port}/idtoken`), "ACTIONS_ID_TOKEN_REQUEST_URL"],
    [build(h.peeps.url, "https://actions.githubusercontent.com.evil.test/idtoken", [".actions.githubusercontent.com"]), "ACTIONS_ID_TOKEN_REQUEST_URL"],
    [build(h.peeps.url, "https://evilactions.githubusercontent.com/idtoken", [".actions.githubusercontent.com"]), "ACTIONS_ID_TOKEN_REQUEST_URL"],
    [build(h.peeps.url, "https://actions.githubusercontent.com/idtoken", [".actions.githubusercontent.com"]), "ACTIONS_ID_TOKEN_REQUEST_URL"],
  ];
  for (const [make, which] of refused) {
    assert.throws(make, (e: unknown) => e instanceof ControlHttpError && e.code === "url" && e.detail === which && !inspect(e).includes(REQUEST_TOKEN));
  }
  // The default host set: GitHub-hosted runners' token service.
  assert.doesNotThrow(() => new HttpControlPort({ peepsUrl: "https://app.peepsai.com", oidc: { requestUrl: "https://pipelinesghubeus6.actions.githubusercontent.com/abc/_apis/distributedtask/hubs/Actions/plans/x/jobs/y/idtoken?api-version=2.0", requestToken: REQUEST_TOKEN } }).close());
  assert.doesNotThrow(() => new HttpControlPort({ peepsUrl: "https://app.peepsai.com/", oidc: { requestUrl: "https://run-actions-1-azure-eastus.actions.githubusercontent.com/1/idtoken", requestToken: REQUEST_TOKEN } }).close());
  assert.equal(recorder.stats.connections, 0);
  assert.equal(h.oidc.stats.connections, 0);
  assert.equal(h.peeps.stats.connections, 0);
});

test("the OIDC service's 5xx is retried; a 4xx or an answer without a token fails the claim before Peeps", async (t) => {
  const h = await harness(t);
  let n = 0;
  h.oidc.answer((_a, res) => (++n === 1 ? json(res, 503, {}) : json(res, 200, { value: ID_TOKEN })));
  assert.deepEqual(await h.port.claim(CLAIM, signal()), GRANT);
  assert.equal(h.oidc.arrivals.length, 2);
  assert.equal(h.peeps.arrivals.length, 1);
  const cases: [Responder, string, number | undefined][] = [
    [(_a, res) => json(res, 403, { message: REQUEST_TOKEN }), "status", 403],
    [(_a, res) => json(res, 404, {}), "status", 404],
    [(_a, res) => json(res, 201, { value: ID_TOKEN }), "status", 201],
    [(_a, res) => json(res, 200, { value: "not-a-jwt" }), "malformed", undefined],
    [(_a, res) => json(res, 200, { value: `${ID_TOKEN}.${"x".repeat(9000)}` }), "malformed", undefined],
    // A well-formed token one character past the 8 KiB cap: only the cap refuses it.
    [(_a, res) => json(res, 200, { value: `${"a".repeat(8 * 1024 - 3)}.b.c` }), "malformed", undefined],
    [(_a, res) => json(res, 200, {}), "malformed", undefined],
    [(_a, res) => json(res, 200, { value: "x".repeat(20_000) }), "too_large", 200],
  ];
  for (const [responder, code, status] of cases) {
    h.oidc.answer(responder);
    const before: number = h.oidc.arrivals.length;
    const error = await failure(h.port.claim(CLAIM, signal()));
    assert.equal(h.oidc.arrivals.length - before, 1, `${code} ${status ?? ""}: asked once, not retried`);
    assert.equal(error.op, "oidc");
    assert.equal(error.code, code);
    assert.equal(error.status, status);
  }
  assert.equal(h.peeps.arrivals.length, 1, "nothing reaches Peeps without a token");
  const atCap = `${"a".repeat(8 * 1024 - 4)}.b.c`;
  h.oidc.answer((_a, res) => json(res, 200, { value: atCap }));
  assert.deepEqual(await h.port.claim(CLAIM, signal()), GRANT);
  assert.ok(h.peeps.arrivals[1]!.headers.authorization === `Bearer ${atCap}`, "a token at the cap is sent");
});

test("no token reaches an error, a log or the output", async (t) => {
  const written: string[] = [];
  const restore = [process.stdout, process.stderr].map((stream) => {
    const original = stream.write.bind(stream);
    stream.write = ((chunk: unknown, ...rest: unknown[]) => {
      written.push(String(chunk));
      return (original as (...a: unknown[]) => boolean)(chunk, ...rest);
    }) as typeof stream.write;
    return () => (stream.write = original);
  });
  t.after(() => restore.forEach((r) => r()));
  const h = await harness(t);
  const rogue = await startTestServer("peeps.test");
  t.after(() => rogue.close());
  const untrusted = new HttpControlPort({ peepsUrl: rogue.url, oidc: { requestUrl: `${h.oidc.url}/x`, requestToken: REQUEST_TOKEN } }, h.seams);
  t.after(() => untrusted.close());
  const echo: Responder[] = [
    (a, res) => json(res, 500, { echo: a.headers.authorization, body: a.body }),
    (a, res) => (res.writeHead(400, { "content-type": "text/plain" }), res.end(String(a.headers.authorization))),
    (a, res) => json(res, 302, {}, { location: `https://x.test/${String(a.headers.authorization).replace(/\s/g, "")}` }),
    (a, res) => (res.writeHead(200, { "content-type": "application/json" }), res.end(`{"bad": ${a.headers.authorization}`)),
    (a, res) => json(res, 409, { refused: a.headers.authorization }),
    (a, res) => json(res, 200, { ok: false, reason: a.headers.authorization }),
  ];
  const seen: unknown[] = [];
  const events: unknown[] = [];
  for (const responder of echo) {
    h.peeps.answer(responder);
    seen.push(await h.port.claim(CLAIM, signal()).catch((e: unknown) => e));
    seen.push(await h.port.renew("claim-1", RUN_TOKEN, RENEW, signal()).catch((e: unknown) => e));
    events.push(await h.port.events("claim-1", EVENTS_TOKEN, EVENTS, signal()).catch((e: unknown) => e));
  }
  h.oidc.answer((a, res) => json(res, 403, { message: a.headers.authorization }));
  seen.push(await h.port.claim(CLAIM, signal()).catch((e: unknown) => e));
  seen.push(await untrusted.renew("claim-1", RUN_TOKEN, RENEW, signal()).catch((e: unknown) => e));
  assert.equal((seen.at(-1) as ControlHttpError).code, "network", "an untrusted certificate fails the connection");
  // What resolved is data for the decoders (a grant carries its tokens); a refusal or an events
  // answer is reduced to its code. What rejected, and anything written, is what could be printed.
  const errors = [...seen, ...events].filter((e) => e instanceof Error);
  assert.ok(errors.length >= 10);
  const refusals = [...seen.filter((e) => typeof e === "object" && e !== null && "refused" in e), ...events.filter((e) => !(e instanceof Error))];
  assert.equal(refusals.length, 4);
  const text = [...errors.map((e) => `${e.message}\n${e.stack}\n${inspect(e, { depth: 8, showHidden: true })}\n${JSON.stringify(e)}`), ...refusals.map((r) => JSON.stringify(r)), ...written].join("\n");
  for (const sentinel of SENTINELS) assert.ok(!text.includes(sentinel), `a token leaked: ${sentinel.slice(0, 8)}…`);
  const source = readFileSync(path.resolve(__dirname, "../src/load/http-control-port.ts"), "utf8").replace(/\/\*[\s\S]*?\*\/|^\s*\/\/.*$/gm, "");
  assert.doesNotMatch(source, /console\.|process\.(?:stdout|stderr)|add-mask|::/);
});

test("the job's proxy and TLS environment are ignored", async (t) => {
  const h = await harness(t);
  const rogue = await startTestServer("rogue.test");
  t.after(() => rogue.close());
  let proxied = 0;
  const proxy = createTcpServer((s: Socket) => {
    proxied += 1;
    s.destroy();
  });
  await new Promise<void>((resolve) => proxy.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise<void>((resolve) => proxy.close(() => resolve())));
  const proxyUrl = `http://127.0.0.1:${(proxy.address() as { port: number }).port}`;
  const dir = mkdtempSync(path.join(os.tmpdir(), "peeps-wire-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  writeFileSync(path.join(dir, "extra.pem"), rogue.caPem);
  const config = { peepsUrl: h.peeps.url, rogueUrl: rogue.url, oidcUrl: `${h.oidc.url}/idtoken`, oidcHost: "oidc.test", requestToken: REQUEST_TOKEN, ca: h.seams.ca, claim: CLAIM };
  const env = {
    ...process.env,
    PEEPS_TEST_CHILD_CONFIG: JSON.stringify(config),
    NODE_USE_ENV_PROXY: "1",
    HTTPS_PROXY: proxyUrl,
    https_proxy: proxyUrl,
    HTTP_PROXY: proxyUrl,
    ALL_PROXY: proxyUrl,
    NO_PROXY: "",
    NODE_TLS_REJECT_UNAUTHORIZED: "0",
    NODE_EXTRA_CA_CERTS: path.join(dir, "extra.pem"),
    // The job's TLS defaults: a cipher list no server shares, and TLS 1.2 at most.
    NODE_OPTIONS: "--tls-cipher-list=NOT_A_CIPHER --tls-max-v1.2",
  };
  const { code, stdout, stderr } = await runChild(env);
  assert.equal(code, 0, `child failed: ${stdout}${stderr}`);
  const result = JSON.parse(stdout.trim()) as Record<string, unknown>;
  assert.deepEqual(result, {
    claim: ["claimId", "epoch", "eventsToken", "runToken"],
    renew: { ok: true, keys: ["ok", "replay"] },
    events: { ok: true, keys: ["ok", "replay"] },
    untrusted: { ok: false, code: "network" },
    extraCa: { ok: false, code: "network" },
  });
  assert.equal(proxied, 0, "nothing went through the job's proxy");
  assert.equal(rogue.arrivals.length, 0, "an untrusted certificate is refused despite NODE_TLS_REJECT_UNAUTHORIZED and NODE_EXTRA_CA_CERTS");
  assert.equal(h.oidc.arrivals.length, 1);
  for (const sentinel of SENTINELS) assert.ok(!(stdout + stderr).includes(sentinel));
});

/** Runs `support/http-control-child.ts` with `env`, killed after 20 s so a stuck child fails here. */
async function runChild(env: NodeJS.ProcessEnv): Promise<{ code: number | null; stdout: string; stderr: string }> {
  const child = spawn(process.execPath, ["--import", "tsx", path.resolve(__dirname, "support/http-control-child.ts")], { env, stdio: ["ignore", "pipe", "pipe"], timeout: 20_000 });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (d: Buffer) => (stdout += d));
  child.stderr.on("data", (d: Buffer) => (stderr += d));
  const code = await new Promise<number | null>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", resolve);
  });
  return { code, stdout, stderr };
}

test("Node's diagnostics that would print a request or write TLS keys refuse the port before it connects", async (t) => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "peeps-wire-diag-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const keylog = path.join(dir, "tls-keys");
  const cases: [string, NodeJS.ProcessEnv][] = [
    ["NODE_DEBUG=https", { NODE_DEBUG: "https" }],
    ["NODE_DEBUG, any case, among others", { NODE_DEBUG: "fs,hTtP" }],
    ["NODE_DEBUG=*", { NODE_DEBUG: "*" }],
    ["--tls-keylog", { NODE_OPTIONS: `--tls-keylog=${keylog}` }],
    ["--tls-keylog, quoted", { NODE_OPTIONS: `--t"ls-keylog"="${keylog}"` }],
  ];
  for (const [name, diagnostic] of cases) {
    await t.test(name, async (t) => {
      const h = await harness(t);
      const config = { peepsUrl: h.peeps.url, rogueUrl: h.peeps.url, oidcUrl: `${h.oidc.url}/idtoken`, oidcHost: "oidc.test", requestToken: REQUEST_TOKEN, ca: h.seams.ca, claim: CLAIM };
      const { NODE_DEBUG: _d, NODE_OPTIONS: _o, ...base } = process.env;
      const { code, stdout, stderr } = await runChild({ ...base, ...diagnostic, PEEPS_TEST_CHILD_CONFIG: JSON.stringify(config) });
      for (const sentinel of SENTINELS) assert.ok(!(stdout + stderr).includes(sentinel), `a token was printed: ${sentinel.slice(0, 8)}…`);
      assert.ok(!existsSync(keylog), "no TLS keys were written");
      assert.equal(code, 1, `${stdout}${stderr}`);
      assert.deepEqual(JSON.parse(stdout.trim()), { failed: "diagnostics" });
      assert.equal(h.oidc.stats.connections + h.peeps.stats.connections, 0);
    });
  }
});

test("through the fake Peeps: the grant, renewals and events decode and apply", async (t) => {
  const limits: GrantLimits = { allowedOrigins: ["https://sink.test"], privateOrigins: {}, maxUsers: 1, requestBudget: 1000, policyRevision: 1, phases: { checking: { ratePerSecond: 5, burst: 5 }, measurement: { ratePerSecond: 5, burst: 5 } } };
  const fake = new FakeControlPort({ claimId: CLAIM_ID, plan: { protocolVersion: 1 }, limits, workload: { path: CLAIM.workload.path, digest: CLAIM.workload.digest, module: "journeys.ts", export: "smoke" }, baseURL: "https://sink.test", binding: { checkoutSha: CLAIM.checkoutSha, lockDigests: CLAIM.lockDigests, treeDigest: CLAIM.treeDigest, workload: CLAIM.workload } });
  const h = await harness(t, (a, res) => {
    const m = /^\/api\/v1\/load\/claims(?:\/([^/]+)\/(renew|events))?$/.exec(a.url);
    const bearer = String(a.headers.authorization).replace(/^Bearer /, "");
    const answer = !m ? Promise.resolve({ refused: "malformed" })
      : !m[2] ? (bearer === ID_TOKEN ? fake.claim(JSON.parse(a.body) as ClaimRequest, signal()) : Promise.resolve({ refused: "auth" }))
      : m[2] === "renew" ? fake.renew(decodeURIComponent(m[1]!), bearer, a.body, signal())
      : fake.events(decodeURIComponent(m[1]!), bearer, JSON.parse(a.body), signal());
    void answer.then((body) => json(res, body && typeof body === "object" && "refused" in body ? 409 : 200, body));
  });
  const sent = sharedClocks();
  const reply = decodeClaimReply(await h.port.claim(CLAIM, signal()));
  const received = sharedClocks();
  assert.ok(reply.ok);
  const g = reply.grant;
  assert.equal(g.runToken, fake.runToken);
  const lease = new RunnerLease({ binding: { claimId: g.claimId, epoch: g.epoch, planHash: g.planHash }, nonce: g.lease.nonce, renewEveryMs: g.lease.renewEveryMs, ttlMs: g.lease.ttlMs, ceiling: g.lease.ceiling, leaseUntilServerMs: g.lease.leaseUntilServerMs, serverNowMs: g.lease.serverNowMs }, sent, received);
  for (let i = 0; i < 3; i++) {
    const tx = lease.begin(sharedClocks(), `n-${i}`, (seq, nonce) => renewBody({ epoch: g.epoch, seq, nonce, phase: "starting", debited: i, unresolved: 0, inFlight: 0, state: "running", lagP99Ms: 0 }));
    assert.ok(tx);
    // Sent twice: the retry is the same bytes, and the fake answers it as an exact retry.
    await h.port.renew(g.claimId, g.runToken, tx.body, signal());
    const decoded = decodeRenewReply(await h.port.renew(g.claimId, g.runToken, tx.body, signal()));
    assert.equal(decoded.kind, "reply");
    assert.equal(lease.apply((decoded as { reply: Parameters<RunnerLease["apply"]>[0] }).reply, sharedClocks()).kind, "lease");
  }
  assert.deepEqual(fake.renewals.map((r) => [r.seq, r.refused]), [[1, undefined], [1, undefined], [2, undefined], [2, undefined], [3, undefined], [3, undefined]]);
  const batch = '{"kind":"summary"}';
  const body = { streamId: "stream-1", seq: 1, payloadHash: batchHash({ streamId: "stream-1", seq: 1, payload: batch, final: undefined }), batch };
  assert.deepEqual(await h.port.events(g.claimId, g.eventsToken, body, signal()), { ok: true, replay: false });
  assert.deepEqual(await h.port.events(g.claimId, g.eventsToken, body, signal()), { ok: true, replay: true });
  assert.deepEqual(await h.port.renew(g.claimId, g.eventsToken, tx2(g.epoch), signal()), { refused: "auth" }, "an events token cannot renew");
});

function tx2(epoch: number): string {
  return renewBody({ epoch, seq: 4, nonce: "x", phase: "starting", debited: 3, unresolved: 0, inFlight: 0, state: "running", lagP99Ms: 0 }).body;
}

test("mode: load stays unwired: nothing outside test/ builds the HTTP port yet", () => {
  const src = path.resolve(__dirname, "../src");
  const files = (readdirSync(src, { recursive: true }) as string[]).filter((f) => /\.[cm]?[jt]s$/.test(f) && f !== path.join("load", "http-control-port.ts"));
  assert.ok(files.includes("main.ts") && files.includes(path.join("load", "supervisor.ts")));
  for (const file of files) assert.doesNotMatch(readFileSync(path.join(src, file), "utf8"), /http-control-port|HttpControlPort/, file);
});
