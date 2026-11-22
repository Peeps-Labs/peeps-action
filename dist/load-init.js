"use strict";
var __create = Object.create;
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __getProtoOf = Object.getPrototypeOf;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toESM = (mod, isNodeMode, target) => (target = mod != null ? __create(__getProtoOf(mod)) : {}, __copyProps(
  // If the importer is in node compatibility mode or this is not an ESM
  // file that has been converted to a CommonJS file using a Babel-
  // compatible transform (i.e. "__esModule" has not been set), then set
  // "default" to the CommonJS "module.exports" for node compatibility.
  isNodeMode || !mod || !mod.__esModule ? __defProp(target, "default", { value: mod, enumerable: true }) : target,
  mod
));
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);

// src/load/jail/init.ts
var init_exports = {};
__export(init_exports, {
  MAX_QUEUE_BYTES: () => MAX_QUEUE_BYTES,
  isolate: () => isolate,
  serveControl: () => serveControl
});
module.exports = __toCommonJS(init_exports);
var import_node_child_process = require("node:child_process");
var import_node_fs = require("node:fs");
var import_node_net = __toESM(require("node:net"));

// src/load/jail/ctl.ts
var MAX_FRAME_BYTES = 64 * 1024;
var MAX_MESSAGE = 2e3;
var ERROR_CLASSES = ["assertion", "timeout", "network", "other"];
var PLAYWRIGHT_COMPAT = ["ok", "not_found", "below_floor", "unreadable"];
var MAX_LOCATION = 500;
var TO_EXECUTOR = /* @__PURE__ */ new Set(["init", "turn", "cancel", "stop"]);
var TO_SUPERVISOR = /* @__PURE__ */ new Set(["loaded", "fatal", "outcome"]);
function relayable(frame, from) {
  return (from === "supervisor" ? TO_EXECUTOR : TO_SUPERVISOR).has(frame.type);
}
function encode(frame) {
  return `${JSON.stringify(frame)}
`;
}
var isSafePositive = (v) => Number.isSafeInteger(v) && v > 0;
var isSafeCount = (v) => Number.isSafeInteger(v) && v >= 0;
var isFinitePositive = (v) => typeof v === "number" && Number.isFinite(v) && v > 0;
var isText = (v, max, min = 0) => typeof v === "string" && v.length >= min && v.length <= max;
var isCode = (v) => v === null || Number.isSafeInteger(v);
var isSignal = (v) => v === null || isText(v, 32, 1);
var PASSWORD = /^[A-Za-z0-9_-]{43}$/;
var NONCE = /^[0-9a-f]{64}$/;
var IDENT = /^[A-Za-z_$][A-Za-z0-9_$]{0,255}$/;
function ticketOf(v) {
  if (typeof v !== "object" || v === null) return null;
  const t = v;
  if (!isText(t.claimId, 256, 1) || !isSafeCount(t.epoch) || !isText(t.planHash, 256, 1) || !isSafeCount(t.leaseSeq) || !isText(t.nonce, 256, 1)) return null;
  if (!isFinitePositive(t.monoDeadline) || !isFinitePositive(t.wallDeadline)) return null;
  return { claimId: t.claimId, epoch: t.epoch, planHash: t.planHash, leaseSeq: t.leaseSeq, nonce: t.nonce, monoDeadline: t.monoDeadline, wallDeadline: t.wallDeadline };
}
function optional(v, name, max) {
  if (v[name] === void 0) return {};
  return isText(v[name], max) ? { [name]: v[name] } : null;
}
function oneOf(v, name, set) {
  if (v[name] === void 0) return {};
  return typeof v[name] === "string" && set.includes(v[name]) ? { [name]: v[name] } : null;
}
function decode(line) {
  let value;
  try {
    value = JSON.parse(line);
  } catch {
    return null;
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const v = value;
  switch (v.type) {
    case "hello":
      return typeof v.nonce === "string" && NONCE.test(v.nonce) ? { type: "hello", nonce: v.nonce } : null;
    case "ready":
    case "launched":
    case "stop":
      return { type: v.type };
    case "start":
    case "launch": {
      const ticket = ticketOf(v.ticket);
      return ticket ? { type: v.type, ticket } : null;
    }
    case "refused":
      return v.reason === "stale_ticket" || v.reason === "used_ticket" || v.reason === "foreign_ticket" || v.reason === "early_ticket" ? { type: "refused", reason: v.reason } : null;
    case "installed":
      return isCode(v.code) && isSignal(v.signal) && typeof v.ms === "number" && Number.isFinite(v.ms) && v.ms >= 0 ? { type: "installed", code: v.code, signal: v.signal, ms: v.ms } : null;
    case "exit":
      return isCode(v.code) && isSignal(v.signal) ? { type: "exit", code: v.code, signal: v.signal } : null;
    case "init": {
      const j = v.journey;
      if (typeof j !== "object" || j === null || !isText(j.module, 1024, 1) || typeof j.export !== "string" || !IDENT.test(j.export)) return null;
      if (!isText(v.baseURL, 2048, 1) || !isText(v.proxy, 256, 1) || !isFinitePositive(v.renewEveryMs)) return null;
      if (!Number.isInteger(v.parallel) || v.parallel < 1 || v.parallel > 8) return null;
      return { type: "init", journey: { module: j.module, export: j.export }, baseURL: v.baseURL, proxy: v.proxy, renewEveryMs: v.renewEveryMs, parallel: v.parallel };
    }
    case "turn":
      if (!isSafePositive(v.turn) || !isSafePositive(v.slot) || typeof v.password !== "string" || !PASSWORD.test(v.password) || !isFinitePositive(v.deadlineMono)) return null;
      return { type: "turn", turn: v.turn, slot: v.slot, password: v.password, deadlineMono: v.deadlineMono };
    case "cancel":
      return isSafePositive(v.turn) ? { type: "cancel", turn: v.turn } : null;
    case "loaded":
      return isText(v.playwright, 64, 1) ? { type: "loaded", playwright: v.playwright } : null;
    case "fatal": {
      if (v.code !== "unreadable" && v.code !== "playwright" && v.code !== "journey" && v.code !== "protocol") return null;
      const location = optional(v, "location", MAX_LOCATION);
      const error = oneOf(v, "error", ERROR_CLASSES);
      const playwright = oneOf(v, "playwright", PLAYWRIGHT_COMPAT);
      if (!isText(v.message, MAX_MESSAGE) || !location || !error || !playwright) return null;
      return { type: "fatal", code: v.code, message: v.message, ...location, ...error, ...playwright };
    }
    case "outcome": {
      if (!isSafePositive(v.turn) || v.kind !== "success" && v.kind !== "failure" && v.kind !== "timeout" && v.kind !== "cancelled") return null;
      const message = optional(v, "message", MAX_MESSAGE);
      const location = optional(v, "location", MAX_LOCATION);
      const error = oneOf(v, "error", ERROR_CLASSES);
      if (!message || !location || !error) return null;
      return { type: "outcome", turn: v.turn, kind: v.kind, ...message, ...location, ...error };
    }
    default:
      return null;
  }
}
var LineSplitter = class {
  buffer = "";
  /** Bytes after the last newline: at end of input, a frame cut short. */
  get incomplete() {
    return this.buffer !== "";
  }
  push(chunk) {
    this.buffer += chunk;
    const lines = this.buffer.split("\n");
    this.buffer = lines.pop() ?? "";
    if (Buffer.byteLength(this.buffer) > MAX_FRAME_BYTES || lines.some((line) => Buffer.byteLength(line) > MAX_FRAME_BYTES)) return null;
    return lines;
  }
};
function sameNonce(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
function newTicketState() {
  return { used: /* @__PURE__ */ new Set(), installed: false };
}
function consumeTicket(kind, ticket, now, config, state) {
  if (!sameText(ticket.claimId, config.claimId)) return "foreign";
  if (state.used.has(kind)) return "used";
  if (kind === "launch" && !state.installed) return "early";
  if (!(now.monoMs < ticket.monoDeadline) || !(now.wallMs < ticket.wallDeadline)) return "stale";
  state.used.add(kind);
  return "ok";
}
function sameText(a, b) {
  return a.length === b.length && sameNonce(a, b);
}

// src/load/jail/spec.ts
var RELAY_UID = 65533;
var IN_JAIL = {
  workspace: "/run/peeps/ws",
  home: "/run/peeps/home",
  node: "/run/peeps/node",
  action: "/run/peeps/action",
  sockets: "/run/peeps/sock",
  ca: "/run/peeps/ca.pem",
  relayPort: 3128
};
function rootDir(runId) {
  return `/run/peeps-root-${runId}`;
}
function executorEnv(config) {
  return [
    `PATH=${dirOf(config.nodeInJail)}:/usr/bin:/bin`,
    `HOME=${IN_JAIL.home}`,
    ...config.caPem ? [`NODE_EXTRA_CA_CERTS=${IN_JAIL.ca}`] : [],
    ...Object.entries(config.env).map(([name, value]) => `${name}=${value}`)
  ];
}
function rebuildEnv(config) {
  return [
    `PATH=${dirOf(config.nodeInJail)}:/usr/bin:/bin`,
    `HOME=${IN_JAIL.home}`,
    "npm_config_offline=true",
    "npm_config_registry=https://registry.npmjs.org/",
    `npm_config_userconfig=${IN_JAIL.home}/.npmrc-none`,
    `npm_config_globalconfig=${IN_JAIL.home}/.npmrc-global-none`,
    "npm_config_git=/bin/false",
    `npm_config_cache=${IN_JAIL.home}/.npm`,
    "npm_config_install_links=false",
    "npm_config_audit=false",
    "npm_config_fund=false",
    "npm_config_update_notifier=false"
  ];
}
function dropArgs(uid, gid) {
  return [
    `--reuid=${uid}`,
    `--regid=${gid}`,
    "--clear-groups",
    "--bounding-set=-all",
    "--inh-caps=-all",
    "--ambient-caps=-all",
    "--no-new-privs"
  ];
}
function dirOf(file) {
  return file.slice(0, file.lastIndexOf("/")) || "/";
}

// src/load/jail/init.ts
var MAX_QUEUE_BYTES = 1024 * 1024;
function run(cmd, args) {
  (0, import_node_child_process.execFileSync)(cmd, args, { stdio: ["ignore", "ignore", "inherit"] });
}
function bindReadOnly(source, target) {
  run("mount", ["--bind", source, target]);
  run("mount", ["-o", "remount,bind,ro,nosuid,nodev", target]);
}
function isolate(config) {
  run("mount", ["--make-rprivate", "/"]);
  const root = rootDir(config.runId);
  (0, import_node_fs.mkdirSync)(root, { recursive: true });
  run("mount", ["-t", "tmpfs", "-o", "mode=755,nosuid,nodev,size=16m", "tmpfs", root]);
  const at = (p) => `${root}${p}`;
  for (const dir of ["/usr", "/etc", "/dev", "/proc", "/tmp", "/oldroot", "/run/peeps/ws-lower", IN_JAIL.workspace, IN_JAIL.node, IN_JAIL.action, IN_JAIL.home, "/run/peeps/up", IN_JAIL.sockets]) {
    (0, import_node_fs.mkdirSync)(at(dir), { recursive: true });
  }
  bindReadOnly(config.workspace, at("/run/peeps/ws-lower"));
  bindReadOnly(config.nodeDir, at(IN_JAIL.node));
  bindReadOnly(config.actionDir, at(IN_JAIL.action));
  if (config.caPem) {
    (0, import_node_fs.writeFileSync)(at(IN_JAIL.ca), "");
    bindReadOnly(config.caPem, at(IN_JAIL.ca));
  }
  run("mount", ["--bind", config.socketDir, at(IN_JAIL.sockets)]);
  run("mount", ["-o", "remount,bind,nosuid,nodev,noexec", at(IN_JAIL.sockets)]);
  bindReadOnly("/usr", at("/usr"));
  for (const name of ["bin", "sbin", "lib", "lib64", "lib32", "libx32"]) {
    const host = `/${name}`;
    if (!(0, import_node_fs.existsSync)(host)) continue;
    if ((0, import_node_fs.lstatSync)(host).isSymbolicLink()) (0, import_node_fs.symlinkSync)((0, import_node_fs.readlinkSync)(host), at(host));
    else {
      (0, import_node_fs.mkdirSync)(at(host));
      bindReadOnly(host, at(host));
    }
  }
  for (const dir of ["ssl", "alternatives"]) {
    if (!(0, import_node_fs.existsSync)(`/etc/${dir}`)) continue;
    (0, import_node_fs.mkdirSync)(at(`/etc/${dir}`));
    bindReadOnly(`/etc/${dir}`, at(`/etc/${dir}`));
  }
  for (const file of ["ld.so.cache", "passwd", "group", "nsswitch.conf", "hosts"]) {
    if (!(0, import_node_fs.existsSync)(`/etc/${file}`)) continue;
    (0, import_node_fs.writeFileSync)(at(`/etc/${file}`), "");
    bindReadOnly(`/etc/${file}`, at(`/etc/${file}`));
  }
  run("mount", ["-t", "tmpfs", "-o", "mode=755,nosuid", "tmpfs", at("/dev")]);
  for (const node of ["null", "zero", "urandom", "random", "tty"]) {
    (0, import_node_fs.writeFileSync)(at(`/dev/${node}`), "");
    run("mount", ["--bind", `/dev/${node}`, at(`/dev/${node}`)]);
  }
  run("mount", ["-t", "tmpfs", "-o", "mode=1777,nosuid,nodev,size=256m", "tmpfs", at("/tmp")]);
  run("mount", ["-t", "tmpfs", "-o", "mode=1777,nosuid,nodev,size=256m", "tmpfs", at(IN_JAIL.home)]);
  run("mount", ["-t", "tmpfs", "-o", "size=512m,mode=755,nosuid,nodev", "tmpfs", at("/run/peeps/up")]);
  (0, import_node_fs.mkdirSync)(at("/run/peeps/up/upper"));
  const lower = (0, import_node_fs.statSync)(config.workspace);
  (0, import_node_fs.chownSync)(at("/run/peeps/up/upper"), lower.uid, lower.gid);
  (0, import_node_fs.chmodSync)(at("/run/peeps/up/upper"), lower.mode & 4095);
  (0, import_node_fs.mkdirSync)(at("/run/peeps/up/work"));
  run("mount", ["-t", "overlay", "overlay", "-o", `nosuid,nodev,lowerdir=${at("/run/peeps/ws-lower")},upperdir=${at("/run/peeps/up/upper")},workdir=${at("/run/peeps/up/work")}`, at(IN_JAIL.workspace)]);
  run("umount", ["-l", at("/run/peeps/up")]);
  run("umount", ["-l", at("/run/peeps/ws-lower")]);
  (0, import_node_fs.rmdirSync)(at("/run/peeps/up"));
  (0, import_node_fs.rmdirSync)(at("/run/peeps/ws-lower"));
  run("ip", ["link", "set", "lo", "up"]);
  process.chdir(root);
  run("pivot_root", [".", "oldroot"]);
  process.chdir("/");
  run("mount", ["-t", "proc", "-o", "nosuid,nodev,noexec", "proc", "/proc"]);
  run("umount", ["-l", "/oldroot"]);
  (0, import_node_fs.rmdirSync)("/oldroot");
}
function connectCtl(nonce) {
  return new Promise((resolve, reject) => {
    const socket = import_node_net.default.connect(`${IN_JAIL.sockets}/ctl.sock`);
    socket.once("connect", () => {
      socket.write(encode({ type: "hello", nonce }));
      resolve(socket);
    });
    socket.once("error", reject);
  });
}
function startRelay(config) {
  return new Promise((resolve, reject) => {
    const relay2 = (0, import_node_child_process.spawn)("/usr/bin/setpriv", [...dropArgs(RELAY_UID, RELAY_UID), config.nodeInJail, config.initInJail, "--relay"], {
      stdio: ["ignore", "pipe", "inherit"],
      env: {},
      cwd: "/"
    });
    relay2.stdout.setEncoding("utf8");
    relay2.stdout.once("data", (line) => line.startsWith("relay ready") ? resolve(relay2) : reject(new Error(line)));
    relay2.once("exit", (code) => reject(new Error(`relay exited ${code}`)));
  });
}
var REFUSED = { stale: "stale_ticket", used: "used_ticket", foreign: "foreign_ticket", early: "early_ticket" };
function serveControl(ctl, config, io) {
  const tickets = newTicketState();
  let executor;
  let over = false;
  const finish = (code, signal) => {
    if (over) return;
    over = true;
    ctl.write(encode({ type: "exit", code, signal }));
    io.end();
  };
  const violation = () => finish(null, "protocol");
  const send = (frame) => {
    if (over) return true;
    const flowing = ctl.write(encode(frame));
    if (ctl.writableLength > MAX_QUEUE_BYTES) violation();
    return flowing;
  };
  const install = () => {
    const t0 = io.now().monoMs;
    const child = io.install();
    if (!child) {
      tickets.installed = true;
      send({ type: "installed", code: 0, signal: null, ms: 0 });
      return;
    }
    let done = false;
    const report = (code, signal) => {
      if (done) return;
      done = true;
      if (code === 0) tickets.installed = true;
      send({ type: "installed", code, signal, ms: Math.max(0, Math.round(io.now().monoMs - t0)) });
    };
    child.once("error", () => report(null, "spawn_error"));
    child.once("exit", (code, signal) => report(code, signal));
  };
  const launch = () => {
    const child = io.executor();
    executor = child;
    const stdin = child.stdin;
    const fd3 = child.stdio[3];
    stdin.on("error", () => child.exitCode === null && child.signalCode === null && violation());
    const lines2 = new LineSplitter();
    fd3.setEncoding("utf8");
    fd3.on("error", violation);
    fd3.once("end", () => {
      if (lines2.incomplete) violation();
    });
    fd3.on("data", (chunk) => {
      if (over) return;
      const got = lines2.push(chunk);
      if (got === null) return violation();
      for (const line of got) {
        const frame = decode(line);
        if (!frame || !relayable(frame, "executor")) return violation();
        if (!send(frame)) {
          fd3.pause();
          ctl.once("drain", () => fd3.resume());
        }
        if (over) return;
      }
    });
    child.once("error", () => finish(null, "spawn_error"));
    child.once("close", (code, signal) => finish(code, signal));
    send({ type: "launched" });
  };
  const lines = new LineSplitter();
  ctl.setEncoding("utf8");
  ctl.once("end", () => {
    if (lines.incomplete) violation();
  });
  ctl.on("data", (chunk) => {
    if (over) return;
    const got = lines.push(chunk);
    if (got === null) return violation();
    for (const line of got) {
      const frame = decode(line);
      if (!frame) return violation();
      if (frame.type === "start" || frame.type === "launch") {
        const verdict = consumeTicket(frame.type, frame.ticket, io.now(), config, tickets);
        if (verdict !== "ok") send({ type: "refused", reason: REFUSED[verdict] });
        else if (frame.type === "start") install();
        else launch();
        if (over) return;
        continue;
      }
      if (!relayable(frame, "supervisor") || !executor) return violation();
      const stdin = executor.stdin;
      stdin.write(encode(frame));
      if (stdin.writableLength > MAX_QUEUE_BYTES) return violation();
    }
  });
}
function monoNow() {
  return { monoMs: Number(process.hrtime.bigint()) / 1e6, wallMs: Date.now() };
}
async function init() {
  const config = JSON.parse(process.env.PEEPS_JAIL_CONFIG ?? "");
  const nonce = process.env.PEEPS_CTL_NONCE ?? "";
  delete process.env.PEEPS_CTL_NONCE;
  isolate(config);
  const ctl = await connectCtl(nonce);
  ctl.on("close", () => process.exit(0));
  ctl.on("error", () => process.exit(0));
  await startRelay(config);
  ctl.write(encode({ type: "ready" }));
  const asExecutor = (env, command, stdio) => (0, import_node_child_process.spawn)("/usr/bin/setpriv", [...dropArgs(config.executorUid, config.executorGid), "/usr/bin/env", "-i", ...env, ...command], { stdio, cwd: IN_JAIL.workspace, env: {} });
  serveControl(ctl, config, {
    install: () => config.install ? asExecutor(rebuildEnv(config), config.install, ["ignore", "inherit", "inherit"]) : null,
    executor: () => asExecutor(executorEnv(config), config.command, ["pipe", "inherit", "inherit", "pipe"]),
    now: monoNow,
    end: () => {
      ctl.end(() => process.exit(0));
      setTimeout(() => process.exit(0), 1e3).unref();
    }
  });
}
var RELAY_MAX_CONNECTIONS = 1024;
var RELAY_IDLE_MS = 12e4;
function relay() {
  const server = import_node_net.default.createServer((client) => {
    const upstream = import_node_net.default.connect(`${IN_JAIL.sockets}/proxy.sock`);
    const close = () => {
      client.destroy();
      upstream.destroy();
    };
    client.pipe(upstream).pipe(client);
    for (const side of [client, upstream]) {
      side.on("error", close);
      side.on("close", close);
      side.setTimeout(RELAY_IDLE_MS, close);
    }
  });
  server.maxConnections = RELAY_MAX_CONNECTIONS;
  server.listen(IN_JAIL.relayPort, "127.0.0.1", () => process.stdout.write("relay ready\n"));
}
function errno(read) {
  try {
    read();
    return "readable";
  } catch (e) {
    return e.code ?? "error";
  }
}
async function probe(target) {
  const [host, port] = [target.slice(0, target.lastIndexOf(":")), Number(target.slice(target.lastIndexOf(":") + 1))];
  const tcp = (h, p, path) => new Promise((resolve) => {
    const s = import_node_net.default.connect(p, h);
    s.setTimeout(3e3, () => (s.destroy(), resolve("timeout")));
    s.once("error", (e) => resolve(e.code ?? "error"));
    s.once("connect", () => {
      s.write(`GET ${path} HTTP/1.0\r
Host: ${host}\r
\r
`);
      resolve("connected");
      s.once("data", () => s.destroy());
      s.setTimeout(3e3, () => s.destroy());
    });
  });
  const dns = await import("node:dns/promises").then((d) => d.lookup("example.com").then(() => "resolved", (e) => e.code ?? "error"));
  const unixProxy = await new Promise((resolve) => {
    const s = import_node_net.default.connect(`${IN_JAIL.sockets}/proxy.sock`);
    s.once("error", (e) => resolve(e.code ?? "error"));
    s.once("connect", () => (s.destroy(), resolve("connected")));
  });
  let workspaceWrite = "written";
  try {
    (0, import_node_fs.writeFileSync)(`${IN_JAIL.workspace}/.peeps-probe`, "x");
  } catch (e) {
    workspaceWrite = e.code ?? "error";
  }
  const result = {
    uid: process.getuid?.(),
    direct: await tcp(host, port, "/probe-direct"),
    relay: await tcp("127.0.0.1", IN_JAIL.relayPort, "/probe-relay"),
    dns,
    unixProxy,
    workspaceWrite,
    hostPaths: ["/home", "/oldroot", "/etc/shadow", "/var", "/root", "/mnt", "/opt"].filter((p) => (0, import_node_fs.existsSync)(p)),
    mounts: (0, import_node_fs.readFileSync)("/proc/self/mountinfo", "utf8").split("\n").filter(Boolean).map((l) => l.split(" ")[4]),
    procOne: errno(() => (0, import_node_fs.readFileSync)("/proc/1/environ")),
    procOneRoot: errno(() => (0, import_node_fs.readdirSync)("/proc/1/root")),
    procSelf: errno(() => (0, import_node_fs.readFileSync)("/proc/self/status"))
  };
  process.stdout.write(`PEEPS-PROBE ${JSON.stringify(result)}
`);
}
if (require.main === module) {
  const mode = process.argv[2];
  if (mode === "--relay") relay();
  else if (mode === "--probe") void probe(process.argv[3] ?? "");
  else
    init().catch((error) => {
      process.stderr.write(`peeps load jail init: ${error instanceof Error ? error.message : String(error)}
`);
      process.exit(1);
    });
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  MAX_QUEUE_BYTES,
  isolate,
  serveControl
});
