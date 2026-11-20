"use strict";
var __create = Object.create;
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __getProtoOf = Object.getPrototypeOf;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __export = (target, all) => {
  for (var name2 in all)
    __defProp(target, name2, { get: all[name2], enumerable: true });
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toESM = (mod, isNodeMode, target) => (target = mod != null ? __create(__getProtoOf(mod)) : {}, __copyProps(
  // If the importer is in node compatibility mode or this is not an ESM
  // file that has been converted to a CommonJS file using a Babel-
  // compatible transform (i.e. "__esModule" has not been set), then set
  // "default" to the CommonJS "module.exports" for node compatibility.
  isNodeMode || !mod || !mod.__esModule ? __defProp(target, "default", { value: mod, enumerable: true }) : target,
  mod
));
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);

// src/load/main.ts
var main_exports = {};
__export(main_exports, {
  mainLoad: () => mainLoad,
  readLoadInputs: () => readLoadInputs,
  reportOf: () => reportOf,
  stepSummary: () => stepSummary
});
module.exports = __toCommonJS(main_exports);
var import_node_fs4 = require("node:fs");
var import_node_path3 = __toESM(require("node:path"));

// src/load/http-control-port.ts
var import_node_crypto2 = require("node:crypto");
var import_node_http = require("node:http");
var import_node_https = require("node:https");
var import_node_tls = require("node:tls");
var import_node_util = require("node:util");

// src/load/control-port.ts
var import_node_crypto = require("node:crypto");

// src/load/wire.ts
var WIRE_PROTOCOL = 1;
var CLAIM_BODY_MAX_BYTES = 16 * 1024;
var RENEW_BODY_MAX_BYTES = 4 * 1024;
var EVENTS_BODY_MAX_BYTES = 300 * 1024;
var EVENTS_BATCH_MAX_BYTES = 256 * 1024;
var CLAIM_REFUSALS = [
  "auth",
  "unknown_grant",
  "wrong_workflow",
  "wrong_commit",
  "binding",
  "rerun",
  "duplicate_claim",
  "claim_superseded",
  "identity",
  "self_hosted",
  "fence_unverified",
  "expired",
  "stopped",
  "not_enabled",
  "policy_changed",
  "environment_changed",
  "outside_harness",
  "unsupported_protocol",
  "malformed"
];
var RENEW_REFUSALS = ["auth", "epoch", "hash", "gap", "changed_payload", "debited", "closed", "malformed"];
var EVENTS_REFUSALS = ["auth", "expired", "malformed", "hash", "stream", "gap", "conflict", "after_final", "budget"];
var STOP_REASONS = ["load_testing_off", "policy_changed", "environment_changed", "user_stop", "scope_deleted", "identity_conflict"];
var member = (list) => (v2) => typeof v2 === "string" && list.includes(v2);
var isClaimRefusal = member(CLAIM_REFUSALS);
var isStopReason = member(STOP_REASONS);

