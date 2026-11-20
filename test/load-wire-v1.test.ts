/**
 * The control wire's shared corpus, wire-v1 (e5 plan v3, A1). Peeps owns it
 * (`src/server/load-testing/protocol/__fixtures__/wire-v1/`, run through Peeps' own decide
 * functions by its `wire-corpus.test.ts`); `test/fixtures/load-wire/v1/` is a byte-for-byte copy,
 * pinned by the same root hash: the sha256 of MANIFEST without its first, status, line, so A5's
 * freeze does not change it. Editing the copy fails here.
 *
 * Every vector the runner can produce or read runs through the action's own production code: the
 * canonical JSON and the renew, batch and plan hashes; the strict claim body (built by `claimBody`,
 * checked by `claimBodyProblem`, which refuses exactly the bodies Peeps refuses for their shape);
 * every whole grant through `decodeClaimReply` and prepare's checks; every `phase-caps.json`
 * vector through `engineBudgets` and `runLimits`; every renew reply and `closed` receipt through
 * `decodeRenewReply` and `decodeClosedReceipt`; and the claim, renew and events requests (built by
 * `claimBody`, `renewBody` and `eventsBody`) and every refusal code and events answer through the
 * HTTP port, byte for byte. Request bytes the runner cannot produce (Peeps' parser vectors) are
 * Peeps' corpus tests' business; here only their refusal replies apply.
 */
import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

import { claimBody, claimBodyProblem, hostLabels } from "../src/load/claim-body";
import { canonical, decodeClaimReply, decodeClosedReceipt, decodeRenewReply, planHashOf, PROTOCOL, renewBody, sha256, type ClaimRequest, type EventsBody, type Grant, type RenewFields } from "../src/load/control-port";
import { engineBudgets, OUTSTANDING_PER_TURN, runLimits } from "../src/load/engine-limits";
import { batchHash, eventsBody } from "../src/load/gate/reconcile";
import { HttpControlPort } from "../src/load/http-control-port";
import { MAX_REMAINING_MS } from "../src/load/lease";
import { validatePlanInput, type PlanInput } from "../src/load/plan-input";
import { SUPERVISOR_CONSTANTS } from "../src/load/supervisor";
import { CLAIM_BODY_MAX_BYTES, CLAIM_REFUSALS, EVENTS_BATCH_MAX_BYTES, EVENTS_BODY_MAX_BYTES, EVENTS_REFUSALS, PHASES, RENEW_BODY_MAX_BYTES, RENEW_REFUSALS, STOP_REASONS } from "../src/load/wire";
import { json, jwt, loopbackLookup, startTestServer, type Responder, type TestServer } from "./support/control-server";

/** sha256 of `wire-v1/MANIFEST` without its status line; the same constant as peeps' `wire-corpus.test.ts`. */
const WIRE_V1_ROOT_HASH = "82eaf59837eeb778619861d9d3857f0b0533f2237bd00525568f4a3f99627b97";
/** The peeps commit the copy came from (peeps #3238). */
const PEEPS_COMMIT = "b0b17c3e5709776fa95ccc806df79e132ffb5751";

const dir = path.resolve(__dirname, "fixtures/load-wire/v1");
const common = path.resolve(__dirname, "fixtures/load-plans/v1/common");
const read = <T>(file: string): T => JSON.parse(readFileSync(path.join(dir, file), "utf8")) as T;
const readCommon = <T>(file: string): T => JSON.parse(readFileSync(path.join(common, file), "utf8")) as T;
const hex = (bytes: Buffer | string) => createHash("sha256").update(bytes).digest("hex");

type BodySpec = { json: unknown } | { text: string } | { base64: string } | { fill: { envelope: Record<string, unknown>; char: string; count: number } };
function bytesOf(spec: BodySpec): Uint8Array {
  if ("json" in spec) return new TextEncoder().encode(JSON.stringify(spec.json));
  if ("text" in spec) return new TextEncoder().encode(spec.text);
  if ("base64" in spec) return new Uint8Array(Buffer.from(spec.base64, "base64"));
  return new TextEncoder().encode(JSON.stringify({ ...spec.fill.envelope, batch: spec.fill.char.repeat(spec.fill.count) }));
}

