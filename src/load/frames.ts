/**
 * The supervisor–executor wire: each message is a 4-byte big-endian length and that many
 * bytes of UTF-8 JSON. Nothing else on the executor's stdout is ever interpreted: a frame
 * that is too long, not JSON, not an object or without a `t` is a protocol violation, and
 * the supervisor stops the executor.
 */

export const MAX_FRAME_BYTES = 256 * 1024;

export interface Frame {
  t: string;
  [key: string]: unknown;
}

export function encodeFrame(message: Frame): Buffer {
  const body = Buffer.from(JSON.stringify(message), "utf8");
  if (body.length > MAX_FRAME_BYTES) throw new Error(`frame of ${body.length} bytes is over the limit`);
  const head = Buffer.alloc(4);
  head.writeUInt32BE(body.length, 0);
  return Buffer.concat([head, body]);
}

export class FrameError extends Error {}

/** Accumulates bytes and yields whole frames; throws `FrameError` on anything malformed. */
export class FrameReader {
  private buffer: Buffer = Buffer.alloc(0);

  push(chunk: Buffer): Frame[] {
    this.buffer = this.buffer.length === 0 ? chunk : Buffer.concat([this.buffer, chunk]);
    const frames: Frame[] = [];
    while (this.buffer.length >= 4) {
      const length = this.buffer.readUInt32BE(0);
      if (length > MAX_FRAME_BYTES) throw new FrameError(`frame of ${length} bytes is over the limit`);
      if (this.buffer.length < 4 + length) break;
      const body = this.buffer.subarray(4, 4 + length).toString("utf8");
      this.buffer = this.buffer.subarray(4 + length);
      let parsed: unknown;
      try {
        parsed = JSON.parse(body);
      } catch {
        throw new FrameError("frame is not JSON");
      }
      if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed) || typeof (parsed as Frame).t !== "string") {
        throw new FrameError("frame is not a message");
      }
      frames.push(parsed as Frame);
    }
    return frames;
  }
}
