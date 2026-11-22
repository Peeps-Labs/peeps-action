/**
 * The customer install's download phase (CW plan §4.5, §6.2): every lockfile tarball fetched by
 * the action from registry.npmjs.org over the hardened transport, checked by sha512, written
 * into npm's cache; then npm installs offline in a namespace with no network. A local HTTPS
 * server under the test's CA stands in for the registry, resolved by the transport's lookup seam.
 */
import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { offlineInstallArgv, offlinePreinstall, type Toolchain } from "../src/load/install";
import { cacheKeyOf, downloadTarballs, fetchPreinstall, lockedTarballs, type RegistryFetchSeams, type Tarball } from "../src/load/registry-fetch";
import { loopbackLookup, startTestServer, type TestServer } from "./support/control-server";
import { envProxySupported, recordingProxy, runWithEnvProxy } from "./support/env-proxy";

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

/** CI's load-jail job sets it: there a skip for want of npm, sudo or unshare is a failure. */
const REQUIRED = process.env.LOAD_JAIL_TESTS === "1";

test("with LOAD_JAIL_TESTS=1 the real-npm tests can't skip: npm, sudo and unshare are here", { skip: REQUIRED ? false : "LOAD_JAIL_TESTS is not set" }, () => {
  assert.ok(hasNpm, `no npm beside ${process.execPath}`);
  assert.ok(canUnshare, "no passwordless sudo unshare --net");
});

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

test("lockedTarballs skips an optional entry whose os, cpu or libc leaves out linux x64 glibc, as npm does (@next/swc's set)", () => {
  const sri = (n: number) => `sha512-${Buffer.alloc(64, n).toString("base64")}`;
  const swc = (name: string, n: number, more: Record<string, unknown>, optional = true) => [`node_modules/@next/${name}`, { version: "15.0.0", resolved: `${REG}/@next/${name}/-/${name}-15.0.0.tgz`, integrity: sri(n), ...(optional ? { optional: true } : {}), ...more }] as const;
  const lock = { packages: Object.fromEntries([
    ["", { name: "app" }],
    ["node_modules/next", { version: "15.0.0", resolved: `${REG}/next/-/next-15.0.0.tgz`, integrity: sri(1) }],
    swc("swc-linux-x64-gnu", 2, { os: ["linux"], cpu: ["x64"], libc: ["glibc"] }),
    swc("swc-linux-x64-musl", 3, { os: ["linux"], cpu: ["x64"], libc: ["musl"] }),
    swc("swc-linux-arm64-gnu", 4, { os: ["linux"], cpu: ["arm64"], libc: ["glibc"] }),
    swc("swc-darwin-arm64", 5, { os: ["darwin"], cpu: ["arm64"] }),
    swc("swc-win32-x64-msvc", 6, { os: ["win32"], cpu: ["x64"] }),
    swc("swc-not-darwin", 7, { os: ["!darwin"] }),
    swc("swc-not-linux", 8, { os: ["!linux"] }),
    swc("swc-any", 9, { os: "any", cpu: ["x64", "arm64"] }),
    // Not optional: npm would refuse it EBADPLATFORM rather than skip it, so it is kept.
    swc("swc-required-darwin", 10, { os: ["darwin"] }, false),
  ]) };
  const kept = lockedTarballs(lock).map((x) => x.url.replace(`${REG}/`, ""));
  assert.deepEqual(kept, [
    "next/-/next-15.0.0.tgz",
    "@next/swc-linux-x64-gnu/-/swc-linux-x64-gnu-15.0.0.tgz",
    "@next/swc-not-darwin/-/swc-not-darwin-15.0.0.tgz",
    "@next/swc-any/-/swc-any-15.0.0.tgz",
    "@next/swc-required-darwin/-/swc-required-darwin-15.0.0.tgz",
  ]);
});

