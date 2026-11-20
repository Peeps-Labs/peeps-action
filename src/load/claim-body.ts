/**
 * The claim body (seq 0), and nothing else (e5 plan v3 §2.3): one strict, load-only mapper builds
 * it, and it is checked against the same strict schema Peeps parses it with (P1's
 * `parseClaimBody` in `wire.ts`) before it is sent, so a body Peeps would refuse `malformed` or
 * `unsupported_protocol` is never sent at all.
 *
 *   {protocol, actionVersion, grantRef, idempotencyKey, checkoutSha, workload: {path, digest},
 *    lockDigests: {"package-lock.json"}, observed: {treeDigest, generatedLockDigest},
 *    runAttempt, checkRunId, fence: {kind: "netns", probe: {passed, failures, image, kernel,
 *    tools, chrony}}}
 *
 * Unknown keys are refused at every depth. The OIDC token is never in the body: the HTTP port
 * sends it as the claim's bearer. `test/load-wire-v1.test.ts` runs the shared corpus's claim
 * vectors through `claimBodyProblem` and rebuilds its request with `claimBody`.
 */
import { execFile } from "node:child_process";
import os from "node:os";
import { canonical, type Binding, type ClaimRequest } from "./control-port";
import { CLAIM_BODY_MAX_BYTES, WIRE_PROTOCOL } from "./wire";

/** What the probe reports about the host, for the evidence only: Peeps stores them, never judges them. */
export interface ProbeLabels {
  image: string;
  kernel: string;
  tools: string;
  chrony: string;
}

export interface ClaimInputs {
  grantRef: string;
  actionVersion: string;
  idempotencyKey: string;
  runAttempt: number;
  checkRunId: number;
  binding: Binding;
  probe: { passed: boolean; failures: readonly string[] };
  labels: ProbeLabels;
}

export type ClaimBodyResult = { ok: true; body: ClaimRequest } | { ok: false; problem: string };

const MAX_FAILURES = 20;
const MAX_FAILURE = 256;
const MAX_LABEL = 128;

/** The claim body for `i`, or the first field that keeps it from Peeps' strict schema (named, never its value). */
export function claimBody(i: ClaimInputs): ClaimBodyResult {
  const b = i.binding;
  const body: ClaimRequest = {
    protocol: WIRE_PROTOCOL,
    actionVersion: i.actionVersion,
    grantRef: i.grantRef,
    idempotencyKey: i.idempotencyKey,
    checkoutSha: b.checkoutSha,
    workload: { path: b.workload.path, digest: b.workload.digest },
    lockDigests: { "package-lock.json": b.lockDigests["package-lock.json"] },
    observed: { treeDigest: b.observed.treeDigest, generatedLockDigest: b.observed.generatedLockDigest },
    runAttempt: i.runAttempt,
    checkRunId: i.checkRunId,
    fence: {
      kind: "netns",
      probe: {
        passed: i.probe.passed,
        failures: i.probe.failures.slice(0, MAX_FAILURES).map((f) => clip(f, MAX_FAILURE)),
        image: clip(i.labels.image, MAX_LABEL),
        kernel: clip(i.labels.kernel, MAX_LABEL),
        tools: clip(i.labels.tools, MAX_LABEL),
        chrony: clip(i.labels.chrony, MAX_LABEL),
      },
    },
  };
  const problem = claimBodyProblem(canonical(body));
  return problem === undefined ? { ok: true, body } : { ok: false, problem };
}

/**
 * At most `max` UTF-16 units, never splitting a character. Peeps' schema counts code points, so
 * this is the stricter count: a label it keeps is never too long for Peeps.
 */
function clip(text: string, max: number): string {
  if (text.length <= max) return text;
  let out = "";
  for (const ch of text) {
    if (out.length + ch.length > max) break;
    out += ch;
  }
  return out;
}

