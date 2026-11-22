/**
 * The customer install's download phase (CW plan §4.5, §6.2): every lockfile tarball fetched by
 * the action from registry.npmjs.org over the hardened transport, checked by sha512, written
 * into npm's cache; then npm installs offline in a namespace with no network. A local HTTPS
 * server under the test's CA stands in for the registry, resolved by the transport's lookup seam.
 */
import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import type { Toolchain } from "../src/load/install";
import { cacheKeyOf, downloadTarballs, fetchPreinstall, lockedTarballs, type RegistryFetchSeams, type Tarball } from "../src/load/registry-fetch";
import { loopbackLookup, startTestServer, type TestServer } from "./support/control-server";

const REG = "https://registry.npmjs.org";

function tmp(t: TestContext, prefix = "peeps-fetch-"): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), prefix));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

const nodeDir = path.dirname(path.dirname(process.execPath));
const npmCli = path.join(nodeDir, "lib/node_modules/npm/bin/npm-cli.js");
const hasNpm = existsSync(npmCli);
/** The Node running the tests and its npm: in CI, setup-node's pinned 24.22.3 and 11.19.1. */
function toolchain(): Toolchain {
  const npmVersion = (JSON.parse(readFileSync(path.join(nodeDir, "lib/node_modules/npm/package.json"), "utf8")) as { version: string }).version;
  return { nodeDir, node: process.execPath, npmCli, nodeVersion: process.versions.node, npmVersion };
}

const canUnshare = (() => {
  if (process.platform !== "linux") return false;
  try {
    execFileSync("/usr/bin/sudo", ["-n", "/usr/bin/unshare", "--net", "--", "/bin/true"], { stdio: "ignore", timeout: 10_000 });
    return true;
  } catch {
    return false;
  }
})();

/** A package tarball: `package/package.json` and anything else given. */
function tarball(t: TestContext, name: string, version: string, extra: Record<string, unknown> = {}): { bytes: Buffer; integrity: string } {
  const root = tmp(t);
  mkdirSync(path.join(root, "package"));
  writeFileSync(path.join(root, "package/package.json"), JSON.stringify({ name, version, ...extra }));
  writeFileSync(path.join(root, "package/index.js"), `module.exports = ${JSON.stringify(name)};\n`);
  const file = path.join(root, "p.tgz");
  execFileSync("tar", ["-czf", file, "-C", root, "package"]);
  const bytes = readFileSync(file);
  return { bytes, integrity: `sha512-${createHash("sha512").update(bytes).digest("base64")}` };
}

interface Registry {
  server: TestServer;
  seams: RegistryFetchSeams;
  /** Paths served, by path. */
  files: Map<string, Buffer>;
}

async function registry(t: TestContext): Promise<Registry> {
  const files = new Map<string, Buffer>();
  const server = await startTestServer("registry.npmjs.org", (a, res) => {
    const body = files.get(a.url);
    if (!body) {
      res.writeHead(404).end();
      return;
    }
    res.writeHead(200, { "content-type": "application/octet-stream", "content-length": String(body.length) });
    res.end(body);
  });
  t.after(() => server.close());
  return { server, files, seams: { ca: [server.caPem], lookup: loopbackLookup, port: server.port } };
}

function cacheEntries(cache: string): string[] {
  const index = path.join(cache, "_cacache/index-v5");
  return existsSync(index) ? (readdirSync(index, { recursive: true }) as string[]).filter((f) => /[0-9a-f]{40,}$/.test(path.basename(f))) : [];
}

test("lockedTarballs: each distinct canonical URL and sha512 of the lock, nothing else", () => {
  const good = `sha512-${Buffer.alloc(64, 1).toString("base64")}`;
  const lock = { packages: {
    "": { name: "app" },
    "node_modules/a": { resolved: `${REG}/a/-/a-1.0.0.tgz`, integrity: good },
    "node_modules/b/node_modules/a": { resolved: `${REG}/a/-/a-1.0.0.tgz`, integrity: `sha1-${Buffer.alloc(20).toString("base64")} ${good}` },
    "node_modules/c": { resolved: "https://evil.example/c.tgz", integrity: good },
    "node_modules/d": { version: "1.0.0", inBundle: true },
    "node_modules/e": { link: true, resolved: "packages/e" },
  } };
  assert.deepEqual(lockedTarballs(lock), [{ url: `${REG}/a/-/a-1.0.0.tgz`, integrity: good }]);
});

