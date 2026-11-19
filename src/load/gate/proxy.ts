/**
 * The gate's proxy (plan v3 §5). The journey's only exit is the relay to this proxy's Unix
 * socket. Each request arrives as an HTTP CONNECT carrying the turn's credential, for one
 * approved origin; the proxy terminates the journey's TLS with the run CA's leaf for that host,
 * reads exactly one request, rebuilds it (`normalize`), asks the gate whether it could be
 * admitted (`reserve`, which debits nothing but spends a rate token), dials the origin itself, and then, in one
 * synchronous step with nothing awaited between them:
 *
 *     admit → journal.begin → socket.write(head + body)
 *
 * so no time passes between the gate's decision and the bytes leaving, and no TCP or TLS
 * reaches a target for a request the gate would refuse.
 *
 * Every refusal on a tunnel is terminal for it: a second request, Upgrade, Expect or a nested
 * CONNECT revokes the tunnel, its dial and its upstream. Redirects are passed back, never
 * followed; nothing is retried; every request gets a fresh upstream socket, to the address
 * pinned for its origin on first use. Tunnels, connections, dials and response buffering are
 * bounded, and every stage has a deadline. `closeTurn` and `close()` reset upstream sockets at
 * once (RST: bytes still in the kernel are dropped, not sent).
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { Socket } from "node:net";
import type { Duplex } from "node:stream";
import { TLSSocket, createSecureContext, type SecureContext } from "node:tls";
import type { Ahead, Clocks, Denied, DialTicket, Gate } from "./admission";
import type { RunCa } from "./ca";
import type { Journal } from "./journal";
import { MAX_BODY_BYTES, MAX_HEADERS, normalize, parseAuthority, validatePolicy, type Authority, type RequestPolicy } from "./normalize";
import { canonical, checkedAddresses, connectVerified, DialRefused, reachable, type ApprovedOrigin, type DialOptions, type Upstream } from "./resolve";
import { ResponseReader } from "./response";

/** The header that names why the gate answered instead of the target. */
export const DENIED_HEADER = "x-peeps-load-denied";
/** On a `rate` denial: how long until the gate could admit again. */
export const RETRY_HEADER = "x-peeps-load-retry-after-ms";

/** Response headers never passed back: the proxy frames its own answer. */
const HOP_HEADERS = new Set(["connection", "keep-alive", "proxy-connection", "transfer-encoding", "te", "trailer", "upgrade", "content-length"]);

/** Dial `origin`; `pinned`, when set, is the only address to use. */
/** `ready` is asked just before the TCP connect; false abandons the dial with nothing sent. */
export type Dial = (origin: ApprovedOrigin, signal: AbortSignal, pinned: string | undefined, ready?: () => boolean) => Promise<Upstream>;

export interface ProxyLimits {
  /** Tunnels open at once, per turn and for the run. */
  maxTunnelsPerTurn: number;
  maxTunnels: number;
  /** Connections to the proxy's socket at once, CONNECT not yet answered included. */
  maxConnections: number;
  /** Dials in progress, per turn and for the run. */
  maxPendingDialsPerTurn: number;
  maxPendingDials: number;
  /** From CONNECT to the tunnel's request read in full. */
  setupMs: number;
  /** From the start of a dial to a verified connection. */
  dialMs: number;
  /** From the write to the end of the response. */
  exchangeMs: number;
  /** A response body larger than this is cut off. */
  maxResponseBytes: number;
  /** Request body bytes held in memory across every tunnel at once. */
  maxBufferedBodyBytes: number;
}

export const DEFAULT_PROXY_LIMITS: ProxyLimits = {
  maxTunnelsPerTurn: 8,
  maxTunnels: 512,
  maxConnections: 1024,
  maxPendingDialsPerTurn: 4,
  maxPendingDials: 64,
  setupMs: 10_000,
  dialMs: 10_000,
  exchangeMs: 60_000,
  maxResponseBytes: 64 * 1024 * 1024,
  maxBufferedBodyBytes: 32 * 1024 * 1024,
};

export interface ProxyOptions {
  gate: Gate;
  journal: Journal;
  ca: RunCa;
  policy: RequestPolicy;
  /** Approved origins by canonical origin. */
  origins: ReadonlyMap<string, ApprovedOrigin>;
  /** The turn a `Proxy-Authorization` value belongs to, if any. */
  authorize(credential: string): number | undefined;
  limits?: Partial<ProxyLimits>;
  /** Read at each check. Defaults to `performance.now()` and `Date.now()`. */
  clocks?: () => Clocks;
  /** Defaults to resolving and dialling through `resolve.ts`; tests inject fixture trust. */
  dial?: Dial;
  /** Tests only: a header carrying each request's seq, so a sink's receipts can be joined to the journal. */
  seqHeader?: string;
}

