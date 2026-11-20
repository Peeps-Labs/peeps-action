/**
 * The gate's proxy (plan v3 §5). The journey's only exit is the relay to this proxy's Unix
 * socket. Each request arrives as an HTTP CONNECT carrying the turn's credential, for one
 * approved origin; the proxy terminates the journey's TLS with the run CA's leaf for that host,
 * reads exactly one request, rebuilds it (`normalize`), and has the gate debit it (`permit`,
 * then `journal.begin`) before anything reaches the target, not even a TCP SYN (e4 plan v3
 * §2.6). It then dials the origin itself, checking the permit at TCP and at TLS start
 * (`checkDial`), and in one synchronous step with nothing awaited between them:
 *
 *     clocks() → handoff → journal.attempt → socket.write(head + body)
 *
 * A dial or handoff that fails keeps its debit, unattempted, and is answered as a cut. The
 * HTTP handoff may still be queued by the socket, so revocation resets the underlying TCP
 * connection. Whenever the gate answers `lease`, `onLeaseExpired` is called.
 *
 * Every refusal on a tunnel is terminal for it: a second request, Upgrade, Expect or a nested
 * CONNECT revokes the tunnel, its dial and its upstream. Redirects are passed back, never
 * followed; nothing is retried; every request gets a fresh upstream socket, to the address
 * pinned for its origin on first use. Tunnels, connections, dials and response buffering are
 * bounded, and every stage has a deadline. `closeTurn` and `close()` reset upstream sockets at
 * once (RST: bytes still in the kernel are dropped, not sent).
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { isIP, type Socket } from "node:net";
import type { Duplex } from "node:stream";
import { TLSSocket, createSecureContext, type SecureContext } from "node:tls";
import type { Clocks, Denied, Gate, Permit } from "./admission";
import type { RunCa } from "./ca";
import type { Journal } from "./journal";
import { MAX_BODY_BYTES, MAX_HEADERS, normalize, parseAuthority, validatePolicy, type Authority, type RequestPolicy } from "./normalize";
import { boundedLookup, canonical, checkedAddresses, connectVerified, DialRefused, reachable, untilAbort, type ApprovedOrigin, type DialOptions, type DialReady, type Upstream } from "./resolve";
import { ResponseReader, ResponseTooLarge } from "./response";

/** The header that names why the gate answered instead of the target. */
export const DENIED_HEADER = "x-peeps-load-denied";
/** The header that names why the gate ended an exchange it had admitted: final, never re-sent. */
export const CUT_HEADER = "x-peeps-load-cut";
/** On a `rate` denial: how long until the gate could admit again. */
export const RETRY_HEADER = "x-peeps-load-retry-after-ms";

/** Response headers never passed back: the proxy frames its own answer, and only the gate speaks for the gate. */
const HOP_HEADERS = new Set(["connection", "keep-alive", "proxy-connection", "transfer-encoding", "te", "trailer", "upgrade", "content-length", DENIED_HEADER, CUT_HEADER, RETRY_HEADER]);
/** A HEAD response's length is what it asked for: kept. */
const HEAD_HOP_HEADERS = new Set([...HOP_HEADERS].filter((h) => h !== "content-length"));

/** Dial `origin`; `pinned`, when set, is the only address to use. */
/** TCP and TLS must each call `ready` at their start boundary. */
export type Dial = (origin: ApprovedOrigin, signal: AbortSignal, pinned: string | undefined, ready?: DialReady) => Promise<Upstream>;

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
  /** How long a request may wait behind its origin's first dial, before its own dial starts. */
  queueMs: number;
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
  queueMs: 10_000,
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
  /** Read at each check: `sharedClocks` in production, a seam in tests. */
  clocks: () => Clocks;
  /**
   * Called whenever the gate answers `lease` (at a permit, a dial boundary or a handoff): the
   * supervisor's terminate. It may close this proxy re-entrantly.
   */
  onLeaseExpired(): void;
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
  dispatching?: boolean;
  dial?: AbortController;
  finish?: (reason: string) => void;
  /** Request body bytes this tunnel holds, counted in the run-wide budget. */
  bodyBytes: number;
}

export interface DialSeams {
  /** Tests only: a resolver for fixture names. */
  lookup?: DialOptions["lookup"];
  maxLookups?: number;
  /** Tests only: the fixture CA. */
  ca?: readonly string[];
  /** Tests only: where an address is actually connected (the fixture sink). */
  connect?: typeof connectVerified;
}

