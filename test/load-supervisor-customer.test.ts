/**
 * The supervisor's customer-path startup (CW plan §4.5): the toolchain is resolved and checked
 * once, before the probe, and both the probe and the jail take it; a probe whose jail can't start
 * is `fence_unverified`; the install runs in the mode the entry chose; and a customer run has no
 * harness hosts. Every assertion is a count or an order.
 */
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { failureLines } from "../src/load/main";
import { bindingOf, type LoadResult } from "../src/load/supervisor";
import { InstallFailed, InstallRefused, SUPPORTED_TOOLCHAIN, trustedToolchain, type Toolchain } from "../src/load/install";
import type { JailSpec } from "../src/load/jail/spec";
import { fakeJail } from "./support/fake-jail";
import { rig, scripted, why, workspace, WORKLOAD_PATH } from "./support/run-supervisor";

const TC: Toolchain = { nodeDir: "/opt/tc/node/24.22.3/x64", node: "/opt/tc/node/24.22.3/x64/bin/node", npmCli: "/opt/tc/node/24.22.3/x64/lib/node_modules/npm/bin/npm-cli.js", nodeVersion: "24.22.3", npmVersion: "11.19.1" };
const digests = async (w: string) => ({ lock: "", hiddenLock: "", tree: (await bindingOf(w, WORKLOAD_PATH)).observed.treeDigest });

describe("load supervisor: the customer path's startup", { concurrency: 4 }, () => {
  test("a toolchain that fails its check is install_unsupported: no probe, no jail, no claim", async (t) => {
    let probes = 0;
    const r = await rig(t, { seams: { toolchain: () => { throw new Error("node's sha256 is not the pinned one"); }, probe: async () => { probes++; return { passed: true, failures: [], seen: null }; } } });
    const res = await r.result;
    assert.equal(res.status, "didnt_start", why(r, res));
    assert.equal(res.reason, "install_unsupported");
    assert.equal(probes, 0);
    assert.equal(r.jails.made.length, 0);
    assert.equal(r.port.claims.length, 0);
  });

  test("the probe and the jail both run the checked toolchain's node, never nodeDir's", async (t) => {
    const probed: string[] = [];
    const jails = fakeJail();
    const specs: JailSpec[] = [];
    const r = await rig(t, {
      launch: (spec, options, signal) => {
        specs.push(spec);
        return jails.launch(spec, options, signal);
      },
      seams: {
        toolchain: () => TC,
        probe: undefined,
        probeJail: async (base) => {
          probed.push(base.node, base.nodeDir);
          return { passed: true, failures: [], seen: null };
        },
      },
    });
    const res = await r.result;
    assert.equal(res.status, "completed", why(r, res));
    assert.deepEqual(probed, [TC.node, TC.nodeDir]);
    assert.deepEqual(specs.map((s) => [s.node, s.nodeDir]), [[TC.node, TC.nodeDir]]);
  });

  test("a probe whose jail can't start is fence_unverified, and nothing is claimed", async (t) => {
    const r = await rig(t, { seams: { toolchain: () => TC, probe: undefined, probeJail: async () => { throw new Error("sudo: a password is required"); } } });
    const res = await r.result;
    assert.equal(res.status, "didnt_start", why(r, res));
    assert.equal(res.reason, "fence_unverified");
    assert.equal(r.port.claims.length, 0);
    assert.equal(r.jails.made.length, 0);
  });

  test("fetch mode runs the download installer with the checked toolchain; offline mode the cache installer", async (t) => {
    for (const install of [{ mode: "fetch" as const }, { mode: "offline" as const, cache: "/home/runner/cache" }]) {
      const ran: string[] = [];
      const r = await rig(t, {
        install,
        seams: {
          toolchain: () => TC,
          preinstall: undefined,
          installers: {
            fetch: async (ws, tc) => { ran.push(`fetch ${tc.node}`); return digests(ws); },
            offline: async (ws, tc, _scratch, o) => { ran.push(`offline ${tc.node} ${o.cache}`); return digests(ws); },
          },
        },
      });
      const res = await r.result;
      assert.equal(res.status, "completed", why(r, res));
      assert.deepEqual(ran, install.mode === "fetch" ? [`fetch ${TC.node}`] : [`offline ${TC.node} /home/runner/cache`]);
    }
  });

  test("a failed download is install_failed before the claim; a refused checkout is install_unsupported", async (t) => {
    for (const [error, reason] of [[new Error("install_failed: /x/-/x-1.0.0.tgz does not match its lockfile sha512"), "install_failed"], [new InstallRefused(["package-lock.json is missing"]), "install_unsupported"]] as const) {
      const r = await rig(t, { install: { mode: "fetch" }, seams: { toolchain: () => TC, preinstall: undefined, installers: { fetch: async () => { throw error; } } } });
      const res = await r.result;
      assert.equal(res.reason, reason, why(r, res));
      assert.equal(r.port.claims.length, 0);
    }
  });

  test("no install mode at all refuses install_unsupported", async (t) => {
    const r = await rig(t, { seams: { toolchain: () => TC, preinstall: undefined } });
    const res = await r.result;
    assert.equal(res.reason, "install_unsupported", why(r, res));
    assert.equal(r.port.claims.length, 0);
  });

  test("a customer run has no harness list: a grant on any host runs; the harness list still refuses it", async (t) => {
    const customer = await rig(t, {});
    assert.equal((await customer.result).status, "completed");
    const harness = await rig(t, { harnessHosts: ["sink.load-harness.example.com"] });
    assert.equal((await harness.result).reason, "outside_harness");
  });
});

