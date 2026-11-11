/**
 * The recording codec's payload, as Peeps reads it (`pr-impact/infrastructure/recording-codec.ts`).
 * `fixtures/evidence/recording-codec.golden.json` is Peeps' own golden file, copied
 * byte-identical (its sha256 is pinned below); the contract is the payload before gzip.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { gunzipSync } from "node:zlib";

import { decodePayload, encodePayload, RECORDING_CODEC_VERSION, type RecordingBlob } from "../src/evidence/codec";
import { gzipRecording } from "../src/evidence/upload";

const GOLDEN = path.join(__dirname, "fixtures/evidence/recording-codec.golden.json");

test("a minimal fingerprint, byte by byte, with its global ids", () => {
  const value: RecordingBlob = { kind: "fingerprint", entities: [{ id: "fn:b", file: "file:a", layer: "browser", valueHash: "0102030405060708" }], global: ["file:a"] };
  const expected = [
    "50514952", // PQIR
    "01", // version
    "01", // fingerprint
    "02", "06" + Buffer.from("file:a").toString("hex"), "04" + Buffer.from("fn:b").toString("hex"), // dictionary
    "01", // one entity
    "01", "01", "00", "0102030405060708", // id 1, file index 0 + 1, browser, value hash
    "01", "00", // global: [0]
  ].join("");
  assert.equal(Buffer.from(encodePayload(value)).toString("hex"), expected);
});

test("minimal footprints, byte by byte: the browser, index lists as gaps, attempts by retry", () => {
  const value: RecordingBlob = {
    kind: "footprints",
    browser: { name: "chromium", version: "147.0.1" },
    universe: { layers: ["browser"], measured: ["code", "route"], loadedFiles: ["file:a"], ambient: [] },
    members: [{ run: "r1", attempts: [{ retry: 1, passed: true }, { retry: 0, passed: false }], partial: ["css"], tokens: ["route:/x", "file:a", "fn:b"] }],
  };
  const str = (s: string) => Buffer.from([s.length]).toString("hex") + Buffer.from(s).toString("hex");
  const expected = [
    "50514952", "01", "02",
    "03", str("file:a"), str("fn:b"), str("route:/x"),
    "01", str("chromium"), str("147.0.1"), // the browser that recorded, inline
    "01", // layers: browser
    "09", // measured: code (bit 0) and route (bit 3)
    "01", "00", // loadedFiles: [0]
    "00", // ambient: []
    "01", str("r1"),
    "02", "0000", "0101", // retry 0 failed, retry 1 passed
    "04", // partial: css (bit 2)
    "03", "00", "00", "00", // tokens: 0, 1, 2 as gaps
  ].join("");
  assert.equal(Buffer.from(encodePayload(value)).toString("hex"), expected);
});

test("the encoding is canonical: input order changes nothing, and a varint has one spelling", () => {
  const entities = Array.from({ length: 200 }, (_, i) => ({ id: `fn:${String(i).padStart(3, "0")}`, file: null, layer: null, valueHash: "00".repeat(8) }));
  const forward = encodePayload({ kind: "fingerprint", entities, global: [] });
  const reversed = encodePayload({ kind: "fingerprint", entities: [...entities].reverse(), global: [] });
  assert.deepEqual(forward, reversed);
  // 200 entries: the count is a two-byte varint.
  assert.equal(Buffer.from(forward.slice(6, 8)).toString("hex"), "c801");
});

test("what the server would refuse is refused here first", () => {
  const entity = { id: "fn:a", file: null, layer: null, valueHash: "00".repeat(8) };
  assert.throws(() => encodePayload({ kind: "fingerprint", entities: [entity, entity], global: [] }), /duplicate/);
  assert.throws(() => encodePayload({ kind: "fingerprint", entities: [{ ...entity, valueHash: "xyz" }], global: [] }), /valueHash/);
  assert.throws(() => encodePayload({ kind: "fingerprint", entities: [{ ...entity, id: "" }], global: [] }), /empty/);
  assert.throws(
    () => encodePayload({ kind: "footprints", browser: null, universe: { layers: [], measured: [], loadedFiles: [], ambient: [] }, members: [{ run: "r", attempts: [{ retry: 0, passed: true }, { retry: 0, passed: true }], partial: [], tokens: [] }] }),
    /duplicate/,
  );
});

test("a stored blob is gzip over the payload", () => {
  const value: RecordingBlob = { kind: "fingerprint", entities: [{ id: "fn:b", file: "file:a", layer: "server", valueHash: "0102030405060708" }], global: [] };
  assert.deepEqual(new Uint8Array(gunzipSync(gzipRecording(value))), encodePayload(value));
});

/** Peeps' copies, for the drift check when this checkout sits beside one (`PEEPS_FIXTURES` names another). */
const PEEPS_FIXTURES = process.env.PEEPS_FIXTURES ?? path.resolve(__dirname, "../../../peeps/.claude/worktrees/pqa-3201-pr2a/src/server/repo-backed/pr-impact/infrastructure/__fixtures__");
const sha256 = (file: string) => createHash("sha256").update(readFileSync(file)).digest("hex");

const PINNED = {
  "recording-codec.golden.json": "cdd6831ef3834bfe891cd1b6ca6ce3d28aca2d9f09bd0fd7725d29692f619078",
  "impact-ids.vectors.json": "1cc7f0eb1f947eb669d9fb099e6d1f248882c303a6f7b8ef25dec913a18c0577",
};

test("the fixtures are Peeps' bytes: pinned here, and equal to Peeps' copies where they're on disk", () => {
  for (const [name, pinned] of Object.entries(PINNED)) {
    assert.equal(sha256(path.join(__dirname, "fixtures/evidence", name)), pinned, name);
    const peeps = path.join(PEEPS_FIXTURES, name);
    if (existsSync(peeps)) assert.equal(sha256(peeps), pinned, `Peeps' ${name} changed: copy it again`);
  }
});

interface Golden {
  version: number;
  cases: Array<{ name: string; value: RecordingBlob; payloadHex: string }>;
  invalid: Array<{ name: string; payloadHex: string }>;
}
const golden = JSON.parse(readFileSync(GOLDEN, "utf8")) as Golden;

test("Peeps' golden payloads, byte for byte, both ways", () => {
  assert.equal(golden.version, RECORDING_CODEC_VERSION);
  assert.ok(golden.cases.length > 0);
  for (const row of golden.cases) {
    assert.equal(Buffer.from(encodePayload(row.value)).toString("hex"), row.payloadHex, row.name);
    assert.deepEqual(decodePayload(Buffer.from(row.payloadHex, "hex")), row.value, row.name);
  }
});

test("every payload Peeps refuses is refused here too", () => {
  assert.ok(golden.invalid.length > 0);
  for (const row of golden.invalid) assert.throws(() => decodePayload(Buffer.from(row.payloadHex, "hex")), /recording codec/, row.name);
});