/** The production dial. One checked IPv4 literal and one TCP attempt per paid ticket. */
export function makeDial(seams: DialSeams = {}): Dial {
  const connect = seams.connect ?? connectVerified;
  const lookup = boundedLookup(seams.maxLookups ?? DEFAULT_PROXY_LIMITS.maxPendingDials, seams.lookup);
  return async (origin, signal, pinned, ready) => {
    const address = pinned ?? (await checkedAddresses(origin, { lookup, signal }))[0]!;
    // Check pins and fresh answers at the boundary: the runner's own addresses can change.
    if (isIP(address) !== 4 || !reachable(address, origin)) {
      throw new DialRefused("address", `${origin.host}: its selected address is no longer reachable`);
    }
    if (signal.aborted || (ready && !ready())) throw new DialRefused("aborted", origin.host);
    return connect(address, origin, { ca: seams.ca, signal, ready });
  };
}

export class GateProxy {
  readonly server: Server;
  private readonly inner: Server;
  private readonly limits: ProxyLimits;
  private readonly connections = new Set<Duplex>();
  private readonly tunnels = new Set<TunnelState>();
  private readonly tunnelsPerTurn = new Map<number, number>();
  private readonly byTls = new WeakMap<object, TunnelState>();
  private readonly work = new Set<Promise<unknown>>();
  private readonly pending = { run: 0, turn: new Map<number, number>(), origin: new Map<string, number>() };
  private readonly pins = new Map<string, string>();
  private readonly firstDials = new Map<string, Promise<void>>();
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
    this.clocks = o.clocks;
    this.dial = o.dial ?? makeDial({ maxLookups: this.limits.maxPendingDials });
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

  /** The verified address each origin was pinned to on its first admitted request. */
  get pinned(): ReadonlyMap<string, string> {
    return this.pins;
  }

  /** Revoke a turn: the gate stops admitting it, its dials are abandoned, its tunnels and upstreams reset now. */
  closeTurn(turn: number): void {
    this.closedTurns.add(turn);
    this.o.gate.closeTurn(turn);
    for (const t of [...this.tunnels]) if (t.turn === turn) this.revoke(t);
  }

  /** Stop the gate and reset every socket, tunnel and dial; await the listener and owned work. */
  close(): Promise<void> {
    // Every caller waits on the same close.
    this.closing ??= this.shutDown();
    return this.closing;
  }

  private async shutDown(): Promise<void> {
    this.closed = true;
    this.o.gate.stop();
    for (const t of [...this.tunnels]) this.revoke(t);
    for (const s of this.connections) s.destroy();
    await new Promise<void>((resolve) => {
      if (!this.server.listening) return resolve();
      this.server.close(() => resolve());
    });
    // A settling dial can hand over a TCP handle after cancellation. Its closure is
    // tracked before the dispatch promise settles and included in the next iteration.
    while (this.work.size > 0) await Promise.allSettled(this.work);
  }

