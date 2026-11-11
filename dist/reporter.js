"use strict";
var __create = Object.create;
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __getProtoOf = Object.getPrototypeOf;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key2 of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key2) && key2 !== except)
        __defProp(to, key2, { get: () => from[key2], enumerable: !(desc = __getOwnPropDesc(from, key2)) || desc.enumerable });
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

// src/reporter.ts
var reporter_exports = {};
__export(reporter_exports, {
  ATTACH_FLUSH_DEADLINE_MS: () => ATTACH_FLUSH_DEADLINE_MS,
  ATTACH_PLAN_DEADLINE_MS: () => ATTACH_PLAN_DEADLINE_MS,
  TITLE_PATH_SEPARATOR: () => TITLE_PATH_SEPARATOR,
  default: () => PeepsCiReporter,
  htmlReportDir: () => htmlReportDir,
  identityOf: () => identityOf,
  isLastAttempt: () => isLastAttempt,
  narrowedOutcome: () => narrowedOutcome,
  testFileOf: () => testFileOf
});
module.exports = __toCommonJS(reporter_exports);
var import_node_crypto2 = require("node:crypto");
var import_node_fs3 = require("node:fs");
var import_promises = require("node:fs/promises");
var import_node_path3 = __toESM(require("node:path"));

// src/env.ts
var import_node_fs = require("node:fs");
var import_node_path = __toESM(require("node:path"));
function appOf(start, readyUrl, reset) {
  return start && readyUrl ? { start, readyUrl, reset } : null;
}
function readDefaultBranch(env) {
  const file = env.GITHUB_EVENT_PATH;
  if (!file) return null;
  try {
    const payload = JSON.parse((0, import_node_fs.readFileSync)(file, "utf8"));
    const branch = payload.repository?.default_branch;
    return typeof branch === "string" && branch !== "" ? branch : null;
  } catch {
    return null;
  }
}
function input(env, name) {
  const value = env[`INPUT_${name.toUpperCase().replace(/ /g, "_")}`];
  return value && value.trim() !== "" ? value.trim() : null;
}
function resolvePeepsUrl(raw) {
  const trimmed = raw.replace(/\/+$/, "");
  let url;
  try {
    url = new URL(trimmed);
  } catch {
    throw new Error(`PEEPS_API_URL is not a valid URL: ${trimmed}`);
  }
  const loopback = url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "[::1]";
  if (url.protocol !== "https:" && !loopback) {
    throw new Error(
      `PEEPS_API_URL must use https (got ${url.protocol.replace(":", "")}): ${trimmed}`
    );
  }
  return trimmed;
}
function eventNameForPipelineSource(source) {
  switch (source) {
    case void 0:
    case "":
      return null;
    case "push":
      return "push";
    case "merge_request_event":
      return "pull_request";
    case "schedule":
      return "schedule";
    case "api":
    case "trigger":
    case "web":
    case "pipeline":
    case "parent_pipeline":
      return "workflow_dispatch";
    default:
      return source;
  }
}
function flag(value) {
  return /^(true|1|yes)$/i.test((value ?? "").trim());
}
function variable(env, name) {
  const value = env[name];
  return value && value.trim() !== "" ? value.trim() : null;
}
function readGitLabRunnerEnv(env) {
  const workspace = env.CI_PROJECT_DIR ?? process.cwd();
  const workingDirectory = variable(env, "PEEPS_WORKING_DIRECTORY");
  const branch = env.CI_COMMIT_BRANCH ?? env.CI_MERGE_REQUEST_SOURCE_BRANCH_NAME;
  const ref = branch ? `refs/heads/${branch}` : env.CI_COMMIT_TAG ? `refs/tags/${env.CI_COMMIT_TAG}` : null;
  return {
    platform: "gitlab",
    mode: variable(env, "PEEPS_MODE") ?? "ci",
    sessionId: variable(env, "PEEPS_SESSION_ID"),
    configPath: variable(env, "PEEPS_PLAYWRIGHT_CONFIG"),
    framework: variable(env, "PEEPS_FRAMEWORK"),
    deviceTools: flag(env.PEEPS_DEVICE_TOOLS),
    peepsUrl: resolvePeepsUrl(env.PEEPS_API_URL ?? "https://app.peepsai.com"),
    workingDirectory: workingDirectory ? import_node_path.default.resolve(workspace, workingDirectory) : workspace,
    repository: env.CI_PROJECT_PATH ?? null,
    sha: env.CI_COMMIT_SHA ?? null,
    ref,
    eventName: eventNameForPipelineSource(env.CI_PIPELINE_SOURCE),
    defaultBranch: variable(env, "CI_DEFAULT_BRANCH"),
    runId: env.CI_PIPELINE_ID ?? null,
    runUrl: env.CI_PIPELINE_URL ?? null,
    serverUrl: (env.CI_SERVER_URL ?? "https://gitlab.com").replace(/\/+$/, ""),
    workspace,
    oidc: null,
    idToken: variable(env, "PEEPS_ID_TOKEN"),
    app: appOf(variable(env, "PEEPS_APP_START"), variable(env, "PEEPS_APP_READY_URL"), variable(env, "PEEPS_APP_RESET"))
  };
}
function readRunnerEnv(env = process.env) {
  if (env.GITLAB_CI === "true") return readGitLabRunnerEnv(env);
  const requestUrl = env.ACTIONS_ID_TOKEN_REQUEST_URL;
  const requestToken = env.ACTIONS_ID_TOKEN_REQUEST_TOKEN;
  const workspace = env.GITHUB_WORKSPACE ?? process.cwd();
  const workingDirectory = input(env, "working-directory") ?? variable(env, "PEEPS_WORKING_DIRECTORY");
  const serverUrl = (env.GITHUB_SERVER_URL ?? "https://github.com").replace(/\/+$/, "");
  const repository = env.GITHUB_REPOSITORY ?? null;
  const runId = env.GITHUB_RUN_ID ?? null;
  return {
    platform: "github",
    mode: input(env, "mode") ?? env.PEEPS_MODE ?? "ci",
    sessionId: input(env, "session-id") ?? env.PEEPS_SESSION_ID ?? null,
    configPath: input(env, "config") ?? env.PEEPS_PLAYWRIGHT_CONFIG ?? null,
    framework: input(env, "framework") ?? env.PEEPS_FRAMEWORK ?? null,
    deviceTools: flag(input(env, "device-tools") ?? env.PEEPS_DEVICE_TOOLS),
    peepsUrl: resolvePeepsUrl(env.PEEPS_API_URL ?? "https://app.peepsai.com"),
    workingDirectory: workingDirectory ? import_node_path.default.resolve(workspace, workingDirectory) : workspace,
    repository,
    sha: env.GITHUB_SHA ?? null,
    ref: env.GITHUB_REF ?? null,
    eventName: env.GITHUB_EVENT_NAME ?? null,
    defaultBranch: readDefaultBranch(env),
    runId,
    runUrl: repository && runId ? `${serverUrl}/${repository}/actions/runs/${runId}` : null,
    serverUrl,
    workspace,
    oidc: requestUrl && requestToken ? { requestUrl, requestToken } : null,
    idToken: null,
    app: appOf(
      input(env, "app-start") ?? variable(env, "PEEPS_APP_START"),
      input(env, "app-ready-url") ?? variable(env, "PEEPS_APP_READY_URL"),
      input(env, "app-reset") ?? variable(env, "PEEPS_APP_RESET")
    )
  };
}