// src/load/control-port.ts
function canonical(value) {
  if (value === null || typeof value !== "object") {
    if (typeof value === "number" && !Number.isFinite(value)) throw new Error("canonical: a number must be finite");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  const obj = value;
  return `{${Object.keys(obj).filter((k) => obj[k] !== void 0).sort().map((k) => `${JSON.stringify(k)}:${canonical(obj[k])}`).join(",")}}`;
}
function sha256(text2) {
  return (0, import_node_crypto.createHash)("sha256").update(text2).digest("hex");
}
function planHashOf(plan) {
  return sha256(canonical(plan));
}
function renewBody(fields) {
  const requestHash = sha256(canonical(fields));
  return { requestHash, body: canonical({ ...fields, requestHash }) };
}
var isObj = (v2) => typeof v2 === "object" && v2 !== null && !Array.isArray(v2);
var text = (v2, max = 512) => typeof v2 === "string" && v2.length > 0 && v2.length <= max;
var whole = (v2) => typeof v2 === "number" && Number.isSafeInteger(v2) && v2 >= 0;
var finite = (v2) => typeof v2 === "number" && Number.isFinite(v2);
var texts = (v2, max) => Array.isArray(v2) && v2.length <= max && v2.every((x) => text(x, 2048));
var SHA = /^[0-9a-f]{64}$/;
var COMMIT = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/;
var sha = (v2) => typeof v2 === "string" && SHA.test(v2);
var only = (v2, keys) => Object.keys(v2).length === keys.length && keys.every((k) => Object.hasOwn(v2, k));
function decodeBinding(v2) {
  if (!isObj(v2) || !only(v2, ["checkoutSha", "lockDigests", "observed", "workload"])) return;
  const { lockDigests: l, observed: o, workload: w } = v2;
  if (typeof v2.checkoutSha !== "string" || !COMMIT.test(v2.checkoutSha)) return;
  if (!isObj(l) || !only(l, ["package-lock.json"]) || !sha(l["package-lock.json"])) return;
  if (!isObj(o) || !only(o, ["treeDigest", "generatedLockDigest"]) || !sha(o.treeDigest) || !sha(o.generatedLockDigest)) return;
  if (!isObj(w) || !only(w, ["path", "digest"]) || !text(w.path, 1024) || !sha(w.digest)) return;
  return {
    checkoutSha: v2.checkoutSha,
    lockDigests: { "package-lock.json": l["package-lock.json"] },
    observed: { treeDigest: o.treeDigest, generatedLockDigest: o.generatedLockDigest },
    workload: { path: w.path, digest: w.digest }
  };
}
function decodePhase(v2) {
  if (v2 === void 0) return void 0;
  if (!isObj(v2)) return false;
  const out = {};
  for (const key of ["ratePerSecond", "burst", "maxUsers", "total"]) {
    const x = v2[key];
    if (x === void 0) continue;
    if (key === "ratePerSecond" ? !(finite(x) && x > 0) : !whole(x)) return false;
    out[key] = x;
  }
  return out;
}
function decodeClaimReply(raw) {
  const bad = { ok: false, refused: "malformed" };
  if (!isObj(raw)) return bad;
  if (raw.refused !== void 0) return { ok: false, refused: isClaimRefusal(raw.refused) ? raw.refused : "unknown" };
  const { limits: l, lease: s, workload: w } = raw;
  if (!text(raw.claimId, 256) || !whole(raw.epoch) || !text(raw.runToken, 4096) || !text(raw.eventsToken, 4096) || !text(raw.planHash, 64) || !SHA.test(raw.planHash)) return bad;
  if (!isObj(raw.plan) || !text(raw.baseURL, 2048)) return bad;
  if (!isObj(w) || !text(w.path, 1024) || !text(w.digest, 128) || !text(w.module, 1024) || !text(w.export, 256)) return bad;
  if (!isObj(l) || !texts(l.allowedOrigins, 20) || !isObj(l.privateOrigins) || !Object.values(l.privateOrigins).every((v2) => texts(v2, 20)) || Object.keys(l.privateOrigins).length > 20 || !whole(l.maxUsers) || !whole(l.requestBudget) || !whole(l.policyRevision) || !isObj(l.phases)) return bad;
  const checking = decodePhase(l.phases.checking);
  const measurement = decodePhase(l.phases.measurement);
  if (checking === false || measurement === false) return bad;
  let originCaps;
  if (l.originCaps !== void 0) {
    if (!isObj(l.originCaps)) return bad;
    originCaps = {};
    for (const [k, n] of Object.entries(l.originCaps)) {
      if (!whole(n)) return bad;
      originCaps[k] = n;
    }
  }
  if (!isObj(s) || s.seq !== 0 || !text(s.nonce, 256) || !finite(s.ttlMs) || !(finite(s.renewEveryMs) && s.renewEveryMs > 0) || !whole(s.ceiling) || !finite(s.leaseUntilServerMs) || !finite(s.serverNowMs)) return bad;
  if (!whole(raw.maxRunMs) || !whole(raw.graceMs) || !finite(raw.hardEndServerMs)) return bad;
  const binding = decodeBinding(raw.binding);
  if (!binding) return bad;
  return {
    ok: true,
    grant: {
      claimId: raw.claimId,
      epoch: raw.epoch,
      runToken: raw.runToken,
      eventsToken: raw.eventsToken,
      planHash: raw.planHash,
      plan: raw.plan,
      workload: { path: w.path, digest: w.digest, module: w.module, export: w.export },
      limits: {
        allowedOrigins: [...l.allowedOrigins],
        privateOrigins: Object.fromEntries(Object.entries(l.privateOrigins).map(([k, v2]) => [k, [...v2]])),
        maxUsers: l.maxUsers,
        requestBudget: l.requestBudget,
        policyRevision: l.policyRevision,
        phases: { ...checking ? { checking } : {}, ...measurement ? { measurement } : {} },
        ...originCaps ? { originCaps } : {}
      },
      lease: { seq: 0, nonce: s.nonce, ttlMs: s.ttlMs, renewEveryMs: s.renewEveryMs, ceiling: s.ceiling, leaseUntilServerMs: s.leaseUntilServerMs, serverNowMs: s.serverNowMs },
      maxRunMs: raw.maxRunMs,
      graceMs: raw.graceMs,
      hardEndServerMs: raw.hardEndServerMs,
      baseURL: raw.baseURL,
      binding
    }
  };
}
function decodeRenewReply(raw) {
  if (!isObj(raw) || !text(raw.claimId, 256) || !whole(raw.epoch) || !text(raw.planHash, 64) || !whole(raw.seq) || !text(raw.nonce, 256)) return { kind: "unaddressed" };
  const num = (v2) => finite(v2) ? v2 : Number.NaN;
  let stop;
  let lease = raw.lease === "held" || raw.lease === "lost" ? raw.lease : "lost";
  if (raw.stop !== void 0) {
    const st = raw.stop;
    if (isObj(st) && (st.mode === "graceful" || st.mode === "now") && isStopReason(st.reason)) stop = { mode: st.mode, reason: st.reason };
    else lease = "lost";
  }
  return {
    kind: "reply",
    reply: {
      claimId: raw.claimId,
      epoch: raw.epoch,
      planHash: raw.planHash,
      seq: raw.seq,
      nonce: raw.nonce,
      lease,
      ttlMs: num(raw.ttlMs),
      ceiling: whole(raw.ceiling) ? raw.ceiling : Number.NaN,
      leaseUntilServerMs: num(raw.leaseUntilServerMs),
      serverNowMs: num(raw.serverNowMs),
      ...stop ? { stop } : {}
    }
  };
}
function decodeClosedReceipt(raw) {
  if (!isObj(raw) || raw.closed !== true || raw.lease !== "lost" || raw.ttlMs !== 0 || !whole(raw.ceiling) || !finite(raw.leaseUntilServerMs) || !finite(raw.serverNowMs) || "refused" in raw || !text(raw.claimId, 256) || !whole(raw.epoch) || !text(raw.planHash, 64) || !whole(raw.seq) || !text(raw.nonce, 256)) return void 0;
  return { claimId: raw.claimId, epoch: raw.epoch, planHash: raw.planHash, seq: raw.seq, nonce: raw.nonce, closed: true };
}

// src/load/http-control-port.ts
var LOAD_OIDC_AUDIENCE = "peeps-load";
var CLAIM_RETRY_MS = 4500;
var CLAIM_ATTEMPT_MS = 2e3;
var CLAIM_PAUSE_MS = 100;
var CLAIM_ANSWER_MAX_BYTES = 2 * 1024 * 1024;
var ANSWER_MAX_BYTES = 64 * 1024;
var OIDC_ANSWER_MAX_BYTES = 16 * 1024;
var OIDC_TOKEN_MAX_CHARS = 8 * 1024;
var OIDC_ATTEMPTS = 5;
var GITHUB_OIDC_HOSTS = [".actions.githubusercontent.com"];
var REFUSALS = /* @__PURE__ */ new Set([...CLAIM_REFUSALS, ...RENEW_REFUSALS]);
var CLAIM_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
var EVENT_REASONS = new Set(EVENTS_REFUSALS);
var ControlHttpError = class extends Error {
  constructor(op, code, status, detail) {
    super(`load control ${op}: ${code}${status !== void 0 ? ` ${status}` : ""}${detail ? ` (${detail})` : ""}`);
    this.op = op;
    this.code = code;
    this.status = status;
    this.detail = detail;
    this.name = "ControlHttpError";
  }
  /** Worth sending the same bytes again. */
  get transient() {
    if (this.code === "status") return this.status !== void 0 && (this.status >= 500 || this.status === 408 || this.status === 429);
    return this.code === "network" || this.code === "timeout";
  }
};
var monoNow = () => Number(process.hrtime.bigint()) / 1e6;
var HttpControlPort = class {
  origin;
  oidcUrl;
  requestToken;
  userAgent;
  lookup;
  renewAgent;
  eventsAgent;
  oidcAgent;
  constructor(options, seams = {}) {
    if (diagnosticsOn()) throw new ControlHttpError("config", "diagnostics");
    this.origin = peepsOrigin(options.peepsUrl);
    this.oidcUrl = oidcRequestUrl(options.oidc.requestUrl, seams.oidcHosts ?? GITHUB_OIDC_HOSTS);
    this.requestToken = options.oidc.requestToken;
    this.userAgent = options.userAgent ?? "peeps-action-load";
    this.lookup = seams.lookup;
    const tls = {
      ca: seams.ca ?? [...import_node_tls.rootCertificates],
      rejectUnauthorized: true,
      minVersion: "TLSv1.2",
      maxVersion: "TLSv1.3",
      ciphers: import_node_crypto2.constants.defaultCoreCipherList,
      enableTrace: false,
      ALPNProtocols: ["http/1.1"],
      ...seams.lookup ? { lookup: seams.lookup } : {}
    };
    this.renewAgent = new import_node_https.Agent({ ...tls, keepAlive: true, maxSockets: 2, maxFreeSockets: 2, scheduling: "lifo" });
    this.eventsAgent = new import_node_https.Agent({ ...tls, keepAlive: true, maxSockets: 1, maxFreeSockets: 1 });
    this.oidcAgent = new import_node_https.Agent({ ...tls, keepAlive: false, maxSockets: 1 });
  }
  /**
   * Mints the OIDC token, then sends the claim and retries it, identical bytes and the same
   * token, on a transient failure until `CLAIM_RETRY_MS` after the call.
   */
  async claim(body, signal) {
    const deadline = monoNow() + CLAIM_RETRY_MS;
    const window = AbortSignal.any([signal, AbortSignal.timeout(CLAIM_RETRY_MS)]);
    const idToken = await this.mint(window, signal);
    const bytes = canonical(body);
    let last;
    for (; ; ) {
      const left = deadline - monoNow();
      if (left <= 0) throw last ?? new ControlHttpError("claim", "timeout");
      const cutByWindow = left < CLAIM_ATTEMPT_MS;
      const attempt = AbortSignal.any([signal, AbortSignal.timeout(Math.max(1, Math.ceil(Math.min(left, CLAIM_ATTEMPT_MS))))]);
      try {
        const answer = await this.send("claim", this.renewAgent, "/api/v1/load/claims", idToken, bytes, CLAIM_ANSWER_MAX_BYTES, attempt);
        if (monoNow() >= deadline) {
          last = new ControlHttpError("claim", "timeout");
          continue;
        }
        const reply = reduceRefusal(answer);
        if (isObj2(reply) && !("refused" in reply) && !(typeof reply.claimId === "string" && CLAIM_ID.test(reply.claimId))) throw new ControlHttpError("claim", "malformed", answer.status);
        return reply;
      } catch (error) {
        if (!(error instanceof ControlHttpError) || !error.transient || signal.aborted) throw signal.aborted ? new ControlHttpError("claim", "aborted") : error;
        if (!(last && cutByWindow && error.code === "timeout")) last = error;
      }
      const pause = Math.min(CLAIM_PAUSE_MS, deadline - monoNow());
      if (pause > 0) await sleep(pause, signal).catch(() => void 0);
    }
  }
  async renew(claimId, runToken, body, signal) {
    const answer = await this.send("renew", this.renewAgent, claimPath(claimId, "renew"), runToken, body, ANSWER_MAX_BYTES, signal);
    return reduceRefusal(answer);
  }
  async events(claimId, eventsToken, body, signal) {
    const answer = await this.send("events", this.eventsAgent, claimPath(claimId, "events"), eventsToken, JSON.stringify(body), ANSWER_MAX_BYTES, signal);
    const json = answer.json;
    if (isObj2(json) && json.ok === true && answer.status < 300) {
      if ("refused" in json || "reason" in json || typeof json.replay !== "boolean") throw new ControlHttpError("events", "malformed", answer.status);
      return { ok: true, replay: json.replay };
    }
    if (isObj2(json) && json.ok === false) return { ok: false, reason: typeof json.reason === "string" && EVENT_REASONS.has(json.reason) ? json.reason : "unknown" };
    return reduceRefusal(answer);
  }
  /** Closes the kept-alive sockets. */
  close() {
    this.renewAgent.destroy();
    this.eventsAgent.destroy();
    this.oidcAgent.destroy();
  }
  /** The job's OIDC token for `peeps-load`. GitHub's 5xx is retried, bounded by `window`. */
  async mint(window, caller) {
    const url = new URL(this.oidcUrl);
    url.searchParams.set("audience", LOAD_OIDC_AUDIENCE);
    const path4 = url.pathname + url.search;
    for (let attempt = 1; ; attempt++) {
      try {
        const answer = await this.send("oidc", this.oidcAgent, path4, this.requestToken, void 0, OIDC_ANSWER_MAX_BYTES, window, url);
        if (answer.status !== 200) throw new ControlHttpError("oidc", "status", answer.status);
        const value = isObj2(answer.json) ? answer.json.value : void 0;
        if (typeof value !== "string" || value.length > OIDC_TOKEN_MAX_CHARS || !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(value)) throw new ControlHttpError("oidc", "malformed");
        return value;
      } catch (error) {
        if (caller.aborted) throw new ControlHttpError("claim", "aborted");
        if (!(error instanceof ControlHttpError) || !error.transient || attempt >= OIDC_ATTEMPTS || window.aborted) throw error;
      }
      await sleep(200 * attempt, window).catch(() => void 0);
    }
  }
  send(op, agent, path4, bearer, body, cap, signal, target = this.origin) {
    return new Promise((resolve, reject) => {
      if (signal.aborted) return reject(abortError(op, signal));
      let settled = false;
      const headers = { accept: "application/json", authorization: `Bearer ${bearer}`, "user-agent": this.userAgent };
      if (body !== void 0) {
        headers["content-type"] = "application/json";
        headers["content-length"] = String(Buffer.byteLength(body));
      }
      try {
        for (const [name2, value] of Object.entries(headers)) (0, import_node_http.validateHeaderValue)(name2, value);
      } catch {
        return reject(new ControlHttpError(op, "malformed"));
      }
      const options = {
        agent,
        protocol: "https:",
        hostname: target.hostname,
        port: target.port || 443,
        servername: target.hostname,
        path: path4,
        method: body === void 0 ? "GET" : "POST",
        rejectUnauthorized: true,
        ...this.lookup ? { lookup: this.lookup } : {}
      };
      const req = (0, import_node_https.request)(options);
      const finish = (error, answer) => {
        if (settled) return;
        settled = true;
        signal.removeEventListener("abort", onAbort);
        if (error) {
          req.destroy();
          reject(error);
        } else resolve(answer);
      };
      const onAbort = () => finish(abortError(op, signal));
      signal.addEventListener("abort", onAbort, { once: true });
      req.on("error", (e) => finish(new ControlHttpError(op, "network", void 0, errnoCode(e))));
      req.on("response", (res) => {
        const status = res.statusCode ?? 0;
        if (status >= 300 && status < 400) return finish(new ControlHttpError(op, "redirect", status));
        if (status >= 500 || status === 408 || status === 429) return finish(new ControlHttpError(op, "status", status));
        if (status < 200) return finish(new ControlHttpError(op, "status", status));
        if (!/^application\/json\s*(;|$)/i.test(String(res.headers["content-type"] ?? ""))) return finish(new ControlHttpError(op, "content_type", status));
        const declared = Number(res.headers["content-length"]);
        if (Number.isFinite(declared) && declared > cap) return finish(new ControlHttpError(op, "too_large", status));
        const chunks = [];
        let size = 0;
        res.on("data", (chunk) => {
          size += chunk.length;
          if (size > cap) return finish(new ControlHttpError(op, "too_large", status));
          chunks.push(chunk);
        });
        res.on("error", (e) => finish(new ControlHttpError(op, "network", status, errnoCode(e))));
        res.on("close", () => {
          if (!res.complete) finish(new ControlHttpError(op, "network", status, "ECONNRESET"));
        });
        res.on("end", () => {
          let json;
          try {
            json = JSON.parse(Buffer.concat(chunks).toString("utf8"));
          } catch {
            return finish(new ControlHttpError(op, "malformed", status));
          }
          finish(void 0, { status, json });
        });
      });
      for (const [name2, value] of Object.entries(headers)) req.setHeader(name2, value);
      req.end(body);
    });
  }
};
function diagnosticsOn() {
  if (["http", "https", "net", "stream", "tls"].some((section) => (0, import_node_util.debuglog)(section).enabled)) return true;
  const nodeOptions = (process.env.NODE_OPTIONS ?? "").replace(/["\\]/g, "");
  return [nodeOptions, ...process.execArgv].some((arg) => /--tls[-_]keylog\b/.test(arg));
}
function claimPath(claimId, op) {
  try {
    return `/api/v1/load/claims/${encodeURIComponent(claimId)}/${op}`;
  } catch {
    throw new ControlHttpError(op, "malformed");
  }
}
function peepsOrigin(raw) {
  let url;
  try {
    url = new URL(raw);
  } catch {
    throw new ControlHttpError("config", "url", void 0, "PEEPS_URL");
  }
  if (url.protocol !== "https:" || url.username || url.password || url.pathname !== "/" && url.pathname !== "" || url.search || url.hash) throw new ControlHttpError("config", "url", void 0, "PEEPS_URL");
  return url;
}
function oidcRequestUrl(raw, hosts) {
  let url;
  try {
    url = new URL(raw);
  } catch {
    throw new ControlHttpError("config", "url", void 0, "ACTIONS_ID_TOKEN_REQUEST_URL");
  }
  const host = url.hostname.toLowerCase();
  const allowed = hosts.some((h) => h.startsWith(".") ? url.port === "" && host.endsWith(h) && host.length > h.length : url.host.toLowerCase() === h);
  if (url.protocol !== "https:" || url.username || url.password || url.hash || !allowed) throw new ControlHttpError("config", "url", void 0, "ACTIONS_ID_TOKEN_REQUEST_URL");
  return url;
}
var isObj2 = (v2) => typeof v2 === "object" && v2 !== null && !Array.isArray(v2);
function reduceRefusal(answer) {
  const json = answer.json;
  if (isObj2(json) && "refused" in json) return { refused: typeof json.refused === "string" && REFUSALS.has(json.refused) ? json.refused : "unknown" };
  return answer.status < 300 ? json : { refused: "unknown" };
}
function errnoCode(e) {
  return typeof e.code === "string" && /^[A-Z][A-Z0-9_]{1,63}$/.test(e.code) ? e.code : void 0;
}
var domExceptionName = Object.getOwnPropertyDescriptor(DOMException.prototype, "name").get;
function abortError(op, signal) {
  try {
    if (domExceptionName.call(signal.reason) === "TimeoutError") return new ControlHttpError(op, "timeout");
  } catch {
  }
  return new ControlHttpError(op, "aborted");
}
function sleep(ms2, signal) {
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(signal.reason);
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal.reason);
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms2);
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

// src/load/signals.ts
function loadSignals(proc = process) {
  const soft = new AbortController();
  const hard = new AbortController();
  const received = [];
  const onInt = () => {
    received.push("SIGINT");
    soft.abort();
  };
  const onTerm = () => {
    received.push("SIGTERM");
    soft.abort();
    hard.abort();
  };
  proc.on("SIGINT", onInt);
  proc.on("SIGTERM", onTerm);
  return {
    signal: soft.signal,
    hard: hard.signal,
    received,
    dispose: () => {
      proc.off("SIGINT", onInt);
      proc.off("SIGTERM", onTerm);
    }
  };
}

// src/load/supervisor.ts
var import_node_crypto8 = require("node:crypto");
var import_node_fs3 = require("node:fs");
var import_node_perf_hooks = require("node:perf_hooks");
var import_node_os4 = __toESM(require("node:os"));
var import_node_path2 = __toESM(require("node:path"));

// src/load/accounting.ts
var DENY_REASONS = [
  "stopped",
  "run_end",
  "lease",
  "turn_closed",
  "turn_deadline",
  "origin",
  "method",
  "total",
  "phase_total",
  "origin_total",
  "turn_total",
  "ceiling",
  "outstanding",
  "users",
  "rate",
  "credential",
  "form",
  "header",
  "host",
  "sni",
  "path",
  "not_allowed",
  "expect",
  "upgrade",
  "pipelined",
  "too_large",
  "memory",
  "dials",
  "tunnels",
  "setup_timeout"
];
var CUT_REASONS = [
  "dial",
  "dial_timeout",
  "turn_closed",
  "stopped",
  "revoked",
  "pin",
  "lease",
  "rate",
  "run_end",
  "turn_deadline",
  "write",
  "upstream",
  "exchange_timeout",
  "response_too_large"
];
function zeroCounts() {
  return {
    debited: 0,
    attempted: 0,
    accepted: 0,
    responded: 0,
    received: 0,
    denied: Object.fromEntries(DENY_REASONS.map((r) => [r, 0])),
    cut: Object.fromEntries(CUT_REASONS.map((r) => [r, 0]))
  };
}
var COUNTERS = ["debited", "attempted", "accepted", "responded", "received"];
function requestDelta(prev, next) {
  const out = zeroCounts();
  for (const k of COUNTERS) {
    const d = next[k] - prev[k];
    if (d < 0) throw new Error(`accounting: ${k} ran back`);
    out[k] = d;
  }
  for (const kind of ["denied", "cut"]) {
    for (const [reason, n] of Object.entries(next[kind])) {
      const d = n - (prev[kind][reason] ?? 0);
      if (d < 0) throw new Error(`accounting: ${kind} ${reason} ran back`);
      out[kind][reason] = (out[kind][reason] ?? 0) + d;
    }
  }
  return out;
}
function addCounts(into, c) {
  for (const k of COUNTERS) into[k] += c[k];
  for (const kind of ["denied", "cut"]) for (const [r, n] of Object.entries(c[kind])) into[kind][r] = (into[kind][r] ?? 0) + n;
}
var emptyCounters = () => ({ due: 0, started: 0, missed: 0, success: 0, failure: 0, timeout: 0, interrupted: 0 });
var Accounting = class {
  constructor(intervalMs = 1e4) {
    this.intervalMs = intervalMs;
  }
  starts = /* @__PURE__ */ new Map();
  counters = /* @__PURE__ */ new Map();
  requestCounts = /* @__PURE__ */ new Map();
  cohorts = /* @__PURE__ */ new Map();
  sealed = /* @__PURE__ */ new Set();
  nextToClose = 0;
  /** Every outcome recorded, once each: the run's totals. */
  totals = { success: 0, failure: 0, timeout: 0, interrupted: 0 };
  intervalOf(atMs) {
    return Math.floor(atMs / this.intervalMs);
  }
  bump(atMs, key) {
    const interval = Math.max(this.intervalOf(atMs), this.nextToClose);
    const counters = this.counters.get(interval) ?? emptyCounters();
    counters[key] += 1;
    this.counters.set(interval, counters);
  }
  /** Requests counted at `atMs` (a journal delta), in the interval holding it or the oldest still open. */
  requests(atMs, delta) {
    const interval = Math.max(this.intervalOf(atMs), this.nextToClose);
    const counts = this.requestCounts.get(interval) ?? zeroCounts();
    addCounts(counts, delta);
    this.requestCounts.set(interval, counts);
  }
  due(atMs) {
    this.bump(atMs, "due");
  }
  missed(atMs) {
    this.bump(atMs, "missed");
  }
  start(id, atMs, stage, deadlineMs) {
    if (this.starts.has(id)) throw new Error(`start ${id} recorded twice`);
    const interval = this.intervalOf(atMs);
    this.starts.set(id, { atMs, deadlineMs, interval, stage, outcome: null, outcomeAtMs: null });
    const key = `${interval}/${stage}`;
    if (!this.sealed.has(key)) {
      const cohort = this.cohorts.get(key) ?? { interval, stage, starts: 0, success: 0, failure: 0, timeout: 0, interrupted: 0, lastDeadlineMs: deadlineMs };
      cohort.starts += 1;
      cohort.lastDeadlineMs = Math.max(cohort.lastDeadlineMs, deadlineMs);
      this.cohorts.set(key, cohort);
    }
    this.bump(atMs, "started");
  }
  /** Records the start's one outcome; false when it had one already or is unknown. */
  outcome(id, kind, atMs) {
    return this.record(id, kind, atMs) !== null;
  }
  /** Records the start's one outcome and returns it as counted (late is a timeout); null when
   * it had one already or is unknown. */
  record(id, kind, atMs) {
    const start = this.starts.get(id);
    if (!start || start.outcome) return null;
    const late = atMs >= start.deadlineMs;
    const final = late && kind !== "interrupted" ? "timeout" : kind;
    start.outcome = final;
    start.outcomeAtMs = final === "timeout" ? start.deadlineMs : atMs;
    this.bump(start.outcomeAtMs, final);
    this.totals[final] += 1;
    const cohort = this.cohorts.get(`${start.interval}/${start.stage}`);
    if (cohort) cohort[final] += 1;
    return final;
  }
  /** Starts with no outcome whose deadline has passed: they are timeouts now. */
  expire(nowMs) {
    const expired = [];
    for (const [id, start] of this.starts) {
      if (!start.outcome && nowMs >= start.deadlineMs) {
        this.record(id, "timeout", start.deadlineMs);
        expired.push(id);
      }
    }
    return expired;
  }
  /** Every interval that has fully elapsed by `nowMs` and was not published yet, in order. */
  closeIntervals(nowMs) {
    const out = [];
    while ((this.nextToClose + 1) * this.intervalMs <= nowMs) out.push(this.close(this.nextToClose++));
    this.prune();
    return out;
  }
  close(interval) {
    const untilMs = (interval + 1) * this.intervalMs;
    let inFlight = 0;
    let oldest = null;
    for (const start of this.starts.values()) {
      if (start.atMs < untilMs && (start.outcomeAtMs === null || start.outcomeAtMs >= untilMs)) {
        inFlight += 1;
        oldest = Math.max(oldest ?? 0, untilMs - start.atMs);
      }
    }
    const counters = this.counters.get(interval) ?? emptyCounters();
    this.counters.delete(interval);
    const requests = this.requestCounts.get(interval) ?? zeroCounts();
    this.requestCounts.delete(interval);
    return { interval, fromMs: interval * this.intervalMs, untilMs, ...counters, inFlight, oldestInFlightMs: oldest, requests };
  }
  /** Cohorts that can seal by `nowMs`: every start resolved, or past its deadline plus grace. */
  sealCohorts(nowMs, graceMs, force = false) {
    const out = [];
    for (const [key, c] of this.cohorts) {
      const intervalOver = (c.interval + 1) * this.intervalMs <= nowMs;
      const settled = c.success + c.failure + c.timeout + c.interrupted;
      const resolved = settled === c.starts;
      if (!force && !(intervalOver && (resolved || nowMs >= c.lastDeadlineMs + graceMs))) continue;
      this.sealed.add(key);
      this.cohorts.delete(key);
      out.push({
        interval: c.interval,
        stage: c.stage,
        starts: c.starts,
        success: c.success,
        failure: c.failure,
        timeout: c.timeout,
        interrupted: c.interrupted,
        unresolved: c.starts - settled
      });
    }
    this.prune();
    return out.sort((a, b) => a.interval - b.interval || a.stage - b.stage);
  }
  /** Lets go of starts no published record can still need. */
  prune() {
    const publishedUntil = this.nextToClose * this.intervalMs;
    for (const [id, s] of this.starts) {
      if (s.outcomeAtMs !== null && s.outcomeAtMs < publishedUntil && this.sealed.has(`${s.interval}/${s.stage}`)) this.starts.delete(id);
    }
  }
  /** How many starts are still held (in flight, or not yet published and sealed). */
  retained() {
    return this.starts.size;
  }
  /** Starts with no outcome yet. */
  unresolved() {
    return [...this.starts].filter(([, s]) => !s.outcome).map(([id]) => id);
  }
};

// src/load/clocks.ts
function sharedClocks() {
  return { monoMs: Number(process.hrtime.bigint()) / 1e6, wallMs: Date.now() };
}

// src/load/claim-body.ts
var import_node_child_process = require("node:child_process");
var import_node_os = __toESM(require("node:os"));
var MAX_FAILURES = 20;
var MAX_FAILURE = 256;
var MAX_LABEL = 128;
function claimBody(i) {
  const b = i.binding;
  const body = {
    protocol: WIRE_PROTOCOL,
    actionVersion: i.actionVersion,
    grantRef: i.grantRef,
    idempotencyKey: i.idempotencyKey,
    checkoutSha: b.checkoutSha,
    workload: { path: b.workload.path, digest: b.workload.digest },
    lockDigests: { "package-lock.json": b.lockDigests["package-lock.json"] },
    observed: { treeDigest: b.observed.treeDigest, generatedLockDigest: b.observed.generatedLockDigest },
    runAttempt: i.runAttempt,
    checkRunId: i.checkRunId,
    fence: {
      kind: "netns",
      probe: {
        passed: i.probe.passed,
        failures: i.probe.failures.slice(0, MAX_FAILURES).map((f) => clip(f, MAX_FAILURE)),
        image: clip(i.labels.image, MAX_LABEL),
        kernel: clip(i.labels.kernel, MAX_LABEL),
        tools: clip(i.labels.tools, MAX_LABEL),
        chrony: clip(i.labels.chrony, MAX_LABEL)
      }
    }
  };
  const problem = claimBodyProblem(canonical(body));
  return problem === void 0 ? { ok: true, body } : { ok: false, problem };
}
function clip(text2, max) {
  if (text2.length <= max) return text2;
  let out = "";
  for (const ch of text2) {
    if (out.length + ch.length > max) break;
    out += ch;
  }
  return out;
}
var SHA256_HEX = /^[0-9a-f]{64}$/;
var COMMIT2 = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/;
var GRANT_REF = /^[A-Za-z0-9_-]{22}$/;
var UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
var utf8 = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
var isObj3 = (v2) => typeof v2 === "object" && v2 !== null && !Array.isArray(v2);
var whole2 = (v2, min = 0) => typeof v2 === "number" && Number.isSafeInteger(v2) && v2 >= min;
var str = (v2, min, max) => typeof v2 === "string" && v2.length >= min && v2.length <= max;
var match = (v2, re) => typeof v2 === "string" && re.test(v2);
function exactly(v2, at, keys) {
  if (!isObj3(v2)) return at;
  for (const k of Object.keys(v2)) if (!keys.includes(k)) return `${at}.${k}`;
  for (const k of keys) if (!Object.hasOwn(v2, k)) return `${at}.${k}`;
  return void 0;
}
function claimBodyProblem(body) {
  const bytes = typeof body === "string" ? new TextEncoder().encode(body) : body;
  if (bytes.byteLength > CLAIM_BODY_MAX_BYTES) return "size";
  let raw;
  try {
    raw = JSON.parse(utf8.decode(bytes));
  } catch {
    return "json";
  }
  if (isObj3(raw) && typeof raw.protocol === "number" && raw.protocol !== WIRE_PROTOCOL) return "unsupported_protocol";
  const top = exactly(raw, "body", ["protocol", "actionVersion", "grantRef", "idempotencyKey", "checkoutSha", "workload", "lockDigests", "observed", "runAttempt", "checkRunId", "fence"]);
  if (top) return top;
  const r = raw;
  if (r.protocol !== WIRE_PROTOCOL) return "protocol";
  if (!str(r.actionVersion, 1, 64)) return "actionVersion";
  if (!match(r.grantRef, GRANT_REF)) return "grantRef";
  if (!match(r.idempotencyKey, UUID_V4)) return "idempotencyKey";
  if (!match(r.checkoutSha, COMMIT2)) return "checkoutSha";
  const w = exactly(r.workload, "workload", ["path", "digest"]);
  if (w) return w;
  if (!str(r.workload.path, 1, 1024)) return "workload.path";
  if (!match(r.workload.digest, SHA256_HEX)) return "workload.digest";
  const l = exactly(r.lockDigests, "lockDigests", ["package-lock.json"]);
  if (l) return l;
  if (!match(r.lockDigests["package-lock.json"], SHA256_HEX)) return "lockDigests.package-lock.json";
  const o = exactly(r.observed, "observed", ["treeDigest", "generatedLockDigest"]);
  if (o) return o;
  if (!match(r.observed.treeDigest, SHA256_HEX)) return "observed.treeDigest";
  if (!match(r.observed.generatedLockDigest, SHA256_HEX)) return "observed.generatedLockDigest";
  if (!whole2(r.runAttempt, 1)) return "runAttempt";
  if (!whole2(r.checkRunId)) return "checkRunId";
  const f = exactly(r.fence, "fence", ["kind", "probe"]);
  if (f) return f;
  const fence = r.fence;
  if (fence.kind !== "netns") return "fence.kind";
  const p = exactly(fence.probe, "fence.probe", ["passed", "failures", "image", "kernel", "tools", "chrony"]);
  if (p) return p;
  const probe2 = fence.probe;
  if (typeof probe2.passed !== "boolean") return "fence.probe.passed";
  if (!Array.isArray(probe2.failures) || probe2.failures.length > MAX_FAILURES || !probe2.failures.every((x) => str(x, 0, MAX_FAILURE))) return "fence.probe.failures";
  for (const k of ["image", "kernel", "tools", "chrony"]) if (!str(probe2[k], 0, MAX_LABEL)) return `fence.probe.${k}`;
  return void 0;
}
var runHostTool = (file, args) => new Promise((resolve) => {
  (0, import_node_child_process.execFile)(file, args, { env: { PATH: "/usr/sbin:/usr/bin:/sbin:/bin", LC_ALL: "C" }, timeout: 2e3, maxBuffer: 16 * 1024, killSignal: "SIGKILL" }, (error, stdout) => resolve(error ? void 0 : String(stdout)));
});
var printable = (text2) => text2.replace(/[\u0000-\u001f\u007f-\u009f]/g, " ").trim();
var firstLine = (out) => out === void 0 ? "unavailable" : printable(out.split("\n")[0] ?? "") || "unavailable";
async function hostLabels(env = process.env, run = runHostTool) {
  const [systemd, unshare, tracking] = await Promise.all([
    run("/usr/bin/systemd-run", ["--version"]),
    run("/usr/bin/unshare", ["--version"]),
    run("/usr/bin/chronyc", ["-n", "tracking"])
  ]);
  const field = (name2) => tracking?.split("\n").find((l) => l.startsWith(name2))?.split(":").slice(1).join(":").trim();
  const leap = field("Leap status");
  const offset = field("System time");
  return {
    image: env.ImageOS && env.ImageVersion ? printable(`${env.ImageOS} ${env.ImageVersion}`) : "unknown",
    kernel: printable(import_node_os.default.release()) || "unknown",
    tools: `${firstLine(systemd)}; ${firstLine(unshare)}`,
    chrony: leap ? printable(`${leap.toLowerCase()}${offset ? `, ${offset}` : ""}`) : "unavailable"
  };
}

// src/load/gate/ca.ts
var import_node_crypto3 = require("node:crypto");

// src/load/gate/der.ts
function tlv(tag, content) {
  return Buffer.concat([Buffer.from([tag]), length(content.length), content]);
}
function length(n) {
  if (n < 128) return Buffer.from([n]);
  const bytes = [];
  for (let v2 = n; v2 > 0; v2 = Math.floor(v2 / 256)) bytes.unshift(v2 % 256);
  return Buffer.from([128 | bytes.length, ...bytes]);
}
var seq = (...items) => tlv(48, Buffer.concat(items));
var set = (...items) => tlv(49, Buffer.concat(items));
var octets = (b) => tlv(4, b);
var bool = (v2) => tlv(1, Buffer.from([v2 ? 255 : 0]));
var utf82 = (s) => tlv(12, Buffer.from(s, "utf8"));
var explicit = (n, content) => tlv(160 | n, content);
var implicit = (n, content) => tlv(128 | n, content);
var implicitSeq = (n, ...items) => tlv(160 | n, Buffer.concat(items));
function integer(v2) {
  let b = typeof v2 === "number" ? bigEndian(v2) : Buffer.from(v2);
  while (b.length > 1 && b[0] === 0 && b[1] < 128) b = b.subarray(1);
  if (b[0] >= 128) b = Buffer.concat([Buffer.from([0]), b]);
  return tlv(2, b);
}
function bigEndian(n) {
  if (!Number.isSafeInteger(n) || n < 0) throw new Error("der: integer must be a whole number \u2265 0");
  const bytes = [];
  for (let v2 = n; v2 > 0; v2 = Math.floor(v2 / 256)) bytes.unshift(v2 % 256);
  return Buffer.from(bytes.length ? bytes : [0]);
}
function oid(dotted) {
  const parts = dotted.split(".").map(Number);
  const out = [40 * parts[0] + parts[1]];
  for (const p of parts.slice(2)) {
    const chunk = [p & 127];
    for (let v2 = Math.floor(p / 128); v2 > 0; v2 = Math.floor(v2 / 128)) chunk.unshift(128 | v2 & 127);
    out.push(...chunk);
  }
  return tlv(6, Buffer.from(out));
}
var bits = (b, unused = 0) => tlv(3, Buffer.concat([Buffer.from([unused]), b]));
function time(ms2) {
  const d = new Date(Math.floor(ms2 / 1e3) * 1e3);
  const y = d.getUTCFullYear();
  const rest = [d.getUTCMonth() + 1, d.getUTCDate(), d.getUTCHours(), d.getUTCMinutes(), d.getUTCSeconds()].map((n) => String(n).padStart(2, "0")).join("");
  return y < 2050 ? tlv(23, Buffer.from(`${String(y % 100).padStart(2, "0")}${rest}Z`)) : tlv(24, Buffer.from(`${y}${rest}Z`));
}

// src/load/gate/ca.ts
var OID = {
  ecdsaSha256: "1.2.840.10045.4.3.2",
  commonName: "2.5.4.3",
  subjectKeyId: "2.5.29.14",
  keyUsage: "2.5.29.15",
  subjectAltName: "2.5.29.17",
  basicConstraints: "2.5.29.19",
  nameConstraints: "2.5.29.30",
  authorityKeyId: "2.5.29.35",
  extKeyUsage: "2.5.29.37",
  serverAuth: "1.3.6.1.5.5.7.3.1"
};
var HOST = /^(?=.{1,253}$)(?!-)[a-z0-9-]{1,63}(?<!-)(\.(?!-)[a-z0-9-]{1,63}(?<!-))+$/;
function isApprovedHostName(host) {
  return HOST.test(host) && !/^[0-9.]+$/.test(host);
}
var BACKDATE_MS = 60 * 60 * 1e3;
function createRunCa(options) {
  const hosts = [...new Set(options.hosts)];
  if (hosts.length === 0) throw new Error("ca: at least one approved host is required");
  for (const h of hosts) if (!isApprovedHostName(h)) throw new Error(`ca: not an approved host name: ${JSON.stringify(h)}`);
  const notBefore = options.nowMs - BACKDATE_MS;
  const notAfter = options.nowMs + options.validForMs;
  if (!Number.isFinite(options.nowMs) || !(options.validForMs > 0) || !representable(notBefore) || !representable(notAfter)) throw new Error("ca: nowMs and validForMs must give a representable validity, validForMs > 0");
  const ca = buildCa(hosts, notBefore, notAfter);
  const leaves = new Map(hosts.map((host) => [host, issueLeaf({ host, issuer: ca.name, issuerKeyId: ca.keyId, signer: ca.key, notBefore, notAfter })]));
  return { certPem: ca.certPem, leaf: (host) => leaves.get(host) };
}
function representable(ms2) {
  return Number.isFinite(ms2) && ms2 >= Date.UTC(1950, 0, 1) && ms2 < Date.UTC(1e4, 0, 1);
}
function buildCa(hosts, notBefore, notAfter) {
  const ca = (0, import_node_crypto3.generateKeyPairSync)("ec", { namedCurve: "P-256" });
  const caSpki = ca.publicKey.export({ type: "spki", format: "der" });
  const caKeyId = keyId(caSpki);
  const caName = name("Peeps load run CA");
  const caDer = certificate({
    issuer: caName,
    subject: caName,
    notBefore,
    notAfter,
    spki: caSpki,
    signer: ca.privateKey,
    extensions: [
      extension(OID.basicConstraints, true, seq(bool(true), integer(0))),
      extension(OID.keyUsage, true, bits(Buffer.from([6]), 1)),
      // keyCertSign, cRLSign
      extension(OID.nameConstraints, true, nameConstraints(hosts)),
      extension(OID.subjectKeyId, false, octets(caKeyId))
    ]
  });
  return { certPem: pem(caDer), name: caName, keyId: caKeyId, key: ca.privateKey };
}
function issueLeaf(o) {
  const pair = (0, import_node_crypto3.generateKeyPairSync)("ec", { namedCurve: "P-256" });
  const spki = pair.publicKey.export({ type: "spki", format: "der" });
  const der = certificate({
    issuer: o.issuer,
    subject: seq(),
    notBefore: o.notBefore,
    notAfter: o.notAfter,
    spki,
    signer: o.signer,
    extensions: [
      extension(OID.basicConstraints, true, seq()),
      extension(OID.keyUsage, true, bits(Buffer.from([128]), 7)),
      // digitalSignature
      extension(OID.extKeyUsage, false, seq(oid(OID.serverAuth))),
      extension(OID.subjectAltName, true, seq(implicit(2, Buffer.from(o.host, "ascii")))),
      extension(OID.subjectKeyId, false, octets(keyId(spki))),
      extension(OID.authorityKeyId, false, seq(implicit(0, o.issuerKeyId)))
    ]
  });
  return { certPem: pem(der), key: pair.privateKey };
}
function name(commonName) {
  return seq(set(seq(oid(OID.commonName), utf82(commonName))));
}
function keyId(spki) {
  return (0, import_node_crypto3.createHash)("sha1").update(spki).digest();
}
function nameConstraints(hosts) {
  const permitted = hosts.map((h) => seq(implicit(2, Buffer.from(h, "ascii"))));
  const excluded = [seq(implicit(7, Buffer.alloc(8))), seq(implicit(7, Buffer.alloc(32)))];
  return seq(implicitSeq(0, ...permitted), implicitSeq(1, ...excluded));
}
function extension(id, critical, value) {
  return critical ? seq(oid(id), bool(true), octets(value)) : seq(oid(id), octets(value));
}
function certificate(o) {
  const algorithm = seq(oid(OID.ecdsaSha256));
  const serial = (0, import_node_crypto3.randomBytes)(16);
  serial[0] = serial[0] & 127 | 1;
  const tbs = seq(
    explicit(0, integer(2)),
    integer(serial),
    algorithm,
    o.issuer,
    seq(time(o.notBefore), time(o.notAfter)),
    o.subject,
    o.spki,
    explicit(3, seq(...o.extensions))
  );
  const signature = (0, import_node_crypto3.sign)("sha256", tbs, { key: o.signer, dsaEncoding: "der" });
  return seq(tbs, algorithm, bits(signature));
}
function pem(der) {
  const body = der.toString("base64").match(/.{1,64}/g).join("\n");
  return `-----BEGIN CERTIFICATE-----
${body}
-----END CERTIFICATE-----
`;
}

// src/load/gate/normalize.ts
function namesMethodOverride(body) {
  const char = (_m, hex) => String.fromCharCode(parseInt(hex, 16));
  const decoded = body.replace(/%([0-9a-f]{2})/gi, char).replace(/\\u([0-9a-f]{4})/gi, char).replaceAll("\\", "");
  return /(?:_|(?<![a-z0-9])\.)method/i.test(decoded);
}
var phpName = (name2) => name2.replace(/^ +/, "").split("[")[0].replace(/[ .]/g, "_");
var MAX_BODY_BYTES = 1024 * 1024;
var MAX_TARGET_BYTES = 2048;
var MAX_HEADERS = 100;
var READ_METHODS = /* @__PURE__ */ new Set(["GET", "HEAD", "OPTIONS"]);
var WRITE_METHODS = /* @__PURE__ */ new Set(["POST", "PUT", "PATCH", "DELETE"]);
var PASSED_HEADERS = /* @__PURE__ */ new Set([
  "accept",
  "accept-encoding",
  "accept-language",
  "authorization",
  "cache-control",
  "content-type",
  "cookie",
  "if-match",
  "if-modified-since",
  "if-none-match",
  "if-unmodified-since",
  "origin",
  "pragma",
  "range",
  "referer",
  "user-agent",
  "x-requested-with"
]);
var REFUSED_HEADERS = /* @__PURE__ */ new Set(["transfer-encoding", "te", "trailer", "upgrade", "expect", "http2-settings"]);
var OVERRIDE_HEADERS = /^(x-http-method(-override)?|x-method-override|x-original-(url|uri|method)|x-rewrite-url|x-forwarded(-.*)?|forwarded|x-real-ip|via)$/;
var GATE_HEADERS = /* @__PURE__ */ new Set(["host", "content-length", "connection", "keep-alive", "proxy-connection", "proxy-authorization"]);
function validatePolicy(policy) {
  for (const raw of policy.headers ?? []) {
    const h = raw.toLowerCase();
    const folded = h.replaceAll("_", "-");
    if (!/^[a-z0-9-]+$/.test(h) || REFUSED_HEADERS.has(folded) || GATE_HEADERS.has(folded) || OVERRIDE_HEADERS.test(folded)) {
      throw new Error(`load gate: the policy may not name the header ${JSON.stringify(raw)}`);
    }
  }
  for (const r of policy.allowedRequests) if (!unambiguousPath(r.path)) throw new Error(`load gate: ambiguous allowed path ${JSON.stringify(r.path)}`);
}
function canonicalOrigin(host, port) {
  return port === 443 ? `https://${host}` : `https://${host}:${port}`;
}
function parseAuthority(target) {
  const m = /^([a-z0-9.-]+):([1-9][0-9]{0,4})$/.exec(target);
  if (!m) return void 0;
  const host = m[1];
  const port = Number(m[2]);
  if (port > 65535 || !isApprovedHostName(host)) return void 0;
  return { host, port, origin: canonicalOrigin(host, port) };
}
var refuse = (reason, status = 400) => ({ ok: false, reason, status });
function normalize(req, tunnel, policy) {
  const { authority } = tunnel;
  if (tunnel.servername !== authority.host) return refuse("sni", 421);
  if (!policy.allowedOrigins.includes(authority.origin)) return refuse("origin", 403);
  if (req.httpVersion !== "1.1") return refuse("version", 505);
  if (!READ_METHODS.has(req.method) && !WRITE_METHODS.has(req.method)) return refuse("method", 405);
  if (req.target.length > MAX_TARGET_BYTES) return refuse("too_long", 414);
  if (!req.target.startsWith("/")) return refuse("form");
  if (req.rawHeaders.length > 2 * MAX_HEADERS) return refuse("header", 431);
  const q = req.target.indexOf("?");
  const path4 = q < 0 ? req.target : req.target.slice(0, q);
  if (!unambiguousPath(path4) || !/^[\x21-\x7e]*$/.test(req.target) || req.target.includes("#")) return refuse("path");
  const extra = new Set((policy.headers ?? []).map((h) => h.toLowerCase()).filter((h) => !OVERRIDE_HEADERS.test(h.replaceAll("_", "-"))));
  const lines = [];
  let host;
  let length2;
  for (let i = 0; i + 1 < req.rawHeaders.length; i += 2) {
    const name2 = req.rawHeaders[i].toLowerCase();
    const value = req.rawHeaders[i + 1];
    if (/[\r\n\0]/.test(value)) return refuse("header");
    if (REFUSED_HEADERS.has(name2)) return refuse("header");
    if (name2 === "host") {
      if (host !== void 0) return refuse("host");
      host = value;
      continue;
    }
    if (name2 === "content-length") {
      if (length2 !== void 0) return refuse("length");
      length2 = value;
      continue;
    }
    if (GATE_HEADERS.has(name2)) continue;
    if (PASSED_HEADERS.has(name2) || extra.has(name2)) lines.push(`${name2}: ${value}`);
  }
  if (host === void 0 || !hostMatches(host, authority)) return refuse("host", 421);
  if (req.body.length > MAX_BODY_BYTES) return refuse("too_large", 413);
  if (length2 !== void 0 && (!/^(0|[1-9][0-9]*)$/.test(length2) || Number(length2) !== req.body.length)) return refuse("length");
  if (READ_METHODS.has(req.method) && req.body.length > 0) return refuse("length");
  if (!READ_METHODS.has(req.method)) {
    if (!policy.allowedRequests.some((r) => r.method === req.method && r.path === path4)) return refuse("not_allowed", 403);
    if (q >= 0 && [...new URLSearchParams(req.target.slice(q + 1)).keys()].some((k) => phpName(k).toLowerCase() === "_method")) return refuse("not_allowed", 403);
    if (namesMethodOverride(req.body.toString("latin1"))) return refuse("not_allowed", 403);
  }
  const hostLine = authority.port === 443 ? authority.host : `${authority.host}:${authority.port}`;
  const framing = WRITE_METHODS.has(req.method) || req.body.length > 0 ? [`content-length: ${req.body.length}`] : [];
  const head = [`${req.method} ${req.target} HTTP/1.1`, `host: ${hostLine}`, ...lines, ...framing, "connection: close", "", ""].join("\r\n");
  return { ok: true, method: req.method, path: path4, origin: authority.origin, head, body: req.body };
}
function hostMatches(value, a) {
  const v2 = value.toLowerCase();
  return v2 === `${a.host}:${a.port}` || a.port === 443 && v2 === a.host;
}
function unambiguousPath(path4) {
  if (!path4.startsWith("/") || path4.includes("\\") || path4.includes(";")) return false;
  if (/%(2f|5c|2e|00)/i.test(path4)) return false;
  if (/%(?![0-9a-f]{2})/i.test(path4)) return false;
  const segments = path4.slice(1).split("/");
  return segments.every((s, i) => (s !== "" || i === segments.length - 1) && s !== "." && s !== "..") && !(path4.length > 1 && path4.endsWith("//"));
}

// src/load/engine-limits.ts
var ENGINE_LIMITS = {
  /** Checking proves the journey with at most 5 users (§10.3). */
  checkingMaxUsers: 5,
  /** Checking and rehearsal budget: 10,000 requests a day per environment (§10.3). */
  checkingDailyRequests: 1e4,
  /** How long Checking may take before the run "didn't start". */
  checkingDeadlineMs: 12e4,
  /** The most a single turn (one journey invocation) may take. */
  turnDeadlineMs: 3e4,
  /** Ramp-down and Stop grace (§10.3). */
  stopGraceMs: 3e4,
  /** How long after a due tick a start may still begin. */
  startSlackMs: 1e3,
  /** A sustained request-rate cap per phase, whatever the plan asks. */
  maxRatePerSecond: 200,
  /** The bucket's size: how many requests may go at once after a quiet spell (never more
   * than every user's whole turn). */
  maxBurst: 50,
  /** The lease (§9.1, 30–60 s). */
  leaseMs: 45e3
};
function rateFor(users, perJourneyMax, pacingEveryMs, constants) {
  const need = Math.ceil(users * perJourneyMax * 1e3 / pacingEveryMs);
  return Math.max(1, Math.min(constants.maxRatePerSecond, need));
}
function engineBudgets(input, constants = ENGINE_LIMITS) {
  const { plan, limits } = input;
  const perJourney = plan.requests.perJourneyMax;
  const pacing = plan.cohort.pacingEveryMs;
  const turnDeadlineMs = Math.min(constants.turnDeadlineMs, constants.checkingDeadlineMs);
  const checkingUsers = Math.min(constants.checkingMaxUsers, plan.peakUsers, limits.maxUsers);
  const checking = {
    users: checkingUsers,
    // One turn per Checking user.
    totalRequests: Math.min(checkingUsers * perJourney, constants.checkingDailyRequests, limits.requestBudget),
    ratePerSecond: rateFor(checkingUsers, perJourney, pacing, constants),
    burst: Math.min(constants.maxBurst, checkingUsers * perJourney),
    concurrency: checkingUsers,
    phaseDeadlineMs: constants.checkingDeadlineMs,
    turnDeadlineMs
  };
  const users = Math.min(plan.peakUsers, limits.maxUsers);
  const measurement = {
    users,
    // The request budget is per run: the supervisor takes Checking's issued permits off this
    // when measurement begins.
    totalRequests: Math.min(plan.requests.ceiling, limits.requestBudget),
    ratePerSecond: rateFor(users, perJourney, pacing, constants),
    burst: Math.min(constants.maxBurst, users * perJourney),
    concurrency: users,
    phaseDeadlineMs: plan.durationMs + constants.stopGraceMs,
    turnDeadlineMs: Math.min(constants.turnDeadlineMs, plan.durationMs + constants.stopGraceMs)
  };
  return {
    checking,
    measurement,
    stopGraceMs: constants.stopGraceMs,
    startSlackMs: Math.min(constants.startSlackMs, pacing),
    leaseMs: constants.leaseMs,
    absoluteEndMs: checking.phaseDeadlineMs + measurement.phaseDeadlineMs
  };
}
var DIALS_PER_TURN = 4;
var OUTSTANDING_PER_TURN = 8;
var MAX_PENDING_DIALS = 256;
function runLimits(input, grant, o) {
  const budgets = engineBudgets({ plan: input.plan, limits: { ...input.limits, maxUsers: Math.min(input.limits.maxUsers, grant.maxUsers), requestBudget: Math.min(input.limits.requestBudget, grant.requestBudget) } }, o.constants);
  const engine = (b) => ({ ratePerSecond: b.ratePerSecond, burst: b.burst, maxUsers: b.users, total: b.totalRequests });
  const lower = (mine, theirs) => {
    const out = { ...mine };
    for (const key of ["ratePerSecond", "burst", "maxUsers", "total"]) {
      const v2 = theirs?.[key];
      if (v2 === void 0) continue;
      const okValue = key === "ratePerSecond" ? Number.isFinite(v2) && v2 > 0 : Number.isSafeInteger(v2) && v2 >= (key === "burst" ? 1 : 0);
      if (!okValue) return `phase ${key} ${String(v2)}`;
      out[key] = Math.min(out[key], v2);
    }
    return out;
  };
  const checking = lower(engine(budgets.checking), grant.phases.checking);
  const measurement = lower(engine(budgets.measurement), grant.phases.measurement);
  if (typeof checking === "string") return { ok: false, reason: "invalid", detail: checking };
  if (typeof measurement === "string") return { ok: false, reason: "invalid", detail: measurement };
  const { plan } = input;
  const runTotal = Math.min(input.limits.requestBudget, grant.requestBudget);
  const reduced = [];
  if (measurement.maxUsers < plan.peakUsers) reduced.push(`users ${measurement.maxUsers} < ${plan.peakUsers}`);
  if (measurement.total < plan.requests.ceiling) reduced.push(`measurement total ${measurement.total} < ${plan.requests.ceiling}`);
  if (measurement.ratePerSecond < budgets.measurement.ratePerSecond) reduced.push(`rate ${measurement.ratePerSecond} < ${budgets.measurement.ratePerSecond}`);
  if (runTotal - checking.total < plan.requests.ceiling) reduced.push(`budget after Checking ${runTotal - checking.total} < ${plan.requests.ceiling}`);
  if (plan.onReduced === "refuse" && reduced.length) return { ok: false, reason: "reduced", detail: reduced.join("; ") };
  const origins = {};
  const approved = /* @__PURE__ */ new Map();
  for (const raw of grant.allowedOrigins) {
    let url;
    try {
      url = new URL(raw);
    } catch {
      return { ok: false, reason: "invalid", detail: `origin ${raw}` };
    }
    if (url.protocol !== "https:") return { ok: false, reason: "origin_unsupported", detail: raw };
    const port = url.port ? Number(url.port) : 443;
    const origin = canonicalOrigin(url.hostname, port);
    origins[origin] = grant.originCaps ? Math.min(runTotal, grant.originCaps[origin] ?? grant.originCaps[raw] ?? 0) : runTotal;
    approved.set(origin, { host: url.hostname, port, privateCidrs: [...grant.privateOrigins[raw] ?? grant.privateOrigins[origin] ?? []] });
  }
  const users = Math.max(checking.maxUsers, measurement.maxUsers);
  return {
    ok: true,
    value: {
      checking,
      measurement,
      gate: {
        origins,
        methods: [.../* @__PURE__ */ new Set(["GET", "HEAD", ...plan.allowedRequests.map((r) => r.method)])],
        maxOutstandingPerTurn: OUTSTANDING_PER_TURN,
        maxRequestsPerTurn: plan.requests.perJourneyMax,
        runTotal,
        turnDeadlineMs: budgets.measurement.turnDeadlineMs
      },
      policy: { allowedOrigins: Object.keys(origins), allowedRequests: plan.allowedRequests.map((r) => ({ ...r })) },
      approved,
      proxy: { maxPendingDialsPerTurn: DIALS_PER_TURN, maxPendingDials: Math.min(users * o.parallel, MAX_PENDING_DIALS) },
      budgets
    }
  };
}

// src/load/gate/admission.ts
var RATE_BOUNDARIES = ["permit", "tcp", "tls", "handoff"];
var MILLI = 1e3;
var Gate = class {
  constructor(limits) {
    this.limits = limits;
    for (const [name2, value] of [["maxOutstandingPerTurn", limits.maxOutstandingPerTurn], ["runTotal", limits.runTotal], ["maxRequestsPerTurn", limits.maxRequestsPerTurn ?? 0], ...Object.entries(limits.origins)]) {
      if (!Number.isSafeInteger(value) || value < 0) throw new Error(`gate: ${name2} must be a whole number \u2265 0`);
    }
    for (const [name2, value] of [["turnDeadlineMs", limits.turnDeadlineMs], ["runEndMono", limits.runEndMono]]) {
      if (!Number.isFinite(value) || value < 0) throw new Error(`gate: ${name2} must be a finite number \u2265 0`);
    }
    if (limits.runEndWall !== void 0 && !Number.isFinite(limits.runEndWall)) throw new Error("gate: runEndWall must be finite");
    checkPhase(limits.phase);
    this.phase = { ...limits.phase };
    const burst = this.phase.burst * MILLI;
    this.milliTokens = { permit: burst, tcp: burst, tls: burst, handoff: burst };
    this.methods = new Set(limits.methods);
  }
  lease = { seq: -1, monoUntil: Number.NEGATIVE_INFINITY, wallUntil: Number.NEGATIVE_INFINITY, ceiling: 0 };
  lastLeaseSeq = -1;
  /** A lease was seen run out on either clock: lost for good, as the runner's lease is. */
  expired = false;
  liveSlots = /* @__PURE__ */ new Map();
  turns = /* @__PURE__ */ new Map();
  /** Admitted, delivery not yet known. */
  undelivered = /* @__PURE__ */ new Set();
  /** Admitted, exchange not yet over: seq → turn. */
  exchanges = /* @__PURE__ */ new Map();
  perOrigin = /* @__PURE__ */ new Map();
  nextTurn = 1;
  seq = 0;
  liveTurns = 0;
  sentCount = 0;
  phaseCount = 0;
  stoppedFlag = false;
  drainingFlag = false;
  drainEnd;
  runCutoff;
  phase;
  // A reservation bounds pending work. Actual traffic is also paced at each boundary,
  // since time spent waiting in a dial can bunch work from different reservations.
  milliTokens;
  lastRefillMono;
  methods;
  permits = /* @__PURE__ */ new WeakSet();
  /** Requests admitted: what counts against the ceiling and totals, and what renewals report. Only grows. */
  get admitted() {
    return this.seq;
  }
  /** Admitted requests known to have sent bytes. */
  get sent() {
    return this.sentCount;
  }
  /** Admitted requests whose delivery is not yet known. */
  get unresolved() {
    return this.undelivered.size;
  }
  /** Admitted requests whose exchange is not over. */
  get inFlight() {
    return this.exchanges.size;
  }
  get stopped() {
    return this.stoppedFlag;
  }
  /** A lease was seen run out on either clock, here: lost for good. */
  get leaseExpired() {
    return this.expired;
  }
  /**
   * Replaces the lease with a newer one. A lower ceiling or an earlier deadline takes effect
   * at once. A grant at or below the last applied seq is ignored, even after a revoke; a
   * malformed one revokes.
   */
  applyLease(lease) {
    if (this.expired) return;
    if (!Number.isSafeInteger(lease.seq)) return this.revokeLease();
    if (!(lease.seq > this.lastLeaseSeq)) return;
    this.lastLeaseSeq = lease.seq;
    if (!Number.isSafeInteger(lease.ceiling) || lease.ceiling < 0 || !Number.isFinite(lease.monoUntil) || !Number.isFinite(lease.wallUntil)) return this.revokeLease();
    this.lease = { ...lease };
  }
  /** Lost contact, a lost lease, or one seen expired: nothing more is admitted until a newer lease applies. */
  revokeLease() {
    this.lease = { ...this.lease, monoUntil: Number.NEGATIVE_INFINITY, wallUntil: Number.NEGATIVE_INFINITY };
  }
  /**
   * Moves to the next phase. The bucket is refilled at the old rate up to `t`, then clamped
   * to the new burst, so a phase change never adds tokens.
   */
  setPhase(caps, t) {
    checkPhase(caps);
    this.refill(t.monoMs);
    this.phase = { ...caps };
    this.refillBuckets(0);
    this.phaseCount = 0;
  }
  /** Draining: existing turns go on until cutoff, and no new turn opens. */
  drain(cutoff) {
    this.drainingFlag = true;
    if (cutoff) this.drainEnd = { ...cutoff };
  }
  /** Irreversible: a hard stop, the run's end, or `close()`. */
  stop() {
    this.stoppedFlag = true;
    for (const turn of this.turns.values()) turn.open = false;
    this.liveSlots.clear();
    this.liveTurns = 0;
  }
  /** Opens a turn for `slot` (one simulated user). A slot has at most one live turn. */
  openTurn(slot, t, deadlineMs = this.limits.turnDeadlineMs) {
    const ms2 = Math.min(deadlineMs, this.limits.turnDeadlineMs);
    if (this.stoppedFlag) return { ok: false, reason: "stopped" };
    if (this.checkRunEnd(t)) return { ok: false, reason: "run_end" };
    if (this.drainingFlag) return { ok: false, reason: "draining" };
    if ([...this.liveSlots.values()].includes(slot)) return { ok: false, reason: "slot_busy" };
    if (!(this.liveTurns < this.phase.maxUsers)) return { ok: false, reason: "users" };
    const turn = this.nextTurn++;
    this.liveSlots.set(turn, slot);
    this.turns.set(turn, {
      deadlineMono: t.monoMs + ms2,
      deadlineWall: t.wallMs + ms2,
      expired: false,
      outstanding: 0,
      admitted: 0,
      open: true
    });
    this.liveTurns += 1;
    return { ok: true, turn };
  }
  /** Revokes the turn: nothing more of it is admitted, and its user slot frees. Its exchanges finish on their own. */
  closeTurn(turn) {
    const state = this.turns.get(turn);
    if (!state) return;
    if (state.open) this.liveTurns -= 1;
    state.open = false;
    this.liveSlots.delete(turn);
    if (state.outstanding === 0) this.turns.delete(turn);
  }
  /**
   * Every check, then the debit: seq, phase, origin and turn totals, the ceiling, the undelivered
   * set and the exchange. Spends the permit's rate token. Nothing of the request has reached its
   * target yet.
   */
  permit(r, t) {
    const d = this.check(r, t);
    if (!("turn" in d)) return d;
    const denied = this.rateDenial(Math.min(...RATE_BOUNDARIES.map((b) => this.milliTokens[b])));
    if (denied) return denied;
    this.milliTokens.permit -= MILLI;
    const turn = d.turn;
    const seq2 = ++this.seq;
    this.phaseCount += 1;
    this.perOrigin.set(r.origin, (this.perOrigin.get(r.origin) ?? 0) + 1);
    this.undelivered.add(seq2);
    this.exchanges.set(seq2, r.turn);
    turn.outstanding += 1;
    turn.admitted += 1;
    const permit = Object.freeze({ seq: seq2, turn: r.turn, origin: r.origin });
    this.permits.add(permit);
    return { ok: true, permit };
  }
  /**
   * At TCP and at TLS start: liveness, and that boundary's rate token spent (into debt if need be). Totals, the ceiling and
   * outstanding are not rechecked: this permit is already counted. With no boundary (before the
   * dial starts), liveness only.
   */
  checkDial(p, t, boundary) {
    return this.recheck(p, t, boundary);
  }
  /** Immediately before the write, on a fresh sample: liveness and the handoff's rate token. */
  handoff(p, t) {
    return this.recheck(p, t, "handoff");
  }
  /** How long until the handoff's rate token is there: 0 when it is. */
  handoffWait(t) {
    this.refill(t.monoMs);
    const denied = this.rateDenial(this.milliTokens.handoff);
    return denied?.reason === "rate" ? Math.max(1, denied.retryInMs ?? 1) : 0;
  }
  /** The permit's dial or handoff failed: its debit stays (unattempted), its exchange ends. */
  abandon(p) {
    this.resolve(p.seq, false);
  }
  recheck(p, t, boundary) {
    if (!this.permits.has(p) || !this.exchanges.has(p.seq)) return deny("turn_closed", true);
    const d = this.live(p.turn, t);
    if (!("turn" in d)) return d;
    if (!boundary) return;
    this.refill(t.monoMs);
    if (boundary === "handoff") {
      const denied = this.rateDenial(this.milliTokens.handoff);
      if (denied) return denied;
    }
    this.milliTokens[boundary] -= MILLI;
  }
  /** Once either clock reaches a cutoff, a clock correction cannot reopen the run. */
  checkRunEnd(t) {
    if (this.runCutoff) return this.runCutoff;
    const drain = this.drainEnd;
    if (!(t.monoMs < this.limits.runEndMono && t.wallMs < (this.limits.runEndWall ?? Infinity))) {
      this.runCutoff = "hard";
    } else if (drain && !(t.monoMs < drain.monoMs && t.wallMs < drain.wallMs)) {
      this.runCutoff = "drain";
    }
    return this.runCutoff;
  }
  /** Stop, run end, lease and turn expiry on both clocks. */
  live(turnId, t) {
    if (this.stoppedFlag) return deny("stopped", true);
    if (this.checkRunEnd(t)) return deny("run_end", true);
    if (!(t.monoMs < this.lease.monoUntil && t.wallMs < this.lease.wallUntil)) {
      if (Number.isFinite(this.lease.monoUntil)) this.expired = true;
      this.revokeLease();
      return deny("lease", false);
    }
    const turn = this.turns.get(turnId);
    if (!turn?.open) return deny("turn_closed", true);
    if (!(t.monoMs < turn.deadlineMono && t.wallMs < turn.deadlineWall)) turn.expired = true;
    if (turn.expired) return deny("turn_deadline", true);
    return { turn };
  }
  /** Every limit before the rate check. */
  check(r, t) {
    const d = this.live(r.turn, t);
    if (!("turn" in d)) return d;
    const { turn } = d;
    const originTotal = Object.hasOwn(this.limits.origins, r.origin) ? this.limits.origins[r.origin] : void 0;
    if (originTotal === void 0) return deny("origin", true);
    if (!this.methods.has(r.method)) return deny("method", true);
    if (!(this.seq < this.limits.runTotal)) return deny("total", true);
    if (this.limits.maxRequestsPerTurn !== void 0 && !(turn.admitted < this.limits.maxRequestsPerTurn)) return deny("turn_total", true);
    if (!(this.phaseCount < this.phase.total)) return deny("phase_total", false);
    if (!((this.perOrigin.get(r.origin) ?? 0) < originTotal)) return deny("origin_total", true);
    if (!(this.seq < this.lease.ceiling)) return deny("ceiling", false);
    if (!(turn.outstanding < this.limits.maxOutstandingPerTurn)) return deny("outstanding", false);
    if (!(this.liveTurns <= this.phase.maxUsers)) return deny("users", false);
    this.refill(t.monoMs);
    return { turn };
  }
  rateDenial(tokens) {
    if (tokens >= MILLI) return;
    const retryInMs = Math.ceil((MILLI - tokens) / this.phase.ratePerSecond);
    return { ok: false, reason: "rate", final: false, retryInMs };
  }
  /**
   * Whether an admitted request's bytes left: `false` only when the write took none. Either
   * way it stays admitted. A request that never sent also has no exchange, so it finishes too.
   * Unknown or repeated seqs are ignored.
   */
  resolve(seq2, sent) {
    if (!this.undelivered.delete(seq2)) return;
    if (sent) this.sentCount += 1;
    else this.finish(seq2);
  }
  /** The request's exchange is over (answered, failed or abandoned): its turn may send another. */
  finish(seq2) {
    const turnId = this.exchanges.get(seq2);
    if (turnId === void 0) return;
    this.exchanges.delete(seq2);
    const turn = this.turns.get(turnId);
    if (!turn) return;
    turn.outstanding -= 1;
    if (!turn.open && turn.outstanding === 0) this.turns.delete(turnId);
  }
  /** Refill each bucket to at most `burst`. A clock that runs back adds nothing. */
  refill(monoMs) {
    if (this.lastRefillMono === void 0) {
      this.lastRefillMono = monoMs;
      return;
    }
    if (!(monoMs > this.lastRefillMono)) return;
    const added = (monoMs - this.lastRefillMono) * this.phase.ratePerSecond;
    this.refillBuckets(added);
    this.lastRefillMono = monoMs;
  }
  refillBuckets(added) {
    for (const boundary of RATE_BOUNDARIES) {
      this.milliTokens[boundary] = Math.min(this.phase.burst * MILLI, this.milliTokens[boundary] + added);
    }
  }
};
function checkPhase(caps) {
  if (!(caps.ratePerSecond > 0 && Number.isFinite(caps.ratePerSecond))) throw new Error("gate: ratePerSecond must be positive and finite");
  if (!(Number.isSafeInteger(caps.burst) && caps.burst >= 1)) throw new Error("gate: burst must be a whole number \u2265 1");
  if (!(Number.isSafeInteger(caps.maxUsers) && caps.maxUsers >= 0)) throw new Error("gate: maxUsers must be a whole number \u2265 0");
  if (!(Number.isSafeInteger(caps.total) && caps.total >= 0)) throw new Error("gate: total must be a whole number \u2265 0");
}
function deny(reason, final) {
  return { ok: false, reason, final };
}

// src/load/gate/journal.ts
var MAX_JOURNAL_PATH = 256;
function encodeHandoffs(h) {
  return { debited: h.debited, unattempted: [...h.unattempted].sort((a, b) => a - b) };
}
function wasAttempted(handoffs, seq2) {
  return Number.isSafeInteger(seq2) && seq2 >= 1 && seq2 <= handoffs.debited && !handoffs.unattempted.has(seq2);
}
var Journal = class {
  open = /* @__PURE__ */ new Map();
  deniedBy = /* @__PURE__ */ new Map();
  cutBy = /* @__PURE__ */ new Map();
  unattempted = /* @__PURE__ */ new Set();
  receipts = /* @__PURE__ */ new Set();
  counts = { debited: 0, accepted: 0, responded: 0 };
  /** Responses per turn, kept only for the turns marked with `trackTurn` (Checking's). */
  respondedBy = /* @__PURE__ */ new Map();
  /** Count this turn's responses (`respondedForTurn`). Bounded: only Checking's turns are marked. */
  trackTurn(turn) {
    if (!this.respondedBy.has(turn)) this.respondedBy.set(turn, 0);
  }
  /** Valid response heads seen for a tracked turn's requests. */
  respondedForTurn(turn) {
    return this.respondedBy.get(turn) ?? 0;
  }
  /** Debited, before any dial. Seqs come from the gate, in order, each once. */
  begin(seq2, meta) {
    if (seq2 !== this.counts.debited + 1) throw new Error(`journal: seq ${seq2} out of order (expected ${this.counts.debited + 1})`);
    this.counts.debited = seq2;
    this.unattempted.add(seq2);
    this.open.set(seq2, { meta: { ...meta, path: meta.path.slice(0, MAX_JOURNAL_PATH) }, written: "unresolved", responded: false, finished: false });
  }
  /** Called at the write boundary. An error after invocation can mean partial delivery. */
  attempt(seq2, address) {
    this.unattempted.delete(seq2);
    const e = this.open.get(seq2);
    if (e && address !== void 0) e.meta.address = address;
  }
  handoffs() {
    return { debited: this.counts.debited, unattempted: new Set(this.unattempted) };
  }
  /** Record a complete receipt verified by the caller against this run's sink evidence. */
  confirmReceipt(seq2) {
    const handoffs = { debited: this.counts.debited, unattempted: this.unattempted };
    if (!wasAttempted(handoffs, seq2) || this.receipts.has(seq2)) return false;
    this.receipts.add(seq2);
    return true;
  }
  /** The write's callback reported every byte taken. */
  accept(seq2) {
    const e = this.open.get(seq2);
    if (!e || e.written === "accepted" || this.unattempted.has(seq2)) return;
    e.written = "accepted";
    this.counts.accepted += 1;
    this.prune(seq2, e);
  }
  /** A valid response head arrived for it. */
  respond(seq2) {
    const e = this.open.get(seq2);
    if (!e || e.responded || this.unattempted.has(seq2)) return;
    e.responded = true;
    this.counts.responded += 1;
    const n = this.respondedBy.get(e.meta.turn);
    if (n !== void 0) this.respondedBy.set(e.meta.turn, n + 1);
  }
  /** Its exchange is over, however it ended. */
  finish(seq2) {
    const e = this.open.get(seq2);
    if (!e) return;
    e.finished = true;
    this.prune(seq2, e);
  }
  /** An admitted request ended early. Only its first reason counts. */
  cut(seq2, reason) {
    const e = this.open.get(seq2);
    if (!e || e.cut !== void 0) return;
    e.cut = reason;
    this.cutBy.set(reason, (this.cutBy.get(reason) ?? 0) + 1);
  }
  deny(reason) {
    this.deniedBy.set(reason, (this.deniedBy.get(reason) ?? 0) + 1);
  }
  /** The open entry for `seq`, if it is still open. */
  entry(seq2) {
    const e = this.open.get(seq2);
    return e && { ...e, meta: { ...e.meta } };
  }
  /** Entries still open: unresolved writes and exchanges not yet over. */
  get openCount() {
    return this.open.size;
  }
  snapshot() {
    const { debited, accepted, responded } = this.counts;
    return {
      debited,
      attempted: debited - this.unattempted.size,
      accepted,
      responded,
      received: this.receipts.size,
      unresolved: debited - accepted,
      denied: Object.fromEntries(this.deniedBy),
      cut: Object.fromEntries(this.cutBy)
    };
  }
  /** An unresolved write stays open: its delivery is the one thing the counts cannot say. A debit never attempted has none. */
  prune(seq2, e) {
    if (e.finished && (e.written === "accepted" || this.unattempted.has(seq2))) this.open.delete(seq2);
  }
};

// src/load/gate/proxy.ts
var import_node_http2 = require("node:http");
var import_node_net2 = require("node:net");
var import_promises2 = require("node:timers/promises");
var import_node_tls3 = require("node:tls");

// src/load/gate/resolve.ts
var import_node_crypto4 = require("node:crypto");
var import_promises = require("node:dns/promises");
var import_node_net = require("node:net");
var import_node_os2 = require("node:os");
var import_node_tls2 = require("node:tls");
var METADATA_V4 = /* @__PURE__ */ new Set(["169.254.169.254", "168.63.129.16"]);
function classify(address) {
  const kind = (0, import_node_net.isIP)(address);
  if (kind === 4) return classifyV4(v4Bytes(address));
  if (kind !== 6) return "invalid";
  const b = v6Bytes(address);
  if (!b) return "invalid";
  const zeros = (from, to) => b.slice(from, to).every((x) => x === 0);
  if (zeros(0, 10) && b[10] === 255 && b[11] === 255) return classifyV4(b.slice(12));
  if (zeros(0, 16)) return "unspecified";
  if (zeros(0, 15) && b[15] === 1) return "loopback";
  if (zeros(0, 8)) return "reserved";
  if (b[0] === 253 && b[1] === 0 && b[2] === 14 && b[3] === 194) return "metadata";
  if (b[0] === 255) return "multicast";
  if (b[0] === 254 && (b[1] & 192) === 128) return "link_local";
  if ((b[0] & 254) === 252) return "private";
  if (b[0] === 0 && b[1] === 100 && b[2] === 255 && b[3] === 155) return "reserved";
  if (b[0] === 32 && b[1] === 2) return "reserved";
  if (b[0] === 32 && b[1] === 1 && b[2] < 2) return "reserved";
  if (b[0] === 32 && b[1] === 1 && b[2] === 13 && b[3] === 184) return "reserved";
  if (b[0] === 63 && b[1] === 255 && (b[2] & 240) === 0) return "reserved";
  if ((b[0] & 224) !== 32) return "reserved";
  return "public";
}
function classifyV4(b) {
  const [a, c, d] = [b[0], b[1], b[2]];
  const dotted = b.join(".");
  if (METADATA_V4.has(dotted)) return "metadata";
  if (a === 100 && c === 100) return "metadata";
  if (dotted === "0.0.0.0") return "unspecified";
  if (a === 0) return "this_network";
  if (a === 127) return "loopback";
  if (a === 169 && c === 254) return "link_local";
  if (a >= 224 && a <= 239) return "multicast";
  if (a >= 240) return "reserved";
  if (a === 10 || a === 172 && c >= 16 && c <= 31 || a === 192 && c === 168 || a === 100 && c >= 64 && c <= 127) return "private";
  if (a === 192 && c === 0 && (d === 0 || d === 2)) return "reserved";
  if (a === 192 && c === 88 && d === 99) return "reserved";
  if (a === 198 && (c === 18 || c === 19)) return "reserved";
  if (a === 198 && c === 51 && d === 100 || a === 203 && c === 0 && d === 113) return "reserved";
  return "public";
}
function v4Bytes(address) {
  return address.split(".").map(Number);
}
function v6Bytes(address) {
  let s = address.toLowerCase();
  if (s.includes("%")) return void 0;
  let tail = [];
  const colon = s.lastIndexOf(":");
  if (s.includes(".")) {
    tail = v4Bytes(s.slice(colon + 1));
    s = `${s.slice(0, colon + 1)}0:0`;
  }
  const halves = s.split("::");
  if (halves.length > 2) return void 0;
  const words = (part) => part === "" ? [] : part.split(":").map((w) => parseInt(w, 16));
  const head = words(halves[0]);
  const back = halves.length === 2 ? words(halves[1]) : [];
  const fill = 8 - head.length - back.length;
  if (fill < 0 || halves.length === 1 && fill !== 0) return void 0;
  const bytes = [...head, ...Array(fill).fill(0), ...back].flatMap((w) => [w >> 8, w & 255]);
  if (tail.length) bytes.splice(12, 4, ...tail);
  return bytes;
}
function unmap(address) {
  const b = (0, import_node_net.isIP)(address) === 6 ? v6Bytes(address) : void 0;
  if (b && b.slice(0, 10).every((x) => x === 0) && b[10] === 255 && b[11] === 255) return b.slice(12).join(".");
  return address;
}
function canonical2(address) {
  const a = unmap(address);
  if ((0, import_node_net.isIP)(a) !== 6 || a.includes("%")) return a;
  return new URL(`http://[${a}]`).hostname.slice(1, -1);
}
function ownAddresses() {
  return new Set(
    Object.values((0, import_node_os2.networkInterfaces)()).flat().filter((i) => i !== void 0).map((i) => canonical2(i.address))
  );
}
function reachable(address, origin, own = ownAddresses()) {
  const a = canonical2(address);
  const c = classify(a);
  if (c === "public") return !own.has(a);
  if (c !== "private" || own.has(a) || origin.privateCidrs.length === 0) return false;
  const list = new import_node_net.BlockList();
  for (const cidr of origin.privateCidrs) {
    const [net2, bits2] = cidr.split("/");
    const type = (0, import_node_net.isIP)(net2 ?? "") === 6 ? "ipv6" : "ipv4";
    list.addSubnet(net2, Number(bits2), type);
  }
  return list.check(a, (0, import_node_net.isIP)(a) === 6 ? "ipv6" : "ipv4");
}
var DialRefused = class extends Error {
  constructor(reason, detail) {
    super(`load gate: dial refused (${reason}): ${detail}`);
    this.reason = reason;
    this.name = "DialRefused";
  }
};
var systemLookup = (name2) => (0, import_promises.lookup)(name2, { all: true, verbatim: true });
function boundedLookup(limit, lookup = systemLookup) {
  const pending = /* @__PURE__ */ new Map();
  return (name2, signal) => new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new DialRefused("aborted", name2));
    let waiters = pending.get(name2);
    if (!waiters) {
      if (pending.size >= limit) return reject(new DialRefused("resolve", "system lookup capacity reached"));
      const group2 = /* @__PURE__ */ new Set();
      pending.set(name2, group2);
      waiters = group2;
      const settle = (result) => {
        pending.delete(name2);
        for (const waiter of group2) waiter(result);
      };
      void Promise.resolve().then(() => lookup(name2)).then(
        (addresses) => settle({ addresses }),
        (error) => settle({ error })
      );
    }
    const group = waiters;
    const finish = (result) => {
      signal?.removeEventListener("abort", abort);
      group.delete(finish);
      if ("addresses" in result) resolve(result.addresses);
      else reject(result.error);
    };
    const abort = () => finish({ error: new DialRefused("aborted", name2) });
    group.add(finish);
    signal?.addEventListener("abort", abort, { once: true });
  });
}
async function untilAbort(work, signal, host) {
  if (!signal) return work;
  let abort;
  const canceled = new Promise((_resolve, reject) => {
    abort = () => reject(new DialRefused("aborted", host));
    if (signal.aborted) abort();
    else signal.addEventListener("abort", abort, { once: true });
  });
  try {
    return await Promise.race([work, canceled]);
  } finally {
    signal.removeEventListener("abort", abort);
  }
}
async function checkedAddresses(origin, options = {}) {
  const { signal } = options;
  if (signal?.aborted) throw new DialRefused("aborted", origin.host);
  if ((0, import_node_net.isIP)(origin.host)) throw new DialRefused("resolve", "an address literal is not an approved name");
  let addresses;
  try {
    addresses = await untilAbort((options.lookup ?? systemLookup)(`${origin.host}.`, signal), signal, origin.host);
  } catch (error) {
    if (error instanceof DialRefused) throw error;
    throw new DialRefused("resolve", `${origin.host}: ${error.message}`);
  }
  if (addresses.length === 0) throw new DialRefused("resolve", `${origin.host}: no address`);
  const own = ownAddresses();
  for (const { address } of addresses) {
    if (!reachable(address, origin, own)) throw new DialRefused("address", `${origin.host} resolves to a ${classify(unmap(address))} address`);
  }
  const v4 = [...new Set(addresses.map(({ address }) => canonical2(address)))].filter((a) => (0, import_node_net.isIP)(a) === 4);
  if (v4.length === 0) throw new DialRefused("address", `${origin.host} has no IPv4 address; IPv6 targets are not supported yet`);
  return v4;
}
var bundled;
function bundledRoots() {
  return bundled ??= (0, import_node_tls2.createSecureContext)({ ca: [...import_node_tls2.rootCertificates], minVersion: "TLSv1.2" });
}
function checkIdentity(host, cert) {
  if (!cert?.raw) return new Error("no certificate");
  const x509 = new import_node_crypto4.X509Certificate(cert.raw);
  return x509.checkHost(host, { subject: "never", partialWildcards: false, multiLabelWildcards: false }) === void 0 ? new Error(`certificate is not for ${host}`) : void 0;
}
function connectVerified(address, origin, options = {}) {
  const { signal, ready } = options;
  if (signal?.aborted) return Promise.reject(new DialRefused("aborted", origin.host));
  const family = (0, import_node_net.isIP)(address);
  if (!family || (0, import_node_net.isIP)(origin.host)) return Promise.reject(new DialRefused("address", origin.host));
  const secureContext = options.ca ? (0, import_node_tls2.createSecureContext)({ ca: [...options.ca], minVersion: "TLSv1.2" }) : bundledRoots();
  const tcp = new import_node_net.Socket();
  const closed = new Promise((resolve) => tcp.once("close", () => resolve()));
  let connected = false;
  const reset = () => {
    if (tcp.destroyed) return;
    if (connected) tcp.resetAndDestroy();
    else tcp.destroy();
  };
  return new Promise((resolve, reject) => {
    let settled = false;
    const fail = (error) => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener("abort", abort);
      reset();
      void closed.then(() => reject(error));
    };
    const abort = () => fail(new DialRefused("aborted", origin.host));
    const transportError = (error) => fail(new DialRefused("tls", `${origin.host}: ${error.message}`));
    signal?.addEventListener("abort", abort, { once: true });
    tcp.on("error", transportError);
    tcp.once("close", () => transportError(new Error("TCP closed during dial")));
    tcp.once("connect", () => {
      connected = true;
      let tls;
      try {
        if (signal?.aborted || ready?.("tls") === false) return abort();
        tls = (0, import_node_tls2.connect)({
          socket: tcp,
          servername: origin.host,
          ALPNProtocols: ["http/1.1"],
          rejectUnauthorized: true,
          secureContext,
          checkServerIdentity: (_host, cert) => checkIdentity(origin.host, cert)
        });
      } catch (error) {
        return transportError(error);
      }
      tls.on("error", transportError);
      tls.once("close", () => transportError(new Error("closed during the handshake")));
      tls.once("secureConnect", () => {
        if (settled) return;
        const alpn = tls.alpnProtocol;
        if (typeof alpn === "string" && alpn !== "http/1.1") {
          return fail(new DialRefused("alpn", `${origin.host} chose ${alpn}`));
        }
        settled = true;
        signal?.removeEventListener("abort", abort);
        resolve({ socket: tls, address, reset, closed });
      });
    });
    try {
      tcp.connect({
        host: origin.host,
        port: origin.port,
        family,
        autoSelectFamily: false,
        // Node defers the literal-host form to nextTick. This resolver returns only
        // the checked literal and enters Node's single-address connect synchronously.
        lookup: (_name, _options, resolved) => {
          if (signal?.aborted || ready?.("tcp") === false) return abort();
          resolved(null, address, family);
        }
      });
    } catch (error) {
      transportError(error);
    }
  });
}

