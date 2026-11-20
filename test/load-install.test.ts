/**
 * The pre-claim install (e4 plan v3 §2.2): npm runs only after the root manifest and the
 * lockfile pass validation, only with trusted config, from a trusted toolchain; and the
 * checkout is recorded by a digest and a HEAD read without git.
 */
import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import {
  checkoutHead,
  installEnv,
  installProblems,
  preinstall,
  readWorkspace,
  satisfies,
  treeDigest,
  trustedToolchain,
  type Toolchain,
} from "../src/load/install";

const REG = "https://registry.npmjs.org";
const INTEGRITY = "sha512-" + "A".repeat(86) + "==";

function tmp(t: TestContext, prefix = "peeps-install-"): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), prefix));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

interface Fixture {
  manifest?: Record<string, unknown>;
  lock?: Record<string, unknown> | null;
  files?: Record<string, string>;
}

const BASE_MANIFEST = { name: "app", version: "1.0.0", dependencies: { "left-pad": "^1.3.0" }, devDependencies: { "@playwright/test": "~1.50.0" } };
function baseLock(): Record<string, unknown> {
  return {
    name: "app",
    version: "1.0.0",
    lockfileVersion: 3,
    requires: true,
    packages: {
      "": { name: "app", version: "1.0.0", dependencies: { "left-pad": "^1.3.0" }, devDependencies: { "@playwright/test": "~1.50.0" } },
      "node_modules/left-pad": { version: "1.3.0", resolved: `${REG}/left-pad/-/left-pad-1.3.0.tgz`, integrity: INTEGRITY },
      "node_modules/@playwright/test": { version: "1.50.1", resolved: `${REG}/@playwright/test/-/test-1.50.1.tgz`, integrity: INTEGRITY, dev: true },
    },
  };
}

function workspace(t: TestContext, f: Fixture = {}): string {
  const dir = tmp(t);
  writeFileSync(path.join(dir, "package.json"), JSON.stringify(f.manifest ?? BASE_MANIFEST));
  const lock = f.lock === undefined ? baseLock() : f.lock;
  if (lock) writeFileSync(path.join(dir, "package-lock.json"), JSON.stringify(lock));
  for (const [name, content] of Object.entries(f.files ?? {})) {
    mkdirSync(path.dirname(path.join(dir, name)), { recursive: true });
    writeFileSync(path.join(dir, name), content);
  }
  return dir;
}

const problems = (dir: string) => installProblems(readWorkspace(dir));

test("a public-registry npm project with lockfile v3 is installable", (t) => {
  assert.deepEqual(problems(workspace(t)), []);
  const v2 = baseLock();
  v2.lockfileVersion = 2;
  (v2 as { dependencies?: unknown }).dependencies = { "left-pad": { version: "1.3.0", resolved: `${REG}/left-pad/-/left-pad-1.3.0.tgz`, integrity: INTEGRITY } };
  assert.deepEqual(problems(workspace(t, { lock: v2 })), [], "v2 with a legacy dependencies tree");
  const bundled = baseLock();
  (bundled.packages as Record<string, unknown>)["node_modules/left-pad/node_modules/x"] = { version: "1.0.0", inBundle: true };
  assert.deepEqual(problems(workspace(t, { lock: bundled })), [], "a bundled dependency carries no resolved URL");
  const aliased = { ...BASE_MANIFEST, dependencies: { pad: "npm:left-pad@^1.3.0" } };
  const aliasLock = baseLock();
  const pk = aliasLock.packages as Record<string, Record<string, unknown>>;
  pk[""] = { ...pk[""], dependencies: { pad: "npm:left-pad@^1.3.0" } };
  pk["node_modules/pad"] = { ...pk["node_modules/left-pad"], name: "left-pad" };
  delete pk["node_modules/left-pad"];
  assert.deepEqual(problems(workspace(t, { manifest: aliased, lock: aliasLock })), [], "an npm: alias to a range");
});