interface ClaimLeaseWire { seq: 0; nonce: string; ttlMs: number; renewEveryMs: number; ceiling: number; leaseUntilServerMs: number; serverNowMs: number }
type GrantWire = Grant;
interface ClaimFile {
  request: ClaimRequest;
  cases: {
    name: string;
    body?: BodySpec;
    requestPatch?: Partial<ClaimRequest>;
    expect: { refused: string } | { granted: { replay: boolean; lease: ClaimLeaseWire; hardEndServerMs: number; binding: Grant["binding"] } };
  }[];
}
type RenewExpect = { refused: string } | { reply: Record<string, unknown> } | { receipt: string };
interface RenewFile {
  cases: { name: string; steps: ({ stamp: { mode: string; reason: string } } | { stamp?: undefined; fields?: RenewFields; body: string | BodySpec; expect: RenewExpect })[] }[];
}
interface EventsFile {
  cases: { name: string; steps: { body: BodySpec; expect: { ok: true; replay: boolean } | { ok: false; reason: string } }[] }[];
}

// ---------------------------------------------------------------- the copy

test("the copy matches peeps' pinned root hash, which leaves out the status line", () => {
  const manifest = readFileSync(path.join(dir, "MANIFEST"), "utf8");
  assert.match(manifest.slice(0, manifest.indexOf("\n")), /^status: (draft|frozen)$/);
  assert.equal(hex(manifest.slice(manifest.indexOf("\n") + 1)), WIRE_V1_ROOT_HASH);
});

test("the corpus is a draft until the action turns load on (A5)", () => {
  assert.equal(readFileSync(path.join(dir, "MANIFEST"), "utf8").split("\n")[0], "status: draft");
});

test("MANIFEST lists every file with its sha256, and nothing else", () => {
  const listed = readFileSync(path.join(dir, "MANIFEST"), "utf8").trimEnd().split("\n").slice(1).map((line) => line.split(/\s+/));
  const files = readdirSync(dir).filter((f) => f !== "MANIFEST").sort();
  assert.deepEqual(listed.map(([, file]) => file), files);
  for (const [hash, file] of listed) assert.equal(hex(readFileSync(path.join(dir, file!))), hash, file);
});

test("the copy records the peeps commit and root hash it came from", () => {
  const source = readFileSync(path.resolve(dir, "../SOURCE"), "utf8");
  assert.match(source, new RegExp(`commit:\\s+${PEEPS_COMMIT}`));
  assert.match(source, new RegExp(WIRE_V1_ROOT_HASH));
});

// ---------------------------------------------------------------- constants and hashes

test("the action's wire numbers and vocabularies are constants.json's", () => {
  const c = read<{ protocol: number; bytes: Record<string, number>; lease: Record<string, number>; refusals: Record<string, string[]>; stopReasons: string[]; phases: string[] }>("constants.json");
  assert.equal(c.protocol, PROTOCOL);
  assert.deepEqual(c.bytes, { claimBody: CLAIM_BODY_MAX_BYTES, renewBody: RENEW_BODY_MAX_BYTES, eventsBody: EVENTS_BODY_MAX_BYTES, eventsBatch: EVENTS_BATCH_MAX_BYTES });
  assert.equal(SUPERVISOR_CONSTANTS.maxEventsBodyBytes, c.bytes.eventsBody);
  assert.equal(SUPERVISOR_CONSTANTS.maxBatchBytes, c.bytes.eventsBatch);
  assert.equal(MAX_REMAINING_MS, c.lease.maxRemainingMs);
  assert.deepEqual(c.refusals, { claim: [...CLAIM_REFUSALS], renew: [...RENEW_REFUSALS], events: [...EVENTS_REFUSALS] });
  assert.deepEqual(c.stopReasons, [...STOP_REASONS]);
  assert.deepEqual(c.phases, [...PHASES]);
});

