/**
 * A recording HTTP proxy, and the child that runs a request with Node's own env proxy on
 * (`env-proxy-child.ts`). Node reads `NODE_USE_ENV_PROXY` only at startup, so a test that sets it
 * in its own `process.env` proves nothing; the child is started with it.
 */
import { execFile } from "node:child_process";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import type { TestContext } from "node:test";

export async function recordingProxy(t: TestContext): Promise<{ url: string; hits: string[] }> {
  const hits: string[] = [];
  const proxy = createServer((req, res) => {
    hits.push(String(req.url));
    res.writeHead(502).end();
  });
  proxy.on("connect", (req, socket) => {
    hits.push(`CONNECT ${req.url}`);
    socket.destroy();
  });
  await new Promise<void>((resolve) => proxy.listen(0, "127.0.0.1", resolve));
  t.after(() => proxy.close());
  return { url: `http://127.0.0.1:${(proxy.address() as AddressInfo).port}`, hits };
}

/** Node 24.5 and later honour NODE_USE_ENV_PROXY for the global agent. */
export const envProxySupported = (() => {
  const [major, minor] = process.versions.node.split(".").map(Number) as [number, number];
  return major > 24 || (major === 24 && minor >= 5);
})();

export function runWithEnvProxy(proxyUrl: string, args: unknown): Promise<unknown> {
  return new Promise((resolve, reject) => {
    execFile(process.execPath, ["--import", "tsx", path.join(__dirname, "env-proxy-child.ts")], {
      env: { PATH: process.env.PATH, HOME: process.env.HOME, NODE_USE_ENV_PROXY: "1", HTTPS_PROXY: proxyUrl, https_proxy: proxyUrl, PROBE_ARGS: JSON.stringify(args) },
      timeout: 30_000,
    }, (error, stdout, stderr) => {
      if (error) return reject(new Error(`${error.message}\n${stderr}`));
      try {
        resolve(JSON.parse(stdout.trim().split("\n").pop()!));
      } catch {
        reject(new Error(`no result: ${stdout}${stderr}`));
      }
    });
  });
}