describe("load supervisor: a refusal before the claim keeps its cause", { concurrency: 4 }, () => {
  const messages = (res: { failures: { message: string }[] }) => res.failures.map((f) => f.message).join("\n");

  test("a yarn.lock in the checkout: install_unsupported, and the failures name the file", async (t) => {
    const r = await rig(t, { install: { mode: "fetch" }, afterBinding: (ws) => writeFileSync(path.join(ws, "yarn.lock"), ""), seams: { toolchain: () => TC, preinstall: undefined } });
    const res = await r.result;
    assert.equal(res.reason, "install_unsupported", why(r, res));
    assert.match(messages(res), /yarn\.lock/);
    assert.equal(r.port.claims.length, 0);
  });

  test("a toolchain whose node isn't the pinned build: install_unsupported, and the failures carry the read and the pinned sha256", async (t) => {
    const root = mkdtempSync(path.join(os.tmpdir(), "peeps-fake-tc-"));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    // The toolcache folder trustedToolchain accepts is this host's arch; the pinned hashes are linux x64's.
    const dir = path.join(root, "node", "24.22.3", process.arch);
    mkdirSync(path.join(dir, "bin"), { recursive: true });
    mkdirSync(path.join(dir, "lib/node_modules/npm/bin"), { recursive: true });
    writeFileSync(path.join(dir, "bin/node"), "#!/bin/sh\necho v24.22.3\n", { mode: 0o755 });
    writeFileSync(path.join(dir, "lib/node_modules/npm/bin/npm-cli.js"), "require('../lib/cli.js')(process)\n");
    writeFileSync(path.join(dir, "lib/node_modules/npm/package.json"), '{"version":"11.19.1"}');
    const ws = workspace(t);
    const r = await rig(t, { ws, seams: { toolchain: () => trustedToolchain(dir, ws, undefined, root, { platform: "linux-x64" }) } });
    const res = await r.result;
    assert.equal(res.reason, "install_unsupported", why(r, res));
    assert.match(messages(res), new RegExp(`node's sha256 [0-9a-f]{64} is not the pinned ${SUPPORTED_TOOLCHAIN[0]!.linuxX64!.nodeSha256}`));
  });

  test("two problems are two failures, each on its own log line, neither cut by the other", async (t) => {
    const r = await rig(t, { install: { mode: "fetch" }, afterBinding: (ws) => { for (const name of ["yarn.lock", "pnpm-lock.yaml"]) writeFileSync(path.join(ws, name), ""); }, seams: { toolchain: () => TC, preinstall: undefined } });
    const res = await r.result;
    assert.equal(res.reason, "install_unsupported", why(r, res));
    const lines = failureLines(res.failures);
    assert.ok(lines.includes("peeps load: yarn.lock is not supported: load runs install from package-lock.json only"), lines.join("\n"));
    assert.ok(lines.includes("peeps load: pnpm-lock.yaml is not supported: load runs install from package-lock.json only"), lines.join("\n"));
    const fence = await rig(t, { seams: { toolchain: () => TC, probe: async () => ({ passed: false, failures: ["first ".repeat(60), "second"], seen: null }) } });
    const fenced = await fence.result;
    assert.equal(fenced.reason, "fence_unverified", why(fence, fenced));
    assert.deepEqual(fenced.failures.map((f) => f.message), ["first ".repeat(60), "second"]);
    assert.equal(failureLines(fenced.failures).at(-1), "peeps load: second");
  });

  test("a jail that can't start: fence_unverified, and the failures say why", async (t) => {
    const r = await rig(t, { seams: { toolchain: () => TC, probe: undefined, probeJail: async () => { throw Object.assign(new Error("spawn /home/runner/SECRET-PATH/sudo ENOENT"), { code: "ENOENT" }); } } });
    const res = await r.result;
    assert.equal(res.reason, "fence_unverified", why(r, res));
    assert.match(messages(res), /^the jail could not start \(sudo or systemd-run is missing or refused\): an unexpected error \(ENOENT\)$/);
    assert.doesNotMatch(JSON.stringify(res), /SECRET-PATH/, "the exception's own message is never kept");
  });

  test("a failed download: install_failed, and the failures name the tarball", async (t) => {
    const r = await rig(t, { install: { mode: "fetch" }, seams: { toolchain: () => TC, preinstall: undefined, installers: { fetch: async () => { throw new InstallFailed("/x/-/x-1.0.0.tgz does not match its lockfile sha512"); } } } });
    const res = await r.result;
    assert.equal(res.reason, "install_failed", why(r, res));
    assert.match(messages(res), /x-1\.0\.0\.tgz does not match its lockfile sha512/);
  });

  test("an install error that isn't the install's own: install_failed with a fixed cause, never its message", async (t) => {
    const r = await rig(t, { install: { mode: "fetch" }, seams: { toolchain: () => TC, preinstall: undefined, installers: { fetch: async () => { throw new Error("install_failed: https://u:PASS-SENTINEL@registry.example/a.tgz?t=Q"); } } } });
    const res = await r.result;
    assert.equal(res.reason, "install_failed", why(r, res));
    assert.equal(messages(res), "install_failed: an unexpected error");
  });
});