// src/load/gate/response.ts
var MAX_HEAD_BYTES = 64 * 1024;
var CRLF = Buffer.from("\r\n");
var HEAD_END = Buffer.from("\r\n\r\n");
var ResponseTooLarge = class extends Error {
};
var ResponseReader = class {
  constructor(requestMethod, on, maxBodyBytes = Infinity) {
    this.requestMethod = requestMethod;
    this.on = on;
    this.maxBodyBytes = maxBodyBytes;
  }
  buf = Buffer.alloc(0);
  mode = { kind: "head" };
  paused = false;
  eof = false;
  bytes = 0;
  get done() {
    return this.mode.kind === "done";
  }
  push(chunk) {
    if (this.done) return;
    this.buf = this.buf.length ? Buffer.concat([this.buf, chunk]) : chunk;
    this.process();
  }
  resume() {
    this.paused = false;
    this.process();
  }
  /** Only the upstream's clean readable end is an EOF. */
  end() {
    this.eof = true;
    this.process();
  }
  stop() {
    this.mode = { kind: "done" };
    this.buf = Buffer.alloc(0);
  }
  complete() {
    this.stop();
    this.on.end();
  }
  process() {
    try {
      this.drain();
      if (this.eof && !this.paused && !this.done) {
        if (this.mode.kind !== "close") throw new Error("upstream closed before the response ended");
        this.complete();
      }
    } catch (error) {
      this.stop();
      this.on.error(error);
    }
  }
  drain() {
    while (!this.done && !this.paused) {
      const m = this.mode;
      if (m.kind === "head") {
        const at = this.buf.indexOf(HEAD_END);
        if (at > MAX_HEAD_BYTES || at < 0 && this.buf.length > MAX_HEAD_BYTES) throw new Error("response head too large");
        if (at < 0) return;
        const head = parseHead(this.buf.subarray(0, at).toString("latin1"));
        this.buf = this.buf.subarray(at + 4);
        if (head.status === 101) throw new Error("upstream switched protocols");
        if (head.status < 200) continue;
        const mode = bodyMode(this.requestMethod, head);
        if (mode.kind === "fixed" && mode.left > this.maxBodyBytes) throw new ResponseTooLarge();
        this.mode = mode;
        this.on.head(head);
        if (mode.kind === "done") return this.complete();
        continue;
      }
      if (m.kind === "close") {
        if (this.buf.length) this.data(this.buf.length);
        return;
      }
      if (m.kind === "fixed") {
        if (m.left === 0) return this.complete();
        if (!this.buf.length) return;
        const n = Math.min(m.left, this.buf.length);
        m.left -= n;
        this.data(n);
        continue;
      }
      if (m.kind === "chunk-size") {
        const at = this.buf.indexOf(CRLF);
        if (at < 0) {
          if (this.buf.length > 1024) throw new Error("chunk size line too long");
          return;
        }
        const line = this.buf.subarray(0, at).toString("latin1");
        this.buf = this.buf.subarray(at + 2);
        const hex = line.split(";")[0].trim();
        if (!/^[0-9a-fA-F]{1,12}$/.test(hex)) throw new Error("bad chunk size");
        const size = parseInt(hex, 16);
        this.mode = size === 0 ? { kind: "trailers" } : { kind: "chunk-data", left: size };
        continue;
      }
      if (m.kind === "chunk-data") {
        if (!this.buf.length) return;
        const n = Math.min(m.left, this.buf.length);
        m.left -= n;
        if (m.left === 0) this.mode = { kind: "chunk-crlf" };
        this.data(n);
        continue;
      }
      if (m.kind === "chunk-crlf") {
        if (this.buf.length < 2) return;
        if (this.buf[0] !== 13 || this.buf[1] !== 10) throw new Error("chunk not followed by CRLF");
        this.buf = this.buf.subarray(2);
        this.mode = { kind: "chunk-size" };
        continue;
      }
      if (m.kind === "trailers") {
        const at = this.buf.indexOf(CRLF);
        if (at < 0) {
          if (this.buf.length > MAX_HEAD_BYTES) throw new Error("trailers too large");
          return;
        }
        this.buf = this.buf.subarray(at + 2);
        if (at === 0) return this.complete();
        continue;
      }
      return;
    }
  }
  data(n) {
    this.bytes += n;
    if (this.bytes > this.maxBodyBytes) throw new ResponseTooLarge();
    this.paused = this.on.data(this.take(n)) === false;
  }
  take(n) {
    const out = this.buf.subarray(0, n);
    this.buf = this.buf.subarray(n);
    return Buffer.from(out);
  }
};
var TEXT = /^[\t\x20-\x7e\x80-\xff]*$/;
var TOKEN = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;
function parseHead(text2) {
  const lines = text2.split("\r\n");
  const m = /^HTTP\/1\.[01] ([1-9][0-9]{2})(?: (.*))?$/.exec(lines[0]);
  if (!m || !TEXT.test(m[2] ?? "")) throw new Error("bad status line");
  const headers = [];
  for (const line of lines.slice(1)) {
    const c = line.indexOf(":");
    const value = line.slice(c + 1).trim();
    if (c <= 0 || !TOKEN.test(line.slice(0, c)) || !TEXT.test(value)) throw new Error("bad response header");
    headers.push([line.slice(0, c), value]);
  }
  return { status: Number(m[1]), statusText: m[2] ?? "", headers };
}
function bodyMode(method, head) {
  const bodyless = method === "HEAD" || head.status === 204 || head.status === 304;
  const values = (name2) => head.headers.filter(([n]) => n.toLowerCase() === name2).map(([, v2]) => v2);
  const te = values("transfer-encoding");
  const cl = values("content-length");
  if (te.length && cl.length) throw new Error("ambiguous framing: both transfer-encoding and content-length");
  if (te.length) {
    const codings = te.join(",").split(",").map((s) => s.trim().toLowerCase());
    if (codings.length !== 1 || codings[0] !== "chunked") throw new Error("unsupported transfer-coding");
    return { kind: bodyless ? "done" : "chunk-size" };
  }
  if (cl.length) {
    if (new Set(cl).size !== 1 || !/^[0-9]{1,15}$/.test(cl[0])) throw new Error("bad content-length");
    const n = Number(cl[0]);
    return bodyless || n === 0 ? { kind: "done" } : { kind: "fixed", left: n };
  }
  return { kind: bodyless ? "done" : "close" };
}