test("every canonical, renew, batch and plan hash vector", () => {
  const h = read<{
    canonical: { name: string; value: unknown; canonical: string; sha256: string }[];
    renew: { fields: RenewFields; requestHash: string; body: string }[];
    batch: { streamId: string; seq: number; batch: string; final?: { watermark: number }; hash: string }[];
    plans: { name: string; planHash: string }[];
  }>("hashes.json");
  for (const v of h.canonical) {
    assert.equal(canonical(v.value), v.canonical, v.name);
    assert.equal(sha256(canonical(v.value)), v.sha256, v.name);
  }
  for (const v of h.renew) assert.deepEqual(renewBody(v.fields), { requestHash: v.requestHash, body: v.body });
  for (const v of h.batch) assert.equal(batchHash({ streamId: v.streamId, seq: v.seq, payload: v.batch, final: v.final }), v.hash);
  for (const v of h.plans) assert.equal(planHashOf(readCommon(`${v.name}.plan.json`)), v.planHash, v.name);
});

// ---------------------------------------------------------------- grants

test("every whole grant decodes, and passes prepare's plan, hash, limits and base URL checks", () => {
  const { cases } = read<{ cases: { name: string; grant: GrantWire }[] }>("grant-accepts.json");
  assert.deepEqual(cases.map((c) => c.name), ["starter", "spec-example", "monorepo"]);
  for (const { name, grant } of cases) {
    const reply = decodeClaimReply(grant);
    assert.ok(reply.ok, name);
    assert.deepEqual(reply.grant, grant, `${name}: decoded unchanged`);
    const g = reply.grant;
    const input = validatePlanInput({ plan: g.plan, limits: { allowedOrigins: g.limits.allowedOrigins, maxUsers: g.limits.maxUsers, requestBudget: g.limits.requestBudget, policyRevision: g.limits.policyRevision } });
    assert.ok(input.ok, `${name}: ${JSON.stringify(!input.ok && input.errors)}`);
    assert.equal(planHashOf(input.value.plan), g.planHash, name);
    const limits = runLimits(input.value, g.limits, { parallel: OUTSTANDING_PER_TURN });
    assert.ok(limits.ok, `${name}: ${JSON.stringify(!limits.ok && limits)}`);
    const base = new URL(g.baseURL);
    assert.equal(base.protocol, "https:");
    assert.ok(limits.value.approved.has(`${base.protocol}//${base.host}`.replace(/:443$/, "")), name);
  }
});

test("every phase-caps vector: the engine's own phase numbers are Peeps', the grant carries them, and the gate runs them", () => {
  const { cases } = read<{ cases: (PlanInput & { name: string; phases: Grant["limits"]["phases"]; requestBudget: number; allowance: number; maxRunMs: number })[] }>("phase-caps.json");
  const grants = read<{ cases: { name: string; grant: GrantWire }[] }>("grant-accepts.json").cases;
  assert.deepEqual(cases.map((c) => c.name), grants.map((g) => g.name), "one whole grant per phase-caps vector");
  for (const { name, plan, limits, phases, requestBudget, allowance, maxRunMs } of cases) {
    assert.deepEqual(plan, readCommon(`${name}.plan.json`), `${name}: the corpus plan`);
    const input = validatePlanInput({ plan, limits });
    assert.ok(input.ok, `${name}: ${JSON.stringify(!input.ok && input.errors)}`);
    const budgets = engineBudgets(input.value);
    for (const phase of ["checking", "measurement"] as const) {
      const { ratePerSecond, burst, users, totalRequests } = budgets[phase];
      assert.deepEqual({ ratePerSecond, burst, maxUsers: users, total: totalRequests }, phases[phase], `${name}: ${phase}`);
    }
    const reply = decodeClaimReply(grants.find((c) => c.name === name)!.grant);
    assert.ok(reply.ok, name);
    const grant = reply.grant;
    assert.deepEqual(grant.limits.phases, phases, `${name}: the grant's phases`);
    assert.equal(grant.limits.requestBudget, requestBudget, name);
    assert.equal(grant.lease.ceiling, allowance, name);
    assert.equal(grant.maxRunMs, maxRunMs, name);
    // As prepare reads the grant: its plan against its own limits (the vector's requestBudget is
    // the plan's ceiling; the grant's adds Checking's total).
    const granted = validatePlanInput({ plan: grant.plan, limits: { allowedOrigins: grant.limits.allowedOrigins, maxUsers: grant.limits.maxUsers, requestBudget: grant.limits.requestBudget, policyRevision: grant.limits.policyRevision } });
    assert.ok(granted.ok, name);
    const gate = runLimits(granted.value, grant.limits, { parallel: OUTSTANDING_PER_TURN });
    assert.ok(gate.ok, name);
    assert.deepEqual({ checking: gate.value.checking, measurement: gate.value.measurement }, phases, `${name}: the gate runs Peeps' caps`);
    assert.equal(gate.value.gate.runTotal, requestBudget, name);
  }
});

