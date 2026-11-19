"use strict";

// src/load/jail/outer.ts
var import_node_child_process = require("node:child_process");
var HEARTBEAT_GRACE_MS = 2500;
function main() {
  const config = process.env.PEEPS_JAIL_CONFIG;
  if (!config) fail("no PEEPS_JAIL_CONFIG");
  const { actionDir, initInJail } = JSON.parse(config);
  const init = `${actionDir}/${initInJail.slice(initInJail.lastIndexOf("/") + 1)}`;
  let nonce;
  let last = performance.now();
  let pending = "";
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (chunk) => {
    last = performance.now();
    if (nonce !== void 0) return;
    pending += chunk;
    const newline = pending.indexOf("\n");
    if (newline < 0) return;
    nonce = pending.slice(0, newline);
    if (!/^[0-9a-f]{64}$/.test(nonce)) fail("bad nonce");
    launch(init, config, nonce);
  });
  process.stdin.on("end", () => fail("lifeline closed"));
  process.stdin.on("error", () => fail("lifeline error"));
  setInterval(() => {
    if (performance.now() - last > HEARTBEAT_GRACE_MS) fail("missed heartbeats");
  }, 250).unref();
}
function launch(init, config, nonce) {
  const child = (0, import_node_child_process.spawn)(
    "/usr/bin/unshare",
    ["--net", "--pid", "--mount", "--ipc", "--uts", "--fork", "--kill-child", "--mount-proc", process.execPath, init],
    { stdio: ["ignore", "inherit", "inherit"], env: { PATH: "/usr/sbin:/usr/bin:/sbin:/bin", PEEPS_JAIL_CONFIG: config, PEEPS_CTL_NONCE: nonce } }
  );
  child.on("exit", (code) => process.exit(code ?? 1));
  child.on("error", () => fail("could not start the jail"));
}
function fail(reason) {
  process.stderr.write(`peeps load jail: ${reason}
`);
  process.exit(1);
}
main();
