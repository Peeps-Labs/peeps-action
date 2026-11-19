// Unit main process, in the root namespaces. Spawns the jail and ends the unit
// on lifeline EOF or two missed heartbeats (plan v3 §3).
const { spawn } = require("node:child_process");
const [init, mode] = process.argv.slice(2);
const child = spawn(
  "/usr/bin/unshare",
  ["--net", "--pid", "--mount", "--ipc", "--uts", "--fork", "--kill-child", "--mount-proc", "/bin/bash", init, mode],
  { stdio: ["ignore", "inherit", "inherit"], env: process.env },
);
child.on("exit", (code) => process.exit(code ?? 1));
if (process.env.E0_LIFELINE === "1") {
  let last = Date.now();
  process.stdin.on("data", () => { last = Date.now(); });
  process.stdin.on("end", () => { console.log("OUTER lifeline EOF"); process.exit(0); });
  process.stdin.on("error", () => process.exit(0));
  setInterval(() => {
    if (Date.now() - last > 2500) { console.log("OUTER missed heartbeats"); process.exit(0); }
  }, 250);
}
