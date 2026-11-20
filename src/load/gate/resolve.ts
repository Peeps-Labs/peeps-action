/**
 * The gate's only way out (plan v3 §5). Names are resolved here, never in the jail, and only
 * for approved origins, as absolute names (no resolver search list). Every address the name
 * resolves to is classified, and the name is refused if any of them is out of reach: one public
 * and one metadata address is a refusal, not a race. Private addresses are reachable only inside
 * ranges the Owner approved for that origin, and never the runner's own interfaces.
 *
 * The connection goes to a checked literal address, with `servername` set to the approved host,
 * and is verified against Node's bundled roots only, with the name required in a DNS SAN (no
 * Common Name fallback): the job's `NODE_EXTRA_CA_CERTS`, `NODE_TLS_REJECT_UNAUTHORIZED` and
 * proxy variables play no part. A server that picks a protocol other than HTTP/1.1 by ALPN is
 * refused; one that does no ALPN speaks HTTP/1.1 and is accepted.
 *
 * The proxy pins the first address that connects for each origin for the run (`proxy.ts`).
 */
import { X509Certificate } from "node:crypto";
import { lookup as dnsLookup } from "node:dns/promises";
import { BlockList, isIP, Socket } from "node:net";
import { networkInterfaces } from "node:os";
import { connect, createSecureContext, rootCertificates, type PeerCertificate, type SecureContext, type TLSSocket } from "node:tls";

export type AddressClass =
  | "public"
  | "private"
  | "unspecified"
  | "this_network"
  | "loopback"
  | "link_local"
  | "metadata"
  | "multicast"
  | "reserved"
  | "invalid";

/** Cloud metadata services. Never reachable, whatever the Owner approved. */
const METADATA_V4 = new Set(["169.254.169.254", "168.63.129.16"]);

/** Classify one address. An IPv4-mapped address is classified as its IPv4 address; other translation forms are refused. */
export function classify(address: string): AddressClass {
  const kind = isIP(address);
  if (kind === 4) return classifyV4(v4Bytes(address));
  if (kind !== 6) return "invalid";
  const b = v6Bytes(address);
  if (!b) return "invalid";
  const zeros = (from: number, to: number) => b.slice(from, to).every((x) => x === 0);
  if (zeros(0, 10) && b[10] === 0xff && b[11] === 0xff) return classifyV4(b.slice(12)); // ::ffff:a.b.c.d
  if (zeros(0, 16)) return "unspecified";
  if (zeros(0, 15) && b[15] === 1) return "loopback";
  if (zeros(0, 8)) return "reserved"; // IPv4-compatible, SIIT ::ffff:0:0/96 and the rest of ::/64
  if (b[0] === 0xfd && b[1] === 0x00 && b[2] === 0x0e && b[3] === 0xc2) return "metadata"; // fd00:ec2::/32
  if (b[0] === 0xff) return "multicast";
  if (b[0] === 0xfe && (b[1]! & 0xc0) === 0x80) return "link_local";
  if ((b[0]! & 0xfe) === 0xfc) return "private";
  if (b[0] === 0x00 && b[1] === 0x64 && b[2] === 0xff && b[3] === 0x9b) return "reserved"; // NAT64, well-known and local-use
  if (b[0] === 0x20 && b[1] === 0x02) return "reserved"; // 6to4
  if (b[0] === 0x20 && b[1] === 0x01 && b[2]! < 0x02) return "reserved"; // 2001::/23: Teredo, benchmarking, ORCHID…
  if (b[0] === 0x20 && b[1] === 0x01 && b[2] === 0x0d && b[3] === 0xb8) return "reserved"; // documentation
  if (b[0] === 0x3f && b[1] === 0xff && (b[2]! & 0xf0) === 0x00) return "reserved"; // 3fff::/20, documentation
  if ((b[0]! & 0xe0) !== 0x20) return "reserved"; // outside global unicast 2000::/3
  return "public";
}