test("manifest specs other than a semver range are refused, in workspaces too", (t) => {
  const specs = ["git+https://github.com/a/b.git", "github:a/b", "a/b", "file:../x", "link:../x", "https://example.com/x.tgz", "http://example.com/x.tgz", "./x.tgz", "../x", "npm:left-pad@git+https://x", "latest", "workspace:*"];
  for (const spec of specs) {
    const manifest = { ...BASE_MANIFEST, dependencies: { "left-pad": spec } };
    assert.match(problems(workspace(t, { manifest })).join("; "), /left-pad/, spec);
  }
  for (const field of ["devDependencies", "optionalDependencies", "peerDependencies"]) {
    const manifest = { ...BASE_MANIFEST, [field]: { evil: "file:../evil" } };
    assert.match(problems(workspace(t, { manifest })).join("; "), /evil/, field);
  }
  const outside = { ...BASE_MANIFEST, workspaces: ["../elsewhere"] };
  assert.match(problems(workspace(t, { manifest: outside })).join("; "), /workspace/);
  const inner = { ...BASE_MANIFEST, workspaces: ["packages/*"] };
  const dir = workspace(t, { manifest: inner, files: { "packages/a/package.json": JSON.stringify({ name: "a", dependencies: { x: "git+ssh://git@github.com/a/x.git" } }) } });
  assert.match(problems(dir).join("; "), /packages\/a.*x|x.*packages\/a/);
});

test("lockfile problems are refused: v1, none, shrinkwrap, foreign hosts, http, no integrity, legacy git, links outside", (t) => {
  const v1 = { name: "app", lockfileVersion: 1, dependencies: {} };
  assert.match(problems(workspace(t, { lock: v1 })).join("; "), /lockfile/);
  assert.match(problems(workspace(t, { lock: null })).join("; "), /package-lock\.json/);
  assert.match(problems(workspace(t, { files: { "npm-shrinkwrap.json": "{}" } })).join("; "), /shrinkwrap/);
  const mutate = (fn: (p: Record<string, Record<string, unknown>>, lock: Record<string, unknown>) => void) => {
    const lock = baseLock();
    fn(lock.packages as Record<string, Record<string, unknown>>, lock);
    return problems(workspace(t, { lock })).join("; ");
  };
  assert.match(mutate((p) => (p["node_modules/left-pad"]!.resolved = "https://evil.example/left-pad-1.3.0.tgz")), /left-pad/);
  assert.match(mutate((p) => (p["node_modules/left-pad"]!.resolved = "https://registry.npmjs.org.evil.example/left-pad.tgz")), /left-pad/);
  assert.match(mutate((p) => (p["node_modules/left-pad"]!.resolved = "http://registry.npmjs.org/left-pad/-/left-pad-1.3.0.tgz")), /left-pad/);
  assert.match(mutate((p) => delete p["node_modules/left-pad"]!.integrity), /left-pad/);
  assert.match(mutate((p) => (p["node_modules/left-pad"]!.resolved = "git+ssh://git@github.com/a/left-pad.git#abc")), /left-pad/);
  assert.match(mutate((_p, lock) => (lock.dependencies = { "left-pad": { version: "github:a/left-pad#abc" } })), /left-pad/);
  assert.match(mutate((_p, lock) => (lock.dependencies = { x: { version: "1.0.0", dependencies: { y: { version: "1.0.0", from: "git+https://x/y.git" } } } })), /\by\b/);
  assert.match(mutate((p) => (p["node_modules/linked"] = { resolved: "../outside", link: true })), /linked/);
  assert.match(mutate((p) => (p["node_modules/linked"] = { resolved: "packages/missing", link: true })), /linked/);
});

test("a lock entry is read as npm reads it: inBundle, hasShrinkwrap, a truthy link and a URL for a version open no other host", (t) => {
  const mutate = (fn: (p: Record<string, Record<string, unknown>>) => void) => {
    const lock = baseLock();
    fn(lock.packages as Record<string, Record<string, unknown>>);
    return problems(workspace(t, { lock })).join("; ");
  };
  // npm does not read inBundle from a v2 or v3 lock: it fetches `resolved`.
  assert.match(mutate((p) => (p["node_modules/left-pad"] = { version: "1.3.0", resolved: "https://target.example/a.tgz", integrity: INTEGRITY, inBundle: true })), /left-pad.*registry/);
  assert.match(mutate((p) => (p["node_modules/left-pad/node_modules/x"] = { version: "1.0.0", resolved: "http://target.example/a.tgz", inBundle: true })), /\bx\b.*registry/);
  // With no `resolved`, npm fetches name@version: a URL there is fetched as one.
  assert.match(mutate((p) => (p["node_modules/left-pad/node_modules/x"] = { version: "https://target.example/a.tgz", inBundle: true })), /\bx\b.*bundled/);
  assert.match(mutate((p) => (p["node_modules/left-pad/node_modules/x"] = { name: "x@https://target.example/a.tgz", version: "1.0.0", inBundle: true })), /\bx\b.*bundled/);
  // The package's own shrinkwrap names URLs this check never sees.
  assert.match(mutate((p) => (p["node_modules/left-pad"]!.hasShrinkwrap = true)), /left-pad.*shrinkwrap/);
  // Any truthy `link` is a link to npm.
  assert.match(mutate((p) => Object.assign(p["node_modules/left-pad"]!, { link: 1, resolved: "https://registry.npmjs.org/../../../outside/x" })), /left-pad links to/);
  assert.match(mutate((p) => (p["somewhere/else"] = { link: true, resolved: "../outside" })), /somewhere\/else links to/);
});

