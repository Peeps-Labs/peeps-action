/**
 * The few DER encoders `ca.ts` needs to write an X.509 v3 certificate (RFC 5280). Node can
 * sign and parse certificates but not build them, and the action ships no dependencies.
 *
 * Pure: no clock, no I/O.
 */

export function tlv(tag: number, content: Buffer): Buffer {
  return Buffer.concat([Buffer.from([tag]), length(content.length), content]);
}

function length(n: number): Buffer {
  if (n < 0x80) return Buffer.from([n]);
  const bytes: number[] = [];
  for (let v = n; v > 0; v = Math.floor(v / 256)) bytes.unshift(v % 256);
  return Buffer.from([0x80 | bytes.length, ...bytes]);
}

export const seq = (...items: Buffer[]): Buffer => tlv(0x30, Buffer.concat(items));
export const set = (...items: Buffer[]): Buffer => tlv(0x31, Buffer.concat(items));
export const octets = (b: Buffer): Buffer => tlv(0x04, b);
export const bool = (v: boolean): Buffer => tlv(0x01, Buffer.from([v ? 0xff : 0x00]));
export const utf8 = (s: string): Buffer => tlv(0x0c, Buffer.from(s, "utf8"));
/** Context tag `n`, explicit (constructed). */
export const explicit = (n: number, content: Buffer): Buffer => tlv(0xa0 | n, content);
/** Context tag `n`, implicit and primitive, as a GeneralName's dNSName [2] or iPAddress [7]. */
export const implicit = (n: number, content: Buffer): Buffer => tlv(0x80 | n, content);
/** Context tag `n`, implicit and constructed, as nameConstraints' subtrees [0] and [1]. */
export const implicitSeq = (n: number, ...items: Buffer[]): Buffer => tlv(0xa0 | n, Buffer.concat(items));

/** A non-negative integer, from a number or big-endian bytes. */
export function integer(v: number | Buffer): Buffer {
  let b = typeof v === "number" ? bigEndian(v) : Buffer.from(v);
  while (b.length > 1 && b[0] === 0 && b[1]! < 0x80) b = b.subarray(1);
  if (b[0]! >= 0x80) b = Buffer.concat([Buffer.from([0]), b]);
  return tlv(0x02, b);
}

function bigEndian(n: number): Buffer {
  if (!Number.isSafeInteger(n) || n < 0) throw new Error("der: integer must be a whole number ≥ 0");
  const bytes: number[] = [];
  for (let v = n; v > 0; v = Math.floor(v / 256)) bytes.unshift(v % 256);
  return Buffer.from(bytes.length ? bytes : [0]);
}

export function oid(dotted: string): Buffer {
  const parts = dotted.split(".").map(Number);
  const out = [40 * parts[0]! + parts[1]!];
  for (const p of parts.slice(2)) {
    const chunk = [p & 0x7f];
    for (let v = Math.floor(p / 128); v > 0; v = Math.floor(v / 128)) chunk.unshift(0x80 | (v & 0x7f));
    out.push(...chunk);
  }
  return tlv(0x06, Buffer.from(out));
}

/** A BIT STRING holding whole bytes. */
export const bits = (b: Buffer, unused = 0): Buffer => tlv(0x03, Buffer.concat([Buffer.from([unused]), b]));

/** UTCTime through 2049, GeneralizedTime after (RFC 5280 §4.1.2.5). Whole seconds, UTC. */
export function time(ms: number): Buffer {
  const d = new Date(Math.floor(ms / 1000) * 1000);
  const y = d.getUTCFullYear();
  const rest = [d.getUTCMonth() + 1, d.getUTCDate(), d.getUTCHours(), d.getUTCMinutes(), d.getUTCSeconds()].map((n) => String(n).padStart(2, "0")).join("");
  return y < 2050 ? tlv(0x17, Buffer.from(`${String(y % 100).padStart(2, "0")}${rest}Z`)) : tlv(0x18, Buffer.from(`${y}${rest}Z`));
}
