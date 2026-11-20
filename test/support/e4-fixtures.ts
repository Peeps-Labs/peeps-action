/**
 * The E4 executor fixtures (e4 plan v3 §3.1): the journeys' folder as the executor's checkout,
 * or a copy wired to the 1.46 floor's Playwright when PEEPS_LOAD_PLAYWRIGHT_DIR names a folder
 * holding node_modules/playwright-core; and the sink's answers by path.
 */
import { cpSync, mkdirSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { TestContext } from "node:test";
import type { Arrival } from "./load-sink";

export const FIXTURES = path.resolve(__dirname, "../fixtures/load-engine/e4");
const FLOOR_DIR = process.env.PEEPS_LOAD_PLAYWRIGHT_DIR;

/** The checkout the executor runs in: the fixtures, or a copy wired to the floor's Playwright. */
export function fixtureWorkspace(t: TestContext): string {
  if (!FLOOR_DIR) return FIXTURES;
  const dir = mkdtempSync(path.join(os.tmpdir(), "peeps-floor-ws-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  cpSync(FIXTURES, dir, { recursive: true });
  mkdirSync(path.join(dir, "node_modules"));
  symlinkSync(path.join(FLOOR_DIR, "node_modules/playwright-core"), path.join(dir, "node_modules/playwright-core"));
  return dir;
}

/** The sink's answers, by path. */
export function respond(arrival: Arrival, res: import("node:http").ServerResponse): void {
  const url = new URL(arrival.url, "https://sink.test");
  switch (url.pathname) {
    case "/busy":
      res.writeHead(503, { "content-type": "text/plain" });
      return void res.end("busy");
    case "/redirect":
      res.writeHead(302, { location: "/elsewhere" });
      return void res.end();
    case "/hang":
    case "/hold":
      return;
    case "/cookie": {
      const cookie = arrival.headers.cookie;
      res.writeHead(200, { "content-type": "application/json", ...(cookie ? {} : { "set-cookie": `u=${Math.random().toString(36).slice(2)}; Path=/` }) });
      return void res.end(JSON.stringify({ cookie: cookie ?? null }));
    }
    case "/late-cookie":
      setTimeout(() => {
        res.writeHead(200, { "set-cookie": "u=late; Path=/" });
        res.end("late");
      }, 1500);
      return;
    default:
      res.writeHead(200, { "content-type": "text/plain" });
      res.end("ok");
  }
}