test("a grant whose binding is not P1's shape is malformed", () => {
  const { grant } = read<{ cases: { grant: GrantWire }[] }>("grant-accepts.json").cases[0]!;
  const b = grant.binding;
  const variants: [string, unknown][] = [
    ["the old two-file lockDigests", { ...b, lockDigests: { ...b.lockDigests, "node_modules/.package-lock.json": b.observed.generatedLockDigest } }],
    ["a top-level treeDigest", { checkoutSha: b.checkoutSha, lockDigests: b.lockDigests, treeDigest: b.observed.treeDigest, workload: b.workload }],
    ["no observed", { checkoutSha: b.checkoutSha, lockDigests: b.lockDigests, workload: b.workload }],
    ["an unknown key", { ...b, extra: 1 }],
    ["an unknown observed key", { ...b, observed: { ...b.observed, extra: "x" } }],
    ["a digest that is not sha256 hex", { ...b, observed: { ...b.observed, treeDigest: "T".repeat(64) } }],
    ["a checkout that is not a commit", { ...b, checkoutSha: "main" }],
  ];
  for (const [name, binding] of variants) assert.deepEqual(decodeClaimReply({ ...grant, binding }), { ok: false, refused: "malformed" }, name);
});

// ---------------------------------------------------------------- the claim body

const claim = read<ClaimFile>("claim.json");
const LABELS = { image: claim.request.fence.probe.image, kernel: claim.request.fence.probe.kernel, tools: claim.request.fence.probe.tools, chrony: claim.request.fence.probe.chrony };

function inputsOf(r: ClaimRequest) {
  return {
    grantRef: r.grantRef,
    actionVersion: r.actionVersion,
    idempotencyKey: r.idempotencyKey,
    runAttempt: r.runAttempt,
    checkRunId: r.checkRunId,
    binding: { checkoutSha: r.checkoutSha, lockDigests: r.lockDigests, observed: r.observed, workload: r.workload },
    probe: { passed: r.fence.probe.passed, failures: r.fence.probe.failures },
    labels: { image: r.fence.probe.image, kernel: r.fence.probe.kernel, tools: r.fence.probe.tools, chrony: r.fence.probe.chrony },
  };
}

test("the strict mapper rebuilds the corpus's claim byte for byte", () => {
  const built = claimBody(inputsOf(claim.request));
  assert.ok(built.ok, JSON.stringify(built));
  assert.equal(canonical(built.body), canonical(claim.request));
  assert.deepEqual(Object.keys(built.body).sort(), Object.keys(claim.request).sort());
});