// src/load/gate/proxy.ts
var DENIED_HEADER = "x-peeps-load-denied";
var CUT_HEADER = "x-peeps-load-cut";
var RETRY_HEADER = "x-peeps-load-retry-after-ms";
var HOP_HEADERS = /* @__PURE__ */ new Set(["connection", "keep-alive", "proxy-connection", "transfer-encoding", "te", "trailer", "upgrade", "content-length", DENIED_HEADER, CUT_HEADER, RETRY_HEADER]);
var HEAD_HOP_HEADERS = new Set([...HOP_HEADERS].filter((h) => h !== "content-length"));
var DEFAULT_PROXY_LIMITS = {
  maxTunnelsPerTurn: 8,
  maxTunnels: 512,
  maxConnections: 1024,
  maxPendingDialsPerTurn: 4,
  maxPendingDials: 64,
  setupMs: 1e4,
  dialMs: 1e4,
  queueMs: 1e4,
  exchangeMs: 6e4,
  maxResponseBytes: 64 * 1024 * 1024,
  maxBufferedBodyBytes: 32 * 1024 * 1024
};
function makeDial(seams = {}) {
  const connect2 = seams.connect ?? connectVerified;
  const lookup = boundedLookup(seams.maxLookups ?? DEFAULT_PROXY_LIMITS.maxPendingDials, seams.lookup);
  return async (origin, signal, pinned, ready) => {
    const address = pinned ?? (await checkedAddresses(origin, { lookup, signal }))[0];
    if ((0, import_node_net2.isIP)(address) !== 4 || !reachable(address, origin)) {
      throw new DialRefused("address", `${origin.host}: its selected address is no longer reachable`);
    }
    if (signal.aborted || ready && !ready()) throw new DialRefused("aborted", origin.host);
    return connect2(address, origin, { ca: seams.ca, signal, ready });
  };
}
var GateProxy = class {
  constructor(o) {
    this.o = o;
    validatePolicy(o.policy);
    this.limits = { ...DEFAULT_PROXY_LIMITS, ...o.limits };
    this.clocks = o.clocks;
    this.dial = o.dial ?? makeDial({ maxLookups: this.limits.maxPendingDials });
    this.server = (0, import_node_http2.createServer)({ maxHeaderSize: 8192, insecureHTTPParser: false });
    this.server.maxHeadersCount = 0;
    this.server.maxConnections = this.limits.maxConnections;
    this.server.on("connection", (s) => this.track(s));
    this.server.on("connect", (req, socket, head) => this.onConnect(req, socket, head));
    this.server.on("upgrade", (_req, socket) => this.rawRefuse(socket, 400, "upgrade"));
    this.server.on("checkContinue", (_req, res) => this.refuse(res, 417, "expect"));
    this.server.on("checkExpectation", (_req, res) => this.refuse(res, 417, "expect"));
    this.server.on("request", (_req, res) => this.refuse(res, 405, "form"));
    this.server.on("clientError", (_e, socket) => socket.destroy());
    this.inner = (0, import_node_http2.createServer)({ maxHeaderSize: 16384, joinDuplicateHeaders: false, insecureHTTPParser: false, requestTimeout: 0 });
    this.inner.maxHeadersCount = 0;
    this.inner.on("request", (req, res) => this.onRequest(req, res));
    for (const event of ["upgrade", "connect"]) {
      this.inner.on(event, (req, socket) => this.revokeFor(req.socket, socket, event === "upgrade" ? "upgrade" : "form", 400));
    }
    for (const event of ["checkContinue", "checkExpectation"]) {
      this.inner.on(event, (req, res) => {
        this.refuse(res, 417, "expect");
        const t = this.byTls.get(req.socket);
        if (t) this.revoke(t);
      });
    }
    this.inner.on("clientError", (_e, socket) => {
      const t = this.byTls.get(socket);
      if (t) this.revoke(t);
      else socket.destroy();
    });
  }
  server;
  inner;
  limits;
  connections = /* @__PURE__ */ new Set();
  tunnels = /* @__PURE__ */ new Set();
  tunnelsPerTurn = /* @__PURE__ */ new Map();
  byTls = /* @__PURE__ */ new WeakMap();
  work = /* @__PURE__ */ new Set();
  pending = { run: 0, turn: /* @__PURE__ */ new Map(), origin: /* @__PURE__ */ new Map() };
  pins = /* @__PURE__ */ new Map();
  firstDials = /* @__PURE__ */ new Map();
  closedTurns = /* @__PURE__ */ new Set();
  contexts = /* @__PURE__ */ new Map();
  clocks;
  dial;
  closed = false;
  buffered = 0;
  closing;
  /** Listen on the proxy's Unix socket. */
  listen(path4) {
    if (this.closed) return Promise.reject(new Error("load gate: proxy is closed"));
    return new Promise((resolve, reject) => {
      this.server.once("error", reject);
      this.server.listen(path4, () => {
        this.server.off("error", reject);
        resolve();
      });
    });
  }
  /** Feed an accepted connection (production uses `listen`). */
  accept(socket) {
    this.server.emit("connection", socket);
  }
  /** Dials in progress for the run. */
  get pendingDials() {
    return this.pending.run;
  }
  get openTunnels() {
    return this.tunnels.size;
  }
  /** The verified address each origin was pinned to on its first admitted request. */
  get pinned() {
    return this.pins;
  }
  /** Revoke a turn: the gate stops admitting it, its dials are abandoned, its tunnels and upstreams reset now. */
  closeTurn(turn) {
    this.closedTurns.add(turn);
    this.o.gate.closeTurn(turn);
    for (const t of [...this.tunnels]) if (t.turn === turn) this.revoke(t);
  }
  /** Stop the gate and reset every socket, tunnel and dial; await the listener and owned work. */
  close() {
    this.closing ??= this.shutDown();
    return this.closing;
  }
  async shutDown() {
    this.closed = true;
    this.o.gate.stop();
    for (const t of [...this.tunnels]) this.revoke(t);
    for (const s of this.connections) s.destroy();
    await new Promise((resolve) => {
      if (!this.server.listening) return resolve();
      this.server.close(() => resolve());
    });
    while (this.work.size > 0) await Promise.allSettled(this.work);
  }
  trackWork(work) {
    this.work.add(work);
    const done = () => this.work.delete(work);
    void work.then(done, done);
  }
  track(s) {
    this.connections.add(s);
    s.on("close", () => this.connections.delete(s));
  }
  onConnect(req, client, head) {
    if (this.closed) return this.rawRefuse(client, 503, "stopped");
    if (req.rawHeaders.length > 2 * MAX_HEADERS) return this.rawRefuse(client, 431, "header");
    const credentials = headerValues(req.rawHeaders, "proxy-authorization");
    const turn = credentials.length === 1 ? this.o.authorize(credentials[0]) : void 0;
    if (turn === void 0) return this.rawRefuse(client, 407, "credential", "proxy-authenticate: Basic\r\n");
    if (this.closedTurns.has(turn)) return this.rawRefuse(client, 403, "turn_closed");
    const authority = parseAuthority(req.url ?? "");
    if (!authority || !this.o.origins.has(authority.origin)) return this.rawRefuse(client, 403, "origin");
    const context = this.contextFor(authority.host);
    if (!context) return this.rawRefuse(client, 403, "origin");
    const perTurn = this.tunnelsPerTurn.get(turn) ?? 0;
    if (perTurn >= this.limits.maxTunnelsPerTurn || this.tunnels.size >= this.limits.maxTunnels) return this.rawRefuse(client, 503, "tunnels");
    const tunnel = { turn, authority, client, used: false, revoked: false, bodyBytes: 0 };
    this.tunnels.add(tunnel);
    this.tunnelsPerTurn.set(turn, perTurn + 1);
    tunnel.setupTimer = setTimeout(() => {
      this.o.journal.deny("setup_timeout");
      this.revoke(tunnel);
    }, this.limits.setupMs);
    tunnel.setupTimer.unref();
    client.on("close", () => this.revoke(tunnel));
    client.on("error", () => client.destroy());
    if (head.length) client.unshift(head);
    client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
    const tls = new import_node_tls3.TLSSocket(client, { isServer: true, secureContext: context, ALPNProtocols: ["http/1.1"] });
    tunnel.tls = tls;
    this.byTls.set(tls, tunnel);
    tls.on("error", () => this.revoke(tunnel));
    this.inner.emit("connection", tls);
  }
  contextFor(host) {
    let context = this.contexts.get(host);
    if (!context) {
      const leaf = this.o.ca.leaf(host);
      if (!leaf) return void 0;
      context = (0, import_node_tls3.createSecureContext)({ cert: leaf.certPem, key: leaf.key.export({ type: "pkcs8", format: "pem" }), minVersion: "TLSv1.2" });
      this.contexts.set(host, context);
    }
    return context;
  }
  onRequest(req, res) {
    res.shouldKeepAlive = false;
    const tunnel = this.byTls.get(req.socket);
    if (!tunnel || tunnel.revoked) return this.refuse(res, 400, "form");
    if (tunnel.used) {
      this.refuse(res, 400, "pipelined");
      return this.revoke(tunnel);
    }
    tunnel.used = true;
    if (headerValues(req.rawHeaders, "transfer-encoding").length) return this.refuse(res, 400, "header");
    const declared = headerValues(req.rawHeaders, "content-length");
    if (declared.length === 1 && Number(declared[0]) > MAX_BODY_BYTES) return this.refuse(res, 413, "too_large");
    const chunks = [];
    let size = 0;
    req.on("data", (chunk) => {
      if (tunnel.revoked) return;
      size += chunk.length;
      if (this.buffered + chunk.length > this.limits.maxBufferedBodyBytes) {
        this.refuse(res, 503, "memory");
        this.revoke(tunnel);
        return;
      }
      this.buffered += chunk.length;
      tunnel.bodyBytes += chunk.length;
      if (size > MAX_BODY_BYTES) {
        this.refuse(res, 413, "too_large");
        this.revoke(tunnel);
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      if (tunnel.revoked || size > MAX_BODY_BYTES) return;
      clearTimeout(tunnel.setupTimer);
      const tls = req.socket;
      const body = Buffer.concat(chunks);
      chunks.length = 0;
      const n = normalize(
        { method: req.method ?? "", target: req.url ?? "", httpVersion: req.httpVersion, rawHeaders: req.rawHeaders, body },
        { authority: tunnel.authority, servername: typeof tls.servername === "string" ? tls.servername : void 0 },
        this.o.policy
      );
      if (!n.ok) {
        this.release(tunnel);
        return this.refuse(res, n.status, n.reason);
      }
      tunnel.dispatching = true;
      this.trackWork(this.dispatch(tunnel, n, res).then(
        (writing) => {
          tunnel.dispatching = false;
          if (!writing) this.release(tunnel);
        },
        () => {
          tunnel.dispatching = false;
          if (!tunnel.finish) this.release(tunnel);
          this.revoke(tunnel);
        }
      ));
    });
  }
  async dispatch(tunnel, n, res) {
    const { turn } = tunnel;
    const { gate, journal } = this.o;
    const turnDials = this.pending.turn.get(turn) ?? 0;
    if (turnDials >= this.limits.maxPendingDialsPerTurn || this.pending.run >= this.limits.maxPendingDials) return this.refuse(res, 503, "dials");
    const t = this.clocks();
    const permitted = gate.permit({ turn, origin: n.origin, method: n.method }, t);
    if (!permitted.ok) {
      this.denied(res, permitted);
      return this.handleCutoff(turn, permitted);
    }
    const { permit } = permitted;
    journal.begin(permit.seq, { turn, origin: n.origin, method: n.method, path: n.path, monoMs: t.monoMs });
    let releaseFirstDial;
    const origin = this.o.origins.get(n.origin);
    const controller = new AbortController();
    tunnel.dial = controller;
    let timedOut = false;
    const deadline = (ms2) => {
      const timer2 = setTimeout(() => {
        timedOut = true;
        controller.abort();
      }, ms2);
      timer2.unref();
      return timer2;
    };
    let timer = deadline(this.limits.queueMs);
    this.pending.run += 1;
    this.pending.turn.set(turn, turnDials + 1);
    this.pending.origin.set(n.origin, (this.pending.origin.get(n.origin) ?? 0) + 1);
    let upstream;
    let dialDenial;
    try {
      const ready = (boundary) => {
        if (this.closed || tunnel.revoked || res.destroyed) return false;
        dialDenial = gate.checkDial(permit, this.clocks(), boundary);
        if (dialDenial) this.handleCutoff(turn, dialDenial);
        return dialDenial === void 0;
      };
      while (!this.pins.has(n.origin)) {
        const first = this.firstDials.get(n.origin);
        if (first === void 0) {
          let release;
          this.firstDials.set(n.origin, new Promise((resolve) => {
            release = resolve;
          }));
          releaseFirstDial = () => {
            this.firstDials.delete(n.origin);
            release();
          };
          break;
        }
        await untilAbort(first, controller.signal, origin.host);
      }
      clearTimeout(timer);
      timer = deadline(this.limits.dialMs);
      if (controller.signal.aborted || !ready()) throw new DialRefused("aborted", origin.host);
      upstream = await this.dial(origin, controller.signal, this.pins.get(n.origin), ready);
      this.trackWork(upstream.closed);
    } catch {
      releaseFirstDial?.();
      tunnel.dial = void 0;
      const reason = dialDenial ? dialDenial.reason : this.closed ? "stopped" : this.closedTurns.has(turn) ? "turn_closed" : tunnel.revoked ? "revoked" : timedOut ? "dial_timeout" : "dial";
      return this.cutUnsent(res, permit, reason, dialDenial || this.closed || tunnel.revoked || timedOut ? 503 : 502);
    } finally {
      clearTimeout(timer);
      this.pending.run -= 1;
      decrement(this.pending.turn, turn);
      decrement(this.pending.origin, n.origin);
    }
    const reset = () => upstream.reset();
    controller.signal.addEventListener("abort", reset, { once: true });
    try {
      if (this.closed || tunnel.revoked || controller.signal.aborted || res.destroyed) {
        upstream.reset();
        return this.cutUnsent(res, permit, this.closed ? "stopped" : this.closedTurns.has(turn) ? "turn_closed" : timedOut ? "dial_timeout" : "revoked");
      }
      const address = canonical2(upstream.address);
      const pin = this.pins.get(n.origin);
      if (pin !== void 0 && address !== pin) {
        upstream.reset();
        return this.cutUnsent(res, permit, "pin", 502);
      }
      for (let wait = gate.handoffWait(this.clocks()); wait > 0; wait = gate.handoffWait(this.clocks())) {
        const denial = gate.checkDial(permit, this.clocks());
        if (denial) {
          reset();
          this.cutUnsent(res, permit, denial.reason);
          return this.handleCutoff(turn, denial);
        }
        await (0, import_promises2.setTimeout)(Math.min(wait, 50), void 0, { signal: controller.signal, ref: false }).catch(() => void 0);
        if (controller.signal.aborted || res.destroyed) {
          if (!controller.signal.aborted) reset();
          return this.cutUnsent(res, permit, this.closed ? "stopped" : this.closedTurns.has(turn) ? "turn_closed" : "revoked");
        }
        if (!upstream.socket.writable) {
          reset();
          return this.cutUnsent(res, permit, "dial", 502);
        }
      }
      try {
        return this.send(tunnel, n, upstream, res, permit, address);
      } catch (error) {
        upstream.reset();
        throw error;
      }
    } finally {
      controller.signal.removeEventListener("abort", reset);
      tunnel.dial = void 0;
      releaseFirstDial?.();
    }
  }
  /** A debited request whose bytes never left: its debit stays, unattempted, and the gate answers a cut. */
  cutUnsent(res, permit, reason, status = 503) {
    const { gate, journal } = this.o;
    gate.abandon(permit);
    journal.cut(permit.seq, reason);
    journal.finish(permit.seq);
    this.answer(res, status, CUT_HEADER, reason);
  }
  /** A cutoff also resets exchanges that were already handed off. */
  handleCutoff(turn, d) {
    if (d.reason === "lease") this.o.onLeaseExpired();
    else if (d.reason === "run_end") {
      if (this.o.onRunEnded) this.o.onRunEnded();
      else void this.close();
    } else if (d.reason === "turn_deadline") {
      this.closeTurn(turn);
      this.o.onTurnExpired?.(turn);
    }
  }
  /**
   * A fresh sample → handoff → journal.attempt → write, in one synchronous function: nothing
   * may be awaited or deferred here.
   */
  send(tunnel, n, upstream, res, permit, address) {
    const { gate, journal } = this.o;
    if (this.closed || tunnel.revoked || !upstream.socket.writable) {
      upstream.reset();
      return this.cutUnsent(res, permit, this.closed ? "stopped" : "revoked");
    }
    const seq2 = permit.seq;
    const wire = this.o.seqHeader ? Buffer.concat([Buffer.from(n.head.replace(/\r\n\r\n$/, `\r
${this.o.seqHeader}: ${seq2}\r
\r
`), "latin1"), n.body]) : n.body.length ? Buffer.concat([Buffer.from(n.head, "latin1"), n.body]) : Buffer.from(n.head, "latin1");
    const denial = gate.handoff(permit, this.clocks());
    if (denial) {
      upstream.reset();
      this.cutUnsent(res, permit, denial.reason);
      return this.handleCutoff(permit.turn, denial);
    }
    this.pins.set(n.origin, address);
    const finish = this.relay(tunnel, seq2, n.method, upstream, res);
    try {
      journal.attempt(seq2, address);
      upstream.socket.write(wire, (error) => {
        this.release(tunnel);
        if (error) return finish("write");
        journal.accept(seq2);
        gate.resolve(seq2, true);
      });
    } catch {
      finish("write");
    }
    return true;
  }
  /** Relays the response back; returns the exchange's once-only finalizer, installed before the write. */
  relay(tunnel, seq2, method, upstream, res) {
    const { gate, journal } = this.o;
    const { socket } = upstream;
    let finished = false;
    let eof = false;
    let paused = false;
    const timer = setTimeout(() => finish("exchange_timeout"), this.limits.exchangeMs);
    timer.unref();
    const finish = (reason) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      res.off("drain", drain);
      res.off("close", downstreamClosed);
      socket.off("data", push);
      reader.stop();
      upstream.reset();
      if (reason) journal.cut(seq2, reason);
      gate.finish(seq2);
      journal.finish(seq2);
      if (!reason) res.end();
      else if (reason !== "revoked" && !res.headersSent) this.answer(res, 502, CUT_HEADER, reason);
      else if (!res.writableEnded) res.destroy();
    };
    const reader = new ResponseReader(method, {
      head: (h) => {
        const hop = method === "HEAD" ? HEAD_HOP_HEADERS : HOP_HEADERS;
        res.writeHead(h.status, h.statusText, h.headers.filter(([name2]) => !hop.has(name2.toLowerCase())).flat());
        res.flushHeaders();
        journal.respond(seq2);
      },
      data: (chunk) => {
        if (res.write(chunk)) return true;
        paused = true;
        socket.pause();
        res.once("drain", drain);
        return false;
      },
      end: () => finish(),
      error: (error) => finish(error instanceof ResponseTooLarge ? "response_too_large" : "upstream")
    }, this.limits.maxResponseBytes);
    const drain = () => {
      paused = false;
      reader.resume();
      if (!paused && !finished) socket.resume();
    };
    const push = (chunk) => reader.push(chunk);
    const downstreamClosed = () => finish("revoked");
    tunnel.finish = finish;
    void upstream.closed.then(() => this.release(tunnel));
    socket.on("data", push);
    socket.on("error", () => finish("upstream"));
    socket.on("end", () => {
      eof = true;
      reader.end();
    });
    socket.on("close", (hadError) => {
      if (hadError || !eof) finish("upstream");
    });
    res.on("close", downstreamClosed);
    return finish;
  }
  /** Release a body after write completion, TCP close, or a refusal before writing. */
  release(t) {
    this.buffered -= t.bodyBytes;
    t.bodyBytes = 0;
  }
  /** Request body bytes held in memory across the run. */
  get bufferedBodyBytes() {
    return this.buffered;
  }
  /** Revoke one tunnel: abort its dial, reset its upstream, close it. Idempotent. */
  revoke(t) {
    if (t.revoked) return;
    t.revoked = true;
    clearTimeout(t.setupTimer);
    this.tunnels.delete(t);
    decrement(this.tunnelsPerTurn, t.turn);
    t.dial?.abort();
    if (t.finish) t.finish("revoked");
    else if (!t.dispatching) this.release(t);
    t.tls?.destroy();
    t.client.destroy();
  }
  revokeFor(tlsSocket, socket, reason, status) {
    this.rawRefuse(socket, status, reason);
    const t = this.byTls.get(tlsSocket);
    if (t) this.revoke(t);
  }
  denied(res, d) {
    this.refuse(res, 503, d.reason, d.reason === "rate" && d.retryInMs !== void 0 ? { [RETRY_HEADER]: String(d.retryInMs) } : {});
  }
  refuse(res, status, reason, extra = {}) {
    this.o.journal.deny(reason);
    this.answer(res, status, DENIED_HEADER, reason, extra);
  }
  /** The gate's answer: `DENIED_HEADER` before admission, `CUT_HEADER` for an admitted exchange it ended. */
  answer(res, status, header, reason, extra = {}) {
    if (res.headersSent || res.destroyed) {
      res.destroy();
      return;
    }
    res.shouldKeepAlive = false;
    res.writeHead(status, { [header]: reason, ...extra, "content-length": "0", connection: "close" });
    res.end();
  }
  rawRefuse(socket, status, reason, extra = "") {
    this.o.journal.deny(reason);
    socket.on("error", () => socket.destroy());
    socket.end(`HTTP/1.1 ${status} Refused\r
${DENIED_HEADER}: ${reason}\r
${extra}content-length: 0\r
connection: close\r
\r
`);
  }
};
function decrement(map, key) {
  const n = (map.get(key) ?? 0) - 1;
  if (n > 0) map.set(key, n);
  else map.delete(key);
}
function headerValues(raw, name2) {
  const out = [];
  for (let i = 0; i + 1 < raw.length; i += 2) if (raw[i].toLowerCase() === name2) out.push(raw[i + 1]);
  return out;
}

// src/load/gate/reconcile.ts
var import_node_crypto5 = require("node:crypto");
function batchHash(batch) {
  return (0, import_node_crypto5.createHash)("sha256").update(JSON.stringify([batch.streamId, batch.seq, batch.payload, batch.final?.watermark ?? null])).digest("hex");
}

// src/load/install.ts
var import_node_child_process2 = require("node:child_process");
var import_node_crypto6 = require("node:crypto");
var import_node_fs = require("node:fs");
var import_promises3 = require("node:fs/promises");
var import_node_module = require("node:module");
var import_node_path = __toESM(require("node:path"));

// src/load/jail/spec.ts
var RELAY_UID = 65533;
var ADDRESS_FAMILIES = ["AF_UNIX", "AF_INET", "AF_INET6", "AF_NETLINK"];
var DENIED_SYSCALLS = [
  "@debug",
  "bpf",
  "keyctl",
  "add_key",
  "request_key",
  "pidfd_getfd",
  "setns",
  "io_uring_setup",
  "io_uring_enter",
  "io_uring_register"
];
var IN_JAIL = {
  workspace: "/run/peeps/ws",
  home: "/run/peeps/home",
  node: "/run/peeps/node",
  action: "/run/peeps/action",
  sockets: "/run/peeps/sock",
  ca: "/run/peeps/ca.pem",
  relayPort: 3128
};
var RUN_ID = /^[a-z0-9][a-z0-9-]{0,39}$/;
var ENV_NAME = /^[A-Z_][A-Z0-9_]*$/;
var RESERVED_ENV = /* @__PURE__ */ new Set(["PATH", "HOME", "NODE_EXTRA_CA_CERTS", "NODE_OPTIONS", "LD_PRELOAD", "LD_LIBRARY_PATH"]);
function unitName(runId) {
  return `peeps-load-${runId}`;
}
function socketDir(runId) {
  return `/run/peeps-load-${runId}`;
}
function rootDir(runId) {
  return `/run/peeps-root-${runId}`;
}
var OUTPUT_PREFIX = "jail| ";
function neutralize(line) {
  return OUTPUT_PREFIX + line.replaceAll("##[", "## [");
}
function specProblems(spec) {
  const problems = [];
  if (!RUN_ID.test(spec.runId)) problems.push("runId must be 1-40 lowercase letters, digits or dashes");
  for (const [name2, value] of Object.entries({
    node: spec.node,
    nodeDir: spec.nodeDir,
    actionDir: spec.actionDir,
    outer: spec.outer,
    init: spec.init,
    workspace: spec.workspace,
    ...spec.caPem ? { caPem: spec.caPem } : {}
  })) {
    if (!isPlainAbsolute(value)) problems.push(`${name2} must be an absolute path without "..", newlines or NUL`);
  }
  if (!within(spec.node, spec.nodeDir)) problems.push("node must sit inside nodeDir");
  if (dirOf(spec.outer) !== spec.actionDir || dirOf(spec.init) !== spec.actionDir) problems.push("outer and init must sit directly in actionDir");
  if (!Number.isInteger(spec.executorUid) || spec.executorUid <= 0 || spec.executorUid === RELAY_UID) problems.push("executorUid must be a non-root uid other than the relay's");
  if (!Number.isInteger(spec.executorGid) || spec.executorGid <= 0 || spec.executorGid === RELAY_UID) problems.push("executorGid must be a non-root gid other than the relay's");
  if (spec.command.length === 0 || spec.command.some((arg) => arg.includes("\0"))) problems.push("command must be non-empty, without NUL");
  if (spec.install && (spec.install.length === 0 || spec.install.some((arg) => arg.includes("\0")))) problems.push("install must be non-empty, without NUL");
  if (typeof spec.claimId !== "string" || !/^[\x21-\x7e]{1,256}$/.test(spec.claimId)) problems.push("claimId must be 1-256 printable characters");
  for (const [name2, value] of Object.entries(spec.env)) {
    if (!ENV_NAME.test(name2) || RESERVED_ENV.has(name2)) problems.push(`env ${name2} is not allowed`);
    if (/[\0\n]/.test(value)) problems.push(`env ${name2} has a newline or NUL`);
  }
  const { maxRunMs, memoryMax, tasksMax, cpuQuotaPercent } = spec.limits;
  if (!Number.isInteger(maxRunMs) || maxRunMs < 1e3) problems.push("maxRunMs must be at least 1000");
  if (!/^[1-9][0-9]*[KMG]$/.test(memoryMax)) problems.push("memoryMax must look like 512M or 2G");
  if (!Number.isInteger(tasksMax) || tasksMax < 16) problems.push("tasksMax must be at least 16");
  if (!Number.isInteger(cpuQuotaPercent) || cpuQuotaPercent < 50) problems.push("cpuQuotaPercent must be at least 50");
  return problems;
}
function initConfig(spec) {
  return {
    runId: spec.runId,
    socketDir: socketDir(spec.runId),
    workspace: spec.workspace,
    nodeDir: spec.nodeDir,
    actionDir: spec.actionDir,
    ...spec.caPem ? { caPem: spec.caPem } : {},
    initInJail: `${IN_JAIL.action}/${baseOf(spec.init)}`,
    nodeInJail: `${IN_JAIL.node}/${spec.node.slice(spec.nodeDir.length + 1)}`,
    executorUid: spec.executorUid,
    executorGid: spec.executorGid,
    claimId: spec.claimId,
    ...spec.install ? { install: spec.install } : {},
    command: spec.command,
    env: spec.env
  };
}
function systemdRunArgs(spec) {
  const { maxRunMs, memoryMax, tasksMax, cpuQuotaPercent } = spec.limits;
  const property = (value) => ["-p", value];
  return [
    "/usr/bin/systemd-run",
    `--unit=${unitName(spec.runId)}`,
    "--pipe",
    "--wait",
    "--collect",
    "--quiet",
    "--service-type=exec",
    "--working-directory=/",
    ...property("KillMode=control-group"),
    // No grace on stop: the gate is already closed, and customer code gets no last word.
    ...property("KillSignal=SIGKILL"),
    ...property("TimeoutStopSec=2s"),
    ...property(`RuntimeMaxSec=${Math.ceil(maxRunMs / 1e3)}s`),
    ...property(`MemoryMax=${memoryMax}`),
    ...property(`TasksMax=${tasksMax}`),
    ...property("LimitNOFILE=4096"),
    ...property(`CPUQuota=${cpuQuotaPercent}%`),
    ...property(`RestrictAddressFamilies=${ADDRESS_FAMILIES.join(" ")}`),
    ...property("SystemCallErrorNumber=EPERM"),
    // RestrictAddressFamilies does not cover i386 socketcall(); without this, int 0x80 opens vsock.
    ...property("SystemCallArchitectures=native"),
    ...property(`SystemCallFilter=~${DENIED_SYSCALLS.join(" ")}`),
    `--setenv=PEEPS_JAIL_CONFIG=${JSON.stringify(initConfig(spec))}`,
    spec.node,
    spec.outer
  ];
}
function isPlainAbsolute(value) {
  return value.startsWith("/") && !/[\0\n]/.test(value) && !value.split("/").includes("..") && !value.endsWith("/");
}
function within(file, dir) {
  return file.startsWith(`${dir}/`);
}
function dirOf(file) {
  return file.slice(0, file.lastIndexOf("/")) || "/";
}
function baseOf(file) {
  return file.slice(file.lastIndexOf("/") + 1);
}