describe("load supervisor: nothing read from the checkout or an exception's message leaves the runner", { concurrency: 4 }, () => {
  const SECRET = /SENTINEL-77|ghp_SENTINEL/;
  /** Everything that leaves the runner or lands on disk: the result, the events Peeps was sent, the claims. */
  const leaving = (r: Awaited<ReturnType<typeof rig>>, res: unknown) => JSON.stringify({ res, batches: r.port.batches(), claims: r.port.claims, events: r.events });
  const fastInstall = { preinstall: async () => ({ lock: "", hiddenLock: "", tree: "0".repeat(64) }) };

  for (const [what, head, files, detail] of [
    ["a HEAD that is no ref", "ref: https://u:PASS-SENTINEL-77@x.example/r?t=SENTINEL-77\n", {}, "malformed"],
    ["a HEAD holding something else", "machine x.example login u password PASS-SENTINEL-77\n", {}, "malformed"],
    ["a ref whose target is missing", "ref: refs/heads/ghp_SENTINEL77\n", {}, "missing ref target"],
    ["a ref whose target is no commit", "ref: refs/heads/main\n", { "refs/heads/main": "PASS-SENTINEL-77\n" }, "malformed"],
  ] as const) {
    test(`the binding before the claim: ${what} is checkout_changed (${detail}), with no text of it`, async (t) => {
      const r = await rig(t, {
        afterBinding: (ws) => {
          writeFileSync(path.join(ws, ".git/HEAD"), head);
          for (const [name, body] of Object.entries(files)) {
            mkdirSync(path.dirname(path.join(ws, ".git", name)), { recursive: true });
            writeFileSync(path.join(ws, ".git", name), body);
          }
        },
        seams: { toolchain: () => TC, ...fastInstall },
      });
      const res = await r.result;
      assert.equal(res.reason, "checkout_changed", why(r, res));
      assert.equal(res.status, "didnt_start");
      assert.equal(r.port.claims.length, 0);
      assert.deepEqual(res.failures, [{ message: `checkout_changed: ${detail}`, location: null }]);
      assert.doesNotMatch(leaving(r, res), SECRET);
    });
  }

  test("the binding prepare reads again: a HEAD changed after the claim is checkout_changed, with no text of it", async (t) => {
    const r = await rig(t, {
      seams: { toolchain: () => TC },
      observer: (e, rg) => {
        if (e.type === "claimed") writeFileSync(path.join(rg.ws, ".git/HEAD"), "ref: https://u:PASS-SENTINEL-77@x.example/\n");
      },
    });
    const res = await r.result;
    assert.equal(res.reason, "checkout_changed", why(r, res));
    assert.equal(r.port.claims.length, 1);
    assert.deepEqual(res.failures.map((f) => f.message), ["checkout_changed: malformed"]);
    assert.doesNotMatch(leaving(r, res), SECRET);
  });

  test("an unexpected exception at startup is a fixed stage and code, never its message", async (t) => {
    const r = await rig(t, { seams: { toolchain: () => TC }, launch: async () => { throw Object.assign(new Error("spawn failed for https://u:PASS-SENTINEL-77@x.example/"), { code: "EACCES" }); } });
    const res = await r.result;
    assert.equal(res.reason, "startup_failed", why(r, res));
    assert.deepEqual(res.failures, [{ message: "startup_failed: the jail could not start: an unexpected error (EACCES)", location: null }]);
    assert.doesNotMatch(leaving(r, res), SECRET);
  });

  test("a plain Error whose message starts with a key and a colon: the name is the Error's own, never read from the message", async (t) => {
    const r = await rig(t, { exportName: "throwsKeyFirst", seams: { toolchain: () => TC, log: () => undefined } });
    const res = await r.result;
    assert.equal(res.reason, "checking_failed", why(r, res));
    assert.ok(res.failures.length > 0);
    for (const f of res.failures) assert.deepEqual(f, { message: "failure: other", location: null });
    assert.doesNotMatch(leaving(r, res), /AKIAEXAMPLEKEY123456/);
  });

  test("a journey's exception is its kind and a closed error class; its name, location and message go to the job log only", async (t) => {
    const lines: string[] = [];
    const r = await rig(t, { exportName: "throwsSecret", seams: { toolchain: () => TC, log: (line: string) => lines.push(line) } });
    const res = await r.result;
    assert.equal(res.reason, "checking_failed", why(r, res));
    assert.ok(res.failures.length > 0);
    for (const f of res.failures) assert.deepEqual(f, { message: "failure: other", location: null });
    assert.doesNotMatch(leaving(r, res), SECRET);
    assert.ok(lines.some((l) => /journey failure at journeys\.ts:\d+(:\d+)?: .*PASS-SENTINEL-77/.test(l)), "the customer's own log still has the location and the message");
  });
});