test("the cache check skips the same optional platform entries: a recipe without darwin's tarball is not refused for it", { skip: hasNpm ? false : "no npm beside this Node" }, async (t) => {
  const ws = tmp(t, "peeps-fetch-ws-");
  const sri = `sha512-${Buffer.alloc(64, 5).toString("base64")}`;
  const deps = { "@next/swc-darwin-arm64": "15.0.0" };
  writeFileSync(path.join(ws, "package.json"), JSON.stringify({ name: "app", version: "1.0.0", optionalDependencies: deps }));
  writeFileSync(path.join(ws, "package-lock.json"), JSON.stringify({ name: "app", version: "1.0.0", lockfileVersion: 3, requires: true, packages: {
    "": { name: "app", version: "1.0.0", optionalDependencies: deps },
    "node_modules/@next/swc-darwin-arm64": { version: "15.0.0", resolved: `${REG}/@next/swc-darwin-arm64/-/swc-darwin-arm64-15.0.0.tgz`, integrity: sri, optional: true, os: ["darwin"], cpu: ["arm64"] },
  } }));
  // With nothing to check, npm itself is next: with sudo and unshare here it installs nothing and
  // skips the package, as npm does; without them it fails to start. Either way not the cache check.
  const outcome = await offlinePreinstall(ws, toolchain(), tmp(t), { cache: tmp(t), uid: process.getuid!(), gid: process.getgid!() }).then(() => "installed", (e: Error) => e.message);
  assert.doesNotMatch(outcome, /cached tarball/);
  if (canUnshare) assert.equal(outcome, "installed");
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
  await assert.rejects(downloadTarballs([{ url: `${REG}/fixture-a/-/fixture-a-1.0.0.tgz`, integrity: a.integrity }], cache, toolchain(), r.seams), /^InstallFailed: install_failed: \/fixture-a\/-\/fixture-a-1\.0\.0\.tgz does not match its lockfile sha512$/);
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
  await assert.rejects(downloadTarballs(both, tmp(t), toolchain(), { ...r.seams, totalMaxBytes: a.bytes.length + b.bytes.length - 1 }), /install_failed: the downloads passed \d+ bytes in all \(total too large\)$/);
  await assert.rejects(downloadTarballs([{ url: `${REG}/fixture-c/-/fixture-c-1.0.0.tgz`, integrity: a.integrity }], tmp(t), toolchain(), r.seams), /install_failed: .*status 404/);
  r.server.answer(() => undefined);
  const started = Date.now();
  await assert.rejects(downloadTarballs(both.slice(0, 1), tmp(t), toolchain(), { ...r.seams, deadlineMs: 300 }), /install_failed: .*timeout/);
  assert.ok(Date.now() - started < 5_000);
});

test("the first failure stops the others: no new tarball is taken and nothing more is cached", { skip: hasNpm ? false : "no npm beside this Node" }, async (t) => {
  const r = await registry(t);
  const good = Array.from({ length: 10 }, (_, i) => tarball(t, `fixture-${i}`, "1.0.0"));
  const list: Tarball[] = good.map((g, i) => ({ url: `${REG}/fixture-${i}/-/fixture-${i}-1.0.0.tgz`, integrity: g.integrity }));
  for (const [i, g] of good.entries()) r.files.set(`/fixture-${i}/-/fixture-${i}-1.0.0.tgz`, g.bytes);
  r.files.set("/fixture-0/-/fixture-0-1.0.0.tgz", good[1]!.bytes);
  r.server.answer((a, res) => {
    const body = r.files.get(a.url)!;
    const send = () => res.writeHead(200, { "content-length": String(body.length) }).end(body);
    // The bad one answers at once; the others hang until the test ends.
    if (a.url.startsWith("/fixture-0/")) send();
  });
  const cache = tmp(t);
  const started = Date.now();
  await assert.rejects(downloadTarballs(list, cache, toolchain(), { ...r.seams, deadlineMs: 20_000 }), /install_failed: \/fixture-0\/-\/fixture-0-1\.0\.0\.tgz does not match its lockfile sha512/);
  assert.ok(Date.now() - started < 5_000, "the hanging downloads were stopped, not waited out");
  const asked = r.server.arrivals.map((a) => a.url);
  assert.ok(!asked.includes("/fixture-8/-/fixture-8-1.0.0.tgz") && !asked.includes("/fixture-9/-/fixture-9-1.0.0.tgz"), `no new work after the failure: ${asked.join(", ")}`);
  assert.deepEqual(cacheEntries(cache), []);
});