// src/load/install.ts
var SUPPORTED_TOOLCHAIN = [{ node: "24.22.3", npm: "11.19.1" }];
var REGISTRY = "https://registry.npmjs.org/";
var INSTALL_MS = 10 * 6e4;
var DEP_FIELDS = ["dependencies", "devDependencies", "optionalDependencies", "peerDependencies"];
var InstallRefused = class extends Error {
  constructor(problems) {
    super(`install_unsupported: ${problems.join("; ")}`);
    this.problems = problems;
    this.name = "InstallRefused";
  }
};
function readJson(root, file, unreadable, name2) {
  if (!lstatExists(file)) return void 0;
  try {
    const resolved = (0, import_node_fs.realpathSync)(file);
    if (!inside(resolved, root) || !(0, import_node_fs.statSync)(resolved).isFile()) {
      unreadable.push(name2);
      return void 0;
    }
    return JSON.parse((0, import_node_fs.readFileSync)(resolved, "utf8"));
  } catch {
    unreadable.push(name2);
    return void 0;
  }
}
function inside(child, root) {
  return child === root || child.startsWith(`${root}/`);
}
function workspacePatterns(manifest) {
  if (typeof manifest !== "object" || manifest === null) return [];
  const w = manifest.workspaces;
  if (w === void 0) return [];
  if (Array.isArray(w)) return w;
  if (typeof w === "object" && w !== null && Array.isArray(w.packages)) return w.packages;
  return [w];
}
function readWorkspace(dir) {
  const root = (0, import_node_fs.realpathSync)(dir);
  const unreadable = [];
  const manifest = readJson(root, import_node_path.default.join(root, "package.json"), unreadable, "package.json");
  const lock = readJson(root, import_node_path.default.join(root, "package-lock.json"), unreadable, "package-lock.json");
  const workspaces = [];
  for (const pattern of workspacePatterns(manifest)) {
    if (typeof pattern !== "string" || !/^[A-Za-z0-9._@/-]+(\/\*)?$/.test(pattern) || pattern.startsWith("/")) {
      workspaces.push({ rel: String(pattern), problem: "workspace pattern not supported (a folder, or a folder followed by /*)" });
      continue;
    }
    const base = pattern.endsWith("/*") ? pattern.slice(0, -2) : pattern;
    const lexical = import_node_path.default.resolve(root, base);
    let dirs = [];
    try {
      const real = (0, import_node_fs.realpathSync)(lexical);
      if (!inside(real, root) || !inside(lexical, root)) {
        workspaces.push({ rel: pattern, problem: "workspace is outside the checkout" });
        continue;
      }
      dirs = pattern.endsWith("/*") ? (0, import_node_fs.readdirSync)(real, { withFileTypes: true }).filter((entry) => entry.isDirectory() || entry.isSymbolicLink()).map((entry) => import_node_path.default.join(lexical, entry.name)) : [lexical];
    } catch {
      if (!inside(lexical, root)) workspaces.push({ rel: pattern, problem: "workspace is outside the checkout" });
      continue;
    }
    for (const d of dirs) {
      const rel = import_node_path.default.relative(root, d).split(import_node_path.default.sep).join("/");
      let real;
      try {
        real = (0, import_node_fs.realpathSync)(d);
      } catch {
        continue;
      }
      if (!inside(real, root)) {
        workspaces.push({ rel, problem: "workspace is outside the checkout" });
        continue;
      }
      if (!(0, import_node_fs.statSync)(real).isDirectory() || !lstatExists(import_node_path.default.join(real, "package.json"))) continue;
      workspaces.push({ rel, manifest: readJson(root, import_node_path.default.join(real, "package.json"), unreadable, `${rel}/package.json`) });
    }
  }
  return {
    root,
    manifest,
    lock,
    unreadable,
    shrinkwrap: (0, import_node_fs.existsSync)(import_node_path.default.join(root, "npm-shrinkwrap.json")),
    npmrc: lstatExists(import_node_path.default.join(root, ".npmrc")),
    workspaces,
    externalLinks: externalLinks(root)
  };
}
function lstatExists(file) {
  try {
    (0, import_node_fs.lstatSync)(file);
    return true;
  } catch {
    return false;
  }
}
function externalLinks(root) {
  const out = [];
  const walk = (dir) => {
    for (const entry of (0, import_node_fs.readdirSync)(dir, { withFileTypes: true })) {
      const full = import_node_path.default.join(dir, entry.name);
      if (entry.isSymbolicLink()) {
        let target;
        try {
          target = (0, import_node_fs.realpathSync)(full);
        } catch {
          target = import_node_path.default.resolve(dir, (0, import_node_fs.readlinkSync)(full));
        }
        if (!inside(target, root)) out.push(import_node_path.default.relative(root, full));
      } else if (entry.isDirectory() && entry.name !== ".git" && entry.name !== "node_modules") walk(full);
    }
  };
  walk(root);
  return out;
}
var NUM = "0|[1-9]\\d*";
var PRE = "(?:-((?:0|[1-9]\\d*|\\d*[A-Za-z-][0-9A-Za-z-]*)(?:\\.(?:0|[1-9]\\d*|\\d*[A-Za-z-][0-9A-Za-z-]*))*))?";
var BUILD = "(?:\\+[0-9A-Za-z-]+(?:\\.[0-9A-Za-z-]+)*)?";
var FULL = new RegExp(`^v?(${NUM})\\.(${NUM})\\.(${NUM})${PRE}${BUILD}$`);
var XR = "x|X|\\*|" + NUM;
var PARTIAL = new RegExp(`^[v=]*(${XR})(?:\\.(${XR})(?:\\.(${XR})${PRE}${BUILD})?)?$`);
function preIds(s) {
  return s ? s.split(".").map((id) => /^\d+$/.test(id) ? Number(id) : id) : [];
}
function parseVersion(s) {
  const m = FULL.exec(s.trim());
  if (!m) return null;
  const [major, minor, patch] = [Number(m[1]), Number(m[2]), Number(m[3])];
  if (![major, minor, patch].every(Number.isSafeInteger)) return null;
  return { major, minor, patch, pre: preIds(m[4]) };
}
function compare(a, b) {
  for (const k of ["major", "minor", "patch"]) if (a[k] !== b[k]) return a[k] < b[k] ? -1 : 1;
  if (!a.pre.length || !b.pre.length) return a.pre.length === b.pre.length ? 0 : a.pre.length ? -1 : 1;
  for (let i = 0; i < Math.max(a.pre.length, b.pre.length); i++) {
    const x = a.pre[i];
    const y = b.pre[i];
    if (x === void 0) return -1;
    if (y === void 0) return 1;
    if (x === y) continue;
    if (typeof x === "number" && typeof y === "number") return x < y ? -1 : 1;
    if (typeof x === "number") return -1;
    if (typeof y === "number") return 1;
    return x < y ? -1 : 1;
  }
  return 0;
}
var v = (major, minor, patch, pre = []) => ({ major, minor, patch, pre });
var ZERO_PRE = [0];
var isX = (s) => s === void 0 || s === "x" || s === "X" || s === "*";
function desugar(token) {
  const m = /^(\^|~>?|>=|<=|>|<|=)?(.*)$/.exec(token);
  const op = m[1] ?? "";
  const p = PARTIAL.exec(m[2]);
  if (!p) return null;
  const [M, mi, pa] = [p[1], p[2], p[3]];
  const pre = preIds(p[4]);
  if (isX(M) && (!isX(mi) || !isX(pa)) || isX(mi) && !isX(pa)) return null;
  if (isX(M)) {
    if (op === "" || op === "=" || op === ">=" || op === "^" || op.startsWith("~")) return [];
    return null;
  }
  const maj = Number(M);
  const min = isX(mi) ? void 0 : Number(mi);
  const pat = isX(pa) ? void 0 : Number(pa);
  if (min === void 0 && !isX(pa) && pa !== void 0) return null;
  const lower = v(maj, min ?? 0, pat ?? 0, pat === void 0 ? [] : pre);
  if (op === "" || op === "=") {
    if (min === void 0) return [{ op: ">=", v: lower }, { op: "<", v: v(maj + 1, 0, 0, ZERO_PRE) }];
    if (pat === void 0) return [{ op: ">=", v: lower }, { op: "<", v: v(maj, min + 1, 0, ZERO_PRE) }];
    return [{ op: "=", v: lower }];
  }
  if (op.startsWith("~")) {
    if (min === void 0) return [{ op: ">=", v: lower }, { op: "<", v: v(maj + 1, 0, 0, ZERO_PRE) }];
    return [{ op: ">=", v: lower }, { op: "<", v: v(maj, min + 1, 0, ZERO_PRE) }];
  }
  if (op === "^") {
    if (maj > 0 || min === void 0) return [{ op: ">=", v: lower }, { op: "<", v: v(maj + 1, 0, 0, ZERO_PRE) }];
    if (min > 0 || pat === void 0) return [{ op: ">=", v: lower }, { op: "<", v: v(0, min + 1, 0, ZERO_PRE) }];
    return [{ op: ">=", v: lower }, { op: "<", v: v(0, 0, pat + 1, ZERO_PRE) }];
  }
  if (pat !== void 0) return [{ op, v: lower }];
  const next = min === void 0 ? v(maj + 1, 0, 0, ZERO_PRE) : v(maj, min + 1, 0, ZERO_PRE);
  switch (op) {
    case ">=":
      return [{ op: ">=", v: lower }];
    case ">":
      return [{ op: ">=", v: { ...next, pre: [] } }];
    case "<":
      return [{ op: "<", v: v(maj, min ?? 0, 0, ZERO_PRE) }];
    case "<=":
      return [{ op: "<", v: next }];
    default:
      return null;
  }
}
function parseRange(range) {
  if (range.length > 256 || !/^[\sA-Za-z0-9.^~<>=|*+-]*$/.test(range)) return null;
  const sets = [];
  for (const part of range.split("||")) {
    const text2 = part.trim().replace(/(\^|~>?|>=|<=|>|<|=)\s+/g, "$1");
    const hyphen = /^(\S+)\s+-\s+(\S+)$/.exec(text2);
    if (hyphen) {
      const lo = desugar(`>=${hyphen[1]}`);
      const hi = PARTIAL.exec(hyphen[2]);
      if (!lo || !hi || isX(hi[1])) return null;
      const upper = desugar(`<=${hyphen[2]}`);
      if (!upper) return null;
      sets.push([...lo, ...upper]);
      continue;
    }
    const set2 = [];
    for (const token of text2 === "" ? [] : text2.split(/\s+/)) {
      const c = desugar(token);
      if (!c) return null;
      set2.push(...c);
    }
    sets.push(set2);
  }
  return sets;
}
function test(version, c) {
  const d = compare(version, c.v);
  switch (c.op) {
    case "<":
      return d < 0;
    case "<=":
      return d <= 0;
    case ">":
      return d > 0;
    case ">=":
      return d >= 0;
    case "=":
      return d === 0;
  }
}
function satisfies(version, range) {
  const ver = parseVersion(version);
  const sets = parseRange(range);
  if (!ver || !sets) return false;
  return sets.some((set2) => {
    if (!set2.every((c) => test(ver, c))) return false;
    if (!ver.pre.length) return true;
    return set2.some((c) => c.v.pre.length > 0 && c.v.major === ver.major && c.v.minor === ver.minor && c.v.patch === ver.patch);
  });
}
var NAME = /^(?:@[a-z0-9][a-z0-9._~-]*\/)?[a-z0-9][a-z0-9._~-]*$/;
function specOf(name2, spec) {
  if (typeof spec !== "string") return `${name2}: the spec is not a string`;
  if (spec.startsWith("npm:")) {
    const rest = spec.slice(4);
    const at = rest.lastIndexOf("@");
    if (at <= 0) return `${name2}: an npm: alias must name a version range`;
    const target = rest.slice(0, at);
    const range = rest.slice(at + 1);
    if (!NAME.test(target) || parseRange(range) === null) return `${name2}: ${spec} is not an npm: alias to a semver range`;
    return { name: target, range };
  }
  if (parseRange(spec) === null) return `${name2}: ${spec} is not a semver range (git, file, link, URL and tag specs are refused)`;
  return { name: name2, range: spec };
}
function depsOf(manifest, field) {
  const d = typeof manifest === "object" && manifest !== null ? manifest[field] : void 0;
  return typeof d === "object" && d !== null && !Array.isArray(d) ? d : {};
}
function manifestProblems(manifest, where) {
  if (typeof manifest !== "object" || manifest === null || Array.isArray(manifest)) return [`${where}: not a JSON object`];
  const out = [];
  for (const field of DEP_FIELDS) {
    const raw = manifest[field];
    if (raw !== void 0 && (typeof raw !== "object" || raw === null || Array.isArray(raw))) out.push(`${where}: ${field} is not an object`);
    for (const [name2, spec] of Object.entries(depsOf(manifest, field))) {
      if (!NAME.test(name2)) out.push(`${where}: ${name2} is not a package name`);
      const parsed = specOf(name2, spec);
      if (typeof parsed === "string") out.push(`${where}: ${field} ${parsed}`);
    }
  }
  if (Object.hasOwn(manifest, "overrides")) validateOverrides(manifest.overrides, where, out);
  return out;
}
function validateOverrides(overrides, where, out, depth = 0) {
  if (typeof overrides !== "object" || overrides === null || Array.isArray(overrides) || depth > 64) {
    out.push(`${where}: invalid overrides object`);
    return;
  }
  for (const [name2, value] of Object.entries(overrides)) {
    if (typeof value === "object" && value !== null) validateOverrides(value, where, out, depth + 1);
    else if (!(typeof value === "string" && value.startsWith("$") && NAME.test(value.slice(1)))) {
      const spec = specOf(name2, value);
      if (typeof spec === "string") out.push(`${where}: overrides ${spec}`);
    }
  }
}
function registryTarball(value) {
  if (typeof value !== "string" || !value.startsWith(REGISTRY)) return false;
  try {
    const url = new URL(value);
    return url.origin === new URL(REGISTRY).origin && url.username === "" && url.password === "";
  } catch {
    return false;
  }
}
var BAD_LEGACY = /^(?:git\b|git\+|github:|gist:|bitbucket:|gitlab:|file:|link:|https?:|[^@/:]+\/[^@/:])/;
function legacyProblems(deps, trail, out, depth = 0) {
  if (typeof deps !== "object" || deps === null || depth > 64) return;
  for (const [name2, entry] of Object.entries(deps)) {
    if (typeof entry !== "object" || entry === null) {
      out.push(`package-lock.json: dependencies ${trail}${name2} is not an object`);
      continue;
    }
    const e = entry;
    for (const key of ["version", "from"]) {
      if (typeof e[key] === "string" && BAD_LEGACY.test(e[key])) out.push(`package-lock.json: dependencies ${trail}${name2} ${key} ${String(e[key])} is not from the registry`);
    }
    legacyProblems(e.dependencies, `${trail}${name2} > `, out, depth + 1);
  }
}
function lockProblems(ws) {
  const lock = ws.lock;
  if (lock === void 0) return ws.unreadable.includes("package-lock.json") ? [] : ["package-lock.json is required"];
  if (typeof lock !== "object" || lock === null) return ["package-lock.json: not a JSON object"];
  if (lock.lockfileVersion !== 2 && lock.lockfileVersion !== 3 || typeof lock.packages !== "object" || lock.packages === null || Array.isArray(lock.packages)) {
    return [`package-lock.json: lockfileVersion ${String(lock.lockfileVersion)} is not supported (2 or 3 with packages)`];
  }
  const out = [];
  const packages = lock.packages;
  const workspaceFolders = new Set(ws.workspaces.filter((w) => !w.problem).map((w) => w.rel));
  for (const [key, entry] of Object.entries(packages)) {
    const inModules = key.includes("node_modules/");
    const name2 = key === "" ? "<root>" : inModules ? key.slice(key.lastIndexOf("node_modules/") + "node_modules/".length) : key;
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
      out.push(`package-lock.json: ${name2} is not an object`);
      continue;
    }
    out.push(...manifestProblems(entry, `package-lock.json: ${key || "<root>"}`));
    if (key === "") continue;
    if (entry.hasShrinkwrap) {
      out.push(`package-lock.json: ${name2} carries its own shrinkwrap, which is not supported`);
      continue;
    }
    if (entry.link) {
      const target = inModules && entry.link === true && typeof entry.resolved === "string" ? import_node_path.default.posix.normalize(entry.resolved) : "";
      const ok = target !== "" && !target.startsWith("..") && !import_node_path.default.posix.isAbsolute(target) && workspaceFolders.has(target) && packages[target] !== void 0;
      if (!ok) out.push(`package-lock.json: ${name2} links to ${String(entry.resolved)}, not a workspace folder in the checkout`);
      continue;
    }
    if (!inModules) {
      if (!workspaceFolders.has(key)) out.push(`package-lock.json: ${name2} is not a workspace`);
      continue;
    }
    if (entry.inBundle === true && entry.resolved !== void 0) {
      out.push(`package-lock.json: bundled ${name2} has an explicit source (${String(entry.resolved)}), not resolved from ${REGISTRY} by its parent`);
      continue;
    }
    if (entry.resolved === void 0 && entry.inBundle === true) {
      const plainName = entry.name === void 0 || typeof entry.name === "string" && NAME.test(entry.name);
      if (!plainName || typeof entry.version !== "string" || parseVersion(entry.version) === null) {
        out.push(`package-lock.json: ${name2} is bundled but is not a plain name and version (${String(entry.name ?? name2)}@${String(entry.version)})`);
      }
      continue;
    }
    if (!registryTarball(entry.resolved) || typeof entry.integrity !== "string" || !entry.integrity) {
      out.push(`package-lock.json: ${name2} is not resolved from ${REGISTRY} with an integrity hash (${String(entry.resolved)})`);
    }
  }
  legacyProblems(lock.dependencies, "", out);
  for (const workspace of ws.workspaces) {
    if (workspace.problem || typeof workspace.manifest !== "object" || workspace.manifest === null) continue;
    const manifest = workspace.manifest;
    const locked = packages[workspace.rel];
    if (!locked || manifest.version !== locked.version) out.push(`package-lock.json: ${workspace.rel} has a different locked version`);
    for (const field of DEP_FIELDS) {
      const wanted = depsOf(manifest, field);
      const actual = depsOf(locked, field);
      if ([.../* @__PURE__ */ new Set([...Object.keys(wanted), ...Object.keys(actual)])].some((dep) => wanted[dep] !== actual[dep])) {
        out.push(`package-lock.json: ${workspace.rel} has different ${field}`);
      }
    }
  }
  const rootEntry = packages[""] ?? {};
  for (const field of DEP_FIELDS) {
    const wanted = depsOf(ws.manifest, field);
    const locked = depsOf(rootEntry, field);
    const names = /* @__PURE__ */ new Set([...Object.keys(wanted), ...Object.keys(locked)]);
    for (const name2 of names) {
      if (wanted[name2] !== locked[name2]) {
        out.push(`package-lock.json: ${field} ${name2} is ${JSON.stringify(locked[name2])} in the lock and ${JSON.stringify(wanted[name2])} in package.json`);
        continue;
      }
      const spec = specOf(name2, wanted[name2]);
      if (typeof spec === "string") continue;
      const optionalPeer = field === "peerDependencies" && ws.manifest.peerDependenciesMeta?.[name2]?.optional === true;
      const dependency = packages[`node_modules/${name2}`];
      const entry = dependency?.link === true && typeof dependency.resolved === "string" ? packages[import_node_path.default.posix.normalize(dependency.resolved)] : dependency;
      if (!entry) {
        if (!optionalPeer) out.push(`package-lock.json: ${field} ${name2} has no locked version`);
        continue;
      }
      const lockedName = typeof entry.name === "string" ? entry.name : name2;
      if (lockedName !== spec.name) out.push(`package-lock.json: ${name2} is locked as ${lockedName}, not ${spec.name}`);
      if (typeof entry.version !== "string" || !satisfies(entry.version, spec.range)) {
        out.push(`package-lock.json: ${name2} is locked at ${String(entry.version)}, outside ${spec.range}`);
      }
    }
  }
  return out;
}
function installProblems(ws) {
  const out = [];
  for (const name2 of ws.unreadable) out.push(`${name2} must be a valid JSON file inside the checkout`);
  if (ws.manifest === void 0 && !ws.unreadable.includes("package.json")) out.push("package.json is required");
  else if (ws.manifest !== void 0) out.push(...manifestProblems(ws.manifest, "package.json"));
  for (const w of ws.workspaces) {
    if (w.problem) out.push(`${w.rel}: ${w.problem}`);
    else if (w.manifest !== void 0) out.push(...manifestProblems(w.manifest, `${w.rel}/package.json`));
  }
  if (ws.shrinkwrap) out.push("npm-shrinkwrap.json is not supported");
  if (ws.npmrc) out.push("a project .npmrc is not supported (private registries are not supported)");
  for (const link of ws.externalLinks) out.push(`${link} is a symlink that leaves the checkout`);
  out.push(...lockProblems(ws));
  return out;
}
function installEnv(tc, scratch) {
  const npmrc = import_node_path.default.join(scratch, "npmrc");
  const globalNpmrc = import_node_path.default.join(scratch, "npmrc-global");
  (0, import_node_fs.mkdirSync)(import_node_path.default.join(scratch, "home"), { recursive: true });
  for (const file of [npmrc, globalNpmrc]) (0, import_node_fs.writeFileSync)(file, `registry=${REGISTRY}
`);
  return {
    PATH: `${import_node_path.default.join(tc.nodeDir, "bin")}:/usr/bin:/bin`,
    HOME: import_node_path.default.join(scratch, "home"),
    npm_config_userconfig: npmrc,
    npm_config_globalconfig: globalNpmrc,
    npm_config_registry: REGISTRY,
    npm_config_git: "/bin/false",
    npm_config_script_shell: "/bin/false",
    npm_config_ignore_scripts: "true",
    npm_config_cache: import_node_path.default.join(scratch, "cache"),
    npm_config_install_links: "false",
    npm_config_audit: "false",
    npm_config_fund: "false",
    npm_config_update_notifier: "false"
  };
}
function trustedToolchain(nodeDir, ws, supported = SUPPORTED_TOOLCHAIN, toolCache = process.env.RUNNER_TOOL_CACHE) {
  const fail = (why) => {
    throw new InstallRefused([why]);
  };
  const root = (0, import_node_fs.realpathSync)(ws);
  if (!toolCache) return fail("RUNNER_TOOL_CACHE is required");
  let dir;
  let node;
  let npmCli;
  let npmPkg;
  try {
    const cache = (0, import_node_fs.realpathSync)(toolCache);
    dir = (0, import_node_fs.realpathSync)(nodeDir);
    if (inside(cache, root) || inside(root, cache) || !supported.some(({ node: version }) => dir === import_node_path.default.join(cache, "node", version, process.arch))) {
      return fail("Node must come from the runner's pinned setup-node toolcache");
    }
  } catch (error) {
    if (error instanceof InstallRefused) throw error;
    return fail(`cannot resolve the runner toolcache or ${nodeDir}`);
  }
  try {
    node = (0, import_node_fs.realpathSync)(import_node_path.default.join(nodeDir, "bin/node"));
    npmCli = (0, import_node_fs.realpathSync)(import_node_path.default.join(nodeDir, "lib/node_modules/npm/bin/npm-cli.js"));
    npmPkg = (0, import_node_fs.realpathSync)(import_node_path.default.join(nodeDir, "lib/node_modules/npm/package.json"));
  } catch {
    return fail(`no node and npm in ${nodeDir}`);
  }
  for (const [label, file] of [["node", node], ["npm", npmCli], ["npm", npmPkg], ["the toolchain", dir]]) {
    if (inside(file, root) || inside(root, file)) fail(`${label} must not come from the workspace (${file})`);
    if (!inside(file, dir)) fail(`${label} must sit inside ${dir} (${file})`);
  }
  const nodeVersion = (0, import_node_child_process2.execFileSync)(node, ["--version"], { encoding: "utf8", env: {}, timeout: 1e4 }).trim().replace(/^v/, "");
  const npmVersion = String(JSON.parse((0, import_node_fs.readFileSync)(npmPkg, "utf8")).version);
  if (import_node_path.default.basename(import_node_path.default.dirname(dir)) !== nodeVersion) fail(`node ${nodeVersion} disagrees with its pinned toolcache directory`);
  if (!supported.some((s) => s.node === nodeVersion && s.npm === npmVersion)) fail(`npm ${npmVersion} with node ${nodeVersion} is not a supported toolchain`);
  return { nodeDir: dir, node, npmCli, nodeVersion, npmVersion };
}
async function sha256File(file, signal) {
  const hash = (0, import_node_crypto6.createHash)("sha256");
  for await (const chunk of (0, import_node_fs.createReadStream)(file, { signal })) hash.update(chunk);
  return hash.digest("hex");
}
function netnsPrefix(o) {
  if (!Number.isSafeInteger(o.uid) || o.uid < 0 || !Number.isSafeInteger(o.gid) || o.gid < 0) throw new InstallRefused(["the runner's uid and gid must be whole numbers"]);
  return ["/usr/bin/sudo", "-n", "/usr/bin/unshare", "--net", "--", "/usr/bin/setpriv", `--reuid=${o.uid}`, `--regid=${o.gid}`, "--init-groups", "--pdeathsig", "SIGKILL", "/usr/bin/env", "-i"];
}
function offlineInstallArgv(tc, cache, scratch, o) {
  const env = { ...installEnv(tc, scratch), npm_config_cache: cache, npm_config_offline: "true", npm_config_logs_dir: import_node_path.default.join(scratch, "logs") };
  const [file, ...prefix] = netnsPrefix(o);
  const vars = Object.entries(env).map(([k, v2]) => `${k}=${v2}`);
  return { file, args: [...prefix, ...vars, tc.node, tc.npmCli, "ci", "--offline", "--ignore-scripts", "--no-audit", "--no-fund", "--cache", cache], env };
}
async function verifyRecipeCache(cache, tc, lock, signal) {
  const { packages } = lock;
  const checked = /* @__PURE__ */ new Set();
  const cacheDir = import_node_path.default.join(cache, "_cacache");
  const requireFromNpm = (0, import_node_module.createRequire)(tc.npmCli);
  for (const [name2, entry] of Object.entries(packages)) {
    if (!registryTarball(entry.resolved) || typeof entry.integrity !== "string" || checked.has(entry.integrity)) continue;
    signal?.throwIfAborted();
    const cacache = requireFromNpm("cacache");
    const stream = cacache.get.stream.byDigest(cacheDir, entry.integrity);
    const abort = () => stream.destroy(new Error("cache verification cancelled"));
    signal?.addEventListener("abort", abort, { once: true });
    try {
      for await (const _chunk of stream) signal?.throwIfAborted();
      signal?.throwIfAborted();
      checked.add(entry.integrity);
    } catch {
      signal?.throwIfAborted();
      throw new Error(`install_failed: cached tarball missing or corrupt for ${name2}`);
    } finally {
      signal?.removeEventListener("abort", abort);
    }
  }
}
async function offlinePreinstall(ws, tc, scratch, o, timeoutMs = INSTALL_MS, signal) {
  signal?.throwIfAborted();
  let cache;
  try {
    cache = (0, import_node_fs.realpathSync)(o.cache);
    if (!(0, import_node_fs.statSync)(cache).isDirectory()) throw new Error("not a directory");
  } catch {
    throw new InstallRefused(["the recipe's npm cache is missing"]);
  }
  const workspace = readWorkspace(ws);
  const problems = installProblems(workspace);
  if (problems.length > 0) throw new InstallRefused(problems);
  await verifyRecipeCache(cache, tc, workspace.lock, signal);
  signal?.throwIfAborted();
  const { file, args } = offlineInstallArgv(tc, cache, scratch, o);
  await runNpm(file, args, { cwd: ws, env: { PATH: "/usr/bin:/bin" } }, timeoutMs, signal);
  return digestsOf(ws, signal);
}
async function digestsOf(ws, signal) {
  signal?.throwIfAborted();
  return {
    lock: await sha256File(import_node_path.default.join(ws, "package-lock.json"), signal),
    hiddenLock: (0, import_node_fs.existsSync)(import_node_path.default.join(ws, "node_modules/.package-lock.json")) ? await sha256File(import_node_path.default.join(ws, "node_modules/.package-lock.json"), signal) : "",
    tree: await treeDigest(ws, signal)
  };
}
function runNpm(file, args, o, timeoutMs, signal) {
  return new Promise((resolve, reject) => {
    const child = (0, import_node_child_process2.spawn)(file, args, { cwd: o.cwd, env: o.env, stdio: ["ignore", "pipe", "pipe"], shell: false, timeout: timeoutMs, killSignal: "SIGKILL", signal });
    for (const stream of [child.stdout, child.stderr]) {
      stream.setEncoding("utf8");
      let pending = "";
      stream.on("data", (chunk) => {
        pending += chunk;
        const lines = pending.split("\n");
        pending = lines.pop() ?? "";
        for (const line of lines) process.stderr.write(`${neutralize(line.slice(0, 4096))}
`);
      });
    }
    let spawnError;
    child.once("error", (error) => {
      spawnError = error;
    });
    child.once("close", (code, exitSignal) => {
      if (signal?.aborted) reject(signal.reason);
      else if (spawnError) reject(spawnError);
      else if (code === 0) resolve();
      else reject(new Error(`install_failed: npm ci exited ${code ?? exitSignal}`));
    });
  });
}
async function treeDigest(ws, signal) {
  signal?.throwIfAborted();
  const root = (0, import_node_fs.realpathSync)(ws);
  const hash = (0, import_node_crypto6.createHash)("sha256");
  const walk = async (dir, rel) => {
    const names = (await (0, import_promises3.readdir)(dir)).sort();
    for (const name2 of names) {
      signal?.throwIfAborted();
      if (rel === "" && name2 === ".git") continue;
      const full = import_node_path.default.join(dir, name2);
      const relPath = rel ? `${rel}/${name2}` : name2;
      const st = await (0, import_promises3.lstat)(full);
      const mode = (st.mode & 4095).toString(8);
      if (st.isSymbolicLink()) hash.update(`L\0${relPath}\0${mode}\0${await (0, import_promises3.readlink)(full)}
`);
      else if (st.isDirectory()) {
        hash.update(`D\0${relPath}\0${mode}
`);
        await walk(full, relPath);
      } else if (st.isFile()) hash.update(`F\0${relPath}\0${mode}\0${st.size}\0${await sha256File(full, signal)}
`);
      else hash.update(`O\0${relPath}\0${mode}\0${st.mode >>> 12}
`);
    }
  };
  await walk(root, "");
  signal?.throwIfAborted();
  return hash.digest("hex");
}
var SHA2 = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/;
var REF = /^refs\/[A-Za-z0-9._/-]+$/;
function checkoutHead(ws) {
  const git = import_node_path.default.join(ws, ".git");
  const head = (0, import_node_fs.readFileSync)(import_node_path.default.join(git, "HEAD"), "utf8").trim();
  if (SHA2.test(head)) return head;
  const m = /^ref: (\S+)$/.exec(head);
  const ref = m?.[1];
  if (!ref || !REF.test(ref) || ref.split("/").some((part) => part === ".." || part === "." || part === "")) throw new Error(`checkout_changed: HEAD is not a ref this action reads (${head.slice(0, 100)})`);
  const loose = import_node_path.default.join(git, ref);
  if ((0, import_node_fs.existsSync)(loose)) {
    const sha2 = (0, import_node_fs.readFileSync)(loose, "utf8").trim();
    if (SHA2.test(sha2)) return sha2;
    throw new Error(`checkout_changed: ${ref} does not hold a commit`);
  }
  const packed = (0, import_node_fs.existsSync)(import_node_path.default.join(git, "packed-refs")) ? (0, import_node_fs.readFileSync)(import_node_path.default.join(git, "packed-refs"), "utf8").split("\n") : [];
  for (const line of packed) {
    const [sha2, name2] = line.split(" ");
    if (name2 === ref && sha2 && SHA2.test(sha2)) return sha2;
  }
  throw new Error(`checkout_changed: ${ref} is not found`);
}

// src/load/jail.ts
var import_node_child_process3 = require("node:child_process");
var import_node_crypto7 = require("node:crypto");
var import_node_fs2 = require("node:fs");
var import_promises4 = require("node:fs/promises");
var import_node_os3 = __toESM(require("node:os"));
var import_node_stream = require("node:stream");
var import_node_string_decoder = require("node:string_decoder");
var import_node_net3 = __toESM(require("node:net"));
var import_node_util2 = require("node:util");

