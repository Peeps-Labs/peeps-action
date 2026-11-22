/**
 * Run as its own process with `NODE_USE_ENV_PROXY=1` and `HTTPS_PROXY` set before Node starts,
 * which is the only time Node reads them. It first sends one request through Node's global agent
 * (the control: that one must reach the proxy), then the call under test over the action's
 * transport, and prints what it got as one JSON line.
 */
import https from "node:https";
import { readJobIdentity } from "../../src/load/oidc";
import { downloadTarballs } from "../../src/load/registry-fetch";
import { loopbackLookup } from "./control-server";

interface Args {
  controlUrl: string;
  ca: string[];
  oidc?: { requestUrl: string; requestToken: string; oidcHost: string; env: Record<string, string> };
  download?: { tarballs: { url: string; integrity: string }[]; cache: string; port: number; toolchain: { nodeDir: string; node: string; npmCli: string; nodeVersion: string; npmVersion: string } };
}

async function main(): Promise<void> {
  const a = JSON.parse(process.env.PROBE_ARGS!) as Args;
  await new Promise<void>((resolve) => {
    const req = https.get(a.controlUrl, { ca: a.ca }, (res) => {
      res.resume();
      res.on("end", resolve);
    });
    req.on("error", () => resolve());
  });
  const seams = { ca: a.ca, lookup: loopbackLookup };
  let result: unknown;
  if (a.oidc) result = await readJobIdentity({ requestUrl: a.oidc.requestUrl, requestToken: a.oidc.requestToken }, a.oidc.env, { ...seams, oidcHosts: [a.oidc.oidcHost] });
  if (a.download) result = await downloadTarballs(a.download.tarballs, a.download.cache, a.download.toolchain, { ...seams, port: a.download.port }).catch((e: Error) => ({ error: e.message }));
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

void main();
