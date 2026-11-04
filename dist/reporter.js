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
  identityOf: () => identityOf
});
module.exports = __toCommonJS(reporter_exports);
var import_node_fs2 = require("node:fs");
var import_promises = require("node:fs/promises");
var import_node_path2 = __toESM(require("node:path"));

// src/env.ts
var import_node_fs = require("node:fs");
var import_node_path = __toESM(require("node:path"));
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
    idToken: variable(env, "PEEPS_ID_TOKEN")
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
    idToken: null
  };
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
  constructor(path3, status, body) {
    super(`Peeps ${path3} \u2192 ${status}: ${body.slice(0, 500)}`);
    this.path = path3;
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
  async postBytes(path3, bytes) {
    let lastError;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const response = await fetch(`${this.env.peepsUrl}${path3}`, {
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
          throw new Error(`Peeps ${path3} \u2192 ${response.status}: ${text.slice(0, 300)}`);
        }
        lastError = new Error(`Peeps ${path3} \u2192 ${response.status}`);
      } catch (error) {
        lastError = error;
      }
      await new Promise((r) => setTimeout(r, 1500 * (attempt + 1)));
    }
    throw lastError instanceof Error ? lastError : new Error(String(lastError));
  }
  /** GET that treats 204 as "nothing" (long-poll idle) instead of an error. */
  async getOrNull(path3) {
    const response = await fetch(`${this.env.peepsUrl}${path3}`, {
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
      throw new PeepsHttpError(path3, response.status, text);
    }
    return JSON.parse(text);
  }
  async get(path3) {
    const response = await fetch(`${this.env.peepsUrl}${path3}`, {
      headers: {
        Authorization: `Bearer ${await this.token()}`,
        Accept: "application/json",
        "User-Agent": "peeps-action/0.1"
      }
    });
    const text = await response.text();
    if (!response.ok) {
      throw new PeepsHttpError(path3, response.status, text);
    }
    return JSON.parse(text);
  }
  async post(path3, body) {
    const response = await fetch(`${this.env.peepsUrl}${path3}`, {
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
      throw new PeepsHttpError(path3, response.status, text);
    }
    return text ? JSON.parse(text) : {};
  }
};

// src/reporter.ts
var TITLE_PATH_SEPARATOR = " \u203A ";
function identityOf(test, rootDirAbs, rootDirRepo) {
  const rel = import_node_path2.default.relative(rootDirAbs, test.location.file).split(import_node_path2.default.sep).join("/");
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
  constructor(options = {}) {
    this.attachDir = options.attachDir ?? null;
    if (this.attachDir) {
      this.plan = { peepsUrl: "", rootDir: ".", runs: [] };
      return;
    }
    const planPath = process.env.PEEPS_PLAN_FILE;
    if (!planPath) throw new Error("PEEPS_PLAN_FILE is not set");
    this.plan = JSON.parse((0, import_node_fs2.readFileSync)(planPath, "utf8"));
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
      workspace = (0, import_node_fs2.realpathSync)(workspace);
    } catch {
    }
    const rootDir = import_node_path2.default.relative(workspace, config.rootDir).split(import_node_path2.default.sep).join("/") || ".";
    const tests = suite.allTests().map((t) => identityOf(t, config.rootDir, rootDir));
    const unique = [...new Map(tests.map((t) => [key(t), t])).values()];
    const files = [];
    for (const file of new Set(suite.allTests().map((t) => t.location.file))) {
      const bytes = await (0, import_promises.readFile)(file);
      files.push({
        path: import_node_path2.default.relative(workspace, file).split(import_node_path2.default.sep).join("/"),
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
      import_node_path2.default.join(this.attachDir, "state.json"),
      JSON.stringify({ batches: this.batches, reportDir: this.reportDir }),
      { mode: 384 }
    );
  }
  testBegan(test, now) {
    const entry = this.entryFor(test);
    if (!entry) return;
    if (!this.started.has(entry.runId)) {
      this.started.add(entry.runId);
      this.enqueue(entry, { type: "run_start", timestamp: now });
    }
    this.enqueue(entry, { type: "test_start", timestamp: now, testName: test.title });
  }
  testEnded(test, result, now) {
    const entry = this.entryFor(test);
    if (!entry) {
      if (this.attachDir && this.batches.length === 0) return;
      console.log(`[peeps] not planned, not reported: ${test.titlePath().join(" \u203A ")} (${result.status})`);
      return;
    }
    const error = result.errors[0];
    this.enqueue(entry, {
      type: "test_end",
      timestamp: now,
      testName: test.title,
      status: result.status,
      duration: Math.round(result.duration),
      error: error?.message?.slice(0, 4e3),
      errorStack: error?.stack?.slice(0, 8e3),
      retry: result.retry
    });
    if (result.retry >= test.retries || result.status === "passed") {
      this.enqueue(entry, { type: "run_end", timestamp: now });
      this.pending.push(this.flush(entry));
    }
  }
  async onEnd() {
    if (this.planned) await this.planned;
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
function htmlReportDir(config) {
  const html = config.reporter.find(([name]) => name === "html");
  if (!html) return null;
  const fromEnv = process.env.PLAYWRIGHT_HTML_OUTPUT_DIR || process.env.PLAYWRIGHT_HTML_REPORT;
  if (fromEnv) return import_node_path2.default.resolve(fromEnv);
  const configDir = config.configFile ? import_node_path2.default.dirname(config.configFile) : config.rootDir;
  const options = html[1] ?? {};
  if (options.outputFolder) return import_node_path2.default.resolve(configDir, options.outputFolder);
  for (let dir = configDir; ; dir = import_node_path2.default.dirname(dir)) {
    if ((0, import_node_fs2.existsSync)(import_node_path2.default.join(dir, "package.json"))) return import_node_path2.default.join(dir, "playwright-report");
    if (import_node_path2.default.dirname(dir) === dir) return import_node_path2.default.resolve("playwright-report");
  }
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  ATTACH_FLUSH_DEADLINE_MS,
  ATTACH_PLAN_DEADLINE_MS,
  TITLE_PATH_SEPARATOR,
  htmlReportDir,
  identityOf
});
