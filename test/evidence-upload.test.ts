/**
 * What leaves the job: the head fingerprint before the announce (its receipt cited by the
 * announce), the footprints after the tests, then finalize. Any failure drops impact and
 * the job runs as it does today.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { gunzipSync } from "node:zlib";

import { decodePayload, encodePayload } from "../src/evidence/codec";
import { fingerprintBuild } from "../src/evidence/fingerprint/rules";
import { parseProjectKey, tokenOf } from "../src/evidence/hash";
import { fingerprintRecording, footprintsRecording } from "../src/evidence/recording";
import { evidencePath, FINGERPRINT_PATH, uploadEvidence, uploadFingerprint, type EvidenceTransport } from "../src/evidence/upload";
import { BASE, nextBuild } from "./support/next-build";

const key = parseProjectKey(Buffer.alloc(32, 9).toString("hex"))!;
const files = nextBuild(BASE);
const fingerprint = fingerprintBuild({ files: [...files.keys()], read: (f) => files.get(f) ?? null, sourcePrefix: "" });

test("a fingerprint leaves as tokens only: no source path, function name or route in its bytes", () => {
  const blob = fingerprintRecording(fingerprint, key);
  assert.equal(blob.kind, "fingerprint");
  const text = Buffer.from(encodePayload(blob)).toString("latin1");
  for (const plain of ["LoginForm", "onSuccess", "src/app", "Badge", "sso", "turbopack", "node_modules"]) assert.ok(!text.includes(plain), plain);
});

test("each fingerprint entity carries its layer, its file's token and a keyed value hash", () => {
  const blob = fingerprintRecording(fingerprint, key);
  assert.equal(blob.kind, "fingerprint");
  const onSuccess = blob.entities.find((e) => e.id === tokenOf(key, "fn:browser:src/app/login/LoginForm.tsx:onSuccess"))!;
  assert.deepEqual([onSuccess.layer, onSuccess.file], ["browser", tokenOf(key, "file:src/app/login/LoginForm.tsx")]);
  assert.match(onSuccess.valueHash, /^[0-9a-f]{16}$/);
  const route = blob.entities.find((e) => e.id === tokenOf(key, "route:/sso"))!;
  assert.deepEqual([route.layer, route.file], ["server", null]);
  const css = blob.entities.find((e) => e.id === tokenOf(key, "css:src/components/common/Badge.module.css"))!;
  assert.deepEqual([css.layer, css.file], ["browser", tokenOf(key, "file:src/components/common/Badge.module.css")]);
  // The same build under another key shares no id and no value hash.
  const other = fingerprintRecording(fingerprint, parseProjectKey(Buffer.alloc(32, 1).toString("hex"))!);
  assert.equal(other.kind, "fingerprint");
  const ids = new Set(blob.entities.flatMap((e) => [e.id, e.valueHash]));
  assert.ok(other.entities.every((e) => !ids.has(e.id) && !ids.has(e.valueHash)));
});

test("footprints: one member per run, its attempts, partial and tokens; universe measured", () => {
  const blob = footprintsRecording(key, {
    layers: ["browser"],
    measured: ["code", "css", "route"],
    members: [
      { run: "run-2", attempts: [{ retry: 0, passed: false }, { retry: 1, passed: true }], evidence: [{ keys: ["fn:browser:a.ts:f", "file:a.ts"], paths: ["/cart"], partial: [], reasons: [] }, { keys: [], paths: ["/api/items"], partial: ["code"], reasons: ["target_lost"] }] },
      { run: "run-1", attempts: [{ retry: 0, passed: true }], evidence: [] },
    ],
  });
  assert.equal(blob.kind, "footprints");
  assert.deepEqual(blob.members.map((m) => [m.run, m.partial, m.tokens.length]), [
    ["run-2", ["code"], 4],
    // An attempt with no evidence at all proves nothing.
    ["run-1", ["code", "css", "route"], 0],
  ]);
});

function fakeTransport(answers: Record<string, unknown | Error>): EvidenceTransport & { calls: Array<{ path: string; body: unknown }> } {
  const calls: Array<{ path: string; body: unknown }> = [];
  const answer = (path: string) => {
    const found = Object.entries(answers).find(([prefix]) => path.startsWith(prefix))?.[1];
    if (found instanceof Error) return Promise.reject(found);
    return Promise.resolve(found ?? {});
  };
  return {
    calls,
    postBytes: (path, bytes) => {
      calls.push({ path, body: bytes });
      return answer(path);
    },
    postJson: (path, body) => {
      calls.push({ path, body });
      return answer(path);
    },
  };
}

test("the head fingerprint goes up before the announce, for its project, and its receipt comes back (contract §2)", async () => {
  const blob = fingerprintRecording(fingerprint, key);
  const digest = (await import("node:crypto")).createHash("sha256").update(encodePayload(blob)).digest("hex");
  const transport = fakeTransport({ [FINGERPRINT_PATH]: { uploadId: "up-1", digest } });
  const receipt = await uploadFingerprint(transport, { blob, projectId: "p1", base: "b".repeat(40), leg: "chromium", keyVersion: "V1", binding: "peeps-action@1/codec1/routes1" });
  assert.deepEqual(receipt, { uploadId: "up-1", digest });
  const [call] = transport.calls;
  const query = new URLSearchParams(call!.path.split("?")[1]);
  assert.deepEqual(Object.fromEntries(query), { projectId: "p1", protocolVersion: "2", binding: "peeps-action@1/codec1/routes1", keyVersion: "V1", digest, base: "b".repeat(40), leg: "chromium" });
  assert.deepEqual(new Uint8Array(gunzipSync(call!.body as Buffer)), encodePayload(blob));
});

test("base and leg go only when they're what the route takes", async () => {
  const transport = fakeTransport({ [FINGERPRINT_PATH]: { uploadId: "up-1" } });
  await uploadFingerprint(transport, { blob: fingerprintRecording(fingerprint, key), projectId: "p1", base: "", leg: "", keyVersion: "V1", binding: "x" });
  await uploadFingerprint(transport, { blob: fingerprintRecording(fingerprint, key), projectId: "p1", base: "not-a-sha", leg: "x".repeat(101), keyVersion: "V1", binding: "x" });
  for (const call of transport.calls) {
    const query = new URLSearchParams(call.path.split("?")[1]);
    assert.deepEqual([query.has("base"), query.has("leg")], [false, false], call.path);
  }
});

test("any failure uploading the fingerprint is no receipt, never a failed job", async () => {
  const blob = fingerprintRecording(fingerprint, key);
  const input = { blob, projectId: "p1", base: "b".repeat(40), leg: "chromium", keyVersion: "V1", binding: "x" };
  assert.equal(await uploadFingerprint(fakeTransport({ [FINGERPRINT_PATH]: new Error("Peeps → 409") }), input, () => {}), null);
  assert.equal(await uploadFingerprint(fakeTransport({ [FINGERPRINT_PATH]: { digest: "d" } }), input, () => {}), null);
  assert.equal(await uploadFingerprint(fakeTransport({ [FINGERPRINT_PATH]: { uploadId: "x".repeat(65) } }), input, () => {}), null);
  // Peeps read other bytes than these.
  assert.equal(await uploadFingerprint(fakeTransport({ [FINGERPRINT_PATH]: { uploadId: "up-1", digest: "0".repeat(64) } }), input, () => {}), null);
});

test("footprints go up in one request under the batch, which publishes (contract §4)", async () => {
  const transport = fakeTransport({ [evidencePath("batch-1")]: { status: "published" } });
  const members = Array.from({ length: 5 }, (_, i) => ({ run: `run-${i}`, attempts: [{ retry: 0, passed: true }], evidence: [{ keys: [`file:f${i}.ts`], paths: [], partial: [], reasons: [] }] }));
  const ok = await uploadEvidence(transport, { batchId: "batch-1", key, layers: ["browser"], measured: ["code", "css", "route"], members, browser: { name: "chromium", version: "147.0.1" } });
  assert.equal(ok, true);
  assert.deepEqual(transport.calls.map((c) => c.path), [`${evidencePath("batch-1")}?protocolVersion=2`]);
  const blob = decodePayload(gunzipSync(transport.calls[0]!.body as Buffer));
  assert.equal(blob.kind === "footprints" && blob.members.length, 5);
});

test("a refused upload, or more members than Peeps takes, records nothing", async () => {
  const members = (n: number) => Array.from({ length: n }, (_, i) => ({ run: `run-${i}`, attempts: [{ retry: 0, passed: true }], evidence: [] }));
  const refused = fakeTransport({ [evidencePath("batch-1")]: new Error("Peeps → 409") });
  assert.equal(await uploadEvidence(refused, { batchId: "batch-1", key, layers: ["browser"], measured: ["code"], members: members(2) }, () => {}), false);
  const tooMany = fakeTransport({});
  assert.equal(await uploadEvidence(tooMany, { batchId: "batch-1", key, layers: ["browser"], measured: ["code"], members: members(16_001) }, () => {}), false);
  assert.deepEqual(tooMany.calls, []);
});

test("loaded files leave keyed, like every other token", () => {
  const blob = footprintsRecording(key, { layers: ["browser"], measured: ["code"], members: [], loadedFiles: ["file:src/lib/date.ts"] });
  assert.equal(blob.kind, "footprints");
  assert.deepEqual(blob.universe.loadedFiles, [tokenOf(key, "file:src/lib/date.ts")]);
});

test("the fingerprint names its global ids: the Next runtime and routing, keyed", () => {
  const blob = fingerprintRecording(fingerprint, key);
  assert.equal(blob.kind, "fingerprint");
  if (blob.kind !== "fingerprint") return;
  assert.deepEqual(blob.global, [tokenOf(key, "file:node_modules/next/dist/server/runtime.js"), tokenOf(key, "out:routes-manifest.json")].sort());
  assert.ok(blob.global.every((id) => blob.entities.some((e) => e.id === id)));
});

test("the footprints carry the browser build that recorded, or none", () => {
  const recorded = footprintsRecording(key, { layers: ["browser"], measured: ["code"], members: [], browser: { name: "chromium", version: "147.0.7727.15" } });
  assert.equal(recorded.kind === "footprints" && JSON.stringify(recorded.browser), JSON.stringify({ name: "chromium", version: "147.0.7727.15" }));
  const unknown = footprintsRecording(key, { layers: ["browser"], measured: ["code"], members: [] });
  assert.equal(unknown.kind === "footprints" && unknown.browser, null);
});

test("ambient code leaves keyed, like every other token (PQA-3201 PR 3)", () => {
  const blob = footprintsRecording(key, { layers: ["server"], measured: ["code"], members: [], ambient: ["fn:server:src/app/api/heartbeat/route.ts:GET", "file:src/app/api/heartbeat/route.ts"] });
  assert.equal(blob.kind, "footprints");
  assert.deepEqual(blob.universe.ambient, [tokenOf(key, "fn:server:src/app/api/heartbeat/route.ts:GET"), tokenOf(key, "file:src/app/api/heartbeat/route.ts")]);
  const none = footprintsRecording(key, { layers: ["browser"], measured: ["code"], members: [] });
  assert.deepEqual(none.kind === "footprints" && none.universe.ambient, []);
});
