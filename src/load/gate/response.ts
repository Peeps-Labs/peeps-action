/**
 * Reads one HTTP/1.1 response off an upstream socket, to know when the exchange is over and to
 * hand the journey a decoded body. Strict and small: a status line, headers, then a body framed
 * by chunked coding, Content-Length, or the end of the connection. Interim 1xx responses are
 * skipped; 101 is an error (the gate never asks to upgrade).
 */

const MAX_HEAD_BYTES = 64 * 1024;
const CRLF = Buffer.from("\r\n");
const HEAD_END = Buffer.from("\r\n\r\n");

export interface ResponseHead {
  status: number;
  statusText: string;
  /** Raw name/value pairs, in order. */
  headers: [string, string][];
}

export interface ResponseEvents {
  head(head: ResponseHead): void;
  data(chunk: Buffer): void;
  end(): void;
  error(error: Error): void;
}

type Mode = { kind: "head" } | { kind: "fixed"; left: number } | { kind: "chunk-size" } | { kind: "chunk-data"; left: number } | { kind: "chunk-crlf" } | { kind: "trailers" } | { kind: "close" } | { kind: "done" };

export class ResponseReader {
  private buf: Buffer = Buffer.alloc(0);
  private mode: Mode = { kind: "head" };
  private failed = false;

  constructor(
    private readonly requestMethod: string,
    private readonly on: ResponseEvents,
  ) {}

  get done(): boolean {
    return this.mode.kind === "done" || this.failed;
  }

  push(chunk: Buffer): void {
    if (this.done) return;
    this.buf = this.buf.length ? Buffer.concat([this.buf, chunk]) : chunk;
    try {
      this.drain();
    } catch (error) {
      this.fail(error as Error);
    }
  }

  /** The upstream closed its side. */
  end(): void {
    if (this.done) return;
    if (this.mode.kind === "close") {
      this.mode = { kind: "done" };
      this.on.end();
    } else this.fail(new Error("upstream closed before the response ended"));
  }

  /** The exchange was ended from outside (a reset, a deadline): never a clean end. */
  abort(error: Error): void {
    if (this.done) return;
    this.fail(error);
  }

  private fail(error: Error): void {
    if (this.failed) return;
    this.failed = true;
    this.on.error(error);
  }

  private drain(): void {
    for (;;) {
      const m = this.mode;
      if (m.kind === "head") {
        const at = this.buf.indexOf(HEAD_END);
        if (at > MAX_HEAD_BYTES || (at < 0 && this.buf.length > MAX_HEAD_BYTES)) throw new Error("response head too large");
        if (at < 0) return;
        const head = parseHead(this.buf.subarray(0, at).toString("latin1"));
        this.buf = this.buf.subarray(at + 4);
        if (head.status === 101) throw new Error("upstream switched protocols");
        if (head.status < 200) continue; // interim response: the real one follows
        // Framing is validated before the head is passed on: a malformed response is never
        // reported as received.
        const mode = bodyMode(this.requestMethod, head);
        this.on.head(head);
        this.mode = mode;
        if (this.mode.kind === "done") return this.on.end();
        continue;
      }
      if (m.kind === "close") {
        if (this.buf.length) this.on.data(this.take(this.buf.length));
        return;
      }
      if (m.kind === "fixed") {
        if (!this.buf.length) return;
        const n = Math.min(m.left, this.buf.length);
        this.on.data(this.take(n));
        m.left -= n;
        if (m.left === 0) {
          this.mode = { kind: "done" };
          return this.on.end();
        }
        continue;
      }
      if (m.kind === "chunk-size") {
        const at = this.buf.indexOf(CRLF);
        if (at < 0) {
          if (this.buf.length > 1024) throw new Error("chunk size line too long");
          return;
        }
        const line = this.buf.subarray(0, at).toString("latin1");
        this.buf = this.buf.subarray(at + 2);
        const hex = line.split(";")[0]!.trim();
        if (!/^[0-9a-fA-F]{1,12}$/.test(hex)) throw new Error("bad chunk size");
        const size = parseInt(hex, 16);
        this.mode = size === 0 ? { kind: "trailers" } : { kind: "chunk-data", left: size };
        continue;
      }
      if (m.kind === "chunk-data") {
        if (!this.buf.length) return;
        const n = Math.min(m.left, this.buf.length);
        this.on.data(this.take(n));
        m.left -= n;
        if (m.left === 0) this.mode = { kind: "chunk-crlf" };
        continue;
      }
      if (m.kind === "chunk-crlf") {
        if (this.buf.length < 2) return;
        if (this.buf[0] !== 0x0d || this.buf[1] !== 0x0a) throw new Error("chunk not followed by CRLF");
        this.buf = this.buf.subarray(2);
        this.mode = { kind: "chunk-size" };
        continue;
      }
      if (m.kind === "trailers") {
        const at = this.buf.indexOf(CRLF);
        if (at < 0) {
          if (this.buf.length > MAX_HEAD_BYTES) throw new Error("trailers too large");
          return;
        }
        this.buf = this.buf.subarray(at + 2);
        if (at === 0) {
          this.mode = { kind: "done" };
          return this.on.end();
        }
        continue;
      }
      return;
    }
  }

  private take(n: number): Buffer {
    const out = this.buf.subarray(0, n);
    this.buf = this.buf.subarray(n);
    return Buffer.from(out);
  }
}

function parseHead(text: string): ResponseHead {
  const lines = text.split("\r\n");
  const m = /^HTTP\/1\.[01] ([1-9][0-9]{2})(?: (.*))?$/.exec(lines[0]!);
  if (!m) throw new Error("bad status line");
  const headers: [string, string][] = [];
  for (const line of lines.slice(1)) {
    const c = line.indexOf(":");
    if (c <= 0 || /\s/.test(line.slice(0, c))) throw new Error("bad response header");
    headers.push([line.slice(0, c), line.slice(c + 1).trim()]);
  }
  return { status: Number(m[1]), statusText: m[2] ?? "", headers };
}

function bodyMode(method: string, head: ResponseHead): Mode {
  if (method === "HEAD" || head.status === 204 || head.status === 304) return { kind: "done" };
  const values = (name: string) => head.headers.filter(([n]) => n.toLowerCase() === name).map(([, v]) => v);
  const te = values("transfer-encoding");
  const cl = values("content-length");
  if (te.length && cl.length) throw new Error("ambiguous framing: both transfer-encoding and content-length");
  if (te.length) {
    const codings = te.join(",").split(",").map((s) => s.trim().toLowerCase());
    if (codings.length !== 1 || codings[0] !== "chunked") throw new Error("unsupported transfer-coding");
    return { kind: "chunk-size" };
  }
  if (cl.length) {
    if (new Set(cl).size !== 1 || !/^[0-9]{1,15}$/.test(cl[0]!)) throw new Error("bad content-length");
    const n = Number(cl[0]);
    return n === 0 ? { kind: "done" } : { kind: "fixed", left: n };
  }
  return { kind: "close" };
}
