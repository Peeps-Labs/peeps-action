/** The debugging socket's edges: a handshake that never completes, and a close nobody asked about. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer as createHttp } from "node:http";
import { createServer as createTcp, type AddressInfo } from "node:net";
import { chromium } from "@playwright/test";

import { connectCdp } from "../src/evidence/browser/cdp-socket";
import { pickPort } from "../src/evidence/browser/worker";

test("a WebSocket upgrade that never answers gives up at its deadline, and the socket is closed", async (t) => {
  // Accepts the connection, never answers the upgrade.
  const held: Array<import("node:net").Socket> = [];
  const silent = createTcp((socket) => void held.push(socket));
  await new Promise<void>((resolve) => silent.listen(0, "127.0.0.1", resolve));
  const wsPort = (silent.address() as AddressInfo).port;
  const http = createHttp((_, res) => res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({ webSocketDebuggerUrl: `ws://127.0.0.1:${wsPort}/devtools/browser/x` })));
  await new Promise<void>((resolve) => http.listen(0, "127.0.0.1", resolve));
  t.after(() => {
    for (const socket of held) socket.destroy();
    silent.close();
    http.close();
  });
  const started = Date.now();
  await assert.rejects(connectCdp((http.address() as AddressInfo).port, { deadlineMs: 300 }), /in time/);
  assert.ok(Date.now() - started < 2_000, `took ${Date.now() - started} ms`);
});

test("a close is reported to whoever listens, whatever was pending", async (t) => {
  const port = pickPort()!;
  const browser = await chromium.launch({ args: [`--remote-debugging-port=${port}`] });
  t.after(() => browser.close());
  const cdp = await connectCdp(port);
  const closed = new Promise<void>((resolve) => cdp.onClose(resolve));
  cdp.close();
  await closed;
  await assert.rejects(cdp.send("Target.getBrowserContexts"), /closed/);
});