// src/footprint/rules.ts
var MAX_FOOTPRINT_PATHS = 300;
var MAX_PATH_LENGTH = 512;
var MAX_REQUEST_BYTES = 9e5;
var MAX_REQUEST_EVENTS = 500;
var APP_PROTOCOLS = /* @__PURE__ */ new Set(["http:", "https:", "ws:", "wss:"]);
var STATIC_PREFIX = "/_next/static/";
var NEXT_DATA = /^\/_next\/data\/[^/]+\/(.*)\.json$/;
var UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
var OPAQUE = /^(?=.*\d)[A-Za-z0-9_-]{20,}$/;
var JWT = /^[\w-]+\.[\w-]+\.[\w-]+$/;
var DATE = /^\d{4}-\d{2}-\d{2}$/;
var IP = /^(?:\d+\.\d+\.\d+\.\d+|\[.*\])$/;
var LOOPBACK = /* @__PURE__ */ new Set(["localhost", "127.0.0.1", "[::1]"]);
function hostsFor({ baseUrls, origins }) {
  const exact = /* @__PURE__ */ new Set();
  const parents = /* @__PURE__ */ new Set();
  let local = false;
  let anyBase = false;
  for (const url of baseUrls) {
    const host = hostnameOf(url);
    if (!host) continue;
    anyBase = true;
    if (LOOPBACK.has(host) || !host.includes(".")) local = true;
    else if (IP.test(host)) exact.add(host);
    else parents.add(host.split(".").slice(-2).join("."));
  }
  if (!anyBase) return null;
  for (const url of origins) {
    const host = hostnameOf(url);
    if (host) exact.add(host);
  }
  return (host) => exact.has(host) || local && (LOOPBACK.has(host) || !host.includes(".")) || !IP.test(host) && parents.has(host.split(".").slice(-2).join("."));
}
function hostnameOf(url) {
  try {
    return new URL(url).hostname || null;
  } catch {
    return null;
  }
}
function isPrivate(raw) {
  let segment = raw;
  try {
    segment = decodeURIComponent(raw);
  } catch {
    return true;
  }
  if (DATE.test(segment)) return false;
  if (segment.includes("@") || UUID.test(segment) || /\d{6,}/.test(segment) || OPAQUE.test(segment)) return true;
  if (/^[+\d().\s_-]+$/.test(segment) && segment.replace(/\D/g, "").length >= 7) return true;
  if (/^[A-Za-z0-9+/_-]+={1,2}$/.test(segment)) return true;
  if (JWT.test(segment) && (segment.startsWith("eyJ") || segment.length >= 32)) return true;
  if (/^[0-9a-f]{8,}$/i.test(segment) && /\d/.test(segment)) return true;
  const mixed = /[a-z]/.test(segment) && /[A-Z]/.test(segment);
  if (mixed && /^[\w-]{8,}$/.test(segment) && /\d/.test(segment)) return true;
  return mixed && /^[A-Za-z]{16,}$/.test(segment);
}
function foldPath(path4) {
  return path4.split("/").map((whole) => {
    const segment = whole.split(";")[0];
    return segment !== "" && isPrivate(segment) ? ":id" : segment;
  }).join("/");
}
function eventBatches(events) {
  const batches = [];
  let current = [];
  let bytes = 0;
  for (const event of events) {
    const size = Buffer.byteLength(JSON.stringify(event)) + 1;
    if (current.length > 0 && (bytes + size > MAX_REQUEST_BYTES || current.length === MAX_REQUEST_EVENTS)) {
      batches.push(current);
      current = [];
      bytes = 0;
    }
    current.push(event);
    bytes += size;
  }
  if (current.length > 0) batches.push(current);
  return batches;
}
function requestPaths(url) {
  const { pathname } = new URL(url);
  const path4 = pathname.length > 1 ? pathname.replace(/\/+$/, "") : pathname;
  const batch = /^(.*\/trpc)\/([^/]*,[^/]*)$/.exec(path4);
  const paths = batch ? batch[2].split(",").map((procedure) => `${batch[1]}/${procedure}`) : [path4];
  const data = NEXT_DATA.exec(path4);
  if (data) paths.push(data[1] === "index" ? "/" : `/${data[1]}`);
  return paths.map(foldPath);
}
function sentFootprint(footprint, origins, attempt) {
  const repeated = attempt.repeatEachIndex > 0 || attempt.repeatEach > 1;
  return { ...footprint, complete: footprint.complete && !repeated && !attempt.hiddenRequests, attempt: { retry: attempt.retry }, origins };
}
function footprintFromText(traces, origins) {
  const isApp = hostsFor(origins);
  if (!isApp) return { paths: [], complete: false };
  const paths = /* @__PURE__ */ new Set();
  let complete = true;
  let sawNetwork = false;
  const add = (url) => {
    const parsed = new URL(url, origins.baseUrls.find((base) => hostnameOf(base)));
    if (!APP_PROTOCOLS.has(parsed.protocol) || !isApp(parsed.hostname)) return;
    for (const path4 of requestPaths(parsed.href)) {
      if (path4.startsWith(STATIC_PREFIX)) continue;
      if (path4.length > MAX_PATH_LENGTH) complete = false;
      else paths.add(path4);
    }
  };
  for (const trace of traces) {
    if (!trace) {
      complete = false;
      continue;
    }
    try {
      for (const text of trace.network) {
        for (const line of text.split("\n")) {
          if (line === "") continue;
          const event = JSON.parse(line);
          if (event.type !== "resource-snapshot" || !event.snapshot?.request?.url) continue;
          sawNetwork = true;
          add(event.snapshot.request.url);
        }
      }
      for (const text of trace.actions) {
        for (const line of text.split("\n")) {
          if (!line.includes('"goto"')) continue;
          const event = JSON.parse(line);
          if (event.type === "before" && event.method === "goto" && event.params?.url) add(event.params.url);
        }
      }
    } catch {
      complete = false;
    }
  }
  const sorted = [...paths].sort();
  return {
    paths: sorted.slice(0, MAX_FOOTPRINT_PATHS),
    complete: complete && sawNetwork && sorted.length > 0 && sorted.length <= MAX_FOOTPRINT_PATHS
  };
}
function keepsTrace(policy, attempt) {
  const failed = attempt.status !== attempt.expectedStatus;
  switch (policy) {
    case "off":
      return false;
    case "retain-on-failure":
      return failed;
    case "on-first-retry":
    case "retry-with-trace":
      return attempt.retry === 1;
    case "on-all-retries":
      return attempt.retry > 0;
    case "retain-on-first-failure":
      return attempt.retry === 0 && failed;
    case "retain-on-failure-and-retries":
      return failed || attempt.retry > 0;
    default:
      return true;
  }
}