function classifyV4(b: number[]): AddressClass {
  const [a, c, d] = [b[0]!, b[1]!, b[2]!];
  const dotted = b.join(".");
  if (METADATA_V4.has(dotted)) return "metadata";
  if (a === 100 && c === 100) return "metadata"; // Alibaba, 100.100.0.0/16
  if (dotted === "0.0.0.0") return "unspecified";
  if (a === 0) return "this_network";
  if (a === 127) return "loopback";
  if (a === 169 && c === 254) return "link_local";
  if (a >= 224 && a <= 239) return "multicast";
  if (a >= 240) return "reserved";
  if (a === 10 || (a === 172 && c >= 16 && c <= 31) || (a === 192 && c === 168) || (a === 100 && c >= 64 && c <= 127)) return "private";
  if (a === 192 && c === 0 && (d === 0 || d === 2)) return "reserved"; // IETF protocol assignments (Oracle metadata at .0.192), TEST-NET-1
  if (a === 192 && c === 88 && d === 99) return "reserved"; // 6to4 relay
  if (a === 198 && (c === 18 || c === 19)) return "reserved"; // benchmarking
  if ((a === 198 && c === 51 && d === 100) || (a === 203 && c === 0 && d === 113)) return "reserved"; // TEST-NET-2, -3
  return "public";
}

function v4Bytes(address: string): number[] {
  return address.split(".").map(Number);
}

function v6Bytes(address: string): number[] | undefined {
  let s = address.toLowerCase();
  if (s.includes("%")) return undefined; // a zone id names a link: never an approved origin
  let tail: number[] = [];
  const colon = s.lastIndexOf(":");
  if (s.includes(".")) {
    tail = v4Bytes(s.slice(colon + 1));
    s = `${s.slice(0, colon + 1)}0:0`;
  }
  const halves = s.split("::");
  if (halves.length > 2) return undefined;
  const words = (part: string) => (part === "" ? [] : part.split(":").map((w) => parseInt(w, 16)));
  const head = words(halves[0]!);
  const back = halves.length === 2 ? words(halves[1]!) : [];
  const fill = 8 - head.length - back.length;
  if (fill < 0 || (halves.length === 1 && fill !== 0)) return undefined;
  const bytes = [...head, ...Array<number>(fill).fill(0), ...back].flatMap((w) => [w >> 8, w & 0xff]);
  if (tail.length) bytes.splice(12, 4, ...tail);
  return bytes;
}

/** The address to dial: an IPv4-mapped IPv6 address becomes its IPv4 literal. */
export function unmap(address: string): string {
  const b = isIP(address) === 6 ? v6Bytes(address) : undefined;
  if (b && b.slice(0, 10).every((x) => x === 0) && b[10] === 0xff && b[11] === 0xff) return b.slice(12).join(".");
  return address;
}

/** One spelling per address: unmapped, and IPv6 in its compressed lower-case form. */
export function canonical(address: string): string {
  const a = unmap(address);
  // A zone id names a link: left as it is, so classify() calls it invalid.
  if (isIP(a) !== 6 || a.includes("%")) return a;
  return new URL(`http://[${a}]`).hostname.slice(1, -1);
}

export interface ApprovedOrigin {
  /** Lower-case approved host name. */
  host: string;
  port: number;
  /** Private ranges (CIDR) the Owner approved for this origin. Empty: public addresses only. Metadata stays unreachable. */
  privateCidrs: readonly string[];
}

/** The runner's own addresses: never a target, whatever range the Owner approved. */
function ownAddresses(): Set<string> {
  return new Set(
    Object.values(networkInterfaces())
      .flat()
      .filter((i) => i !== undefined)
      .map((i) => canonical(i.address)),
  );
}

/** Whether an origin may reach one address. */
export function reachable(address: string, origin: Pick<ApprovedOrigin, "privateCidrs">, own: ReadonlySet<string> = ownAddresses()): boolean {
  const a = canonical(address);
  const c = classify(a);
  if (c === "public") return !own.has(a);
  if (c !== "private" || own.has(a) || origin.privateCidrs.length === 0) return false;
  const list = new BlockList();
  for (const cidr of origin.privateCidrs) {
    const [net, bits] = cidr.split("/");
    const type = isIP(net ?? "") === 6 ? "ipv6" : "ipv4";
    list.addSubnet(net!, Number(bits), type);
  }
  return list.check(a, isIP(a) === 6 ? "ipv6" : "ipv4");
}

type Addresses = readonly { address: string; family: number }[];
export type Lookup = (name: string, signal?: AbortSignal) => Promise<Addresses>;

export interface DialOptions {
  signal?: AbortSignal;
  /** Tests only: a resolver for fixture names. Gets the absolute name (with its trailing dot). */
  lookup?: Lookup;
  /** Tests only: the fixture CA, used instead of Node's bundled roots. */
  ca?: readonly string[];
}

export class DialRefused extends Error {
  constructor(
    readonly reason: "resolve" | "address" | "tls" | "alpn" | "aborted",
    detail: string,
  ) {
    super(`load gate: dial refused (${reason}): ${detail}`);
    this.name = "DialRefused";
  }
}

