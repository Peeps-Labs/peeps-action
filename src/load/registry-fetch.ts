/**
 * The customer install's download phase (CW plan §4.5, Sol C2): the action itself fetches every
 * tarball the lockfile names from registry.npmjs.org, checks each against the lock's sha512, and
 * writes it into an npm cache with npm's own `cacache`; then `offlinePreinstall` runs
 * `npm ci --offline --ignore-scripts` in a network namespace with no interface. npm never has a
 * network, so its URL rewriting, redirects and metadata fetches reach nothing: anything this
 * phase didn't fetch is a cache miss, `install_failed`, never egress.
 *
 *   - Only canonical tarball URLs (`canonicalRegistryTarball`), each fetched from exactly that
 *     path on registry.npmjs.org:443, over the shared transport: the job's proxy and CA
 *     variables are ignored and any 3xx fails.
 *   - At most 8 at a time, 64 MiB each, 1 GiB in all, 10 minutes in all.
 *   - Each body is hashed with sha512 as it streams; a mismatch writes nothing and fails.
 *   - A verified body is stored under the integrity it was checked against, with pacote's
 *     request-cache key for its URL.
 */
import { createHash } from "node:crypto";
import { mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { canonicalRegistryTarball, installProblems, InstallRefused, offlinePreinstall, readWorkspace, sha512Of, type InstallDigests, type OfflineInstall, type Toolchain } from "./install";
import { ControlHttpError, controlTransport, type HttpControlSeams } from "./transport";

export const REGISTRY_HOST = "registry.npmjs.org";
export const FETCH_PARALLEL = 8;
export const TARBALL_MAX_BYTES = 64 * 1024 * 1024;
export const TOTAL_MAX_BYTES = 1024 * 1024 * 1024;
export const FETCH_MS = 10 * 60_000;

/** Only tests set these. */
export interface RegistryFetchSeams extends HttpControlSeams {
  /** The registry's port (a local server under the test's CA); 443 otherwise. */
  port?: number;
  tarballMaxBytes?: number;
  totalMaxBytes?: number;
  deadlineMs?: number;
}

export interface Tarball {
  url: string;
  /** `sha512-<base64>`, the part of the lock's integrity this phase checks. */
  integrity: string;
}

/** Each distinct (url, sha512) of the lock's registry entries, after `installProblems` passed. */
export function lockedTarballs(lock: unknown): Tarball[] {
  const packages = (lock as { packages?: Record<string, Record<string, unknown> | null> }).packages ?? {};
  const seen = new Map<string, Tarball>();
  for (const entry of Object.values(packages)) {
    if (!entry || !canonicalRegistryTarball(entry.resolved)) continue;
    const integrity = sha512Of(entry.integrity);
    if (integrity === null) continue;
    seen.set(`${entry.resolved} ${integrity}`, { url: entry.resolved, integrity });
  }
  return [...seen.values()];
}

/** pacote's cache key for a tarball fetched from `url` (make-fetch-happen's request cache). */
export const cacheKeyOf = (url: string) => `make-fetch-happen:request-cache:${url}`;

interface Cacache {
  put(cache: string, key: string, data: Buffer, opts: { integrity: string; algorithms?: string[] }): Promise<unknown>;
}

/**
 * Downloads and verifies every tarball into `<cache>/_cacache`. Rejects `install_failed` on any
 * failure: nothing unverified is ever written.
 */
export async function downloadTarballs(tarballs: Tarball[], cache: string, tc: Toolchain, seams: RegistryFetchSeams = {}, signal?: AbortSignal): Promise<{ count: number; bytes: number }> {
  const cacache = createRequire(tc.npmCli)("cacache") as Cacache;
  const cacheDir = path.join(cache, "_cacache");
  const tarballCap = seams.tarballMaxBytes ?? TARBALL_MAX_BYTES;
  const totalCap = seams.totalMaxBytes ?? TOTAL_MAX_BYTES;
  const window = AbortSignal.any([AbortSignal.timeout(seams.deadlineMs ?? FETCH_MS), ...(signal ? [signal] : [])]);
  const target = new URL(`https://${REGISTRY_HOST}${seams.port ? `:${seams.port}` : ""}`);
  const t = controlTransport(seams);
  const agent = t.agent({ keepAlive: true, maxSockets: FETCH_PARALLEL, maxFreeSockets: FETCH_PARALLEL });
  let total = 0;
  let next = 0;
  const fail = (why: string): never => {
    throw new Error(`install_failed: ${why}`);
  };
  const one = async (tarball: Tarball) => {
    const url = new URL(tarball.url);
    const hash = createHash("sha512");
    const chunks: Buffer[] = [];
    try {
      await t.download("registry", agent, target, url.pathname, tarballCap, window, (chunk) => {
        total += chunk.length;
        if (total > totalCap) return false;
        hash.update(chunk);
        chunks.push(chunk);
        return true;
      });
    } catch (error) {
      signal?.throwIfAborted();
      const code = error instanceof ControlHttpError ? `${error.code}${error.status !== undefined ? ` ${error.status}` : ""}` : "download";
      return fail(`fetching ${url.pathname} failed (${code})`);
    }
    if (total > totalCap) fail(`the tarballs exceed ${totalCap} bytes`);
    const digest = `sha512-${hash.digest("base64")}`;
    if (digest !== tarball.integrity) fail(`${url.pathname} does not match its lockfile sha512`);
    signal?.throwIfAborted();
    await cacache.put(cacheDir, cacheKeyOf(tarball.url), Buffer.concat(chunks), { integrity: tarball.integrity, algorithms: ["sha512"] });
  };
  try {
    const workers = Array.from({ length: Math.min(FETCH_PARALLEL, tarballs.length) }, async () => {
      while (next < tarballs.length) await one(tarballs[next++]!);
    });
    const settled = await Promise.allSettled(workers);
    const failed = settled.find((s): s is PromiseRejectedResult => s.status === "rejected");
    if (failed) throw failed.reason;
  } finally {
    t.close();
  }
  return { count: tarballs.length, bytes: total };
}

/**
 * The customer path's pre-claim install: validated as `preinstall` is, then the download phase
 * into `<scratch>/cache`, then `offlinePreinstall` from that cache with no network. Refuses with
 * `install_unsupported` before anything is fetched.
 */
export async function fetchPreinstall(ws: string, tc: Toolchain, scratch: string, ids: Omit<OfflineInstall, "cache">, seams: RegistryFetchSeams = {}, signal?: AbortSignal, log: (line: string) => void = () => undefined): Promise<InstallDigests> {
  signal?.throwIfAborted();
  const workspace = readWorkspace(ws);
  const problems = installProblems(workspace);
  if (problems.length > 0) throw new InstallRefused(problems);
  const cache = path.join(scratch, "cache");
  mkdirSync(cache, { recursive: true });
  const fetched = await downloadTarballs(lockedTarballs(workspace.lock), cache, tc, seams, signal);
  log(`downloaded ${fetched.count} tarballs (${fetched.bytes} bytes) from ${REGISTRY_HOST}, each checked against its lockfile sha512`);
  const digests = await offlinePreinstall(ws, tc, scratch, { cache, ...ids }, undefined, signal);
  log("npm ci --offline --ignore-scripts ran in a network namespace with no interface");
  return digests;
}