interface Prepared {
  method: string;
  path: string;
  origin: string;
  head: string;
  body: Buffer;
}

interface TunnelState {
  turn: number;
  authority: Authority;
  client: Duplex;
  tls?: TLSSocket;
  used: boolean;
  revoked: boolean;
  setupTimer?: NodeJS.Timeout;
  dial?: AbortController;
  upstream?: Upstream;
  /** Request body bytes this tunnel holds, counted in the run-wide budget. */
  bodyBytes: number;
}

const systemClocks = (): Clocks => ({ monoMs: performance.now(), wallMs: Date.now() });

export interface DialSeams {
  /** Tests only: a resolver for fixture names. */
  lookup?: DialOptions["lookup"];
  /** Tests only: the fixture CA. */
  ca?: readonly string[];
  /** Tests only: where an address is actually connected (the fixture sink). */
  connect?: typeof connectVerified;
}

/**
 * The production dial. A pinned origin goes to its pinned address with no lookup. Before the
 * pin, dials share one lookup per origin until a connect on it settles, so the customer's DNS cannot spread
 * a run's first dials across addresses; the shared answer is dropped once it settles.
 */
export function makeDial(seams: DialSeams = {}): Dial {
  const connect = seams.connect ?? connectVerified;
  const resolving = new Map<string, Promise<string[]>>();
  const drops = new WeakMap<Promise<string[]>, () => void>();
  return async (origin, signal, pinned, ready) => {
    let address: string;
    if (pinned) {
      // The pin is checked again on every dial: the runner's own addresses can change.
      if (!reachable(pinned, origin)) throw new DialRefused("address", `${origin.host}: its pinned address is no longer reachable`);
      address = pinned;
    } else {
      const key = `${origin.host}:${origin.port}`;
      let addresses = resolving.get(key);
      if (!addresses) {
        // Not tied to one dial's signal: another dial may be waiting on the same answer. One
        // lookup at a time per approved origin, so lookups are bounded by the origins.
        const answer = checkedAddresses(origin, { lookup: seams.lookup });
        addresses = answer;
        resolving.set(key, answer);
        // Kept until a connect on it settles (by then the origin is usually pinned); a failed
        // lookup is dropped at once.
        drops.set(answer, () => {
          if (resolving.get(key) === answer) resolving.delete(key);
        });
        answer.catch(() => drops.get(answer)!());
      }
      const answer = addresses;
      const drop = drops.get(answer)!;
      try {
        // One address per dial: a dial spends one rate token and makes at most one TCP attempt.
        address = (await Promise.race([answer, abortedSignal(signal, origin.host)]))[0]!;
        // The lease and the turn are checked again just before the SYN: DNS may have taken a while.
        if (signal.aborted || (ready && !ready())) throw new DialRefused("aborted", origin.host);
      } catch (error) {
        drop();
        throw error;
      }
      const connecting = connect(address, origin, { ca: seams.ca, signal });
      connecting.then(drop, drop);
      return connecting;
    }
    if (signal.aborted || (ready && !ready())) throw new DialRefused("aborted", origin.host);
    return connect(address, origin, { ca: seams.ca, signal });
  };
}

function abortedSignal(signal: AbortSignal, host: string): Promise<never> {
  return new Promise((_resolve, reject) => {
    const fail = () => reject(new DialRefused("aborted", host));
    if (signal.aborted) fail();
    else signal.addEventListener("abort", fail, { once: true });
  });
}

export class GateProxy {
  readonly server: Server;
  private readonly inner: Server;
  private readonly limits: ProxyLimits;
  private readonly connections = new Set<Duplex>();
  private readonly tunnels = new Set<TunnelState>();
  private readonly tunnelsPerTurn = new Map<number, number>();
  private readonly byTls = new WeakMap<object, TunnelState>();
  private readonly upstreams = new Map<Upstream, number>();
  private readonly pending = { run: 0, turn: new Map<number, number>(), origin: new Map<string, number>() };
  private readonly pins = new Map<string, string>();
  private readonly closedTurns = new Set<number>();
  private readonly contexts = new Map<string, SecureContext>();
  private readonly clocks: () => Clocks;
  private readonly dial: Dial;
  private closed = false;
  private buffered = 0;
  private closing: Promise<void> | undefined;

