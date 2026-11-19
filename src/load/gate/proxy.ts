/**
 * The gate's proxy (plan v3 §5). The journey's only exit is the relay to this proxy's Unix
 * socket. Each request arrives as an HTTP CONNECT carrying the turn's credential, for one
 * approved origin; the proxy terminates the journey's TLS with the run CA's leaf for that host,
 * reads exactly one request, rebuilds it (`normalize`), dials the origin itself (`resolve`), and
 * then, in one synchronous step with nothing awaited between them:
 *
 *     admit → journal.begin → socket.write(head + body)
 *
 * so no time passes between the gate's decision and the bytes leaving. Upgrade and Expect are
 * refused, redirects are answered not followed, nothing is retried, and every upstream socket is
 * dialled fresh for one request. `close()` resets every socket, dropping what the kernel still
 * holds; `closeTurn` revokes a turn's tunnels and pending dials.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { Duplex } from "node:stream";
import { TLSSocket, createSecureContext, type SecureContext } from "node:tls";
import type { Clocks, Gate } from "./admission";
import type { RunCa } from "./ca";
import type { Journal } from "./journal";
import { MAX_BODY_BYTES, normalize, parseAuthority, type Authority, type RequestPolicy } from "./normalize";
import { dial as dialOrigin, type ApprovedOrigin, type Upstream } from "./resolve";
import { ResponseReader } from "./response";

/** The header that names why the gate answered instead of the target. */
export const DENIED_HEADER = "x-peeps-load-denied";

/** Response headers never passed back: the proxy frames its own answer. */
const HOP_HEADERS = new Set(["connection", "keep-alive", "proxy-connection", "transfer-encoding", "te", "trailer", "upgrade", "content-length"]);

export type Dial = (origin: ApprovedOrigin, signal: AbortSignal) => Promise<Upstream>;

export interface ProxyOptions {
  gate: Gate;
  journal: Journal;
  ca: RunCa;
  policy: RequestPolicy;
  /** Approved origins by canonical origin. */
  origins: ReadonlyMap<string, ApprovedOrigin>;
  /** The turn a `Proxy-Authorization` value belongs to, if any. */
  authorize(credential: string): number | undefined;
  /** Dials in progress, per turn and for the run. */
  maxPendingDialsPerTurn: number;
  maxPendingDials: number;
  /** Read at each admission. Defaults to `performance.now()` and `Date.now()`. */
  clocks?: () => Clocks;
  /** Defaults to `resolve.dial`; tests inject a dial with fixture trust. */
  dial?: Dial;
}

interface TunnelState {
  turn: number;
  authority: Authority;
  client: Duplex;
  tls?: TLSSocket;
  used: boolean;
}

const systemClocks = (): Clocks => ({ monoMs: performance.now(), wallMs: Date.now() });

export class GateProxy {
  readonly server: Server;
  private readonly inner: Server;
  private readonly tunnels = new Set<TunnelState>();
  private readonly byTls = new WeakMap<TLSSocket, TunnelState>();
  private readonly upstreams = new Set<Upstream>();
  private readonly pending = new Map<number, Set<AbortController>>();
  private pendingCount = 0;
  private readonly closedTurns = new Set<number>();
  private readonly contexts = new Map<string, SecureContext>();
  private readonly clocks: () => Clocks;
  private readonly dial: Dial;
  private closed = false;

  constructor(private readonly o: ProxyOptions) {
    this.clocks = o.clocks ?? systemClocks;
    this.dial = o.dial ?? ((origin, signal) => dialOrigin(origin, { signal }));
    this.server = createServer({ maxHeaderSize: 8192 });
    this.server.on("connect", (req: IncomingMessage, socket: Duplex, head: Buffer) => this.onConnect(req, socket, head));
    this.server.on("upgrade", (_req: IncomingMessage, socket: Duplex) => rawRefuse(socket, 400, "upgrade"));
    this.server.on("checkContinue", (_req, res) => answer(res, 417, "expect"));
    this.server.on("checkExpectation", (_req, res) => answer(res, 417, "expect"));
    this.server.on("request", (_req, res) => answer(res, 405, "form"));
    this.server.on("clientError", (_e, socket: Duplex) => socket.destroy());

    this.inner = createServer({ maxHeaderSize: 16384, joinDuplicateHeaders: false, requestTimeout: 0 });
    this.inner.on("request", (req, res) => this.onRequest(req, res));
    this.inner.on("upgrade", (_req: IncomingMessage, socket: Duplex) => rawRefuse(socket, 400, "upgrade"));
    this.inner.on("connect", (_req: IncomingMessage, socket: Duplex) => rawRefuse(socket, 400, "form"));
    this.inner.on("checkContinue", (_req, res) => answer(res, 417, "expect"));
    this.inner.on("checkExpectation", (_req, res) => answer(res, 417, "expect"));
    this.inner.on("clientError", (_e, socket: Duplex) => socket.destroy());
  }

