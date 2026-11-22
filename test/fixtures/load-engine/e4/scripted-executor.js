/**
 * An executor that misbehaves on purpose, for the supervisor's tests (e4 plan v3 §3.2): frames
 * in on stdin, out on fd 3, as the real one. `PEEPS_SCRIPT` says what it does:
 *
 *   silent     every turn reports success without a request
 *   request    every turn makes one GET through the gate, then reports success
 *   fatal      answers `init` with `fatal` (PEEPS_FATAL_MESSAGE, _LOCATION and _ERROR set its fields)
 *   mute       never answers `init`
 *
 * PEEPS_PW_VERSION sets the Playwright version `loaded` reports. And on top, with `request`: PEEPS_DUP=1 reports each outcome twice; PEEPS_EXIT_AFTER=n exits
 * after n outcomes; PEEPS_BAD_AFTER=n sends a frame only init may send after n outcomes;
 * PEEPS_BIG_AFTER=n sends an oversized line; PEEPS_IGNORE_AFTER=n answers no turn after n
 * outcomes, `cancel` included.
 */
"use strict";
const fs = require("node:fs");
const http = require("node:http");
const tls = require("node:tls");

const mode = process.env.PEEPS_SCRIPT || "request";
const num = (name) => (process.env[name] === undefined ? Infinity : Number(process.env[name]));
const out = fs.createWriteStream(null, { fd: 3 });
const send = (f) => out.write(JSON.stringify(f) + "\n");
let init;
let outcomes = 0;

function get(turn, password) {
  const proxy = new URL(init.proxy);
  const base = new URL(init.baseURL);
  const credential = "Basic " + Buffer.from(`${turn}:${password}`).toString("base64");
  return new Promise((resolve) => {
    const req = http.request({ host: proxy.hostname, port: proxy.port, method: "CONNECT", path: base.host, headers: { host: base.host, "proxy-authorization": credential } });
    req.on("connect", (res, socket) => {
      if (res.statusCode !== 200) return resolve(false);
      const s = tls.connect({ socket, servername: base.hostname }, () => {
        s.write(`GET /value HTTP/1.1\r\nHost: ${base.host}\r\nConnection: close\r\n\r\n`);
      });
      let got = "";
      s.on("data", (d) => (got += d));
      s.on("end", () => resolve(/^HTTP\/1\.1 200/.test(got)));
      s.on("error", () => resolve(false));
    });
    req.on("error", () => resolve(false));
    req.end();
  });
}

async function onTurn(f) {
  if (outcomes >= num("PEEPS_IGNORE_AFTER")) return;
  if (mode === "request") await get(f.turn, f.password);
  outcomes += 1;
  send({ type: "outcome", turn: f.turn, kind: "success" });
  if (process.env.PEEPS_DUP) send({ type: "outcome", turn: f.turn, kind: "success" });
  if (outcomes >= num("PEEPS_EXIT_AFTER")) process.exit(3);
  if (outcomes >= num("PEEPS_BAD_AFTER")) send({ type: "ready" });
  if (outcomes >= num("PEEPS_BIG_AFTER")) out.write(JSON.stringify({ type: "outcome", turn: f.turn, kind: "success", message: "x".repeat(100_000) }) + "\n");
}

let buf = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buf += chunk;
  let i;
  while ((i = buf.indexOf("\n")) >= 0) {
    const f = JSON.parse(buf.slice(0, i));
    buf = buf.slice(i + 1);
    if (f.type === "init") {
      init = f;
      if (mode === "fatal") send({ type: "fatal", code: "journey", message: process.env.PEEPS_FATAL_MESSAGE || "the journey did not load::set-output", location: process.env.PEEPS_FATAL_LOCATION || "journeys.ts:1", ...(process.env.PEEPS_FATAL_ERROR ? { error: process.env.PEEPS_FATAL_ERROR } : {}) });
      else if (mode !== "mute") send({ type: "loaded", playwright: process.env.PEEPS_PW_VERSION || "0.0.0-scripted" });
    } else if (f.type === "turn") void onTurn(f);
  }
});
process.stdin.on("end", () => process.exit(0));
