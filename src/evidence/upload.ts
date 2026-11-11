/**
 * Uploading a job's evidence, as `pr2-contract.md` (peeps, PQA-3201 2a) defines it: each
 * project's head fingerprint before the announce, whose receipt the announce cites; then
 * after the tests, each project's footprints in one request under its batch, which
 * publishes. Each request has its own timeout. Any failure is logged and drops that
 * project's recording, and the job runs exactly as it does today: evidence never fails a job.
 */
import { createHash } from "node:crypto";
import { gzipSync } from "node:zlib";
import { encodePayload, type Layer, type RecordingBlob } from "./codec";
import type { EvidenceKind } from "./port";
import { footprintsRecording, type MemberEvidence } from "./recording";

export const FINGERPRINT_PATH = "/api/v1/ci/impact/fingerprint";
export const evidencePath = (batchId: string) => `/api/v1/ci/batches/${encodeURIComponent(batchId)}/evidence`;
export const UPLOAD_TIMEOUT_MS = 30_000;
/** Peeps refuses more on the wire (contract §2, §4); past it nothing is sent. */
export const MAX_BLOB_BYTES = 8 * 1024 * 1024;
/** Peeps refuses a footprints payload with more members (contract §4). */
export const MAX_MEMBERS = 16_000;
const PROTOCOL_VERSION = 2;

export interface EvidenceTransport {
  /** POST bytes; resolves to the parsed JSON answer, rejects on any non-2xx or timeout. */
  postBytes(path: string, bytes: Buffer, timeoutMs: number): Promise<unknown>;
  postJson(path: string, body: unknown, timeoutMs: number): Promise<unknown>;
}

export interface Receipt {
  uploadId: string;
  /** SHA-256 of the payload: equal evidence, equal digest. */
  digest: string;
}

/** The transport over Peeps' API, as the job's own client authenticates. */
export function peepsTransport(peepsUrl: string, token: () => Promise<string>): EvidenceTransport {
  const send = async (path: string, body: BodyInit, contentType: string, timeoutMs: number) => {
    const response = await fetch(`${peepsUrl}${path}`, {
      method: "POST",
      headers: { Authorization: `Bearer ${await token()}`, "Content-Type": contentType, Accept: "application/json", "User-Agent": "peeps-action/0.1" },
      body,
      signal: AbortSignal.timeout(timeoutMs),
    });
    const text = await response.text();
    if (!response.ok) throw new Error(`Peeps ${path.split("?")[0]} → ${response.status}`);
    return text ? (JSON.parse(text) as unknown) : {};
  };
  return {
    postBytes: (path, bytes, timeoutMs) => send(path, new Uint8Array(bytes), "application/octet-stream", timeoutMs),
    postJson: (path, body, timeoutMs) => send(path, JSON.stringify(body), "application/json", timeoutMs),
  };
}

export function gzipRecording(blob: RecordingBlob): Buffer {
  return gzipSync(encodePayload(blob));
}

const say = (message: string) => console.log(`[peeps] ${message}`);

export async function uploadFingerprint(
  transport: EvidenceTransport,
  input: { blob: RecordingBlob; projectId: string; base: string; leg: string; keyVersion: string; binding: string },
  log: (message: string) => void = say,
): Promise<Receipt | null> {
  try {
    const payload = encodePayload(input.blob);
    const digest = createHash("sha256").update(payload).digest("hex");
    const bytes = gzipSync(payload);
    if (bytes.length > MAX_BLOB_BYTES) throw new Error(`the fingerprint is ${bytes.length} bytes, over ${MAX_BLOB_BYTES}`);
    const query = new URLSearchParams({ projectId: input.projectId, protocolVersion: String(PROTOCOL_VERSION), binding: input.binding, keyVersion: input.keyVersion, digest });
    // Both optional: sent only as the route takes them.
    if (/^[0-9a-f]{40}$/.test(input.base)) query.set("base", input.base);
    if (input.leg.length >= 1 && input.leg.length <= 100 && !/[\u0000-\u001f\u007f]/.test(input.leg)) query.set("leg", input.leg);
    const answer = (await transport.postBytes(`${FINGERPRINT_PATH}?${query}`, bytes, UPLOAD_TIMEOUT_MS)) as { uploadId?: unknown; digest?: unknown } | null;
    if (typeof answer?.uploadId !== "string" || answer.uploadId === "" || answer.uploadId.length > 64) throw new Error("Peeps gave no upload id");
    if (answer.digest !== undefined && answer.digest !== digest) throw new Error("Peeps read other bytes than were sent");
    return { uploadId: answer.uploadId, digest };
  } catch (error) {
    log(`not recording what this job's tests ran: the build's fingerprint didn't upload (${String(error).slice(0, 300)})`);
    return null;
  }
}

export async function uploadEvidence(
  transport: EvidenceTransport,
  input: { batchId: string; key: Buffer; layers: Layer[]; measured: EvidenceKind[]; members: MemberEvidence[]; loadedFiles?: string[]; ambient?: string[]; browser?: { name: string; version: string } | null },
  log: (message: string) => void = say,
): Promise<boolean> {
  try {
    if (input.members.length > MAX_MEMBERS) throw new Error(`${input.members.length} tests, over ${MAX_MEMBERS}`);
    const blob = footprintsRecording(input.key, { layers: input.layers, measured: input.measured, loadedFiles: input.loadedFiles, ambient: input.ambient, browser: input.browser, members: input.members });
    const bytes = gzipRecording(blob);
    if (bytes.length > MAX_BLOB_BYTES) throw new Error(`the footprints are ${bytes.length} bytes, over ${MAX_BLOB_BYTES}`);
    await transport.postBytes(`${evidencePath(input.batchId)}?protocolVersion=${PROTOCOL_VERSION}`, bytes, UPLOAD_TIMEOUT_MS);
    return true;
  } catch (error) {
    log(`not recording what this job's tests ran: the footprints didn't upload (${String(error).slice(0, 300)})`);
    return false;
  }
}
