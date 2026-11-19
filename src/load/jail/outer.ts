/**
 * The unit's main process, outside the jail's namespaces (bundled as load-outer.js).
 *
 * It reads the lifeline on stdin: the first line is the control nonce, then a
 * heartbeat every second. On EOF, or after two missed heartbeats, it exits, and
 * systemd kills the whole cgroup, stopped processes included. Teardown needs no
 * help from init (plan v3 §3, Opus r2 M1). It reads nothing from the checkout.
 */
import { spawn } from "node:child_process";

const HEARTBEAT_GRACE_MS = 2500;

function main(): void {
  const config = process.env.PEEPS_JAIL_CONFIG;
  if (!config) fail("no PEEPS_JAIL_CONFIG");
  const { actionDir, initInJail } = JSON.parse(config) as { actionDir: string; initInJail: string };
  const init = `${actionDir}/${initInJail.slice(initInJail.lastIndexOf("/") + 1)}`;

  let nonce: string | undefined;
  let last = Date.now();
  let pending = "";
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (chunk: string) => {
    last = Date.now();
    if (nonce !== undefined) return;
    pending += chunk;
    const newline = pending.indexOf("\n");
    if (newline < 0) return;
    nonce = pending.slice(0, newline);
    if (!/^[0-9a-f]{64}$/.test(nonce)) fail("bad nonce");
    launch(init, config!, nonce);
  });
  process.stdin.on("end", () => fail("lifeline closed"));
  process.stdin.on("error", () => fail("lifeline error"));
  setInterval(() => {
    if (Date.now() - last > HEARTBEAT_GRACE_MS) fail("missed heartbeats");
  }, 250).unref();
}

function launch(init: string, config: string, nonce: string): void {
  const child = spawn(
    "/usr/bin/unshare",
    ["--net", "--pid", "--mount", "--ipc", "--uts", "--fork", "--kill-child", "--mount-proc", process.execPath, init],
    { stdio: ["ignore", "inherit", "inherit"], env: { PATH: "/usr/sbin:/usr/bin:/sbin:/bin", PEEPS_JAIL_CONFIG: config, PEEPS_CTL_NONCE: nonce } },
  );
  child.on("exit", (code) => process.exit(code ?? 1));
  child.on("error", () => fail("could not start the jail"));
}

function fail(reason: string): never {
  process.stderr.write(`peeps load jail: ${reason}\n`);
  process.exit(1);
}

main();