describe("load supervisor: every string the result or Peeps' summary carries is a known code", { concurrency: 4 }, () => {
  /** The codes a result or summary may carry: statuses, reasons, states and failure codes. */
  const CODE = /^(?:[a-z][a-z0-9_]{0,63})(?:: (?:assertion|timeout|network|other))?$/;
  const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
  /** Every string in a value, with its path. */
  const strings = (v: unknown, at = "$", out: [string, string][] = []): [string, string][] => {
    if (typeof v === "string") out.push([at, v]);
    else if (Array.isArray(v)) v.forEach((x, i) => strings(x, `${at}[${i}]`, out));
    else if (v && typeof v === "object") for (const [k, x] of Object.entries(v)) strings(x, `${at}.${k}`, out);
    return out;
  };
  const check = (r: Awaited<ReturnType<typeof rig>>, res: LoadResult) => {
    const summaries = (r.port.batches() as { kind: string }[]).filter((b) => b.kind === "summary");
    for (const [at, value] of [...strings(res, "result"), ...strings(summaries, "summary")]) {
      // The claim id is Peeps' own, from its answer.
      if (at === "result.claimId" && UUID.test(value)) continue;
      assert.match(value, CODE, `${at} = ${JSON.stringify(value)}`);
    }
  };

  test("a load-time fatal whose message and location pass every shape check", async (t) => {
    const r = await rig(t, { seams: { toolchain: () => TC, log: () => undefined }, jail: scripted({ PEEPS_SCRIPT: "fatal", PEEPS_FATAL_MESSAGE: "AKIAEXAMPLEKEY123456: denied", PEEPS_FATAL_LOCATION: "AKIAEXAMPLEKEY123456/journeys.ts:1", PEEPS_FATAL_ERROR: "other" }) });
    const res = await r.result;
    assert.equal(res.reason, "executor_journey", why(r, res));
    assert.deepEqual(res.failures, [{ message: "executor_journey: other", location: null }]);
    check(r, res);
  });

  test("a failed turn from a plain Error", async (t) => {
    const r = await rig(t, { exportName: "throwsKeyFirst", seams: { toolchain: () => TC, log: () => undefined } });
    const res = await r.result;
    assert.equal(res.reason, "checking_failed", why(r, res));
    check(r, res);
  });

  test("a Playwright version with extra metadata: the result has a compatibility code, the job log the version", async (t) => {
    const lines: string[] = [];
    const r = await rig(t, { seams: { toolchain: () => TC, log: (l: string) => lines.push(l) }, jail: scripted({ PEEPS_PW_VERSION: "1.59.1-AKIAEXAMPLEKEY123456" }) });
    const res = await r.result;
    assert.equal(res.playwright, "ok", why(r, res));
    check(r, res);
    assert.ok(lines.some((l) => l.includes("1.59.1-AKIAEXAMPLEKEY123456")), lines.join("\n"));
  });
});