  private trackWork(work: Promise<unknown>): void {
    this.work.add(work);
    const done = () => this.work.delete(work);
    void work.then(done, done);
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
      const body = Buffer.concat(chunks);
      chunks.length = 0;
      const n = normalize(
        { method: req.method ?? "", target: req.url ?? "", httpVersion: req.httpVersion, rawHeaders: req.rawHeaders, body },
        { authority: tunnel.authority, servername: typeof tls.servername === "string" ? tls.servername : undefined },
        this.o.policy,
      );
      if (!n.ok) {
        this.release(tunnel);
        return this.refuse(res, n.status, n.reason);
      }
      tunnel.dispatching = true;
      this.trackWork(this.dispatch(tunnel, n, res).then(
        (writing) => {
          tunnel.dispatching = false;
          if (!writing) this.release(tunnel);
        },
        () => {
          tunnel.dispatching = false;
          if (!tunnel.finish) this.release(tunnel);
          this.revoke(tunnel);
        },
      ));
    });
  }

  private async dispatch(tunnel: TunnelState, n: Prepared, res: ServerResponse): Promise<boolean | void> {
    const { turn } = tunnel;
    const { gate, journal } = this.o;
    const turnDials = this.pending.turn.get(turn) ?? 0;
    if (turnDials >= this.limits.maxPendingDialsPerTurn || this.pending.run >= this.limits.maxPendingDials) return this.refuse(res, 503, "dials");
    // The debit, before anything reaches the target, not even a TCP SYN (I2).
    const t = this.clocks();
    const permitted = gate.permit({ turn, origin: n.origin, method: n.method }, t);
    if (!permitted.ok) {
      this.denied(res, permitted);
      return this.expiredIf(permitted);
    }
    const { permit } = permitted;
    journal.begin(permit.seq, { turn, origin: n.origin, method: n.method, path: n.path, monoMs: t.monoMs });
    let releaseFirstDial: (() => void) | undefined;
    const origin = this.o.origins.get(n.origin)!;
    const controller = new AbortController();
    tunnel.dial = controller;
    let timedOut = false;
    const deadline = (ms: number) => {
      const timer = setTimeout(() => {
        timedOut = true;
        controller.abort();
      }, ms);
      timer.unref();
      return timer;
    };
    // Waiting behind the origin's first dial has its own deadline, and the dial its own after it.
    let timer = deadline(this.limits.queueMs);
    this.pending.run += 1;
    this.pending.turn.set(turn, turnDials + 1);
    this.pending.origin.set(n.origin, (this.pending.origin.get(n.origin) ?? 0) + 1);
    let upstream: Upstream;
    let dialDenial: Denied | undefined;
    try {
      const ready: DialReady = (boundary) => {
        if (this.closed || tunnel.revoked || res.destroyed) return false;
        dialDenial = gate.checkDial(permit, this.clocks(), boundary);
        if (dialDenial?.reason === "lease") this.o.onLeaseExpired();
        return dialDenial === undefined;
      };
      while (!this.pins.has(n.origin)) {
        const first = this.firstDials.get(n.origin);
        if (first === undefined) {
          let release!: () => void;
          this.firstDials.set(n.origin, new Promise<void>((resolve) => { release = resolve; }));
          releaseFirstDial = () => {
            this.firstDials.delete(n.origin);
            release();
          };
          break;
        }
        await untilAbort(first, controller.signal, origin.host);
      }
      clearTimeout(timer);
      timer = deadline(this.limits.dialMs);
      if (controller.signal.aborted || !ready()) throw new DialRefused("aborted", origin.host);
      upstream = await this.dial(origin, controller.signal, this.pins.get(n.origin), ready);
      this.trackWork(upstream.closed);
    } catch {
      releaseFirstDial?.();
      const reason = this.closed ? "stopped" : this.closedTurns.has(turn) ? "turn_closed" : tunnel.revoked ? "revoked" : dialDenial ? dialDenial.reason : timedOut ? "dial_timeout" : "dial";
      return this.cutUnsent(res, permit, reason, dialDenial || this.closed || tunnel.revoked || timedOut ? 503 : 502);
    } finally {
      clearTimeout(timer);
      tunnel.dial = undefined;
      this.pending.run -= 1;
      decrement(this.pending.turn, turn);
      decrement(this.pending.origin, n.origin);
    }
    try {
      if (this.closed || tunnel.revoked || controller.signal.aborted || res.destroyed) {
        upstream.reset();
        return this.cutUnsent(res, permit, this.closed ? "stopped" : this.closedTurns.has(turn) ? "turn_closed" : "revoked");
      }
      const address = canonical(upstream.address);
      const pin = this.pins.get(n.origin);
      if (pin !== undefined && address !== pin) {
        upstream.reset();
        return this.cutUnsent(res, permit, "pin", 502);
      }
      try {
        return this.send(tunnel, n, upstream, res, permit, address);
      } catch (error) {
        upstream.reset();
        throw error;
      }
    } finally {
      releaseFirstDial?.();
    }
  }

  /** A debited request whose bytes never left: its debit stays, unattempted, and the gate answers a cut. */
  private cutUnsent(res: ServerResponse, permit: Permit, reason: string, status = 503): void {
    const { gate, journal } = this.o;
    gate.abandon(permit);
    journal.cut(permit.seq, reason);
    journal.finish(permit.seq);
    this.answer(res, status, CUT_HEADER, reason);
  }

  /** `onLeaseExpired` after a `lease` answer; last, since it may close the proxy. */
  private expiredIf(d: Denied): void {
    if (d.reason === "lease") this.o.onLeaseExpired();
  }

  /**
   * A fresh sample → handoff → journal.attempt → write, in one synchronous function: nothing
   * may be awaited or deferred here.
   */
  private send(tunnel: TunnelState, n: Prepared, upstream: Upstream, res: ServerResponse, permit: Permit, address: string): boolean | void {
    const { gate, journal } = this.o;
    if (this.closed || tunnel.revoked || !upstream.socket.writable) {
      upstream.reset();
      return this.cutUnsent(res, permit, this.closed ? "stopped" : "revoked");
    }
    const seq = permit.seq;
    const wire = this.o.seqHeader
      ? Buffer.concat([Buffer.from(n.head.replace(/\r\n\r\n$/, `\r\n${this.o.seqHeader}: ${seq}\r\n\r\n`), "latin1"), n.body])
      : n.body.length ? Buffer.concat([Buffer.from(n.head, "latin1"), n.body]) : Buffer.from(n.head, "latin1");
    const denial = gate.handoff(permit, this.clocks());
    if (denial) {
      upstream.reset();
      this.cutUnsent(res, permit, denial.reason);
      return this.expiredIf(denial);
    }
    this.pins.set(n.origin, address);
    const finish = this.relay(tunnel, seq, n.method, upstream, res);
    try {
      journal.attempt(seq, address);
      upstream.socket.write(wire, (error) => {
        this.release(tunnel);
        if (error) return finish("write");
        journal.accept(seq);
        gate.resolve(seq, true);
      });
    } catch {
      finish("write");
    }
    return true;
  }

  /** Relays the response back; returns the exchange's once-only finalizer, installed before the write. */
  private relay(tunnel: TunnelState, seq: number, method: string, upstream: Upstream, res: ServerResponse): (reason?: string) => void {
    const { gate, journal } = this.o;
    const { socket } = upstream;
    let finished = false;
    let eof = false;
    let paused = false;
    const timer = setTimeout(() => finish("exchange_timeout"), this.limits.exchangeMs);
    timer.unref();
    const finish = (reason?: string) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      res.off("drain", drain);
      res.off("close", downstreamClosed);
      socket.off("data", push);
      reader.stop();
      // Even a successful write callback only confirms handoff. Keep reset ownership
      // through termination so an early target response cannot leave queued TCP bytes.
      upstream.reset();
      if (reason) journal.cut(seq, reason);
      gate.finish(seq);
      journal.finish(seq);
      if (!reason) res.end();
      else if (reason !== "revoked" && !res.headersSent) this.answer(res, 502, CUT_HEADER, reason);
      else if (!res.writableEnded) res.destroy();
    };
    const reader = new ResponseReader(method, {
      head: (h) => {
        const hop = method === "HEAD" ? HEAD_HOP_HEADERS : HOP_HEADERS;
        res.writeHead(h.status, h.statusText, h.headers.filter(([name]) => !hop.has(name.toLowerCase())).flat());
        // Sent now: a close-delimited response cut before its first body byte still shows its head.
        res.flushHeaders();
        journal.respond(seq);
      },
      data: (chunk) => {
        if (res.write(chunk)) return true;
        paused = true;
        socket.pause();
        res.once("drain", drain);
        return false;
      },
      end: () => finish(),
      error: (error) => finish(error instanceof ResponseTooLarge ? "response_too_large" : "upstream"),
    }, this.limits.maxResponseBytes);
    const drain = () => {
      paused = false;
      reader.resume();
      if (!paused && !finished) socket.resume();
    };
    const push = (chunk: Buffer) => reader.push(chunk);
    const downstreamClosed = () => finish("revoked");
    tunnel.finish = finish;
    void upstream.closed.then(() => this.release(tunnel));
    socket.on("data", push);
    socket.on("error", () => finish("upstream"));
    socket.on("end", () => {
      eof = true;
      reader.end();
    });
    socket.on("close", (hadError: boolean) => {
      if (hadError || !eof) finish("upstream");
    });
    res.on("close", downstreamClosed);
    return finish;
  }

  /** Release a body after write completion, TCP close, or a refusal before writing. */
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
    if (t.revoked) return;
    t.revoked = true;
    clearTimeout(t.setupTimer);
    this.tunnels.delete(t);
    decrement(this.tunnelsPerTurn, t.turn);
    t.dial?.abort();
    if (t.finish) t.finish("revoked");
    else if (!t.dispatching) this.release(t);
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
    this.answer(res, status, DENIED_HEADER, reason, extra);
  }

  /** The gate's answer: `DENIED_HEADER` before admission, `CUT_HEADER` for an admitted exchange it ended. */
  private answer(res: ServerResponse, status: number, header: typeof DENIED_HEADER | typeof CUT_HEADER, reason: string, extra: Record<string, string> = {}): void {
    if (res.headersSent || res.destroyed) {
      res.destroy();
      return;
    }
    res.shouldKeepAlive = false;
    res.writeHead(status, { [header]: reason, ...extra, "content-length": "0", connection: "close" });
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