  constructor(private readonly o: ProxyOptions) {
    validatePolicy(o.policy);
    this.limits = { ...DEFAULT_PROXY_LIMITS, ...o.limits };
    this.clocks = o.clocks ?? systemClocks;
    this.dial = o.dial ?? makeDial();
    // maxHeadersCount 0: Node keeps every header, so nothing is hidden from the checks here
    // (with a count cap it drops the excess from rawHeaders yet still acts on their framing).
    this.server = createServer({ maxHeaderSize: 8192, insecureHTTPParser: false });
    this.server.maxHeadersCount = 0;
    this.server.maxConnections = this.limits.maxConnections;
    this.server.on("connection", (s: Duplex) => this.track(s));
    this.server.on("connect", (req: IncomingMessage, socket: Duplex, head: Buffer) => this.onConnect(req, socket, head));
    this.server.on("upgrade", (_req: IncomingMessage, socket: Duplex) => this.rawRefuse(socket, 400, "upgrade"));
    this.server.on("checkContinue", (_req, res) => this.refuse(res, 417, "expect"));
    this.server.on("checkExpectation", (_req, res) => this.refuse(res, 417, "expect"));
    this.server.on("request", (_req, res) => this.refuse(res, 405, "form"));
    this.server.on("clientError", (_e, socket: Duplex) => socket.destroy());

    this.inner = createServer({ maxHeaderSize: 16384, joinDuplicateHeaders: false, insecureHTTPParser: false, requestTimeout: 0 });
    this.inner.maxHeadersCount = 0;
    this.inner.on("request", (req, res) => this.onRequest(req, res));
    for (const event of ["upgrade", "connect"] as const) {
      this.inner.on(event, (req: IncomingMessage, socket: Duplex) => this.revokeFor(req.socket, socket, event === "upgrade" ? "upgrade" : "form", 400));
    }
    for (const event of ["checkContinue", "checkExpectation"] as const) {
      this.inner.on(event, (req: IncomingMessage, res: ServerResponse) => {
        this.refuse(res, 417, "expect");
        const t = this.byTls.get(req.socket);
        if (t) this.revoke(t);
      });
    }
    this.inner.on("clientError", (_e, socket: Duplex) => {
      const t = this.byTls.get(socket);
      if (t) this.revoke(t);
      else socket.destroy();
    });
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

  /** Feed an accepted connection (production uses `listen`). */
  accept(socket: Duplex): void {
    this.server.emit("connection", socket);
  }

  /** Dials in progress for the run. */
  get pendingDials(): number {
    return this.pending.run;
  }

  get openTunnels(): number {
    return this.tunnels.size;
  }

  /** The address each origin was pinned to on its first successful dial. */
  get pinned(): ReadonlyMap<string, string> {
    return this.pins;
  }

  /** Revoke a turn: the gate stops admitting it, its dials are abandoned, its tunnels and upstreams reset now. */
  closeTurn(turn: number): void {
    this.closedTurns.add(turn);
    this.o.gate.closeTurn(turn);
    for (const t of [...this.tunnels]) if (t.turn === turn) this.revoke(t);
    for (const [u, owner] of this.upstreams) if (owner === turn) u.reset();
  }

  /** Stop the gate and reset every socket, tunnel and dial; resolves once the server is closed. */
  close(): Promise<void> {
    // Every caller waits on the same close.
    this.closing ??= this.shutDown();
    return this.closing;
  }

  private shutDown(): Promise<void> {
    this.closed = true;
    this.o.gate.stop();
    for (const t of [...this.tunnels]) this.revoke(t);
    for (const u of this.upstreams.keys()) u.reset();
    for (const s of this.connections) s.destroy();
    return new Promise((resolve) => {
      if (!this.server.listening) return resolve();
      this.server.close(() => resolve());
    });
  }

  private track(s: Duplex): void {
    this.connections.add(s);
    s.on("close", () => this.connections.delete(s));
  }

  private onConnect(req: IncomingMessage, client: Duplex, head: Buffer): void {
    if (this.closed) return this.rawRefuse(client, 503, "stopped");
    if (req.rawHeaders.length > 2 * MAX_HEADERS) return this.rawRefuse(client, 431, "header");
    const credentials = headerValues(req.rawHeaders, "proxy-authorization");
    const turn = credentials.length === 1 ? this.o.authorize(credentials[0]!) : undefined;
    if (turn === undefined) return this.rawRefuse(client, 407, "credential", "proxy-authenticate: Basic\r\n");
    if (this.closedTurns.has(turn)) return this.rawRefuse(client, 403, "turn_closed");
    const authority = parseAuthority(req.url ?? "");
    if (!authority || !this.o.origins.has(authority.origin)) return this.rawRefuse(client, 403, "origin");
    const context = this.contextFor(authority.host);
    if (!context) return this.rawRefuse(client, 403, "origin");
    const perTurn = this.tunnelsPerTurn.get(turn) ?? 0;
    if (perTurn >= this.limits.maxTunnelsPerTurn || this.tunnels.size >= this.limits.maxTunnels) return this.rawRefuse(client, 503, "tunnels");

    const tunnel: TunnelState = { turn, authority, client, used: false, revoked: false, bodyBytes: 0 };
    this.tunnels.add(tunnel);
    this.tunnelsPerTurn.set(turn, perTurn + 1);
    tunnel.setupTimer = setTimeout(() => {
      this.o.journal.deny("setup_timeout");
      this.revoke(tunnel);
    }, this.limits.setupMs);
    tunnel.setupTimer.unref();
    client.on("close", () => this.revoke(tunnel));
    client.on("error", () => client.destroy());
    if (head.length) client.unshift(head);
    client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
    const tls = new TLSSocket(client as Socket, { isServer: true, secureContext: context, ALPNProtocols: ["http/1.1"] });
    tunnel.tls = tls;
    this.byTls.set(tls, tunnel);
    tls.on("error", () => this.revoke(tunnel));
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
    const tunnel = this.byTls.get(req.socket);
    if (!tunnel || tunnel.revoked) return this.refuse(res, 400, "form");
    // One request per tunnel. A second one (pipelined, or sent before the first was answered)
    // revokes the tunnel, the first request's dial and its upstream included.
    if (tunnel.used) {
      this.refuse(res, 400, "pipelined");
      return this.revoke(tunnel);
    }
    tunnel.used = true;
    if (headerValues(req.rawHeaders, "transfer-encoding").length) return this.refuse(res, 400, "header");
    const declared = headerValues(req.rawHeaders, "content-length");
    if (declared.length === 1 && Number(declared[0]) > MAX_BODY_BYTES) return this.refuse(res, 413, "too_large");

    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (chunk: Buffer) => {
      if (tunnel.revoked) return;
      size += chunk.length;
      // Bodies wait in memory through setup and the dial: a run-wide budget bounds them.
      if (this.buffered + chunk.length > this.limits.maxBufferedBodyBytes) {
        this.refuse(res, 503, "memory");
        this.revoke(tunnel);
        return;
      }
      this.buffered += chunk.length;
      tunnel.bodyBytes += chunk.length;
      // Node holds the body to its Content-Length, checked above; this guards that assumption.
      if (size > MAX_BODY_BYTES) {
        this.refuse(res, 413, "too_large");
        this.revoke(tunnel);
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      if (tunnel.revoked || size > MAX_BODY_BYTES) return;
      clearTimeout(tunnel.setupTimer);
      const tls = req.socket as TLSSocket;
      const n = normalize(
        { method: req.method ?? "", target: req.url ?? "", httpVersion: req.httpVersion, rawHeaders: req.rawHeaders, body: Buffer.concat(chunks) },
        { authority: tunnel.authority, servername: typeof tls.servername === "string" ? tls.servername : undefined },
        this.o.policy,
      );
      if (!n.ok) {
        this.release(tunnel);
        return this.refuse(res, n.status, n.reason);
      }
      void this.dispatch(tunnel, n, res).finally(() => this.release(tunnel));
    });
  }

  private ahead(turn: number, origin: string): Ahead {
    return { run: this.pending.run, turn: this.pending.turn.get(turn) ?? 0, origin: this.pending.origin.get(origin) ?? 0 };
  }

  private async dispatch(tunnel: TunnelState, n: Prepared, res: ServerResponse): Promise<void> {
    const { turn } = tunnel;
    const { gate } = this.o;
    const turnDials = this.pending.turn.get(turn) ?? 0;
    if (turnDials >= this.limits.maxPendingDialsPerTurn || this.pending.run >= this.limits.maxPendingDials) return this.refuse(res, 503, "dials");
    // Nothing reaches the target, not even a TCP SYN, for a request the gate would refuse now;
    // and each dial spends a rate token for good, however it ends.
    const reserved = gate.reserve({ turn, origin: n.origin, method: n.method }, this.clocks(), this.ahead(turn, n.origin));
    if (!reserved.ok) return this.denied(res, reserved);
    const { ticket } = reserved;
    try {
      const origin = this.o.origins.get(n.origin)!;
      const controller = new AbortController();
      tunnel.dial = controller;
      let timedOut = false;
      const timer = setTimeout(() => {
        timedOut = true;
        controller.abort();
      }, this.limits.dialMs);
      timer.unref();
      this.pending.run += 1;
      this.pending.turn.set(turn, turnDials + 1);
      this.pending.origin.set(n.origin, (this.pending.origin.get(n.origin) ?? 0) + 1);
      let upstream: Upstream;
      let lapsed: Denied | undefined;
      try {
        const request = { turn, origin: n.origin, method: n.method };
        const ready = () => {
          if (this.closed || tunnel.revoked || res.destroyed) return false;
          lapsed = gate.whyNot(request, this.clocks());
          return lapsed === undefined;
        };
        upstream = await this.dial(origin, controller.signal, this.pins.get(n.origin), ready);
      } catch {
        // The gate refused just before the connect: say why, as admit would have.
        if (lapsed && !this.closed && !tunnel.revoked) return this.denied(res, lapsed);
        return this.refuse(res, controller.signal.aborted ? 503 : 502, this.closed ? "stopped" : tunnel.revoked ? "revoked" : timedOut ? "dial_timeout" : "dial");
      } finally {
        clearTimeout(timer);
        tunnel.dial = undefined;
        this.pending.run -= 1;
        decrement(this.pending.turn, turn);
        decrement(this.pending.origin, n.origin);
      }
      if (this.closed || tunnel.revoked || controller.signal.aborted || res.destroyed) {
        upstream.reset();
        return this.refuse(res, 503, this.closed ? "stopped" : "revoked");
      }
      // Only a live, verified dial pins its origin; every later one must reach the same address.
      const pin = this.pins.get(n.origin);
      if (pin === undefined) this.pins.set(n.origin, canonical(upstream.address));
      else if (canonical(upstream.address) !== pin) {
        upstream.reset();
        return this.refuse(res, 502, "pin");
      }
      this.send(tunnel, n, upstream, res, ticket);
    } finally {
      // Spent by admit, or the dial ended without it: either way the ticket is gone, the token spent.
      gate.drop(ticket);
    }
  }

  /** admit → journal.begin → write, in one synchronous function: nothing may be awaited or deferred here. */
  private send(tunnel: TunnelState, n: Prepared, upstream: Upstream, res: ServerResponse, ticket: DialTicket): void {
    const { gate, journal } = this.o;
    if (this.closed || tunnel.revoked || !upstream.socket.writable) {
      upstream.reset();
      return this.refuse(res, 503, this.closed ? "stopped" : "revoked");
    }
    const head = Buffer.from(n.head, "latin1");
    const decision = gate.admit({ turn: tunnel.turn, origin: n.origin, method: n.method }, this.clocks(), ticket);
    if (!decision.ok) {
      upstream.reset();
      return this.denied(res, decision);
    }
    const seq = decision.seq;
    journal.begin(seq, { turn: tunnel.turn, origin: n.origin, method: n.method, path: n.path, address: upstream.address });
    const wire = this.o.seqHeader ? Buffer.from(n.head.replace(/\r\n\r\n$/, `\r\n${this.o.seqHeader}: ${seq}\r\n\r\n`), "latin1") : head;
    const write = { accepted: false };
    const finish = this.relay(tunnel, seq, n.method, upstream, res, write);
    try {
      upstream.socket.write(n.body.length ? Buffer.concat([wire, n.body]) : wire, (error) => {
        if (error) return;
        write.accepted = true;
        journal.accept(seq);
        gate.resolve(seq, true);
      });
    } catch {
      upstream.reset();
      finish();
    }
  }

  /** Relays the response back; returns the exchange's once-only finalizer, installed before the write. */
  private relay(tunnel: TunnelState, seq: number, method: string, upstream: Upstream, res: ServerResponse, write: { readonly accepted: boolean }): () => void {
    const { gate, journal } = this.o;
    const { socket } = upstream;
    tunnel.upstream = upstream;
    this.upstreams.set(upstream, tunnel.turn);
    let finished = false;
    let bytes = 0;
    const timer = setTimeout(() => {
      journal.cut(seq, "exchange_timeout");
      reader.abort(new Error("exchange deadline"));
      upstream.reset();
    }, this.limits.exchangeMs);
    timer.unref();
    const finish = () => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      this.upstreams.delete(upstream);
      gate.finish(seq);
      journal.finish(seq);
      if (!reader.done) upstream.reset();
      if (!res.writableEnded) res.destroy();
    };
    const reader = new ResponseReader(method, {
      head: (h) => {
        journal.receive(seq);
        res.writeHead(h.status, h.statusText, h.headers.filter(([name]) => !HOP_HEADERS.has(name.toLowerCase())).flat());
      },
      data: (chunk) => {
        if (finished) return;
        bytes += chunk.length;
        if (bytes > this.limits.maxResponseBytes) {
          journal.cut(seq, "response_too_large");
          return finish();
        }
        // Backpressure: a journey that stops reading stops the upstream, not the supervisor's memory.
        if (!res.write(chunk)) {
          socket.pause();
          res.once("drain", () => socket.resume());
        }
      },
      end: () => {
        if (finished) return;
        res.end();
        finish();
        // An early response with the request's write still pending: reset, so unsent bytes
        // are dropped rather than flushed after the exchange is over.
        if (write.accepted) socket.destroy();
        else upstream.reset();
      },
      error: () => {
        if (finished) return;
        journal.cut(seq, "upstream");
        if (!res.headersSent) this.answer(res, 502, "upstream");
        finish();
      },
    });
    socket.on("data", (chunk: Buffer) => reader.push(chunk));
    socket.on("end", () => reader.end());
    socket.on("close", (hadError: boolean) => {
      // Only a clean EOF ends a close-delimited body; an error or a reset is a failure.
      if (!reader.done) {
        if (hadError) reader.abort(new Error("upstream reset"));
        else reader.end();
      }
      finish();
    });
    res.on("close", finish);
    return finish;
  }

