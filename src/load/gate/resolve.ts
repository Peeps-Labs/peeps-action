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
import { BlockList, connect as netConnect, isIP, type Socket } from "node:net";
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
  return isIP(a) === 6 ? new URL(`http://[${a}]`).hostname.slice(1, -1) : a;
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

export type Lookup = (name: string) => Promise<readonly { address: string; family: number }[]>;

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

function aborted(signal: AbortSignal | undefined, host: string): Promise<never> {
  return new Promise((_resolve, reject) => {
    if (!signal) return;
    const fail = () => reject(new DialRefused("aborted", host));
    if (signal.aborted) fail();
    else signal.addEventListener("abort", fail, { once: true });
  });
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
    addresses = await Promise.race([(options.lookup ?? systemLookup)(`${origin.host}.`), aborted(signal, origin.host)]);
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
 * TLS to a literal, already-checked address, verified as `origin.host`. Exported for tests,
 * which reach a fixture on loopback; production goes through `dial`.
 */
export function connectVerified(address: string, origin: ApprovedOrigin, options: Pick<DialOptions, "ca" | "signal"> = {}): Promise<Upstream> {
  const { signal } = options;
  if (signal?.aborted) return Promise.reject(new DialRefused("aborted", origin.host));
  const tcp: Socket = netConnect({ host: address, port: origin.port });
  let socket: TLSSocket | undefined;
  const reset = () => {
    if (tcp.destroyed) return;
    if (tcp.connecting) {
      // resetAndDestroy() would wait for the connection and let TLS send its hello first.
      tcp.destroy();
      socket?.destroy();
    } else tcp.resetAndDestroy();
  };
  const secureContext = options.ca ? createSecureContext({ ca: [...options.ca], minVersion: "TLSv1.2" }) : bundledRoots();
  socket = connect({
    socket: tcp,
    servername: origin.host,
    ALPNProtocols: ["http/1.1"],
    rejectUnauthorized: true,
    secureContext,
    checkServerIdentity: (_host, cert) => checkIdentity(origin.host, cert),
  });
  const tls = socket;
  return new Promise((resolve, reject) => {
    const abort = () => {
      // Reject first: destroying the sockets can report an error of its own on the way.
      reject(new DialRefused("aborted", origin.host));
      reset();
    };
    signal?.addEventListener("abort", abort, { once: true });
    const fail = (error: Error) => {
      signal?.removeEventListener("abort", abort);
      reset();
      reject(new DialRefused("tls", `${origin.host}: ${error.message}`));
    };
    tcp.once("error", fail);
    tls.once("error", fail);
    const closed = () => fail(new Error("closed during the handshake"));
    tls.once("close", closed);
    tls.once("secureConnect", () => {
      signal?.removeEventListener("abort", abort);
      tcp.off("error", fail);
      tls.off("error", fail);
      tls.off("close", closed);
      // Errors after the handshake surface as "close" to whoever holds the socket.
      tcp.on("error", () => undefined);
      tls.on("error", () => undefined);
      const alpn = tls.alpnProtocol;
      if (typeof alpn === "string" && alpn !== "http/1.1") {
        reset();
        reject(new DialRefused("alpn", `${origin.host} chose ${alpn}`));
        return;
      }
      resolve({ socket: tls, address, reset });
    });
  });
}