  /** Listen on the proxy's Unix socket. */
  listen(path: string): Promise<void> {
    return new Promise((resolve, reject) => {
      this.server.once("error", reject);
      this.server.listen(path, () => {
        this.server.off("error", reject);
        resolve();
      });
    });
  }

  /** Revoke a turn: the gate stops admitting it, its dials are abandoned and its tunnels reset. */
  closeTurn(turn: number): void {
    this.closedTurns.add(turn);
    this.o.gate.closeTurn(turn);
    for (const c of this.pending.get(turn) ?? []) c.abort();
    for (const t of [...this.tunnels]) if (t.turn === turn) this.dropTunnel(t);
  }

  /** Reset every socket, tunnel and dial. Bytes still queued in the kernel are dropped. */
  close(): Promise<void> {
    this.closed = true;
    for (const set of this.pending.values()) for (const c of set) c.abort();
    for (const u of this.upstreams) u.reset();
    for (const t of [...this.tunnels]) this.dropTunnel(t);
    return new Promise((resolve) => {
      if (!this.server.listening) return resolve();
      this.server.close(() => resolve());
    });
  }

  /** Feed an accepted connection (tests use a socket pair; production uses `listen`). */
  accept(socket: Duplex): void {
    this.server.emit("connection", socket);
  }

  private onConnect(req: IncomingMessage, client: Duplex, head: Buffer): void {
    if (this.closed) return rawRefuse(client, 503, "stopped");
    const credentials = headerValues(req.rawHeaders, "proxy-authorization");
    const turn = credentials.length === 1 ? this.o.authorize(credentials[0]!) : undefined;
    if (turn === undefined) return rawRefuse(client, 407, "credential", "proxy-authenticate: Basic\r\n");
    if (this.closedTurns.has(turn)) return rawRefuse(client, 403, "turn_closed");
    const authority = parseAuthority(req.url ?? "");
    if (!authority || !this.o.origins.has(authority.origin)) return rawRefuse(client, 403, "origin");
    const context = this.contextFor(authority.host);
    if (!context) return rawRefuse(client, 403, "origin");

    const tunnel: TunnelState = { turn, authority, client, used: false };
    this.tunnels.add(tunnel);
    client.on("close", () => this.tunnels.delete(tunnel));
    client.on("error", () => client.destroy());
    if (head.length) client.unshift(head);
    client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
    const tls = new TLSSocket(client, { isServer: true, secureContext: context, ALPNProtocols: ["http/1.1"] });
    tunnel.tls = tls;
    this.byTls.set(tls, tunnel);
    tls.on("error", () => this.dropTunnel(tunnel));
    this.inner.emit("connection", tls);
  }

  private contextFor(host: string): SecureContext | undefined {
    let context = this.contexts.get(host);
    if (!context) {
      const leaf = this.o.ca.leaf(host);
      if (!leaf) return undefined;
      context = createSecureContext({ cert: leaf.certPem, key: leaf.key.export({ type: "pkcs8", format: "pem" }), minVersion: "TLSv1.2" });
      this.contexts.set(host, context);
    }
    return context;
  }