test("all install metadata uses supported dependency sources", (t) => {
  const lock = baseLock();
  const packages = lock.packages as Record<string, Record<string, unknown>>;
  packages["node_modules/left-pad"]!.dependencies = { nested: "latest" };
  assert.match(problems(workspace(t, { lock })).join("; "), /left-pad.*nested.*semver/);

  const manifest = { ...BASE_MANIFEST, overrides: { "left-pad": { nested: "latest" } } };
  assert.match(problems(workspace(t, { manifest })).join("; "), /overrides.*nested.*semver/);

  const bundled = baseLock();
  (bundled.packages as Record<string, unknown>)["node_modules/left-pad/node_modules/nested"] = {
    version: "1.0.0", inBundle: true, resolved: "https://example.invalid/nested.tgz",
  };
  assert.match(problems(workspace(t, { lock: bundled })).join("; "), /bundled.*explicit source/);
});

test("a dependency on a declared workspace uses the locked workspace version", (t) => {
  const local = { name: "local", version: "1.3.0" };
  const manifest = { name: "app", version: "1.0.0", dependencies: { local: "^1.0.0" }, workspaces: ["packages/local"] };
  const lock = { lockfileVersion: 3, packages: { "": manifest, "node_modules/local": { resolved: "packages/local", link: true }, "packages/local": local } };
  const files = { "packages/local/package.json": JSON.stringify(local) };
  assert.deepEqual(problems(workspace(t, { manifest, lock, files })), []);
  lock.packages["packages/local"].version = "2.0.0";
  assert.match(problems(workspace(t, { manifest, lock, files })).join("; "), /local.*outside/);
});

test("a project .npmrc and a symlink that leaves the checkout are refused", (t) => {
  assert.match(problems(workspace(t, { files: { ".npmrc": "registry=https://evil.example/\n" } })).join("; "), /\.npmrc/);
  const dir = workspace(t);
  symlinkSync("/etc", path.join(dir, "escape"));
  assert.match(problems(dir).join("; "), /escape/);
  const inside = workspace(t);
  symlinkSync("package.json", path.join(inside, "alias.json"));
  assert.deepEqual(problems(inside), [], "a symlink that stays inside is fine");
});

test("manifest validation does not read metadata outside the checkout", (t) => {
  const outside = workspace(t);
  const ws = workspace(t);
  const manifest = path.join(ws, "package.json");
  rmSync(manifest);
  symlinkSync(path.join(outside, "package.json"), manifest);
  const files = readWorkspace(ws);
  assert.equal(files.manifest, undefined);
  assert.match(installProblems(files).join("; "), /package.json.*inside the checkout/);
});

test("a manifest the lock disagrees with is refused: a range the locked version misses, a missing dependency", (t) => {
  const range = { ...BASE_MANIFEST, dependencies: { "left-pad": "^2.0.0" } };
  const lockForRange = baseLock();
  (lockForRange.packages as Record<string, Record<string, unknown>>)[""]!.dependencies = { "left-pad": "^2.0.0" };
  assert.match(problems(workspace(t, { manifest: range, lock: lockForRange })).join("; "), /left-pad.*1\.3\.0|1\.3\.0.*left-pad/);
  const extra = { ...BASE_MANIFEST, dependencies: { "left-pad": "^1.3.0", "right-pad": "^1.0.0" } };
  assert.match(problems(workspace(t, { manifest: extra })).join("; "), /right-pad/, "the root entry in the lock disagrees");
  const lockAgrees = baseLock();
  (lockAgrees.packages as Record<string, Record<string, unknown>>)[""]!.dependencies = { "left-pad": "^1.3.0", "right-pad": "^1.0.0" };
  assert.match(problems(workspace(t, { manifest: extra, lock: lockAgrees })).join("; "), /right-pad/, "no entry for it in the lock");
});

