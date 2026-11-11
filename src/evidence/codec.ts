/**
 * The recording codec's payload, as Peeps defines and reads it
 * (`src/server/repo-backed/pr-impact/infrastructure/recording-codec.ts`, version 1; its
 * golden fixture is the contract). A stored blob is gzip over this (`upload.ts`). Pure.
 *
 * Every integer is an unsigned LEB128 varint unless named `u8`; a string is a varint
 * byte length then its UTF-8 bytes, never empty. Magic `PQIR`, version u8, kind u8
 * (1 fingerprint, 2 footprints), a dictionary of every string strictly ascending by
 * bytes, then the body. An index list is a count, then ascending dictionary indexes,
 * each as its gap from the previous less one.
 *
 * Fingerprint: entities ascending by id, each id, file (0 for none, else index + 1),
 * layer u8 (255 none) and an 8-byte value hash; then `global`, an index list of the ids
 * whose change means everything. Footprints: the browser that recorded (u8 0 for none,
 * or 1 then its name and full version as strings), layers and measured as u8 bitmasks,
 * loadedFiles and ambient index lists, then members ascending by run, each its
 * run, attempts ascending by retry (retry, passed u8), partial u8 bitmask and tokens.
 * `decodePayload` refuses every other encoding, as Peeps' reader does.
 */
import type { EvidenceKind } from "./port";

export const RECORDING_CODEC_VERSION = 1;
/** In Peeps' order: a bitmask's bit is the index. */
export const LAYERS = ["browser", "server", "worker_thread", "worker_process", "build", "database"] as const;
export const EVIDENCE_KINDS: readonly EvidenceKind[] = ["code", "out", "css", "route", "table"];
export type Layer = (typeof LAYERS)[number];

export interface FingerprintEntity {
  id: string;
  file: string | null;
  layer: Layer | null;
  /** 8 bytes, in hex. */
  valueHash: string;
}

export interface RecordedMember {
  /** The Peeps run id the announce gave this test's run. */
  run: string;
  attempts: Array<{ retry: number; passed: boolean }>;
  partial: EvidenceKind[];
  tokens: string[];
}

export type RecordingBlob =
  | { kind: "fingerprint"; entities: FingerprintEntity[]; global: string[] }
  | {
      kind: "footprints";
      browser: { name: string; version: string } | null;
      universe: { layers: Layer[]; measured: EvidenceKind[]; loadedFiles: string[]; ambient: string[] };
      members: RecordedMember[];
    };

const MAGIC = [0x50, 0x51, 0x49, 0x52];
const NO_LAYER = 255;
const MAX_STRING_BYTES = 4096;

const byBytes = (a: string, b: string) => Buffer.compare(Buffer.from(a, "utf8"), Buffer.from(b, "utf8"));

function fail(message: string): never {
  throw new Error(`recording codec: ${message}`);
}

function ascending<T>(items: readonly T[], compare: (a: T, b: T) => number, what: string): T[] {
  const sorted = [...items].sort(compare);
  for (let i = 1; i < sorted.length; i++) if (compare(sorted[i - 1]!, sorted[i]!) === 0) fail(`duplicate ${what}`);
  return sorted;
}

function bitmask<T>(vocabulary: readonly T[], values: readonly T[], what: string): number {
  let mask = 0;
  for (const value of values) {
    const index = vocabulary.indexOf(value);
    if (index < 0) fail(`${what}: unknown ${String(value)}`);
    mask |= 1 << index;
  }
  return mask;
}