const SHA256_HEX = /^[0-9a-f]{64}$/;
const COMMIT = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/;
/** 128 random bits, base64url. */
const GRANT_REF = /^[A-Za-z0-9_-]{22}$/;
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
// Fatal, and a byte order mark is kept (so `JSON.parse` refuses it), as Peeps decodes it.
const utf8 = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);
const whole = (v: unknown, min = 0) => typeof v === "number" && Number.isSafeInteger(v) && v >= min;
const str = (v: unknown, min: number, max: number) => typeof v === "string" && v.length >= min && v.length <= max;
const match = (v: unknown, re: RegExp) => typeof v === "string" && re.test(v);

/** The object at `at` has exactly `keys`; otherwise the first offending path. */
function exactly(v: unknown, at: string, keys: readonly string[]): string | undefined {
  if (!isObj(v)) return at;
  for (const k of Object.keys(v)) if (!keys.includes(k)) return `${at}.${k}`;
  for (const k of keys) if (!Object.hasOwn(v, k)) return `${at}.${k}`;
  return undefined;
}

/**
 * Why Peeps' strict claim schema would refuse these bytes (`unsupported_protocol` or a field's
 * path, for `malformed`), or undefined when it parses. Shape only: whether Peeps grants the
 * claim is Peeps' to decide.
 */
export function claimBodyProblem(body: string | Uint8Array): string | undefined {
  const bytes = typeof body === "string" ? new TextEncoder().encode(body) : body;
  if (bytes.byteLength > CLAIM_BODY_MAX_BYTES) return "size";
  let raw: unknown;
  try {
    raw = JSON.parse(utf8.decode(bytes));
  } catch {
    return "json";
  }
  if (isObj(raw) && typeof raw.protocol === "number" && raw.protocol !== WIRE_PROTOCOL) return "unsupported_protocol";
  const top = exactly(raw, "body", ["protocol", "actionVersion", "grantRef", "idempotencyKey", "checkoutSha", "workload", "lockDigests", "observed", "runAttempt", "checkRunId", "fence"]);
  if (top) return top;
  const r = raw as Obj;
  if (r.protocol !== WIRE_PROTOCOL) return "protocol";
  if (!str(r.actionVersion, 1, 64)) return "actionVersion";
  if (!match(r.grantRef, GRANT_REF)) return "grantRef";
  if (!match(r.idempotencyKey, UUID_V4)) return "idempotencyKey";
  if (!match(r.checkoutSha, COMMIT)) return "checkoutSha";
  const w = exactly(r.workload, "workload", ["path", "digest"]);
  if (w) return w;
  if (!str((r.workload as Obj).path, 1, 1024)) return "workload.path";
  if (!match((r.workload as Obj).digest, SHA256_HEX)) return "workload.digest";
  const l = exactly(r.lockDigests, "lockDigests", ["package-lock.json"]);
  if (l) return l;
  if (!match((r.lockDigests as Obj)["package-lock.json"], SHA256_HEX)) return "lockDigests.package-lock.json";
  const o = exactly(r.observed, "observed", ["treeDigest", "generatedLockDigest"]);
  if (o) return o;
  if (!match((r.observed as Obj).treeDigest, SHA256_HEX)) return "observed.treeDigest";
  if (!match((r.observed as Obj).generatedLockDigest, SHA256_HEX)) return "observed.generatedLockDigest";
  if (!whole(r.runAttempt, 1)) return "runAttempt";
  if (!whole(r.checkRunId)) return "checkRunId";
  const f = exactly(r.fence, "fence", ["kind", "probe"]);
  if (f) return f;
  const fence = r.fence as Obj;
  if (fence.kind !== "netns") return "fence.kind";
  const p = exactly(fence.probe, "fence.probe", ["passed", "failures", "image", "kernel", "tools", "chrony"]);
  if (p) return p;
  const probe = fence.probe as Obj;
  if (typeof probe.passed !== "boolean") return "fence.probe.passed";
  if (!Array.isArray(probe.failures) || probe.failures.length > MAX_FAILURES || !probe.failures.every((x) => str(x, 0, MAX_FAILURE))) return "fence.probe.failures";
  for (const k of ["image", "kernel", "tools", "chrony"] as const) if (!str(probe[k], 0, MAX_LABEL)) return `fence.probe.${k}`;
  return undefined;
}