test("satisfies follows npm for the ranges it reads, and refuses the rest", () => {
  const yes: [string, string][] = [
    ["1.3.0", "^1.3.0"], ["1.9.9", "^1.3.0"], ["0.2.5", "^0.2.3"], ["0.0.3", "^0.0.3"], ["1.2.9", "~1.2.3"], ["1.2.0", "~1.2"],
    ["1.2.3", "1.2.3"], ["1.2.3", "=1.2.3"], ["1.2.3", "v1.2.3"], ["1.5.0", "1.x"], ["1.5.0", "1"], ["1.2.7", "1.2.*"], ["9.9.9", "*"], ["9.9.9", ""],
    ["2.0.0", ">=1.2.3"], ["1.2.4", ">1.2.3"], ["1.2.2", "<1.2.3"], ["1.2.3", "<=1.2.3"], ["1.2.3", "1.2.3 - 2.3.4"], ["2.3.9", "1.2 - 2.3"],
    ["3.1.0", "^1.0.0 || ^3.0.0"], ["1.5.0", ">= 1.0.0 < 2.0.0"], ["1.0.0-beta.2", "^1.0.0-beta.1"], ["1.50.1", "~1.50.0"], ["1.0.0", ">=x"],
  ];
  for (const [v, r] of yes) assert.equal(satisfies(v, r), true, `${v} in ${r}`);
  const no: [string, string][] = [
    ["2.0.0", "^1.3.0"], ["0.3.0", "^0.2.3"], ["0.0.4", "^0.0.3"], ["1.3.0", "~1.2.3"], ["1.2.4", "1.2.3"], ["2.0.0", "1.x"], ["1.2.3", ">1.2.3"],
    ["2.0.0-rc.1", "^1.0.0"], ["1.5.0-beta", "^1.2.3"], ["1.0.0-beta.0", "^1.0.0-beta.1"], ["2.4.0", "1.2 - 2.3"], ["2.0.0", ">= 1.0.0 < 2.0.0"],
    ["1.0.0", "latest"], ["1.0.0", "1.0.0 junk"], ["1.0.0", ">x"], ["1.0.0", "<x"], ["1.0.0", "^1.0.0 ||| 2"], ["not.a.version", "*"],
  ];
  for (const [v, r] of no) assert.equal(satisfies(v, r), false, `${v} not in ${r}`);
});

function fakeToolchain(t: TestContext, nodeVersion: string, npmVersion: string, script = "", dir = tmp(t, "peeps-node-")): string {
  mkdirSync(path.join(dir, "bin"), { recursive: true });
  mkdirSync(path.join(dir, "lib/node_modules/npm/bin"), { recursive: true });
  writeFileSync(path.join(dir, "bin/node"), `#!/bin/sh\necho v${nodeVersion}\n`);
  chmodSync(path.join(dir, "bin/node"), 0o755);
  writeFileSync(path.join(dir, "lib/node_modules/npm/package.json"), JSON.stringify({ name: "npm", version: npmVersion }));
  writeFileSync(path.join(dir, "lib/node_modules/npm/bin/npm-cli.js"), script);
  return dir;
}

test("trustedToolchain only accepts the pinned runner toolcache and checks the versions", (t) => {
  const supported = [{ node: "24.22.3", npm: "11.19.1" }];
  const ws = workspace(t);
  const cache = realpathSync(tmp(t, "peeps-toolcache-"));
  const nodeDir = path.join(cache, "node", "24.22.3", process.arch);
  const verify = (dir: string) => trustedToolchain(dir, ws, supported, cache);

  fakeToolchain(t, "24.22.3", "11.19.1", "", nodeDir);
  assert.equal(verify(nodeDir).node, path.join(nodeDir, "bin/node"));
  assert.equal(verify(nodeDir).npmCli, path.join(nodeDir, "lib/node_modules/npm/bin/npm-cli.js"));

  const unrelated = fakeToolchain(t, "24.22.3", "11.19.1");
  assert.throws(() => verify(unrelated), /install_unsupported.*toolcache/);
  chmodSync(path.join(unrelated, "bin/node"), 0o644);
  assert.throws(() => verify(unrelated), /install_unsupported.*toolcache/, "provenance is checked before any version probe");
  const inWs = fakeToolchain(t, "24.22.3", "11.19.1", "", path.join(ws, "toolchain"));
  assert.throws(() => verify(inWs), /install_unsupported.*toolcache/);

  fakeToolchain(t, "22.1.0", "11.19.1", "", nodeDir);
  assert.throws(() => verify(nodeDir), /install_unsupported.*node 22/);
  fakeToolchain(t, "24.22.3", "11.0.0", "", nodeDir);
  assert.throws(() => verify(nodeDir), /install_unsupported.*npm 11/);

  rmSync(path.join(nodeDir, "lib/node_modules/npm"), { recursive: true });
  symlinkSync(path.join(inWs, "lib/node_modules/npm"), path.join(nodeDir, "lib/node_modules/npm"));
  assert.throws(() => verify(nodeDir), /install_unsupported.*workspace/);
});