// src/footprint/trace-file.ts
var import_node_fs2 = require("node:fs");
var import_node_path2 = __toESM(require("node:path"));
var import_node_zlib = require("node:zlib");
var MAX_TRACE_BYTES = 512 * 1024 * 1024;
function readZip(file, wanted, budget = { left: MAX_TRACE_BYTES }) {
  const fd = (0, import_node_fs2.openSync)(file, "r");
  try {
    const size = (0, import_node_fs2.fstatSync)(fd).size;
    const read = (position, length) => {
      const buffer = Buffer.alloc(length);
      (0, import_node_fs2.readSync)(fd, buffer, 0, length, position);
      return buffer;
    };
    const tailLength = Math.min(size, 22 + 65535);
    const tail = read(size - tailLength, tailLength);
    const end = tail.lastIndexOf(Buffer.from([80, 75, 5, 6]));
    if (end < 0) throw new Error("No zip end record");
    const count = tail.readUInt16LE(end + 10);
    const directorySize = tail.readUInt32LE(end + 12);
    const directoryOffset = tail.readUInt32LE(end + 16);
    if (count === 65535 || directoryOffset === 4294967295) throw new Error("A zip64 trace");
    const directory = read(directoryOffset, directorySize);
    const out = [];
    for (let at = 0, n = 0; n < count; n++) {
      if (directory.readUInt32LE(at) !== 33639248) throw new Error("A corrupt zip directory");
      const method = directory.readUInt16LE(at + 10);
      const compressed = directory.readUInt32LE(at + 20);
      const plain = directory.readUInt32LE(at + 24);
      const nameLength = directory.readUInt16LE(at + 28);
      const extraLength = directory.readUInt16LE(at + 30);
      const commentLength = directory.readUInt16LE(at + 32);
      const offset = directory.readUInt32LE(at + 42);
      const name = directory.toString("utf8", at + 46, at + 46 + nameLength);
      at += 46 + nameLength + extraLength + commentLength;
      if (!wanted(name)) continue;
      budget.left -= plain;
      if (budget.left < 0) throw new Error("A trace too large to read");
      const header = read(offset, 30);
      const start = offset + 30 + header.readUInt16LE(26) + header.readUInt16LE(28);
      const bytes = read(start, compressed);
      if (method === 0) out.push(bytes.toString("utf8"));
      else if (method === 8) out.push(plain === 0 ? "" : (0, import_node_zlib.inflateRawSync)(bytes, { maxOutputLength: plain }).toString("utf8"));
      else throw new Error(`A zip entry compressed with method ${method}`);
    }
    return out;
  } finally {
    (0, import_node_fs2.closeSync)(fd);
  }
}
function readTrace(file) {
  try {
    const budget = { left: MAX_TRACE_BYTES };
    return {
      network: readZip(file, (name) => name.endsWith(".network"), budget),
      // The runner's own `test.trace` has steps, not the browser's actions.
      actions: readZip(file, (name) => name.endsWith(".trace") && !name.endsWith("test.trace"), budget)
    };
  } catch {
    return null;
  }
}
function footprintFromTrace(traces, origins) {
  return footprintFromText(traces.map(readTrace), origins);
}
function takeFootprint(attempt, use, origins, log = console.log) {
  const traces = attempt.attachments.filter((a) => a.name === "trace" && a.contentType === "application/zip" && a.path);
  const baseUrls = [process.env.BASE_URL, use.baseURL].filter((url) => typeof url === "string" && url !== "");
  const footprint = footprintFromTrace(traces.map((a) => a.path), { baseUrls, origins });
  const policy = typeof use.peepsCustomerTrace === "string" ? use.peepsCustomerTrace : void 0;
  if (!keepsTrace(policy, attempt)) {
    for (const trace of traces) {
      attempt.attachments.splice(attempt.attachments.indexOf(trace), 1);
      try {
        (0, import_node_fs2.unlinkSync)(trace.path);
        (0, import_node_fs2.rmdirSync)(import_node_path2.default.dirname(trace.path));
      } catch (error) {
        if (error.code !== "ENOTEMPTY") log(`[peeps] could not remove a recorded trace: ${String(error)}`);
      }
    }
  }
  return footprint;
}

