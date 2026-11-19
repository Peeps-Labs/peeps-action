/**
 * The gate's only way out (plan v3 §5). Names are resolved here, never in the jail, and only
 * for approved origins. Every address the name resolves to is unmapped and classified, and the
 * dial is refused if any of them falls in a class the origin may not reach: a name that
 * resolves to one public and one metadata address is refused, not raced.
 *
 * The connection goes to the literal address with `servername` set to the approved host, HTTP/1.1
 * by ALPN (required), and verification against Node's bundled roots only: the job's
 * `NODE_EXTRA_CA_CERTS`, `NODE_TLS_REJECT_UNAUTHORIZED` and proxy variables play no part.
 */
import { lookup as dnsLookup } from "node:dns/promises";
import { connect as netConnect, isIP, type Socket } from "node:net";
import { checkServerIdentity, connect, rootCertificates, type TLSSocket } from "node:tls";

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
const METADATA_V4 = new Set(["169.254.169.254", "168.63.129.16", "100.100.100.200"]);
const METADATA_V6 = "fd00:0ec2:0000:0000:0000:0000:0000:0254";

/** Classify one address, IPv4-mapped, NAT64 and 6to4 forms by the IPv4 address they carry. */
export function classify(address: string): AddressClass {
  const kind = isIP(address);
  if (kind === 4) return classifyV4(v4Bytes(address));
  if (kind !== 6) return "invalid";
  const b = v6Bytes(address);
  if (!b) return "invalid";
  const zeros = (from: number, to: number) => b.slice(from, to).every((x) => x === 0);
  if (zeros(0, 10) && b[10] === 0xff && b[11] === 0xff) return classifyV4(b.slice(12)); // ::ffff:a.b.c.d
  if (b[0] === 0x00 && b[1] === 0x64 && b[2] === 0xff && b[3] === 0x9b && zeros(4, 12)) return classifyV4(b.slice(12)); // 64:ff9b::/96
  if (b[0] === 0x20 && b[1] === 0x02) return classifyV4(b.slice(2, 6)); // 2002::/16
  if (zeros(0, 16)) return "unspecified";
  if (zeros(0, 15) && b[15] === 1) return "loopback";
  if (zeros(0, 12)) return "reserved"; // IPv4-compatible, deprecated
  if (hex(b) === METADATA_V6) return "metadata";
  if (b[0] === 0xff) return "multicast";
  if (b[0] === 0xfe && (b[1]! & 0xc0) === 0x80) return "link_local";
  if ((b[0]! & 0xfe) === 0xfc) return "private";
  if (b[0] === 0x20 && b[1] === 0x01 && b[2] === 0x0d && b[3] === 0xb8) return "reserved"; // documentation
  if (b[0] === 0x20 && b[1] === 0x01 && b[2] === 0x00 && b[3] === 0x00) return "reserved"; // Teredo
  if ((b[0]! & 0xe0) !== 0x20) return "reserved"; // outside global unicast 2000::/3
  return "public";
}

function classifyV4(b: number[]): AddressClass {
  const [a, c] = [b[0]!, b[1]!];
  const dotted = b.join(".");
  if (METADATA_V4.has(dotted)) return "metadata";
  if (dotted === "0.0.0.0") return "unspecified";
  if (a === 0) return "this_network";
  if (a === 127) return "loopback";
  if (a === 169 && c === 254) return "link_local";
  if (a >= 224 && a <= 239) return "multicast";
  if (a >= 240) return "reserved";
  if (a === 10 || (a === 172 && c >= 16 && c <= 31) || (a === 192 && c === 168) || (a === 100 && c >= 64 && c <= 127)) return "private";
  if ((a === 192 && c === 0 && b[2] === 0) || (a === 192 && c === 0 && b[2] === 2) || (a === 198 && (c === 18 || c === 19)) || (a === 198 && c === 51 && b[2] === 100) || (a === 203 && c === 0 && b[2] === 113)) return "reserved";
  return "public";
}

function v4Bytes(address: string): number[] {
  return address.split(".").map(Number);
}

function v6Bytes(address: string): number[] | undefined {
  let s = address.toLowerCase();
  const zone = s.indexOf("%");
  if (zone >= 0) return undefined; // a zone id names a link: never an approved origin
  let tail: number[] = [];
  const dot = s.lastIndexOf(":");
  if (s.includes(".")) {
    tail = v4Bytes(s.slice(dot + 1));
    s = `${s.slice(0, dot + 1)}0:0`;
  }
  const halves = s.split("::");
  if (halves.length > 2) return undefined;
  const words = (part: string) => (part === "" ? [] : part.split(":").map((w) => parseInt(w, 16)));
  const head = words(halves[0]!);
  const back = halves.length === 2 ? words(halves[1]!) : [];
  const fill = 8 - head.length - back.length;
  if (fill < 0 || (halves.length === 1 && fill !== 0)) return undefined;
  const all = [...head, ...Array<number>(fill).fill(0), ...back];
  const bytes = all.flatMap((w) => [w >> 8, w & 0xff]);
  if (tail.length) bytes.splice(12, 4, ...tail);
  return bytes;
}

