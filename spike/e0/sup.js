// Supervisor stand-in for the teardown rows: launches the unit, sends heartbeats,
// and calls end() when sudo exits (plan v3 §3).
const { spawn, execFileSync } = require("node:child_process");
const [unit, args] = [process.argv[2], JSON.parse(process.argv[3])];
const c = spawn("sudo", ["-n", "systemd-run", `--unit=${unit}`, ...args], { stdio: ["pipe", "inherit", "inherit"] });
console.log(`SUP pid=${process.pid} sudo=${c.pid}`);
const hb = setInterval(() => { try { c.stdin.write("hb\n"); } catch {} }, 1000);
c.on("exit", () => {
  clearInterval(hb);
  c.stdin.destroy();
  setTimeout(() => {
    try { execFileSync("sudo", ["-n", "systemctl", "stop", `${unit}.service`], { stdio: "ignore" }); } catch {}
    process.exit(0);
  }, 2000);
});
