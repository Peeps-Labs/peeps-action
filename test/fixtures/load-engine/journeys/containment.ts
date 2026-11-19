import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import type { APIRequestContext } from "@playwright/test";

/**
 * Starts a grandchild that leaves the process group (`setsid`) and is reparented when its
 * parent exits, then reports the grandchild's host pid. Every turn leaves one behind.
 */
export async function escape(request: APIRequestContext): Promise<void> {
  const pidFile = `/tmp/peeps-load-escape-${process.pid}-${Date.now()}`;
  // sh forks setsid sleep in the background and exits at once: the sleeper is reparented.
  // The shell itself opens /proc/self/stat, so it reads its own pid as the host sees it.
  const child = spawn("sh", ["-c", `setsid sh -c 'read -r pid rest < /proc/self/stat; echo $pid > ${pidFile}; exec sleep 300' >/dev/null 2>&1 &`], {
    stdio: "ignore",
  });
  await new Promise((resolve) => child.on("exit", resolve));
  let pid = "";
  for (let i = 0; i < 100 && !pid; i++) {
    await new Promise((resolve) => setTimeout(resolve, 20));
    try {
      pid = readFileSync(pidFile, "utf8").trim();
    } catch {
      // not yet
    }
  }
  await request.get(`/report?escaped=${pid}`);
}
