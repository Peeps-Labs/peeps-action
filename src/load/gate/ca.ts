/**
 * The run's own certificate authority (plan v3 §5). The gate terminates the journey's TLS, so
 * the journey must trust a CA; this one can vouch only for the run's approved hosts. Its
 * `nameConstraints` (critical) permit exactly those DNS names and exclude every IP address, so
 * even a leaked key could not impersonate anything else to a verifier that honours them.
 *
 * RFC 5280 constraints also permit descendants of an approved name, so the CA issues every leaf
 * when it is made and its signing key is then dropped: nothing can be issued later. Keys stay in
 * memory; the CA certificate is the only thing ever written (for `NODE_EXTRA_CA_CERTS`).
 *
 * Pure apart from key generation and randomness: the caller passes the time.
 */
import { createHash, generateKeyPairSync, randomBytes, sign, type KeyObject } from "node:crypto";
import { bits, bool, explicit, implicit, implicitSeq, integer, octets, oid, seq, set, time, utf8 } from "./der";

const OID = {
  ecdsaSha256: "1.2.840.10045.4.3.2",
  commonName: "2.5.4.3",
  subjectKeyId: "2.5.29.14",
  keyUsage: "2.5.29.15",
  subjectAltName: "2.5.29.17",
  basicConstraints: "2.5.29.19",
  nameConstraints: "2.5.29.30",
  authorityKeyId: "2.5.29.35",
  extKeyUsage: "2.5.29.37",
  serverAuth: "1.3.6.1.5.5.7.3.1",
} as const;

/** Lower-case DNS name with at least two labels; no IP literal, wildcard or trailing dot. */
const HOST = /^(?=.{1,253}$)(?!-)[a-z0-9-]{1,63}(?<!-)(\.(?!-)[a-z0-9-]{1,63}(?<!-))+$/;

export function isApprovedHostName(host: string): boolean {
  return HOST.test(host) && !/^[0-9.]+$/.test(host);
}

/** Clock skew allowed on the start of validity. */
const BACKDATE_MS = 60 * 60 * 1000;

export interface RunCaOptions {
  hosts: readonly string[];
  nowMs: number;
  /** How long the certificates stay valid from `nowMs`: the run's length and its grace. */
  validForMs: number;
}

export interface LeafCredentials {
  certPem: string;
  /** In memory only: hand it to `tls.createSecureContext`, never to a file. */
  key: KeyObject;
}

export interface RunCa {
  readonly certPem: string;
  /** The leaf issued for an approved host, or undefined for any other name. */
  leaf(host: string): LeafCredentials | undefined;
}

export function createRunCa(options: RunCaOptions): RunCa {
  const hosts = [...new Set(options.hosts)];
  if (hosts.length === 0) throw new Error("ca: at least one approved host is required");
  for (const h of hosts) if (!isApprovedHostName(h)) throw new Error(`ca: not an approved host name: ${JSON.stringify(h)}`);
  const notBefore = options.nowMs - BACKDATE_MS;
  const notAfter = options.nowMs + options.validForMs;
  if (!Number.isFinite(options.nowMs) || !(options.validForMs > 0) || !representable(notBefore) || !representable(notAfter)) throw new Error("ca: nowMs and validForMs must give a representable validity, validForMs > 0");
  const ca = buildCa(hosts, notBefore, notAfter);
  // Every leaf is issued now, and the CA's signing key goes out of scope with this call: nothing
  // later in the run can issue another certificate, for a descendant name or anything else.
  const leaves = new Map(hosts.map((host) => [host, issueLeaf({ host, issuer: ca.name, issuerKeyId: ca.keyId, signer: ca.key, notBefore, notAfter })] as const));
  return { certPem: ca.certPem, leaf: (host) => leaves.get(host) };
}

/** Between 1950 and 9999, as X.509 times can say it. */
function representable(ms: number): boolean {
  return Number.isFinite(ms) && ms >= Date.UTC(1950, 0, 1) && ms < Date.UTC(10000, 0, 1);
}

export interface BuiltCa {
  certPem: string;
  name: Buffer;
  keyId: Buffer;
  /** The signing key. `createRunCa` drops it once the leaves are issued; tests use it to issue a leaf outside the constraints. */
  key: KeyObject;
}