/** Runs a host tool by absolute path and answers its stdout, or undefined on any failure. */
export type HostRun = (file: string, args: string[]) => Promise<string | undefined>;

const runHostTool: HostRun = (file, args) =>
  new Promise((resolve) => {
    execFile(file, args, { cwd: "/", env: { PATH: "/usr/sbin:/usr/bin:/sbin:/bin", LC_ALL: "C" }, timeout: 2_000, maxBuffer: 16 * 1024, killSignal: "SIGKILL" }, (error, stdout) => resolve(error ? undefined : String(stdout)));
  });

function imageLabel(env: NodeJS.ProcessEnv): string {
  try {
    const image = env.ImageOS;
    return image === "ubuntu22" || image === "ubuntu24" ? image : "unknown";
  } catch {
    return "unknown";
  }
}

function kernelRelease(): string {
  try {
    return KERNEL_RELEASE.exec(os.release())?.[0] ?? "unknown";
  } catch {
    return "unknown";
  }
}

function versionLine(out: string | undefined, pattern: RegExp): string {
  const line = out?.split("\n", 1)[0];
  return line && pattern.test(line) ? line : "unavailable";
}

const KERNEL_RELEASE = /^[0-9]{1,4}\.[0-9]{1,4}\.[0-9]{1,4}(?:-[0-9]{1,6}-(?:azure|generic))?/;
const SYSTEMD_VERSION = /^systemd [0-9]{1,4}(?: \([0-9]{1,4}\.[0-9]{1,4}-[0-9]{1,4}ubuntu[0-9]{0,4}(?:\.[0-9]{1,4}){0,3}\))?$/;
const UNSHARE_VERSION = /^unshare from util-linux [0-9]{1,4}\.[0-9]{1,4}(?:\.[0-9]{1,4})?$/;
const CLOCK_OFFSET = /^[0-9]{1,8}\.[0-9]{1,9} seconds (?:fast|slow) of NTP time$/;
const LEAP_STATUS = new Set(["normal", "insert second", "delete second", "not synchronised"]);

/**
 * The four probe labels: the runner image family (a fixed enum),
 * the kernel, the versions of the host tools the fence runs on (systemd-run, unshare), and
 * chrony's leap status and offset. ImageVersion is workflow-controlled and its format does not
 * establish provenance. Host probe values must match the expected formats. A failed probe says
 * `unknown` or `unavailable`, and the other labels stand.
 */
export async function hostLabels(env: NodeJS.ProcessEnv = process.env, run: HostRun = runHostTool): Promise<ProbeLabels> {
  const read = async (file: string, args: string[]) => {
    try {
      return await run(file, args);
    } catch {
      return undefined;
    }
  };
  const [systemd, unshare, tracking] = await Promise.all([
    read("/usr/bin/systemd-run", ["--version"]),
    read("/usr/bin/unshare", ["--version"]),
    read("/usr/bin/chronyc", ["-n", "tracking"]),
  ]);
  const field = (name: string) => tracking?.split("\n").find((line) => line.split(":", 1)[0]?.trimEnd() === name)?.split(":").slice(1).join(":").trim();
  const leap = field("Leap status")?.toLowerCase();
  const offset = field("System time");
  return {
    image: imageLabel(env),
    kernel: kernelRelease(),
    tools: clip(`${versionLine(systemd, SYSTEMD_VERSION)}; ${versionLine(unshare, UNSHARE_VERSION)}`, MAX_LABEL),
    chrony: leap && LEAP_STATUS.has(leap)
      ? `${leap}${offset && CLOCK_OFFSET.test(offset) ? `, ${offset}` : ""}` : "unavailable",
  };
}