// src/load/jail/ctl.ts
var MAX_FRAME_BYTES = 64 * 1024;
var MAX_MESSAGE = 2e3;
var MAX_LOCATION = 500;
var TO_EXECUTOR = /* @__PURE__ */ new Set(["init", "turn", "cancel", "stop"]);
var TO_SUPERVISOR = /* @__PURE__ */ new Set(["loaded", "fatal", "outcome"]);
function relayable(frame, from) {
  return (from === "supervisor" ? TO_EXECUTOR : TO_SUPERVISOR).has(frame.type);
}
function encode(frame) {
  return `${JSON.stringify(frame)}
`;
}
var isSafePositive = (v2) => Number.isSafeInteger(v2) && v2 > 0;
var isSafeCount = (v2) => Number.isSafeInteger(v2) && v2 >= 0;
var isFinitePositive = (v2) => typeof v2 === "number" && Number.isFinite(v2) && v2 > 0;
var isText = (v2, max, min = 0) => typeof v2 === "string" && v2.length >= min && v2.length <= max;
var isCode = (v2) => v2 === null || Number.isSafeInteger(v2);
var isSignal = (v2) => v2 === null || isText(v2, 32, 1);
var PASSWORD = /^[A-Za-z0-9_-]{43}$/;
var NONCE = /^[0-9a-f]{64}$/;
var IDENT = /^[A-Za-z_$][A-Za-z0-9_$]{0,255}$/;
function ticketOf(v2) {
  if (typeof v2 !== "object" || v2 === null) return null;
  const t = v2;
  if (!isText(t.claimId, 256, 1) || !isSafeCount(t.epoch) || !isText(t.planHash, 256, 1) || !isSafeCount(t.leaseSeq) || !isText(t.nonce, 256, 1)) return null;
  if (!isFinitePositive(t.monoDeadline) || !isFinitePositive(t.wallDeadline)) return null;
  return { claimId: t.claimId, epoch: t.epoch, planHash: t.planHash, leaseSeq: t.leaseSeq, nonce: t.nonce, monoDeadline: t.monoDeadline, wallDeadline: t.wallDeadline };
}
function optional(v2, name2, max) {
  if (v2[name2] === void 0) return {};
  return isText(v2[name2], max) ? { [name2]: v2[name2] } : null;
}
function decode(line) {
  let value;
  try {
    value = JSON.parse(line);
  } catch {
    return null;
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const v2 = value;
  switch (v2.type) {
    case "hello":
      return typeof v2.nonce === "string" && NONCE.test(v2.nonce) ? { type: "hello", nonce: v2.nonce } : null;
    case "ready":
    case "launched":
    case "stop":
      return { type: v2.type };
    case "start":
    case "launch": {
      const ticket = ticketOf(v2.ticket);
      return ticket ? { type: v2.type, ticket } : null;
    }
    case "refused":
      return v2.reason === "stale_ticket" || v2.reason === "used_ticket" || v2.reason === "foreign_ticket" || v2.reason === "early_ticket" ? { type: "refused", reason: v2.reason } : null;
    case "installed":
      return isCode(v2.code) && isSignal(v2.signal) && typeof v2.ms === "number" && Number.isFinite(v2.ms) && v2.ms >= 0 ? { type: "installed", code: v2.code, signal: v2.signal, ms: v2.ms } : null;
    case "exit":
      return isCode(v2.code) && isSignal(v2.signal) ? { type: "exit", code: v2.code, signal: v2.signal } : null;
    case "init": {
      const j = v2.journey;
      if (typeof j !== "object" || j === null || !isText(j.module, 1024, 1) || typeof j.export !== "string" || !IDENT.test(j.export)) return null;
      if (!isText(v2.baseURL, 2048, 1) || !isText(v2.proxy, 256, 1) || !isFinitePositive(v2.renewEveryMs)) return null;
      if (!Number.isInteger(v2.parallel) || v2.parallel < 1 || v2.parallel > 8) return null;
      return { type: "init", journey: { module: j.module, export: j.export }, baseURL: v2.baseURL, proxy: v2.proxy, renewEveryMs: v2.renewEveryMs, parallel: v2.parallel };
    }
    case "turn":
      if (!isSafePositive(v2.turn) || !isSafePositive(v2.slot) || typeof v2.password !== "string" || !PASSWORD.test(v2.password) || !isFinitePositive(v2.deadlineMono)) return null;
      return { type: "turn", turn: v2.turn, slot: v2.slot, password: v2.password, deadlineMono: v2.deadlineMono };
    case "cancel":
      return isSafePositive(v2.turn) ? { type: "cancel", turn: v2.turn } : null;
    case "loaded":
      return isText(v2.playwright, 64, 1) ? { type: "loaded", playwright: v2.playwright } : null;
    case "fatal": {
      if (v2.code !== "unreadable" && v2.code !== "playwright" && v2.code !== "journey" && v2.code !== "protocol") return null;
      const location = optional(v2, "location", MAX_LOCATION);
      if (!isText(v2.message, MAX_MESSAGE) || !location) return null;
      return { type: "fatal", code: v2.code, message: v2.message, ...location };
    }
    case "outcome": {
      if (!isSafePositive(v2.turn) || v2.kind !== "success" && v2.kind !== "failure" && v2.kind !== "timeout" && v2.kind !== "cancelled") return null;
      const message = optional(v2, "message", MAX_MESSAGE);
      const location = optional(v2, "location", MAX_LOCATION);
      if (!message || !location) return null;
      return { type: "outcome", turn: v2.turn, kind: v2.kind, ...message, ...location };
    }
    default:
      return null;
  }
}
var LineSplitter = class {
  buffer = "";
  /** Bytes after the last newline: at end of input, a frame cut short. */
  get incomplete() {
    return this.buffer !== "";
  }
  push(chunk) {
    this.buffer += chunk;
    const lines = this.buffer.split("\n");
    this.buffer = lines.pop() ?? "";
    if (Buffer.byteLength(this.buffer) > MAX_FRAME_BYTES || lines.some((line) => Buffer.byteLength(line) > MAX_FRAME_BYTES)) return null;
    return lines;
  }
};
function sameNonce(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

// src/load/jail.ts
var exec = (0, import_node_util2.promisify)(import_node_child_process3.execFile);
var HOST_ENV = { PATH: "/usr/sbin:/usr/bin:/sbin:/bin" };
var HEARTBEAT_MS = 1e3;
var STOP_GRACE_MS = 2e3;
var EMPTY_WAIT_MS = 3e3;
var READY_MS = 6e4;
var CALL_MS = 15e3;
var INSTALL_MS2 = 15 * 6e4;
var RELAY_URL = `http://127.0.0.1:${IN_JAIL.relayPort}`;
var TicketRefused = class extends Error {
  constructor(reason) {
    super(`load jail: init refused the ticket (${reason})`);
    this.reason = reason;
    this.name = "TicketRefused";
  }
};
var NoTicket = class extends Error {
  constructor() {
    super("load jail: no ticket (the lease is not held, or a stop was asked for)");
    this.name = "NoTicket";
  }
};
async function startJail(spec, options, signal) {
  if (signal?.aborted) throw abortError2(signal);
  const problems = specProblems(spec);
  if (problems.length > 0) throw new Error(`load jail: ${problems.join("; ")}`);
  for (const tree of [spec.workspace, spec.nodeDir, spec.actionDir]) await refuseSpecialFiles(tree);
  const unit = unitName(spec.runId);
  const dir = socketDir(spec.runId);
  const nonce = (0, import_node_crypto7.randomBytes)(32).toString("hex");
  await removeStale(unit, dir, spec.runId);
  let proxy;
  const ctlServer = import_node_net3.default.createServer();
  const proxySockets = /* @__PURE__ */ new Set();
  try {
    await sudo("/usr/bin/mkdir", "-m", "0700", dir);
    await sudo("/usr/bin/chown", String(process.getuid()), dir);
    signal?.throwIfAborted();
    proxy = await options.listenProxy(`${dir}/proxy.sock`);
    proxy.on("connection", (socket) => {
      proxySockets.add(socket);
      socket.once("close", () => proxySockets.delete(socket));
    });
    await new Promise((resolve, reject) => ctlServer.once("error", reject).listen(`${dir}/ctl.sock`, resolve));
    await sudo("/usr/bin/chown", `root:${RELAY_UID}`, dir, `${dir}/proxy.sock`);
    await sudo("/usr/bin/chown", "root:root", `${dir}/ctl.sock`);
    await sudo("/usr/bin/chmod", "0660", `${dir}/proxy.sock`);
    await sudo("/usr/bin/chmod", "0600", `${dir}/ctl.sock`);
    await sudo("/usr/bin/chmod", "0710", dir);
    signal?.throwIfAborted();
  } catch (error) {
    proxy?.close();
    ctlServer.close();
    await sudo("/usr/bin/rm", "-rf", dir).catch(() => void 0);
    throw error;
  }
  const gate = proxy;
  const ctl = acceptCtl(ctlServer, nonce);
  ctl.catch(() => void 0);
  const child = (0, import_node_child_process3.spawn)("/usr/bin/sudo", ["-n", ...systemdRunArgs(spec)], { env: HOST_ENV, stdio: ["pipe", "pipe", "pipe"] });
  const stdout = neutralized(child.stdout);
  const stderr = neutralized(child.stderr);
  if (options.stdout !== "pipe") stdout.pipe(process.stdout);
  stderr.pipe(process.stderr);
  const lifeline = child.stdin;
  lifeline.on("error", () => void 0);
  lifeline.write(`${nonce}
`);
  const heartbeat = setInterval(() => lifeline.write("\n"), HEARTBEAT_MS);
  const cgroup = controlGroup(unit);
  let ending;
  const end = () => ending ??= (async () => {
    const t0 = performance.now();
    clearInterval(heartbeat);
    gate.close();
    for (const socket of proxySockets) socket.destroy();
    lifeline.destroy();
    ctlServer.close();
    const group = await cgroup;
    if (!group || !await becomesInactive(unit, STOP_GRACE_MS)) await sudo("/usr/bin/systemctl", "stop", `${unit}.service`).catch(() => void 0);
    const clean = group ? await cgroupEmpties(group, EMPTY_WAIT_MS) : await childGone(child, EMPTY_WAIT_MS) && await becomesInactive(unit, 0);
    await sudo("/usr/bin/rm", "-rf", dir, rootDir(spec.runId)).catch(() => void 0);
    return { clean, ms: Math.round(performance.now() - t0) };
  })();
  const died = new Promise((_, reject) => {
    child.once("exit", (code) => reject(new Error(`load jail ended before it was ready (${code})`)));
    child.once("error", reject);
  });
  died.catch(() => void 0);
  child.once("exit", () => void end());
  child.once("error", () => void end());
  const late = new Promise((_, reject) => {
    const timer = setTimeout(() => reject(new Error(`load jail was not ready within ${READY_MS / 1e3} s`)), READY_MS);
    timer.unref();
    void Promise.race([ctl.then((c) => c.ready), died]).finally(() => clearTimeout(timer)).catch(() => void 0);
  });
  const ready = Promise.race([ctl.then((c) => c.ready), died, late]);
  ready.catch(() => void 0);
  const exited = new Promise((resolve) => {
    ctl.then((c) => c.exit.then(resolve), () => resolve({ code: null, signal: null }));
    died.catch(() => setTimeout(() => resolve({ code: null, signal: null }), 100));
  });
  let terminal;
  const terminalWaiters = /* @__PURE__ */ new Set();
  const latch = (error) => {
    if (terminal) return;
    terminal = error;
    for (const w of terminalWaiters) w(error);
    terminalWaiters.clear();
  };
  died.catch((e) => latch(e));
  child.once("exit", () => latch(new Error("load jail ended")));
  void ctl.then((c) => c.closed.then(() => latch(new Error("load jail's control socket closed"))), (e) => latch(e));
  void exited.then(() => latch(new Error("load jail's executor exited")));
  const bounded = (p, ms2, what, signal2) => new Promise((resolve, reject) => {
    if (terminal) return reject(terminal);
    if (signal2?.aborted) return reject(abortError2(signal2));
    const timer = setTimeout(() => done(() => reject(new Error(`load jail: no ${what} within ${Math.round(ms2 / 1e3)} s`))), ms2);
    const onTerminal = (e) => done(() => reject(e));
    const onAbort = () => done(() => reject(abortError2(signal2)));
    const done = (settle) => {
      clearTimeout(timer);
      terminalWaiters.delete(onTerminal);
      signal2?.removeEventListener("abort", onAbort);
      settle();
    };
    terminalWaiters.add(onTerminal);
    signal2?.addEventListener("abort", onAbort, { once: true });
    p.then((v2) => done(() => resolve(v2)), (e) => done(() => reject(e)));
  });
  const nextOf = (types) => ctl.then(
    (c) => new Promise((resolve) => {
      const off = c.onFrame((f) => {
        if (!types.includes(f.type)) return;
        off();
        resolve(f);
      });
    })
  );
  let installed;
  let launched;
  const sendTicket = (c, type, ticketOf2) => {
    if (ending !== void 0) throw new Error("load jail is ending");
    const ticket = ticketOf2();
    if (ticket === null) throw new NoTicket();
    c.send({ type, ticket });
  };
  const start = (ticketOf2, signal2) => {
    if (installed) return Promise.reject(new Error("load jail: start was already called"));
    installed = (async () => {
      await bounded(ready, READY_MS, "ready", signal2);
      const c = await ctl;
      const answer = nextOf(["installed", "refused"]);
      sendTicket(c, "start", ticketOf2);
      const f = await bounded(answer, INSTALL_MS2, "install", signal2);
      if (f.type === "refused") {
        installed = void 0;
        throw new TicketRefused(f.reason);
      }
      if (f.type !== "installed") throw new Error(`load jail: unexpected ${f.type}`);
      return { code: f.code, signal: f.signal, ms: f.ms };
    })();
    installed.catch(() => void 0);
    return installed;
  };
  const launch = (ticketOf2, signal2) => {
    if (!installed) return Promise.reject(new Error("load jail: launch before start"));
    if (launched) return Promise.reject(new Error("load jail: launch was already called"));
    const after = installed;
    launched = (async () => {
      await bounded(after, INSTALL_MS2, "install", signal2);
      const c = await ctl;
      const answer = nextOf(["launched", "refused"]);
      sendTicket(c, "launch", ticketOf2);
      const f = await bounded(answer, CALL_MS, "launch", signal2);
      if (f.type === "refused") {
        launched = void 0;
        throw new TicketRefused(f.reason);
      }
    })();
    launched.catch(() => void 0);
    return launched;
  };
  const handle = {
    unit,
    ready,
    start,
    launch,
    send: (frame) => {
      if (!relayable(frame, "supervisor")) throw new Error(`load jail: ${frame.type} is not a frame for the executor`);
      void ctl.then((c) => ending === void 0 && c.send(frame), () => void 0);
    },
    onFrame: (listener) => {
      let off;
      let removed = false;
      void ctl.then((c) => {
        if (!removed) off = c.onFrame(listener);
      }, () => void 0);
      return () => {
        removed = true;
        off?.();
      };
    },
    relayUrl: RELAY_URL,
    exited,
    end,
    stdout: options.stdout === "pipe" ? stdout : null
  };
  if (signal) {
    if (signal.aborted) {
      await end();
      throw abortError2(signal);
    }
    signal.addEventListener("abort", () => void end(), { once: true });
  }
  return handle;
}
var PROBE_MOUNTS = /^\/(usr|bin|sbin|lib\w*|etc\/[\w.]+|dev(\/\w+)?|tmp|proc|run\/peeps\/[\w-]+)?$/;
async function probe(base, runId, signal) {
  const ip = nonLoopbackIPv4();
  const hits = [];
  const listener = import_node_net3.default.createServer((c) => {
    c.once("data", (d) => {
      hits.push(String(d).split("\r\n")[0]);
      c.end("HTTP/1.0 200 OK\r\nContent-Length: 2\r\n\r\nok");
    });
    c.on("error", () => void 0);
  });
  await new Promise((resolve) => listener.listen(0, ip, resolve));
  const target = `${ip}:${listener.address().port}`;
  const forward = (path4) => new Promise((resolve) => {
    const server = import_node_net3.default.createServer((c) => {
      const u = import_node_net3.default.connect(listener.address().port, ip);
      c.pipe(u).pipe(c);
      u.on("error", () => c.destroy());
      c.on("error", () => u.destroy());
    });
    server.listen(path4, () => resolve(server));
  });
  const spec = { ...base, runId, claimId: `probe-${runId}`, command: [`${IN_JAIL.node}/bin/node`, `${IN_JAIL.action}/load-init.js`, "--probe", target] };
  let out = "";
  try {
    const handle = await startJail(spec, { listenProxy: forward, stdout: "pipe" }, signal);
    handle.stdout.setEncoding("utf8");
    handle.stdout.on("data", (d) => out += d);
    const ticket = () => {
      const now = sharedClocks();
      return { claimId: spec.claimId, epoch: 0, planHash: "probe", leaseSeq: 0, nonce: (0, import_node_crypto7.randomBytes)(16).toString("hex"), monoDeadline: now.monoMs + CALL_MS, wallDeadline: now.wallMs + CALL_MS };
    };
    try {
      await handle.start(ticket, signal);
      await handle.launch(ticket, signal);
      await handle.exited;
    } finally {
      const end = await handle.end();
      if (!end.clean) out += "\nPEEPS-PROBE-UNCLEAN\n";
    }
  } finally {
    listener.close();
  }
  const line = out.split("\n").map((l) => l.replace(/^jail\| /, "")).find((l) => l.startsWith("PEEPS-PROBE "));
  let seen = null;
  try {
    seen = line ? JSON.parse(line.slice("PEEPS-PROBE ".length)) : null;
  } catch {
    seen = null;
  }
  const failures = [];
  if (!seen) failures.push("the probe printed no report");
  else {
    const expect = (ok, what) => !ok && failures.push(what);
    expect(seen.uid === base.executorUid, "it did not run as the executor's uid");
    expect(seen.relay === "connected", "the relay did not connect");
    expect(seen.direct !== "connected", "a direct connection got out");
    expect(seen.dns !== "resolved", "DNS resolved");
    expect(seen.unixProxy === "EACCES", "the proxy socket was reachable");
    expect(Array.isArray(seen.hostPaths) && seen.hostPaths.length === 0, "host paths are visible");
    expect(seen.procOne === "EACCES" && seen.procOneRoot === "EACCES", "init's /proc entry is readable");
    expect(seen.procSelf === "readable", "/proc does not work");
    expect(Array.isArray(seen.mounts) && seen.mounts.every((m) => PROBE_MOUNTS.test(m) && !/ws-lower|\/up$/.test(m)), "mounts outside the manifest are visible");
    expect(seen.workspaceWrite === "written" && !(0, import_node_fs2.existsSync)(`${base.workspace}/.peeps-probe`), "a write reached the checkout");
  }
  if (out.includes("PEEPS-PROBE-UNCLEAN")) failures.push("the unit's cgroup was not empty after end()");
  if (hits.length !== 1 || hits[0] !== "GET /probe-relay HTTP/1.0") failures.push(`the listener saw ${JSON.stringify(hits)}`);
  return { passed: failures.length === 0, failures, seen };
}
function nonLoopbackIPv4() {
  for (const list of Object.values(import_node_os3.default.networkInterfaces())) {
    for (const a of list ?? []) if (a.family === "IPv4" && !a.internal) return a.address;
  }
  throw new Error("load jail probe: no non-loopback IPv4 address");
}
function abortError2(signal) {
  const reason = signal.reason;
  return reason instanceof Error ? reason : new Error("load jail: aborted");
}
var MAX_LINE = 64 * 1024;
function neutralized(source) {
  const out = new import_node_stream.PassThrough();
  const decoder = new import_node_string_decoder.StringDecoder("utf8");
  let pending = "";
  const emit = (line) => {
    if (!out.write(`${neutralize(line.endsWith("\r") ? line.slice(0, -1) : line)}
`)) {
      source.pause();
      out.once("drain", () => source.resume());
    }
  };
  source.on("data", (chunk) => {
    pending += decoder.write(chunk);
    let nl;
    while ((nl = pending.indexOf("\n")) !== -1) {
      emit(pending.slice(0, nl));
      pending = pending.slice(nl + 1);
    }
    while (pending.length > MAX_LINE) {
      emit(pending.slice(0, MAX_LINE));
      pending = pending.slice(MAX_LINE);
    }
  });
  source.on("end", () => {
    pending += decoder.end();
    if (pending) emit(pending);
    out.end();
  });
  return out;
}
async function refuseSpecialFiles(tree) {
  if (await (0, import_promises4.realpath)(tree) !== tree) throw new Error(`load jail: ${tree} must not go through a symlink`);
  const { stdout } = await exec("/usr/bin/find", [tree, "-xdev", "(", "-type", "s", "-o", "-type", "p", "-o", "-type", "b", "-o", "-type", "c", ")", "-print", "-quit"], { env: HOST_ENV, timeout: CALL_MS });
  if (stdout.trim()) throw new Error(`load jail: ${tree} holds a socket, FIFO or device (${stdout.trim()})`);
}
async function removeStale(unit, dir, runId) {
  if (!await becomesInactive(unit, 0)) throw new Error(`load jail: ${unit} is still running`);
  await sudo("/usr/bin/rm", "-rf", dir, rootDir(runId));
}
function acceptCtl(server, nonce) {
  const others = /* @__PURE__ */ new Set();
  return new Promise((resolve, reject) => {
    server.on("error", reject);
    server.on("connection", (socket) => {
      others.add(socket);
      socket.once("close", () => others.delete(socket));
      const lines = new LineSplitter();
      let hello = false;
      let markReady;
      let failReady;
      let markExit;
      let markClosed;
      const ready = new Promise((r, j) => (markReady = r, failReady = j));
      ready.catch(() => void 0);
      const exit = new Promise((r) => markExit = r);
      const closed = new Promise((r) => markClosed = r);
      const listeners = /* @__PURE__ */ new Set();
      socket.setEncoding("utf8");
      socket.setTimeout(1e4, () => !hello && socket.destroy());
      socket.on("error", () => socket.destroy());
      socket.on("data", (chunk) => {
        const got = lines.push(chunk);
        if (got === null) return socket.destroy();
        for (const line of got) {
          const frame = decode(line);
          if (!hello) {
            if (frame?.type !== "hello" || !sameNonce(frame.nonce, nonce)) return socket.destroy();
            hello = true;
            socket.setTimeout(0);
            socket.once("close", () => {
              failReady(new Error("load jail's init closed its control socket before ready"));
              markClosed();
            });
            server.close();
            others.delete(socket);
            for (const other of others) other.destroy();
            resolve({
              ready,
              exit,
              closed,
              send: (f) => void (socket.writable && socket.write(encode(f))),
              onFrame: (l) => (listeners.add(l), () => void listeners.delete(l))
            });
            continue;
          }
          if (!frame) return socket.destroy();
          if (frame.type === "ready") markReady();
          else if (frame.type === "exit") markExit({ code: frame.code, signal: frame.signal });
          for (const l of [...listeners]) l(frame);
        }
      });
    });
  });
}
async function sudo(...args) {
  await exec("/usr/bin/sudo", ["-n", ...args], { env: HOST_ENV, timeout: CALL_MS });
}
async function controlGroup(unit) {
  for (let i = 0; i < 50; i++) {
    const { stdout } = await exec("/usr/bin/systemctl", ["show", "-p", "ControlGroup", "--value", `${unit}.service`], { env: HOST_ENV, timeout: CALL_MS }).catch(() => ({ stdout: "" }));
    if (stdout.trim()) return stdout.trim();
    await sleep3(100);
  }
  return "";
}
async function becomesInactive(unit, ms2) {
  const until = performance.now() + ms2;
  do {
    const { stdout } = await exec("/usr/bin/systemctl", ["is-active", `${unit}.service`], { env: HOST_ENV, timeout: CALL_MS }).catch((e) => ({ stdout: e.stdout ?? "" }));
    if (["inactive", "failed"].includes(stdout.trim())) return true;
    await sleep3(100);
  } while (performance.now() < until);
  return false;
}
async function cgroupEmpties(cgroup, ms2) {
  const until = performance.now() + ms2;
  do {
    const events = await (0, import_promises4.readFile)(`/sys/fs/cgroup${cgroup}/cgroup.events`, "utf8").catch((e) => e.code === "ENOENT" ? "gone" : "");
    if (events === "gone" || /^populated 0$/m.test(events)) return true;
    await sleep3(100);
  } while (performance.now() < until);
  return false;
}
async function childGone(child, ms2) {
  if (child.exitCode !== null || child.signalCode !== null) return true;
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(false), ms2);
    child.once("exit", () => (clearTimeout(timer), resolve(true)));
  });
}
function sleep3(ms2) {
  return new Promise((resolve) => setTimeout(resolve, ms2));
}

// src/load/lease.ts
var MAX_REMAINING_MS = 6e3;
var RunnerLease = class {
  /**
   * `sent` and `received` are the claim request's send and reply times. The wall offset and
   * round trip are measured once, here.
   */
  constructor(claim, sent, received) {
    this.claim = claim;
    this.binding = { ...claim.binding };
    this.offsetMs = claim.serverNowMs - (sent.wallMs + received.wallMs) / 2;
    this.rttMs = Math.max(0, received.monoMs - sent.monoMs);
    this.renewEveryMs = claim.renewEveryMs;
    this.lastServerNowMs = claim.serverNowMs;
    this.remainingMs = wellFormed(claim) && Number.isFinite(claim.renewEveryMs) && claim.renewEveryMs > 0 ? remaining(claim) : 0;
    this.current = this.grant(claim, 0, sent, this.remainingMs);
    if (!(this.remainingMs > 0) || !live(this.current, received)) this.lose();
  }
  offsetMs;
  rttMs;
  renewEveryMs;
  current;
  binding;
  remainingMs;
  lastServerNowMs;
  lastSeq = 0;
  /** The highest seq allocated, answered or not: a `closed` goes after it, never on it. */
  allocated = 0;
  inFlight;
  lostFlag = false;
  closedTx;
  closedAckedFlag = false;
  get grantNow() {
    return { ...this.current };
  }
  get lost() {
    return this.lostFlag;
  }
  get outstanding() {
    return this.inFlight;
  }
  get lastAllocatedSeq() {
    return this.allocated;
  }
  /** A matching receipt acknowledged the `closed` renewal. */
  get closedAcked() {
    return this.closedAckedFlag;
  }
  /** Whether the lease is still running at `t`. Once either clock passes its deadline it is lost for good. */
  held(t) {
    if (this.lostFlag) return false;
    if (live(this.current, t)) return true;
    this.lose();
    return false;
  }
  /**
   * Starts the next renewal. One at a time: refused while one is in flight or the lease is lost.
   * The seq, the hash and the body are allocated together and stored once (frozen).
   */
  begin(t, nonce, build) {
    if (this.lostFlag || this.inFlight || this.closedTx || !this.held(t)) return null;
    const seq2 = this.lastSeq + 1;
    this.allocated = Math.max(this.allocated, seq2);
    const { requestHash, body } = build(seq2, nonce);
    this.inFlight = Object.freeze({ seq: seq2, nonce, requestHash, body: String(body), firstSendMono: t.monoMs, firstSendWall: t.wallMs });
    return this.inFlight;
  }
  /**
   * The release-bearing `closed` renewal (e5 plan §2.4): allowed whether or not the lease is
   * held, once. Its seq follows the last one allocated, so an abandoned seq (which Peeps may or
   * may not have seen) is skipped, never reused. The lease is over on the runner from here: a
   * renewal still outstanding is dropped, and no renewal follows. Its deadline is the caller's
   * (the reporting deadline), not the lease's.
   */
  beginClosed(t, nonce, build) {
    if (this.closedTx) return null;
    this.inFlight = void 0;
    if (!this.lostFlag) this.lose();
    const seq2 = this.allocated + 1;
    this.allocated = seq2;
    const { requestHash, body } = build(seq2, nonce);
    this.closedTx = Object.freeze({ seq: seq2, nonce, requestHash, body: String(body), firstSendMono: t.monoMs, firstSendWall: t.wallMs });
    return this.closedTx;
  }
  /** Whether `receipt` acknowledges the `closed` renewal sent. It is read only as that: it changes no deadline. */
  ackClosed(receipt) {
    const tx = this.closedTx;
    const b = this.binding;
    if (!tx || receipt.closed !== true || receipt.claimId !== b.claimId || receipt.epoch !== b.epoch || receipt.planHash !== b.planHash || receipt.seq !== tx.seq || receipt.nonce !== tx.nonce) return false;
    this.closedAckedFlag = true;
    return true;
  }
  /** Whether the in-flight renewal may be sent again (identical bytes): only inside the lease it was first sent under. */
  mayRetry(t) {
    return this.inFlight !== void 0 && this.held(t);
  }
  /** When to send the next renewal, after one sent at `prevSendMono` was answered at `prevAnswerMono`. */
  nextSendAt(prevSendMono, prevAnswerMono) {
    return Math.max(prevSendMono + Math.min(this.renewEveryMs, this.remainingMs / 2), prevAnswerMono);
  }
  /** The renewal timed out or failed for good: the gate closes without waiting for HTTP. */
  abandon() {
    this.inFlight = void 0;
    this.lose();
  }
  apply(reply, t) {
    const tx = this.inFlight;
    const b = this.binding;
    if (reply.claimId !== b.claimId || reply.epoch !== b.epoch || reply.planHash !== b.planHash) return { kind: "ignored", reason: "binding" };
    if (!tx || reply.seq !== tx.seq) return { kind: "ignored", reason: "seq" };
    if (reply.nonce !== tx.nonce) return { kind: "ignored", reason: "nonce" };
    this.inFlight = void 0;
    this.lastSeq = tx.seq;
    if (this.lostFlag) return { kind: "lost", stop: void 0 };
    if (!this.held(t)) return this.lose(void 0);
    if (reply.lease !== "held" || reply.stop?.mode === "now") return this.lose(reply.stop);
    if (!wellFormed(reply)) {
      if (reply.stop || this.shortens(reply, tx)) return this.lose(reply.stop);
      return rejected("malformed", void 0);
    }
    if (reply.serverNowMs < this.lastServerNowMs) return this.lose(reply.stop);
    const rem = remaining(reply);
    if (!(rem > 0)) return this.lose(reply.stop);
    const grant = this.grant(reply, tx.seq, { monoMs: tx.firstSendMono, wallMs: tx.firstSendWall }, rem);
    if (!live(grant, t)) return this.lose(reply.stop);
    this.lastServerNowMs = reply.serverNowMs;
    this.remainingMs = rem;
    this.current = grant;
    return { kind: "lease", grant: { ...grant }, stop: reply.stop };
  }
  /** Whether the readable part of a malformed reply would end the lease earlier than the grant held. */
  shortens(reply, tx) {
    const bounds = [reply.ttlMs, reply.leaseUntilServerMs - reply.serverNowMs].filter(Number.isFinite);
    const rem = Math.min(MAX_REMAINING_MS, ...bounds);
    if (tx.firstSendMono + rem < this.current.monoUntil || tx.firstSendWall + rem < this.current.wallUntil) return true;
    const wall = reply.leaseUntilServerMs - this.offsetMs - this.rttMs / 2;
    return Number.isFinite(wall) && wall < this.current.wallUntil;
  }
  /** Both deadlines run at most `rem` from the first send, so the wall clock backstops the monotonic one. */
  grant(lease, seq2, firstSend, rem) {
    return {
      seq: seq2,
      monoUntil: firstSend.monoMs + rem,
      wallUntil: Math.min(lease.leaseUntilServerMs - this.offsetMs - this.rttMs / 2, firstSend.wallMs + rem),
      ceiling: lease.ceiling
    };
  }
  lose(stop) {
    this.lostFlag = true;
    this.current = { ...this.current, seq: this.current.seq + 1, monoUntil: Number.NEGATIVE_INFINITY, wallUntil: Number.NEGATIVE_INFINITY };
    return { kind: "lost", stop };
  }
};
function live(g, t) {
  return t.monoMs < g.monoUntil && t.wallMs < g.wallUntil;
}
function rejected(reason, stop) {
  return stop ? { kind: "rejected", reason, stop } : { kind: "rejected", reason };
}
function wellFormed(lease) {
  return [lease.ttlMs, lease.leaseUntilServerMs, lease.serverNowMs].every(Number.isFinite) && Number.isSafeInteger(lease.ceiling) && lease.ceiling >= 0;
}
function remaining(lease) {
  return Math.min(lease.ttlMs, lease.leaseUntilServerMs - lease.serverNowMs, MAX_REMAINING_MS);
}

// src/load/scheduler.ts
var ceilDiv = (a, b) => Math.ceil(a / b);
function userEpochs(input) {
  const closed = [];
  const active = [];
  let stageStart = 0;
  const retire = (at) => {
    const userId = active.length;
    const activeFromMs = active.pop();
    if (activeFromMs !== void 0) closed.push({ userId, activeFromMs, activeUntilMs: at });
  };
  const settleAt = (users, at) => {
    while (active.length < users) active.push(at);
    while (active.length > users) retire(at);
  };
  for (const stage of input.stages) {
    const duration = stage.durationMs;
    settleAt(stage.fromUsers, stageStart);
    const n = Math.abs(stage.toUsers - stage.fromUsers);
    if (stage.toUsers > stage.fromUsers) {
      for (let j = 1; j <= n; j++) active.push(stageStart + Math.floor(j * duration / n));
    } else if (stage.toUsers < stage.fromUsers) {
      for (let j = 1; j <= n; j++) retire(stageStart + duration - Math.floor((n - j + 1) * duration / n));
    }
    stageStart += duration;
  }
  settleAt(0, stageStart);
  return closed.sort((a, b) => a.activeFromMs - b.activeFromMs || a.userId - b.userId);
}
function ticksInWindow(epoch, pacingEveryMs, fromMs, untilMs) {
  const lo = Math.max(fromMs, epoch.activeFromMs);
  const hi = Math.min(untilMs, epoch.activeUntilMs);
  if (hi <= lo) return 0;
  return ceilDiv(hi - epoch.activeFromMs, pacingEveryMs) - ceilDiv(lo - epoch.activeFromMs, pacingEveryMs);
}
function scheduleStageStarts(input) {
  const epochs = userEpochs(input);
  const out = [];
  let startMs = 0;
  for (const stage of input.stages) {
    const untilMs = startMs + stage.durationMs;
    let starts = 0;
    for (const epoch of epochs) starts += ticksInWindow(epoch, input.pacingEveryMs, startMs, untilMs);
    out.push(starts);
    startMs = untilMs;
  }
  return out;
}
function stageAt(stageEnds, atMs) {
  for (let i = 0; i < stageEnds.length; i++) if (atMs < stageEnds[i]) return i;
  return -1;
}
var Scheduler = class {
  constructor(input, startSlackMs) {
    this.input = input;
    this.startSlackMs = startSlackMs;
    this.epochs = userEpochs(input);
    this.next = this.epochs.map(() => 0);
    let end = 0;
    this.stageEnds = input.stages.map((stage) => end += stage.durationMs);
    this.endMs = end;
  }
  epochs;
  /** Per epoch: the next tick index not yet decided. */
  next;
  stageEnds;
  endMs;
  /** Every tick due at or before `nowMs` that has not been decided: started, or missed. */
  poll(nowMs, isBusy) {
    const starts = [];
    const missed = [];
    const pacing = this.input.pacingEveryMs;
    const nowStage = stageAt(this.stageEnds, nowMs);
    this.epochs.forEach((epoch, i) => {
      if (nowMs < epoch.activeFromMs) return;
      const lastDueAt = Math.min(nowMs, epoch.activeUntilMs - 1);
      if (lastDueAt < epoch.activeFromMs) return;
      const latest = Math.floor((lastDueAt - epoch.activeFromMs) / pacing);
      for (let k = this.next[i]; k <= latest; k++) {
        const dueMs = epoch.activeFromMs + k * pacing;
        const dueStage = stageAt(this.stageEnds, dueMs);
        if (k < latest) {
          missed.push({ userId: epoch.userId, dueMs, stage: dueStage, reason: "late" });
          continue;
        }
        if (nowMs - dueMs > this.startSlackMs) missed.push({ userId: epoch.userId, dueMs, stage: dueStage, reason: "late" });
        else if (dueStage !== nowStage) missed.push({ userId: epoch.userId, dueMs, stage: dueStage, reason: "boundary" });
        else if (isBusy(epoch.userId)) missed.push({ userId: epoch.userId, dueMs, stage: dueStage, reason: "busy" });
        else starts.push({ userId: epoch.userId, dueMs, stage: nowStage });
      }
      this.next[i] = Math.max(this.next[i], latest + 1);
    });
    const order = (a, b) => a.dueMs - b.dueMs || a.userId - b.userId;
    return { starts: starts.sort(order), missed: missed.sort(order) };
  }
  /** Whether every tick has been decided. */
  finished(nowMs) {
    return nowMs >= this.endMs;
  }
  /** When the next undecided tick is due, or null when none is left. */
  nextDueMs() {
    let best = null;
    this.epochs.forEach((epoch, i) => {
      const dueMs = epoch.activeFromMs + this.next[i] * this.input.pacingEveryMs;
      if (dueMs < epoch.activeUntilMs && (best === null || dueMs < best)) best = dueMs;
    });
    return best;
  }
};