function hex(b: number[]): string {
  const words: string[] = [];
  for (let i = 0; i < 16; i += 2) words.push(((b[i]! << 8) | b[i + 1]!).toString(16).padStart(4, "0"));
  return words.join(":");
}

export interface ApprovedOrigin {
  /** Lower-case approved host name. */
  host: string;
  port: number;
  /** The Owner approved private addresses for this origin. Metadata stays unreachable. */
  allowPrivate: boolean;
}

export type Lookup = (host: string) => Promise<readonly { address: string; family: number }[]>;

export interface DialOptions {
  signal?: AbortSignal;
  /** Tests only: a resolver for fixture names. */
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

/** Which classes an origin may reach. */
export function reachable(c: AddressClass, origin: Pick<ApprovedOrigin, "allowPrivate">): boolean {
  return c === "public" || (c === "private" && origin.allowPrivate);
}

const systemLookup: Lookup = (host) => dnsLookup(host, { all: true, verbatim: true });

/** Resolve an approved name and check every address it gives; the first is the one to dial. */
export async function checkedAddress(origin: ApprovedOrigin, options: Pick<DialOptions, "lookup" | "signal"> = {}): Promise<string> {
  const { signal } = options;
  if (signal?.aborted) throw new DialRefused("aborted", origin.host);
  if (isIP(origin.host)) throw new DialRefused("resolve", "an address literal is not an approved name");
  let addresses: readonly { address: string }[];
  try {
    addresses = await (options.lookup ?? systemLookup)(origin.host);
  } catch (error) {
    throw new DialRefused("resolve", `${origin.host}: ${(error as Error).message}`);
  }
  if (signal?.aborted) throw new DialRefused("aborted", origin.host);
  if (addresses.length === 0) throw new DialRefused("resolve", `${origin.host}: no address`);
  for (const { address } of addresses) {
    const c = classify(address);
    if (!reachable(c, origin)) throw new DialRefused("address", `${origin.host} resolves to a ${c} address`);
  }
  return addresses[0]!.address;
}

/** A verified upstream connection, and the TCP socket under it so it can be reset. */
export interface Upstream {
  socket: TLSSocket;
  /** Reset the TCP connection (RST): bytes the kernel still holds are dropped, not sent. */
  reset(): void;
}

/** Resolve, check every address, then open a verified HTTP/1.1 TLS connection to the first. */
export async function dial(origin: ApprovedOrigin, options: DialOptions = {}): Promise<Upstream & { address: string }> {
  const address = await checkedAddress(origin, options);
  return { ...(await connectVerified(address, origin, options)), address };
}

/**
 * TLS to a literal, already-checked address, verified as `origin.host`. Exported for tests,
 * which reach a fixture on loopback; production goes through `dial`.
 */
export function connectVerified(address: string, origin: ApprovedOrigin, options: Pick<DialOptions, "ca" | "signal"> = {}): Promise<Upstream> {
  const { signal } = options;
  if (signal?.aborted) return Promise.reject(new DialRefused("aborted", origin.host));
  const tcp: Socket = netConnect({ host: address, port: origin.port });
  const reset = () => {
    if (!tcp.destroyed) tcp.resetAndDestroy();
  };
  const socket = connect({
    socket: tcp,
    servername: origin.host,
    ALPNProtocols: ["http/1.1"],
    rejectUnauthorized: true,
    ca: options.ca ? [...options.ca] : [...rootCertificates],
    minVersion: "TLSv1.2",
    checkServerIdentity: (_host, cert) => checkServerIdentity(origin.host, cert),
  });
  return new Promise((resolve, reject) => {
    const abort = () => {
      reset();
      reject(new DialRefused("aborted", origin.host));
    };
    signal?.addEventListener("abort", abort, { once: true });
    socket.once("error", (error) => {
      signal?.removeEventListener("abort", abort);
      reset();
      reject(new DialRefused("tls", `${origin.host}: ${error.message}`));
    });
    socket.once("secureConnect", () => {
      signal?.removeEventListener("abort", abort);
      if (socket.alpnProtocol !== "http/1.1") {
        reset();
        reject(new DialRefused("alpn", `${origin.host} did not agree to HTTP/1.1`));
        return;
      }
      resolve({ socket, reset });
    });
  });
}