const systemLookup: Lookup = (name) => dnsLookup(name, { all: true, verbatim: true });

/**
 * Bound actual system work, including lookups without any remaining callers. Each caller
 * unregisters on abort so a stuck resolver does not retain a trail of canceled waiters.
 */
export function boundedLookup(limit: number, lookup: Lookup = systemLookup): Lookup {
  type Result = { addresses: Addresses } | { error: unknown };
  type Waiter = (result: Result) => void;
  const pending = new Map<string, Set<Waiter>>();
  return (name, signal) => new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new DialRefused("aborted", name));
    let waiters = pending.get(name);
    if (!waiters) {
      if (pending.size >= limit) return reject(new DialRefused("resolve", "system lookup capacity reached"));
      const group = new Set<Waiter>();
      pending.set(name, group);
      waiters = group;
      const settle = (result: Result) => {
        pending.delete(name);
        for (const waiter of group) waiter(result);
      };
      void Promise.resolve().then(() => lookup(name)).then(
        (addresses) => settle({ addresses }),
        (error: unknown) => settle({ error }),
      );
    }
    const group = waiters;
    const finish: Waiter = (result) => {
      signal?.removeEventListener("abort", abort);
      group.delete(finish);
      if ("addresses" in result) resolve(result.addresses);
      else reject(result.error);
    };
    const abort = () => finish({ error: new DialRefused("aborted", name) });
    group.add(finish);
    signal?.addEventListener("abort", abort, { once: true });
  });
}

export async function untilAbort<T>(work: Promise<T>, signal: AbortSignal | undefined, host: string): Promise<T> {
  if (!signal) return work;
  let abort!: () => void;
  const canceled = new Promise<never>((_resolve, reject) => {
    abort = () => reject(new DialRefused("aborted", host));
    if (signal.aborted) abort();
    else signal.addEventListener("abort", abort, { once: true });
  });
  try {
    return await Promise.race([work, canceled]);
  } finally {
    signal.removeEventListener("abort", abort);
  }
}

/**
 * Resolve an approved name (absolute: no search list) and check every address it gives.
 * Returns the checked addresses to try, in order, as dialable literals.
 */
export async function checkedAddresses(origin: ApprovedOrigin, options: Pick<DialOptions, "lookup" | "signal"> = {}): Promise<string[]> {
  const { signal } = options;
  if (signal?.aborted) throw new DialRefused("aborted", origin.host);
  if (isIP(origin.host)) throw new DialRefused("resolve", "an address literal is not an approved name");
  let addresses: readonly { address: string }[];
  try {
    // An abort frees the caller at once; getaddrinfo itself cannot be cancelled.
    addresses = await untilAbort((options.lookup ?? systemLookup)(`${origin.host}.`, signal), signal, origin.host);
  } catch (error) {
    if (error instanceof DialRefused) throw error;
    throw new DialRefused("resolve", `${origin.host}: ${(error as Error).message}`);
  }
  if (addresses.length === 0) throw new DialRefused("resolve", `${origin.host}: no address`);
  const own = ownAddresses();
  for (const { address } of addresses) {
    if (!reachable(address, origin, own)) throw new DialRefused("address", `${origin.host} resolves to a ${classify(unmap(address))} address`);
  }
  // IPv4 only for now: a runner may translate a global-looking IPv6 answer (a local NAT64
  // prefix) to an address the table cannot see. Every answer is still checked above.
  const v4 = [...new Set(addresses.map(({ address }) => canonical(address)))].filter((a) => isIP(a) === 4);
  if (v4.length === 0) throw new DialRefused("address", `${origin.host} has no IPv4 address; IPv6 targets are not supported yet`);
  return v4;
}

/** A verified upstream connection, and the TCP socket under it so it can be reset. */
export interface Upstream {
  socket: TLSSocket;
  /** Resolves after the underlying TCP handle has closed. */
  closed: Promise<void>;
  /** The literal address it is connected to. */
  address: string;
  /**
   * Reset the connection: an RST once connected, so bytes the kernel still holds are dropped,
   * or a plain close while still connecting, so no handshake completes and nothing is written.
   */
  reset(): void;
}

let bundled: SecureContext | undefined;
/** Node's bundled roots, built once: building it costs several ms of synchronous work. */
export function bundledRoots(): SecureContext {
  return (bundled ??= createSecureContext({ ca: [...rootCertificates], minVersion: "TLSv1.2" }));
}