// src/inventory.ts
var import_node_child_process = require("node:child_process");
var import_node_crypto = require("node:crypto");
var import_node_util = require("node:util");
var execFileAsync = (0, import_node_util.promisify)(import_node_child_process.execFile);
function gitBlobSha(content) {
  return (0, import_node_crypto.createHash)("sha1").update(`blob ${content.length}\0`).update(content).digest("hex");
}

// src/peeps.ts
var PEEPS_OIDC_AUDIENCE = "https://peepsai.com";
function expiryOf(token) {
  const parts = token.split(".");
  if (parts.length !== 3) return Number.MAX_SAFE_INTEGER;
  try {
    const payload = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
    return typeof payload.exp === "number" ? payload.exp * 1e3 : Number.MAX_SAFE_INTEGER;
  } catch {
    return Number.MAX_SAFE_INTEGER;
  }
}
var PeepsHttpError = class extends Error {
  constructor(path4, status, body) {
    super(`Peeps ${path4} \u2192 ${status}: ${body.slice(0, 500)}`);
    this.path = path4;
    this.status = status;
    this.body = body;
    this.name = "PeepsHttpError";
  }
  /** The `error` code of a JSON body, e.g. `batch_closed`; null otherwise. */
  get code() {
    try {
      const parsed = JSON.parse(this.body);
      return typeof parsed.error === "string" ? parsed.error : null;
    } catch {
      return null;
    }
  }
};
var PeepsClient = class {
  constructor(env) {
    this.env = env;
  }
  tokenPromise = null;
  tokenExpiresAt = 0;
  /**
   * The bearer token Peeps accepts for this job. GitHub's OIDC tokens live
   * about ten minutes and can be re-requested for as long as the job runs, so
   * an agent session lasting longer than that re-mints transparently.
   */
  async token() {
    if (this.tokenPromise && Date.now() < this.tokenExpiresAt - 6e4) return this.tokenPromise;
    this.tokenPromise = this.mintToken().then((token) => {
      this.tokenExpiresAt = expiryOf(token);
      return token;
    });
    return this.tokenPromise;
  }
  async mintToken() {
    if (this.env.idToken) return this.env.idToken;
    if (this.env.oidc) {
      const url = new URL(this.env.oidc.requestUrl);
      url.searchParams.set("audience", PEEPS_OIDC_AUDIENCE);
      for (let attempt = 1; ; attempt++) {
        const response = await fetch(url, {
          headers: {
            Authorization: `Bearer ${this.env.oidc.requestToken}`,
            Accept: "application/json"
          }
        });
        if (response.ok) {
          const data = await response.json();
          if (!data.value) throw new Error("GitHub returned no OIDC token value");
          return data.value;
        }
        if (response.status < 500 || attempt >= 5) {
          throw new Error(
            `Could not obtain a GitHub OIDC token (${response.status}). Does the job have \`permissions: id-token: write\`?`
          );
        }
        console.log(`[peeps] OIDC token request returned ${response.status}; retrying (${attempt}/5)`);
        await new Promise((r) => setTimeout(r, 2e3 * attempt));
      }
    }
    const apiKey = process.env.PEEPS_API_KEY;
    if (apiKey) return apiKey;
    throw new Error(
      this.env.platform === "gitlab" ? "No credentials: give the Peeps job `id_tokens: { PEEPS_ID_TOKEN: { aud: https://peepsai.com } }`, or set PEEPS_API_KEY." : "No credentials: run inside GitHub Actions with `id-token: write`, or set PEEPS_API_KEY."
    );
  }
  /** Raw upload (artifacts). Retries transient failures a couple of times. */
  async postBytes(path4, bytes) {
    let lastError;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const response = await fetch(`${this.env.peepsUrl}${path4}`, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${await this.token()}`,
            "Content-Type": "application/octet-stream",
            "Content-Length": String(bytes.byteLength),
            "User-Agent": "peeps-action/0.1"
          },
          body: new Uint8Array(bytes),
          signal: AbortSignal.timeout(12e4)
        });
        if (response.ok) return;
        const text = await response.text();
        if (response.status < 500 && response.status !== 408 && response.status !== 429) {
          throw new Error(`Peeps ${path4} \u2192 ${response.status}: ${text.slice(0, 300)}`);
        }
        lastError = new Error(`Peeps ${path4} \u2192 ${response.status}`);
      } catch (error) {
        lastError = error;
      }
      await new Promise((r) => setTimeout(r, 1500 * (attempt + 1)));
    }
    throw lastError instanceof Error ? lastError : new Error(String(lastError));
  }
  /** GET that treats 204 as "nothing" (long-poll idle) instead of an error. */
  async getOrNull(path4) {
    const response = await fetch(`${this.env.peepsUrl}${path4}`, {
      headers: {
        Authorization: `Bearer ${await this.token()}`,
        Accept: "application/json",
        "User-Agent": "peeps-action/0.1"
      },
      signal: AbortSignal.timeout(4e4)
    });
    if (response.status === 204) return null;
    const text = await response.text();
    if (!response.ok) {
      throw new PeepsHttpError(path4, response.status, text);
    }
    return JSON.parse(text);
  }
  async get(path4, signal) {
    const response = await fetch(`${this.env.peepsUrl}${path4}`, {
      headers: {
        Authorization: `Bearer ${await this.token()}`,
        Accept: "application/json",
        "User-Agent": "peeps-action/0.1"
      },
      ...signal ? { signal } : {}
    });
    const text = await response.text();
    if (!response.ok) {
      throw new PeepsHttpError(path4, response.status, text);
    }
    return JSON.parse(text);
  }
  async post(path4, body) {
    const response = await fetch(`${this.env.peepsUrl}${path4}`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${await this.token()}`,
        "Content-Type": "application/json",
        Accept: "application/json",
        "User-Agent": "peeps-action/0.1"
      },
      body: JSON.stringify(body)
    });
    const text = await response.text();
    if (!response.ok) {
      throw new PeepsHttpError(path4, response.status, text);
    }
    return text ? JSON.parse(text) : {};
  }
};