test("installEnv is the action's config only: registry fixed, no git, no scripts, nothing from the job", (t) => {
  const scratch = tmp(t);
  const tc: Toolchain = { nodeDir: "/opt/node", node: "/opt/node/bin/node", npmCli: "/opt/node/lib/node_modules/npm/bin/npm-cli.js", nodeVersion: "24.22.3", npmVersion: "11.19.1" };
  process.env.HTTPS_PROXY = "http://job-proxy.example";
  try {
    const env = installEnv(tc, scratch);
    assert.equal(env.PATH, "/opt/node/bin:/usr/bin:/bin");
    assert.equal(env.HOME, path.join(scratch, "home"));
    assert.equal(env.npm_config_registry, "https://registry.npmjs.org/");
    assert.equal(env.npm_config_userconfig, path.join(scratch, "npmrc"));
    assert.equal(env.npm_config_globalconfig, path.join(scratch, "npmrc-global"), "npm refuses one file as both");
    assert.equal(env.npm_config_git, "/bin/false");
    assert.equal(env.npm_config_script_shell, "/bin/false");
    assert.equal(env.npm_config_ignore_scripts, "true");
    assert.equal(env.npm_config_cache, path.join(scratch, "cache"));
    assert.equal(env.npm_config_install_links, "false");
    assert.equal(env.npm_config_audit, "false");
    assert.equal(env.npm_config_fund, "false");
    assert.equal(env.npm_config_update_notifier, "false");
    assert.equal(Object.keys(env).some((k) => /proxy/i.test(k)), false, "nothing from the job");
    for (const file of ["npmrc", "npmrc-global"]) assert.equal(readFileSync(path.join(scratch, file), "utf8"), "registry=https://registry.npmjs.org/\n");
  } finally {
    delete process.env.HTTPS_PROXY;
  }
});

