/**
 * The jail's shape (plan v3 §3), checked without starting one. The hosted
 * runner tests that start real jails are in load-jail.test.ts.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import net from "node:net";
import os from "node:os";
import { acceptCtl } from "../src/load/jail";
import path from "node:path";
import { decode, encode, LineSplitter, MAX_FRAME_BYTES, sameNonce } from "../src/load/jail/ctl";
import { dropArgs, executorEnv, initConfig, neutralize, rebuildEnv, RELAY_UID, specProblems, systemdRunArgs, type JailSpec } from "../src/load/jail/spec";

const spec = (over: Partial<JailSpec> = {}): JailSpec => ({
  runId: "r-123",
  node: "/opt/node/bin/node",
  nodeDir: "/opt/node",
  actionDir: "/a/dist",
  outer: "/a/dist/load-outer.js",
  init: "/a/dist/load-init.js",
  workspace: "/home/runner/work/app/app",
  executorUid: 1001,
  executorGid: 1001,
  claimId: "claim-1",
  command: ["/run/peeps/node/bin/node", "/run/peeps/action/load-executor.js"],
  env: { PEEPS_RUN: "1" },
  limits: { maxRunMs: 600_000, memoryMax: "2G", tasksMax: 512, cpuQuotaPercent: 300 },
  ...over,
});

const property = (args: string[], name: string) => args.filter((a, i) => args[i - 1] === "-p" && a.startsWith(`${name}=`));

test("the unit refuses vsock and packet sockets and turns denied system calls into EPERM", () => {
  const args = systemdRunArgs(spec());
  assert.deepEqual(property(args, "RestrictAddressFamilies"), ["RestrictAddressFamilies=AF_UNIX AF_INET AF_INET6 AF_NETLINK"]);
  // systemd's default action kills; Node's libuv probes io_uring at start (E0 run 1).
  assert.deepEqual(property(args, "SystemCallErrorNumber"), ["SystemCallErrorNumber=EPERM"]);
  // RestrictAddressFamilies does not cover i386 socketcall().
  assert.deepEqual(property(args, "SystemCallArchitectures"), ["SystemCallArchitectures=native"]);
  const [filter] = property(args, "SystemCallFilter");
  assert.ok(filter?.startsWith("SystemCallFilter=~"));
  for (const call of ["@debug", "bpf", "setns", "pidfd_getfd", "io_uring_setup", "keyctl"]) assert.ok(filter!.split(/[~ ]/).includes(call), call);
});

test("the unit's whole cgroup is killed on stop, with a hard end and resource limits", () => {
  const args = systemdRunArgs(spec());
  assert.deepEqual(property(args, "KillMode"), ["KillMode=control-group"]);
  assert.deepEqual(property(args, "KillSignal"), ["KillSignal=SIGKILL"]);
  assert.deepEqual(property(args, "TimeoutStopSec"), ["TimeoutStopSec=2s"]);
  assert.deepEqual(property(args, "RuntimeMaxSec"), ["RuntimeMaxSec=600s"]);
  assert.deepEqual(property(args, "MemoryMax"), ["MemoryMax=2G"]);
  assert.deepEqual(property(args, "TasksMax"), ["TasksMax=512"]);
  assert.deepEqual(property(args, "CPUQuota"), ["CPUQuota=300%"]);
  assert.ok(args.includes("--pipe") && args.includes("--wait") && args.includes("--collect"));
  assert.ok(args.includes("--unit=peeps-load-r-123"));
});

test("the unit's main process is the trusted Node running the outer watcher", () => {
  const args = systemdRunArgs(spec());
  assert.equal(args[0], "/usr/bin/systemd-run");
  assert.deepEqual(args.slice(-2), ["/opt/node/bin/node", "/a/dist/load-outer.js"]);
  const config = JSON.parse(args.find((a) => a.startsWith("--setenv=PEEPS_JAIL_CONFIG="))!.slice("--setenv=PEEPS_JAIL_CONFIG=".length));
  assert.equal(config.initInJail, "/run/peeps/action/load-init.js");
  assert.equal(config.nodeInJail, "/run/peeps/node/bin/node");
  assert.equal(config.socketDir, "/run/peeps-load-r-123");
});

test("the executor gets only the environment the spec names", () => {
  assert.deepEqual(executorEnv(initConfig(spec({ caPem: "/tmp/ca.pem" }))), [
    "PATH=/run/peeps/node/bin:/usr/bin:/bin",
    "HOME=/run/peeps/home",
    "NODE_EXTRA_CA_CERTS=/run/peeps/ca.pem",
    "PEEPS_RUN=1",
  ]);
  assert.deepEqual(executorEnv(initConfig(spec({ env: {} }))), ["PATH=/run/peeps/node/bin:/usr/bin:/bin", "HOME=/run/peeps/home"]);
});

test("init is told the claim and the install; the rebuild runs offline with the action's npm config only", () => {
  const install = ["/run/peeps/node/bin/node", "/run/peeps/node/lib/node_modules/npm/bin/npm-cli.js", "rebuild", "--foreground-scripts"];
  const config = initConfig(spec({ install }));
  assert.equal(config.claimId, "claim-1");
  assert.deepEqual(config.install, install);
  assert.equal(initConfig(spec()).install, undefined);
  const env = rebuildEnv(config);
  assert.ok(env.includes("PATH=/run/peeps/node/bin:/usr/bin:/bin"));
  assert.ok(env.includes("HOME=/run/peeps/home"));
  for (const v of ["npm_config_offline=true", "npm_config_registry=https://registry.npmjs.org/", "npm_config_git=/bin/false", "npm_config_audit=false", "npm_config_fund=false", "npm_config_update_notifier=false"]) assert.ok(env.includes(v), v);
  assert.equal(env.some((v) => v.startsWith("PEEPS_RUN=")), false, "the journey's environment is not the install's");
  assert.equal(env.some((v) => /ignore_scripts|script_shell/.test(v)), false, "the rebuild runs scripts");
});

test("dropping privileges clears groups and every capability set, with no way back", () => {
  assert.deepEqual(dropArgs(1001, 1001), ["--reuid=1001", "--regid=1001", "--clear-groups", "--bounding-set=-all", "--inh-caps=-all", "--ambient-caps=-all", "--no-new-privs"]);
});

test("a spec is refused when it could escape its own shape", () => {
  assert.deepEqual(specProblems(spec()), []);
  const refused: Array<[Partial<JailSpec>, RegExp]> = [
    [{ runId: "Bad/ID" }, /runId/],
    [{ runId: "" }, /runId/],
    [{ workspace: "relative" }, /workspace/],
    [{ workspace: "/a/../etc" }, /workspace/],
    [{ caPem: "/x\n" }, /caPem/],
    [{ node: "/elsewhere/node" }, /inside nodeDir/],
    [{ init: "/other/load-init.js" }, /actionDir/],
    [{ executorUid: 0 }, /executorUid/],
    [{ executorUid: RELAY_UID }, /executorUid/],
    [{ executorGid: RELAY_UID }, /executorGid/],
    [{ command: [] }, /command/],
    [{ command: ["a\0b"] }, /command/],
    [{ install: [] }, /install/],
    [{ install: ["npm\0"] }, /install/],
    [{ claimId: "" }, /claimId/],
    [{ claimId: "a\nb" }, /claimId/],
    [{ env: { NODE_OPTIONS: "--require x" } }, /NODE_OPTIONS/],
    [{ env: { LD_PRELOAD: "x" } }, /LD_PRELOAD/],
    [{ env: { lower: "x" } }, /lower/],
    [{ limits: { maxRunMs: 10, memoryMax: "2G", tasksMax: 512, cpuQuotaPercent: 300 } }, /maxRunMs/],
    [{ limits: { maxRunMs: 60_000, memoryMax: "lots", tasksMax: 512, cpuQuotaPercent: 300 } }, /memoryMax/],
  ];
  for (const [over, expected] of refused) assert.match(specProblems(spec(over)).join("; "), expected, JSON.stringify(over));
});

test("control frames round-trip, and anything else is not a frame", () => {
  const nonce = "a".repeat(64);
  for (const frame of [{ type: "hello", nonce }, { type: "ready" }, { type: "launched" }, { type: "exit", code: 3, signal: null }, { type: "exit", code: null, signal: "SIGKILL" }] as const) {
    assert.deepEqual(decode(encode(frame).trim()), frame);
  }
  for (const line of ["", "{", "null", '{"type":"hello","nonce":"short"}', '{"type":"exit","code":1.5,"signal":null}', '{"type":"other"}']) assert.equal(decode(line), null, line);
});

test("an over-long control line ends the connection", () => {
  const lines = new LineSplitter();
  assert.deepEqual(lines.push('{"type":"ready"}\n{"type"'), ['{"type":"ready"}']);
  assert.deepEqual(lines.push(':"start"}\n'), ['{"type":"start"}']);
  assert.equal(new LineSplitter().push("x".repeat(MAX_FRAME_BYTES + 1)), null);
});

test("nonces compare in full", () => {
  assert.ok(sameNonce("ab", "ab"));
  assert.ok(!sameNonce("ab", "ac"));
  assert.ok(!sameNonce("ab", "abc"));
});

test("nothing under src/load signals a process; init imports no customer-facing code", () => {
  const root = path.resolve(__dirname, "../src/load");
  const files = (dir: string): string[] => readdirSync(dir).flatMap((f) => (statSync(path.join(dir, f)).isDirectory() ? files(path.join(dir, f)) : [path.join(dir, f)]));
  for (const file of files(root)) assert.doesNotMatch(readFileSync(file, "utf8"), /process\.kill\(|\.kill\(/, file);
  const imports = readFileSync(path.join(root, "jail/init.ts"), "utf8").match(/from "([^"]+)"/g) ?? [];
  assert.deepEqual(imports.filter((i) => !/from "node:[a-z_/]+"|from "\.\/(ctl|spec)"/.test(i)), []);
});

test("the control socket takes one connection with the nonce; a wrong nonce or a late one gets nowhere", async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "peeps-ctl-"));
  const sock = path.join(dir, "ctl.sock");
  const server = net.createServer();
  await new Promise<void>((resolve) => server.listen(sock, resolve));
  const nonce = "b".repeat(64);
  const accepted = acceptCtl(server, nonce);
  const outcome = (payload: string) =>
    new Promise<string>((resolve) => {
      const s = net.connect(sock);
      s.on("connect", () => s.write(payload));
      s.on("close", () => resolve("closed"));
      s.on("error", (e: NodeJS.ErrnoException) => resolve(e.code ?? "error"));
      setTimeout(() => (s.destroy(), resolve("open")), 1500);
    });
  assert.equal(await outcome(encode({ type: "hello", nonce: "0".repeat(64) })), "closed");
  assert.equal(await outcome("not a frame\n"), "closed");
  const real = net.connect(sock);
  await new Promise((r) => real.once("connect", r));
  real.write(encode({ type: "hello", nonce }));
  const ctl = await accepted;
  real.write(encode({ type: "ready" }));
  await ctl.ready;
  assert.match(await outcome(encode({ type: "hello", nonce })), /^(ENOENT|ECONNREFUSED|closed)$/);
  real.write(encode({ type: "exit", code: 7, signal: null }));
  assert.deepEqual(await ctl.exit, { code: 7, signal: null });
  real.destroy();
  rmSync(dir, { recursive: true, force: true });
});

test("lines the runner would read as workflow commands are neutralized", () => {
  // The runner trims whitespace (U+0085 included) before it looks for `::`, and finds `##[` anywhere.
  const runnerReadsCommand = (line: string) => /^[\s\u0085\u200b\ufeff]*::/u.test(line) || line.includes("##[");
  const hostile = ["::save-state name=x::1", "  ::add-mask::x", "##[group]x", "x ##[set-output name=r;]passed", "\u0085::set-output name=r::1", "\ufeff::stop-commands::t"];
  for (const line of hostile) {
    assert.ok(runnerReadsCommand(line), line);
    assert.ok(!runnerReadsCommand(neutralize(line)), line);
  }
  assert.equal(neutralize("plain ::text::"), "jail| plain ::text::");
});

// ---------------------------------------------------------------- init's control channel, without a jail

import { spawn, type ChildProcess } from "node:child_process";
import { serveControl, MAX_QUEUE_BYTES } from "../src/load/jail/init";
import type { CtlFrame, Ticket } from "../src/load/jail/ctl";

const FAKE_EXECUTOR = `
const fs = require("fs"); const net = require("net");
const out = new net.Socket({ fd: 3, readable: false });
const mode = process.argv[1];
const send = (f) => out.write(JSON.stringify(f) + "\\n");
if (mode === "forge") send({ type: "exit", code: 0, signal: null });
if (mode === "garbage") out.write("not a frame\\n");
if (mode === "huge") out.write("x".repeat(70 * 1024) + "\\n");
if (mode === "partial") out.end(JSON.stringify({ type: "loaded", playwright: "1.46.1" }), () => process.exit(0));
if (mode === "deaf") { setInterval(() => {}, 1000); }
else {
  let buf = "";
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (d) => {
    buf += d; let i;
    while ((i = buf.indexOf("\\n")) >= 0) {
      const f = JSON.parse(buf.slice(0, i)); buf = buf.slice(i + 1);
      if (f.type === "init") send({ type: "loaded", playwright: "1.46.1" });
      if (f.type === "turn") send({ type: "outcome", turn: f.turn, kind: "success", extra: "dropped" });
      if (f.type === "stop") out.end(() => process.exit(0));
    }
  });
}
`;

interface Channel {
  frames: CtlFrame[];
  send(frame: CtlFrame | string): void;
  wait(match: (f: CtlFrame) => boolean): Promise<CtlFrame>;
  spawned: { install: number; executor: number };
  ended: Promise<void>;
}

async function channel(t: import("node:test").TestContext, o: { install?: "ok" | "fail" | "none"; executor?: string } = {}): Promise<Channel> {
  const dir = mkdtempSync(path.join(os.tmpdir(), "peeps-init-"));
  const sock = path.join(dir, "ctl.sock");
  const server = net.createServer();
  await new Promise<void>((resolve) => server.listen(sock, resolve));
  const supervisorSide = new Promise<net.Socket>((resolve) => server.once("connection", resolve));
  const initSide = net.connect(sock);
  await new Promise((r) => initSide.once("connect", r));
  const sup = await supervisorSide;
  const children: ChildProcess[] = [];
  const spawned = { install: 0, executor: 0 };
  let markEnded!: () => void;
  const ended = new Promise<void>((r) => (markEnded = r));
  serveControl(initSide, { claimId: "claim-1" }, {
    install: () => {
      spawned.install += 1;
      if ((o.install ?? "ok") === "none") return null;
      const child = spawn(process.execPath, ["-e", o.install === "fail" ? "process.exit(3)" : "setTimeout(() => process.exit(0), 50)"], { stdio: "ignore" });
      children.push(child);
      return child;
    },
    executor: () => {
      spawned.executor += 1;
      const child = spawn(process.execPath, ["-e", FAKE_EXECUTOR, o.executor ?? "echo"], { stdio: ["pipe", "inherit", "inherit", "pipe"] });
      children.push(child);
      return child;
    },
    now: () => ({ monoMs: 1_000, wallMs: 1_700_000_001_000 }),
    end: () => {
      markEnded();
      initSide.end();
      for (const c of children) c.kill("SIGKILL");
    },
  });
  t.after(() => {
    for (const c of children) c.kill("SIGKILL");
    sup.destroy();
    initSide.destroy();
    server.close();
    rmSync(dir, { recursive: true, force: true });
  });
  const frames: CtlFrame[] = [];
  const waiters: { match: (f: CtlFrame) => boolean; resolve: (f: CtlFrame) => void }[] = [];
  const lines = new LineSplitter();
  sup.setEncoding("utf8");
  sup.on("data", (chunk: string) => {
    for (const line of lines.push(chunk) ?? []) {
      const frame = decode(line);
      assert.ok(frame, `init sent a line that is not a frame: ${line}`);
      frames.push(frame);
      for (const w of [...waiters]) if (w.match(frame)) (waiters.splice(waiters.indexOf(w), 1), w.resolve(frame));
    }
  });
  sup.on("error", () => undefined);
  return {
    frames,
    spawned,
    ended,
    send: (frame) => void sup.write(typeof frame === "string" ? frame : encode(frame)),
    wait: (match) => {
      const seen = frames.find(match);
      if (seen) return Promise.resolve(seen);
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`no frame; got ${JSON.stringify(frames)}`)), 10_000);
        waiters.push({ match, resolve: (f) => (clearTimeout(timer), resolve(f)) });
      });
    },
  };
}

const T: Ticket = { claimId: "claim-1", epoch: 1, planHash: "p", leaseSeq: 1, nonce: "n", monoDeadline: 5_000, wallDeadline: 1_700_000_005_000 };
const STALE: Ticket = { ...T, monoDeadline: 500 };

test("init: a stale start is refused before the install, and does not use the ticket up", async (t) => {
  const c = await channel(t);
  c.send({ type: "start", ticket: STALE });
  assert.deepEqual(await c.wait((f) => f.type === "refused"), { type: "refused", reason: "stale_ticket" });
  c.send({ type: "start", ticket: { ...T, claimId: "claim-2" } });
  await c.wait((f) => f.type === "refused" && f.reason === "foreign_ticket");
  assert.equal(c.spawned.install, 0, "nothing ran");
  c.send({ type: "start", ticket: T });
  const installed = await c.wait((f) => f.type === "installed");
  assert.equal((installed as { code: number }).code, 0);
  assert.equal(c.spawned.install, 1);
  c.send({ type: "start", ticket: T });
  await c.wait((f) => f.type === "refused" && f.reason === "used_ticket");
  assert.equal(c.spawned.install, 1);
});

test("init: launch before installed is refused; a failing install reports its code and opens no launch", async (t) => {
  const c = await channel(t, { install: "fail" });
  c.send({ type: "launch", ticket: T });
  await c.wait((f) => f.type === "refused" && f.reason === "early_ticket");
  c.send({ type: "start", ticket: T });
  const installed = await c.wait((f) => f.type === "installed");
  assert.equal((installed as { code: number }).code, 3);
  c.send({ type: "launch", ticket: T });
  await new Promise((r) => setTimeout(r, 100));
  assert.equal(c.frames.filter((f) => f.type === "refused" && f.reason === "early_ticket").length, 2);
  assert.equal(c.spawned.executor, 0);
});

test("init: start, launch, then frames relayed both ways, extra fields dropped", async (t) => {
  const c = await channel(t, { install: "none" });
  c.send({ type: "start", ticket: T });
  assert.deepEqual(await c.wait((f) => f.type === "installed"), { type: "installed", code: 0, signal: null, ms: 0 });
  c.send({ type: "launch", ticket: T });
  await c.wait((f) => f.type === "launched");
  c.send({ type: "init", journey: { module: "j.ts", export: "j" }, baseURL: "https://shop.test", proxy: "http://127.0.0.1:3128", renewEveryMs: 2000, parallel: 2 });
  await c.wait((f) => f.type === "loaded");
  c.send({ type: "turn", turn: 7, slot: 1, password: "A".repeat(43), deadlineMono: 9_000 });
  assert.deepEqual(await c.wait((f) => f.type === "outcome"), { type: "outcome", turn: 7, kind: "success" });
  c.send({ type: "stop" });
  assert.deepEqual(await c.wait((f) => f.type === "exit"), { type: "exit", code: 0, signal: null });
  await c.ended;
});

for (const [label, mode, from] of [
  ["a forged exit on fd 3", "forge", "executor"],
  ["a line that is not a frame on fd 3", "garbage", "executor"],
  ["an oversized line on fd 3", "huge", "executor"],
  ["an unterminated frame on fd 3", "partial", "executor"],
  ["a wrong-direction frame from the supervisor", "echo", "supervisor"],
  ["an unknown frame from the supervisor", "echo", "supervisor-garbage"],
] as const) {
  test(`init: ${label} ends the executor as protocol`, async (t) => {
    const c = await channel(t, { executor: mode });
    c.send({ type: "start", ticket: T });
    await c.wait((f) => f.type === "installed");
    c.send({ type: "launch", ticket: T });
    await c.wait((f) => f.type === "launched");
    if (from === "supervisor") c.send({ type: "outcome", turn: 1, kind: "success" });
    if (from === "supervisor-garbage") c.send('{"type":"nope"}\n');
    assert.deepEqual(await c.wait((f) => f.type === "exit"), { type: "exit", code: null, signal: "protocol" });
    await c.ended;
  });
}

test("init: an executor that stops reading is ended by the 1 MiB rule", async (t) => {
  const c = await channel(t, { executor: "deaf" });
  c.send({ type: "start", ticket: T });
  await c.wait((f) => f.type === "installed");
  c.send({ type: "launch", ticket: T });
  await c.wait((f) => f.type === "launched");
  const frame = encode({ type: "cancel", turn: 123456 });
  c.send(frame.repeat(Math.ceil((MAX_QUEUE_BYTES * 2) / frame.length)));
  assert.deepEqual(await c.wait((f) => f.type === "exit"), { type: "exit", code: null, signal: "protocol" });
  await c.ended;
});
