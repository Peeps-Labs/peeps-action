/**
 * Runs the HTTP control port in a process of its own, so a test can start it with the job's
 * proxy and TLS environment (`NODE_USE_ENV_PROXY` is read once, at startup). Prints one JSON
 * line: what each call came to, never what it carried.
 */
import { HttpControlPort, ControlHttpError } from "../../src/load/http-control-port";
import { renewBody, type ClaimRequest } from "../../src/load/control-port";
import { loopbackLookup } from "./control-server";

interface Config {
  peepsUrl: string;
  rogueUrl: string;
  oidcUrl: string;
  oidcHost: string;
  requestToken: string;
  ca: string[];
  claim: ClaimRequest;
}

const config = JSON.parse(process.env.PEEPS_TEST_CHILD_CONFIG!) as Config;
const outcome = (p: Promise<unknown>) => p.then((v) => ({ ok: true, keys: Object.keys(v as object).sort() }), (e: unknown) => ({ ok: false, code: e instanceof ControlHttpError ? e.code : "other" }));

async function main(): Promise<void> {
  const seams = { ca: config.ca, lookup: loopbackLookup, oidcHosts: [config.oidcHost] };
  const port = new HttpControlPort({ peepsUrl: config.peepsUrl, oidc: { requestUrl: config.oidcUrl, requestToken: config.requestToken } }, seams);
  const signal = () => AbortSignal.timeout(5000);
  const claim = await port.claim(config.claim, signal()) as { claimId: string; runToken: string; eventsToken: string };
  const renew = await outcome(port.renew(claim.claimId, claim.runToken, renewBody({ epoch: 1, seq: 1, nonce: "n", phase: "starting", debited: 0, unresolved: 0, inFlight: 0, state: "running", lagP99Ms: 0 }).body, signal()));
  const events = await outcome(port.events(claim.claimId, claim.eventsToken, { streamId: "s", seq: 1, payloadHash: "h", batch: "{}" }, signal()));
  port.close();
  const rogue = new HttpControlPort({ peepsUrl: config.rogueUrl, oidc: { requestUrl: config.oidcUrl, requestToken: config.requestToken } }, seams);
  const untrusted = await outcome(rogue.renew(claim.claimId, claim.runToken, "{}", signal()));
  rogue.close();
  // The bundled roots, not NODE_EXTRA_CA_CERTS (which holds the rogue server's CA).
  const bundled = new HttpControlPort({ peepsUrl: config.rogueUrl, oidc: { requestUrl: config.oidcUrl, requestToken: config.requestToken } }, { lookup: loopbackLookup, oidcHosts: [config.oidcHost] });
  const extraCa = await outcome(bundled.renew(claim.claimId, claim.runToken, "{}", signal()));
  bundled.close();
  process.stdout.write(JSON.stringify({ claim: Object.keys(claim).sort(), renew, events, untrusted, extraCa }) + "\n");
}

main().catch((e: unknown) => {
  process.stdout.write(JSON.stringify({ failed: e instanceof ControlHttpError ? e.code : "other" }) + "\n");
  process.exitCode = 1;
});
