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
  isolate: () => isolate
});
module.exports = __toCommonJS(init_exports);
var import_node_child_process = require("node:child_process");
var import_node_fs = require("node:fs");
var import_node_net = __toESM(require("node:net"));

// src/load/jail/ctl.ts
var MAX_FRAME_BYTES = 64 * 1024;
function encode(frame) {
  return `${JSON.stringify(frame)}
`;
}
function decode(line) {
  let value;
  try {
    value = JSON.parse(line);
  } catch {
    return null;
  }
  if (typeof value !== "object" || value === null) return null;
  const v = value;
  switch (v.type) {
    case "hello":
      return typeof v.nonce === "string" && /^[0-9a-f]{64}$/.test(v.nonce) ? { type: "hello", nonce: v.nonce } : null;
    case "ready":
    case "start":
      return { type: v.type };
    case "exit": {
      const code = v.code === null || typeof v.code === "number" && Number.isInteger(v.code) ? v.code : void 0;
      const signal = v.signal === null || typeof v.signal === "string" ? v.signal : void 0;
      return code === void 0 || signal === void 0 ? null : { type: "exit", code, signal };
    }
    default:
      return null;
  }
}
var LineSplitter = class {
  buffer = "";
  push(chunk) {
    this.buffer += chunk;
    const lines = this.buffer.split("\n");
    this.buffer = lines.pop() ?? "";
    if (Buffer.byteLength(this.buffer) > MAX_FRAME_BYTES || lines.some((line) => Buffer.byteLength(line) > MAX_FRAME_BYTES)) return null;
    return lines;
  }
};

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
async function init() {
  const config = JSON.parse(process.env.PEEPS_JAIL_CONFIG ?? "");
  const nonce = process.env.PEEPS_CTL_NONCE ?? "";
  delete process.env.PEEPS_CTL_NONCE;
  isolate(config);
  const ctl = await connectCtl(nonce);
  const send = (frame) => ctl.write(encode(frame));
  ctl.on("close", () => process.exit(0));
  ctl.on("error", () => process.exit(0));
  await startRelay(config);
  send({ type: "ready" });
  const lines = new LineSplitter();
  let started = false;
  ctl.setEncoding("utf8");
  ctl.on("data", (chunk) => {
    const got = lines.push(chunk);
    if (got === null) process.exit(1);
    for (const line of got) {
      if (decode(line)?.type !== "start" || started) continue;
      started = true;
      const executor = (0, import_node_child_process.spawn)(
        "/usr/bin/setpriv",
        [...dropArgs(config.executorUid, config.executorGid), "/usr/bin/env", "-i", ...executorEnv(config), ...config.command],
        { stdio: ["ignore", "inherit", "inherit"], cwd: IN_JAIL.workspace, env: {} }
      );
      executor.on("exit", (code, signal) => {
        send({ type: "exit", code, signal });
        ctl.end(() => process.exit(0));
      });
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
var mode = process.argv[2];
if (mode === "--relay") relay();
else if (mode === "--probe") void probe(process.argv[3] ?? "");
else
  init().catch((error) => {
    process.stderr.write(`peeps load jail init: ${error instanceof Error ? error.message : String(error)}
`);
    process.exit(1);
  });
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  isolate
});