// src/load/plan-input.ts
var PLAN_PROTOCOL_VERSION = 1;
var PLAN_BOUNDS = {
  maxStages: 20,
  maxDurationMs: 60 * 60 * 1e3,
  maxUsers: 1e3,
  minPacingMs: 1e3,
  maxPlannedStarts: 1e6,
  maxPerJourney: 1e3,
  maxAllowedRequests: 50,
  maxOrigins: 20,
  maxText: 512
};
var ALLOWED_METHODS = /* @__PURE__ */ new Set(["POST", "PUT", "PATCH", "DELETE"]);
var IDENTIFIER = /^[A-Za-z_$][\w$]*$/;
var Check = class {
  errors = [];
  fail(at, message) {
    this.errors.push(`${at}: ${message}`);
  }
  object(value, at, keys) {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      this.fail(at, "must be an object");
      return null;
    }
    const obj = value;
    for (const key of Object.keys(obj)) if (!keys.includes(key)) this.fail(`${at}.${key}`, "is not a known field");
    for (const key of keys) if (!(key in obj)) this.fail(`${at}.${key}`, "is missing");
    return obj;
  }
  int(value, at, min, max) {
    if (typeof value !== "number" || !Number.isSafeInteger(value)) {
      this.fail(at, "must be a whole number");
      return null;
    }
    if (value < min || value > max) {
      this.fail(at, `must be between ${min} and ${max}`);
      return null;
    }
    return value;
  }
  text(value, at) {
    if (typeof value !== "string" || value.length === 0 || value.length > PLAN_BOUNDS.maxText) {
      this.fail(at, `must be text of 1 to ${PLAN_BOUNDS.maxText} characters`);
      return null;
    }
    return value;
  }
  literal(value, at, expected) {
    if (value !== expected) {
      this.fail(at, `must be ${JSON.stringify(expected)}`);
      return null;
    }
    return expected;
  }
  array(value, at, min, max) {
    if (!Array.isArray(value)) {
      this.fail(at, "must be a list");
      return null;
    }
    if (value.length < min || value.length > max) {
      this.fail(at, `must hold ${min} to ${max} entries`);
      return null;
    }
    return value;
  }
};
function isContainedModulePath(module2) {
  if (module2.length === 0 || module2.length > PLAN_BOUNDS.maxText) return false;
  if (module2.startsWith("/") || module2.startsWith("~") || /^[A-Za-z]:/.test(module2)) return false;
  if (module2.includes("\\") || module2.includes("\0") || module2.includes("//")) return false;
  return module2.split("/").every((segment) => segment !== "" && segment !== "." && segment !== "..");
}
function isCanonicalOrigin(origin) {
  let url;
  try {
    url = new URL(origin);
  } catch {
    return false;
  }
  return (url.protocol === "https:" || url.protocol === "http:") && url.origin === origin;
}
var STAGE_KEYS = ["name", "kind", "startMs", "durationMs", "fromUsers", "toUsers", "plannedStarts"];
var PLAN_KEYS = [
  "protocolVersion",
  "journey",
  "cohort",
  "durationMs",
  "peakUsers",
  "plannedStarts",
  "requests",
  "allowedRequests",
  "onReduced"
];
var LIMITS_KEYS = ["allowedOrigins", "maxUsers", "requestBudget", "policyRevision"];
function checkPlan(c, raw) {
  const plan = c.object(raw, "plan", PLAN_KEYS);
  if (!plan) return;
  c.literal(plan.protocolVersion, "plan.protocolVersion", PLAN_PROTOCOL_VERSION);
  c.literal(plan.onReduced, "plan.onReduced", "refuse");
  const journey = c.object(plan.journey, "plan.journey", ["module", "export"]);
  if (journey) {
    const module2 = c.text(journey.module, "plan.journey.module");
    if (module2 !== null && !isContainedModulePath(module2)) {
      c.fail("plan.journey.module", "must be a path inside the repository");
    }
    const name2 = c.text(journey.export, "plan.journey.export");
    if (name2 !== null && !IDENTIFIER.test(name2)) c.fail("plan.journey.export", "must be an export name");
  }
  const cohort = c.object(plan.cohort, "plan.cohort", ["kind", "demand", "pacingEveryMs", "stages"]);
  let stagesOk = false;
  let sumDuration = 0;
  let sumStarts = 0;
  let peak = 0;
  const stages = [];
  let pacing = null;
  if (cohort) {
    c.literal(cohort.kind, "plan.cohort.kind", "protocol");
    c.literal(cohort.demand, "plan.cohort.demand", "users");
    pacing = c.int(cohort.pacingEveryMs, "plan.cohort.pacingEveryMs", PLAN_BOUNDS.minPacingMs, PLAN_BOUNDS.maxDurationMs);
    const list = c.array(cohort.stages, "plan.cohort.stages", 1, PLAN_BOUNDS.maxStages);
    if (list) {
      stagesOk = true;
      list.forEach((rawStage, i) => {
        const at = `plan.cohort.stages[${i}]`;
        const before = c.errors.length;
        const stage = c.object(rawStage, at, STAGE_KEYS);
        if (!stage) {
          stagesOk = false;
          return;
        }
        c.text(stage.name, `${at}.name`);
        if (stage.kind !== "ramp" && stage.kind !== "hold") c.fail(`${at}.kind`, 'must be "ramp" or "hold"');
        const startMs = c.int(stage.startMs, `${at}.startMs`, 0, PLAN_BOUNDS.maxDurationMs);
        const durationMs2 = c.int(stage.durationMs, `${at}.durationMs`, 1, PLAN_BOUNDS.maxDurationMs);
        const fromUsers = c.int(stage.fromUsers, `${at}.fromUsers`, 0, PLAN_BOUNDS.maxUsers);
        const toUsers = c.int(stage.toUsers, `${at}.toUsers`, 0, PLAN_BOUNDS.maxUsers);
        c.int(stage.plannedStarts, `${at}.plannedStarts`, 0, PLAN_BOUNDS.maxPlannedStarts);
        if (stage.kind === "hold" && fromUsers !== null && toUsers !== null && fromUsers !== toUsers) {
          c.fail(at, "a hold keeps the same number of users");
        }
        if (startMs !== null && startMs !== sumDuration) c.fail(`${at}.startMs`, `must be ${sumDuration}, where the stage before ends`);
        if (c.errors.length !== before) {
          stagesOk = false;
          return;
        }
        sumDuration += durationMs2;
        sumStarts += stage.plannedStarts;
        peak = Math.max(peak, fromUsers, toUsers);
        stages.push(stage);
      });
    }
  }
  const durationMs = c.int(plan.durationMs, "plan.durationMs", 1, PLAN_BOUNDS.maxDurationMs);
  const peakUsers = c.int(plan.peakUsers, "plan.peakUsers", 1, PLAN_BOUNDS.maxUsers);
  const plannedStarts = c.int(plan.plannedStarts, "plan.plannedStarts", 1, PLAN_BOUNDS.maxPlannedStarts);
  if (stagesOk && durationMs !== null && sumDuration !== durationMs) c.fail("plan.durationMs", `must be the stages' total, ${sumDuration}`);
  if (stagesOk && sumDuration > PLAN_BOUNDS.maxDurationMs) c.fail("plan.cohort.stages", "must add up to 60 min or less");
  if (stagesOk && peakUsers !== null && peak !== peakUsers) c.fail("plan.peakUsers", `must be the stages' peak, ${peak}`);
  if (stagesOk && plannedStarts !== null && sumStarts !== plannedStarts) c.fail("plan.plannedStarts", `must be the stages' total, ${sumStarts}`);
  if (stagesOk && pacing !== null && sumDuration <= PLAN_BOUNDS.maxDurationMs) {
    const expected = scheduleStageStarts({ pacingEveryMs: pacing, stages });
    stages.forEach((stage, i) => {
      if (stage.plannedStarts !== expected[i]) {
        c.fail(`plan.cohort.stages[${i}].plannedStarts`, `must be ${expected[i]}, what the schedule produces`);
      }
    });
  }
  const requests = c.object(plan.requests, "plan.requests", ["perJourneyMax", "ceiling"]);
  if (requests) {
    const perJourney = c.int(requests.perJourneyMax, "plan.requests.perJourneyMax", 1, PLAN_BOUNDS.maxPerJourney);
    const ceiling = c.int(requests.ceiling, "plan.requests.ceiling", 1, Number.MAX_SAFE_INTEGER);
    if (perJourney !== null && ceiling !== null && plannedStarts !== null && perJourney * plannedStarts !== ceiling) {
      c.fail("plan.requests.ceiling", "must be plannedStarts \xD7 perJourneyMax");
    }
  }
  const allowed = c.array(plan.allowedRequests, "plan.allowedRequests", 0, PLAN_BOUNDS.maxAllowedRequests);
  if (allowed) {
    const seen = /* @__PURE__ */ new Set();
    allowed.forEach((rawRequest, i) => {
      const at = `plan.allowedRequests[${i}]`;
      const request2 = c.object(rawRequest, at, ["method", "path"]);
      if (!request2) return;
      if (typeof request2.method !== "string" || !ALLOWED_METHODS.has(request2.method)) {
        c.fail(`${at}.method`, "must be POST, PUT, PATCH or DELETE");
      }
      const path4 = c.text(request2.path, `${at}.path`);
      if (path4 !== null && (!path4.startsWith("/") || /[?#\s\\]/.test(path4))) {
        c.fail(`${at}.path`, "must be a path starting with /, without a query or fragment");
      }
      const key = `${String(request2.method)} ${String(request2.path)}`;
      if (seen.has(key)) c.fail(at, "is listed twice");
      seen.add(key);
    });
  }
}
function checkLimits(c, raw) {
  const limits = c.object(raw, "limits", LIMITS_KEYS);
  if (!limits) return;
  const origins = c.array(limits.allowedOrigins, "limits.allowedOrigins", 1, PLAN_BOUNDS.maxOrigins);
  if (origins) {
    const seen = /* @__PURE__ */ new Set();
    origins.forEach((origin, i) => {
      if (typeof origin !== "string" || !isCanonicalOrigin(origin)) {
        c.fail(`limits.allowedOrigins[${i}]`, "must be an exact origin such as https://staging.example.com");
      }
      if (seen.has(origin)) c.fail(`limits.allowedOrigins[${i}]`, "is listed twice");
      seen.add(origin);
    });
  }
  c.int(limits.maxUsers, "limits.maxUsers", 1, PLAN_BOUNDS.maxUsers);
  c.int(limits.requestBudget, "limits.requestBudget", 1, Number.MAX_SAFE_INTEGER);
  c.int(limits.policyRevision, "limits.policyRevision", 0, Number.MAX_SAFE_INTEGER);
}
function validatePlanInput(raw) {
  const c = new Check();
  const input = c.object(raw, "input", ["plan", "limits"]);
  if (!input) return { ok: false, errors: c.errors };
  checkPlan(c, input.plan);
  checkLimits(c, input.limits);
  if (c.errors.length === 0) {
    const { plan, limits } = input;
    if (plan.peakUsers > limits.maxUsers) c.fail("plan.peakUsers", `is more than the environment allows (${limits.maxUsers})`);
    if (plan.requests.ceiling > limits.requestBudget) {
      c.fail("plan.requests.ceiling", `is more than the environment's request budget (${limits.requestBudget})`);
    }
  }
  if (c.errors.length > 0) return { ok: false, errors: c.errors };
  return { ok: true, value: structuredClone(input) };
}

// src/load/supervisor.ts
var SUPERVISOR_CONSTANTS = {
  loadedMs: 6e4,
  reportingMs: 1e4,
  hardReportingMs: 2e3,
  intervalMs: 1e4,
  tickMs: 50,
  renewAttemptMs: 1e3,
  outcomeTimeoutMs: 5e3,
  maxBatchBytes: EVENTS_BATCH_MAX_BYTES,
  maxEventsBodyBytes: EVENTS_BODY_MAX_BYTES,
  retryMs: 100,
  retryMaxMs: 2e3
};
var Refused = class extends Error {
  constructor(status, reason, detail) {
    super(`${reason}${detail ? `: ${detail}` : ""}`);
    this.status = status;
    this.reason = reason;
  }
};
async function runLoad(o, s = {}) {
  return new LoadRun(o, s).run();
}
var sha256Of = (file) => (0, import_node_crypto8.createHash)("sha256").update((0, import_node_fs3.readFileSync)(file)).digest("hex");
async function bindingOf(workspace, workloadPath, tree, signal) {
  signal?.throwIfAborted();
  const lock = import_node_path2.default.join(workspace, "package-lock.json");
  const generated = import_node_path2.default.join(workspace, "node_modules/.package-lock.json");
  return {
    checkoutSha: checkoutHead(workspace),
    lockDigests: { "package-lock.json": (0, import_node_fs3.existsSync)(lock) ? sha256Of(lock) : "" },
    observed: { treeDigest: tree ?? await treeDigest(workspace, signal), generatedLockDigest: (0, import_node_fs3.existsSync)(generated) ? sha256Of(generated) : "" },
    workload: { path: workloadPath, digest: sha256Of(import_node_path2.default.resolve(workspace, workloadPath)) }
  };
}
var sameBinding = (a, b) => JSON.stringify(sortKeys(a)) === JSON.stringify(sortKeys(b));
function sortKeys(v2) {
  if (Array.isArray(v2)) return v2.map(sortKeys);
  if (v2 && typeof v2 === "object") return Object.fromEntries(Object.keys(v2).sort().map((k) => [k, sortKeys(v2[k])]));
  return v2;
}
function sanitize(text2, max = 500) {
  if (text2 === void 0) return null;
  return text2.replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g, "").replace(/::/g, ": :").slice(0, max);
}
var LoadRun = class {
  constructor(o, s) {
    this.o = o;
    this.s = s;
    this.clocks = s.clocks ?? sharedClocks;
    this.k = { ...SUPERVISOR_CONSTANTS, ...pick(s.constants, Object.keys(SUPERVISOR_CONSTANTS)) };
    this.engine = { ...ENGINE_LIMITS, ...pick(s.constants, Object.keys(ENGINE_LIMITS)) };
    this.signal = o.signal ? AbortSignal.any([o.signal, this.internal.signal]) : this.internal.signal;
    this.emit = (e) => {
      try {
        o.observer?.(e);
      } catch {
      }
    };
    this.accounting = new Accounting(this.k.intervalMs);
    this.terminated = new Promise((resolve) => this.resolveTerminated = resolve);
  }
  clocks;
  k;
  engine;
  internal = new AbortController();
  signal;
  emit;
  claimId = null;
  grant;
  lease;
  gate;
  journal;
  proxy;
  jail;
  limits;
  plan;
  runEndMono = Number.POSITIVE_INFINITY;
  runEndWall = Number.POSITIVE_INFINITY;
  caDir;
  /** Latches. */
  reason;
  status;
  expiryObserved = false;
  stopNowLive = false;
  gracefulStop = false;
  phase = "starting";
  renewController = new AbortController();
  renewing = false;
  renewInFlight;
  renewTimer;
  renewState = "running";
  renewals = { sent: 0, states: [], afterTerminate: 0 };
  watchTimer;
  tickTimer;
  graceEnd;
  /** The drain's own end, before `alignDrain` brings it forward to a lease Peeps capped. */
  drainLimit;
  /** The end of the last lease applied (`grantNow` reads -Infinity once the lease is lost). */
  leaseUntil;
  /** How long a drain may take: the grant's grace, never longer than a measured turn's deadline (also how long a cohort waits to be sealed). */
  drainGraceMs = 0;
  /** Per allocated renewal: its attempts, the ms from first send to the applied answer, and the outcome. */
  latency = /* @__PURE__ */ new Map();
  /** Measured starts' lag behind their due tick, on the plan's clock, for `lagP99Ms`. */
  startLags = [];
  loopDelay = (0, import_node_perf_hooks.monitorEventLoopDelay)({ resolution: 10 });
  closedOutcome = { state: "none", attempts: 0, latencyMs: null };
  closedCancel = new AbortController();
  credentials = /* @__PURE__ */ new Map();
  turns = /* @__PURE__ */ new Map();
  busySlots = /* @__PURE__ */ new Map();
  duplicateOutcomes = 0;
  failures = [];
  playwright = null;
  checking = { turns: 0, success: 0, failure: 0, timeout: 0, cancelled: 0, responded: [] };
  measurement = { started: 0, missed: 0, success: 0, failure: 0, timeout: 0, cancelled: 0 };
  accounting;
  measureStartMono = 0;
  measureStartWall;
  measureEndWall;
  scheduler;
  lastSnapshot;
  terminated;
  resolveTerminated;
  proxyClosed;
  jailEnded;
  jailLaunchPending = false;
  /** The launch was attempted: from then on only an ended, clean jail proves nothing of this run is left. */
  launchCalled = false;
  gateClosed = false;
  outcomeWaiters = /* @__PURE__ */ new Set();
  hard = false;
  hardTimer;
  resolveHardLimit;
  hardLimit = new Promise((resolve) => {
    this.resolveHardLimit = resolve;
  });
  // Evidence: one ordered stream, one batch in flight.
  streamId = (0, import_node_crypto8.randomUUID)();
  evidenceSeq = 0;
  evidenceQueue = [];
  evidenceRunning;
  evidenceStopped = false;
  evidenceCancel = new AbortController();
  incomplete;
  finalSent;
  async run() {
    const onAbort = () => this.terminate("cancelled");
    if (this.signal.aborted) onAbort();
    else this.signal.addEventListener("abort", onAbort, { once: true });
    const onHard = () => this.hardCancel();
    if (this.o.hardSignal?.aborted) onHard();
    else this.o.hardSignal?.addEventListener("abort", onHard, { once: true });
    this.loopDelay.enable();
    try {
      await Promise.race([this.execute(), this.hardLimit]);
      await this.terminated;
      return await this.finish();
    } finally {
      this.loopDelay.disable();
      clearTimeout(this.hardTimer);
      this.signal.removeEventListener("abort", onAbort);
      this.o.hardSignal?.removeEventListener("abort", onHard);
    }
  }
  async execute() {
    try {
      this.throwIfDone();
      const report = await (this.s.probe ? this.s.probe() : this.realProbe());
      this.throwIfDone();
      if (!report.passed) throw new Refused("didnt_start", "fence_unverified", report.failures.join("; "));
      const digests = await (this.s.preinstall ? this.s.preinstall(this.o.workspace) : this.realPreinstall());
      const binding = await bindingOf(this.o.workspace, this.o.workloadPath, digests.tree, this.signal);
      this.throwIfDone();
      await this.claim(binding, report);
      await this.prepare(binding);
      await this.startup();
      await this.runChecking();
      await this.runMeasurement();
    } catch (error) {
      if (error instanceof Refused) this.terminate(error.reason, error.status);
      else if (error instanceof NoTicket) this.terminate("didnt_start", "didnt_start");
      else if (error instanceof TicketRefused) this.terminate(error.reason === "stale_ticket" ? "didnt_start" : "executor_protocol", error.reason === "stale_ticket" ? "didnt_start" : "failed");
      else if (this.reason === void 0) this.terminate("startup_failed", "failed", error.message);
    }
  }
  throwIfDone() {
    if (this.reason !== void 0) throw new Refused(this.status ?? "failed", this.reason);
  }
  async realProbe() {
    const node = import_node_path2.default.join(this.o.nodeDir, "bin", "node");
    return probe(
      { node, nodeDir: this.o.nodeDir, actionDir: this.o.actionDir, outer: import_node_path2.default.join(this.o.actionDir, "load-outer.js"), init: import_node_path2.default.join(this.o.actionDir, "load-init.js"), workspace: this.o.workspace, executorUid: process.getuid(), executorGid: process.getgid(), env: {}, limits: { maxRunMs: 6e4, memoryMax: "512M", tasksMax: 64, cpuQuotaPercent: 100 } },
      `${this.o.runId}-probe`.slice(0, 40),
      this.signal
    );
  }
  /** Offline, from the recipe's npm cache, with no network interface (e5 plan v3 §2.10). */
  async realPreinstall() {
    this.signal.throwIfAborted();
    if (!this.o.npmCache) throw new Refused("didnt_start", "install_unsupported", "no recipe npm cache");
    const scratch = (0, import_node_fs3.mkdtempSync)(import_node_path2.default.join(import_node_os4.default.tmpdir(), "peeps-load-install-"));
    try {
      return await offlinePreinstall(this.o.workspace, trustedToolchain(this.o.nodeDir, this.o.workspace), scratch, { cache: this.o.npmCache, uid: process.getuid(), gid: process.getgid() }, void 0, this.signal);
    } catch (error) {
      throw new Refused("didnt_start", error instanceof InstallRefused ? "install_unsupported" : "install_failed", error.message);
    } finally {
      (0, import_node_fs3.rmSync)(scratch, { recursive: true, force: true });
    }
  }
  // ---------------------------------------------------------------- claim and the lease controller
  async claim(binding, report) {
    const labels = await (this.s.labels ? this.s.labels() : hostLabels());
    this.throwIfDone();
    const built = claimBody({
      grantRef: this.o.grantRef,
      actionVersion: this.o.actionVersion ?? "0.0.0",
      idempotencyKey: (0, import_node_crypto8.randomUUID)(),
      runAttempt: this.o.runAttempt ?? 1,
      checkRunId: this.o.checkRunId ?? 0,
      binding,
      probe: { passed: report.passed, failures: report.failures },
      labels
    });
    if (!built.ok) throw new Refused("didnt_start", "claim_invalid", built.problem);
    const body = built.body;
    const sent = this.clocks();
    const raw = await this.o.port.claim(body, this.signal);
    const received = this.clocks();
    this.throwIfDone();
    const reply = decodeClaimReply(raw);
    if (!reply.ok) throw new Refused("didnt_start", `claim_${reply.refused}`);
    const g = reply.grant;
    this.grant = g;
    this.claimId = g.claimId;
    const claimGrant = { binding: { claimId: g.claimId, epoch: g.epoch, planHash: g.planHash }, nonce: g.lease.nonce, renewEveryMs: g.lease.renewEveryMs, ttlMs: g.lease.ttlMs, ceiling: g.lease.ceiling, leaseUntilServerMs: g.lease.leaseUntilServerMs, serverNowMs: g.lease.serverNowMs };
    this.lease = new RunnerLease(claimGrant, sent, received);
    const hardRemainingMs = g.hardEndServerMs - g.lease.serverNowMs;
    this.runEndMono = sent.monoMs + hardRemainingMs;
    this.runEndWall = sent.wallMs + hardRemainingMs;
    this.emit({ type: "claimed", claimId: g.claimId });
    if (this.lease.lost) throw new Refused("lease_lost", "lease_lost");
    this.renewing = true;
    this.scheduleRenew(sent.monoMs, received.monoMs);
    this.armWatch();
  }
  scheduleRenew(prevSendMono, prevAnswerMono) {
    if (!this.renewing || !this.lease) return;
    const at = this.lease.nextSendAt(prevSendMono, prevAnswerMono);
    const delay2 = Math.max(0, at - this.clocks().monoMs);
    this.renewTimer = setTimeout(() => {
      this.renewTimer = void 0;
      this.renewInFlight = this.renewOnce().catch(() => void 0).finally(() => this.renewInFlight = void 0);
    }, delay2);
  }
  renewFields(seq2, nonce) {
    const gate = this.gate;
    return renewBody({
      epoch: this.grant.epoch,
      seq: seq2,
      nonce,
      phase: this.phase,
      debited: gate?.admitted ?? 0,
      unresolved: gate?.unresolved ?? 0,
      inFlight: gate?.inFlight ?? 0,
      state: this.renewState,
      lagP99Ms: this.lagP99Ms()
    });
  }
  /** The p99 (nearest rank) of measured starts' lag behind their due tick over the last interval, in whole ms. */
  lagP99Ms() {
    if (this.phase !== "measurement" || this.startLags.length === 0) return 0;
    const since = this.clocks().monoMs - this.measureStartMono - this.k.intervalMs;
    while (this.startLags.length && this.startLags[0].atMs < since) this.startLags.shift();
    const lags = this.startLags.map((x) => x.lagMs).sort((a, b) => a - b);
    const p = nearestRank(lags, 0.99);
    return p === void 0 ? 0 : Math.max(0, Math.ceil(p));
  }
  /** One renewal, retried with identical bytes to its answer while the lease it was sent under holds. */
  async renewOnce() {
    const lease = this.lease;
    const g = this.grant;
    const t0 = this.clocks();
    const tx = lease.begin(t0, (0, import_node_crypto8.randomBytes)(16).toString("hex"), (seq2, nonce) => this.renewFields(seq2, nonce));
    if (!tx) {
      if (!lease.held(this.clocks())) this.onExpiry();
      return;
    }
    const state = this.renewState;
    this.renewals.sent += 1;
    this.renewals.states.push(state);
    if (this.reason !== void 0) this.renewals.afterTerminate += 1;
    const record = {
      attempts: 0,
      ms: null,
      outcome: "none",
      firstSendAtMs: tx.firstSendWall,
      answerAppliedAtMs: null,
      phase: this.phase
    };
    this.latency.set(tx.seq, record);
    const signal = this.renewController.signal;
    const again = async () => {
      if (lease.mayRetry(this.clocks())) await delay(Math.min(100, this.k.renewAttemptMs), signal).catch(() => void 0);
      if (signal.aborted) return false;
      if (lease.mayRetry(this.clocks())) return true;
      this.onExpiry();
      return false;
    };
    for (; ; ) {
      if (signal.aborted) return;
      const attempt = AbortSignal.any([signal, AbortSignal.timeout(this.k.renewAttemptMs)]);
      let raw;
      record.attempts += 1;
      try {
        raw = await this.o.port.renew(g.claimId, g.runToken, tx.body, attempt);
      } catch {
        if (signal.aborted || !await again()) return;
        continue;
      }
      if (signal.aborted) return;
      const decoded = decodeRenewReply(raw);
      if (decoded.kind === "unaddressed") {
        if (!await again()) return;
        continue;
      }
      const now = this.clocks();
      const d = lease.apply(decoded.reply, now);
      this.emit({ type: "renewal", seq: tx.seq, state, decision: d.kind });
      if (d.kind === "ignored") {
        if (!await again()) return;
        continue;
      }
      if (d.kind !== "rejected") {
        record.ms = Math.max(0, now.monoMs - tx.firstSendMono);
        record.answerAppliedAtMs = now.wallMs;
      }
      record.outcome = d.kind === "lease" ? "held" : d.kind;
      if (d.kind === "lost") {
        if (d.stop?.mode === "now") {
          this.stopNowLive = true;
          this.gate?.revokeLease();
          this.terminate("stopped");
        } else {
          this.gate?.revokeLease();
          this.onExpiry();
        }
        return;
      }
      if (d.kind === "lease") {
        this.gate?.applyLease(d.grant);
        if (d.stop?.mode === "graceful") this.onGracefulStop();
        this.alignDrain(decoded.reply);
      }
      this.armWatch();
      this.scheduleRenew(tx.firstSendMono, now.monoMs);
      return;
    }
  }
  onExpiry() {
    if (this.drainCutFirst(this.clocks())) return this.terminate(this.gracefulStop ? "stopped" : "completed");
    this.expiryObserved = true;
    this.gate?.revokeLease();
    this.terminate("lease_lost");
  }
  onGracefulStop() {
    if (this.gracefulStop) return;
    this.gracefulStop = true;
    if (this.phase !== "measurement") return this.terminate(this.phase === "starting" ? "didnt_start" : "stopped", this.phase === "starting" ? "didnt_start" : "stopped");
    this.startDrain();
    this.maybeFinishMeasurement();
  }
  startDrain() {
    this.renewState = "draining";
    if (this.graceEnd === void 0) {
      const t = this.clocks();
      this.markMeasurementEnd(t);
      this.graceEnd = { monoMs: t.monoMs + this.drainGraceMs, wallMs: t.wallMs + this.drainGraceMs };
      this.drainLimit = this.graceEnd;
      this.gate.drain(this.graceEnd);
    }
    this.armWatch();
  }
  /**
   * While the runner drains, Peeps caps the lease at its own drain start plus the grace (rule 10).
   * The runner maps that cap from the renewal's first send, so a slow or retried renewal places it
   * before `graceEnd`. A capped lease (one that ends before its TTL) then ends the drain with it,
   * so the cap is the drain's cut, not a lost lease. An uncapped one restores the drain's own end.
   */
  alignDrain(reply) {
    if (!this.lease) return;
    const g = this.lease.grantNow;
    this.leaseUntil = { monoMs: g.monoUntil, wallMs: g.wallUntil };
    if (!this.drainLimit || this.reason !== void 0) return;
    const capped = reply.leaseUntilServerMs - reply.serverNowMs < reply.ttlMs;
    this.graceEnd = capped ? { monoMs: Math.min(this.drainLimit.monoMs, g.monoUntil), wallMs: Math.min(this.drainLimit.wallMs, g.wallUntil) } : this.drainLimit;
    this.gate.drain(this.graceEnd);
  }
  /** The drain's end came at or before the lease's, and has passed: running out is the drain's cut. */
  drainCutFirst(t) {
    const end = this.graceEnd;
    const lease = this.leaseUntil;
    if (!end || !lease) return false;
    return end.monoMs <= lease.monoMs && end.wallMs <= lease.wallMs && !(t.monoMs < end.monoMs && t.wallMs < end.wallMs);
  }
  /** One self-re-arming timer on the nearest deadline: the lease, the run's end, and the grace end. */
  armWatch() {
    if (this.reason !== void 0 || !this.lease) return;
    clearTimeout(this.watchTimer);
    const t = this.clocks();
    const grant = this.lease.grantNow;
    const monoLeft = Math.min(grant.monoUntil, this.runEndMono, this.graceEnd?.monoMs ?? Infinity) - t.monoMs;
    const wallLeft = Math.min(grant.wallUntil, this.runEndWall, this.graceEnd?.wallMs ?? Infinity) - t.wallMs;
    const wait = Math.min(100, Math.max(1, Math.min(monoLeft, wallLeft)));
    this.watchTimer = setTimeout(() => this.watch(), Number.isFinite(wait) ? wait : 100);
  }
  watch() {
    if (this.reason !== void 0 || !this.lease) return;
    const t = this.clocks();
    if (!this.lease.held(t)) return this.onExpiry();
    const cutoff = this.gate?.checkRunEnd(t);
    if (cutoff === "hard" || !this.gate && !(t.monoMs < this.runEndMono && t.wallMs < this.runEndWall)) {
      return this.terminate("run_end", "failed");
    }
    if (cutoff === "drain") return this.terminate(this.gracefulStop ? "stopped" : "completed");
    for (const state of this.busySlots.values()) {
      if (!(t.wallMs < state.deadlineWall)) this.expireTurn(state);
    }
    this.armWatch();
  }
  // ---------------------------------------------------------------- prepare
  async prepare(claimed) {
    const g = this.grant;
    const projection = { allowedOrigins: g.limits.allowedOrigins, maxUsers: g.limits.maxUsers, requestBudget: g.limits.requestBudget, policyRevision: g.limits.policyRevision };
    const input = validatePlanInput({ plan: g.plan, limits: projection });
    if (!input.ok) throw new Refused("didnt_start", "plan_invalid", input.errors.slice(0, 5).join("; "));
    if (planHashOf(input.value.plan) !== g.planHash) throw new Refused("didnt_start", "plan_hash");
    const plan = input.value.plan;
    this.plan = plan;
    if (g.workload.module !== plan.journey.module || g.workload.export !== plan.journey.export || g.workload.path !== this.o.workloadPath) throw new Refused("didnt_start", "workload_mismatch");
    const now = await bindingOf(this.o.workspace, this.o.workloadPath, void 0, this.signal);
    if (!sameBinding(now, claimed) || !sameBinding(now, g.binding)) throw new Refused("didnt_start", "checkout_changed");
    const limits = runLimits(input.value, g.limits, { parallel: OUTSTANDING_PER_TURN, constants: this.engine });
    if (!limits.ok) throw new Refused("didnt_start", limits.reason, limits.detail);
    this.limits = limits.value;
    this.drainGraceMs = Math.min(g.graceMs, limits.value.budgets.measurement.turnDeadlineMs);
    if (this.o.harnessHosts) {
      const allowed = new Set(this.o.harnessHosts.map((h) => h.toLowerCase()));
      for (const a of limits.value.approved.values()) if (!allowed.has(a.host.toLowerCase())) throw new Refused("didnt_start", "outside_harness");
    }
    let base;
    try {
      base = new URL(g.baseURL);
    } catch {
      throw new Refused("didnt_start", "base_url");
    }
    const baseOrigin = `${base.protocol}//${base.host}`;
    if (!limits.value.approved.has(baseOrigin.replace(/:443$/, ""))) throw new Refused("didnt_start", "base_url");
    this.throwIfDone();
    const hosts = [...limits.value.approved.values()].map((a) => a.host);
    const nowWall = Date.now();
    const ca = createRunCa({ hosts, nowMs: nowWall, validForMs: g.maxRunMs + g.graceMs + 36e5 });
    this.caDir = (0, import_node_fs3.mkdtempSync)(import_node_path2.default.join(import_node_os4.default.tmpdir(), "peeps-load-ca-"));
    const caFile = import_node_path2.default.join(this.caDir, "ca.pem");
    (0, import_node_fs3.writeFileSync)(caFile, ca.certPem, { mode: 384 });
    const journal = new Journal();
    const gate = new Gate({ ...limits.value.gate, runEndMono: this.runEndMono, runEndWall: this.runEndWall, phase: limits.value.checking });
    gate.applyLease(this.lease.grantNow);
    this.gate = gate;
    this.journal = journal;
    this.proxy = new GateProxy({
      gate,
      journal,
      ca,
      policy: limits.value.policy,
      origins: limits.value.approved,
      authorize: (c) => this.credentials.get(c),
      limits: { ...limits.value.proxy, exchangeMs: this.engine.turnDeadlineMs },
      clocks: this.clocks,
      onLeaseExpired: () => this.onExpiry(),
      onRunEnded: () => this.watch(),
      onTurnExpired: (turn) => {
        const state = this.turns.get(turn);
        if (state) this.expireTurn(state);
      },
      dial: this.s.dial ?? (this.s.dialSeams ? makeDial(this.s.dialSeams) : void 0),
      seqHeader: this.s.seqHeader
    });
    this.lastSnapshot = journal.snapshot();
    this.s.onJournal?.(journal);
    const node = "/run/peeps/node/bin/node";
    const spec = {
      runId: this.o.runId,
      claimId: g.claimId,
      node: import_node_path2.default.join(this.o.nodeDir, "bin", "node"),
      nodeDir: this.o.nodeDir,
      actionDir: this.o.actionDir,
      outer: import_node_path2.default.join(this.o.actionDir, "load-outer.js"),
      init: import_node_path2.default.join(this.o.actionDir, "load-init.js"),
      workspace: this.o.workspace,
      caPem: caFile,
      executorUid: process.getuid?.() ?? 0,
      executorGid: process.getgid?.() ?? 0,
      install: [node, "/run/peeps/node/lib/node_modules/npm/bin/npm-cli.js", "rebuild", "--foreground-scripts"],
      command: this.s.command ?? [node, "/run/peeps/action/load-executor.js"],
      env: {},
      // The clocks read fractional milliseconds; systemd and the spec take whole ones.
      limits: { maxRunMs: Math.ceil(15 * 6e4 + 6e4 + Math.max(0, this.runEndMono - this.clocks().monoMs) + g.graceMs), memoryMax: "2G", tasksMax: 512, cpuQuotaPercent: Math.max(100, (import_node_os4.default.availableParallelism() - 1) * 100) }
    };
    const proxy = this.proxy;
    const launch = this.s.launch ?? startJail;
    this.jailLaunchPending = true;
    this.launchCalled = true;
    let handle;
    try {
      handle = await launch(spec, { listenProxy: (p) => proxy.listen(p).then(() => proxy.server) }, this.signal);
    } finally {
      this.jailLaunchPending = false;
    }
    this.jail = handle;
    if (this.reason !== void 0) {
      this.jailEnded = handle.end();
      this.jailEnded.catch(() => void 0);
      this.throwIfDone();
    }
    handle.onFrame((f) => this.onFrame(f));
    void handle.exited.then((e) => {
      if (this.reason !== void 0) return;
      if (e.signal === "protocol") this.terminate("executor_protocol", "failed");
      else if (this.phase !== "starting" || this.playwright !== null) this.terminate("executor_exit", "failed");
    });
  }
  // ---------------------------------------------------------------- startup
  ticketOf = () => {
    const t = this.clocks();
    const lease = this.lease;
    if (this.reason !== void 0 || this.gracefulStop || this.stopNowLive || !lease.held(t)) return null;
    if (!(t.monoMs < this.runEndMono && t.wallMs < this.runEndWall)) return null;
    const g = lease.grantNow;
    return { claimId: this.grant.claimId, epoch: this.grant.epoch, planHash: this.grant.planHash, leaseSeq: g.seq, nonce: (0, import_node_crypto8.randomBytes)(16).toString("hex"), monoDeadline: Math.min(g.monoUntil, this.runEndMono), wallDeadline: Math.min(g.wallUntil, this.runEndWall) };
  };
  async startup() {
    const jail = this.jail;
    const installed = await jail.start(this.ticketOf, this.signal);
    this.throwIfDone();
    if (installed.code !== 0) throw new Refused("didnt_start", "install_failed", `code ${installed.code ?? installed.signal}`);
    await jail.launch(this.ticketOf, this.signal);
    this.throwIfDone();
    const answer = this.nextFrame((f2) => f2.type === "loaded" || f2.type === "fatal", this.k.loadedMs);
    jail.send({ type: "init", journey: this.plan.journey, baseURL: this.grant.baseURL, proxy: jail.relayUrl, renewEveryMs: this.grant.lease.renewEveryMs, parallel: DIALS_PER_TURN });
    const f = await answer;
    this.throwIfDone();
    if (!f) throw new Refused("didnt_start", "loaded_timeout");
    if (f.type === "fatal") {
      this.failures.push({ message: sanitize(f.message, 2e3) ?? "", location: sanitize(f.location) });
      throw new Refused("didnt_start", `executor_${f.code}`);
    }
    if (f.type === "loaded") this.playwright = sanitize(f.playwright, 64);
  }
  /** The next frame matching, or null at the time limit or the run's end. */
  nextFrame(match2, ms2) {
    return new Promise((resolve) => {
      const timer = setTimeout(() => done(null), ms2);
      const off = this.jail.onFrame((f) => {
        if (match2(f)) done(f);
      });
      const onEnd = () => done(null);
      void this.terminated.then(onEnd);
      const done = (f) => {
        clearTimeout(timer);
        off();
        resolve(f);
      };
    });
  }
  // ---------------------------------------------------------------- turns
  openTurn(slot, phase, deadlineMs, accountingId) {
    const gate = this.gate;
    const t = this.clocks();
    const opened = gate.openTurn(`s${slot}`, t, deadlineMs);
    if (!opened.ok) {
      if (opened.reason === "run_end") this.watch();
      return null;
    }
    const turn = opened.turn;
    const password = (0, import_node_crypto8.randomBytes)(32).toString("base64url");
    this.credentials.set(`Basic ${Buffer.from(`${turn}:${password}`).toString("base64")}`, turn);
    const deadlineMono = Math.min(t.monoMs + deadlineMs, this.runEndMono);
    const state = { turn, slot, phase, startMono: t.monoMs, deadlineWall: t.wallMs + deadlineMs, deadlineReached: false, timers: [], accountingId };
    this.turns.set(turn, state);
    this.busySlots.set(slot, state);
    if (phase === "checking") this.journal.trackTurn(turn);
    state.timers.push(setTimeout(() => this.expireTurn(state), Math.max(0, deadlineMono - t.monoMs)));
    this.jail.send({ type: "turn", turn, slot, password, deadlineMono });
    this.emit({ type: "turn", turn, slot, phase });
    return state;
  }
  /** At the deadline, close the gate side and cancel. The slot stays busy until its outcome. */
  expireTurn(state) {
    if (state.deadlineReached || state.outcome !== void 0 || this.reason !== void 0) return;
    state.deadlineReached = true;
    this.proxy.closeTurn(state.turn);
    this.jail.send({ type: "cancel", turn: state.turn });
    state.timers.push(setTimeout(() => {
      if (state.outcome === void 0 && this.reason === void 0) this.terminate("executor_unresponsive", "failed");
    }, this.k.outcomeTimeoutMs));
  }
  onFrame(f) {
    if (f.type !== "outcome") return;
    const state = this.turns.get(f.turn);
    if (!state || state.outcome !== void 0) {
      this.duplicateOutcomes = Math.min(this.duplicateOutcomes + 1, 1e6);
      return;
    }
    state.outcome = f.kind;
    for (const timer of state.timers) clearTimeout(timer);
    this.proxy?.closeTurn(f.turn);
    this.busySlots.delete(state.slot);
    this.emit({ type: "outcome", turn: f.turn, kind: f.kind });
    if (f.kind !== "success" && this.failures.length < 20) this.failures.push({ message: sanitize(f.message, 2e3) ?? f.kind, location: sanitize(f.location) });
    const counts = state.phase === "checking" ? this.checking : this.measurement;
    counts[f.kind] += 1;
    if (state.phase === "measurement") {
      const planNow = this.clocks().monoMs - this.measureStartMono;
      this.accounting.record(state.accountingId, f.kind === "cancelled" ? "interrupted" : f.kind, planNow);
    }
    for (const w of [...this.outcomeWaiters]) w();
    if (this.phase === "measurement") this.maybeFinishMeasurement();
  }
  waitOutcomes(states, untilMono) {
    return new Promise((resolve) => {
      const check = () => {
        if (states.every((x) => x.outcome !== void 0) || this.reason !== void 0) done();
      };
      const timer = setTimeout(() => done(), Math.max(0, untilMono - this.clocks().monoMs));
      const done = () => {
        clearTimeout(timer);
        this.outcomeWaiters.delete(check);
        resolve();
      };
      this.outcomeWaiters.add(check);
      void this.terminated.then(done);
      check();
    });
  }
  // ---------------------------------------------------------------- Checking: a barrier
  async runChecking() {
    this.phase = "checking";
    this.emit({ type: "phase", phase: "checking" });
    const caps = this.limits.checking;
    const deadline = this.clocks().monoMs + this.engine.checkingDeadlineMs;
    const states = [];
    for (let slot = 1; slot <= caps.maxUsers; slot++) {
      const st = this.openTurn(slot, "checking", Math.min(this.engine.turnDeadlineMs, this.engine.checkingDeadlineMs), `checking-${slot}`);
      if (st) states.push(st);
    }
    this.checking.turns = states.length;
    await this.waitOutcomes(states, deadline);
    this.throwIfDone();
    for (const st of states) this.proxy.closeTurn(st.turn);
    this.checking.responded = states.map((st) => this.journal.respondedForTurn(st.turn));
    const passed = states.length === caps.maxUsers && states.length > 0 && states.every((st) => st.outcome === "success") && this.checking.responded.every((n) => n >= 1) && this.clocks().monoMs < deadline;
    if (!passed) throw new Refused("didnt_start", "checking_failed");
    if (this.reason !== void 0 || this.gracefulStop || this.stopNowLive) throw new Refused("didnt_start", this.reason ?? "stopped");
    this.gate.setPhase(this.limits.measurement, this.clocks());
  }
  // ---------------------------------------------------------------- measurement
  async runMeasurement() {
    const plan = this.plan;
    this.phase = "measurement";
    const started = this.clocks();
    this.measureStartMono = started.monoMs;
    this.measureStartWall = started.wallMs;
    this.emit({ type: "phase", phase: "measurement" });
    this.scheduler = new Scheduler({ pacingEveryMs: plan.cohort.pacingEveryMs, stages: plan.cohort.stages }, this.limits.budgets.startSlackMs);
    this.tick();
    await this.terminated;
  }
  tick() {
    if (this.reason !== void 0) return;
    const planNow = this.clocks().monoMs - this.measureStartMono;
    const scheduler = this.scheduler;
    if (!this.gracefulStop) {
      const poll = scheduler.poll(planNow, (user) => this.busySlots.has(user));
      for (const m of poll.missed) {
        this.accounting.missed(m.dueMs);
        this.measurement.missed += 1;
      }
      for (const st of poll.starts) {
        this.accounting.due(st.dueMs);
        const id = `m-${st.userId}-${st.dueMs}`;
        const opened = this.openTurn(st.userId, "measurement", this.limits.budgets.measurement.turnDeadlineMs, id);
        if (!opened) {
          this.accounting.missed(st.dueMs);
          this.measurement.missed += 1;
          continue;
        }
        this.measurement.started += 1;
        const startMs = opened.startMono - this.measureStartMono;
        this.startLags.push({ atMs: startMs, lagMs: Math.max(0, startMs - st.dueMs) });
        this.accounting.start(id, planNow, st.stage, planNow + this.limits.budgets.measurement.turnDeadlineMs);
      }
    }
    this.countRequests(planNow);
    this.publishIntervals(planNow, false);
    if (scheduler.finished(planNow) && this.graceEnd === void 0) this.startDrain();
    this.maybeFinishMeasurement();
    if (this.reason === void 0) this.tickTimer = setTimeout(() => this.tick(), this.k.tickMs);
  }
  maybeFinishMeasurement() {
    if (this.reason !== void 0 || this.phase !== "measurement") return;
    const ending = this.gracefulStop || this.scheduler !== void 0 && this.graceEnd !== void 0;
    if (ending && this.busySlots.size === 0) this.terminate(this.gracefulStop ? "stopped" : "completed");
  }
  markMeasurementEnd(at) {
    if (this.measureStartWall === void 0 || this.measureEndWall !== void 0) return;
    const elapsed = Math.max(0, at.monoMs - this.measureStartMono);
    this.measureEndWall = this.measureStartWall + Math.min(elapsed, this.plan.durationMs);
  }
  measurementWindow() {
    if (this.measureStartWall === void 0 || this.measureEndWall === void 0) return null;
    return { startedAtMs: this.measureStartWall, endedAtMs: this.measureEndWall };
  }
  countRequests(planNow) {
    const snap = this.journal.snapshot();
    this.accounting.requests(Math.max(0, planNow), requestDelta(this.lastSnapshot, snap));
    this.lastSnapshot = snap;
  }
  // ---------------------------------------------------------------- terminate, settle, report
  /** Cancels (if nothing has ended the run yet) and drops the draining: the lease is abandoned and the reporting is cut short. */
  hardCancel() {
    if (this.hard) return;
    this.hard = true;
    this.hardTimer = setTimeout(this.resolveHardLimit, this.k.hardReportingMs);
    this.terminate("cancelled");
    this.lease?.abandon();
    this.renewing = false;
    clearTimeout(this.renewTimer);
    this.renewController.abort();
  }
  /** Synchronous and idempotent: one reason, latched. */
  terminate(trigger, status, detail) {
    if (this.reason !== void 0) return;
    if (detail !== void 0 && this.failures.length < 20) this.failures.push({ message: sanitize(detail, 2e3) ?? trigger, location: null });
    let reason = trigger;
    let st = status;
    if (this.expiryObserved || this.gate?.leaseExpired) [reason, st] = ["lease_lost", "lease_lost"];
    else if (this.stopNowLive) [reason, st] = ["stopped", "stopped"];
    else if (this.lease && !this.lease.held(this.clocks()) && !this.drainCutFirst(this.clocks())) [reason, st] = ["lease_lost", "lease_lost"];
    this.markMeasurementEnd(this.clocks());
    this.reason = reason;
    this.status = st ?? statusOf(reason);
    clearTimeout(this.watchTimer);
    clearTimeout(this.tickTimer);
    for (const state of this.turns.values()) for (const timer of state.timers) clearTimeout(timer);
    if (this.journal && this.gate && this.lease) {
      this.emit({ type: "snapshot", at: "terminate", handoffs: encodeHandoffs(this.journal.handoffs()), journal: this.journal.snapshot(), monoMs: this.clocks().monoMs, leaseMonoUntil: this.lease.grantNow.monoUntil });
    }
    this.emit({ type: "terminate", reason, status: this.status });
    this.proxyClosed = this.proxy ? this.proxy.close() : Promise.resolve();
    this.jailEnded = this.jail ? this.jail.end() : Promise.resolve({ clean: true });
    this.jailEnded.catch(() => void 0);
    const keepRenewing = this.lease !== void 0 && !this.hard && !(reason === "lease_lost" || reason.startsWith("executor_") || this.phase === "starting");
    if (!keepRenewing) {
      this.lease?.abandon();
      this.renewing = false;
      clearTimeout(this.renewTimer);
      this.renewController.abort();
    } else {
      this.renewState = "draining";
    }
    this.internal.abort();
    for (const w of [...this.outcomeWaiters]) w();
    this.resolveTerminated();
  }
  async finish() {
    const deadline = delayResolve(this.k.reportingMs);
    void this.hardLimit.then(deadline.finish);
    const settled = (async () => {
      await this.proxyClosed;
      this.renewing = false;
      clearTimeout(this.renewTimer);
      while (this.renewInFlight) await this.renewInFlight;
      return true;
    })();
    const ok = await Promise.race([settled, deadline.then(() => false)]);
    this.renewing = false;
    clearTimeout(this.renewTimer);
    this.renewController.abort();
    const finalDebit = this.gate?.admitted ?? 0;
    if (ok && this.gate) {
      this.gateClosed = true;
      this.emit({ type: "gate_closed", debited: finalDebit });
    }
    if (this.journal) {
      const planNow = this.phase === "measurement" ? this.clocks().monoMs - this.measureStartMono : 0;
      this.countRequests(Math.max(0, planNow));
      this.publishIntervals(Math.max(0, planNow), true);
      this.queueHandoffs();
      if (this.gateClosed) this.queueFinal(finalDebit);
    }
    const cleanup = this.cleanupProof(deadline);
    const closing = cleanup.then((c) => this.close(ok, c, finalDebit, deadline));
    await Promise.race([Promise.all([this.flushEvidence(), closing]), deadline]);
    this.evidenceStopped = true;
    this.evidenceCancel.abort();
    this.closedCancel.abort();
    const jailEnd = await Promise.race([cleanup, deadline.then(() => "dirty")]);
    if (this.caDir) (0, import_node_fs3.rmSync)(this.caDir, { recursive: true, force: true });
    deadline.cancel();
    const loop = this.loopDelay;
    return {
      status: this.status,
      reason: this.reason,
      claimId: this.claimId,
      playwright: this.playwright,
      checking: this.checking,
      measurement: this.measurement,
      measurementWindow: this.measurementWindow(),
      journal: this.journal?.snapshot() ?? null,
      handoffs: this.journal ? encodeHandoffs(this.journal.handoffs()) : null,
      gateClosed: this.gateClosed,
      final: this.finalSent ?? "missing",
      renewals: this.renewals,
      latency: this.latencySummary(true),
      eventLoop: { p99Ms: loop.count ? round(loop.percentile(99) / 1e6) : 0, maxMs: loop.count ? round(loop.max / 1e6) : 0 },
      closed: this.closedOutcome,
      evidence: this.finalSent ? { state: "complete" } : this.incomplete ? { state: "incomplete", ...this.incomplete } : { state: "missing" },
      cleanup: jailEnd,
      duplicateOutcomes: this.duplicateOutcomes,
      failures: this.failures
    };
  }
  /**
   * Whether nothing of this run can be left: `clean` when the jail ended with its cgroup proven
   * empty, or when no launch was ever attempted (`not_started`). A launch still pending, one that
   * failed, or an end that is not clean or not back by the deadline is `dirty`.
   */
  async cleanupProof(deadline) {
    if (!this.launchCalled) return "not_started";
    if (this.jailLaunchPending || !this.jail || !this.jailEnded) return "dirty";
    const end = await Promise.race([this.jailEnded.catch(() => null), deadline.then(() => null)]);
    return end?.clean ? "clean" : "dirty";
  }
  /**
   * The release-bearing `closed` renewal: once, only with settlement proven, retried with
   * identical bytes until a matching receipt, a refusal or the reporting deadline.
   */
  async close(settled, cleanup, debited, deadline) {
    const lease = this.lease;
    const g = this.grant;
    if (!lease || !g) return;
    const inFlight = this.gate?.inFlight ?? 0;
    const withheld = !settled ? "unsettled" : cleanup === "dirty" ? "dirty" : inFlight !== 0 ? "in_flight" : void 0;
    if (withheld) {
      this.closedOutcome = { state: "withheld", reason: withheld, attempts: 0, latencyMs: null };
      return;
    }
    if (deadline.expired()) return;
    const t0 = this.clocks();
    const tx = lease.beginClosed(
      t0,
      (0, import_node_crypto8.randomBytes)(16).toString("hex"),
      (seq2, nonce) => renewBody({ epoch: g.epoch, seq: seq2, nonce, phase: this.phase, debited, unresolved: this.gate?.unresolved ?? 0, inFlight: 0, state: "closed", lagP99Ms: this.lagP99Ms() })
    );
    if (!tx) return;
    const out = { state: "unanswered", seq: tx.seq, debited, attempts: 0, latencyMs: null };
    this.closedOutcome = out;
    const stop = AbortSignal.any([this.closedCancel.signal, this.hardSignalOr()]);
    void deadline.then(() => this.closedCancel.abort());
    let pause = this.k.retryMs;
    while (!stop.aborted && !deadline.expired()) {
      out.attempts += 1;
      let raw;
      let answered = true;
      try {
        raw = await this.o.port.renew(g.claimId, g.runToken, tx.body, AbortSignal.any([stop, AbortSignal.timeout(this.k.renewAttemptMs)]));
      } catch {
        answered = false;
      }
      if (stop.aborted || deadline.expired()) break;
      if (answered) {
        const receipt = decodeClosedReceipt(raw);
        if (receipt && lease.ackClosed(receipt)) {
          out.state = "acked";
          out.latencyMs = round(this.clocks().monoMs - tx.firstSendMono);
          break;
        }
        const refused = isObj4(raw) && typeof raw.refused === "string" ? raw.refused.slice(0, 64) : void 0;
        if (refused !== void 0) {
          out.state = "refused";
          out.reason = refused;
          break;
        }
      }
      await delay(pause, stop).catch(() => void 0);
      pause = Math.min(pause * 2, this.k.retryMaxMs);
    }
    this.emit({ type: "closed", seq: tx.seq, outcome: out.state });
  }
  /** The closed retries stop with the hard limit too. */
  hardSignalOr() {
    const ac = new AbortController();
    void this.hardLimit.then(() => ac.abort());
    return ac.signal;
  }
  /** The renewal latency record; `withRecords` keeps every allocation's entry. */
  latencySummary(withRecords) {
    const records = [...this.latency.entries()].sort((a, b) => a[0] - b[0]).map(
      ([seq2, r]) => [seq2, r.attempts, r.ms === null ? null : round(r.ms), r.outcome, r.firstSendAtMs, r.answerAppliedAtMs, r.phase]
    );
    const values = records.map((r) => r[2] === null ? Number.POSITIVE_INFINITY : r[2]).sort((a, b) => a - b);
    const at = (q) => {
      const v2 = nearestRank(values, q);
      return v2 === void 0 || !Number.isFinite(v2) ? null : v2;
    };
    return { records: withRecords ? records : [], count: records.length, unanswered: records.filter((r) => r[2] === null).length, p50Ms: at(0.5), p99Ms: at(0.99), p999Ms: at(0.999), maxMs: at(1) };
  }
  // ---------------------------------------------------------------- evidence
  publishIntervals(planNow, force) {
    if (!this.journal || this.phase !== "measurement") return;
    const intervals = force ? this.accounting.closeIntervals(Math.ceil((planNow + 1) / this.k.intervalMs) * this.k.intervalMs) : this.accounting.closeIntervals(planNow);
    const cohorts = this.accounting.sealCohorts(planNow, this.drainGraceMs, force);
    if (!intervals.length && !cohorts.length) return;
    if (this.fits({ kind: "intervals", intervals, cohorts })) this.queue({ kind: "intervals", intervals, cohorts });
    else {
      this.queueRecords("intervals", "intervals", intervals, { cohorts: [] });
      this.queueRecords("intervals", "cohorts", cohorts, { intervals: [] });
    }
  }
  /** The handoffs, the renewal latencies and the summary, each split to fit a batch. */
  queueHandoffs() {
    const h = encodeHandoffs(this.journal.handoffs());
    this.queueRecords("handoffs", "unattempted", h.unattempted, { debited: h.debited });
    const latency = this.latencySummary(true);
    this.queueRecords("renewals", "records", latency.records, {});
    const { records: _records, ...latencyStats } = latency;
    const loop = this.loopDelay;
    this.queue({ kind: "summary", journal: this.journal.snapshot(), checking: this.checking, measurement: this.measurement, measurementWindow: this.measurementWindow(), reason: this.reason, playwright: this.playwright, failures: this.failures.slice(0, 20), denyReasons: DENY_REASONS.length, cutReasons: CUT_REASONS.length, zero: zeroCounts().debited, latency: latencyStats, eventLoop: { p99Ms: loop.count ? round(loop.percentile(99) / 1e6) : 0, maxMs: loop.count ? round(loop.max / 1e6) : 0 } });
  }
  queueFinal(watermark) {
    if (this.incomplete) return;
    this.queue({ kind: "final" }, { watermark });
  }
  /** Whether `payload` fits one batch and one events body. */
  fits(payload) {
    const batch = JSON.stringify(payload);
    return Buffer.byteLength(batch) <= this.k.maxBatchBytes && Buffer.byteLength(JSON.stringify(batch)) + 512 <= this.k.maxEventsBodyBytes;
  }
  /** `records` under `key`, split to fit before any seq is allocated (`splitToFit`). */
  queueRecords(kind, key, records, extra) {
    const split = splitToFit(kind, key, records, extra, (p) => this.fits(p));
    for (const payload of split.payloads) this.queue(payload);
    if (split.oversized !== void 0) this.latchIncomplete({ reason: "oversized", record: { kind, index: split.oversized } });
  }
  latchIncomplete(why) {
    this.incomplete ??= why;
  }
  queue(payload, final) {
    if (!this.grant || this.evidenceStopped) return;
    if (!this.fits(payload)) return this.latchIncomplete({ reason: "oversized", record: { kind: String(payload.kind), index: 0 } });
    const seq2 = ++this.evidenceSeq;
    const batch = JSON.stringify(payload);
    const payloadHash = batchHash({ streamId: this.streamId, seq: seq2, payload: batch, final });
    this.evidenceQueue.push({ body: { streamId: this.streamId, seq: seq2, payloadHash, batch, ...final ? { final } : {} } });
    this.startEvidence();
  }
  startEvidence() {
    return this.evidenceRunning ??= this.pump().finally(() => this.evidenceRunning = void 0);
  }
  /**
   * One batch in flight. Dropped only on `{ok: true}`. A transport failure (a 5xx or 429 too) or
   * an answer that does not decode sends the same bytes again after a pause that doubles up to
   * `retryMaxMs`. Any refusal latches the evidence `incomplete` at that seq and stops the
   * stream, so nothing after a hole is sent and no final is acknowledged past one.
   */
  async pump() {
    const g = this.grant;
    let pause = this.k.retryMs;
    while (this.evidenceQueue.length && !this.evidenceStopped) {
      const head = this.evidenceQueue[0];
      let answer;
      let answered = true;
      try {
        answer = await this.o.port.events(g.claimId, g.eventsToken, head.body, AbortSignal.any([this.evidenceCancel.signal, AbortSignal.timeout(this.k.renewAttemptMs * 2)]));
      } catch {
        answered = false;
      }
      if (this.evidenceStopped) return;
      if (answered && isObj4(answer)) {
        if (answer.ok === true && typeof answer.replay === "boolean" && !("reason" in answer) && !("refused" in answer)) {
          this.evidenceQueue.shift();
          if (head.body.final) this.finalSent = head.body.final;
          pause = this.k.retryMs;
          continue;
        }
        const refusal = answer.ok === false ? answer.reason : answer.refused;
        if (answer.ok === false || answer.ok !== true && typeof answer.refused === "string") {
          this.latchIncomplete({ seq: head.body.seq, reason: typeof refusal === "string" ? refusal.slice(0, 64) : "unknown" });
          this.evidenceStopped = true;
          return;
        }
      }
      await delay(pause, this.evidenceCancel.signal).catch(() => void 0);
      pause = Math.min(pause * 2, this.k.retryMaxMs);
    }
  }
  async flushEvidence() {
    while (this.evidenceRunning || !this.evidenceStopped && this.evidenceQueue.length > 0) {
      await this.startEvidence();
    }
  }
};
function statusOf(reason) {
  if (reason === "completed") return "completed";
  if (reason === "stopped") return "stopped";
  if (reason === "cancelled") return "cancelled";
  if (reason === "lease_lost") return "lease_lost";
  if (reason === "didnt_start") return "didnt_start";
  return "failed";
}
var round = (ms2) => Math.round(ms2 * 10) / 10;
var isObj4 = (v2) => typeof v2 === "object" && v2 !== null && !Array.isArray(v2);
function splitToFit(kind, key, records, extra, fits) {
  const payloads = [];
  let oversized;
  const go = (part, first) => {
    if (oversized !== void 0) return;
    const payload = { kind, ...extra, first, [key]: part };
    if (fits(payload)) return void payloads.push(payload);
    if (part.length <= 1) return void (oversized = first);
    const half = Math.ceil(part.length / 2);
    go(part.slice(0, half), first);
    go(part.slice(half), first + half);
  };
  go(records, 0);
  return oversized === void 0 ? { payloads } : { payloads, oversized };
}
function nearestRank(sorted, q) {
  if (sorted.length === 0) return void 0;
  return sorted[Math.min(sorted.length, Math.max(1, Math.ceil(q * sorted.length))) - 1];
}
function pick(o, keys) {
  if (!o) return {};
  return Object.fromEntries(Object.entries(o).filter(([k, v2]) => keys.includes(k) && v2 !== void 0));
}
function delay(ms2, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason);
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal.reason);
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms2);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}
function delayResolve(ms2) {
  const end = performance.now() + ms2;
  let finished = false;
  let done;
  const p = new Promise((resolve) => {
    done = resolve;
  });
  const finish = () => {
    finished = true;
    clearTimeout(timer);
    done();
  };
  const timer = setTimeout(finish, ms2);
  return Object.assign(p, {
    cancel: () => clearTimeout(timer),
    expired: () => finished || performance.now() >= end,
    finish
  });
}