/** The approved name must be in a DNS SAN: no Common Name fallback, no partial wildcards. */
export function checkIdentity(host: string, cert: PeerCertificate): Error | undefined {
  if (!cert?.raw) return new Error("no certificate");
  const x509 = new X509Certificate(cert.raw);
  return x509.checkHost(host, { subject: "never", partialWildcards: false, multiLabelWildcards: false }) === undefined ? new Error(`certificate is not for ${host}`) : undefined;
}

/** Resolve, check every address, then connect to the first checked address that answers. */
export async function dial(origin: ApprovedOrigin, options: DialOptions = {}): Promise<Upstream> {
  const addresses = await checkedAddresses(origin, options);
  return connectFirst(addresses, origin, options);
}

/** Try checked addresses in order; a refused or failed connection moves to the next. A TLS failure does not. */
export async function connectFirst(
  addresses: readonly string[],
  origin: ApprovedOrigin,
  options: Pick<DialOptions, "ca" | "signal"> & { connect?: typeof connectVerified } = {},
): Promise<Upstream> {
  const { connect = connectVerified, ...rest } = options;
  let last: unknown;
  for (const address of addresses) {
    try {
      return await connect(address, origin, rest);
    } catch (error) {
      last = error;
      if (!(error instanceof DialRefused) || error.reason !== "tls" || !/ECONNREFUSED|EHOSTUNREACH|ENETUNREACH|EADDRNOTAVAIL/.test(error.message)) throw error;
    }
  }
  throw last ?? new DialRefused("resolve", `${origin.host}: no address`);
}

/**
 * TLS to a literal, already-checked address, verified as `origin.host`.
 * The same grant must be live immediately before both TCP and TLS start.
 */
export function connectVerified(
  address: string,
  origin: ApprovedOrigin,
  options: Pick<DialOptions, "ca" | "signal"> & { ready?: () => boolean } = {},
): Promise<Upstream> {
  const { signal, ready } = options;
  if (signal?.aborted) return Promise.reject(new DialRefused("aborted", origin.host));
  const family = isIP(address);
  if (!family || isIP(origin.host)) return Promise.reject(new DialRefused("address", origin.host));
  const secureContext = options.ca ? createSecureContext({ ca: [...options.ca], minVersion: "TLSv1.2" }) : bundledRoots();
  const live = () => !signal?.aborted && (ready?.() ?? true);
  const tcp = new Socket();
  const closed = new Promise<void>((resolve) => tcp.once("close", () => resolve()));
  let connected = false;
  const reset = () => {
    if (tcp.destroyed) return;
    if (connected) tcp.resetAndDestroy();
    else tcp.destroy();
  };

  return new Promise((resolve, reject) => {
    let settled = false;
    const fail = (error: DialRefused) => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener("abort", abort);
      reset();
      void closed.then(() => reject(error));
    };
    const abort = () => fail(new DialRefused("aborted", origin.host));
    const transportError = (error: Error) => fail(new DialRefused("tls", `${origin.host}: ${error.message}`));
    signal?.addEventListener("abort", abort, { once: true });
    tcp.on("error", transportError);
    tcp.once("close", () => transportError(new Error("TCP closed during dial")));
    tcp.once("connect", () => {
      connected = true;
      let tls: TLSSocket;
      try {
        if (!live()) return abort();
        tls = connect({
          socket: tcp,
          servername: origin.host,
          ALPNProtocols: ["http/1.1"],
          rejectUnauthorized: true,
          secureContext,
          checkServerIdentity: (_host, cert) => checkIdentity(origin.host, cert),
        });
      } catch (error) {
        return transportError(error as Error);
      }
      tls.on("error", transportError);
      tls.once("close", () => transportError(new Error("closed during the handshake")));
      tls.once("secureConnect", () => {
        if (settled) return;
        const alpn = tls.alpnProtocol;
        if (typeof alpn === "string" && alpn !== "http/1.1") {
          return fail(new DialRefused("alpn", `${origin.host} chose ${alpn}`));
        }
        settled = true;
        signal?.removeEventListener("abort", abort);
        resolve({ socket: tls, address, reset, closed });
      });
    });
    try {
      tcp.connect({
        host: origin.host,
        port: origin.port,
        family,
        autoSelectFamily: false,
        // Node defers the literal-host form to nextTick. This resolver returns only
        // the checked literal and enters Node's single-address connect synchronously.
        lookup: (_name, _options, resolved) => {
          if (!live()) return abort();
          resolved(null, address, family);
        },
      });
    } catch (error) {
      transportError(error as Error);
    }
  });
}