/** The CA certificate and its key. Exported for tests; production goes through `createRunCa`. */
export function buildCa(hosts: readonly string[], notBefore: number, notAfter: number): BuiltCa {
  const ca = generateKeyPairSync("ec", { namedCurve: "P-256" });
  const caSpki = ca.publicKey.export({ type: "spki", format: "der" });
  const caKeyId = keyId(caSpki);
  const caName = name("Peeps load run CA");
  const caDer = certificate({
    issuer: caName,
    subject: caName,
    notBefore,
    notAfter,
    spki: caSpki,
    signer: ca.privateKey,
    extensions: [
      extension(OID.basicConstraints, true, seq(bool(true), integer(0))),
      extension(OID.keyUsage, true, bits(Buffer.from([0x06]), 1)), // keyCertSign, cRLSign
      extension(OID.nameConstraints, true, nameConstraints(hosts)),
      extension(OID.subjectKeyId, false, octets(caKeyId)),
    ],
  });
  return { certPem: pem(caDer), name: caName, keyId: caKeyId, key: ca.privateKey };
}

/** One leaf for `host`: empty subject, the name only in a critical SAN (RFC 5280 §4.2.1.6), so a long name fits. */
export function issueLeaf(o: { host: string; issuer: Buffer; issuerKeyId: Buffer; signer: KeyObject; notBefore: number; notAfter: number }): LeafCredentials {
  const pair = generateKeyPairSync("ec", { namedCurve: "P-256" });
  const spki = pair.publicKey.export({ type: "spki", format: "der" });
  const der = certificate({
    issuer: o.issuer,
    subject: seq(),
    notBefore: o.notBefore,
    notAfter: o.notAfter,
    spki,
    signer: o.signer,
    extensions: [
      extension(OID.basicConstraints, true, seq()),
      extension(OID.keyUsage, true, bits(Buffer.from([0x80]), 7)), // digitalSignature
      extension(OID.extKeyUsage, false, seq(oid(OID.serverAuth))),
      extension(OID.subjectAltName, true, seq(implicit(2, Buffer.from(o.host, "ascii")))),
      extension(OID.subjectKeyId, false, octets(keyId(spki))),
      extension(OID.authorityKeyId, false, seq(implicit(0, o.issuerKeyId))),
    ],
  });
  return { certPem: pem(der), key: pair.privateKey };
}

export function name(commonName: string): Buffer {
  return seq(set(seq(oid(OID.commonName), utf8(commonName))));
}

export function keyId(spki: Buffer): Buffer {
  return createHash("sha1").update(spki).digest();
}

/** Permit each approved DNS name (and its subdomains, per RFC 5280); exclude every IPv4 and IPv6 address. */
function nameConstraints(hosts: readonly string[]): Buffer {
  const permitted = hosts.map((h) => seq(implicit(2, Buffer.from(h, "ascii"))));
  const excluded = [seq(implicit(7, Buffer.alloc(8))), seq(implicit(7, Buffer.alloc(32)))];
  return seq(implicitSeq(0, ...permitted), implicitSeq(1, ...excluded));
}

function extension(id: string, critical: boolean, value: Buffer): Buffer {
  return critical ? seq(oid(id), bool(true), octets(value)) : seq(oid(id), octets(value));
}

function certificate(o: { issuer: Buffer; subject: Buffer; notBefore: number; notAfter: number; spki: Buffer; signer: KeyObject; extensions: Buffer[] }): Buffer {
  const algorithm = seq(oid(OID.ecdsaSha256));
  const serial = randomBytes(16);
  serial[0] = (serial[0]! & 0x7f) | 0x01;
  const tbs = seq(
    explicit(0, integer(2)),
    integer(serial),
    algorithm,
    o.issuer,
    seq(time(o.notBefore), time(o.notAfter)),
    o.subject,
    o.spki,
    explicit(3, seq(...o.extensions)),
  );
  const signature = sign("sha256", tbs, { key: o.signer, dsaEncoding: "der" });
  return seq(tbs, algorithm, bits(signature));
}

function pem(der: Buffer): string {
  const body = der.toString("base64").match(/.{1,64}/g)!.join("\n");
  return `-----BEGIN CERTIFICATE-----\n${body}\n-----END CERTIFICATE-----\n`;
}