  private onRequest(req: IncomingMessage, res: ServerResponse): void {
    res.shouldKeepAlive = false;
    const tunnel = this.byTls.get(req.socket as TLSSocket);
    if (!tunnel) return answer(res, 400, "form");
    // One request per tunnel: a second one (pipelined or after the first) is refused.
    if (tunnel.used) return answer(res, 400, "pipelined");
    tunnel.used = true;
    if (headerValues(req.rawHeaders, "transfer-encoding").length) return this.refuse(res, 400, "header");
    const declared = headerValues(req.rawHeaders, "content-length");
    if (declared.length === 1 && Number(declared[0]) > MAX_BODY_BYTES) return this.refuse(res, 413, "too_large");

    const chunks: Buffer[] = [];
    let size = 0;
    let over = false;
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        over = true;
        req.destroy();
        this.refuse(res, 413, "too_large");
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      if (over) return;
      const tls = req.socket as TLSSocket;
      const n = normalize(
        { method: req.method ?? "", target: req.url ?? "", httpVersion: req.httpVersion, rawHeaders: req.rawHeaders, body: Buffer.concat(chunks) },
        { authority: tunnel.authority, servername: typeof tls.servername === "string" ? tls.servername : undefined },
        this.o.policy,
      );
      if (!n.ok) return this.refuse(res, n.status, n.reason);
      void this.dispatch(tunnel, n, res);
    });
  }

  private refuse(res: ServerResponse, status: number, reason: string): void {
    this.o.journal.deny(reason);
    answer(res, status, reason);
  }

  private async dispatch(tunnel: TunnelState, n: { method: string; path: string; origin: string; head: string; body: Buffer }, res: ServerResponse): Promise<void> {
    const { turn } = tunnel;
    const turnDials = this.pending.get(turn) ?? new Set<AbortController>();
    if (turnDials.size >= this.o.maxPendingDialsPerTurn || this.pendingCount >= this.o.maxPendingDials) return this.refuse(res, 503, "dials");
    const origin = this.o.origins.get(n.origin)!;
    const controller = new AbortController();
    turnDials.add(controller);
    this.pending.set(turn, turnDials);
    this.pendingCount += 1;
    let upstream: Upstream;
    try {
      upstream = await this.dial(origin, controller.signal);
    } catch {
      return this.refuse(res, 502, "dial");
    } finally {
      turnDials.delete(controller);
      if (turnDials.size === 0) this.pending.delete(turn);
      this.pendingCount -= 1;
    }
    this.upstreams.add(upstream);
    upstream.socket.on("close", () => this.upstreams.delete(upstream));
    if (controller.signal.aborted || this.closed || !this.tunnels.has(tunnel) || res.destroyed) {
      upstream.reset();
      return this.refuse(res, 503, "turn_closed");
    }
    this.send(tunnel, n, upstream, res);
  }

  /** admit → journal.begin → write, in one synchronous function: nothing may be awaited here. */
  private send(tunnel: TunnelState, n: { method: string; path: string; origin: string; head: string; body: Buffer }, upstream: Upstream, res: ServerResponse): void {
    const { gate, journal } = this.o;
    const { socket } = upstream;
    if (!socket.writable) {
      upstream.reset();
      return this.refuse(res, 502, "dial");
    }
    const decision = gate.admit({ turn: tunnel.turn, origin: n.origin, method: n.method }, this.clocks());
    if (!decision.ok) {
      upstream.reset();
      return this.refuse(res, 503, decision.reason);
    }
    const seq = decision.seq;
    journal.begin(seq, { turn: tunnel.turn, origin: n.origin, method: n.method, path: n.path });
    socket.write(Buffer.concat([Buffer.from(n.head, "latin1"), n.body]), (error) => {
      if (error) return;
      journal.accept(seq);
      gate.resolve(seq, true);
    });
    this.relay(seq, n.method, upstream, res);
  }

  private relay(seq: number, method: string, upstream: Upstream, res: ServerResponse): void {
    const { gate, journal } = this.o;
    const { socket } = upstream;
    let finished = false;
    const finish = () => {
      if (finished) return;
      finished = true;
      gate.finish(seq);
    };
    const reader = new ResponseReader(method, {
      head: (head) => {
        journal.receive(seq);
        gate.resolve(seq, true);
        const headers: [string, string][] = head.headers.filter(([name]) => !HOP_HEADERS.has(name.toLowerCase()));
        res.writeHead(head.status, head.statusText, headers.flat());
      },
      data: (chunk) => res.write(chunk),
      end: () => {
        finish();
        res.end();
        socket.destroy();
      },
      error: () => {
        finish();
        upstream.reset();
        if (!res.headersSent) answer(res, 502, "upstream");
        else res.destroy();
      },
    });
    socket.on("data", (chunk: Buffer) => reader.push(chunk));
    socket.on("end", () => reader.end());
    socket.on("error", () => undefined);
    socket.on("close", () => {
      if (!reader.done) reader.end();
      finish();
    });
    res.on("close", () => {
      if (!reader.done) upstream.reset();
    });
  }

  private dropTunnel(t: TunnelState): void {
    this.tunnels.delete(t);
    t.tls?.destroy();
    t.client.destroy();
  }
}

function headerValues(raw: readonly string[], name: string): string[] {
  const out: string[] = [];
  for (let i = 0; i + 1 < raw.length; i += 2) if (raw[i]!.toLowerCase() === name) out.push(raw[i + 1]!);
  return out;
}

function answer(res: ServerResponse, status: number, reason: string): void {
  if (res.headersSent || res.destroyed) {
    res.destroy();
    return;
  }
  res.shouldKeepAlive = false;
  res.writeHead(status, { [DENIED_HEADER]: reason, "content-length": "0", connection: "close" });
  res.end();
}

function rawRefuse(socket: Duplex, status: number, reason: string, extra = ""): void {
  socket.end(`HTTP/1.1 ${status} Refused\r\n${DENIED_HEADER}: ${reason}\r\n${extra}content-length: 0\r\nconnection: close\r\n\r\n`);
  socket.on("error", () => socket.destroy());
}
