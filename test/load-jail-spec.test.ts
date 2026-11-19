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
import { dropArgs, executorEnv, initConfig, neutralize, RELAY_UID, specProblems, systemdRunArgs, type JailSpec } from "../src/load/jail/spec";

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
  for (const frame of [{ type: "hello", nonce }, { type: "ready" }, { type: "start" }, { type: "exit", code: 3, signal: null }, { type: "exit", code: null, signal: "SIGKILL" }] as const) {
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