for (const x of claim.cases) {
  test(`claim vector: ${x.name}`, () => {
    if (x.body) {
      // Peeps refuses these bytes for their shape: the action's check refuses them before sending.
      assert.ok("refused" in x.expect && (x.expect.refused === "malformed" || x.expect.refused === "unsupported_protocol"));
      const problem = claimBodyProblem(bytesOf(x.body));
      assert.ok(problem !== undefined, "refused by the action too");
      assert.equal(problem === "unsupported_protocol", x.expect.refused === "unsupported_protocol");
      return;
    }
    // Every other answer is Peeps' to decide: the body is well formed, and the mapper builds it.
    const request = { ...claim.request, ...x.requestPatch } as ClaimRequest;
    assert.equal(claimBodyProblem(JSON.stringify(request)), undefined);
    const built = claimBody(inputsOf(request));
    assert.ok(built.ok, JSON.stringify(built));
    assert.equal(canonical(built.body), canonical(request));
    if ("granted" in x.expect) {
      // The granted lease and binding decode, and the binding is the one the body claimed.
      const whole = read<{ cases: { grant: GrantWire }[] }>("grant-accepts.json").cases[0]!.grant;
      const reply = decodeClaimReply({ ...whole, lease: x.expect.granted.lease, hardEndServerMs: x.expect.granted.hardEndServerMs, binding: x.expect.granted.binding });
      assert.ok(reply.ok);
      assert.deepEqual(reply.grant.lease, x.expect.granted.lease);
      assert.deepEqual(reply.grant.binding, { checkoutSha: request.checkoutSha, lockDigests: request.lockDigests, observed: request.observed, workload: request.workload });
    }
  });
}

test("the mapper refuses, by field name, a body Peeps' schema would refuse, and never sends it", () => {
  const base = inputsOf(claim.request);
  const bad: [string, Partial<typeof base>, string][] = [
    ["no grant reference", { grantRef: "" }, "grantRef"],
    ["an idempotency key that is not a UUID v4", { idempotencyKey: "k1" }, "idempotencyKey"],
    ["no package-lock.json digest", { binding: { ...base.binding, lockDigests: { "package-lock.json": "" } } }, "lockDigests.package-lock.json"],
    ["no generated lock digest", { binding: { ...base.binding, observed: { ...base.binding.observed, generatedLockDigest: "" } } }, "observed.generatedLockDigest"],
    ["attempt 0", { runAttempt: 0 }, "runAttempt"],
    ["an action version too long", { actionVersion: "v".repeat(65) }, "actionVersion"],
  ];
  for (const [name, patch, field] of bad) assert.deepEqual(claimBody({ ...base, ...patch }), { ok: false, problem: field }, name);
  // Probe text the schema bounds is clipped, not refused: whole characters only.
  const long = claimBody({ ...base, probe: { passed: true, failures: Array.from({ length: 25 }, () => "é😀".repeat(200)) }, labels: { ...LABELS, image: "😀".repeat(100) } });
  assert.ok(long.ok, JSON.stringify(long));
  assert.equal(long.body.fence.probe.failures.length, 20);
  assert.ok(long.body.fence.probe.failures.every((f) => f.length <= 256 && !/[\uD800-\uDBFF]$/.test(f)));
  assert.equal(long.body.fence.probe.image, "😀".repeat(64));
});

test("the probe labels come from the image, the kernel, the fence's tools and chrony, and never fail", async () => {
  const out: Record<string, string> = {
    "/usr/bin/systemd-run": "systemd 255 (255.4-1ubuntu8.4)\n+PAM +AUDIT\n",
    "/usr/bin/unshare": "unshare from util-linux 2.39.3\n",
    "/usr/bin/chronyc": "Reference ID    : A9FEA97B (169.254.169.123)\nSystem time     : 0.000021000 seconds fast of NTP time\nLeap status     : Normal\n",
  };
  const labels = await hostLabels({ ImageOS: "ubuntu24", ImageVersion: "20261116.376.1" }, async (file) => out[file]);
  assert.equal(labels.image, "ubuntu24 20261116.376.1");
  assert.equal(labels.tools, "systemd 255 (255.4-1ubuntu8.4); unshare from util-linux 2.39.3");
  assert.equal(labels.chrony, "normal, 0.000021000 seconds fast of NTP time");
  assert.ok(labels.kernel.length > 0);
  assert.deepEqual(await hostLabels({}, async () => undefined), { image: "unknown", kernel: labels.kernel, tools: "unavailable; unavailable", chrony: "unavailable" });
  const real = await hostLabels({});
  for (const k of ["image", "kernel", "tools", "chrony"] as const) assert.equal(typeof real[k], "string");
});

// ---------------------------------------------------------------- renewals

const renew = read<RenewFile>("renew.json");