export function encodePayload(value: RecordingBlob): Uint8Array {
  const bytes: number[] = [];
  const u8 = (n: number) => bytes.push(n);
  const varint = (n: number) => {
    if (!Number.isSafeInteger(n) || n < 0) fail(`bad integer ${n}`);
    let rest = n;
    while (rest >= 0x80) {
      bytes.push((rest % 0x80) | 0x80);
      rest = Math.floor(rest / 0x80);
    }
    bytes.push(rest);
  };
  const string = (s: string) => {
    const utf8 = Buffer.from(s, "utf8");
    if (utf8.length === 0) fail("empty string");
    if (utf8.length > MAX_STRING_BYTES) fail("string too long");
    varint(utf8.length);
    bytes.push(...utf8);
  };

  const strings =
    value.kind === "fingerprint"
      ? [...value.entities.flatMap((e) => (e.file === null ? [e.id] : [e.id, e.file])), ...value.global]
      : [...value.universe.loadedFiles, ...value.universe.ambient, ...value.members.flatMap((m) => m.tokens)];
  const dictionary = [...new Set(strings)].sort(byBytes);
  const indexOf = new Map(dictionary.map((entry, index) => [entry, index]));
  const indexList = (entries: readonly string[]) => {
    const indexes = [...new Set(entries)].map((e) => indexOf.get(e)!).sort((a, b) => a - b);
    varint(indexes.length);
    indexes.forEach((index, i) => varint(i === 0 ? index : index - indexes[i - 1]! - 1));
  };

  bytes.push(...MAGIC);
  u8(RECORDING_CODEC_VERSION);
  u8(value.kind === "fingerprint" ? 1 : 2);
  varint(dictionary.length);
  for (const entry of dictionary) string(entry);

  if (value.kind === "fingerprint") {
    const entities = ascending(value.entities, (a, b) => byBytes(a.id, b.id), "entity");
    varint(entities.length);
    for (const entity of entities) {
      if (!/^[0-9a-f]{16}$/.test(entity.valueHash)) fail("bad valueHash");
      varint(indexOf.get(entity.id)!);
      varint(entity.file === null ? 0 : indexOf.get(entity.file)! + 1);
      const layer = entity.layer === null ? NO_LAYER : LAYERS.indexOf(entity.layer);
      if (layer < 0) fail(`unknown layer ${String(entity.layer)}`);
      u8(layer);
      bytes.push(...Buffer.from(entity.valueHash, "hex"));
    }
    indexList(value.global);
    return new Uint8Array(bytes);
  }

  if (value.browser === null) u8(0);
  else {
    u8(1);
    string(value.browser.name);
    string(value.browser.version);
  }
  u8(bitmask(LAYERS, value.universe.layers, "layers"));
  u8(bitmask(EVIDENCE_KINDS, value.universe.measured, "measured"));
  indexList(value.universe.loadedFiles);
  indexList(value.universe.ambient);
  const members = ascending(value.members, (a, b) => byBytes(a.run, b.run), "run");
  varint(members.length);
  for (const member of members) {
    string(member.run);
    const attempts = ascending(member.attempts, (a, b) => a.retry - b.retry, "retry");
    varint(attempts.length);
    for (const attempt of attempts) {
      varint(attempt.retry);
      u8(attempt.passed ? 1 : 0);
    }
    u8(bitmask(EVIDENCE_KINDS, member.partial, "partial"));
    indexList(member.tokens);
  }
  return new Uint8Array(bytes);
}

