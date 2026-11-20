/**
 * Real jails on a real runner (plan v3 §9 rows 4, 6 and 7; E0's checks made
 * permanent). Runs only with LOAD_JAIL_TESTS=1, which the hosted 22.04 and
 * 24.04 jobs in ci.yml set; there it needs sudo, systemd and cgroup v2.
 */
import { after, before, test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { chmodSync, cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { sharedClocks } from "../src/load/clocks";
import { probe, startJail, TicketRefused, type JailHandle } from "../src/load/jail";
import { encode, type Ticket } from "../src/load/jail/ctl";
import type { JailSpec } from "../src/load/jail/spec";
import { preinstall, trustedToolchain } from "../src/load/install";
import { MiniSupervisor, type ExecutorLink } from "./support/mini-supervisor";
import { FIXTURES, respond } from "./support/e4-fixtures";

const enabled = process.env.LOAD_JAIL_TESTS === "1";

const VSOCK32 = `#include <stdio.h>
#include <sys/mman.h>
int main(void) {
  unsigned int *args = mmap(0, 4096, PROT_READ | PROT_WRITE, MAP_PRIVATE | MAP_ANONYMOUS | MAP_32BIT, -1, 0);
  args[0] = 40; args[1] = 1; args[2] = 0;
  long r;
  __asm__ volatile ("int $0x80" : "=a"(r) : "a"(102), "b"(1), "c"(args) : "memory");
  printf(r >= 0 ? "VSOCK32 allowed\\n" : "VSOCK32 refused %ld\\n", -r);
  return 0;
}
`;
const options = { skip: enabled ? false : "set LOAD_JAIL_TESTS=1 on a Linux runner with sudo and systemd" };

let actionDir = "";
let workspace = "";
let sink: net.Server;
let sinkHits: string[] = [];
let sinkAddr = "";
let runs = 0;
const HOLD = ["/bin/sh", "-c", "setsid sleep 900 </dev/null >/dev/null 2>&1 & exec sleep 900"];

before(() => {
  if (!enabled) return;
  execFileSync("sudo", ["-n", "true"]);
  assert.equal(execFileSync("stat", ["-fc", "%T", "/sys/fs/cgroup"], { encoding: "utf8" }).trim(), "cgroup2fs");
  // The committed bundles: what ships is what is tested (CI checks dist/ matches src/).
  actionDir = path.resolve(__dirname, "../dist");

  // Under the runner's 0750 home, as a real checkout is (E0 row 2).
  workspace = mkdtempSync(path.join(os.homedir(), "peeps-jail-ws-"));
  chmodSync(workspace, 0o755);
  writeFileSync(path.join(workspace, "package.json"), '{"name":"fixture"}\n');
  // A binary in the checkout, as customer code could ship: i386 socketcall(AF_VSOCK) through int 0x80.
  writeFileSync(path.join(workspace, "vsock32.c"), VSOCK32);
  execFileSync("gcc", ["-O0", "-o", path.join(workspace, "vsock32"), path.join(workspace, "vsock32.c")]);
});

after(() => {
  sink?.close();
  if (workspace) rmSync(workspace, { recursive: true, force: true });
});

function hostAddress(): string {
  for (const list of Object.values(os.networkInterfaces())) {
    for (const a of list ?? []) if (a.family === "IPv4" && !a.internal) return a.address;
  }
  throw new Error("no non-loopback IPv4 address");
}

async function startSink(): Promise<void> {
  if (sink) return;
  const ip = hostAddress();
  sink = net.createServer((c) => {
    c.once("data", (d) => {
      sinkHits.push(String(d).split("\r\n")[0]!);
      c.end("HTTP/1.0 200 OK\r\nContent-Length: 2\r\n\r\nok");
    });
    c.on("error", () => undefined);
  });
  await new Promise<void>((resolve) => sink.listen(0, ip, resolve));
  sinkAddr = `${ip}:${(sink.address() as net.AddressInfo).port}`;
}

/** The gate's stand-in: forwards the relay's connections to the sink. */
function forwardToSink(sockPath: string): Promise<net.Server> {
  const [host, port] = [sinkAddr.split(":")[0]!, Number(sinkAddr.split(":")[1])];
  return new Promise((resolve) => {
    const server = net.createServer((c) => {
      const u = net.connect(port, host);
      c.pipe(u).pipe(c);
      u.on("error", () => c.destroy());
      c.on("error", () => u.destroy());
    });
    server.listen(sockPath, () => resolve(server));
  });
}

function spec(command: string[], ws = workspace): JailSpec {
  const node = process.execPath;
  const runId = `t${process.pid}-${++runs}`;
  return {
    runId,
    claimId: `claim-${runId}`,
    node,
    nodeDir: path.dirname(path.dirname(node)),
    actionDir,
    outer: path.join(actionDir, "load-outer.js"),
    init: path.join(actionDir, "load-init.js"),
    workspace: ws,
    executorUid: process.getuid!(),
    executorGid: process.getgid!(),
    command,
    env: {},
    limits: { maxRunMs: 120_000, memoryMax: "1G", tasksMax: 256, cpuQuotaPercent: 100 },
  };
}

/** A ticket for `s`, minted now, good for `ms`. */
function ticketFor(s: JailSpec, ms = 60_000): Ticket {
  const now = sharedClocks();
  return { claimId: s.claimId, epoch: 1, planHash: "p", leaseSeq: 1, nonce: "n", monoDeadline: now.monoMs + ms, wallDeadline: now.wallMs + ms };
}

/** `start`, then `launch`, each with a ticket minted at the send. */
async function begin(handle: JailHandle, s: JailSpec): Promise<void> {
  const installed = await handle.start(() => ticketFor(s));
  assert.equal(installed.code, 0, JSON.stringify(installed));
  await handle.launch(() => ticketFor(s));
}

async function runToExit(command: string[]): Promise<{ out: string; handle: JailHandle }> {
  await startSink();
  const s = spec(command);
  const handle = await startJail(s, { listenProxy: forwardToSink, stdout: "pipe" });
  let out = "";
  handle.stdout!.setEncoding("utf8");
  handle.stdout!.on("data", (d: string) => (out += d));
  await handle.ready;
  await begin(handle, s);
  const exit = await handle.exited;
  assert.deepEqual(exit, { code: 0, signal: null }, "the executor exited cleanly");
  const end = await handle.end();
  assert.ok(end.clean, "the unit's cgroup is empty after end()");
  return { out, handle };
}

test("inside the jail, the relay is the only way out (probe())", options, async () => {
  const { runId: _r, claimId: _c, command: _x, ...base } = spec([]);
  const report = await probe(base, `p${process.pid}-${++runs}`);
  assert.deepEqual(report.failures, [], JSON.stringify(report.seen));
  assert.equal(report.passed, true);
  assert.equal(existsSync(path.join(workspace, ".peeps-probe")), false);
});

test("vsock (64- and 32-bit), io_uring, bpf, setns and keyrings are refused by the unit's filter", options, async () => {
  // Each of these succeeds, or fails differently, for an unprivileged process with no filter.
  const host = execFileSync(path.join(workspace, "vsock32"), { encoding: "utf8" });
  assert.match(host, /VSOCK32 allowed/, "without the filter, i386 socketcall opens vsock: the test can fail");
  const script = [
    "import socket, ctypes, errno",
    "def t(k, f):",
    "    try: f(); print('ESCAPE', k, 'allowed')",
    "    except OSError as e: print('ESCAPE', k, errno.errorcode.get(e.errno, e.errno))",
    "t('vsock', lambda: socket.socket(40, socket.SOCK_STREAM))",
    "libc = ctypes.CDLL(None, use_errno=True)",
    "def c(k, *a):",
    "    r = libc.syscall(*a); print('ESCAPE', k, r, errno.errorcode.get(ctypes.get_errno()))",
    "c('io_uring', 425, 8, ctypes.c_void_p(0))",
    "c('setns', 308, -1, 0)",
    "c('keyctl', 250, 0, -3, 0)",
    "c('bpf', 321, 0, 0, 0)",
  ].join("\n");
  const { out } = await runToExit(["/bin/sh", "-c", '/usr/bin/python3 -c "$0"; /run/peeps/ws/vsock32; echo "VSOCK32-EXIT $?"', script]);
  const rows = Object.fromEntries(out.split("\n").map((l) => l.replace(/^jail\| /, "")).filter((l) => l.startsWith("ESCAPE ")).map((l) => [l.split(" ")[1], l.split(" ").slice(2).join(" ")]));
  assert.match(rows.vsock ?? "", /EAFNOSUPPORT|EPERM/, out);
  assert.equal(rows.io_uring, "-1 EPERM");
  assert.equal(rows.setns, "-1 EPERM", "unfiltered: EBADF");
  assert.equal(rows.keyctl, "-1 EPERM", "unfiltered: a keyring id");
  assert.equal(rows.bpf, "-1 EPERM");
  assert.doesNotMatch(out, /VSOCK32 allowed/, out);
  // A foreign-ABI system call is not refused but fatal: SIGSYS, 128 + 31.
  assert.match(out, /VSOCK32-EXIT 159/, out);
});

test("the jail's output reaches the job log with workflow commands neutralized", options, async () => {
  const { out } = await runToExit(["/bin/sh", "-c", "echo '::save-state name=x::1'; echo '  ##[group]x'; echo plain"]);
  assert.deepEqual(out.split("\n").filter(Boolean), ["jail| ::save-state name=x::1", "jail|   ## [group]x", "jail| plain"]);
});

test("a line longer than 64 KiB reaches the log cut into pieces, each prefixed", options, async () => {
  const { out } = await runToExit(["/usr/bin/python3", "-c", "import sys; sys.stdout.write('a' * 200000 + '##[x')"]);
  const lines = out.split("\n").filter(Boolean);
  assert.equal(lines.length, 4);
  assert.ok(lines.every((l) => l.startsWith("jail| ") && l.length <= 64 * 1024 + 6));
  assert.ok(!out.includes("##["));
});

test("end() with the executor still running empties the cgroup within 5 s", options, async () => {
  await startSink();
  const s = spec(HOLD);
  const handle = await startJail(s, { listenProxy: forwardToSink });
  await handle.ready;
  await begin(handle, s);
  await new Promise((r) => setTimeout(r, 500));
  const end = await handle.end();
  assert.ok(end.clean);
  assert.ok(end.ms < 5000, `${end.ms} ms`);
  assert.equal(existsSync(`/run/peeps-load-${handle.unit.slice("peeps-load-".length)}`), false);
});

test("a jail that cannot start rejects ready, and a failed setup leaves nothing behind", options, async () => {
  await startSink();
  const broken = spec(HOLD);
  broken.caPem = path.join(workspace, "missing-ca.pem");
  const handle = await startJail(broken, { listenProxy: forwardToSink });
  await assert.rejects(Promise.race([handle.ready, new Promise((_, r) => setTimeout(() => r(new Error("ready never settled")), 15_000))]), /ended before it was ready/);
  assert.ok((await handle.end()).clean);

  const s = spec(HOLD);
  await assert.rejects(startJail(s, { listenProxy: () => Promise.reject(new Error("no gate")) }), /no gate/);
  assert.equal(existsSync(`/run/peeps-load-${s.runId}`), false);
});

test("the runner's user cannot reach either socket", options, async () => {
  await startSink();
  const handle = await startJail(spec(["/bin/sleep", "30"]), { listenProxy: forwardToSink });
  const dir = `/run/peeps-load-${handle.unit.slice("peeps-load-".length)}`;
  for (const sock of ["ctl.sock", "proxy.sock"]) {
    const code = await new Promise<string>((resolve) => net.connect(`${dir}/${sock}`).once("error", (e: NodeJS.ErrnoException) => resolve(e.code ?? "")).once("connect", () => resolve("connected")));
    assert.equal(code, "EACCES", sock);
  }
  await handle.ready;
  const end = await handle.end();
  assert.ok(end.clean);
});

function holder(command: string[]): Promise<{ child: ReturnType<typeof spawn>; unit: string }> {
  const child = spawn(process.execPath, ["--import", "tsx", path.join(__dirname, "support/jail-holder.ts"), JSON.stringify(spec(command))], { stdio: ["ignore", "pipe", "inherit"] });
  return new Promise((resolve, reject) => {
    let out = "";
    child.stdout!.setEncoding("utf8");
    child.stdout!.on("data", (d: string) => {
      out += d;
      const m = /READY (\S+)/.exec(out);
      if (m) resolve({ child, unit: m[1]! });
    });
    child.once("exit", (code) => reject(new Error(`holder exited ${code}: ${out}`)));
  });
}

async function cgroupOf(unit: string): Promise<string> {
  return execFileSync("systemctl", ["show", "-p", "ControlGroup", "--value", `${unit}.service`], { encoding: "utf8" }).trim();
}

async function emptiesWithin(cgroup: string, ms: number): Promise<number | null> {
  const t0 = performance.now();
  while (performance.now() - t0 < ms) {
    const file = `/sys/fs/cgroup${cgroup}/cgroup.events`;
    if (!existsSync(file) || /^populated 0$/m.test(readFileSync(file, "utf8"))) return performance.now() - t0;
    await new Promise((r) => setTimeout(r, 100));
  }
  return null;
}


for (const [name, freezeInit] of [["the supervisor is killed", false], ["init is stopped and then the supervisor is killed", true]] as const) {
  test(`every process ends within 5 s when ${name}, detached descendants too`, options, async () => {
    await startSink();
    const { child, unit } = await holder(HOLD);
    const cgroup = await cgroupOf(unit);
    assert.ok(cgroup);
    const procs = execFileSync("cat", [`/sys/fs/cgroup${cgroup}/cgroup.procs`], { encoding: "utf8" }).trim().split("\n");
    const sleeps = procs.filter((pid) => readFileSync(`/proc/${pid}/cmdline`, "utf8").startsWith("sleep\x00900"));
    assert.equal(sleeps.length, 2, "the executor and its detached descendant are both in the unit");
    if (freezeInit) {
      const pids = execFileSync("sh", ["-c", `cat /sys/fs/cgroup${cgroup}/cgroup.procs`], { encoding: "utf8" }).trim().split("\n");
      const init = pids.find((pid) => {
        const argv = readFileSync(`/proc/${pid}/cmdline`, "utf8").split("\0").filter(Boolean);
        return argv.length === 2 && argv[0] === process.execPath && argv[1]!.endsWith("/load-init.js");
      });
      assert.ok(init, "found init");
      execFileSync("sudo", ["-n", "kill", "-STOP", init!]);
    }
    child.kill("SIGKILL");
    const ms = await emptiesWithin(cgroup, 5000);
    assert.notEqual(ms, null, "cgroup emptied within 5 s");
  });
}

test("a run that outlives maxRunMs is ended by systemd", options, async () => {
  await startSink();
  const s = spec(HOLD);
  s.limits.maxRunMs = 3000;
  const handle = await startJail(s, { listenProxy: forwardToSink });
  await handle.ready;
  await begin(handle, s);
  const cgroup = await cgroupOf(handle.unit);
  assert.notEqual(await emptiesWithin(cgroup, 8000), null);
  await handle.end();
});


// ---- Tickets, the in-jail install, and the fd 3 channel (e4 plan v3 §2.1, §2.2, §3.1) ----

const NODE_IN_JAIL = "/run/peeps/node/bin/node";
const NPM_REBUILD = [NODE_IN_JAIL, "/run/peeps/node/lib/node_modules/npm/bin/npm-cli.js", "rebuild", "--foreground-scripts"];

/** A checkout of its own under the runner's home, holding `files`. */
function workspaceWith(files: Record<string, string>): string {
  const ws = mkdtempSync(path.join(os.homedir(), "peeps-jail-ws-"));
  chmodSync(ws, 0o755);
  for (const [name, text] of Object.entries(files)) writeFileSync(path.join(ws, name), text);
  return ws;
}

/** A gate stand-in that counts what reaches it and lets nothing through. */
function countingProxy(seen: { connections: number }) {
  return (sockPath: string): Promise<net.Server> =>
    new Promise((resolve) => {
      const server = net.createServer((c) => {
        seen.connections++;
        c.destroy();
      });
      server.listen(sockPath, () => resolve(server));
    });
}

/** A jail whose end is registered as soon as it exists: a failed assertion still ends the unit. */
async function jailWithOutput(t: TestContext, s: JailSpec, listenProxy: (p: string) => Promise<net.Server> = forwardToSink): Promise<{ handle: JailHandle; out: () => string }> {
  await startSink();
  const handle = await startJail(s, { listenProxy, stdout: "pipe" });
  t.after(async () => {
    await handle.end();
  });
  let out = "";
  handle.stdout!.setEncoding("utf8");
  handle.stdout!.on("data", (d: string) => (out += d));
  await handle.ready;
  return { handle, out: () => out };
}

async function waitForOutput(out: () => string, line: RegExp): Promise<void> {
  const deadline = performance.now() + 5_000;
  while (!line.test(out()) && performance.now() < deadline) await sleep(10);
  assert.match(out(), line);
}

const ECHO_RAN = ["/bin/sh", "-c", "echo EXECUTOR-RAN; exec sleep 60"];

test("a stale start ticket is refused before the install, and is not used up", options, async (t) => {
  const s = spec(ECHO_RAN);
  s.install = ["/bin/sh", "-c", "echo INSTALL-RAN"];
  const { handle, out } = await jailWithOutput(t, s);
  const stale = ticketFor(s, -1);
  await assert.rejects(handle.start(() => stale), (e: unknown) => e instanceof TicketRefused && e.reason === "stale_ticket");
  await new Promise((r) => setTimeout(r, 300));
  assert.doesNotMatch(out(), /INSTALL-RAN/, "nothing ran on a stale ticket");
  // The refusal used nothing up: a fresh ticket starts the install.
  assert.equal((await handle.start(() => ticketFor(s))).code, 0);
  await new Promise((r) => setTimeout(r, 300));
  assert.match(out(), /INSTALL-RAN/);
  assert.ok((await handle.end()).clean);
});

test("a launch ticket that went stale during a long install starts no executor", options, async (t) => {
  const s = spec(ECHO_RAN);
  s.install = ["/bin/sh", "-c", "sleep 2"];
  const { handle, out } = await jailWithOutput(t, s);
  const minted = ticketFor(s, 1000);
  assert.equal((await handle.start(() => ticketFor(s))).code, 0);
  await assert.rejects(handle.launch(() => minted), (e: unknown) => e instanceof TicketRefused && e.reason === "stale_ticket");
  await new Promise((r) => setTimeout(r, 500));
  assert.doesNotMatch(out(), /EXECUTOR-RAN/);
  assert.ok((await handle.end()).clean);
});

test("a failing install reports its code, and no launch follows it", options, async (t) => {
  const s = spec(ECHO_RAN);
  s.install = ["/bin/sh", "-c", "exit 7"];
  const { handle, out } = await jailWithOutput(t, s);
  const installed = await handle.start(() => ticketFor(s));
  assert.equal(installed.code, 7);
  await assert.rejects(handle.launch(() => ticketFor(s)), (e: unknown) => e instanceof TicketRefused && e.reason === "early_ticket");
  assert.doesNotMatch(out(), /EXECUTOR-RAN/);
  assert.ok((await handle.end()).clean);
});

test("row 11: a postinstall that writes a marker and runs curl fails the install, writes nothing to the checkout, and reaches nothing", options, async (t) => {
  await startSink();
  sinkHits = [];
  const ws = workspaceWith({
    "package.json": JSON.stringify({ name: "row11", version: "1.0.0", scripts: { postinstall: `echo x > .peeps-marker && echo ROW11-MARKER-WRITTEN && curl -sS -m 5 http://${sinkAddr}/row11` } }),
  });
  try {
    const s = spec(ECHO_RAN, ws);
    s.install = NPM_REBUILD;
    const seen = { connections: 0 };
    const { handle, out } = await jailWithOutput(t, s, countingProxy(seen));
    const installed = await handle.start(() => ticketFor(s));
    assert.equal(installed.code, 7, "curl attempted the connection and could not connect");
    await waitForOutput(out, /^jail\| ROW11-MARKER-WRITTEN$/m);
    assert.equal(existsSync(path.join(ws, ".peeps-marker")), false, "the marker stayed in the overlay");
    assert.deepEqual(sinkHits, [], "zero sink arrivals");
    assert.equal(seen.connections, 0);
    assert.ok((await handle.end()).clean);
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
});

test("the rebuild runs as the runner's uid in the overlay, with no upstream traffic; root preinstall, install and postinstall run (npm 11), prepare does not", options, async (t) => {
  const hook = (name: string) => `echo HOOK ${name} $(id -u) && echo x > .peeps-${name}`;
  const ws = workspaceWith({
    "package.json": JSON.stringify({ name: "hooks", version: "1.0.0", scripts: Object.fromEntries(["preinstall", "install", "postinstall", "prepare"].map((n) => [n, hook(n)])) }),
  });
  try {
    // The executor checks, from inside the overlay, that the hooks wrote their files there.
    const s = spec(["/bin/sh", "-c", "test -f .peeps-preinstall && test -f .peeps-install && test -f .peeps-postinstall && test ! -e .peeps-prepare"], ws);
    s.install = NPM_REBUILD;
    const seen = { connections: 0 };
    const { handle, out } = await jailWithOutput(t, s, countingProxy(seen));
    assert.doesNotMatch(out(), /^jail\| HOOK /m);
    assert.equal((await handle.start(() => ticketFor(s))).code, 0, out());
    await waitForOutput(out, /^jail\| HOOK postinstall \d+$/m);
    await handle.launch(() => ticketFor(s));
    assert.deepEqual(await handle.exited, { code: 0, signal: null }, "the marker files are present only in the overlay");
    const ran = [...out().matchAll(/HOOK (\w+) (\d+)/g)].map((m) => [m[1], Number(m[2])]);
    assert.deepEqual(ran, ["preinstall", "install", "postinstall"].map((name) => [name, process.getuid!()]), out());
    for (const n of ["preinstall", "install", "postinstall", "prepare"]) assert.equal(existsSync(path.join(ws, `.peeps-${n}`)), false, n);
    assert.equal(seen.connections, 0, "the rebuild sent nothing upstream");
    assert.ok((await handle.end()).clean);
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
});

for (const [name, frame] of [
  ["a forged exit", encode({ type: "exit", code: 0, signal: null })],
  ["a frame for the executor", encode({ type: "stop" })],
] as const) {
  test(`${name} on fd 3 ends the jail as protocol`, options, async (t) => {
    const s = spec(["/bin/sh", "-c", `printf '%s' "$0" >&3; exec sleep 60`, frame]);
    const { handle } = await jailWithOutput(t, s);
    await begin(handle, s);
    assert.deepEqual(await handle.exited, { code: null, signal: "protocol" });
    assert.ok((await handle.end()).clean);
  });
}

test("an executor that stops reading stdin is ended by the 1 MiB rule", options, async (t) => {
  const s = spec(["/bin/sleep", "60"]);
  const { handle } = await jailWithOutput(t, s);
  await begin(handle, s);
  for (let turn = 1; turn <= 60_000; turn++) handle.send({ type: "cancel", turn });
  const t0 = performance.now();
  assert.deepEqual(await handle.exited, { code: null, signal: "protocol" });
  assert.ok(performance.now() - t0 < 10_000);
  assert.ok((await handle.end()).clean);
});

// ---- The hosted slice (e4 plan v3 §3.1): the real jail, install, executor, relay, CA and GateProxy ----

/** A checkout holding the e4 journeys and a lockfile for the pinned Playwright, installed as the action would before a claim. */
async function sliceWorkspace(withPlaywright: boolean): Promise<string> {
  const ws = workspaceWith({});
  cpSync(FIXTURES, ws, { recursive: true });
  if (withPlaywright) {
    cpSync(path.join(__dirname, "fixtures/load-engine/slice"), ws, { recursive: true });
    const scratch = mkdtempSync(path.join(os.tmpdir(), "peeps-slice-npm-"));
    try {
      await preinstall(ws, trustedToolchain(path.dirname(path.dirname(process.execPath)), ws), scratch);
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  }
  return ws;
}

/** The mini supervisor's executor, in a real jail: the gate's proxy listens on the jail's socket. */
function jailLink(ws: string, o: { ca: boolean; install: boolean }) {
  return async (ctx: { caFile: string }, proxy: { server: net.Server }): Promise<ExecutorLink> => {
    const s = spec([NODE_IN_JAIL, "/run/peeps/action/load-executor.js"], ws);
    if (o.ca) s.caPem = ctx.caFile;
    if (o.install) s.install = NPM_REBUILD;
    s.limits.memoryMax = "2G";
    const handle = await startJail(s, { listenProxy: (p) => new Promise((resolve) => proxy.server.listen(p, () => resolve(proxy.server))) });
    try {
      await begin(handle, s);
    } catch (error) {
      await handle.end();
      throw error;
    }
    return {
      send: (f) => handle.send(f),
      onFrame: (l) => void handle.onFrame(l),
      exited: handle.exited,
      end: async () => {
        assert.ok((await handle.end()).clean);
      },
      stderr: () => "",
    };
  };
}

test("hosted slice: two turns through the jail keep the slot's cookie, each with a fresh credential and CONNECT; a closed credential reaches nothing", { ...options, timeout: 600_000 }, async (t) => {
  const ws = await sliceWorkspace(true);
  t.after(() => rmSync(ws, { recursive: true, force: true }));
  const m = await MiniSupervisor.start(t, { journey: { module: "journeys.ts", export: "cookie" }, workspace: ws, respond, link: jailLink(ws, { ca: true, install: true }) });
  const loaded = await m.init();
  assert.equal(loaded.type, "loaded", JSON.stringify(loaded));
  assert.match((loaded as { playwright: string }).playwright, /^1\.46\./);

  const first = m.open(1);
  assert.equal((await first.outcome).kind, "success");
  const second = m.open(1);
  assert.equal((await second.outcome).kind, "success");
  assert.equal(m.sink.arrivals.length, 2);
  assert.equal(m.sink.arrivals[0]!.headers.cookie, undefined);
  assert.ok(m.sink.arrivals[1]!.headers.cookie, "the slot kept its cookie across turns");
  assert.notEqual(first.credential, second.credential);
  assert.deepEqual(m.connects, [first.credential, second.credential], "one CONNECT per turn, each with its own credential");

  const closed = m.open(1);
  m.proxy.closeTurn(closed.turn);
  assert.equal((await closed.outcome).kind, "failure");
  assert.deepEqual(m.connects, [first.credential, second.credential, closed.credential]);
  assert.equal(m.journal.snapshot().denied.turn_closed, 1, "the closed credential was refused by the gate");
  assert.equal(m.sink.arrivals.length, 2, "a closed credential got 0 arrivals");
});

test("hosted slice: with no CA in the jail, or no Playwright in the checkout, nothing arrives", { ...options, timeout: 600_000 }, async (t) => {
  const ws = await sliceWorkspace(true);
  t.after(() => rmSync(ws, { recursive: true, force: true }));
  const noCa = await MiniSupervisor.start(t, { journey: { module: "journeys.ts", export: "get" }, workspace: ws, respond, link: jailLink(ws, { ca: false, install: true }) });
  assert.equal((await noCa.init()).type, "loaded");
  assert.equal((await noCa.turn(1)).kind, "failure");
  assert.equal(noCa.sink.arrivals.length, 0, "no CA: 0 arrivals");

  const bare = await sliceWorkspace(false);
  t.after(() => rmSync(bare, { recursive: true, force: true }));
  const noPw = await MiniSupervisor.start(t, { journey: { module: "journeys.ts", export: "get" }, workspace: bare, respond, link: jailLink(bare, { ca: true, install: false }) });
  const f = await noPw.init();
  assert.equal(f.type, "fatal");
  assert.equal((f as { code: string }).code, "playwright");
  assert.equal(noPw.sink.arrivals.length, 0, "no Playwright: 0 arrivals");
});
