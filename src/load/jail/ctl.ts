/**
 * Frames on the control socket between the supervisor and the jail's init:
 * one JSON object per line. Pure: no sockets here.
 */

export type CtlFrame =
  | { type: "hello"; nonce: string }
  | { type: "ready" }
  | { type: "start" }
  | { type: "exit"; code: number | null; signal: string | null };

/** A line longer than this ends the connection: frames are small. */
export const MAX_FRAME_BYTES = 64 * 1024;

export function encode(frame: CtlFrame): string {
  return `${JSON.stringify(frame)}\n`;
}

/** The frame a line holds, or null when it is not one. Unknown fields are dropped. */
export function decode(line: string): CtlFrame | null {
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    return null;
  }
  if (typeof value !== "object" || value === null) return null;
  const v = value as Record<string, unknown>;
  switch (v.type) {
    case "hello":
      return typeof v.nonce === "string" && /^[0-9a-f]{64}$/.test(v.nonce) ? { type: "hello", nonce: v.nonce } : null;
    case "ready":
    case "start":
      return { type: v.type };
    case "exit": {
      const code = v.code === null || (typeof v.code === "number" && Number.isInteger(v.code)) ? (v.code as number | null) : undefined;
      const signal = v.signal === null || typeof v.signal === "string" ? (v.signal as string | null) : undefined;
      return code === undefined || signal === undefined ? null : { type: "exit", code, signal };
    }
    default:
      return null;
  }
}

/** Splits a byte stream into lines; `push` returns the complete lines, or null once a line is too long. */
export class LineSplitter {
  private buffer = "";

  push(chunk: string): string[] | null {
    this.buffer += chunk;
    const lines = this.buffer.split("\n");
    this.buffer = lines.pop() ?? "";
    if (Buffer.byteLength(this.buffer) > MAX_FRAME_BYTES || lines.some((line) => Buffer.byteLength(line) > MAX_FRAME_BYTES)) return null;
    return lines;
  }
}

/** Constant-time comparison of two hex nonces. */
export function sameNonce(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