// src/load/main.ts
var GRANT_REF2 = /^[A-Za-z0-9_-]{22}$/;
var DIGITS = /^[1-9][0-9]{0,18}$/;
var HOST2 = /^(?=.{1,253}$)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*$/;
var VERSION = /^[A-Za-z0-9._-]{1,64}$/;
function readLoadInputs(env, actionDir, execPath = process.execPath) {
  const bad = (problem) => ({ ok: false, problem });
  if (env.NODE_DEBUG) return bad("NODE_DEBUG");
  const need = (name2) => {
    const v2 = env[name2];
    return typeof v2 === "string" && v2.length > 0 ? v2 : void 0;
  };
  const peepsUrl = need("PEEPS_URL");
  if (!peepsUrl) return bad("PEEPS_URL");
  const grantRef = need("PEEPS_LOAD_GRANT");
  if (!grantRef || !GRANT_REF2.test(grantRef)) return bad("PEEPS_LOAD_GRANT");
  const requestUrl = need("ACTIONS_ID_TOKEN_REQUEST_URL");
  const requestToken = need("ACTIONS_ID_TOKEN_REQUEST_TOKEN");
  if (!requestUrl || !requestToken) return bad("ACTIONS_ID_TOKEN_REQUEST_URL");
  const workspace = need("PEEPS_LOAD_WORKSPACE") ?? need("GITHUB_WORKSPACE");
  if (!workspace || !import_node_path3.default.isAbsolute(workspace)) return bad("PEEPS_LOAD_WORKSPACE");
  const workloadPath = need("PEEPS_LOAD_WORKLOAD");
  if (!workloadPath || import_node_path3.default.isAbsolute(workloadPath) || workloadPath.split(/[\\/]/).some((p) => p === ".." || p === "") || workloadPath.length > 1024) return bad("PEEPS_LOAD_WORKLOAD");
  const npmCache = need("PEEPS_LOAD_NPM_CACHE");
  if (!npmCache || !import_node_path3.default.isAbsolute(npmCache)) return bad("PEEPS_LOAD_NPM_CACHE");
  const sinkHosts = (env.PEEPS_LOAD_SINK_HOSTS ?? "").split(",").map((h) => h.trim().toLowerCase()).filter(Boolean);
  if (sinkHosts.length === 0 || sinkHosts.length > 20 || !sinkHosts.every((h) => HOST2.test(h))) return bad("PEEPS_LOAD_SINK_HOSTS");
  const runId = need("GITHUB_RUN_ID");
  const attempt = need("GITHUB_RUN_ATTEMPT");
  if (!runId || !DIGITS.test(runId) || !attempt || !DIGITS.test(attempt)) return bad("GITHUB_RUN_ID");
  const checkRunId = need("PEEPS_LOAD_CHECK_RUN_ID");
  if (!checkRunId || !DIGITS.test(checkRunId) || !Number.isSafeInteger(Number(checkRunId))) return bad("PEEPS_LOAD_CHECK_RUN_ID");
  const actionVersion = env.PEEPS_LOAD_ACTION_VERSION || "dev";
  if (!VERSION.test(actionVersion)) return bad("PEEPS_LOAD_ACTION_VERSION");
  const nodeDir = env.PEEPS_LOAD_NODE_DIR || import_node_path3.default.dirname(import_node_path3.default.dirname(execPath));
  if (!import_node_path3.default.isAbsolute(nodeDir)) return bad("PEEPS_LOAD_NODE_DIR");
  const resultFile = env.PEEPS_LOAD_RESULT_FILE || void 0;
  if (resultFile !== void 0 && !import_node_path3.default.isAbsolute(resultFile)) return bad("PEEPS_LOAD_RESULT_FILE");
  return {
    ok: true,
    inputs: {
      peepsUrl,
      grantRef,
      workspace,
      workloadPath,
      npmCache,
      sinkHosts,
      nodeDir,
      actionDir,
      actionVersion,
      runId: `gh-${runId}-${attempt}`.slice(0, 40),
      runAttempt: Number(attempt),
      checkRunId: Number(checkRunId),
      oidc: { requestUrl, requestToken },
      summaryFile: env.GITHUB_STEP_SUMMARY || void 0,
      resultFile
    }
  };
}
function reportOf(res) {
  const { records: _records, ...latency } = res.latency;
  return {
    status: res.status,
    reason: res.reason,
    claimId: res.claimId,
    gateClosed: res.gateClosed,
    final: res.final,
    closed: res.closed,
    evidence: res.evidence,
    cleanup: res.cleanup,
    renewals: { sent: res.renewals.sent, afterTerminate: res.renewals.afterTerminate },
    latency,
    eventLoop: res.eventLoop,
    checking: { turns: res.checking.turns, success: res.checking.success },
    measurement: res.measurement
  };
}
var ms = (v2) => v2 === null ? "unanswered" : `${v2} ms`;
function stepSummary(res) {
  const l = res.latency;
  return [
    "## Peeps load run",
    "",
    `Status: **${res.status}** (${res.reason})`,
    "",
    "| Renewals | p50 | p99 | p99.9 | max | unanswered |",
    "| --- | --- | --- | --- | --- | --- |",
    `| ${l.count} | ${ms(l.p50Ms)} | ${ms(l.p99Ms)} | ${ms(l.p999Ms)} | ${ms(l.maxMs)} | ${l.unanswered} |`,
    "",
    `Closed: ${res.closed.state}${res.closed.reason ? ` (${res.closed.reason})` : ""}. Evidence: ${res.evidence.state}. Cleanup: ${res.cleanup}. Event loop p99 ${res.eventLoop.p99Ms} ms, max ${res.eventLoop.maxMs} ms.`,
    ""
  ].join("\n").replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, "");
}
async function mainLoad(env = process.env, deps = {}, actionDir = __dirname) {
  const write = deps.write ?? ((line) => void process.stdout.write(`${line}
`));
  const read = readLoadInputs(env, actionDir);
  if (!read.ok) {
    write(JSON.stringify({ refused: "input", input: read.problem }));
    return 2;
  }
  const i = read.inputs;
  let port;
  try {
    port = (deps.makePort ?? ((o) => new HttpControlPort(o)))({ peepsUrl: i.peepsUrl, oidc: i.oidc, userAgent: `peeps-action-load/${i.actionVersion}` });
  } catch (error) {
    const code = typeof error.code === "string" ? error.code : "config";
    write(JSON.stringify({ refused: "port", code }));
    return 2;
  }
  let signals;
  try {
    signals = (deps.signals ?? loadSignals)();
    const res = await (deps.run ?? runLoad)({
      runId: i.runId,
      workspace: i.workspace,
      workloadPath: i.workloadPath,
      nodeDir: i.nodeDir,
      actionDir: i.actionDir,
      port,
      grantRef: i.grantRef,
      npmCache: i.npmCache,
      harnessHosts: i.sinkHosts,
      actionVersion: i.actionVersion,
      runAttempt: i.runAttempt,
      checkRunId: i.checkRunId,
      signal: signals.signal,
      hardSignal: signals.hard
    });
    if (i.resultFile) (0, import_node_fs4.writeFileSync)(i.resultFile, `${JSON.stringify(res)}
`, { mode: 384 });
    if (i.summaryFile) (0, import_node_fs4.appendFileSync)(i.summaryFile, stepSummary(res));
    write(JSON.stringify(reportOf(res)));
    return res.status === "completed" && res.cleanup === "clean" && res.closed.state === "acked" && res.evidence.state === "complete" && res.final !== "missing" && res.final.watermark === res.closed.debited ? 0 : 1;
  } catch {
    write('{"failed":"run_or_report"}');
    return 1;
  } finally {
    signals?.dispose();
    port.close();
  }
}
if (require.main === module) {
  void mainLoad().then((code) => {
    process.exitCode = code;
  });
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  mainLoad,
  readLoadInputs,
  reportOf,
  stepSummary
});
