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
import { buildSync } from "esbuild";
import { startJail, type JailHandle } from "../src/load/jail";
import type { JailSpec } from "../src/load/jail/spec";

const enabled = process.env.LOAD_JAIL_TESTS === "1";
const options = { skip: enabled ? false : "set LOAD_JAIL_TESTS=1 on a Linux runner with sudo and systemd" };

let actionDir = "";
let workspace = "";
let sink: net.Server;
let sinkHits: string[] = [];
let sinkAddr = "";
let runs = 0;

before(() => {
  if (!enabled) return;
  execFileSync("sudo", ["-n", "true"]);
  assert.equal(execFileSync("stat", ["-fc", "%T", "/sys/fs/cgroup"], { encoding: "utf8" }).trim(), "cgroup2fs");
  actionDir = mkdtempSync(path.join(os.tmpdir(), "peeps-jail-action-"));
  chmodSync(actionDir, 0o755);
  for (const [entry, out] of [["src/load/jail/outer.ts", "load-outer.js"], ["src/load/jail/init.ts", "load-init.js"]] as const) {
    buildSync({ entryPoints: [path.resolve(__dirname, "..", entry)], bundle: true, platform: "node", target: "node24", format: "cjs", outfile: path.join(actionDir, out), logLevel: "warning" });
    chmodSync(path.join(actionDir, out), 0o644);
  }
  // Under the runner's 0750 home, as a real checkout is (E0 row 2).
  workspace = mkdtempSync(path.join(os.homedir(), "peeps-jail-ws-"));
  chmodSync(workspace, 0o755);
  writeFileSync(path.join(workspace, "package.json"), '{"name":"fixture"}\n');
});

after(() => {
  sink?.close();
  if (actionDir) rmSync(actionDir, { recursive: true, force: true });
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
  await handle.exited;
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
  assert.equal(probe.hostHome, false);
  assert.equal(probe.procOne, "denied");
  // Writes land in the overlay, never in the checkout.
  assert.equal(probe.workspaceWrite, "written");
  assert.equal(existsSync(path.join(workspace, ".peeps-probe")), false);
  assert.deepEqual(sinkHits, ["GET /probe-relay HTTP/1.0"]);
});

test("vsock, packet, raw sockets, io_uring and bpf are refused to the executor", options, async () => {
  const script = [
    "import socket, ctypes, errno",
    "def t(k, f):",
    "    try: f(); print('ESCAPE', k, 'allowed')",
    "    except OSError as e: print('ESCAPE', k, errno.errorcode.get(e.errno, e.errno))",
    "t('vsock', lambda: socket.socket(40, socket.SOCK_STREAM))",
    "t('packet', lambda: socket.socket(17, socket.SOCK_RAW, 0))",
    "t('raw', lambda: socket.socket(socket.AF_INET, socket.SOCK_RAW, socket.IPPROTO_ICMP))",
    "libc = ctypes.CDLL(None, use_errno=True)",
    "print('ESCAPE io_uring', libc.syscall(425, 8, ctypes.c_void_p(0)), errno.errorcode.get(ctypes.get_errno()))",
    "print('ESCAPE bpf', libc.syscall(321, 0, 0, 0), errno.errorcode.get(ctypes.get_errno()))",
  ].join("\n");
  const { out } = await runToExit(["/usr/bin/python3", "-c", script]);
  const rows = Object.fromEntries(out.split("\n").filter((l) => l.startsWith("ESCAPE ")).map((l) => [l.split(" ")[1], l.split(" ").slice(2).join(" ")]));
  assert.match(rows.vsock ?? "", /EAFNOSUPPORT|EPERM/, out);
  assert.match(rows.packet ?? "", /EAFNOSUPPORT|EPERM/, out);
  assert.match(rows.raw ?? "", /EPERM/, out);
  assert.equal(rows.io_uring, "-1 EPERM");
  assert.equal(rows.bpf, "-1 EPERM");
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

const HOLD = ["/bin/sh", "-c", "setsid sleep 900 </dev/null >/dev/null 2>&1 & exec sleep 900"];

for (const [name, freezeInit] of [["the supervisor is killed", false], ["init is stopped and then the supervisor is killed", true]] as const) {
  test(`every process ends within 5 s when ${name}, detached descendants too`, options, async () => {
    await startSink();
    const { child, unit } = await holder(HOLD);
    const cgroup = await cgroupOf(unit);
    assert.ok(cgroup);
    assert.ok(Number(execFileSync("sh", ["-c", `wc -l < /sys/fs/cgroup${cgroup}/cgroup.procs`], { encoding: "utf8" })) >= 4);
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