test("a good tarball is written to npm's cache under its lockfile sha512 and pacote's key", { skip: hasNpm ? false : "no npm beside this Node" }, async (t) => {
  const r = await registry(t);
  const tc = toolchain();
  const a = tarball(t, "fixture-a", "1.0.0");
  r.files.set("/fixture-a/-/fixture-a-1.0.0.tgz", a.bytes);
  const cache = tmp(t);
  const result = await downloadTarballs([{ url: `${REG}/fixture-a/-/fixture-a-1.0.0.tgz`, integrity: a.integrity }], cache, tc, r.seams);
  assert.deepEqual(result, { count: 1, bytes: a.bytes.length });
  const cacache = createRequire(tc.npmCli)("cacache");
  assert.deepEqual(await cacache.get.byDigest(path.join(cache, "_cacache"), a.integrity), a.bytes);
  const info = await cacache.get.info(path.join(cache, "_cacache"), cacheKeyOf(`${REG}/fixture-a/-/fixture-a-1.0.0.tgz`));
  assert.equal(info.integrity, a.integrity);
  assert.deepEqual(r.server.arrivals.map((x) => `${x.method} ${x.url}`), ["GET /fixture-a/-/fixture-a-1.0.0.tgz"]);
  assert.equal(r.server.arrivals[0]!.headers.authorization, undefined, "nothing but the tarball's path is sent");
});

test("a body whose sha512 differs fails install_failed and writes nothing", { skip: hasNpm ? false : "no npm beside this Node" }, async (t) => {
  const r = await registry(t);
  const a = tarball(t, "fixture-a", "1.0.0");
  const other = tarball(t, "fixture-a", "1.0.1");
  r.files.set("/fixture-a/-/fixture-a-1.0.0.tgz", other.bytes);
  const cache = tmp(t);
  await assert.rejects(downloadTarballs([{ url: `${REG}/fixture-a/-/fixture-a-1.0.0.tgz`, integrity: a.integrity }], cache, toolchain(), r.seams), /^Error: install_failed: \/fixture-a\/-\/fixture-a-1\.0\.0\.tgz does not match its lockfile sha512$/);
  assert.deepEqual(cacheEntries(cache), []);
});

test("a redirect fails install_failed, to the same host or another, and the other host is never contacted", { skip: hasNpm ? false : "no npm beside this Node" }, async (t) => {
  const r = await registry(t);
  const elsewhere = await startTestServer("elsewhere.test");
  t.after(() => elsewhere.close());
  const a = tarball(t, "fixture-a", "1.0.0");
  r.files.set("/fixture-a/-/fixture-a-1.0.1.tgz", a.bytes);
  for (const location of [`${REG}:${r.server.port}/fixture-a/-/fixture-a-1.0.1.tgz`, `${elsewhere.url}/fixture-a-1.0.0.tgz`]) {
    r.server.answer((_x, res) => {
      res.writeHead(302, { location });
      res.end();
    });
    await assert.rejects(downloadTarballs([{ url: `${REG}/fixture-a/-/fixture-a-1.0.0.tgz`, integrity: a.integrity }], tmp(t), toolchain(), { ...r.seams, ca: [r.server.caPem, elsewhere.caPem] }), /install_failed: fetching .* failed \(redirect 302\)/);
  }
  assert.deepEqual(elsewhere.arrivals, []);
  assert.equal(r.server.arrivals.length, 2, "one request each, no follow");
});

test("a tarball over its cap, tarballs over the total, a non-200 and a hang past the deadline all fail install_failed", { skip: hasNpm ? false : "no npm beside this Node" }, async (t) => {
  const r = await registry(t);
  const a = tarball(t, "fixture-a", "1.0.0");
  const b = tarball(t, "fixture-b", "1.0.0");
  r.files.set("/fixture-a/-/fixture-a-1.0.0.tgz", a.bytes);
  r.files.set("/fixture-b/-/fixture-b-1.0.0.tgz", b.bytes);
  const both: Tarball[] = [{ url: `${REG}/fixture-a/-/fixture-a-1.0.0.tgz`, integrity: a.integrity }, { url: `${REG}/fixture-b/-/fixture-b-1.0.0.tgz`, integrity: b.integrity }];
  await assert.rejects(downloadTarballs(both.slice(0, 1), tmp(t), toolchain(), { ...r.seams, tarballMaxBytes: a.bytes.length - 1 }), /install_failed: .*too_large/);
  await assert.rejects(downloadTarballs(both, tmp(t), toolchain(), { ...r.seams, totalMaxBytes: a.bytes.length + b.bytes.length - 1 }), /install_failed: .*too_large/);
  await assert.rejects(downloadTarballs([{ url: `${REG}/fixture-c/-/fixture-c-1.0.0.tgz`, integrity: a.integrity }], tmp(t), toolchain(), r.seams), /install_failed: .*status 404/);
  r.server.answer(() => undefined);
  const started = Date.now();
  await assert.rejects(downloadTarballs(both.slice(0, 1), tmp(t), toolchain(), { ...r.seams, deadlineMs: 300 }), /install_failed: .*timeout/);
  assert.ok(Date.now() - started < 5_000);
});