/** A server that counts what reaches it: npm, if it ran, would be pointed at it. */
async function markerServer(t: TestContext) {
  const hits: string[] = [];
  const server = createServer((req, res) => {
    hits.push(`${req.method} ${req.url}`);
    res.writeHead(404).end();
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  t.after(() => server.close());
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, hits };
}

test("a refused workspace never spawns npm: no marker, no request", async (t) => {
  const server = await markerServer(t);
  const marker = path.join(tmp(t), "npm-ran");
  // The toolchain's npm would leave a marker and call the marker server.
  const nodeDir = fakeToolchain(t, "24.22.3", "11.19.1");
  const tc: Toolchain = { nodeDir, node: process.execPath, npmCli: path.join(nodeDir, "lib/node_modules/npm/bin/npm-cli.js"), nodeVersion: "24.22.3", npmVersion: "11.19.1" };
  writeFileSync(tc.npmCli, `require("fs").writeFileSync(${JSON.stringify(marker)}, "x"); require("http").get(${JSON.stringify(server.url)});`);
  const range = { ...BASE_MANIFEST, dependencies: { "left-pad": "^2.0.0" } };
  const lock = baseLock();
  (lock.packages as Record<string, Record<string, unknown>>)[""]!.dependencies = { "left-pad": "^2.0.0" };
  const missing = { ...BASE_MANIFEST, dependencies: { "left-pad": "^1.3.0", "right-pad": "^1.0.0" } };
  for (const ws of [workspace(t, { manifest: range, lock }), workspace(t, { manifest: missing }), workspace(t, { lock: { lockfileVersion: 1 } })]) {
    await assert.rejects(preinstall(ws, tc, tmp(t)), /install_unsupported/);
  }
  await new Promise((r) => setTimeout(r, 200));
  assert.equal(existsSync(marker), false, "npm never ran");
  assert.deepEqual(server.hits, []);
});

const localNodeDir = path.dirname(path.dirname(process.execPath));
const localNpm = path.join(localNodeDir, "lib/node_modules/npm/bin/npm-cli.js");
const hasLocalNpm = existsSync(localNpm);
function localToolchain(): Toolchain {
  const npmVersion = (JSON.parse(readFileSync(path.join(localNodeDir, "lib/node_modules/npm/package.json"), "utf8")) as { version: string }).version;
  return { nodeDir: localNodeDir, node: process.execPath, npmCli: localNpm, nodeVersion: process.versions.node, npmVersion };
}

test("installEnv alone keeps a project .npmrc's git from running, even for a lock installProblems would refuse", { skip: hasLocalNpm ? false : "no npm beside this Node" }, (t) => {
  const marker = path.join(tmp(t), "git-ran");
  const gitScript = path.join(tmp(t), "fake-git");
  writeFileSync(gitScript, `#!/bin/sh\ntouch ${marker}\nexit 1\n`);
  chmodSync(gitScript, 0o755);
  const manifest = { name: "app", version: "1.0.0", dependencies: { x: "git+https://example.invalid/x.git" } };
  const ws = workspace(t, { manifest, lock: { name: "app", lockfileVersion: 1, requires: true, dependencies: { x: { version: "git+https://example.invalid/x.git#0123456789abcdef0123456789abcdef01234567", from: "git+https://example.invalid/x.git" } } }, files: { ".npmrc": `git=${gitScript}\n` } });
  assert.match(problems(ws).join("; "), /lockfile|\.npmrc/, "installProblems refuses it first");
  const scratch = tmp(t);
  const env = installEnv(localToolchain(), scratch);
  const npmGit = execFileSync(process.execPath, [localNpm, "config", "get", "git"], { cwd: ws, env, encoding: "utf8", timeout: 10_000 });
  assert.equal(npmGit.trim(), "/bin/false", "npm itself reads the trusted git setting");
  try {
    execFileSync(process.execPath, [localNpm, "ci", "--ignore-scripts"], { cwd: ws, env, stdio: "ignore", timeout: 60_000 });
  } catch {
    // It fails: what matters is what it ran.
  }
  assert.equal(existsSync(marker), false, "the project's git ran");
});

test("a lock entry marked inBundle does not send npm to another host", { skip: hasLocalNpm ? false : "no npm beside this Node" }, async (t) => {
  const server = await markerServer(t);
  const manifest = { name: "app", version: "1.0.0", dependencies: { x: "1.0.0" } };
  const packages = { "": { name: "app", version: "1.0.0", dependencies: { x: "1.0.0" } }, "node_modules/x": { version: "1.0.0", resolved: `${server.url}/x-1.0.0.tgz`, inBundle: true } };
  const ws = workspace(t, { manifest, lock: { name: "app", version: "1.0.0", lockfileVersion: 3, requires: true, packages } });
  await assert.rejects(preinstall(ws, localToolchain(), tmp(t)), /install_unsupported/);
  assert.deepEqual(server.hits, [], "npm asked another host for a package");
});

test("preinstall runs npm ci with no lifecycle script, and returns the digests", { skip: hasLocalNpm ? false : "no npm beside this Node" }, async (t) => {
  const marker = path.join(tmp(t), "script-ran");
  const manifest = { name: "app", version: "1.0.0", scripts: { preinstall: `touch ${marker}`, install: `touch ${marker}`, postinstall: `touch ${marker}`, prepare: `touch ${marker}` } };
  const lock = { name: "app", version: "1.0.0", lockfileVersion: 3, requires: true, packages: { "": { name: "app", version: "1.0.0" } } };
  const ws = workspace(t, { manifest, lock });
  const digests = await preinstall(ws, localToolchain(), tmp(t));
  assert.equal(existsSync(marker), false, "a lifecycle script ran");
  assert.match(digests.lock, /^[0-9a-f]{64}$/);
  assert.match(digests.tree, /^[0-9a-f]{64}$/);
  assert.equal(digests.tree, await treeDigest(ws));
});

test("treeDigest changes with any file, mode or symlink target, node_modules included; .git is not part of it", async (t) => {
  const ws = workspace(t, { files: { "src/a.ts": "a", "node_modules/x/index.js": "x", ".git/HEAD": "ref: refs/heads/main\n" } });
  symlinkSync("src/a.ts", path.join(ws, "link"));
  const before = await treeDigest(ws);
  assert.equal(await treeDigest(ws), before, "stable");
  const changes: [string, () => void, () => void][] = [
    ["content", () => writeFileSync(path.join(ws, "src/a.ts"), "b"), () => writeFileSync(path.join(ws, "src/a.ts"), "a")],
    ["node_modules content", () => writeFileSync(path.join(ws, "node_modules/x/index.js"), "y"), () => writeFileSync(path.join(ws, "node_modules/x/index.js"), "x")],
    ["mode", () => chmodSync(path.join(ws, "src/a.ts"), 0o755), () => chmodSync(path.join(ws, "src/a.ts"), 0o644)],
    ["symlink target", () => (rmSync(path.join(ws, "link")), symlinkSync("package.json", path.join(ws, "link"))), () => (rmSync(path.join(ws, "link")), symlinkSync("src/a.ts", path.join(ws, "link")))],
    ["a new file", () => writeFileSync(path.join(ws, "node_modules/x/new.js"), ""), () => rmSync(path.join(ws, "node_modules/x/new.js"))],
  ];
  chmodSync(path.join(ws, "src/a.ts"), 0o644);
  const base = await treeDigest(ws);
  for (const [label, change, undo] of changes) {
    change();
    assert.notEqual(await treeDigest(ws), base, label);
    undo();
    assert.equal(await treeDigest(ws), base, `${label} undone`);
  }
  writeFileSync(path.join(ws, ".git/HEAD"), "ref: refs/heads/other\n");
  assert.equal(await treeDigest(ws), base, ".git is excluded");
});

test("checkoutHead reads loose and packed refs as files, and runs nothing from the checkout's git config", (t) => {
  const sha = "0123456789abcdef0123456789abcdef01234567";
  const marker = path.join(tmp(t), "fsmonitor-ran");
  const ws = workspace(t, {
    files: {
      ".git/HEAD": "ref: refs/heads/main\n",
      ".git/refs/heads/main": `${sha}\n`,
      ".git/config": `[core]\n\tfsmonitor = touch ${marker}\n`,
    },
  });
  assert.equal(checkoutHead(ws), sha);
  rmSync(path.join(ws, ".git/refs/heads/main"));
  const packed = "fedcba9876543210fedcba9876543210fedcba98";
  writeFileSync(path.join(ws, ".git/packed-refs"), `# pack-refs with: peeled fully-peeled sorted\n${packed} refs/heads/main\n^${sha}\n`);
  assert.equal(checkoutHead(ws), packed);
  writeFileSync(path.join(ws, ".git/HEAD"), `${sha}\n`);
  assert.equal(checkoutHead(ws), sha, "a detached HEAD");
  writeFileSync(path.join(ws, ".git/HEAD"), "ref: refs/heads/../../evil\n");
  assert.throws(() => checkoutHead(ws));
  assert.equal(existsSync(marker), false);
});

test("cancelling a running preinstall kills npm and waits for it to close", async (t) => {
  const ws = workspace(t);
  const scratch = tmp(t);
  const marker = path.join(scratch, "started");
  const script = path.join(scratch, "npm.cjs");
  writeFileSync(script, `require("node:fs").writeFileSync(${JSON.stringify(marker)}, String(process.pid)); setInterval(() => {}, 1000);`);
  const ac = new AbortController();
  const running = preinstall(ws, {
    node: process.execPath, nodeDir: path.dirname(path.dirname(process.execPath)), npmCli: script,
    nodeVersion: process.version, npmVersion: "11.0.0",
  }, scratch, 2000, ac.signal);
  const cancelled = assert.rejects(running, { name: "AbortError" });
  for (let i = 0; i < 100 && !existsSync(marker); i++) await new Promise((resolve) => setTimeout(resolve, 10));
  assert.ok(existsSync(marker), "the install child was running before cancellation");
  const pid = Number(readFileSync(marker, "utf8"));
  ac.abort();
  await cancelled;
  assert.throws(() => process.kill(pid, 0), { code: "ESRCH" });
});