test("a dropped connection or a 5xx is retried twice with a fresh hash; a 4xx, a redirect or a sha512 mismatch never", { skip: hasNpm ? false : "no npm beside this Node" }, async (t) => {
  const r = await registry(t);
  const a = tarball(t, "fixture-a", "1.0.0");
  const url = `${REG}/fixture-a/-/fixture-a-1.0.0.tgz`;
  const one = [{ url, integrity: a.integrity }];
  const script = (answers: ("ok" | "503" | "drop" | "half" | "404" | "302" | "bad")[]) => {
    let n = 0;
    r.server.answer((_x, res) => {
      const what = answers[Math.min(n++, answers.length - 1)];
      if (what === "ok") res.writeHead(200, { "content-length": String(a.bytes.length) }).end(a.bytes);
      else if (what === "503") res.writeHead(503).end();
      else if (what === "404") res.writeHead(404).end();
      else if (what === "302") res.writeHead(302, { location: url }).end();
      else if (what === "bad") res.writeHead(200).end(Buffer.from("not the tarball"));
      else if (what === "half") {
        res.writeHead(200, { "content-length": String(a.bytes.length) });
        res.write(a.bytes.subarray(0, 10));
        setTimeout(() => res.destroy(), 20);
      } else res.destroy();
    });
    return () => n;
  };
  for (const answers of [["503", "ok"], ["drop", "ok"], ["half", "503", "ok"]] as const) {
    const count = script([...answers]);
    const cache = tmp(t);
    const got = await downloadTarballs(one, cache, toolchain(), r.seams);
    assert.deepEqual(got, { count: 1, bytes: a.bytes.length }, answers.join(" "));
    assert.equal(count(), answers.length);
    assert.equal(cacheEntries(cache).length, 1);
  }
  // The 1 GiB is of every byte received, retries included: a cap between the verified total and
  // what arrived (the partial body, then the whole one) fails, as its own reason, and is not retried.
  const partial = script(["half", "ok", "ok"]);
  await assert.rejects(downloadTarballs(one, tmp(t), toolchain(), { ...r.seams, totalMaxBytes: a.bytes.length + 5 }), /install_failed: the downloads passed \d+ bytes in all \(total too large\)$/);
  assert.equal(partial(), 2, "the retry that crossed the total is not retried again");
  const persistent = script(["503"]);
  await assert.rejects(downloadTarballs(one, tmp(t), toolchain(), r.seams), /install_failed: .*status 503/);
  assert.equal(persistent(), 3, "two retries, then it fails");
  for (const [answer, error] of [["404", /status 404/], ["302", /redirect 302/], ["bad", /does not match its lockfile sha512/]] as const) {
    const count = script([answer, "ok"]);
    await assert.rejects(downloadTarballs(one, tmp(t), toolchain(), r.seams), error);
    assert.equal(count(), 1, `${answer} is never retried`);
  }
});

test("an attempt that receives nothing for the idle limit is a dropped connection: retried, and after two retries it fails as stalled", { skip: hasNpm ? false : "no npm beside this Node" }, async (t) => {
  const r = await registry(t);
  const a = tarball(t, "fixture-a", "1.0.0");
  const one = [{ url: `${REG}/fixture-a/-/fixture-a-1.0.0.tgz`, integrity: a.integrity }];
  const open = new Set<{ destroy(): void }>();
  t.after(() => { for (const res of open) res.destroy(); });
  const script = (answers: ("ok" | "stall" | "silent")[]) => {
    let n = 0;
    r.server.answer((_x, res) => {
      const what = answers[Math.min(n++, answers.length - 1)];
      open.add(res);
      if (what === "ok") res.writeHead(200, { "content-length": String(a.bytes.length) }).end(a.bytes);
      else if (what === "stall") {
        // Some of the body, then nothing: the connection stays open.
        res.writeHead(200, { "content-length": String(a.bytes.length) });
        res.write(a.bytes.subarray(0, 10));
      }
      // "silent": no answer at all, not even headers.
    });
    return () => n;
  };
  const seams = { ...r.seams, idleMs: 200, deadlineMs: 20_000 };
  for (const answers of [["stall", "ok"], ["silent", "ok"]] as const) {
    const count = script([...answers]);
    const cache = tmp(t);
    assert.deepEqual(await downloadTarballs(one, cache, toolchain(), seams), { count: 1, bytes: a.bytes.length }, answers.join(" "));
    assert.equal(count(), 2, answers.join(" "));
    assert.equal(cacheEntries(cache).length, 1);
  }
  const stuck = script(["stall"]);
  const started = Date.now();
  await assert.rejects(downloadTarballs(one, tmp(t), toolchain(), seams), /^InstallFailed: install_failed: fetching \/fixture-a\/-\/fixture-a-1\.0\.0\.tgz failed \(stalled\)$/);
  assert.equal(stuck(), 3, "two retries, then it fails");
  assert.ok(Date.now() - started < 10_000, "the idle limit ended each attempt, not the 20 s deadline");
});

test("the download ignores the job's proxy: with Node's env proxy on from startup, only the global agent's control request reaches it", { skip: hasNpm && envProxySupported ? false : "needs npm beside this Node, and Node 24.5 or later for NODE_USE_ENV_PROXY" }, async (t) => {
  const proxy = await recordingProxy(t);
  const r = await registry(t);
  const a = tarball(t, "fixture-a", "1.0.0");
  r.files.set("/fixture-a/-/fixture-a-1.0.0.tgz", a.bytes);
  const result = await runWithEnvProxy(proxy.url, {
    controlUrl: "https://control.test:9/",
    ca: [r.server.caPem],
    download: { tarballs: [{ url: `${REG}/fixture-a/-/fixture-a-1.0.0.tgz`, integrity: a.integrity }], cache: tmp(t), port: r.server.port, toolchain: toolchain() },
  });
  assert.deepEqual(proxy.hits, ["CONNECT control.test:9"], "the control went through the proxy, the download did not");
  assert.deepEqual(result, { count: 1, bytes: a.bytes.length });
  assert.equal(r.server.arrivals.length, 1);
});

