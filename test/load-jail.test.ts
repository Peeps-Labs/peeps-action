/**
 * Real jails on a real runner (plan v3 §9 rows 4, 6 and 7; E0's checks made
 * permanent). Runs only with LOAD_JAIL_TESTS=1, which the hosted 22.04 and
 * 24.04 jobs in ci.yml set; there it needs sudo, systemd and cgroup v2.
 */
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { startJail, type JailHandle } from "../src/load/jail";
import type { JailSpec } from "../src/load/jail/spec";

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

function spec(command: string[]): JailSpec {
  const node = process.execPath;
  return {
    runId: `t${process.pid}-${++runs}`,
    node,
    nodeDir: path.dirname(path.dirname(node)),
    actionDir,
    outer: path.join(actionDir, "load-outer.js"),
    init: path.join(actionDir, "load-init.js"),
    workspace,
    executorUid: process.getuid!(),
    executorGid: process.getgid!(),
    command,
    env: {},
    limits: { maxRunMs: 120_000, memoryMax: "1G", tasksMax: 256, cpuQuotaPercent: 100 },
  };
}

async function runToExit(command: string[]): Promise<{ out: string; handle: JailHandle }> {
  await startSink();
  const handle = await startJail(spec(command), { listenProxy: forwardToSink, stdout: "pipe" });
  let out = "";
  handle.stdout!.setEncoding("utf8");
  handle.stdout!.on("data", (d: string) => (out += d));
  await handle.ready;
  handle.start();
  const exit = await handle.exited;
  assert.deepEqual(exit, { code: 0, signal: null }, "the executor exited cleanly");
  const end = await handle.end();
  assert.ok(end.clean, "the unit's cgroup is empty after end()");
  return { out, handle };
}

test("inside the jail, the relay is the only way out (Peeps' own probe)", options, async () => {
  sinkHits = [];
  const { out } = await runToExit(["/run/peeps/node/bin/node", "/run/peeps/action/load-init.js", "--probe", "SINK"].map((a) => (a === "SINK" ? sinkAddr : a)));
  const line = out.split("\n").find((l) => l.startsWith("PEEPS-PROBE "));
  assert.ok(line, out);
  const probe = JSON.parse(line!.slice("PEEPS-PROBE ".length));
  assert.equal(probe.uid, process.getuid!());
  assert.equal(probe.relay, "connected");
  assert.notEqual(probe.direct, "connected");
  assert.notEqual(probe.dns, "resolved");
  assert.equal(probe.unixProxy, "EACCES");
  assert.deepEqual(probe.hostPaths, []);
  assert.equal(probe.procOne, "EACCES");
  assert.equal(probe.procOneRoot, "EACCES");
  assert.equal(probe.procSelf, "readable", "a positive control: /proc works");
  const allowed = /^\/(usr|bin|sbin|lib\w*|etc\/[\w.]+|dev(\/\w+)?|tmp|proc|run\/peeps\/[\w-]+)?$/;
  assert.deepEqual(probe.mounts.filter((m: string) => !allowed.test(m)), [], "only the manifest's mounts are visible");
  assert.deepEqual(probe.mounts.filter((m: string) => /ws-lower|\/up$/.test(m)), [], "the overlay's backing folders are hidden");
  // Writes land in the overlay, never in the checkout.
  assert.equal(probe.workspaceWrite, "written");
  assert.equal(existsSync(path.join(workspace, ".peeps-probe")), false);
  assert.deepEqual(sinkHits, ["GET /probe-relay HTTP/1.0"]);
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
  const rows = Object.fromEntries(out.split("\n").filter((l) => l.startsWith("ESCAPE ")).map((l) => [l.split(" ")[1], l.split(" ").slice(2).join(" ")]));
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
  assert.deepEqual(out.split("\n").filter(Boolean), ["\u200b::save-state name=x::1", "  \u200b##[group]x", "plain"]);
});

test("end() with the executor still running empties the cgroup within 5 s", options, async () => {
  await startSink();
  const handle = await startJail(spec(HOLD), { listenProxy: forwardToSink });
  await handle.ready;
  handle.start();
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
  handle.start();
  const cgroup = await cgroupOf(handle.unit);
  assert.notEqual(await emptiesWithin(cgroup, 8000), null);
  await handle.end();
});