  /** Its body was written or refused: it no longer counts against the budget. */
  private release(t: TunnelState): void {
    this.buffered -= t.bodyBytes;
    t.bodyBytes = 0;
  }

  /** Request body bytes held in memory across the run. */
  get bufferedBodyBytes(): number {
    return this.buffered;
  }

  /** Revoke one tunnel: abort its dial, reset its upstream, close it. Idempotent. */
  private revoke(t: TunnelState): void {
    this.release(t);
    if (t.revoked) return;
    t.revoked = true;
    clearTimeout(t.setupTimer);
    this.tunnels.delete(t);
    decrement(this.tunnelsPerTurn, t.turn);
    t.dial?.abort();
    t.upstream?.reset();
    t.tls?.destroy();
    t.client.destroy();
  }

  private revokeFor(tlsSocket: Duplex, socket: Duplex, reason: string, status: number): void {
    this.rawRefuse(socket, status, reason);
    const t = this.byTls.get(tlsSocket);
    if (t) this.revoke(t);
  }

  private denied(res: ServerResponse, d: Denied): void {
    this.refuse(res, 503, d.reason, d.reason === "rate" && d.retryInMs !== undefined ? { [RETRY_HEADER]: String(d.retryInMs) } : {});
  }

  private refuse(res: ServerResponse, status: number, reason: string, extra: Record<string, string> = {}): void {
    this.o.journal.deny(reason);
    this.answer(res, status, reason, extra);
  }

  /** The refusal's answer alone: for an admitted request, which is cut, never denied. */
  private answer(res: ServerResponse, status: number, reason: string, extra: Record<string, string> = {}): void {
    if (res.headersSent || res.destroyed) {
      res.destroy();
      return;
    }
    res.shouldKeepAlive = false;
    res.writeHead(status, { [DENIED_HEADER]: reason, ...extra, "content-length": "0", connection: "close" });
    res.end();
  }

  private rawRefuse(socket: Duplex, status: number, reason: string, extra = ""): void {
    this.o.journal.deny(reason);
    socket.on("error", () => socket.destroy());
    socket.end(`HTTP/1.1 ${status} Refused\r\n${DENIED_HEADER}: ${reason}\r\n${extra}content-length: 0\r\nconnection: close\r\n\r\n`);
  }
}

function decrement<K>(map: Map<K, number>, key: K): void {
  const n = (map.get(key) ?? 0) - 1;
  if (n > 0) map.set(key, n);
  else map.delete(key);
}

function headerValues(raw: readonly string[], name: string): string[] {
  const out: string[] = [];
  for (let i = 0; i + 1 < raw.length; i += 2) if (raw[i]!.toLowerCase() === name) out.push(raw[i + 1]!);
  return out;
}