test("a refused checkout fetches nothing", async (t) => {
  const r = await registry(t);
  const ws = tmp(t);
  writeFileSync(path.join(ws, "package.json"), JSON.stringify({ name: "app", version: "1.0.0" }));
  writeFileSync(path.join(ws, "yarn.lock"), "");
  // A toolchain that is never read: the refusal comes first, so no npm need be here.
  const none: Toolchain = { nodeDir: "/nonexistent/node", node: "/nonexistent/node/bin/node", npmCli: "/nonexistent/npm-cli.js", nodeVersion: "24.22.3", npmVersion: "11.19.1" };
  await assert.rejects(fetchPreinstall(ws, none, tmp(t), { uid: 0, gid: 0 }, r.seams), /install_unsupported: .*yarn\.lock/);
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

  // A tarball the download phase didn't fetch is refused by the cache check before npm starts,
  // never fetched: the download phase gets fixture-a only, and the check finds fixture-b missing.
  // (npm's own offline miss, should it ever be reached, is the next test.)
  rmSync(path.join(ws, "node_modules"), { recursive: true });
  const again = tmp(t);
  const cache = path.join(again, "cache");
  mkdirSync(cache);
  const before = r.server.arrivals.length;
  await downloadTarballs([{ url: `${REG}/fixture-a/-/fixture-a-1.0.0.tgz`, integrity: a.integrity }], cache, toolchain(), r.seams);
  assert.equal(r.server.arrivals.length - before, 1, "the download phase fetched fixture-a only");
  await assert.rejects(offlinePreinstall(ws, toolchain(), again, { cache, ...ids }), /^InstallFailed: install_failed: the cached tarball for node_modules\/fixture-b is missing or corrupt$/);
  assert.equal(existsSync(path.join(ws, "node_modules/fixture-b")), false);
  assert.equal(r.server.arrivals.length - before, 1, "nothing reached the registry during the install");
});

test("with the real npm: the offline install's own command, given a cache that misses a tarball, fails on the miss (ENOTCACHED) and fetches nothing", { skip: canUnshare && hasNpm ? false : "needs passwordless sudo, unshare and npm beside this Node" }, async (t) => {
  const r = await registry(t);
  const a = tarball(t, "fixture-a", "1.0.0");
  const b = tarball(t, "fixture-b", "2.1.0");
  r.files.set("/fixture-a/-/fixture-a-1.0.0.tgz", a.bytes);
  const deps = { "fixture-a": "1.0.0", "fixture-b": "2.1.0" };
  const ws = tmp(t, "peeps-fetch-ws-");
  writeFileSync(path.join(ws, "package.json"), JSON.stringify({ name: "app", version: "1.0.0", dependencies: deps }));
  writeFileSync(path.join(ws, "package-lock.json"), JSON.stringify({ name: "app", version: "1.0.0", lockfileVersion: 3, requires: true, packages: {
    "": { name: "app", version: "1.0.0", dependencies: deps },
    "node_modules/fixture-a": { version: "1.0.0", resolved: `${REG}/fixture-a/-/fixture-a-1.0.0.tgz`, integrity: a.integrity },
    "node_modules/fixture-b": { version: "2.1.0", resolved: `${REG}/fixture-b/-/fixture-b-2.1.0.tgz`, integrity: b.integrity },
  } }));
  const scratch = tmp(t);
  const cache = path.join(scratch, "cache");
  mkdirSync(cache);
  await downloadTarballs([{ url: `${REG}/fixture-a/-/fixture-a-1.0.0.tgz`, integrity: a.integrity }], cache, toolchain(), r.seams);
  const before = r.server.arrivals.length;
  // The command offlinePreinstall runs, without the cache check in front of it.
  const { file, args } = offlineInstallArgv(toolchain(), cache, scratch, { uid: process.getuid!(), gid: process.getgid!() });
  const ran = spawnSync(file, args, { cwd: ws, env: { PATH: "/usr/bin:/bin" }, encoding: "utf8", timeout: 120_000 });
  assert.notEqual(ran.status, 0, ran.stdout + ran.stderr);
  assert.match(ran.stdout + ran.stderr, /ENOTCACHED/);
  assert.equal(existsSync(path.join(ws, "node_modules/fixture-b")), false);
  assert.equal(r.server.arrivals.length, before, "npm reached nothing");
});
