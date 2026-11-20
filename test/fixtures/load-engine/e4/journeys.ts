/**
 * Journeys for the executor's and sessions' tests (e4 plan v3 §3.1). They import nothing from
 * Playwright at run time, so they run at the 1.46 floor with only `playwright-core` installed.
 */
import assert from "node:assert/strict";
import { Readable } from "node:stream";
import type { APIRequestContext } from "playwright-core";

export async function get(request: APIRequestContext): Promise<void> {
  const res = await request.get("/value");
  assert.equal(res.status(), 200);
}

export async function getTen(request: APIRequestContext): Promise<void> {
  for (let i = 0; i < 10; i++) assert.equal((await request.get(`/value?n=${i}`)).status(), 200);
}

export async function three(request: APIRequestContext): Promise<void> {
  for (let i = 0; i < 3; i++) assert.equal((await request.get(`/value?n=${i}`)).status(), 200);
}

export async function twelveAtOnce(request: APIRequestContext): Promise<void> {
  const all = await Promise.all(Array.from({ length: 12 }, (_, i) => request.get(`/value?n=${i}`)));
  for (const res of all) assert.equal(res.status(), 200);
}

export async function notAllowed(request: APIRequestContext): Promise<void> {
  await request.post("/admin", { data: { a: 1 } });
}

export async function target503(request: APIRequestContext): Promise<void> {
  const res = await request.get("/busy");
  assert.equal(res.status(), 503);
  assert.equal(await res.text(), "busy");
}

export async function redirect(request: APIRequestContext): Promise<void> {
  const res = await request.get("/redirect");
  assert.equal(res.status(), 302);
  assert.equal(res.headers().location, "/elsewhere");
}

export async function cut(request: APIRequestContext): Promise<void> {
  await request.get("/hang");
}

export async function optRetries(request: APIRequestContext): Promise<void> {
  await request.get("/value", { maxRetries: 2 });
}

export async function optRedirects(request: APIRequestContext): Promise<void> {
  await request.get("/value", { maxRedirects: 3 });
}

export async function optIgnoreHttps(request: APIRequestContext): Promise<void> {
  await request.get("/value", { ignoreHTTPSErrors: true });
}

export async function optStream(request: APIRequestContext): Promise<void> {
  await request.post("/cart", { multipart: { file: Readable.from(["x"]) as never } });
}

export async function optDispose(request: APIRequestContext): Promise<void> {
  await request.dispose();
}

/** One request it does not wait for, which fails; and one it does. */
export async function floating(request: APIRequestContext): Promise<void> {
  void request.get("/busy", { failOnStatusCode: true });
  assert.equal((await request.get("/value")).status(), 200);
}

/** Throws something that cannot be turned into a message. */
export async function throwsUnreadable(): Promise<void> {
  throw Object.create(null);
}

/** Never ends by itself. */
export async function hang(): Promise<void> {
  await new Promise(() => undefined);
}

/** Ends at once, sending nothing. */
export async function quick(): Promise<void> {
  return;
}

/** Reads the slot's cookie, set by the sink on the slot's first turn. */
export async function cookie(request: APIRequestContext): Promise<void> {
  assert.equal((await request.get("/cookie")).status(), 200);
}

/** Reads the cookie, then waits on a request the sink holds, and then on nothing at all. */
export async function cookieThenHang(request: APIRequestContext): Promise<void> {
  assert.equal((await request.get("/cookie")).status(), 200);
  await request.get("/hold").catch(() => undefined);
  await new Promise(() => undefined);
}

/** One request the sink holds past any deadline. */
export async function slow(request: APIRequestContext): Promise<void> {
  await request.get("/hold");
}

/** A request whose late answer would set a new cookie. */
export async function lateCookie(request: APIRequestContext): Promise<void> {
  await request.get("/late-cookie");
}

/**
 * The sessions script: reads the slot's cookie, then does what the sink says the turn should
 * do next ("done", "hang" or "late").
 */
export async function script(request: APIRequestContext): Promise<void> {
  const res = await request.get("/script");
  assert.equal(res.status(), 200);
  const { step } = (await res.json()) as { step: string };
  if (step === "hang") {
    await request.get("/hold").catch(() => undefined);
    await new Promise(() => undefined);
  }
  if (step === "late") await request.get("/late-cookie");
}

export async function smallPost(request: APIRequestContext): Promise<void> {
  assert.equal((await request.post("/upload", { data: "small body" })).status(), 200);
}

/** One POST of a body at the gate's limit (load-freeze F4, F5). */
export async function bigPost(request: APIRequestContext): Promise<void> {
  await request.post("/upload", { data: Buffer.alloc(1024 * 1024 - 4096, 0x61), headers: { "content-type": "application/octet-stream" } });
}

/** Raw `fetch` and `node:https` to the target named in `target.txt`, around the gate (load-isolation). */
export async function rawFetch(): Promise<void> {
  const { readFileSync } = await import("node:fs");
  const https = await import("node:https");
  const url = readFileSync("target.txt", "utf8").trim();
  await fetch(url).catch(() => undefined);
  await new Promise<void>((resolve) => https.get(url, { rejectUnauthorized: false }, () => resolve()).on("error", () => resolve()));
}

/** The journey's whole environment, sorted, as its failure message (load-jail: exactly the allowlist). */
export async function envDump(): Promise<void> {
  const allowed = ["HOME", "NODE_EXTRA_CA_CERTS", "PATH"];
  // An unexpected job variable should fail the test without logging its value.
  throw new Error(`ENV ${JSON.stringify({
    keys: Object.keys(process.env).sort(),
    values: allowed.map((key) => process.env[key]),
  })}`);
}