/** A payload read back, refusing anything but the canonical encoding of a value, as Peeps does. */
export function decodePayload(bytes: Uint8Array): RecordingBlob {
  let at = 0;
  const u8 = () => {
    if (at >= bytes.length) fail("truncated");
    return bytes[at++]!;
  };
  const varint = () => {
    let value = 0;
    let scale = 1;
    for (;;) {
      const byte = u8();
      value += (byte & 0x7f) * scale;
      if (!Number.isSafeInteger(value)) fail("integer too large");
      if ((byte & 0x80) === 0) {
        // A trailing zero group is a second spelling of a shorter number.
        if (byte === 0 && scale > 1) fail("non-canonical integer");
        return value;
      }
      scale *= 0x80;
    }
  };
  const raw = (length: number) => {
    if (at + length > bytes.length) fail("truncated");
    at += length;
    return bytes.slice(at - length, at);
  };
  const string = () => {
    const length = varint();
    if (length === 0) fail("empty string");
    if (length > MAX_STRING_BYTES) fail("string too long");
    try {
      return new TextDecoder("utf-8", { fatal: true }).decode(raw(length));
    } catch (error) {
      if (String(error).includes("recording codec")) throw error;
      fail("bad UTF-8");
    }
  };
  const fromBitmask = <T>(vocabulary: readonly T[], mask: number, what: string): T[] => {
    if (mask >> vocabulary.length !== 0) fail(`${what}: unknown bit`);
    return vocabulary.filter((_, index) => (mask & (1 << index)) !== 0);
  };

  if (Buffer.compare(Buffer.from(raw(MAGIC.length)), Buffer.from(MAGIC)) !== 0) fail("bad magic");
  const version = u8();
  if (version !== RECORDING_CODEC_VERSION) fail(`unknown version ${version}`);
  const kind = u8();
  const dictionary: string[] = [];
  const count = varint();
  for (let i = 0; i < count; i++) {
    const entry = string();
    if (i > 0 && byBytes(dictionary[i - 1]!, entry) >= 0) fail("dictionary out of order");
    dictionary.push(entry);
  }
  const used = new Array<boolean>(dictionary.length).fill(false);
  const entry = (index: number) => {
    if (index >= dictionary.length) fail("index past the dictionary");
    used[index] = true;
    return dictionary[index]!;
  };
  const indexList = () => {
    const entries: string[] = [];
    let index = -1;
    const length = varint();
    for (let i = 0; i < length; i++) entries.push(entry((index += varint() + 1)));
    return entries;
  };

  let value: RecordingBlob;
  if (kind === 1) {
    const entities: FingerprintEntity[] = [];
    const length = varint();
    let previous = -1;
    for (let i = 0; i < length; i++) {
      const id = varint();
      if (id <= previous) fail("entities out of order");
      previous = id;
      const file = varint();
      const layer = u8();
      if (layer !== NO_LAYER && layer >= LAYERS.length) fail(`unknown layer ${layer}`);
      entities.push({ id: entry(id), file: file === 0 ? null : entry(file - 1), layer: layer === NO_LAYER ? null : LAYERS[layer]!, valueHash: Buffer.from(raw(8)).toString("hex") });
    }
    value = { kind: "fingerprint", entities, global: indexList() };
  } else if (kind === 2) {
    const present = u8();
    if (present > 1) fail("bad browser byte");
    const browser = present === 1 ? { name: string(), version: string() } : null;
    const layers = fromBitmask(LAYERS, u8(), "layers");
    const measured = fromBitmask(EVIDENCE_KINDS, u8(), "measured");
    const loadedFiles = indexList();
    const ambient = indexList();
    const members: RecordedMember[] = [];
    const length = varint();
    for (let i = 0; i < length; i++) {
      const run = string();
      if (i > 0 && byBytes(members[i - 1]!.run, run) >= 0) fail("members out of order");
      const attempts: RecordedMember["attempts"] = [];
      const tries = varint();
      for (let t = 0; t < tries; t++) {
        const retry = varint();
        if (t > 0 && retry <= attempts[t - 1]!.retry) fail("retries out of order");
        const passed = u8();
        if (passed > 1) fail("bad passed byte");
        attempts.push({ retry, passed: passed === 1 });
      }
      const partial = fromBitmask(EVIDENCE_KINDS, u8(), "partial");
      members.push({ run, attempts, partial, tokens: indexList() });
    }
    value = { kind: "footprints", browser, universe: { layers: [...layers], measured, loadedFiles, ambient }, members };
  } else {
    fail(`unknown kind ${kind}`);
  }
  if (at !== bytes.length) fail("trailing bytes");
  if (used.includes(false)) fail("unreferenced dictionary entry");
  return value;
}