for (const x of renew.cases) {
  test(`renew vector: ${x.name}`, () => {
    for (const step of x.steps) {
      if (step.stamp) continue;
      if (step.fields && !("extra" in step.fields)) {
        const made = renewBody(step.fields);
        assert.equal(made.body, step.body, "renewBody makes the exact bytes");
        assert.ok(Buffer.byteLength(made.body) <= RENEW_BODY_MAX_BYTES);
      }
      const e = step.expect;
      if ("reply" in e) {
        const d = decodeRenewReply(e.reply);
        assert.equal(d.kind, "reply");
        assert.deepEqual(d.kind === "reply" && d.reply, e.reply, "decoded unchanged, stop included");
        assert.equal(decodeClosedReceipt(e.reply), undefined, "a reply is not a receipt");
      } else if ("receipt" in e) {
        const raw = JSON.parse(e.receipt) as Record<string, unknown>;
        assert.equal(canonical(raw), e.receipt, "the receipt is canonical text");
        assert.deepEqual(decodeClosedReceipt(raw), { claimId: raw.claimId, epoch: raw.epoch, planHash: raw.planHash, seq: raw.seq, nonce: raw.nonce, closed: true });
      } else {
        assert.ok((RENEW_REFUSALS as readonly string[]).includes(e.refused), e.refused);
        assert.deepEqual(decodeRenewReply({ refused: e.refused }), { kind: "unaddressed" });
      }
    }
  });
}

test("a stop reason outside the six makes the reply unreadable: the lease reads lost, with no stop", () => {
  const stopped = renew.cases.flatMap((c) => c.steps).map((s) => ("expect" in s && s.expect && "reply" in s.expect ? s.expect.reply : undefined)).find((r) => r?.stop !== undefined)!;
  for (const reason of STOP_REASONS) {
    const d = decodeRenewReply({ ...stopped, stop: { mode: "graceful", reason } });
    assert.deepEqual(d.kind === "reply" && d.reply.stop, { mode: "graceful", reason }, reason);
  }
  for (const reason of ["owner", "", "USER_STOP", "user_stop ", 7, null, undefined, { a: 1 }]) {
    const d = decodeRenewReply({ ...stopped, lease: "held", stop: { mode: "graceful", reason } });
    assert.equal(d.kind, "reply");
    assert.equal(d.kind === "reply" && d.reply.lease, "lost", String(reason));
    assert.equal(d.kind === "reply" && d.reply.stop, undefined, String(reason));
  }
});

// ---------------------------------------------------------------- through the HTTP port

async function port(t: TestContext, responder: Responder): Promise<{ port: HttpControlPort; peeps: TestServer }> {
  const peeps = await startTestServer("peeps.test", responder);
  const oidc = await startTestServer("oidc.test", (_a, res) => json(res, 200, { value: jwt("IDTOKEN") }));
  const p = new HttpControlPort({ peepsUrl: peeps.url, oidc: { requestUrl: `${oidc.url}/idtoken`, requestToken: "REQ" } }, { ca: [peeps.caPem, oidc.caPem], lookup: loopbackLookup, oidcHosts: [`oidc.test:${oidc.port}`] });
  t.after(async () => {
    p.close();
    await peeps.close();
    await oidc.close();
  });
  return { port: p, peeps };
}
const signal = () => AbortSignal.timeout(5000);
const CLAIM_ID = "7d0f6a52-1f1e-4b8e-9a51-3f0b3c1d2e4f";

test("every claim refusal code passes through the port and the decoder; any other reads unknown", async (t) => {
  const request = claimBody(inputsOf(claim.request));
  assert.ok(request.ok);
  let answer: unknown;
  const h = await port(t, (_a, res) => json(res, 409, answer));
  for (const refused of CLAIM_REFUSALS) {
    answer = { refused };
    const got = await h.port.claim(request.body, signal());
    assert.deepEqual(got, { refused });
    assert.deepEqual(decodeClaimReply(got), { ok: false, refused });
  }
  for (const refused of ["matrix", "owner", "Rerun"]) {
    answer = { refused };
    const got = await h.port.claim(request.body, signal());
    assert.deepEqual(got, { refused: "unknown" }, refused);
    assert.deepEqual(decodeClaimReply(got), { ok: false, refused: "unknown" });
  }
  // A renew code is a refusal the port names, but never a claim's.
  answer = { refused: "gap" };
  assert.deepEqual(decodeClaimReply(await h.port.claim(request.body, signal())), { ok: false, refused: "unknown" });
  assert.equal(h.peeps.arrivals[0]!.body, canonical(claim.request), "the port sends the canonical body");
});

