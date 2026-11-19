/**
 * The independent target the load engine's tests measure at (T5). It records each request's
 * arrival, permit header, connection and when its response ended; journey starts arrive
 * separately, as executor events, so a start that never sends is still counted. Responses
 * can be held open, so concurrency is measured by overlap, not by arrival times. Any request
 * without a valid permit is a bypass.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo, Socket } from "node:net";

export interface SinkRequest {
  method: string;
  path: string;
  permit: string | null;
  cookie: string | null;
  connection: number;
  arrivalMs: number;
  /** When the response finished, or the connection closed under it. */
  endMs: number | null;
  /** The client went away before the response was sent. */
  aborted: boolean;
}

export interface SinkStart {
  turn: string;
  user: number;
  phase: string;
  wallMs: number;
}

export type Variant = "baseline" | "paginated";

const SOUGHT = "RR-C30-0011";
const FLEET = Array.from({ length: 14 }, (_, i) => ({
  id: `RR-C30-${String(i + 1).padStart(4, "0")}`,
  status: i + 1 === 11 ? "charging" : i % 3 === 0 ? "idle" : "working",
}));

export class LoadSink {
  readonly requests: SinkRequest[] = [];
  readonly starts: SinkStart[] = [];
  readonly reports: Record<string, string>[] = [];
  /** Every response is held this long before it is sent. */
  holdMs = 0;
  variant: Variant = "baseline";
  info: Record<string, unknown> = {};
  private server: Server | null = null;
  private sockets = new Map<Socket, number>();
  private nextConnection = 0;
  private sids = 0;
  url = "";

  async start(): Promise<string> {
    this.server = createServer((req, res) => this.handle(req, res));
    this.server.on("connection", (socket) => this.sockets.set(socket, ++this.nextConnection));
    await new Promise<void>((resolve) => this.server!.listen(0, "127.0.0.1", resolve));
    this.url = `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`;
    return this.url;
  }

  async close(): Promise<void> {
    for (const socket of this.sockets.keys()) socket.destroy();
    await new Promise<void>((resolve) => (this.server ? this.server.close(() => resolve()) : resolve()));
  }

  recordStart(start: SinkStart): void {
    this.starts.push(start);
  }

  private handle(req: IncomingMessage, res: ServerResponse): void {
    const url = new URL(req.url ?? "/", "http://sink");
    const record: SinkRequest = {
      method: req.method ?? "?",
      path: url.pathname + url.search,
      permit: (req.headers["x-peeps-load-permit"] as string | undefined) ?? null,
      cookie: (req.headers.cookie as string | undefined) ?? null,
      connection: this.sockets.get(req.socket) ?? 0,
      arrivalMs: Date.now(),
      endMs: null,
      aborted: false,
    };
    this.requests.push(record);
    res.on("finish", () => (record.endMs ??= Date.now()));
    res.on("close", () => {
      if (!res.writableFinished) {
        record.aborted = true;
        record.endMs ??= Date.now();
      }
    });
    const hold = Number(url.searchParams.get("hold") ?? this.holdMs);
    const respond = () => {
      if (res.destroyed) return;
      this.route(url, req, res);
    };
    if (hold > 0) setTimeout(respond, hold);
    else respond();
  }

  private json(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
    res.writeHead(status, { "content-type": "application/json", ...headers });
    res.end(JSON.stringify(body));
  }

  private route(url: URL, req: IncomingMessage, res: ServerResponse): void {
    switch (url.pathname) {
      case "/value":
        return this.json(res, 200, { value: 42 });
      case "/reset":
        req.socket.destroy();
        return;
      case "/basic":
        return this.json(res, 401, { error: "auth" }, { "www-authenticate": 'Basic realm="sink"' });
      case "/redirect":
        res.writeHead(302, { location: "/value" });
        res.end();
        return;
      case "/redirect-out":
        res.writeHead(302, { location: "https://elsewhere.example.com/value" });
        res.end();
        return;
      case "/cookie": {
        const sid = /(?:^|;\s*)sid=(\d+)/.exec(req.headers.cookie ?? "")?.[1];
        if (sid) return this.json(res, 200, { sid: Number(sid), fresh: false });
        const fresh = ++this.sids;
        return this.json(res, 200, { sid: fresh, fresh: true }, { "set-cookie": `sid=${fresh}; Path=/` });
      }
      case "/info":
        return this.json(res, 200, this.info);
      case "/report":
        this.reports.push(Object.fromEntries(url.searchParams));
        return this.json(res, 200, { ok: true });
      case "/c/api/robots": {
        if (this.variant === "baseline") return this.json(res, 200, FLEET);
        const cursor = Number(url.searchParams.get("cursor") ?? 0);
        const items = FLEET.slice(cursor, cursor + 5);
        const next = cursor + 5 < FLEET.length ? String(cursor + 5) : null;
        return this.json(res, 200, { items, nextCursor: next });
      }
      default:
        return this.json(res, 200, { ok: true, path: url.pathname });
    }
  }

  // ------------------------------------------------------------------ the oracle

  /** Requests whose permit is missing, unknown or used twice: sends that went around the engine. */
  bypasses(validPermits: Iterable<string>): SinkRequest[] {
    const valid = new Set(validPermits);
    const used = new Set<string>();
    return this.requests.filter((r) => {
      if (!r.permit || !valid.has(r.permit) || used.has(r.permit)) return true;
      used.add(r.permit);
      return false;
    });
  }

  /** The most requests the sink held at once (by overlap of arrival and end). */
  peakConcurrency(): number {
    const edges: [number, number][] = [];
    for (const r of this.requests) {
      edges.push([r.arrivalMs, 1]);
      edges.push([r.endMs ?? Number.POSITIVE_INFINITY, -1]);
    }
    edges.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
    let open = 0;
    let peak = 0;
    for (const [, delta] of edges) {
      open += delta;
      peak = Math.max(peak, open);
    }
    return peak;
  }

  /** The most requests that arrived within any window of `windowMs`. */
  peakArrivals(windowMs: number): number {
    const times = this.requests.map((r) => r.arrivalMs).sort((a, b) => a - b);
    let peak = 0;
    for (let i = 0, j = 0; i < times.length; i++) {
      while (times[i]! - times[j]! >= windowMs) j++;
      peak = Math.max(peak, i - j + 1);
    }
    return peak;
  }

  requestsAfter(wallMs: number): SinkRequest[] {
    return this.requests.filter((r) => r.arrivalMs > wallMs);
  }

  startsAfter(wallMs: number): SinkStart[] {
    return this.starts.filter((s) => s.wallMs > wallMs);
  }

  /** Requests still open at `wallMs`. */
  outstandingAt(wallMs: number): SinkRequest[] {
    return this.requests.filter((r) => r.arrivalMs <= wallMs && (r.endMs === null || r.endMs > wallMs));
  }
}

export { SOUGHT };