test("the job's proxy is ignored: the registry is reached directly", { skip: hasNpm ? false : "no npm beside this Node" }, async (t) => {
  const proxyHits: string[] = [];
  const proxy = createServer((req, res) => {
    proxyHits.push(String(req.url));
    res.writeHead(502).end();
  });
  proxy.on("connect", (req, socket) => {
    proxyHits.push(`CONNECT ${req.url}`);
    socket.destroy();
  });
  await new Promise<void>((resolve) => proxy.listen(0, "127.0.0.1", resolve));
  t.after(() => proxy.close());
  const r = await registry(t);
  const a = tarball(t, "fixture-a", "1.0.0");
  r.files.set("/fixture-a/-/fixture-a-1.0.0.tgz", a.bytes);
  const saved = { HTTPS_PROXY: process.env.HTTPS_PROXY, https_proxy: process.env.https_proxy };
  process.env.HTTPS_PROXY = process.env.https_proxy = `http://127.0.0.1:${(proxy.address() as AddressInfo).port}`;
  try {
    await downloadTarballs([{ url: `${REG}/fixture-a/-/fixture-a-1.0.0.tgz`, integrity: a.integrity }], tmp(t), toolchain(), r.seams);
  } finally {
    for (const [k, v] of Object.entries(saved)) if (v === undefined) delete process.env[k]; else process.env[k] = v;
  }
  assert.deepEqual(proxyHits, []);
  assert.equal(r.server.arrivals.length, 1);
});

test("a refused checkout fetches nothing", async (t) => {
  const r = await registry(t);
  const ws = tmp(t);
  writeFileSync(path.join(ws, "package.json"), JSON.stringify({ name: "app", version: "1.0.0" }));
  writeFileSync(path.join(ws, "yarn.lock"), "");
  await assert.rejects(fetchPreinstall(ws, toolchain(), tmp(t), { uid: 0, gid: 0 }, r.seams), /install_unsupported: .*yarn\.lock/);
  assert.deepEqual(r.server.arrivals, []);
});

test("with the real npm: the download phase fills the cache, npm ci --offline installs from it with no network and no lifecycle script, and a missing tarball fails rather than fetches", { skip: canUnshare && hasNpm ? false : "needs passwordless sudo, unshare and npm beside this Node" }, async (t) => {
  const r = await registry(t);
  const scratch = tmp(t);
  const marker = path.join(scratch, "script-ran");
  const a = tarball(t, "fixture-a", "1.0.0", { scripts: { install: `touch ${marker}`, postinstall: `touch ${marker}` } });
  const b = tarball(t, "fixture-b", "2.1.0");
  r.files.set("/fixture-a/-/fixture-a-1.0.0.tgz", a.bytes);
  r.files.set("/fixture-b/-/fixture-b-2.1.0.tgz", b.bytes);
  const deps = { "fixture-a": "1.0.0", "fixture-b": "^2.0.0" };
  const ws = tmp(t, "peeps-fetch-ws-");
  writeFileSync(path.join(ws, "package.json"), JSON.stringify({ name: "app", version: "1.0.0", dependencies: deps, scripts: { preinstall: `touch ${marker}` } }));
  writeFileSync(path.join(ws, "package-lock.json"), JSON.stringify({ name: "app", version: "1.0.0", lockfileVersion: 3, requires: true, packages: {
    "": { name: "app", version: "1.0.0", dependencies: deps },
    "node_modules/fixture-a": { version: "1.0.0", resolved: `${REG}/fixture-a/-/fixture-a-1.0.0.tgz`, integrity: a.integrity, hasInstallScript: true },
    "node_modules/fixture-b": { version: "2.1.0", resolved: `${REG}/fixture-b/-/fixture-b-2.1.0.tgz`, integrity: b.integrity },
  } }));
  const ids = { uid: process.getuid!(), gid: process.getgid!() };
  const lines: string[] = [];
  const digests = await fetchPreinstall(ws, toolchain(), scratch, ids, r.seams, undefined, (line) => lines.push(line));
  assert.equal(JSON.parse(readFileSync(path.join(ws, "node_modules/fixture-a/package.json"), "utf8")).version, "1.0.0");
  assert.equal(JSON.parse(readFileSync(path.join(ws, "node_modules/fixture-b/package.json"), "utf8")).version, "2.1.0");
  assert.match(digests.hiddenLock, /^[0-9a-f]{64}$/);
  assert.equal(existsSync(marker), false, "a lifecycle script ran");
  assert.deepEqual(r.server.arrivals.map((x) => x.url).sort(), ["/fixture-a/-/fixture-a-1.0.0.tgz", "/fixture-b/-/fixture-b-2.1.0.tgz"]);
  assert.match(lines[0]!, /^downloaded 2 tarballs \(\d+ bytes\) from registry\.npmjs\.org, each checked against its lockfile sha512$/);
  assert.equal(lines[1], "npm ci --offline --ignore-scripts ran in a network namespace with no interface");

  // A tarball the download phase didn't fetch is a miss, never a fetch.
  rmSync(path.join(ws, "node_modules"), { recursive: true });
  const again = tmp(t);
  r.files.delete("/fixture-b/-/fixture-b-2.1.0.tgz");
  const before = r.server.arrivals.length;
  await assert.rejects(fetchPreinstall(ws, toolchain(), again, ids, r.seams), /install_failed/);
  assert.equal(existsSync(path.join(ws, "node_modules/fixture-b")), false);
  assert.ok(r.server.arrivals.length - before <= 2);
});