test("each well-formed claim vector sends its mapped request and decodes its reply", async (t) => {
  let answer: { status: number; body: unknown } = { status: 200, body: {} };
  const h = await port(t, (_a, res) => json(res, answer.status, answer.body));
  const { grant } = read<{ cases: { grant: GrantWire }[] }>("grant-accepts.json").cases[0]!;
  for (const vector of claim.cases) {
    if (vector.body) continue; // Claim parser vectors are covered above without a network request.
    const expected = { ...claim.request, ...vector.requestPatch } as ClaimRequest;
    const request = claimBody(inputsOf(expected));
    assert.ok(request.ok, vector.name);
    if ("granted" in vector.expect) {
      const { lease, hardEndServerMs, binding } = vector.expect.granted;
      answer = { status: 200, body: { ...grant, lease, hardEndServerMs, binding } };
    } else {
      answer = { status: 409, body: vector.expect };
    }
    const reply = decodeClaimReply(await h.port.claim(request.body, signal()));
    assert.deepEqual(reply, "granted" in vector.expect ? { ok: true, grant: answer.body } : { ok: false, ...vector.expect }, vector.name);
    assert.equal(h.peeps.arrivals.at(-1)!.body, canonical(expected), vector.name);
  }
});

test("every renew refusal and reply in renew.json passes through the port unchanged", async (t) => {
  let answer: { status: number; body: unknown } = { status: 200, body: {} };
  const h = await port(t, (_a, res) => json(res, answer.status, answer.body));
  const utf8 = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
  for (const x of renew.cases) {
    for (const step of x.steps) {
      if (step.stamp) continue;
      const expected = typeof step.body === "string" ? step.body : utf8.decode(bytesOf(step.body));
      const request = step.fields && !("extra" in step.fields) ? renewBody(step.fields).body : expected;
      const e = step.expect;
      const body = "refused" in e ? e : "reply" in e ? e.reply : JSON.parse(e.receipt);
      answer = { status: "refused" in e ? 409 : 200, body };
      assert.deepEqual(await h.port.renew(CLAIM_ID, "RUNTOKEN", request, signal()), body, x.name);
      assert.deepEqual(Buffer.from(h.peeps.arrivals.at(-1)!.body), Buffer.from(expected), x.name);
    }
  }
});

test("event vectors use the production envelope builder and transport", async (t) => {
  let answer: unknown;
  const h = await port(t, (_a, res) => json(res, 200, answer));
  const events = read<EventsFile>("events.json");
  const utf8 = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
  const sample = eventsBody("3f2c1b0a-9e8d-4c7b-a6f5-e4d3c2b1a090", 1, "");
  for (const x of events.cases) {
    for (const step of x.steps) {
      answer = step.expect;
      if (!step.expect.ok && step.expect.reason === "malformed") {
        // These are Peeps request-parser vectors; only their refusal shape applies to the runner.
        assert.deepEqual(await h.port.events(CLAIM_ID, "EVTOKEN", sample, signal()), step.expect, x.name);
        continue;
      }
      const expected = bytesOf(step.body);
      const fixture = JSON.parse(utf8.decode(expected)) as EventsBody;
      const body = eventsBody(fixture.streamId, fixture.seq, fixture.batch, fixture.final);
      if (!step.expect.ok && step.expect.reason === "hash") {
        assert.notEqual(body.payloadHash, fixture.payloadHash, x.name);
        body.payloadHash = fixture.payloadHash;
      }
      assert.deepEqual(await h.port.events(CLAIM_ID, "EVTOKEN", body, signal()), step.expect, x.name);
      assert.deepEqual(Buffer.from(h.peeps.arrivals.at(-1)!.body), Buffer.from(expected), x.name);
    }
  }
});