// src/reporter.ts
function testFileOf(test) {
  for (let suite = test.parent; suite; suite = suite.parent) if (suite.type === "file" && suite.location) return suite.location.file;
  return test.location.file;
}
var TITLE_PATH_SEPARATOR = " \u203A ";
function identityOf(test, rootDirAbs, rootDirRepo) {
  const rel = import_node_path3.default.relative(rootDirAbs, test.location.file).split(import_node_path3.default.sep).join("/");
  const trimmedRoot = rootDirRepo.trim();
  const root = trimmedRoot === "" || trimmedRoot === "." || trimmedRoot === "./" ? "" : trimmedRoot.replace(/^\.\//, "").replace(/\/+$/, "");
  const repoPath = root === "" ? rel : `${root}/${rel}`;
  const titles = test.titlePath().filter((t) => t !== "");
  const projectName = test.parent.project()?.name ?? "";
  const withoutFileAndProject = titles.slice(projectName ? 2 : 1);
  return {
    path: repoPath,
    titlePath: withoutFileAndProject.join(TITLE_PATH_SEPARATOR),
    pwProject: projectName
  };
}
function key(id) {
  return `${id.pwProject}\0${id.path}\0${id.titlePath}`;
}
var ATTACH_PLAN_DEADLINE_MS = 6e4;
var ATTACH_FLUSH_DEADLINE_MS = 6e4;
function attachDeadline(fallback) {
  const override = Number(process.env.PEEPS_ATTACH_DEADLINE_MS);
  return Number.isFinite(override) && override > 0 ? override : fallback;
}
function deadline(ms, what) {
  return new Promise((_, reject) => {
    setTimeout(() => reject(new Error(`${what} took longer than ${ms / 1e3}s`)), ms).unref();
  });
}
var PeepsCiReporter = class {
  plan;
  entries = /* @__PURE__ */ new Map();
  rootDirAbs = "";
  queues = /* @__PURE__ */ new Map();
  started = /* @__PURE__ */ new Set();
  pending = [];
  /** Attach mode: where attach-finish looks, and the plan request in flight. */
  attachDir;
  planned = null;
  /** Attach mode: events that arrived before the plan did, replayed once it lands. */
  buffered = null;
  batches = [];
  reportDir = null;
  /** Attach mode: planning missed its deadline, so a late answer must change nothing. */
  gaveUp = false;
  /** A narrowed run's runs whose attempt ended with a retry still to come. */
  awaitingRetry = /* @__PURE__ */ new Set();
  constructor(options = {}) {
    this.attachDir = options.attachDir ?? null;
    if (this.attachDir) {
      this.plan = { peepsUrl: "", rootDir: ".", runs: [] };
      return;
    }
    const planPath = process.env.PEEPS_PLAN_FILE;
    if (!planPath) throw new Error("PEEPS_PLAN_FILE is not set");
    this.plan = JSON.parse((0, import_node_fs3.readFileSync)(planPath, "utf8"));
    for (const entry of this.plan.runs) this.entries.set(key(entry), entry);
  }
  printsToStdio() {
    return false;
  }
  onBegin(config, suite) {
    this.rootDirAbs = config.rootDir;
    if (this.attachDir) {
      try {
        this.reportDir = htmlReportDir(config);
        this.buffered = [];
        this.planned = Promise.race([
          this.planAttachedRun(config, suite),
          deadline(attachDeadline(ATTACH_PLAN_DEADLINE_MS), "planning the run with Peeps")
        ]).then(
          () => this.replayBuffered(),
          (error) => {
            this.gaveUp = true;
            this.buffered = null;
            console.log(`[peeps] attach: could not plan this run with Peeps; it runs unreported: ${String(error)}`);
          }
        );
      } catch (error) {
        console.log(`[peeps] attach: ${String(error)}`);
      }
      return;
    }
    console.log(`[peeps] reporting ${this.entries.size} planned run(s) to ${this.plan.peepsUrl}`);
  }
  // The time is taken here, not on replay, so a buffered event keeps when it happened.
  onTestBegin(test) {
    const at = Date.now();
    if (this.buffered) this.buffered.push(() => this.testBegan(test, at));
    else this.guard(() => this.testBegan(test, at));
  }
  onTestEnd(test, result) {
    const at = Date.now();
    if (this.buffered) this.buffered.push(() => this.testEnded(test, result, at));
    else this.guard(() => this.testEnded(test, result, at));
  }
  replayBuffered() {
    const buffered = this.buffered ?? [];
    this.buffered = null;
    for (const replay of buffered) this.guard(replay);
  }
  /** In attach mode nothing the reporter does may throw into the customer's run. */
  guard(step) {
    if (!this.attachDir) return step();
    try {
      step();
    } catch (error) {
      console.log(`[peeps] attach: ${String(error)}`);
    }
  }
  async planAttachedRun(config, suite) {
    const env = readRunnerEnv(process.env);
    if (!env.sha) throw new Error("The commit sha is not set (GITHUB_SHA / CI_COMMIT_SHA)");
    let workspace = env.workspace;
    try {
      workspace = (0, import_node_fs3.realpathSync)(workspace);
    } catch {
    }
    const rootDir = import_node_path3.default.relative(workspace, config.rootDir).split(import_node_path3.default.sep).join("/") || ".";
    const tests = suite.allTests().map((t) => identityOf(t, config.rootDir, rootDir));
    const unique = [...new Map(tests.map((t) => [key(t), t])).values()];
    const files = [];
    for (const file of new Set(suite.allTests().map((t) => t.location.file))) {
      const bytes = await (0, import_promises.readFile)(file);
      files.push({
        path: import_node_path3.default.relative(workspace, file).split(import_node_path3.default.sep).join("/"),
        blobSha: gitBlobSha(bytes),
        content: bytes.toString("utf8")
      });
    }
    const peeps = new PeepsClient(env);
    const response = await peeps.post("/api/v1/ci/batches", {
      sha: env.sha,
      jobUrl: env.runUrl,
      baseUrl: process.env.BASE_URL ?? null,
      tests: unique,
      files
    });
    if (this.gaveUp) return;
    this.plan = { peepsUrl: env.peepsUrl, rootDir, runs: response.batches.flatMap((b) => b.runs) };
    for (const entry of this.plan.runs) this.entries.set(key(entry), entry);
    this.batches = response.batches.map((b) => ({ batchId: b.batchId, batchNumber: b.batchNumber }));
    console.log(`[peeps] attach: reporting ${this.entries.size} run(s) to ${env.peepsUrl}`);
    await this.writeAttachState();
  }
  async writeAttachState() {
    if (!this.attachDir || this.batches.length === 0) return;
    await (0, import_promises.writeFile)(
      import_node_path3.default.join(this.attachDir, "state.json"),
      JSON.stringify({ batches: this.batches, reportDir: this.reportDir }),
      { mode: 384 }
    );
  }
  testBegan(test, now) {
    const entry = this.entryFor(test);
    if (!entry) return;
    this.awaitingRetry.delete(entry.runId);
    if (!this.started.has(entry.runId)) {
      this.started.add(entry.runId);
      this.enqueue(entry, { type: "run_start", timestamp: now });
    }
    this.enqueue(entry, { type: "test_start", timestamp: now, testName: test.title });
  }
  testEnded(test, result, now) {
    const footprint = this.plan.footprints ? takeFootprint(
      { attachments: result.attachments, status: result.status, retry: result.retry, expectedStatus: test.expectedStatus },
      test.parent.project()?.use ?? {},
      this.plan.footprints.origins
    ) : void 0;
    const entry = this.entryFor(test);
    if (!entry) {
      if (this.attachDir && this.batches.length === 0) return;
      console.log(`[peeps] not planned, not reported: ${test.titlePath().join(" \u203A ")} (${result.status})`);
      return;
    }
    const sent = footprint ? sentFootprint(footprint, this.plan.footprints?.origins ?? [], {
      retry: result.retry,
      repeatEachIndex: test.repeatEachIndex,
      repeatEach: test.parent.project()?.repeatEach ?? 1,
      hiddenRequests: this.plan.footprints?.hiddenRequests.includes(entry.path) ?? false
    }) : void 0;
    if (this.plan.evidence) {
      const record = { testId: test.id, runId: entry.runId, retry: result.retry, passed: result.status === "passed", har: sent ? { paths: sent.paths, complete: sent.complete } : null, file: testFileOf(test) };
      const name = `att-${(0, import_node_crypto2.createHash)("sha256").update(test.id).digest("hex").slice(0, 16)}-${result.retry}.json`;
      try {
        (0, import_node_fs3.writeFileSync)(import_node_path3.default.join(this.plan.evidence.dir, name), JSON.stringify(record), { mode: 384, flag: "wx" });
      } catch (error2) {
        console.log(`[peeps] could not record what this attempt ran: ${String(error2)}`);
      }
    }
    const narrowed = this.plan.narrowed === true;
    const outcome = narrowed ? narrowedOutcome(test, result) : null;
    const error = outcome ? outcome.error : result.errors[0];
    this.enqueue(entry, {
      type: "test_end",
      timestamp: now,
      testName: test.title,
      status: outcome ? outcome.status : result.status,
      duration: Math.round(result.duration),
      error: error?.message?.slice(0, 4e3),
      errorStack: error?.stack?.slice(0, 8e3),
      retry: result.retry,
      ...sent ? { footprint: sent } : {}
    });
    if (narrowed ? isLastAttempt(test, result) : result.retry >= test.retries || result.status === "passed") {
      this.enqueue(entry, { type: "run_end", timestamp: now });
      this.pending.push(this.flush(entry));
    } else if (narrowed) {
      this.awaitingRetry.add(entry.runId);
    }
  }
  async onEnd() {
    if (this.planned) await this.planned;
    for (const runId of this.awaitingRetry) {
      const entry = this.plan.runs.find((r) => r.runId === runId);
      if (entry) this.enqueue(entry, { type: "run_end", timestamp: Date.now() });
    }
    for (const [runId, events] of this.queues) {
      if (events.length === 0) continue;
      const entry = this.plan.runs.find((r) => r.runId === runId);
      if (entry) this.pending.push(this.flush(entry));
    }
    const flushed = Promise.allSettled(this.pending);
    if (!this.attachDir) {
      await flushed;
      return;
    }
    await Promise.race([flushed, deadline(attachDeadline(ATTACH_FLUSH_DEADLINE_MS), "sending the results to Peeps")]).catch(
      (error) => console.log(`[peeps] attach: ${String(error)}; some results were not reported`)
    );
  }
  entryFor(test) {
    return this.entries.get(key(identityOf(test, this.rootDirAbs, this.plan.rootDir))) ?? null;
  }
  enqueue(entry, event) {
    const queue = this.queues.get(entry.runId) ?? [];
    queue.push(event);
    this.queues.set(entry.runId, queue);
  }
  async flush(entry) {
    const events = this.queues.get(entry.runId) ?? [];
    if (events.length === 0) return;
    this.queues.set(entry.runId, []);
    for (const batch of this.plan.footprints ? eventBatches(events) : [events]) await this.post(entry, batch);
  }
  async post(entry, events) {
    const url = `${this.plan.peepsUrl}/api/v1/runs/${entry.runId}/events`;
    const body = JSON.stringify({ events });
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const response = await fetch(url, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer v1.${entry.credential.exp}.${entry.credential.sig}`,
            "User-Agent": "peeps-action/0.1"
          },
          body,
          signal: AbortSignal.timeout(1e4)
        });
        if (response.ok) return;
        if (response.status < 500 && response.status !== 408 && response.status !== 429) {
          console.log(`[peeps] events for ${entry.runId} rejected: ${response.status} ${await response.text()}`);
          return;
        }
      } catch (error) {
        if (attempt === 2) console.log(`[peeps] events for ${entry.runId} failed: ${String(error)}`);
      }
      await new Promise((r) => setTimeout(r, 1e3 * (attempt + 1)));
    }
  }
};
function narrowedOutcome(test, result) {
  if (test.expectedStatus === "failed" && result.status === "failed") return { status: "passed" };
  if (test.expectedStatus === "failed" && result.status === "passed") {
    return { status: "failed", error: { message: "Expected to fail, but passed." } };
  }
  return { status: result.status, error: result.errors[0] };
}
function isLastAttempt(test, result) {
  if (result.retry >= test.retries || result.status === "interrupted") return true;
  return result.status === test.expectedStatus && !inSerialGroup(test);
}
function inSerialGroup(test) {
  for (let suite = test.parent; suite; suite = suite.parent) {
    if (suite._parallelMode === "serial") return true;
  }
  return false;
}
function htmlReportDir(config) {
  const html = config.reporter.find(([name]) => name === "html");
  if (!html) return null;
  const fromEnv = process.env.PLAYWRIGHT_HTML_OUTPUT_DIR || process.env.PLAYWRIGHT_HTML_REPORT;
  if (fromEnv) return import_node_path3.default.resolve(fromEnv);
  const configDir = config.configFile ? import_node_path3.default.dirname(config.configFile) : config.rootDir;
  const options = html[1] ?? {};
  if (options.outputFolder) return import_node_path3.default.resolve(configDir, options.outputFolder);
  for (let dir = configDir; ; dir = import_node_path3.default.dirname(dir)) {
    if ((0, import_node_fs3.existsSync)(import_node_path3.default.join(dir, "package.json"))) return import_node_path3.default.join(dir, "playwright-report");
    if (import_node_path3.default.dirname(dir) === dir) return import_node_path3.default.resolve("playwright-report");
  }
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  ATTACH_FLUSH_DEADLINE_MS,
  ATTACH_PLAN_DEADLINE_MS,
  TITLE_PATH_SEPARATOR,
  htmlReportDir,
  identityOf,
  isLastAttempt,
  narrowedOutcome,
  testFileOf
});
