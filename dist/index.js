"use strict";
var __create = Object.create;
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __getProtoOf = Object.getPrototypeOf;
var __hasOwnProp = Object.prototype.hasOwnProperty;
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

// src/inventory.ts
var import_node_child_process = require("node:child_process");
var import_node_crypto = require("node:crypto");
var import_promises2 = require("node:fs/promises");
var import_node_path3 = __toESM(require("node:path"));
var import_node_util = require("node:util");

// src/playwright-json.ts
var import_promises = require("node:fs/promises");
var import_node_os = require("node:os");
var import_node_path2 = __toESM(require("node:path"));
async function jsonReportTarget() {
  const dir = await (0, import_promises.mkdtemp)(import_node_path2.default.join(process.env.RUNNER_TEMP ?? (0, import_node_os.tmpdir)(), "peeps-json-"));
  const file = import_node_path2.default.join(dir, "report.json");
  return {
    env: { PLAYWRIGHT_JSON_OUTPUT_FILE: file, PLAYWRIGHT_JSON_OUTPUT_NAME: file },
    async read(stdout) {
      const text2 = await (0, import_promises.readFile)(file, "utf8").catch(() => null);
      return parseJsonReport(text2 ?? stdout);
    },
    cleanup: () => (0, import_promises.rm)(dir, { recursive: true, force: true })
  };
}
function parseJsonReport(text2) {
  try {
    return JSON.parse(text2);
  } catch {
    const start = text2.search(/^\{/m);
    if (start <= 0) return null;
    try {
      const report = JSON.parse(text2.slice(start));
      return report && typeof report === "object" && Array.isArray(report.suites) ? report : null;
    } catch {
      return null;
    }
  }
}

// src/inventory.ts
var execFileAsync = (0, import_node_util.promisify)(import_node_child_process.execFile);
function gitBlobSha(content) {
  return (0, import_node_crypto.createHash)("sha1").update(`blob ${content.length}\0`).update(content).digest("hex");
}
function specFilesOf(list) {
  const files = /* @__PURE__ */ new Set();
  const walk3 = (suite) => {
    for (const spec of suite.specs ?? []) files.add(spec.file);
    for (const child of suite.suites ?? []) walk3(child);
  };
  for (const suite of list.suites) walk3(suite);
  return [...files].sort();
}
function testFilesOf(list) {
  return [...new Set(list.suites.flatMap((suite) => suite.file ? [suite.file] : []))].sort();
}
async function listTests(env, extraArgs = []) {
  const args = ["playwright", "test", "--list", "--reporter=json", ...extraArgs];
  if (env.configPath) args.push("--config", env.configPath);
  const target = await jsonReportTarget();
  try {
    const { stdout } = await execFileAsync("npx", args, {
      cwd: env.workingDirectory,
      maxBuffer: 64 * 1024 * 1024,
      env: { ...process.env, CI: "1", ...target.env }
    });
    const list = await target.read(stdout);
    if (!list) throw new Error("playwright test --list wrote no JSON report");
    return list;
  } finally {
    await target.cleanup();
  }
}
async function specFilePayload(env, list) {
  const rootDirAbs = list.config.rootDir ?? env.workingDirectory;
  const files = [];
  for (const file of specFilesOf(list)) {
    const abs = import_node_path3.default.join(rootDirAbs, file);
    const bytes = await (0, import_promises2.readFile)(abs);
    files.push({
      path: import_node_path3.default.relative(env.workspace, abs).split(import_node_path3.default.sep).join("/"),
      blobSha: gitBlobSha(bytes),
      content: bytes.toString("utf8")
    });
  }
  return files;
}
async function buildInventoryRequest(env, list) {
  if (!env.sha) throw new Error("The commit sha is not set (GITHUB_SHA / CI_COMMIT_SHA)");
  const rootDirAbs = list.config.rootDir ?? env.workingDirectory;
  const rootDir = import_node_path3.default.relative(env.workspace, rootDirAbs).split(import_node_path3.default.sep).join("/") || ".";
  const files = await specFilePayload(env, list);
  return { sha: env.sha, rootDir, list, files };
}
async function runInventory(env, peeps) {
  const list = await listTests(env);
  const request = await buildInventoryRequest(env, list);
  const specs = request.files.length;
  const tests = specFilesOf(list).length ? countSpecs(list) : 0;
  console.log(`[peeps] inventory: ${tests} tests in ${specs} spec files at ${request.sha.slice(0, 7)}`);
  const result = await peeps.post("/api/v1/ci/inventory", request);
  console.log(`[peeps] inventory accepted: ${JSON.stringify(result.results)}`);
}
function countSpecs(list) {
  let n = 0;
  const walk3 = (suite) => {
    n += suite.specs?.length ?? 0;
    for (const child of suite.suites ?? []) walk3(child);
  };
  for (const suite of list.suites) walk3(suite);
  return n;
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
  constructor(path24, status, body) {
    super(`Peeps ${path24} \u2192 ${status}: ${body.slice(0, 500)}`);
    this.path = path24;
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
  async postBytes(path24, bytes) {
    let lastError;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const response = await fetch(`${this.env.peepsUrl}${path24}`, {
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
        const text2 = await response.text();
        if (response.status < 500 && response.status !== 408 && response.status !== 429) {
          throw new Error(`Peeps ${path24} \u2192 ${response.status}: ${text2.slice(0, 300)}`);
        }
        lastError = new Error(`Peeps ${path24} \u2192 ${response.status}`);
      } catch (error) {
        lastError = error;
      }
      await new Promise((r) => setTimeout(r, 1500 * (attempt + 1)));
    }
    throw lastError instanceof Error ? lastError : new Error(String(lastError));
  }
  /** GET that treats 204 as "nothing" (long-poll idle) instead of an error. */
  async getOrNull(path24) {
    const response = await fetch(`${this.env.peepsUrl}${path24}`, {
      headers: {
        Authorization: `Bearer ${await this.token()}`,
        Accept: "application/json",
        "User-Agent": "peeps-action/0.1"
      },
      signal: AbortSignal.timeout(4e4)
    });
    if (response.status === 204) return null;
    const text2 = await response.text();
    if (!response.ok) {
      throw new PeepsHttpError(path24, response.status, text2);
    }
    return JSON.parse(text2);
  }
  async get(path24, signal) {
    const response = await fetch(`${this.env.peepsUrl}${path24}`, {
      headers: {
        Authorization: `Bearer ${await this.token()}`,
        Accept: "application/json",
        "User-Agent": "peeps-action/0.1"
      },
      ...signal ? { signal } : {}
    });
    const text2 = await response.text();
    if (!response.ok) {
      throw new PeepsHttpError(path24, response.status, text2);
    }
    return JSON.parse(text2);
  }
  async post(path24, body) {
    const response = await fetch(`${this.env.peepsUrl}${path24}`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${await this.token()}`,
        "Content-Type": "application/json",
        Accept: "application/json",
        "User-Agent": "peeps-action/0.1"
      },
      body: JSON.stringify(body)
    });
    const text2 = await response.text();
    if (!response.ok) {
      throw new PeepsHttpError(path24, response.status, text2);
    }
    return text2 ? JSON.parse(text2) : {};
  }
};

// src/report.ts
var import_node_child_process5 = require("node:child_process");
var import_node_fs6 = require("node:fs");

// src/capture-config.ts
var import_node_crypto2 = require("node:crypto");
var import_promises3 = require("node:fs/promises");
var import_node_path4 = __toESM(require("node:path"));
var import_node_url = require("node:url");
var CONFIG_EXTENSIONS = [".ts", ".js", ".mts", ".mjs", ".cts", ".cjs"];
async function configLocation(env) {
  const cwd = await (0, import_promises3.realpath)(env.workingDirectory);
  const selected = env.configPath ? import_node_path4.default.resolve(cwd, env.configPath) : cwd;
  if (!(await (0, import_promises3.stat)(selected)).isDirectory()) return { dir: import_node_path4.default.dirname(selected), file: selected };
  for (const ext of CONFIG_EXTENSIONS) {
    const file = import_node_path4.default.join(selected, `playwright.config${ext}`);
    try {
      await (0, import_promises3.stat)(file);
      return { dir: selected, file };
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
  }
  return { dir: selected };
}
async function isModule(file) {
  if (/\.(mjs|mts)$/.test(file)) return true;
  if (/\.(cjs|cts)$/.test(file)) return false;
  let dir = import_node_path4.default.dirname(file);
  for (; ; ) {
    try {
      const text2 = await (0, import_promises3.readFile)(import_node_path4.default.join(dir, "package.json"), "utf8");
      try {
        return JSON.parse(text2).type === "module";
      } catch {
        return false;
      }
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    const parent = import_node_path4.default.dirname(dir);
    if (parent === dir) return false;
    dir = parent;
  }
}
var RECORD_TRACES = `const recordTrace = (use) => {
  const trace = use?.trace;
  const mode = (typeof trace === "string" ? trace : trace?.mode) ?? "off";
  if (!["off", "retain-on-failure", "on-first-retry", "retry-with-trace", "on-all-retries", "retain-on-first-failure", "retain-on-failure-and-retries"].includes(mode))
    return { ...use, peepsCustomerTrace: mode };
  return {
    ...use,
    peepsCustomerTrace: mode,
    trace: mode === "off"
      ? { mode: "on", snapshots: true, screenshots: false, sources: false }
      : { ...(typeof trace === "object" ? trace : {}), mode: "on" },
  };
};
withEvidence.use = recordTrace(withEvidence.use);
if (Array.isArray(config.projects))
  withEvidence.projects = config.projects.map((project) => project?.use?.trace === undefined ? project : { ...project, use: recordTrace(project.use) });
`;
var OWN_APP = `{
  // Playwright's own default: one webServer with a port, and no baseURL, is http://localhost:<port>.
  const servers = [withEvidence.webServer].flat().filter(Boolean);
  if (servers.length === 1 && servers[0].port !== undefined && withEvidence.use?.baseURL === undefined)
    withEvidence.use = { ...withEvidence.use, baseURL: "http://localhost:" + servers[0].port };
  delete withEvidence.webServer;
}
`;
var recordCoverage = (worker, dir) => `if (process.env.TEST_WORKER_INDEX !== undefined) {
  try {
    const fs = require("node:fs");
    const fromCli = require("node:module").createRequire(fs.realpathSync(process.argv[1]));
    const fromPlaywright = require("node:module").createRequire(fromCli.resolve("playwright/package.json"));
    const coverage = require(${JSON.stringify(worker)});
    const port = coverage.pickPort();
    if (port && coverage.installCoverage({ dir: ${JSON.stringify(dir)}, core: fromPlaywright("playwright-core"), test: fromPlaywright("playwright/test").test, port })) {
      const withPort = (launchOptions) => ({ ...launchOptions, args: [...(launchOptions?.args ?? []), "--remote-debugging-port=" + port] });
      const isChromium = (use) => (use?.browserName ?? withEvidence.use?.browserName ?? "chromium") === "chromium";
      const topLaunch = withEvidence.use?.launchOptions;
      if (isChromium(withEvidence.use)) withEvidence.use = { ...withEvidence.use, launchOptions: withPort(topLaunch) };
      if (Array.isArray(withEvidence.projects))
        withEvidence.projects = withEvidence.projects.map((project) => {
          if (!project || typeof project !== "object") return project;
          const own = project.use?.launchOptions ?? topLaunch;
          return { ...project, use: { ...project.use, launchOptions: isChromium(project.use) ? withPort(own) : own } };
        });
    }
  } catch (error) {
    console.warn("[peeps] not recording browser coverage in this worker: " + String(error));
  }
}
`;
async function prepareCaptureConfig(env, options = {}) {
  const { dir, file } = await configLocation(env);
  const esm = file ? await isModule(file) : false;
  const configPath = import_node_path4.default.join(dir, `.peeps-capture-${(0, import_node_crypto2.randomUUID)()}.config.${esm ? "mjs" : "cjs"}`);
  const load = !file ? "const loaded = {};" : esm ? `import * as loaded from ${JSON.stringify((0, import_node_url.pathToFileURL)(file).href)};` : `const loaded = await require(${JSON.stringify(file)});`;
  const body = `
const config = await (loaded && typeof loaded === "object" && "default" in loaded ? loaded.default : loaded);
if (!config || typeof config !== "object") throw new Error("Playwright config must export a single object");
if (config.use !== undefined && (!config.use || typeof config.use !== "object"))
  throw new Error("Playwright config.use must be an object");
let defaultVideo = "retain-on-failure";
if (config.use?.video === undefined) {
  // A system browser may exist without Playwright's video encoder. Use its
  // own registry to resolve the encoder, including host revision overrides.
  try {
    const fs = require("node:fs");
    const path = require("node:path");
    const createRequire = require("node:module").createRequire;
    const fromCli = createRequire(fs.realpathSync(process.argv[1]));
    const fromPlaywright = createRequire(fromCli.resolve("playwright/package.json"));
    const coreDir = path.dirname(fromPlaywright.resolve("playwright-core/package.json"));
    // Playwright moved its registry into coreBundle in newer releases.
    // Resolve from the CLI's core, not an unrelated hoisted dependency.
    const bundledRegistry = path.join(coreDir, "lib", "coreBundle.js");
    const registry = fs.existsSync(bundledRegistry)
      ? require(bundledRegistry).registry.registry
      : require(path.join(coreDir, "lib", "server", "registry", "index.js")).registry;
    const encoderPath = registry.findExecutable("ffmpeg").executablePath();
    if (!fs.statSync(encoderPath).isFile()) throw new Error("Encoder is not a file");
    fs.accessSync(encoderPath, fs.constants.X_OK);
  } catch {
    defaultVideo = "off";
    console.warn("[peeps] default video disabled: Playwright FFmpeg unavailable or unverifiable; run npx playwright install ffmpeg to enable failure video. Screenshot defaults still apply.");
  }
}
const withEvidence = {
  ...config,${options.defaultRetries === void 0 ? "" : `
  ...(config.retries === undefined ? { retries: ${options.defaultRetries} } : {}),`}
  use: {
    ...config.use,
    screenshot: config.use?.screenshot === undefined ? "only-on-failure" : config.use.screenshot,
    video: config.use?.video === undefined ? defaultVideo : config.use.video,
  },
};
${options.ownsApp ? OWN_APP : ""}${options.collectFootprints ? RECORD_TRACES : ""}${options.coverage ? recordCoverage(options.coverage.worker, options.coverage.dir) : ""}`;
  const source = esm ? `import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
${load}
${body}
export default withEvidence;
` : `module.exports = (async () => {
${load}
${body}
return { default: withEvidence };
})();
`;
  try {
    await (0, import_promises3.writeFile)(configPath, source, { flag: "wx", mode: 384 });
  } catch (error) {
    if (error.code !== "EEXIST") await (0, import_promises3.unlink)(configPath).catch(() => {
    });
    throw error;
  }
  return { configPath, cleanup: () => (0, import_promises3.unlink)(configPath) };
}

// src/report.ts
var import_promises8 = require("node:fs/promises");
var import_node_os3 = require("node:os");
var import_node_path15 = __toESM(require("node:path"));

// src/narrow.ts
var MAX_GREP_BYTES = 64 * 1024;
function isNarrowed(response) {
  return response.batches.length > 0 && response.batches.every((b) => b.narrowed === true) && (response.failures ?? []).length === 0;
}
function answeredNarrowed(response) {
  return response.batches.some((b) => b.narrowed === true);
}
function withReporterTitles(runs, listed) {
  const reporterTitles = new Map(listed.map((test) => [identity(test), test.titles.filter((title) => title !== "").join(" \u203A ")]));
  return runs.map((run) => ({ ...run, titlePath: reporterTitles.get(identity(run)) ?? run.titlePath }));
}
function escapeRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&").replace(/\n/g, "\\n").replace(/\r/g, "\\r").replace(/\u2028/g, "\\u2028").replace(/\u2029/g, "\\u2029");
}
function exactGrepFor(selected, listed) {
  const wanted = new Set(selected.map(identity));
  const alternatives = new Set(
    listed.filter((test) => wanted.has(identity(test))).map((test) => {
      const values = test.tags.map(escapeRegex).join("|");
      const own = values ? `(?: (?:${values}))*` : "";
      const inherited = values ? `(?: (?:${values})(?: [^@ ][^ ]*)*)*` : "";
      const parts = [test.pwProject ?? "", test.file, ...test.titles].filter((part) => part !== "");
      return parts.map(escapeRegex).join(`${inherited} `) + own;
    })
  );
  return `/^ *(?:${[...alternatives].join("|")})$/`;
}
function selectionDifference(selected, listed) {
  const wanted = new Set(selected.map(identity));
  const found = new Set(listed.map(identity));
  return {
    missing: selected.filter((test) => !found.has(identity(test))),
    extra: listed.filter((test) => !wanted.has(identity(test)))
  };
}
function identity(test) {
  return JSON.stringify([test.pwProject ?? "", test.path, test.titlePath]);
}

// src/footprint/test-sources.ts
var import_node_path6 = __toESM(require("node:path"));

// src/reach/process.ts
var import_node_child_process2 = require("node:child_process");
var import_promises4 = require("node:fs/promises");
var import_node_os2 = require("node:os");
var import_node_path5 = __toESM(require("node:path"));
var HEAP_MB = 512;
async function runBundled(scanner, input2, budgetMs) {
  const scratch = await (0, import_promises4.mkdtemp)(import_node_path5.default.join(process.env.RUNNER_TEMP ?? (0, import_node_os2.tmpdir)(), "peeps-reach-"));
  try {
    const inputFile = import_node_path5.default.join(scratch, "input.json");
    await (0, import_promises4.writeFile)(inputFile, JSON.stringify(input2), { mode: 384 });
    return await new Promise((resolve) => {
      const child = (0, import_node_child_process2.spawn)(process.execPath, [`--max-old-space-size=${HEAP_MB}`, scanner, inputFile], { stdio: ["ignore", "pipe", "pipe"] });
      const chunks = [];
      let timedOut = false;
      const timer = setTimeout(() => {
        timedOut = true;
        child.kill("SIGKILL");
      }, budgetMs);
      child.stdout.on("data", (chunk) => chunks.push(chunk));
      child.stderr.resume();
      child.on("error", () => {
        clearTimeout(timer);
        resolve(null);
      });
      child.on("close", (code) => {
        clearTimeout(timer);
        if (timedOut) return resolve("timeout");
        if (code !== 0) return resolve(null);
        try {
          resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
        } catch {
          resolve(null);
        }
      });
    });
  } finally {
    await (0, import_promises4.rm)(scratch, { recursive: true, force: true });
  }
}

// src/footprint/test-sources.ts
var BUDGET_MS = 2e4;
async function workspaceTestSources(workspace, specs, globalSetups, options = {}) {
  const answer = await runBundled(
    options.scanner ?? import_node_path6.default.join(__dirname, "reach.js"),
    { kind: "testSources", root: workspace, specs, globalSetups, deadlineMs: options.budgetMs ?? BUDGET_MS },
    options.budgetMs ?? BUDGET_MS
  ).catch(() => null);
  if (answer && answer !== "timeout") return answer;
  return { reasons: [{ file: "the suite", why: answer === "timeout" ? "took too long to read" : "couldn't be read" }], hiddenRequests: specs };
}

// src/evidence/job.ts
var import_node_fs2 = require("node:fs");
var import_node_path7 = __toESM(require("node:path"));

// src/version.ts
var ACTION_VERSION = "1.13.0";

// src/evidence/codec.ts
var RECORDING_CODEC_VERSION = 2;
var LAYERS = ["browser", "server", "worker_thread", "worker_process", "build", "database"];
var EVIDENCE_KINDS = ["code", "out", "css", "route", "table"];
var MAGIC = [80, 81, 73, 82];
var NO_LAYER = 255;
var MAX_STRING_BYTES = 4096;
var byBytes = (a, b) => Buffer.compare(Buffer.from(a, "utf8"), Buffer.from(b, "utf8"));
function fail(message) {
  throw new Error(`recording codec: ${message}`);
}
function ascending(items, compare, what) {
  const sorted = [...items].sort(compare);
  for (let i = 1; i < sorted.length; i++) if (compare(sorted[i - 1], sorted[i]) === 0) fail(`duplicate ${what}`);
  return sorted;
}
function bitmask(vocabulary, values, what) {
  let mask = 0;
  for (const value of values) {
    const index = vocabulary.indexOf(value);
    if (index < 0) fail(`${what}: unknown ${String(value)}`);
    mask |= 1 << index;
  }
  return mask;
}
function encodePayload(value) {
  const bytes = [];
  const u8 = (n) => bytes.push(n);
  const varint = (n) => {
    if (!Number.isSafeInteger(n) || n < 0) fail(`bad integer ${n}`);
    let rest = n;
    while (rest >= 128) {
      bytes.push(rest % 128 | 128);
      rest = Math.floor(rest / 128);
    }
    bytes.push(rest);
  };
  const string = (s2) => {
    const utf8 = Buffer.from(s2, "utf8");
    if (utf8.length === 0) fail("empty string");
    if (utf8.length > MAX_STRING_BYTES) fail("string too long");
    varint(utf8.length);
    bytes.push(...utf8);
  };
  const strings = value.kind === "fingerprint" ? [...value.entities.flatMap((e) => e.file === null ? [e.id] : [e.id, e.file]), ...value.global] : [...value.universe.loadedFiles, ...value.universe.ambient, ...value.members.flatMap((m) => m.tokens)];
  const dictionary = [...new Set(strings)].sort(byBytes);
  const indexOf = new Map(dictionary.map((entry, index) => [entry, index]));
  const indexList = (entries) => {
    const indexes = [...new Set(entries)].map((e) => indexOf.get(e)).sort((a, b) => a - b);
    varint(indexes.length);
    indexes.forEach((index, i) => varint(i === 0 ? index : index - indexes[i - 1] - 1));
  };
  bytes.push(...MAGIC);
  const layered = value.kind === "footprints" ? value.members.filter((m) => m.partialLayers !== void 0).length : 0;
  if (value.kind === "footprints" && layered > 0 && layered < value.members.length) fail("partial layers on some members only");
  u8(layered > 0 ? 2 : 1);
  u8(value.kind === "fingerprint" ? 1 : 2);
  varint(dictionary.length);
  for (const entry of dictionary) string(entry);
  if (value.kind === "fingerprint") {
    const entities = ascending(value.entities, (a, b) => byBytes(a.id, b.id), "entity");
    varint(entities.length);
    for (const entity of entities) {
      if (!/^[0-9a-f]{16}$/.test(entity.valueHash)) fail("bad valueHash");
      varint(indexOf.get(entity.id));
      varint(entity.file === null ? 0 : indexOf.get(entity.file) + 1);
      const layer = entity.layer === null ? NO_LAYER : LAYERS.indexOf(entity.layer);
      if (layer < 0) fail(`unknown layer ${String(entity.layer)}`);
      u8(layer);
      bytes.push(...Buffer.from(entity.valueHash, "hex"));
    }
    indexList(value.global);
    return new Uint8Array(bytes);
  }
  if (value.browser === null) u8(0);
  else {
    u8(1);
    string(value.browser.name);
    string(value.browser.version);
  }
  u8(bitmask(LAYERS, value.universe.layers, "layers"));
  u8(bitmask(EVIDENCE_KINDS, value.universe.measured, "measured"));
  indexList(value.universe.loadedFiles);
  indexList(value.universe.ambient);
  const members = ascending(value.members, (a, b) => byBytes(a.run, b.run), "run");
  varint(members.length);
  for (const member of members) {
    string(member.run);
    const attempts = ascending(member.attempts, (a, b) => a.retry - b.retry, "retry");
    varint(attempts.length);
    for (const attempt of attempts) {
      varint(attempt.retry);
      u8(attempt.passed ? 1 : 0);
    }
    u8(bitmask(EVIDENCE_KINDS, member.partial, "partial"));
    if (member.partialLayers !== void 0) {
      if (member.partialLayers.length === 0 !== (member.partial.length === 0)) fail("partial layers without partial kinds, or the reverse");
      u8(bitmask(LAYERS, member.partialLayers, "partialLayers"));
    }
    indexList(member.tokens);
  }
  return new Uint8Array(bytes);
}

// src/evidence/fingerprint/wire.ts
function fromWire(wire) {
  return {
    entities: new Map(wire.entities),
    files: new Map(wire.files),
    global: wire.global,
    scripts: new Map(wire.scripts),
    sheets: new Map(wire.sheets)
  };
}

// src/evidence/hash.ts
var import_node_crypto3 = require("node:crypto");
var ROUTE_ENCODER_VERSION = 1;
var KEY_BYTES = 32;
var ID_HEX = 32;
var SEGMENT_HEX = 16;
var KINDS = /* @__PURE__ */ new Set(["fn", "file", "css", "out"]);
function parseProjectKey(text2) {
  if (typeof text2 !== "string") return null;
  if (/^[0-9a-f]{64}$/.test(text2)) return Buffer.from(text2, "hex");
  if (!/^[A-Za-z0-9_-]+$/.test(text2)) return null;
  const key = Buffer.from(text2, "base64url");
  return key.length === KEY_BYTES && key.toString("base64url") === text2 ? key : null;
}
function keyedId(key, kind, value) {
  return (0, import_node_crypto3.createHmac)("sha256", key).update(`${kind}\0${value}`).digest("hex").slice(0, ID_HEX);
}
function segmentId(key, segment) {
  return (0, import_node_crypto3.createHmac)("sha256", key).update(`route-segment\0${segment}`).digest("hex").slice(0, SEGMENT_HEX);
}
function tokenOf(key, plain) {
  const table = /^(table:[rw]):(.+)$/s.exec(plain);
  if (table) return `${table[1]}:${keyedId(key, "table", table[2])}`;
  const colon = plain.indexOf(":");
  const kind = plain.slice(0, colon);
  const rest = plain.slice(colon + 1);
  if (kind === "route") return `route:${encodeMatcher(key, rest)}`;
  if (colon < 1 || !KINDS.has(kind)) throw new Error(`No token kind for ${kind || "an unnamed key"}`);
  return `${kind}:${keyedId(key, kind, rest)}`;
}
function pathToken(key, path24) {
  return `route:${encodePath(key, path24)}`;
}
function segmentsOf(route) {
  return route.split("/").map((raw) => raw.split(";", 1)[0]).filter((segment) => segment !== "").map((segment) => {
    try {
      return decodeURIComponent(segment);
    } catch {
      return ":id";
    }
  });
}
function encodeMatcher(key, route) {
  const out = segmentsOf(route).map((segment) => {
    if (segment === "*" || segment === "**") return segment;
    if (/^\[\[\.\.\.[^\]]+\]\]$/.test(segment)) return "**";
    if (/^\[\.\.\.[^\]]+\]$/.test(segment)) return "*";
    if (segment.startsWith(":") || /^\[[^\]]+\]$/.test(segment)) return ":id";
    return segmentId(key, segment.toLowerCase());
  });
  return `/${out.join("/")}`;
}
function encodePath(key, path24) {
  const out = segmentsOf(path24).map((segment) => segment === ":id" ? segment : segmentId(key, segment.toLowerCase()));
  return `/${out.join("/")}`;
}
function evidenceTokens(key, evidence) {
  return [.../* @__PURE__ */ new Set([...evidence.keys.map((k) => tokenOf(key, k)), ...evidence.paths.map((p) => pathToken(key, p))])].sort();
}

// src/evidence/port.ts
var sortedUnique = (values) => [...new Set(values)].sort();
function unionEvidence(parts) {
  const partial = sortedUnique(parts.flatMap((p) => p.partial));
  const layers = new Set(parts.filter((p) => p.partial.length > 0).flatMap((p) => p.layers ?? LAYERS));
  return {
    keys: sortedUnique(parts.flatMap((p) => p.keys)),
    paths: sortedUnique(parts.flatMap((p) => p.paths)),
    partial,
    ...partial.length > 0 ? { layers: LAYERS.filter((layer) => layers.has(layer)) } : {},
    reasons: sortedUnique(parts.flatMap((p) => p.reasons))
  };
}

// src/evidence/recording.ts
var VALUE_HEX = 16;
function layerOf(plain) {
  if (plain.startsWith("fn:browser:") || plain.startsWith("css:")) return "browser";
  if (plain.startsWith("out:")) return "build";
  return "server";
}
function fingerprintRecording(fingerprint, key) {
  const entities = [];
  for (const [plain, values] of fingerprint.entities) {
    const source = fingerprint.files.get(plain);
    entities.push({
      id: tokenOf(key, plain),
      file: source === void 0 ? null : tokenOf(key, `file:${source}`),
      layer: layerOf(plain),
      valueHash: keyedId(key, "value", values).slice(0, VALUE_HEX)
    });
  }
  const global = fingerprint.global.filter((plain) => fingerprint.entities.has(plain)).map((plain) => tokenOf(key, plain));
  return { kind: "fingerprint", entities, global };
}
function footprintsRecording(key, input2) {
  const members = input2.members.map(({ run, attempts, evidence }) => {
    const layered = input2.codecVersion === 2;
    if (evidence.length === 0) return { run, attempts, partial: [...input2.measured], ...layered && input2.measured.length > 0 ? { partialLayers: [...LAYERS] } : layered ? { partialLayers: [] } : {}, tokens: [] };
    const union = unionEvidence(evidence);
    return { run, attempts, partial: union.partial, ...layered ? { partialLayers: union.layers ?? [] } : {}, tokens: evidenceTokens(key, union) };
  });
  return { kind: "footprints", browser: input2.browser ?? null, universe: { layers: input2.layers, measured: input2.measured, loadedFiles: (input2.loadedFiles ?? []).map((f) => tokenOf(key, f)), ambient: (input2.ambient ?? []).map((k) => tokenOf(key, k)) }, members };
}

// src/evidence/upload.ts
var import_node_crypto4 = require("node:crypto");
var import_node_zlib = require("node:zlib");
var FINGERPRINT_PATH = "/api/v1/ci/impact/fingerprint";
var evidencePath = (batchId) => `/api/v1/ci/batches/${encodeURIComponent(batchId)}/evidence`;
var UPLOAD_TIMEOUT_MS = 3e4;
var MAX_BLOB_BYTES = 8 * 1024 * 1024;
var MAX_MEMBERS = 16e3;
var PROTOCOL_VERSION = 2;
function peepsTransport(peepsUrl, token) {
  const send = async (path24, body, contentType, timeoutMs) => {
    const response = await fetch(`${peepsUrl}${path24}`, {
      method: "POST",
      headers: { Authorization: `Bearer ${await token()}`, "Content-Type": contentType, Accept: "application/json", "User-Agent": "peeps-action/0.1" },
      body,
      signal: AbortSignal.timeout(timeoutMs)
    });
    const text2 = await response.text();
    if (!response.ok) throw new Error(`Peeps ${path24.split("?")[0]} \u2192 ${response.status}`);
    return text2 ? JSON.parse(text2) : {};
  };
  return {
    postBytes: (path24, bytes, timeoutMs) => send(path24, new Uint8Array(bytes), "application/octet-stream", timeoutMs),
    postJson: (path24, body, timeoutMs) => send(path24, JSON.stringify(body), "application/json", timeoutMs)
  };
}
function gzipRecording(blob) {
  return (0, import_node_zlib.gzipSync)(encodePayload(blob));
}
var say = (message) => console.log(`[peeps] ${message}`);
async function uploadFingerprint(transport, input2, log = say) {
  try {
    const payload = encodePayload(input2.blob);
    const digest = (0, import_node_crypto4.createHash)("sha256").update(payload).digest("hex");
    const bytes = (0, import_node_zlib.gzipSync)(payload);
    if (bytes.length > MAX_BLOB_BYTES) throw new Error(`the fingerprint is ${bytes.length} bytes, over ${MAX_BLOB_BYTES}`);
    const query = new URLSearchParams({ projectId: input2.projectId, protocolVersion: String(PROTOCOL_VERSION), binding: input2.binding, keyVersion: input2.keyVersion, digest });
    if (/^[0-9a-f]{40}$/.test(input2.base)) query.set("base", input2.base);
    if (input2.leg.length >= 1 && input2.leg.length <= 100 && !/[\u0000-\u001f\u007f]/.test(input2.leg)) query.set("leg", input2.leg);
    const answer = await transport.postBytes(`${FINGERPRINT_PATH}?${query}`, bytes, UPLOAD_TIMEOUT_MS);
    if (typeof answer?.uploadId !== "string" || answer.uploadId === "" || answer.uploadId.length > 64) throw new Error("Peeps gave no upload id");
    if (answer.digest !== void 0 && answer.digest !== digest) throw new Error("Peeps read other bytes than were sent");
    return { uploadId: answer.uploadId, digest };
  } catch (error) {
    log(`not recording what this job's tests ran: the build's fingerprint didn't upload (${String(error).slice(0, 300)})`);
    return null;
  }
}
async function uploadEvidence(transport, input2, log = say) {
  try {
    if (input2.members.length > MAX_MEMBERS) throw new Error(`${input2.members.length} tests, over ${MAX_MEMBERS}`);
    const blob = footprintsRecording(input2.key, { layers: input2.layers, measured: input2.measured, loadedFiles: input2.loadedFiles, ambient: input2.ambient, browser: input2.browser, members: input2.members, codecVersion: input2.codecVersion });
    const bytes = gzipRecording(blob);
    if (bytes.length > MAX_BLOB_BYTES) throw new Error(`the footprints are ${bytes.length} bytes, over ${MAX_BLOB_BYTES}`);
    await transport.postBytes(`${evidencePath(input2.batchId)}?protocolVersion=${PROTOCOL_VERSION}`, bytes, UPLOAD_TIMEOUT_MS);
    return true;
  } catch (error) {
    log(`not recording what this job's tests ran: the footprints didn't upload (${String(error).slice(0, 300)})`);
    return false;
  }
}

// src/evidence/job.ts
var toolchain = (codecVersion = RECORDING_CODEC_VERSION) => `peeps-action@${ACTION_VERSION}/codec${codecVersion}/routes${ROUTE_ENCODER_VERSION}`;
var FINGERPRINT_BUDGET_MS = 9e4;
async function scannerFingerprint(nextDir, sourcePrefix) {
  const answer = await runBundled(import_node_path7.default.join(__dirname, "reach.js"), { kind: "fingerprint", root: nextDir, nextDir, sourcePrefix }, FINGERPRINT_BUDGET_MS);
  return answer && answer !== "timeout" ? fromWire(answer) : null;
}
var say2 = (line) => console.log(`[peeps] ${line}`);
async function prepareImpact(input2, log = say2) {
  const asked = input2.collect.filter((c) => c.fingerprint);
  if (asked.length === 0) return null;
  const nextDir = import_node_path7.default.join(input2.appDir, ".next");
  if (!(0, import_node_fs2.existsSync)(import_node_path7.default.join(nextDir, "BUILD_ID"))) {
    log("not recording what this job's tests ran: no Next build in the working directory to fingerprint");
    return null;
  }
  let base;
  let sourcePrefix;
  try {
    const { git } = input2.repository;
    if ((await git("rev-parse", "HEAD")).trim() !== input2.sha) throw new Error("not the job's commit");
    const root = (0, import_node_fs2.realpathSync)((await git("rev-parse", "--show-toplevel")).trim());
    sourcePrefix = import_node_path7.default.relative(root, (0, import_node_fs2.realpathSync)(input2.appDir)).split(import_node_path7.default.sep).join("/");
    if (input2.eventName === "pull_request") {
      await git("rev-parse", "--verify", "--quiet", "HEAD^2");
      base = (await git("rev-parse", "--verify", "--quiet", "HEAD^1")).trim();
    } else {
      base = "";
    }
  } catch {
    log("not recording what this job's tests ran: the checkout isn't the job's commit, or a pull request's isn't GitHub's merge");
    return null;
  }
  let fingerprint;
  try {
    fingerprint = await (input2.fingerprint ?? scannerFingerprint)(nextDir, sourcePrefix);
    if (!fingerprint) throw new Error("no answer in time");
  } catch (error) {
    log(`not recording what this job's tests ran: the build couldn't be fingerprinted (${String(error).slice(0, 300)})`);
    return null;
  }
  const projects = [];
  for (const collect of asked) {
    const blob = fingerprintRecording(fingerprint, collect.key);
    const receipt = await uploadFingerprint(input2.transport, { blob, projectId: collect.projectId, base, leg: input2.leg, keyVersion: collect.keyVersion, binding: toolchain(collect.codecVersion) }, log);
    if (receipt) projects.push({ projectId: collect.projectId, collect, receipt });
  }
  return projects.length > 0 ? { fingerprint, projects } : null;
}

// src/evidence/browser/conflict.ts
var import_promises5 = require("node:fs/promises");
var import_node_path8 = __toESM(require("node:path"));
var SOURCE = /\.(?:[cm]?[jt]sx?)$/;
var STARTS_COVERAGE = /\b(?:startJSCoverage|startCSSCoverage)\b|Profiler\.(?:start|take)PreciseCoverage/;
var COVERAGE_PACKAGE = /monocart|playwright[\w./@-]*coverage|coverage[\w./@-]*playwright/i;
var SKIP = /* @__PURE__ */ new Set(["node_modules", ".git", ".next", "dist", "build", "out", "coverage", "playwright-report", "test-results"]);
function coverageConflict(sources, packages) {
  for (const source of sources) if (STARTS_COVERAGE.test(source.text)) return `${source.path} runs precise coverage itself`;
  for (const pkg of packages) {
    let json;
    try {
      json = JSON.parse(pkg.text);
    } catch {
      continue;
    }
    const name = Object.keys({ ...json.dependencies, ...json.devDependencies }).find((dep) => COVERAGE_PACKAGE.test(dep));
    if (name) return `${pkg.path} depends on ${name}, which collects browser coverage`;
  }
  return null;
}
async function coverageConflictIn(dirs, budget = {}) {
  const maxFiles = budget.maxFiles ?? 5e3;
  let bytesLeft = budget.maxBytes ?? 64 * 1024 * 1024;
  const sources = [];
  const packages = [];
  const seen = /* @__PURE__ */ new Set();
  const walk3 = async (dir) => {
    let entries;
    try {
      entries = await (0, import_promises5.readdir)(dir, { withFileTypes: true });
    } catch {
      return null;
    }
    for (const entry of entries) {
      const full = import_node_path8.default.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (SKIP.has(entry.name)) continue;
        const refused = await walk3(full);
        if (refused) return refused;
      } else if (entry.isFile() && (SOURCE.test(entry.name) || entry.name === "package.json") && !seen.has(full)) {
        seen.add(full);
        if (seen.size > maxFiles) return `the suite has too many files to read (over ${maxFiles})`;
        const text2 = await (0, import_promises5.readFile)(full, "utf8").catch(() => "");
        bytesLeft -= text2.length;
        if (bytesLeft < 0) return "the suite is too large to read";
        (entry.name === "package.json" ? packages : sources).push({ path: full, text: text2 });
      }
    }
    return null;
  };
  for (const dir of dirs) {
    const refused = await walk3(dir);
    if (refused) return refused;
  }
  return coverageConflict(sources, packages);
}

// src/evidence/browser/rules.ts
var BUILT = "/_next/static/";
var PRECISE_COVERAGE = /* @__PURE__ */ new Set(["chromium"]);
function builtFileOf(url) {
  let pathname;
  try {
    pathname = decodeURIComponent(new URL(url).pathname);
  } catch {
    return null;
  }
  const at = pathname.indexOf(BUILT);
  return at < 0 ? null : `static/${pathname.slice(at + BUILT.length)}`;
}
var withoutFragment = (url) => url.split("#", 1)[0];
function partialReasons(coverage) {
  if (coverage.refused) return [`refused:${coverage.refused}`];
  const reasons = [];
  if (coverage.lost > 0) reasons.push("target_lost");
  if ((coverage.late ?? 0) > 0) reasons.push("started_late");
  if ((coverage.sharedIsolate ?? 0) > 0) reasons.push("shared_isolate");
  if (coverage.errors.length > 0) reasons.push("take_error");
  if (coverage.navigations > 0) reasons.push("navigation");
  const covered = new Set(coverage.covered.map(withoutFragment));
  if (coverage.assets.some((url) => !covered.has(withoutFragment(url)))) reasons.push("asset_missing");
  return reasons;
}
var SYNTHETIC = /^<(?:static_initializer|instance_members_initializer)>$/;
function spanAt(index, fn) {
  const exact = index.spans.find((span) => span.start === fn.start) ?? index.spans.find((span) => span.end === fn.end);
  if (exact || !SYNTHETIC.test(fn.name)) return exact;
  let inner;
  for (const span of index.spans) if (span.start <= fn.start && fn.end <= span.end && (!inner || span.end - span.start < inner.end - inner.start)) inner = span;
  return inner;
}
function browserFootprint(coverage, index) {
  if (!PRECISE_COVERAGE.has(coverage.browser)) {
    return { keys: [], partial: ["code", "css"], reasons: ["browser_unsupported"], mapped: 0, unmapped: 0 };
  }
  const keys = /* @__PURE__ */ new Set();
  let mapped = 0;
  let unmapped = 0;
  for (const script of coverage.scripts) {
    const file = builtFileOf(script.url);
    if (file === null) continue;
    const scriptIndex = index.scripts.get(file);
    for (const fn of script.functions) {
      if (fn.start === 0 && fn.name === "") continue;
      if (scriptIndex?.whole) {
        keys.add(scriptIndex.whole);
        mapped++;
        continue;
      }
      const span = scriptIndex && spanAt(scriptIndex, fn);
      if (!span) {
        unmapped++;
        continue;
      }
      if (span.key === null) continue;
      keys.add(span.key);
      if (span.source !== null) keys.add(`file:${span.source}`);
      mapped++;
    }
  }
  for (const sheet of coverage.sheets) {
    const file = builtFileOf(sheet.url);
    if (file === null) continue;
    const sheetIndex = index.sheets.get(file);
    for (const used of sheet.used) {
      if (sheetIndex?.whole) {
        keys.add(sheetIndex.whole);
        continue;
      }
      const span = sheetIndex?.spans.find((s2) => s2.start <= used.start && used.start < s2.end);
      if (span?.key) keys.add(span.key);
      else unmapped++;
    }
  }
  const reasons = partialReasons(coverage);
  if (unmapped > 0) reasons.push("unmapped");
  return { keys: [...keys].sort(), partial: reasons.length > 0 ? ["code", "css"] : [], reasons, mapped, unmapped };
}

// src/evidence/browser/collector.ts
function browserCollector(index) {
  return {
    collect(coverage) {
      const { keys, partial, reasons } = browserFootprint(coverage, index);
      return { keys, paths: [], partial, reasons };
    }
  };
}

// src/evidence/members.ts
function membersOf(records, coverage, fingerprint, collected, contexts, taints = [], serverEvidence) {
  const server = serverEvidence && (collected.coverage || !collected.har) ? serverEvidence : void 0;
  const taintedAttempts = new Set(taints.map((t) => `${t.testId}\0${t.retry}`));
  const collector = browserCollector(fingerprint);
  const covered = /* @__PURE__ */ new Map();
  for (const file of coverage) {
    const key = `${file.testId}\0${file.retry}`;
    covered.set(key, [...covered.get(key) ?? [], file]);
  }
  const owed = /* @__PURE__ */ new Map();
  for (const marker of contexts) {
    const key = `${marker.testId}\0${marker.retry}`;
    owed.set(key, /* @__PURE__ */ new Set([...owed.get(key) ?? [], marker.contextId]));
  }
  const byRun = /* @__PURE__ */ new Map();
  for (const record of records) {
    let member = byRun.get(record.runId);
    if (!member) byRun.set(record.runId, member = { run: record.runId, attempts: [], evidence: [] });
    member.attempts.push({ retry: record.retry, passed: record.passed });
    if (collected.har) {
      const missing = { keys: [], paths: [], partial: ["route"], layers: ["browser"], reasons: ["har_missing"] };
      member.evidence.push(record.har ? { keys: [], paths: record.har.paths, partial: record.har.complete ? [] : ["route"], layers: ["browser"], reasons: record.har.complete ? [] : ["har_incomplete"] } : missing);
    }
    if (collected.coverage) {
      const files = covered.get(`${record.testId}\0${record.retry}`) ?? [];
      const arrived = new Set(files.map((file) => file.contextId));
      if (taintedAttempts.has(`${record.testId}\0${record.retry}`)) member.evidence.push({ keys: [], paths: [], partial: ["code", "css"], layers: ["browser"], reasons: ["marker_failed"] });
      if (files.length === 0) member.evidence.push({ keys: [], paths: [], partial: ["code", "css"], layers: ["browser"], reasons: ["coverage_missing"] });
      else if ([...owed.get(`${record.testId}\0${record.retry}`) ?? []].some((id) => !arrived.has(id)))
        member.evidence.push({ keys: [], paths: [], partial: ["code", "css"], layers: ["browser"], reasons: ["context_unfinished"] });
      for (const file of files) member.evidence.push({ ...collector.collect(file.coverage), layers: ["browser"] });
    }
    if (server) {
      const own = server.byTest.get(record.testId);
      member.evidence.push(
        own ? { keys: own.keys, paths: [], partial: own.partial, layers: ["server"], reasons: own.reasons.map((r) => `server_${r}`) } : { keys: [], paths: [], partial: ["code"], layers: ["server"], reasons: ["server_missing"] }
      );
      if (server.ambient.partial.length > 0) member.evidence.push({ keys: [], paths: [], partial: ["code"], layers: ["server"], reasons: server.ambient.reasons.map((r) => `ambient_${r}`) });
    }
  }
  for (const member of byRun.values()) member.attempts.sort((a, b) => a.retry - b.retry);
  const loaded = /* @__PURE__ */ new Set();
  const browsers = /* @__PURE__ */ new Set();
  if (collected.coverage) {
    for (const file of coverage) {
      browsers.add(JSON.stringify([file.browser.name, file.browser.version]));
      for (const url of file.coverage.covered) {
        const built = builtFileOf(url);
        const index = built === null ? void 0 : fingerprint.scripts.get(built);
        for (const span of index?.spans ?? []) if (span.source !== null) loaded.add(`file:${span.source}`);
      }
    }
  }
  if (server) {
    for (const footprint of [server.ambient, ...server.byTest.values()]) for (const file of footprint.loaded) if (file.startsWith("file:")) loaded.add(file);
  }
  const [only] = browsers;
  const measured = [...collected.coverage || server ? ["code"] : [], ...collected.coverage ? ["css"] : [], ...collected.har ? ["route"] : []];
  const browserLayer = collected.coverage || collected.har;
  return {
    layers: [...browserLayer ? ["browser"] : [], ...server ? ["server"] : []],
    measured,
    loadedFiles: [...loaded].sort(),
    // Peeps takes only code ids here; a whole script's `out:` key stays in each member, whose invocation started the same app.
    ambient: server ? server.ambient.keys.filter((key) => key.startsWith("fn:") || key.startsWith("file:")) : [],
    members: [...byRun.values()],
    browser: browsers.size === 1 && only ? (([name, version]) => ({ name, version }))(JSON.parse(only)) : null
  };
}

// src/evidence/scratch.ts
var import_node_fs3 = require("node:fs");
var import_promises6 = require("node:fs/promises");
var import_node_path9 = __toESM(require("node:path"));
async function openScratch(parent) {
  const dir = await (0, import_promises6.mkdtemp)(import_node_path9.default.join(parent, "peeps-evidence-"));
  const signals = ["SIGTERM", "SIGINT"];
  const onSignal = (signal) => {
    (0, import_node_fs3.rmSync)(dir, { recursive: true, force: true });
    for (const s2 of signals) process.off(s2, onSignal);
    process.kill(process.pid, signal);
  };
  for (const s2 of signals) process.on(s2, onSignal);
  return {
    dir,
    write(name, value) {
      const file = import_node_path9.default.join(dir, import_node_path9.default.basename(name));
      (0, import_node_fs3.writeFileSync)(file, JSON.stringify(value), { mode: 384, flag: "wx" });
      return file;
    },
    read(prefix) {
      const out = [];
      for (const name of (0, import_node_fs3.readdirSync)(dir).filter((n) => n.startsWith(prefix)).sort()) {
        try {
          out.push(JSON.parse((0, import_node_fs3.readFileSync)(import_node_path9.default.join(dir, name), "utf8")));
        } catch {
        }
      }
      return out;
    },
    async dispose() {
      for (const s2 of signals) process.off(s2, onSignal);
      await (0, import_promises6.rm)(dir, { recursive: true, force: true });
    }
  };
}

// src/evidence/server/record.ts
var import_node_path13 = __toESM(require("node:path"));

// src/evidence/server/build-dir.ts
var import_node_fs4 = require("node:fs");
var import_node_path10 = __toESM(require("node:path"));
function walk(dir, rel, out) {
  let entries;
  try {
    entries = (0, import_node_fs4.readdirSync)(import_node_path10.default.join(dir, rel), { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const child = rel === "" ? entry.name : `${rel}/${entry.name}`;
    if (entry.isDirectory()) walk(dir, child, out);
    else {
      const stat6 = (0, import_node_fs4.lstatSync)(import_node_path10.default.join(dir, child));
      out.set(child, `${stat6.size}:${stat6.mtimeMs}`);
    }
  }
}
function snapshotBuildDir(dir) {
  const out = /* @__PURE__ */ new Map();
  walk(dir, "", out);
  return out;
}
function settleBuildDir(dir, snapshot) {
  const now = snapshotBuildDir(dir);
  const created = [];
  const changed = [];
  for (const [file, stamp] of now) {
    const before = snapshot.get(file);
    if (before === void 0) created.push(file);
    else if (before !== stamp) changed.push(file);
  }
  for (const file of created) (0, import_node_fs4.rmSync)(import_node_path10.default.join(dir, file), { force: true });
  return { created: created.sort(), changed: changed.sort() };
}

// src/evidence/server/lifecycle.ts
var import_node_child_process3 = require("node:child_process");
var import_node_fs5 = require("node:fs");
var import_node_path11 = __toESM(require("node:path"));
var READY_TIMEOUT_MS = 18e4;
var STOP_TIMEOUT_MS = 3e4;
var say3 = (line) => console.log(`[peeps] ${line}`);
function shell(command, cwd, env) {
  return new Promise((resolve) => {
    const child = (0, import_node_child_process3.spawn)("sh", ["-c", command], { cwd, env, stdio: ["ignore", "inherit", "inherit"] });
    child.on("error", () => resolve(1));
    child.on("close", (code) => resolve(code ?? 1));
  });
}
var groupAlive = (pid) => {
  try {
    process.kill(-pid, 0);
    return true;
  } catch {
    return false;
  }
};
var sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function waitUntil(done, timeoutMs, everyMs) {
  const deadline = Date.now() + timeoutMs;
  for (; ; ) {
    if (await done()) return true;
    if (Date.now() >= deadline) return false;
    await sleep(everyMs);
  }
}
function readInvocationCoverage(dir, problems) {
  const names = (() => {
    try {
      return (0, import_node_fs5.readdirSync)(dir);
    } catch {
      return [];
    }
  })();
  const pids = (prefix) => names.filter((n) => n.startsWith(prefix)).map((n) => Number(n.slice(prefix.length, -".json".length))).filter(Number.isInteger);
  const files = [];
  let unreadable = 0;
  for (const name of names.filter((n) => n.startsWith("coverage-"))) {
    try {
      const parsed = JSON.parse((0, import_node_fs5.readFileSync)(import_node_path11.default.join(dir, name), "utf8"));
      if (!Array.isArray(parsed.result)) throw new Error("no result");
      files.push({ result: parsed.result });
    } catch {
      unreadable++;
    }
  }
  (0, import_node_fs5.rmSync)(dir, { recursive: true, force: true });
  const covered = [...new Set(names.filter((n) => n.startsWith("coverage-")).map((n) => Number(n.split("-")[1])).filter(Number.isInteger))];
  return { started: pids("pid-"), taken: pids("taken-"), covered, files, unreadable, problems };
}
async function runInvocation(app, options, tests) {
  const problems = [];
  const at = [Date.now()];
  (0, import_node_fs5.rmSync)(options.dir, { recursive: true, force: true });
  (0, import_node_fs5.mkdirSync)(options.dir, { recursive: true, mode: 448 });
  const env = { ...app.env, PEEPS_INVOCATION: options.kind };
  if (app.reset !== null && await shell(app.reset, app.cwd, env) !== 0) {
    say3(`app-reset failed before this ${options.kind} invocation: its server evidence reads partial`);
    problems.push("reset_failed");
  }
  try {
    if ((await fetch(app.readyUrl, { signal: AbortSignal.timeout(2e3) })).ok) {
      say3(`something already answers ${app.readyUrl} before the app starts: this ${options.kind} invocation's server evidence reads partial`);
      problems.push("ready_before_start");
    }
  } catch {
  }
  at.push(Date.now());
  const child = (0, import_node_child_process3.spawn)("sh", ["-c", app.start], {
    cwd: app.cwd,
    detached: true,
    stdio: ["ignore", "inherit", "inherit"],
    env: {
      ...env,
      NODE_V8_COVERAGE: options.dir,
      PEEPS_SERVER_COVERAGE: options.dir,
      NODE_OPTIONS: `${app.env.NODE_OPTIONS ?? ""} --require ${JSON.stringify(options.preload)}`.trim()
    }
  });
  let exited = false;
  child.on("exit", () => exited = true);
  child.on("error", () => exited = true);
  const ready = await waitUntil(
    async () => {
      if (exited) return true;
      try {
        return (await fetch(app.readyUrl, { signal: AbortSignal.timeout(5e3) })).ok;
      } catch {
        return false;
      }
    },
    options.readyTimeoutMs ?? READY_TIMEOUT_MS,
    250
  );
  if (exited) problems.push("app_exited");
  else if (!ready) {
    say3(`the app didn't answer ${app.readyUrl} in time: this invocation's server evidence reads partial`);
    problems.push("not_ready");
  }
  at.push(Date.now());
  let exitCode;
  try {
    exitCode = await tests();
    at.push(Date.now());
  } finally {
    if (exited && !problems.includes("app_exited")) problems.push("app_exited");
    const pid = child.pid;
    if (pid !== void 0 && groupAlive(pid)) {
      process.kill(-pid, "SIGTERM");
      if (!await waitUntil(() => !groupAlive(pid), options.stopTimeoutMs ?? STOP_TIMEOUT_MS, 100)) {
        process.kill(-pid, "SIGKILL");
        problems.push("killed");
        await waitUntil(() => !groupAlive(pid), 5e3, 100);
      }
    }
  }
  const coverage = readInvocationCoverage(options.dir, problems);
  at.push(Date.now());
  const [t0, t1, t2, t3, t4] = at;
  return { exitCode, coverage, timings: { resetMs: t1 - t0, readyMs: t2 - t1, testsMs: t3 - t2, stopMs: t4 - t3 } };
}

// src/evidence/server/rules.ts
var import_node_path12 = __toESM(require("node:path"));
var import_node_url2 = require("node:url");
function builtFileOf2(url, nextDir) {
  if (!url.startsWith("file:")) return null;
  let file;
  try {
    file = (0, import_node_url2.fileURLToPath)(url);
  } catch {
    return null;
  }
  const rel = import_node_path12.default.relative(nextDir, file);
  if (rel === "" || rel.startsWith("..") || import_node_path12.default.isAbsolute(rel)) return null;
  return rel.split(import_node_path12.default.sep).join("/");
}
var RUNTIME = /\/(?:node_modules|corepack)\//;
var NEXT_CONFIG = /^next\.config(?:\.compiled)?\.(?:js|mjs|cjs|ts|mts)$/;
function sourceFileOf(url) {
  if (!url.startsWith("file:")) return null;
  let file;
  try {
    file = (0, import_node_url2.fileURLToPath)(url);
  } catch {
    return null;
  }
  const posix = file.split(import_node_path12.default.sep).join("/");
  return RUNTIME.test(posix) ? null : posix;
}
function sourcesOf(file, sources) {
  return [...sources].filter((source) => file === source || file.endsWith(`/${source}`));
}
function serverFootprint(coverage, scripts, nextDir, sources = /* @__PURE__ */ new Set(), own = () => false) {
  const keys = /* @__PURE__ */ new Set();
  const loaded = /* @__PURE__ */ new Set();
  let unmapped = 0;
  let outside = 0;
  let builtLoaded = false;
  for (const { result } of coverage.files) {
    for (const script of result) {
      const file = builtFileOf2(script.url, nextDir);
      if (file !== null) builtLoaded = true;
      if (file === null) {
        const rel = sourceFileOf(script.url);
        if (rel === null) continue;
        const ran = script.functions.some((fn) => (fn.ranges[0]?.count ?? 0) > 0);
        const named2 = sourcesOf(rel, sources);
        for (const source of named2) {
          loaded.add(`file:${source}`);
          if (ran) keys.add(`file:${source}`);
        }
        if (ran && named2.length === 0 && !own(rel) && !NEXT_CONFIG.test(import_node_path12.default.posix.basename(rel))) outside++;
        continue;
      }
      const index = scripts.get(file);
      if (index?.whole) loaded.add(index.whole);
      for (const span of index?.spans ?? []) if (span.source !== null) loaded.add(`file:${span.source}`);
      for (const fn of script.functions) {
        const range = fn.ranges[0];
        if (!range || range.count === 0) continue;
        if (index?.whole) {
          keys.add(index.whole);
          continue;
        }
        if (!index) {
          unmapped++;
          continue;
        }
        if (range.startOffset === 0 && fn.functionName === "") continue;
        const span = index && spanAt(index, { name: fn.functionName, start: range.startOffset, end: range.endOffset });
        if (!span) {
          unmapped++;
          continue;
        }
        if (span.key === null) continue;
        keys.add(span.key);
        if (span.source !== null) keys.add(`file:${span.source}`);
      }
    }
  }
  const reasons = [...coverage.problems];
  if (coverage.started.length === 0) reasons.push("no_process");
  const taken = new Set(coverage.taken);
  if (coverage.started.some((pid) => !taken.has(pid))) reasons.push("not_taken");
  const covered = new Set(coverage.covered);
  if (coverage.started.some((pid) => !covered.has(pid))) reasons.push("no_coverage");
  const registered = new Set(coverage.started);
  if (coverage.covered.some((pid) => !registered.has(pid))) reasons.push("unregistered");
  if (coverage.started.length > 0 && coverage.unreadable === 0 && !builtLoaded) reasons.push("no_build_ran");
  if (coverage.unreadable > 0) reasons.push("unreadable");
  if (unmapped > 0) reasons.push("unmapped");
  if (outside > 0) reasons.push("outside_build");
  return { keys: [...keys].sort(), loaded: [...loaded].sort(), partial: reasons.length > 0 ? ["code"] : [], reasons };
}

// src/evidence/server/record.ts
var say4 = (line) => console.log(`[peeps] ${line}`);
function specFilter(file) {
  return `^${file.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`;
}
var elsewhere = { keys: [], loaded: [], partial: ["code"], reasons: ["other_invocation"] };
async function recordServer(input2) {
  const invoke = input2.invoke ?? runInvocation;
  const preload = input2.preload.split(import_node_path13.default.sep).join("/");
  const ownCode = (file) => file === preload;
  const footprint = (coverage) => serverFootprint(coverage, input2.scripts, input2.nextDir, input2.sources, ownCode);
  const build = input2.buildDir ?? (() => {
    let snapshot = snapshotBuildDir(input2.nextDir);
    return { snapshot: () => snapshot = snapshotBuildDir(input2.nextDir), settle: () => settleBuildDir(input2.nextDir, snapshot) };
  })();
  build.snapshot();
  let tainted = false;
  const settle = () => {
    const { created, changed } = build.settle();
    if (created.length > 0) say4(`removed ${created.length} file(s) the app wrote into its build directory, before the next run`);
    if (changed.length > 0 && !tainted) {
      say4(`the app rewrote ${changed.length} built file(s) (${changed.slice(0, 3).join(", ")}): later runs' server evidence reads partial`);
      tainted = true;
    }
  };
  const taint = (fp) => tainted ? { ...fp, partial: ["code"], reasons: [...fp.reasons, "build_dir_changed"] } : fp;
  let exitCode = 0;
  const ambientRun = await invoke(input2.app, { dir: import_node_path13.default.join(input2.coverageDir, "ambient"), preload: input2.preload, kind: "ambient" }, () => input2.runTests(null, 0));
  if (ambientRun.exitCode !== 0) exitCode = ambientRun.exitCode;
  const ambient = footprint(ambientRun.coverage);
  const timing = (name, t) => t && say4(`${name}: reset ${(t.resetMs / 1e3).toFixed(1)} s, ready ${(t.readyMs / 1e3).toFixed(1)} s, tests ${(t.testsMs / 1e3).toFixed(1)} s, stop ${(t.stopMs / 1e3).toFixed(1)} s`);
  timing("ambient", ambientRun.timings);
  if (ambient.reasons.length > 0) say4(`the ambient run's server evidence is partial (${ambient.reasons.join(", ")}): every test's is`);
  settle();
  const byTest = /* @__PURE__ */ new Map();
  const counts = () => {
    const out = /* @__PURE__ */ new Map();
    for (const { testId, file } of input2.attempts()) out.set(testId, { count: (out.get(testId)?.count ?? 0) + 1, file });
    return out;
  };
  for (const [i, spec] of input2.specs.entries()) {
    const before = counts();
    const run = await invoke(input2.app, { dir: import_node_path13.default.join(input2.coverageDir, `spec-${i}`), preload: input2.preload, kind: "spec" }, () => input2.runTests(spec, i + 1));
    if (run.exitCode !== 0) exitCode = run.exitCode;
    timing(import_node_path13.default.basename(spec), run.timings);
    const own = taint(footprint(run.coverage));
    if (own.reasons.length > 0) say4(`${import_node_path13.default.basename(spec)}: server evidence partial (${own.reasons.join(", ")})`);
    settle();
    for (const [id, { count, file }] of counts()) {
      if (count === (before.get(id)?.count ?? 0)) continue;
      byTest.set(id, file === spec && !byTest.has(id) ? own : elsewhere);
    }
  }
  return { exitCode, server: { ambient, byTest } };
}

// src/reach/index.ts
var import_node_path14 = __toESM(require("node:path"));

// src/reach/checkout.ts
async function readCheckout(repository, sha) {
  const { git, workspace } = repository;
  let root;
  let base;
  try {
    root = (await git("rev-parse", "--show-toplevel")).trim();
    if (root !== workspace) return { ok: false, why: "not_merge" };
    if ((await git("rev-parse", "HEAD")).trim() !== sha) return { ok: false, why: "not_merge" };
    if ((await git("rev-parse", "--is-shallow-repository")).trim() === "true") {
      await git("fetch", "--quiet", "--no-tags", "--no-recurse-submodules", "--deepen=1", "origin", sha);
    }
    await git("rev-parse", "--verify", "--quiet", "HEAD^2");
    base = (await git("rev-parse", "--verify", "--quiet", "HEAD^1")).trim();
  } catch {
    return { ok: false, why: "not_merge" };
  }
  let changes;
  try {
    changes = parseDiff(
      await git(
        "-c",
        "core.quotePath=false",
        "diff",
        "--no-color",
        "--no-ext-diff",
        "-U0",
        "-M",
        "--src-prefix=a/",
        "--dst-prefix=b/",
        "HEAD^1",
        "HEAD"
      )
    );
    const present = changes.filter((c) => c.status !== "deleted").map((c) => c.path);
    if (present.length > 0 && present.length <= 300) {
      const dirty = await git("diff", "--name-only", "HEAD", "--", ...present);
      if (dirty.trim() !== "") return { ok: false, why: "dirty_checkout" };
    }
  } catch {
    return { ok: false, why: "unreadable_diff" };
  }
  return { ok: true, root, base, changes };
}
function headerPath(line) {
  const rest = line.slice("diff --git a/".length);
  const middle = (rest.length - " b/".length) / 2;
  if (rest.slice(middle, middle + 3) === " b/" && rest.slice(0, middle) === rest.slice(middle + 3)) return rest.slice(0, middle);
  const match = /^(.+) b\/(.+)$/.exec(rest);
  if (!match) throw new Error(`An unreadable diff header: ${line}`);
  return match[2];
}
function parseDiff(diff) {
  const lines = diff.split("\n");
  const out = [];
  let current = null;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.startsWith("diff --git ")) {
      current = { path: headerPath(line), status: "modified", binary: false, hunks: [] };
      out.push(current);
    } else if (!current) {
      if (line !== "") throw new Error(`Diff text outside a file: ${line}`);
    } else if (line.startsWith("rename from ")) {
      current.status = "renamed";
      current.oldPath = line.slice("rename from ".length);
    } else if (line.startsWith("rename to ")) {
      current.path = line.slice("rename to ".length);
    } else if (line.startsWith("deleted file mode ")) {
      current.status = "deleted";
    } else if (line.startsWith("new file mode ")) {
      current.status = "added";
    } else if (line.startsWith("Binary files ")) {
      current.binary = true;
    } else if (line.startsWith("@@ ")) {
      const header = /^@@ -\d+(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line);
      if (!header) throw new Error(`An unreadable hunk header: ${line}`);
      const hunk = { newStart: Number(header[2]), newCount: Number(header[3] ?? 1), removed: [], added: [] };
      const removed = Number(header[1] ?? 1);
      for (let n = 0; n < removed; n++) hunk.removed.push(lines[++i].slice(1));
      for (let n = 0; n < hunk.newCount; n++) hunk.added.push(lines[++i].slice(1));
      while (lines[i + 1]?.startsWith("\\")) i++;
      current.hunks.push(hunk);
    }
  }
  return out;
}

// src/reach/git.ts
var import_node_child_process4 = require("node:child_process");
var import_promises7 = require("node:fs/promises");
var import_node_util2 = require("node:util");
var execFileAsync2 = (0, import_node_util2.promisify)(import_node_child_process4.execFile);
var MAX_OUTPUT_BYTES = 256 * 1024 * 1024;
async function localRepository(workspace, deadline = Number.POSITIVE_INFINITY) {
  return {
    workspace: await (0, import_promises7.realpath)(workspace),
    async git(...args) {
      const left = deadline - Date.now();
      if (left <= 0) throw new Error("Out of time");
      const { stdout } = await execFileAsync2("git", args, {
        cwd: workspace,
        maxBuffer: MAX_OUTPUT_BYTES,
        timeout: Math.min(6e4, left),
        env: { ...process.env, GIT_TERMINAL_PROMPT: "0" }
      });
      return stdout;
    }
  };
}

// src/reach/limits.ts
var MAX_REACH_BYTES = 256 * 1024;
function capReach(reach) {
  if (Buffer.byteLength(JSON.stringify(reach)) <= MAX_REACH_BYTES) return reach;
  return { ...reach, global: true, why: reach.why ?? "too_many_surfaces", surfaces: [], reasons: reach.reasons.slice(0, 1), changedFiles: [], changedTestFiles: [] };
}

// src/reach/index.ts
var REACH_BUDGET_MS = 9e4;
var widened = (why, base = null, changedFiles = []) => capReach({ global: true, why, surfaces: [], reasons: [], changedFiles, changedTestFiles: [], base });
async function computeReach(env, input2, options = {}) {
  if (env.platform !== "github" || env.eventName !== "pull_request" || !env.sha) return void 0;
  const budgetMs = options.budgetMs ?? REACH_BUDGET_MS;
  const started = Date.now();
  try {
    const repository = await localRepository(env.workspace, started + budgetMs);
    const checkout = await readCheckout(repository, env.sha);
    if (!checkout.ok) return widened(checkout.why);
    const changedFiles = checkout.changes.map((change) => change.path);
    const files = (await repository.git("ls-files", "-z")).split("\0").filter(Boolean);
    const remaining = budgetMs - (Date.now() - started);
    if (remaining <= 0) return widened("timeout", checkout.base, changedFiles);
    const answer = await runBundled(
      options.scanner ?? import_node_path14.default.join(__dirname, "reach.js"),
      { root: checkout.root, files, changes: checkout.changes, specFiles: input2.specFiles, base: checkout.base, deadlineMs: remaining },
      remaining
    );
    if (answer === "timeout") return widened("timeout", checkout.base, changedFiles);
    if (answer === null) return widened("scan_failed", checkout.base, changedFiles);
    return capReach(answer);
  } catch (error) {
    console.log(`[peeps] could not read what this pull request reaches, so everything runs: ${String(error).slice(0, 300)}`);
    return widened("scan_failed");
  }
}

// src/reach/preflight.ts
var PREFLIGHT_PATH = "/api/v1/ci/targeted-runs";
var PREFLIGHT_TIMEOUT_MS = 3e3;
var TARGETED_RUNS_PROTOCOL = 2;
var NONE = { protocol: false, scan: false };
function readPreflight(answer) {
  if (typeof answer !== "object" || answer === null) return NONE;
  const { scan, protocolVersion } = answer;
  if (typeof protocolVersion !== "number" || !Number.isSafeInteger(protocolVersion) || protocolVersion < TARGETED_RUNS_PROTOCOL) return NONE;
  const { projects } = answer;
  const collect = (Array.isArray(projects) ? projects : []).map(readCollect).filter((c) => c !== null);
  return { protocol: true, scan: scan === true, ...collect.length > 0 ? { collect } : {} };
}
function readCollect(project) {
  if (typeof project !== "object" || project === null) return null;
  const { projectId, collect } = project;
  if (typeof projectId !== "string" || projectId === "" || typeof collect !== "object" || collect === null) return null;
  const { coverage, fingerprint, key, keyVersion, codecVersions } = collect;
  const parsed = typeof key === "string" && /^[0-9a-f]{64}$/.test(key) ? parseProjectKey(key) : null;
  if (!parsed || typeof keyVersion !== "string" || !/^V[1-9][0-9]*$/.test(keyVersion)) return null;
  if (coverage !== true && fingerprint !== true) return null;
  return { projectId, coverage: coverage === true, fingerprint: fingerprint === true, key: parsed, keyVersion, codecVersion: codecVersionOf(codecVersions) };
}
function codecVersionOf(offered) {
  const readable = Array.isArray(offered) ? offered.filter((v) => Number.isInteger(v) && v >= 1 && v <= RECORDING_CODEC_VERSION) : [];
  return readable.length > 0 ? Math.max(...readable) : 1;
}
var addMask = (line) => console.log(line);
function announceFieldsOf(negotiated) {
  return negotiated.protocol ? { canNarrow: true, protocolVersion: TARGETED_RUNS_PROTOCOL } : {};
}
async function negotiateTargetedRuns(env, peeps, log = addMask) {
  if (env.platform !== "github") return NONE;
  let timer;
  try {
    const answer = await Promise.race([
      peeps.get(PREFLIGHT_PATH, AbortSignal.timeout(PREFLIGHT_TIMEOUT_MS)),
      // The token comes first, and its retries aren't under that signal.
      new Promise((resolve) => {
        timer = setTimeout(() => resolve(null), PREFLIGHT_TIMEOUT_MS);
      })
    ]);
    const negotiated = readPreflight(answer);
    for (const { key } of negotiated.collect ?? []) for (const text2 of [key.toString("hex"), key.toString("base64url")]) log(`::add-mask::${text2}`);
    return { ...negotiated, scan: negotiated.scan && env.eventName === "pull_request" };
  } catch {
    return NONE;
  } finally {
    clearTimeout(timer);
  }
}

// src/report.ts
var MAX_UPLOAD_BYTES = 128 * 1024 * 1024;
var NARROWED_DEFAULT_RETRIES = 1;
function plannedTestsOf(list, rootDir) {
  return listedTestsOf(list, rootDir).map(({ path: path24, titlePath, pwProject }) => ({ path: path24, titlePath, pwProject }));
}
function listedTestsOf(list, rootDir) {
  const out = [];
  const trimmed = rootDir.trim();
  const root = trimmed === "" || trimmed === "." || trimmed === "./" ? "" : trimmed.replace(/^\.\//, "").replace(/\/+$/, "");
  const walk3 = (suite, titles, isFile) => {
    const next = isFile ? titles : [...titles, suite.title];
    for (const spec of suite.specs ?? []) {
      const file = spec.file.replace(/^\.\//, "");
      const specPath = root === "" ? file : `${root}/${file}`;
      const projects = (spec.tests ?? []).map(
        (t) => t.projectName ?? ""
      );
      for (const pwProject of projects.length ? [...new Set(projects)] : [""]) {
        const specTitles = [...next, spec.title];
        const tags = (spec.tags ?? []).map((tag) => `@${tag}`);
        out.push({ path: specPath, titlePath: specTitles.join(" \u203A "), pwProject, file, titles: specTitles, tags });
      }
    }
    for (const child of suite.suites ?? []) walk3(child, next, false);
  };
  for (const suite of list.suites) walk3(suite, [], true);
  return out;
}
async function runReport(env, peeps) {
  if (!env.sha) throw new Error("The commit sha is not set (GITHUB_SHA / CI_COMMIT_SHA)");
  const list = await listTests(env);
  const rootDirAbs = list.config.rootDir ?? env.workingDirectory;
  const rootDir = import_node_path15.default.relative(env.workspace, rootDirAbs).split(import_node_path15.default.sep).join("/") || ".";
  const tests = plannedTestsOf(list, rootDir);
  console.log(`[peeps] report: ${tests.length} tests at ${env.sha.slice(0, 7)} (${env.ref ?? "?"})`);
  const jobUrl = env.runUrl;
  const files = await specFilePayload(env, list);
  const specFiles = specFilesOf(list).map((file) => import_node_path15.default.relative(env.workspace, import_node_path15.default.join(rootDirAbs, file)).split(import_node_path15.default.sep).join("/"));
  const started = Date.now();
  const negotiated = await negotiateTargetedRuns(env, peeps);
  const computed = negotiated.scan ? await computeReach(env, { specFiles }) : void 0;
  if (computed) console.log(`[peeps] reach in ${Date.now() - started} ms: ${computed.global ? `everything (${computed.why})` : `${computed.surfaces.length} surface(s)`}`);
  const announce = {
    sha: env.sha,
    jobUrl,
    baseUrl: process.env.BASE_URL ?? null,
    tests,
    files,
    ...announceFieldsOf(negotiated)
  };
  let impact = negotiated.collect ? await prepareImpact({
    appDir: env.workingDirectory,
    sha: env.sha,
    eventName: env.eventName,
    leg: process.env.GITHUB_JOB ?? "",
    collect: negotiated.collect,
    repository: await localRepository(env.workspace),
    transport: peepsTransport(env.peepsUrl, () => peeps.token())
  }) : null;
  let reach = computed;
  let response;
  try {
    response = await peeps.post("/api/v1/ci/batches", { ...announce, ...reach ? { reach } : {}, ...impact ? { impact: { receipts: impact.projects.slice(0, MAX_RECEIPTS).map(({ receipt }) => receipt) } } : {} });
  } catch (error) {
    if (!reach && !impact || !(error instanceof PeepsHttpError) || error.status >= 500 || error.status === 401 || error.status === 403) throw error;
    console.log(`[peeps] Peeps refused what this ${reach ? "pull request reaches" : "job recorded"} (${error.status}), so everything runs and nothing is recorded`);
    reach = void 0;
    impact = null;
    response = await peeps.post("/api/v1/ci/batches", announce);
  }
  const recorded = impact?.projects.slice(0, MAX_RECEIPTS).map((project) => ({ project, batch: response.batches.find((b) => b.projectId === project.projectId) })).filter((p) => p.batch !== void 0).map(({ project, batch }) => ({ ...project, batchId: batch.batchId, runIds: batch.runs.map((run) => run.runId) }));
  const conflict = recorded?.some((p) => p.collect.coverage) ? await coverageConflictIn([rootDirAbs, env.workingDirectory]) : null;
  if (conflict) console.log(`[peeps] not recording browser coverage: ${conflict}`);
  const server = recorded && recorded.length > 0 ? serverPlanOf(env, recorded, rootDirAbs, testFilesOf(list), list.config.shard) : null;
  const recording = impact && recorded && recorded.length > 0 ? { impact: { fingerprint: impact.fingerprint, projects: recorded, coverage: conflict === null, ...server ? { server } : {} } } : {};
  const runs = response.batches.flatMap((b) => b.runs);
  const unmatched = response.batches.flatMap((b) => b.unmatched);
  console.log(
    `[peeps] planned ${runs.length} run(s) in ${response.batches.length} batch(es); ${unmatched.length} test(s) unknown to Peeps`
  );
  for (const u of unmatched.slice(0, 10)) console.log(`[peeps]   unknown: ${u.path} \u203A ${u.titlePath}`);
  const batches = response.batches.map((b) => ({ batchId: b.batchId, batchNumber: b.batchNumber }));
  let footprints;
  if (negotiated.protocol && response.batches.some((b) => b.collectFootprints === true)) {
    const globalSetups = [list.config.globalSetup ?? []].flat().map((file) => import_node_path15.default.relative(env.workspace, import_node_path15.default.resolve(rootDirAbs, file)).split(import_node_path15.default.sep).join("/"));
    const sources = await workspaceTestSources(env.workspace, specFiles, globalSetups);
    for (const { file, why } of sources.reasons.slice(0, 5)) console.log(`[peeps] not recording footprints: ${file}: ${why}`);
    if (sources.reasons.length > 0) console.log("[peeps] so every test here reads unknown, and always runs");
    footprints = { origins: response.batches.flatMap((b) => b.footprintOrigins ?? []), hiddenRequests: sources.hiddenRequests, record: sources.reasons.length === 0 };
  }
  if (!answeredNarrowed(response)) {
    await executeAndReport(env, peeps, { ...recording, rootDir, runs, batches, footprints, executed: reach && { mode: "full", tests: tests.length } });
    return;
  }
  const listed = listedTestsOf(list, rootDir);
  const reporterRuns = withReporterTitles(runs, listed);
  if (!isNarrowed(response)) {
    console.log("[peeps] not narrowing, running the full suite: Peeps did not narrow every project's batch");
    await executeAndReport(env, peeps, { ...recording, rootDir, runs: reporterRuns, batches, ranFullSuite: true, executed: reach && { mode: "full", tests: tests.length } });
    return;
  }
  const selected = [...runs, ...unmatched];
  if (selected.length === 0) {
    console.log("[peeps] narrowed to 0 test(s) for this pull request");
    await completeBatches(peeps, batches, reach && { mode: "targeted", tests: 0 });
    return;
  }
  const grep = await verifiedGrep(env, selected, listed, rootDir);
  if (grep === null) {
    await executeAndReport(env, peeps, { ...recording, rootDir, runs: reporterRuns, batches, ranFullSuite: true, executed: reach && { mode: "full", tests: tests.length } });
    return;
  }
  console.log(`[peeps] narrowed to ${selected.length} test(s) for this pull request`);
  await executeAndReport(env, peeps, { ...recording, rootDir, runs: reporterRuns, batches, selection: { files: [], grep }, narrowed: true, executed: reach && { mode: "targeted", tests: selected.length } });
}
var named = (tests) => tests.slice(0, 10).map((test) => `${test.path} \u203A ${test.titlePath}`).join("; ");
async function verifiedGrep(env, selected, listed, rootDir) {
  const fallBack = (why) => {
    console.log(`[peeps] not narrowing, running the full suite: ${why}`);
    return null;
  };
  const unlisted = selectionDifference(selected, listed).missing;
  if (unlisted.length > 0) {
    return fallBack(`${unlisted.length} selected test(s) not in Playwright's list: ${named(unlisted)}`);
  }
  const grep = exactGrepFor(selected, listed);
  const bytes = Buffer.byteLength(grep);
  if (bytes > MAX_GREP_BYTES) return fallBack(`its grep is ${bytes} bytes, over the limit of ${MAX_GREP_BYTES}`);
  let found;
  try {
    found = listedTestsOf(await listTests(env, ["--grep", grep, "--no-deps"]), rootDir);
  } catch (error) {
    const why = error.stderr || String(error);
    return fallBack(`Playwright could not list the grep's tests: ${why.slice(0, 500)}`);
  }
  const { missing, extra } = selectionDifference(selected, found);
  if (missing.length > 0) return fallBack(`${missing.length} test(s) not selected by its grep: ${named(missing)}`);
  if (extra.length > 0) return fallBack(`${extra.length} other test(s) also selected by its grep: ${named(extra)}`);
  return grep;
}
async function completeBatches(peeps, batches, executed) {
  for (const b of batches) {
    try {
      await peeps.post(`/api/v1/ci/batches/${b.batchId}/complete`, { reportUploaded: false, ...executed ? { executed } : {} });
    } catch (error) {
      console.log(`[peeps] could not complete batch ${b.batchId}: ${String(error)}`);
    }
  }
}
async function executeAndReport(env, peeps, input2) {
  const scratch = await (0, import_promises8.mkdtemp)(import_node_path15.default.join(process.env.RUNNER_TEMP ?? (0, import_node_os3.tmpdir)(), "peeps-"));
  const planFile = import_node_path15.default.join(scratch, "plan.json");
  const reportDir = import_node_path15.default.join(scratch, "report");
  const plan = { peepsUrl: env.peepsUrl, rootDir: input2.rootDir, runs: input2.runs };
  if (input2.narrowed) plan.narrowed = true;
  if (input2.footprints) plan.footprints = { origins: input2.footprints.origins, hiddenRequests: input2.footprints.hiddenRequests };
  const evidence = input2.impact ? await openScratch(process.env.RUNNER_TEMP ?? (0, import_node_os3.tmpdir)()).catch(() => null) : null;
  if (evidence) plan.evidence = { dir: evidence.dir };
  await (0, import_promises8.writeFile)(planFile, JSON.stringify(plan), { mode: 384 });
  let exitCode;
  try {
    const coverage = evidence && input2.impact?.coverage && input2.impact.projects.some((p) => p.collect.coverage) ? { worker: import_node_path15.default.join(__dirname, "evidence-worker.js"), dir: evidence.dir } : void 0;
    const plan2 = input2.impact?.server;
    let server;
    if (evidence && plan2 && !input2.selection && coverage !== void 0) {
      const blobDir = import_node_path15.default.join(scratch, "blobs");
      const recorded = await recordServer({
        app: { ...plan2.app, cwd: env.workingDirectory, env: { ...process.env, ...input2.extraEnv, CI: "1" } },
        specs: plan2.specs,
        preload: realOr(import_node_path15.default.join(__dirname, "evidence-preload.js")),
        coverageDir: import_node_path15.default.join(scratch, "server-coverage"),
        scripts: input2.impact.fingerprint.scripts,
        sources: new Set(input2.impact.fingerprint.files.values()),
        nextDir: plan2.nextDir,
        runTests: (spec, index) => runPlaywright(env, planFile, reportDir, void 0, { ...input2.extraEnv, PEEPS_INVOCATION: spec === null ? "ambient" : "spec" }, input2.narrowed, input2.footprints?.record === true, coverage, { spec, blobFile: spec === null ? null : import_node_path15.default.join(blobDir, `report-${index}.zip`) }),
        attempts: () => evidence.read("att-").map((record) => ({ testId: record.testId, file: typeof record.file === "string" ? realOr(record.file) : null }))
      });
      exitCode = recorded.exitCode;
      server = recorded.server;
      await mergeReports(env, blobDir, reportDir);
    } else {
      exitCode = await runPlaywright(env, planFile, reportDir, input2.selection, input2.extraEnv, input2.narrowed, input2.footprints?.record === true, coverage);
    }
    if (evidence && input2.impact) {
      await recordEvidence(env, peeps, input2.impact, evidence, { coverage: coverage !== void 0, har: input2.footprints?.record === true }, server).catch((error) => {
        console.log(`[peeps] not recording what this job's tests ran: ${String(error).slice(0, 300)}`);
      });
    }
  } finally {
    await evidence?.dispose().catch((error) => console.log(`[peeps] could not remove the evidence scratch directory: ${String(error).slice(0, 300)}`));
  }
  let reportUploaded = false;
  for (const b of input2.batches) {
    try {
      const uploaded = await uploadReport(peeps, b.batchId, reportDir);
      reportUploaded = uploaded > 0;
      console.log(`[peeps] uploaded ${uploaded} report file(s) for batch ${b.batchNumber}`);
    } catch (error) {
      console.log(`[peeps] report upload failed for batch ${b.batchId}: ${String(error)}`);
    }
    try {
      await peeps.post(`/api/v1/ci/batches/${b.batchId}/complete`, {
        reportUploaded,
        ...input2.ranFullSuite ? { ranFullSuite: true } : {},
        ...input2.executed ? { executed: input2.executed } : {}
      });
    } catch (error) {
      console.log(`[peeps] could not complete batch ${b.batchId}: ${String(error)}`);
    }
  }
  console.log(`[peeps] playwright exited with ${exitCode}`);
  if (exitCode !== 0) process.exitCode = exitCode;
}
var MAX_RECEIPTS = 16;
async function recordEvidence(env, peeps, impact, scratch, collected, server) {
  const records = scratch.read("att-");
  const coverage = scratch.read("cov-");
  const contexts = scratch.read("ctx-");
  const taints = scratch.read("taint-");
  const transport = peepsTransport(env.peepsUrl, () => peeps.token());
  for (const project of impact.projects) {
    const runs = new Set(project.runIds);
    const own = records.filter((record) => runs.has(record.runId));
    const tests = new Set(own.map((record) => record.testId));
    let job;
    try {
      job = membersOf(
        own,
        coverage.filter((file) => tests.has(file.testId)),
        impact.fingerprint,
        { coverage: collected.coverage && project.collect.coverage, har: collected.har },
        contexts,
        taints,
        project.collect.coverage ? server : void 0
      );
    } catch (error) {
      console.log(`[peeps] not recording what this job's tests ran: its evidence couldn't be read (${String(error).slice(0, 300)})`);
      continue;
    }
    if (job.measured.length === 0) continue;
    const ok = await uploadEvidence(transport, {
      batchId: project.batchId,
      key: project.collect.key,
      layers: job.layers,
      measured: job.measured,
      loadedFiles: job.loadedFiles,
      ambient: job.ambient,
      browser: job.browser,
      codecVersion: project.collect.codecVersion,
      members: job.members
    });
    if (ok) console.log(`[peeps] recorded what ${job.members.length} test(s) ran`);
  }
}
async function runPlaywright(env, planFile, reportDir, selection, extraEnv = {}, narrowed = false, collectFootprints = false, coverage, invocation) {
  const reporterPath = import_node_path15.default.join(__dirname, "reporter.js");
  const reporters = invocation ? `${reporterPath},list${invocation.blobFile ? ",blob" : ""}` : `${reporterPath},list,html`;
  const args = ["playwright", "test", `--reporter=${reporters}`];
  let capture;
  try {
    capture = await prepareCaptureConfig(env, {
      ...narrowed ? { defaultRetries: NARROWED_DEFAULT_RETRIES } : {},
      ...collectFootprints ? { collectFootprints } : {},
      ...coverage ? { coverage } : {},
      ...invocation ? { ownsApp: true } : {}
    });
  } catch (error) {
    console.warn(`[peeps] screenshot/video defaults could not be applied; using the original config: ${String(error)}`);
  }
  const configPath = capture?.configPath ?? env.configPath;
  if (configPath) args.push("--config", configPath);
  if (selection) {
    args.push("--grep", selection.grep, "--", ...selection.files);
  }
  if (invocation) args.push(...invocation.spec === null ? ["--grep", "(?!)", "--pass-with-no-tests"] : [specFilter(invocation.spec)]);
  try {
    return await new Promise((resolve) => {
      const couldNotStart = (error) => {
        console.error(`[peeps] could not start Playwright: ${String(error)}`);
        resolve(1);
      };
      try {
        const child = (0, import_node_child_process5.spawn)("npx", args, {
          cwd: env.workingDirectory,
          stdio: "inherit",
          env: {
            ...process.env,
            ...extraEnv,
            CI: "1",
            PEEPS_PLAN_FILE: planFile,
            PLAYWRIGHT_HTML_OUTPUT_DIR: reportDir,
            PLAYWRIGHT_HTML_OPEN: "never",
            ...invocation?.blobFile ? { PLAYWRIGHT_BLOB_OUTPUT_FILE: invocation.blobFile } : {}
          }
        });
        child.on("error", couldNotStart);
        child.on("close", (code) => resolve(code ?? 1));
      } catch (error) {
        couldNotStart(error);
      }
    });
  } finally {
    await capture?.cleanup().catch((error) => {
      console.warn(`[peeps] could not remove temporary capture config: ${String(error)}`);
    });
  }
}
function realOr(file) {
  try {
    return (0, import_node_fs6.realpathSync)(file);
  } catch {
    return file;
  }
}
function serverPlanOf(env, recorded, rootDirAbs, specFiles, shard) {
  if (!env.app || !recorded.some((project) => project.collect.coverage)) return null;
  if (shard) {
    console.log("[peeps] not recording server evidence: the config shards its suite");
    return null;
  }
  if (process.env.NODE_V8_COVERAGE) {
    console.log("[peeps] not recording server evidence: NODE_V8_COVERAGE is already set in this job");
    return null;
  }
  let nextDir;
  try {
    nextDir = (0, import_node_fs6.realpathSync)(import_node_path15.default.join(env.workingDirectory, ".next"));
  } catch {
    console.log("[peeps] not recording server evidence: no Next build in the working directory");
    return null;
  }
  const specs = [...new Set(specFiles.map((file) => realOr(import_node_path15.default.resolve(rootDirAbs, file))))].sort();
  console.log(`[peeps] recording server evidence: ${specs.length} spec file(s), each with the app to itself, after one ambient run`);
  return { app: env.app, specs, nextDir };
}
async function mergeReports(env, blobDir, reportDir) {
  if (!(0, import_node_fs6.existsSync)(blobDir)) return;
  const code = await new Promise((resolve) => {
    const child = (0, import_node_child_process5.spawn)("npx", ["playwright", "merge-reports", "--reporter=html", blobDir], {
      cwd: env.workingDirectory,
      stdio: "inherit",
      env: { ...process.env, PLAYWRIGHT_HTML_OUTPUT_DIR: reportDir, PLAYWRIGHT_HTML_OPEN: "never" }
    });
    child.on("error", () => resolve(1));
    child.on("close", (c) => resolve(c ?? 1));
  });
  if (code !== 0) console.log(`[peeps] could not merge the invocations' reports (${code}): the HTML report may be missing`);
}
async function* walk2(dir, rel = "") {
  let entries;
  try {
    entries = await (0, import_promises8.readdir)(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const abs = import_node_path15.default.join(dir, entry.name);
    const relPath = rel ? `${rel}/${entry.name}` : entry.name;
    if (entry.isDirectory()) yield* walk2(abs, relPath);
    else if (entry.isFile()) yield { abs, rel: relPath };
  }
}
async function uploadReport(peeps, batchId, reportDir) {
  let uploaded = 0;
  for await (const file of walk2(reportDir)) {
    const info = await (0, import_promises8.stat)(file.abs);
    if (info.size > MAX_UPLOAD_BYTES) {
      console.log(`[peeps] skipping ${file.rel}: ${info.size} bytes exceeds the upload limit`);
      continue;
    }
    const bytes = await (0, import_promises8.readFile)(file.abs);
    try {
      await peeps.postBytes(
        `/api/v1/ci/batches/${batchId}/artifacts?path=${encodeURIComponent(file.rel)}`,
        bytes
      );
      uploaded += 1;
    } catch (error) {
      console.log(`[peeps] skipped ${file.rel}: ${String(error).slice(0, 200)}`);
    }
  }
  return uploaded;
}

// src/run.ts
var import_node_path16 = __toESM(require("node:path"));

// src/plan.ts
async function requestPlan(peeps, sessionId, body) {
  try {
    return await peeps.post(`/api/v1/ci/batches/${sessionId}/plan`, body);
  } catch (error) {
    if (error instanceof PeepsHttpError && error.status === 409 && error.code === "batch_closed") {
      console.log(
        "[peeps] Peeps closed this batch before the job started (it was cancelled, or Peeps stopped waiting for the job); nothing to run."
      );
      return null;
    }
    throw error;
  }
}

// src/environment.ts
function nameForLog(name) {
  return name.replace(/[\p{Cc}\p{Zl}\p{Zp}]+/gu, " ").replace(/##\[/g, "## [");
}
function urlForLog(baseUrl) {
  if (baseUrl.includes("@")) return "<unreadable URL>";
  try {
    const url = new URL(baseUrl);
    if (url.protocol !== "http:" && url.protocol !== "https:") return "<unreadable URL>";
    return url.pathname === "/" ? url.origin : `${url.origin}${url.pathname}`;
  } catch {
    return "<unreadable URL>";
  }
}
function hideEnvironmentUrls(vars) {
  const hidden = [...new Set(Object.values(vars).filter((v) => v.includes("@")))].sort((a, b) => b.length - a.length);
  return (text2) => hidden.reduce((out, value) => out.split(value).join("<unreadable URL>"), text2);
}
function planEnvironmentVariables(planEnv, current) {
  const preview = current.PEEPS_PREVIEW_URL;
  const previewFallback = (prefix) => preview && !current.BASE_URL ? { BASE_URL: preview, log: `${prefix}BASE_URL ${urlForLog(preview)} (the Vercel preview of the checked-out commit)` } : null;
  if (!planEnv) {
    const fallback = previewFallback("[peeps] no Peeps environment; ");
    return fallback ? { vars: { BASE_URL: fallback.BASE_URL }, log: fallback.log } : { vars: {}, log: "" };
  }
  const vars = { PEEPS_ENVIRONMENT: planEnv.name };
  const name = nameForLog(planEnv.name);
  if (!planEnv.baseUrl) {
    const fallback = previewFallback(`[peeps] environment ${name} (no BASE_URL in Peeps); `);
    if (fallback) return { vars: { ...vars, BASE_URL: fallback.BASE_URL }, log: fallback.log };
    return { vars, log: `[peeps] environment ${name} (no BASE_URL in Peeps)` };
  }
  vars.PEEPS_BASE_URL = planEnv.baseUrl;
  const url = urlForLog(planEnv.baseUrl);
  if (current.BASE_URL) {
    return {
      vars,
      log: `[peeps] environment ${name}; the workflow's BASE_URL runs, not ${url} (also in PEEPS_BASE_URL)`
    };
  }
  vars.BASE_URL = planEnv.baseUrl;
  return { vars, log: `[peeps] environment ${name}, BASE_URL ${url}` };
}

// src/run.ts
function escapeRegex2(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
function grepFor(titlePaths) {
  const alternatives = [...new Set(titlePaths)].map(
    (t) => escapeRegex2(t.split(" \u203A ").join(" ")) + "(?: @[^ ]+)*$"
  );
  return `(?:^| )(?:${alternatives.join("|")})`;
}
async function runDispatched(env, peeps) {
  if (!env.sessionId) throw new Error("`session-id` is required in run mode (Peeps passes it)");
  const list = await listTests(env);
  const rootDirAbs = list.config.rootDir ?? env.workingDirectory;
  const rootDir = import_node_path16.default.relative(env.workspace, rootDirAbs).split(import_node_path16.default.sep).join("/") || ".";
  const plan = await requestPlan(peeps, env.sessionId, {
    tests: plannedTestsOf(list, rootDir).slice(0, 2e3)
  });
  if (!plan) return;
  console.log(`[peeps] run: batch ${plan.batchNumber} holds ${plan.runs.length} run(s)`);
  if (plan.runs.length === 0) {
    await peeps.post(`/api/v1/ci/batches/${plan.batchId}/complete`, { reportUploaded: false });
    return;
  }
  const files = [...new Set(plan.runs.map((r) => r.path))].map(
    (p) => import_node_path16.default.relative(env.workingDirectory, import_node_path16.default.join(env.workspace, p)).split(import_node_path16.default.sep).join("/")
  );
  const environment = planEnvironmentVariables(plan.environment, process.env);
  if (environment.log) console.log(environment.log);
  await executeAndReport(env, peeps, {
    rootDir,
    runs: plan.runs,
    batches: [{ batchId: plan.batchId, batchNumber: plan.batchNumber }],
    selection: { files, grep: grepFor(plan.runs.map((r) => r.titlePath)) },
    extraEnv: environment.vars
  });
}

// src/agent.ts
var import_node_child_process10 = require("node:child_process");
var import_promises14 = require("node:fs/promises");
var import_node_util4 = require("node:util");

// src/appium.ts
var import_node_child_process7 = require("node:child_process");
var import_node_crypto6 = require("node:crypto");
var import_node_fs9 = require("node:fs");
var import_promises10 = require("node:fs/promises");
var import_node_os5 = require("node:os");
var import_node_path19 = __toESM(require("node:path"));
var import_node_url3 = require("node:url");

// src/appium-reporter.ts
var import_node_fs7 = require("node:fs");
var import_node_path17 = __toESM(require("node:path"));
var TITLE_PATH_SEPARATOR = " \u203A ";
function repoRelative(workspace, abs) {
  const attempt = (root, file) => {
    const rel = import_node_path17.default.relative(root, file).split(import_node_path17.default.sep).join("/");
    return rel === "" || rel === ".." || rel.startsWith("../") || import_node_path17.default.isAbsolute(rel) ? null : rel;
  };
  const direct = attempt(workspace, abs);
  if (direct !== null) return direct;
  try {
    return attempt((0, import_node_fs7.realpathSync)(workspace), (0, import_node_fs7.realpathSync)(abs));
  } catch {
    return null;
  }
}
function identityKey(test) {
  return `${test.path}
${test.titlePath}`;
}
var MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024;
function pageSourceExtension(source, context) {
  if (context && /^(WEBVIEW|CHROMIUM)/i.test(context)) return "html";
  const head = source.trimStart().slice(0, 512);
  if (/^<\?xml|^<hierarchy[\s>]|^<AppiumAUT[\s>]/i.test(head)) return "xml";
  if (/^<!doctype html|<html[\s>]/i.test(head)) return "html";
  return context && /^NATIVE/i.test(context) ? "xml" : "html";
}
var MAX_VIDEO_BYTES = 100 * 1024 * 1024;
var STOP_TIMEOUT_MS2 = 12e4;
var FRAME_TIMEOUT_MS = 1e4;
var VIDEO_HOOK_BUDGET_MS = STOP_TIMEOUT_MS2 + 8 * FRAME_TIMEOUT_MS + 3e4;

// src/pytest.ts
var import_node_child_process6 = require("node:child_process");
var import_node_crypto5 = require("node:crypto");
var import_node_fs8 = require("node:fs");
var import_promises9 = require("node:fs/promises");
var import_node_os4 = require("node:os");
var import_node_path18 = __toESM(require("node:path"));
var WDIO_CONFIG = /^wdio(\..+)?\.conf\.[cm]?[jt]s$/;
var PLUGIN_DIR = import_node_path18.default.join(__dirname, "..", "python");
var PLUGIN = "peeps_pytest_plugin";
var PLAYWRIGHT_CONFIG = /^playwright(\..+)?\.config\.[cm]?[jt]s$/;
function resolveFramework(env) {
  const declared = env.framework;
  if (declared === "playwright" || declared === "pytest" || declared === "appium") return declared;
  if (declared != null && declared !== "auto") {
    throw new Error(`unknown framework "${declared}": use playwright, pytest, appium or auto`);
  }
  if (env.configPath) return WDIO_CONFIG.test(import_node_path18.default.basename(env.configPath)) ? "appium" : "playwright";
  let names;
  try {
    names = (0, import_node_fs8.readdirSync)(env.workingDirectory);
  } catch {
    return "playwright";
  }
  if (names.some((name) => PLAYWRIGHT_CONFIG.test(name))) return "playwright";
  if (names.some((name) => WDIO_CONFIG.test(name))) return "appium";
  if (names.includes("pytest.ini") || names.includes("conftest.py")) return "pytest";
  const pyproject = import_node_path18.default.join(env.workingDirectory, "pyproject.toml");
  if ((0, import_node_fs8.existsSync)(pyproject) && /^\s*\[tool\.pytest(\.ini_options)?\]/m.test((0, import_node_fs8.readFileSync)(pyproject, "utf8"))) {
    return "pytest";
  }
  return "playwright";
}
var TITLE_PATH_SEPARATOR2 = " \u203A ";
function splitParameter(nodeId) {
  const open2 = nodeId.indexOf("[", Math.max(0, nodeId.indexOf("::")));
  if (open2 === -1 || !nodeId.endsWith("]")) return { head: nodeId, parameter: null };
  return { head: nodeId.slice(0, open2), parameter: nodeId.slice(open2 + 1, -1) };
}
function withoutBrowser(parameter, browser) {
  if (parameter === browser) return null;
  if (parameter.startsWith(`${browser}-`)) return parameter.slice(browser.length + 1);
  if (parameter.endsWith(`-${browser}`)) return parameter.slice(0, -browser.length - 1);
  return parameter;
}
function normalizeRoot(rootDir) {
  const trimmed = rootDir.trim();
  if (trimmed === "" || trimmed === "." || trimmed === "./") return "";
  return trimmed.replace(/^\.\//, "").replace(/\/+$/, "");
}
function pytestNodeIdToTest(nodeId, options = {}) {
  const { head, parameter } = splitParameter(nodeId);
  const [file, ...scopes] = head.split("::");
  if (!file || scopes.length === 0 || scopes.some((scope) => scope === "")) {
    throw new Error(`not a pytest test node id: ${nodeId}`);
  }
  const kept = parameter !== null && options.browser ? withoutBrowser(parameter, options.browser) : parameter;
  const root = normalizeRoot(options.rootDir ?? ".");
  return {
    path: root === "" ? file : `${root}/${file}`,
    titlePath: scopes.join(TITLE_PATH_SEPARATOR2) + (kept === null ? "" : `[${kept}]`)
  };
}
function planKey(test) {
  return `${test.pwProject} ${test.path} ${test.titlePath}`;
}
function plannedPytestTests(collection, rootDir) {
  return collection.items.flatMap((item) => {
    try {
      return [
        {
          ...pytestNodeIdToTest(item.nodeId, { rootDir, browser: item.browser }),
          pwProject: item.browser ?? "",
          nodeId: item.nodeId
        }
      ];
    } catch {
      console.log(`[peeps] not a test node id, not reported: ${item.nodeId}`);
      return [];
    }
  });
}
function nodeIdsForRuns(planned, runs) {
  const nodeIdOf = new Map(planned.map((t) => [planKey(t), t.nodeId]));
  const byNodeId = {};
  const unmatched = [];
  for (const run of runs) {
    const nodeId = nodeIdOf.get(planKey(run));
    if (nodeId === void 0) unmatched.push(run);
    else byNodeId[nodeId] = run;
  }
  return { byNodeId, unmatched };
}
function pytestEnv(extra) {
  const env = { ...process.env, CI: "1", ...extra };
  env.PYTHONPATH = process.env.PYTHONPATH ? `${PLUGIN_DIR}${import_node_path18.default.delimiter}${process.env.PYTHONPATH}` : PLUGIN_DIR;
  if (!("PEEPS_PLAN_FILE" in extra)) delete env.PEEPS_PLAN_FILE;
  if (!("PEEPS_COLLECT_OUT" in extra)) delete env.PEEPS_COLLECT_OUT;
  if (!("PEEPS_SELECT_ONLY" in extra)) delete env.PEEPS_SELECT_ONLY;
  if (!("PEEPS_ARTIFACTS_DIR" in extra)) delete env.PEEPS_ARTIFACTS_DIR;
  if (!("PEEPS_WORKSPACE" in extra)) delete env.PEEPS_WORKSPACE;
  return env;
}
function spawnPytest(args, options) {
  const candidates = process.env.PEEPS_PYTHON ? [process.env.PEEPS_PYTHON] : ["python", "python3"];
  const attempt = (index) => new Promise((resolve, reject) => {
    const child = (0, import_node_child_process6.spawn)(candidates[index], ["-m", "pytest", ...args], {
      cwd: options.cwd,
      env: options.env,
      stdio: options.capture ? ["ignore", "pipe", "pipe"] : "inherit"
    });
    let output = "";
    const keep = (chunk) => {
      output = (output + chunk.toString("utf8")).slice(-2e4);
    };
    child.stdout?.on("data", keep);
    child.stderr?.on("data", keep);
    child.on("error", (error) => {
      if (error.code === "ENOENT" && index + 1 < candidates.length) {
        resolve(attempt(index + 1));
      } else {
        reject(new Error(`could not start ${candidates[index]}: ${error.message}`));
      }
    });
    child.on("close", (code) => resolve({ code: code ?? 1, output }));
  });
  return attempt(0);
}
function configArgs(env) {
  return env.configPath ? ["-c", env.configPath] : [];
}
async function collectPytest(env) {
  const scratch = await (0, import_promises9.mkdtemp)(import_node_path18.default.join(process.env.RUNNER_TEMP ?? (0, import_node_os4.tmpdir)(), "peeps-collect-"));
  const out = import_node_path18.default.join(scratch, "collection.json");
  const { code, output } = await spawnPytest(
    ["--collect-only", "-q", "-p", PLUGIN, ...configArgs(env)],
    { cwd: env.workingDirectory, env: pytestEnv({ PEEPS_COLLECT_OUT: out }), capture: true }
  );
  if (![0, 2, 5].includes(code) || !(0, import_node_fs8.existsSync)(out)) {
    throw new Error(`pytest --collect-only exited with ${code}:
${output.slice(-4e3)}`);
  }
  const collection = JSON.parse(await (0, import_promises9.readFile)(out, "utf8"));
  for (const error of collection.errors) {
    console.log(`[peeps] collection error in ${error.nodeId}:
${error.message}`);
  }
  return collection;
}
function repoRelative2(env, abs) {
  let workspace = env.workspace;
  try {
    workspace = (0, import_node_fs8.realpathSync)(workspace);
  } catch {
  }
  const rel = import_node_path18.default.relative(workspace, abs).split(import_node_path18.default.sep).join("/");
  if (rel === ".." || rel.startsWith("../") || import_node_path18.default.isAbsolute(rel)) {
    throw new Error(`${abs} is outside the repository (${env.workspace})`);
  }
  return rel;
}
function repoRootDir(env, collection) {
  return repoRelative2(env, collection.rootDir) || ".";
}
async function moduleFilePayload(env, collection) {
  const modules = new Set(
    [...collection.items, ...collection.deselected ?? []].map((item) => item.nodeId.split("::")[0])
  );
  const files = [];
  for (const file of [...modules].sort()) {
    const abs = import_node_path18.default.join(collection.rootDir, file);
    const bytes = await (0, import_promises9.readFile)(abs);
    files.push({
      path: repoRelative2(env, abs),
      blobSha: gitBlobSha(bytes),
      content: bytes.toString("utf8")
    });
  }
  return files;
}
async function buildPytestInventoryRequest(env, collection) {
  if (!env.sha) throw new Error("The commit sha is not set (GITHUB_SHA / CI_COMMIT_SHA)");
  return {
    sha: env.sha,
    framework: "pytest",
    // Node ids are relative to pytest's rootdir; Peeps joins them onto this.
    rootDir: repoRootDir(env, collection),
    // Deselected tests too: they exist, and Peeps must not read their absence
    // from a module it received in full as their removal.
    items: [...collection.items, ...collection.deselected ?? []],
    // A module that failed to collect is present but unread: Peeps must not
    // take its tests' absence from `items` as their deletion.
    collectionErrors: collection.errors.map((error) => error.nodeId),
    files: await moduleFilePayload(env, collection)
  };
}
async function runPytestInventory(env, peeps) {
  const collection = await collectPytest(env);
  const request = await buildPytestInventoryRequest(env, collection);
  console.log(
    `[peeps] inventory: ${collection.items.length} pytest items in ${request.files.length} modules at ${request.sha.slice(0, 7)}`
  );
  const result = await peeps.post("/api/v1/ci/inventory", request);
  console.log(`[peeps] inventory accepted: ${JSON.stringify(result.results)}`);
}
async function runPytestReport(env, peeps) {
  if (!env.sha) throw new Error("The commit sha is not set (GITHUB_SHA / CI_COMMIT_SHA)");
  const collection = await collectPytest(env);
  const rootDir = repoRootDir(env, collection);
  const planned = plannedPytestTests(collection, rootDir);
  console.log(`[peeps] report: ${planned.length} tests at ${env.sha.slice(0, 7)} (${env.ref ?? "?"})`);
  const jobUrl = env.runUrl;
  const response = await peeps.post("/api/v1/ci/batches", {
    sha: env.sha,
    jobUrl,
    baseUrl: process.env.BASE_URL ?? null,
    tests: planned.map(({ path: p, titlePath, pwProject }) => ({ path: p, titlePath, pwProject })),
    files: await moduleFilePayload(env, collection)
  });
  const runs = response.batches.flatMap((b) => b.runs);
  const unmatched = response.batches.flatMap((b) => b.unmatched);
  console.log(
    `[peeps] planned ${runs.length} run(s) in ${response.batches.length} batch(es); ${unmatched.length} test(s) unknown to Peeps`
  );
  for (const u of unmatched.slice(0, 10)) console.log(`[peeps]   unknown: ${u.path} \u203A ${u.titlePath}`);
  const { byNodeId } = nodeIdsForRuns(planned, runs);
  await executePytestAndReport(env, peeps, {
    collection,
    byNodeId,
    batches: response.batches.map((b) => ({
      batchId: b.batchId,
      batchNumber: b.batchNumber,
      runIds: b.runs.map((r) => r.runId)
    }))
  });
}
async function runPytestDispatched(env, peeps) {
  if (!env.sessionId) throw new Error("`session-id` is required in run mode (Peeps passes it)");
  const collection = await collectPytest(env);
  const rootDir = repoRootDir(env, collection);
  const planned = plannedPytestTests(collection, rootDir);
  const plan = await requestPlan(peeps, env.sessionId, {
    tests: planned.map(({ path: p, titlePath, pwProject }) => ({ path: p, titlePath, pwProject })).slice(0, 2e3)
  });
  if (!plan) return;
  console.log(`[peeps] run: batch ${plan.batchNumber} holds ${plan.runs.length} run(s)`);
  const { byNodeId, unmatched } = nodeIdsForRuns(planned, plan.runs);
  for (const run of unmatched.slice(0, 10)) {
    console.log(`[peeps]   not collected here, not run: ${run.path} \u203A ${run.titlePath}`);
  }
  const nodeIds = Object.keys(byNodeId);
  if (nodeIds.length === 0) {
    await peeps.post(`/api/v1/ci/batches/${plan.batchId}/complete`, { reportUploaded: false });
    if (plan.runs.length > 0) {
      throw new Error(`none of the ${plan.runs.length} planned test(s) were collected at this commit`);
    }
    return;
  }
  const environment = planEnvironmentVariables(plan.environment, process.env);
  if (environment.log) console.log(environment.log);
  await executePytestAndReport(env, peeps, {
    collection,
    byNodeId,
    batches: [{ batchId: plan.batchId, batchNumber: plan.batchNumber }],
    nodeIds,
    extraEnv: environment.vars
  });
}
function nodeIdArgument(nodeId, rootDirAbs, cwd) {
  const separator = nodeId.indexOf("::");
  const file = separator === -1 ? nodeId : nodeId.slice(0, separator);
  const rest = separator === -1 ? "" : nodeId.slice(separator);
  let from = cwd;
  try {
    from = (0, import_node_fs8.realpathSync)(cwd);
  } catch {
  }
  const relative = import_node_path18.default.relative(from, import_node_path18.default.join(rootDirAbs, file)).split(import_node_path18.default.sep).join("/");
  return relative + rest;
}
async function executePytestAndReport(env, peeps, input2) {
  const scratch = await (0, import_promises9.mkdtemp)(import_node_path18.default.join(process.env.RUNNER_TEMP ?? (0, import_node_os4.tmpdir)(), "peeps-"));
  const planFile = import_node_path18.default.join(scratch, "plan.json");
  const resultsFile = import_node_path18.default.join(scratch, "results.json");
  const outputDir = import_node_path18.default.join(scratch, "output");
  const artifactsDir = import_node_path18.default.join(scratch, "evidence");
  await (0, import_promises9.mkdir)(artifactsDir);
  const runs = Object.fromEntries(
    Object.entries(input2.byNodeId).map(([nodeId, run]) => [
      nodeId,
      { runId: run.runId, credential: run.credential }
    ])
  );
  await (0, import_promises9.writeFile)(planFile, JSON.stringify({ peepsUrl: env.peepsUrl, runs }), { mode: 384 });
  const config = env.configPath ? configArgs(env) : input2.collection.iniPath ? ["-c", input2.collection.iniPath] : [];
  const args = ["-p", PLUGIN, "--rootdir", input2.collection.rootDir, ...config];
  if (input2.collection.playwright) args.push("--output", outputDir);
  if (input2.nodeIds) {
    args.push(
      "--",
      ...input2.nodeIds.map((id) => nodeIdArgument(id, input2.collection.rootDir, env.workingDirectory))
    );
  }
  const code = await spawnPytest(args, {
    cwd: env.workingDirectory,
    env: pytestEnv({
      ...input2.extraEnv,
      PEEPS_PLAN_FILE: planFile,
      PEEPS_RESULTS_OUT: resultsFile,
      PEEPS_ARTIFACTS_DIR: artifactsDir,
      // Attachments are refused outside the repository (and pytest's temp).
      PEEPS_WORKSPACE: env.workspace,
      // Run mode executes the plan and nothing else, whatever addopts adds.
      ...input2.nodeIds ? { PEEPS_SELECT_ONLY: "1" } : {}
    }),
    capture: false
  }).then(
    (result) => result.code,
    (error) => {
      console.log(`[peeps] ${String(error)}`);
      return 1;
    }
  );
  const runIdByOutputDir = await readOutputDirs(resultsFile, input2.byNodeId);
  const evidence = await stagedEvidence(import_node_path18.default.join(artifactsDir, "upload"), input2.byNodeId);
  for (const b of input2.batches) {
    try {
      const uploaded = await uploadOutput(peeps, b.batchId, outputDir, runIdByOutputDir);
      console.log(`[peeps] uploaded ${uploaded} artifact file(s) for batch ${b.batchNumber}`);
    } catch (error) {
      console.log(`[peeps] artifact upload failed for batch ${b.batchId}: ${String(error)}`);
    }
    const mine = evidence.filter(
      (file) => input2.batches.length === 1 || (b.runIds ?? []).includes(file.runId)
    );
    if (mine.length > 0) {
      const uploaded = await uploadEvidence2(peeps, b.batchId, mine);
      console.log(`[peeps] uploaded ${uploaded} test attachment(s) for batch ${b.batchNumber}`);
    }
    try {
      await peeps.post(`/api/v1/ci/batches/${b.batchId}/complete`, { reportUploaded: false });
    } catch (error) {
      console.log(`[peeps] could not complete batch ${b.batchId}: ${String(error)}`);
    }
  }
  console.log(`[peeps] pytest exited with ${code}`);
  if (code !== 0) process.exitCode = code;
}
async function readOutputDirs(resultsFile, byNodeId) {
  const map = /* @__PURE__ */ new Map();
  try {
    const results = JSON.parse(await (0, import_promises9.readFile)(resultsFile, "utf8"));
    for (const [nodeId, dir] of Object.entries(results.outputDirs ?? {})) {
      const run = byNodeId[nodeId];
      if (run) map.set(import_node_path18.default.basename(dir), run.runId);
    }
  } catch {
  }
  return map;
}
var MAX_UPLOAD_BYTES2 = 128 * 1024 * 1024;
function artifactName(rel, runIdByOutputDir) {
  const [dir, ...rest] = rel.split("/");
  const runId = rest.length > 0 ? runIdByOutputDir.get(dir) : void 0;
  const flat = (runId ? [runId, ...rest] : [dir, ...rest]).join("-").replace(/[^A-Za-z0-9._-]/g, "_");
  if (flat.length <= 200) return `data/${flat}`;
  const ext = import_node_path18.default.extname(flat);
  return `data/${(0, import_node_crypto5.createHash)("sha1").update(rel).digest("hex")}${ext}`;
}
async function* walkOutput(dir, rel = "") {
  let entries;
  try {
    entries = await (0, import_promises9.readdir)(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const abs = import_node_path18.default.join(dir, entry.name);
    const relPath = rel ? `${rel}/${entry.name}` : entry.name;
    if (entry.isDirectory()) yield* walkOutput(abs, relPath);
    else if (entry.isFile()) yield { abs, rel: relPath };
  }
}
var MAX_EVIDENCE_BYTES = 25 * 1024 * 1024;
async function stagedEvidence(uploadDir, byNodeId) {
  try {
    if (!(await (0, import_promises9.lstat)(uploadDir)).isDirectory()) return [];
  } catch {
    return [];
  }
  const runIds = Object.values(byNodeId).map((run) => run.runId);
  const staged = [];
  for (const entry of await (0, import_promises9.readdir)(uploadDir, { withFileTypes: true })) {
    const name = entry.name;
    if (!entry.isFile() || !/^[A-Za-z0-9._-]{1,200}$/.test(name)) {
      console.log(`[peeps] not uploading ${JSON.stringify(name)}: not a staged attachment`);
      continue;
    }
    const runId = runIds.find((id) => name.startsWith(`${id}-evidence-`));
    if (runId === void 0) continue;
    staged.push({ abs: import_node_path18.default.join(uploadDir, name), name, runId });
  }
  return staged.sort((a, b) => a.name.localeCompare(b.name));
}
async function uploadEvidence2(peeps, batchId, files) {
  let uploaded = 0;
  for (const file of files) {
    try {
      const info = await (0, import_promises9.lstat)(file.abs);
      const cap = /-evidence-video\.mp4$/.test(file.name) ? MAX_VIDEO_BYTES : MAX_EVIDENCE_BYTES;
      if (!info.isFile() || info.size > cap) {
        console.log(`[peeps] skipping attachment ${file.name}: not a file within ${cap} bytes`);
        continue;
      }
      await peeps.postBytes(
        `/api/v1/ci/batches/${batchId}/artifacts?path=${encodeURIComponent(`data/${file.name}`)}`,
        await (0, import_promises9.readFile)(file.abs)
      );
      uploaded += 1;
    } catch (error) {
      console.log(`[peeps] skipped attachment ${file.name}: ${String(error).slice(0, 200)}`);
    }
  }
  return uploaded;
}
async function uploadOutput(peeps, batchId, outputDir, runIdByOutputDir) {
  let uploaded = 0;
  for await (const file of walkOutput(outputDir)) {
    const info = await (0, import_promises9.stat)(file.abs);
    if (info.size > MAX_UPLOAD_BYTES2) {
      console.log(`[peeps] skipping ${file.rel}: ${info.size} bytes exceeds the upload limit`);
      continue;
    }
    const name = artifactName(file.rel, runIdByOutputDir);
    try {
      await peeps.postBytes(
        `/api/v1/ci/batches/${batchId}/artifacts?path=${encodeURIComponent(name)}`,
        await (0, import_promises9.readFile)(file.abs)
      );
      uploaded += 1;
    } catch (error) {
      console.log(`[peeps] skipped ${file.rel}: ${String(error).slice(0, 200)}`);
    }
  }
  return uploaded;
}

// src/appium.ts
var COLLECTOR = import_node_path19.default.join(__dirname, "..", "dist", "appium-collect.mjs");
var APPIUM_REPORTER = import_node_path19.default.join(__dirname, "..", "dist", "appium-reporter.js");
var DEFAULT_CONFIGS = ["ts", "mts", "js", "mjs", "cjs", "cts"].map((ext) => `wdio.conf.${ext}`);
var COLLECT_TIMEOUT_MS = 10 * 60 * 1e3;
async function readAppiumCapabilities(env, configPath = wdioConfigPath(env), extraEnv = {}) {
  const read = await runCollector(env, ["--capabilities", configPath], "reading the WebdriverIO capabilities", extraEnv);
  for (const note of read.notes) console.log(`[peeps] ${note}`);
  return read;
}
var MAX_UPLOAD_BYTES3 = 128 * 1024 * 1024;
function wdioConfigPath(env) {
  if (env.configPath) return import_node_path19.default.resolve(env.workingDirectory, env.configPath);
  for (const name of DEFAULT_CONFIGS) {
    const candidate = import_node_path19.default.join(env.workingDirectory, name);
    if ((0, import_node_fs9.existsSync)(candidate)) return candidate;
  }
  let names = [];
  try {
    names = (0, import_node_fs9.readdirSync)(env.workingDirectory).filter((name) => WDIO_CONFIG.test(name)).sort();
  } catch {
  }
  if (names.length === 1) return import_node_path19.default.join(env.workingDirectory, names[0]);
  throw new Error(
    names.length > 1 ? `several WebdriverIO configs in ${env.workingDirectory} (${names.join(", ")}): set \`config\` to the one this job runs` : `no wdio.conf.ts (or .js, .mjs, .cjs) in ${env.workingDirectory}: set \`config\` to your WebdriverIO config`
  );
}
async function runCollector(env, args, what, extraEnv = {}) {
  const scratch = await (0, import_promises10.mkdtemp)(import_node_path19.default.join(process.env.RUNNER_TEMP ?? (0, import_node_os5.tmpdir)(), "peeps-collect-"));
  const out = import_node_path19.default.join(scratch, "collection.json");
  const { code, output } = await new Promise((resolve, reject) => {
    const child = (0, import_node_child_process7.spawn)(process.execPath, [COLLECTOR, ...args, out], {
      cwd: env.workingDirectory,
      env: { ...process.env, CI: "1", ...extraEnv },
      stdio: ["ignore", "pipe", "pipe"]
    });
    let output2 = "";
    const keep = (chunk) => {
      output2 = (output2 + chunk.toString("utf8")).slice(-2e4);
    };
    child.stdout.on("data", keep);
    child.stderr.on("data", keep);
    const timer = setTimeout(() => {
      output2 += `
[peeps] ${what} did not finish in ${COLLECT_TIMEOUT_MS / 1e3}s`;
      child.kill("SIGKILL");
    }, COLLECT_TIMEOUT_MS);
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(new Error(`could not start the collector: ${error.message}`));
    });
    child.on("close", (code2) => {
      clearTimeout(timer);
      resolve({ code: code2 ?? 1, output: output2 });
    });
  });
  if (code !== 0 || !(0, import_node_fs9.existsSync)(out)) {
    throw new Error(`${what} failed (${code}):
${output.slice(-4e3)}`);
  }
  return JSON.parse(await (0, import_promises10.readFile)(out, "utf8"));
}
async function collectAppium(env, configPath = wdioConfigPath(env)) {
  const collection = await runCollector(env, [configPath], "collecting the WebdriverIO suite");
  for (const note of collection.notes) console.log(`[peeps] ${note}`);
  for (const error of collection.errors) {
    console.log(`[peeps] collection error in ${error.file}:
${error.message}`);
  }
  return collection;
}
function repoPath(env, abs) {
  if (import_node_path19.default.resolve(abs) === import_node_path19.default.resolve(env.workspace)) return "";
  const rel = repoRelative(env.workspace, abs);
  if (rel === null) throw new Error(`${abs} is outside the repository (${env.workspace})`);
  return rel;
}
function appiumRootDir(env, collection) {
  let root = repoPath(env, collection.rootDir);
  const files = collection.specs.map((file) => repoPath(env, file));
  const holds = (file) => root === "" || file.startsWith(`${root}/`);
  while (!files.every(holds)) {
    const parent = import_node_path19.default.posix.dirname(root);
    root = parent === "." ? "" : parent;
  }
  return root || ".";
}
function tagsOf(titles) {
  const tags = /* @__PURE__ */ new Set();
  for (const title of titles) for (const match of title.matchAll(/(?:^|\s)@([^\s@]+)/g)) tags.add(match[1]);
  return [...tags];
}
function lineOf(source, titles) {
  let from = 0;
  let found = -1;
  for (const title of titles) {
    let best = -1;
    for (const quote of ["'", '"', "`"]) {
      const index = source.indexOf(`${quote}${title}${quote}`, from);
      if (index !== -1 && (best === -1 || index < best)) best = index;
    }
    if (best === -1) return found === -1 ? 1 : source.slice(0, found).split("\n").length;
    found = best;
    from = best + 1;
  }
  return found === -1 ? 1 : source.slice(0, found).split("\n").length;
}
async function buildAppiumList(env, collection) {
  const rootDir = appiumRootDir(env, collection);
  const prefix = rootDir === "." ? "" : `${rootDir}/`;
  const relativeToRoot = (abs) => repoPath(env, abs).slice(prefix.length);
  const sources = /* @__PURE__ */ new Map();
  const files = [];
  const fileSuites = /* @__PURE__ */ new Map();
  for (const test of collection.tests) {
    const file = relativeToRoot(test.file);
    let source = sources.get(test.file);
    if (source === void 0) {
      const bytes = await (0, import_promises10.readFile)(test.file);
      source = bytes.toString("utf8");
      sources.set(test.file, source);
      files.push({ path: prefix + file, blobSha: gitBlobSha(bytes), content: source });
    }
    let suite = fileSuites.get(file);
    if (!suite) {
      suite = { title: file, file, line: 0, specs: [], suites: [] };
      fileSuites.set(file, suite);
    }
    const describes = test.titlePath.slice(0, -1);
    for (let depth = 0; depth < describes.length; depth++) {
      const title = describes[depth];
      let child = suite.suites.find((s2) => s2.title === title);
      if (!child) {
        child = { title, file, line: lineOf(source, describes.slice(0, depth + 1)), specs: [], suites: [] };
        suite.suites.push(child);
      }
      suite = child;
    }
    suite.specs.push({
      title: test.titlePath[test.titlePath.length - 1] ?? "",
      file,
      line: lineOf(source, test.titlePath),
      tags: tagsOf(test.titlePath)
    });
  }
  const sorted = [...fileSuites.keys()].sort();
  return {
    rootDir,
    list: {
      config: { rootDir: import_node_path19.default.join(env.workspace, rootDir === "." ? "" : rootDir), projects: [] },
      suites: sorted.map((file) => fileSuites.get(file))
    },
    files: files.sort((a, b) => a.path.localeCompare(b.path)),
    collectionErrors: collection.errors.map((error) => relativeToRoot(error.file))
  };
}
async function buildAppiumInventoryRequest(env, collection) {
  if (!env.sha) throw new Error("The commit sha is not set (GITHUB_SHA / CI_COMMIT_SHA)");
  const built = await buildAppiumList(env, collection);
  return {
    sha: env.sha,
    framework: "appium",
    rootDir: built.rootDir,
    list: built.list,
    // Spec files that did not load (relative to rootDir, as the list's
    // files are): present, but unread, so their tests' absence from the list
    // is not their deletion.
    collectionErrors: built.collectionErrors,
    files: built.files
  };
}
async function runAppiumInventory(env, peeps) {
  const collection = await collectAppium(env);
  const request = await buildAppiumInventoryRequest(env, collection);
  console.log(
    `[peeps] inventory: ${collection.tests.length} WebdriverIO tests in ${request.files.length} spec files at ${request.sha.slice(0, 7)}`
  );
  const result = await peeps.post("/api/v1/ci/inventory", request);
  console.log(`[peeps] inventory accepted: ${JSON.stringify(result.results)}`);
}
function recordVideoRunIdsOf(batches) {
  return batches.filter((b) => b.recordVideo === true).flatMap((b) => b.runs.map((r) => r.runId));
}
async function ffmpegAvailable(pathEnv = process.env.PATH ?? "") {
  const runs = (bin) => new Promise((resolve) => {
    (0, import_node_child_process7.execFile)(bin, ["-version"], { timeout: 1e4, env: { ...process.env, PATH: pathEnv } }, (error) => resolve(!error));
  });
  return await runs("ffmpeg") && await runs("ffprobe");
}
function ffmpegInstallCommand(platform = process.platform) {
  if (platform === "linux") {
    return "sudo -n apt-get update -qq && sudo -n apt-get install -y -qq --no-install-recommends ffmpeg";
  }
  if (platform === "darwin") return "HOMEBREW_NO_AUTO_UPDATE=1 HOMEBREW_NO_INSTALL_CLEANUP=1 brew install ffmpeg";
  return null;
}
var FFMPEG_INSTALL_TIMEOUT_MS = 10 * 60 * 1e3;
function installFfmpeg() {
  const command = ffmpegInstallCommand();
  if (!command) return Promise.reject(new Error(`no installer for ${process.platform}`));
  return new Promise((resolve, reject) => {
    (0, import_node_child_process7.execFile)(
      "bash",
      ["-c", command],
      { timeout: FFMPEG_INSTALL_TIMEOUT_MS, maxBuffer: 16 * 1024 * 1024 },
      (error, _out, err) => error ? reject(new Error(err.trim().split("\n").pop() || error.message)) : resolve()
    );
  });
}
async function ensureFfmpeg(deps = {
  available: () => ffmpegAvailable(),
  install: installFfmpeg
}) {
  if (await deps.available()) return true;
  console.log("[peeps] Record video: ffmpeg is not on this runner; installing it");
  try {
    await deps.install();
  } catch (error) {
    console.log(`[peeps] Record video: could not install ffmpeg (${error instanceof Error ? error.message : String(error)})`);
    return false;
  }
  return deps.available();
}
async function runAppiumReport(env, peeps, runner, ffmpegCheck) {
  if (!env.sha) throw new Error("The commit sha is not set (GITHUB_SHA / CI_COMMIT_SHA)");
  const configPath = wdioConfigPath(env);
  const collection = await collectAppium(env, configPath);
  const built = await buildAppiumList(env, collection);
  const tests = plannedTestsOf(built.list, built.rootDir);
  console.log(`[peeps] report: ${tests.length} tests at ${env.sha.slice(0, 7)} (${env.ref ?? "?"})`);
  const response = await peeps.post("/api/v1/ci/batches", {
    sha: env.sha,
    jobUrl: env.runUrl,
    baseUrl: process.env.BASE_URL ?? null,
    tests,
    files: built.files,
    ...announceFieldsOf(await negotiateTargetedRuns(env, peeps))
  });
  const runs = response.batches.flatMap((b) => b.runs);
  const unmatched = response.batches.flatMap((b) => b.unmatched);
  console.log(
    `[peeps] planned ${runs.length} run(s) in ${response.batches.length} batch(es); ${unmatched.length} test(s) unknown to Peeps`
  );
  for (const u of unmatched.slice(0, 10)) console.log(`[peeps]   unknown: ${u.path} \u203A ${u.titlePath}`);
  const batches = response.batches.map((b) => ({
    batchId: b.batchId,
    batchNumber: b.batchNumber,
    runIds: b.runs.map((r) => r.runId)
  }));
  const recordVideoRunIds = recordVideoRunIdsOf(response.batches);
  if (!answeredNarrowed(response)) {
    await executeAppiumAndReport(env, peeps, { configPath, runs, batches, recordVideoRunIds, ffmpegCheck, runner });
    return;
  }
  const fallBack = (why) => {
    console.log(`[peeps] not narrowing, running the full suite: ${why}`);
    return executeAppiumAndReport(env, peeps, { configPath, runs, batches, recordVideoRunIds, ffmpegCheck, runner, ranFullSuite: true });
  };
  if (!isNarrowed(response)) return fallBack("Peeps did not narrow every project's batch");
  if (collection.errors.length > 0) return fallBack(`${collection.errors.length} spec file(s) did not load`);
  const selected = [...runs, ...unmatched];
  if (selected.length === 0) {
    console.log("[peeps] narrowed to 0 test(s) for this pull request");
    await completeBatches(peeps, batches);
    return;
  }
  if (collection.ownMochaFilter) return fallBack("the WebdriverIO config sets its own Mocha filter");
  const found = specsForRuns(env, collection, selected);
  for (const test of found.unmatched.slice(0, 10)) {
    console.log(`[peeps]   not collected here (or no capability runs its file), not run: ${test.path} \u203A ${test.titlePath}`);
  }
  if (found.matched.length === 0) return fallBack(`none of the ${selected.length} selected test(s) can run at this commit`);
  console.log(`[peeps] narrowed to ${selected.length} test(s) for this pull request`);
  const narrowedRuns = runs.filter((r) => found.matched.includes(r));
  await executeAppiumAndReport(env, peeps, {
    configPath,
    runs: narrowedRuns,
    recordVideoRunIds: recordVideoRunIds.filter((id) => narrowedRuns.some((r) => r.runId === id)),
    ffmpegCheck,
    batches,
    selection: {
      specs: found.specs,
      capabilitySpecs: found.capabilitySpecs,
      grep: exactMochaGrepFor(env, collection, found.matched),
      alsoRun: unmatched.filter((t) => found.matched.includes(t))
    },
    runner
  });
}
function specsForRuns(env, collection, runs) {
  const fileOf = /* @__PURE__ */ new Map();
  for (const test of collection.tests) {
    const rel = repoRelative(env.workspace, test.file);
    if (rel !== null) fileOf.set(`${rel}
${test.titlePath.join(TITLE_PATH_SEPARATOR)}`, test.file);
  }
  const perCapability = collection.capabilitySpecs ?? null;
  const scheduled = perCapability ? new Set(perCapability.flat()) : null;
  const specs = /* @__PURE__ */ new Set();
  const matched = [];
  const unmatched = [];
  for (const run of runs) {
    const file = fileOf.get(`${run.path}
${run.titlePath}`);
    if (file === void 0 || scheduled && !scheduled.has(file)) {
      unmatched.push(run);
      continue;
    }
    specs.add(file);
    matched.push(run);
  }
  const sorted = [...specs].sort();
  if (!perCapability) return { specs: sorted, matched, unmatched };
  return {
    specs: sorted,
    capabilitySpecs: perCapability.map((own) => sorted.filter((file) => own.includes(file))),
    matched,
    unmatched
  };
}
function escapeRegex3(value) {
  return value.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&").replace(/\n/g, "\\n").replace(/\r/g, "\\r").replace(/\u2028/g, "\\u2028").replace(/\u2029/g, "\\u2029");
}
function mochaGrepFor(titlePaths) {
  return fullTitleGrep(titlePaths.map((t) => t.split(TITLE_PATH_SEPARATOR).join(" ")));
}
function fullTitleGrep(fullTitles) {
  return `^(?:${[...new Set(fullTitles)].map(escapeRegex3).join("|")})$`;
}
function exactMochaGrepFor(env, collection, matched) {
  const wanted = new Set(matched.map(identityKey));
  const collected = collection.tests.filter(
    (test) => wanted.has(identityKey({ path: repoRelative(env.workspace, test.file) ?? "", titlePath: test.titlePath.join(TITLE_PATH_SEPARATOR) }))
  );
  return fullTitleGrep(collected.map((test) => test.titlePath.join(" ")));
}
async function runAppiumDispatched(env, peeps) {
  if (!env.sessionId) throw new Error("`session-id` is required in run mode (Peeps passes it)");
  const configPath = wdioConfigPath(env);
  const collection = await collectAppium(env, configPath);
  const built = await buildAppiumList(env, collection);
  const plan = await requestPlan(peeps, env.sessionId, {
    tests: plannedTestsOf(built.list, built.rootDir).slice(0, 2e3)
  });
  if (!plan) return;
  console.log(`[peeps] run: batch ${plan.batchNumber} holds ${plan.runs.length} run(s)`);
  const { specs, capabilitySpecs, matched, unmatched } = specsForRuns(env, collection, plan.runs);
  for (const run of unmatched.slice(0, 10)) {
    console.log(`[peeps]   not collected here (or no capability runs its file), not run: ${run.path} \u203A ${run.titlePath}`);
  }
  if (matched.length === 0) {
    await peeps.post(`/api/v1/ci/batches/${plan.batchId}/complete`, { reportUploaded: false });
    if (plan.runs.length > 0) {
      throw new Error(`none of the ${plan.runs.length} planned test(s) were collected at this commit`);
    }
    return;
  }
  const environment = planEnvironmentVariables(plan.environment, process.env);
  if (environment.log) console.log(environment.log);
  await executeAppiumAndReport(env, peeps, {
    configPath,
    runs: matched,
    recordVideoRunIds: plan.recordVideo === true ? matched.map((r) => r.runId) : [],
    batches: [{ batchId: plan.batchId, batchNumber: plan.batchNumber }],
    selection: { specs, capabilitySpecs, grep: mochaGrepFor(matched.map((r) => r.titlePath)) },
    extraEnv: environment.vars
  });
}
function hasPackage(name, from) {
  for (let dir = from; ; dir = import_node_path19.default.dirname(dir)) {
    if ((0, import_node_fs9.existsSync)(import_node_path19.default.join(dir, "node_modules", name, "package.json"))) return true;
    if (import_node_path19.default.dirname(dir) === dir) return false;
  }
}
var liveWrappers = /* @__PURE__ */ new Set();
var liveGroups = /* @__PURE__ */ new Map();
function trackProcessGroup(child) {
  const pid = child.pid;
  if (pid === void 0) return;
  liveGroups.set(
    pid,
    new Promise((resolve) => {
      child.once("exit", () => {
        liveGroups.delete(pid);
        resolve();
      });
    })
  );
}
function killGroup(pid, signal) {
  try {
    process.kill(-pid, signal);
  } catch {
  }
}
async function stopAppiumRuns(graceMs = 3e3) {
  for (const file of [...liveWrappers]) {
    try {
      (0, import_node_fs9.unlinkSync)(file);
    } catch {
    }
    liveWrappers.delete(file);
  }
  const groups = [...liveGroups];
  if (groups.length === 0) return;
  for (const [pid] of groups) killGroup(pid, "SIGTERM");
  let timer;
  await Promise.race([
    Promise.all(groups.map(([, exited]) => exited)),
    new Promise((resolve) => timer = setTimeout(resolve, graceMs))
  ]);
  clearTimeout(timer);
  for (const [pid] of groups) killGroup(pid, "SIGKILL");
}
function stopOnSignal() {
  const onSignal = (signal) => {
    console.log(`[peeps] ${signal}: stopping WebdriverIO and removing the temporary config`);
    void stopAppiumRuns().finally(() => process.exit(signal === "SIGINT" ? 130 : 143));
  };
  process.once("SIGINT", onSignal);
  process.once("SIGTERM", onSignal);
  return () => {
    process.off("SIGINT", onSignal);
    process.off("SIGTERM", onSignal);
  };
}
async function writeWrapperConfig(configPath, options) {
  const ts = /\.[cm]?ts$/.test(configPath);
  const wrapper = import_node_path19.default.join(import_node_path19.default.dirname(configPath), `.peeps-${(0, import_node_crypto6.randomUUID)()}.wdio.conf.${ts ? "mts" : "mjs"}`);
  const source = [
    "// Written by peeps-action for this run and removed after it; never committed.",
    'import { createRequire } from "node:module";',
    `import * as loaded from ${JSON.stringify((0, import_node_url3.pathToFileURL)(configPath).href)};`,
    "const require = createRequire(import.meta.url);",
    `const { withPeeps } = require(${JSON.stringify(APPIUM_REPORTER)});`,
    "const base = loaded.config ?? loaded.default?.config;",
    `export const config = withPeeps(base, ${JSON.stringify(options)});`,
    ""
  ].join("\n");
  await (0, import_promises10.writeFile)(wrapper, source, { flag: "wx", mode: 384 });
  liveWrappers.add(wrapper);
  return {
    configPath: wrapper,
    cleanup: async () => {
      liveWrappers.delete(wrapper);
      await (0, import_promises10.unlink)(wrapper).catch((error) => {
        if (error.code !== "ENOENT") throw error;
      });
    }
  };
}
function runWdio(env, configPath, extraEnv) {
  return new Promise((resolve) => {
    const child = (0, import_node_child_process7.spawn)("npx", ["wdio", "run", configPath], {
      cwd: env.workingDirectory,
      stdio: "inherit",
      env: { ...process.env, CI: "1", ...extraEnv },
      // Its own process group, so a cancelled job stops it and every worker and service it started.
      detached: true
    });
    trackProcessGroup(child);
    child.on("error", (error) => {
      console.error(`[peeps] could not start WebdriverIO: ${String(error)}`);
      resolve(1);
    });
    child.on("close", (code) => resolve(code ?? 1));
  });
}
async function executeAppiumAndReport(env, peeps, input2) {
  const scratch = await (0, import_promises10.mkdtemp)(import_node_path19.default.join(process.env.RUNNER_TEMP ?? (0, import_node_os5.tmpdir)(), "peeps-"));
  const planFile = import_node_path19.default.join(scratch, "plan.json");
  const artifactsDir = import_node_path19.default.join(scratch, "evidence");
  await (0, import_promises10.mkdir)(artifactsDir);
  const plan = { peepsUrl: env.peepsUrl, workspace: env.workspace, runs: input2.runs };
  if (input2.selection) plan.onlyPlanned = true;
  if (input2.selection?.alsoRun?.length) plan.alsoRun = input2.selection.alsoRun;
  if (input2.recordVideoRunIds?.length) {
    plan.recordVideoRunIds = input2.recordVideoRunIds;
    plan.ffmpeg = await (input2.ffmpegCheck ?? (() => ensureFfmpeg()))();
    console.log(
      `[peeps] Record video is on: recording ${input2.recordVideoRunIds.length} run(s)` + (plan.ffmpeg ? "" : "; ffmpeg is not on this runner, so iOS does not record, Android stops at 3 minutes and no frames are cut")
    );
  }
  await (0, import_promises10.writeFile)(planFile, JSON.stringify(plan), { mode: 384 });
  const junitDir = hasPackage("@wdio/junit-reporter", import_node_path19.default.dirname(input2.configPath)) ? import_node_path19.default.join(scratch, "junit") : null;
  const options = { junitDir };
  if (input2.selection) {
    options.specs = input2.selection.specs.map((file) => (0, import_node_url3.pathToFileURL)(file).href);
    if (input2.selection.capabilitySpecs) {
      options.capabilitySpecs = input2.selection.capabilitySpecs.map((list) => list.map((file) => (0, import_node_url3.pathToFileURL)(file).href));
    }
    options.grep = input2.selection.grep;
    options.onlyPlanned = true;
  }
  let code = 1;
  let wrapper;
  const release = stopOnSignal();
  try {
    wrapper = await writeWrapperConfig(input2.configPath, options);
    const extraEnv = { ...input2.extraEnv, PEEPS_PLAN_FILE: planFile, PEEPS_ARTIFACTS_DIR: artifactsDir };
    code = await (input2.runner ?? ((config, extra) => runWdio(env, config, extra)))(wrapper.configPath, extraEnv);
  } catch (error) {
    console.log(`[peeps] could not run WebdriverIO: ${String(error)}`);
  } finally {
    release();
    await wrapper?.cleanup().catch((error) => {
      console.warn(`[peeps] could not remove the temporary wdio config: ${String(error)}`);
    });
  }
  const byRunId = Object.fromEntries(input2.runs.map((run) => [run.runId, run]));
  const evidence = await stagedEvidence(import_node_path19.default.join(artifactsDir, "upload"), byRunId);
  if (junitDir && input2.batches.length > 1) {
    console.log(`[peeps] JUnit XML not uploaded: this run spans ${input2.batches.length} batches, and it holds every batch's tests`);
  }
  for (const b of input2.batches) {
    const mine = evidence.filter((file) => input2.batches.length === 1 || (b.runIds ?? []).includes(file.runId));
    if (mine.length > 0) {
      const uploaded = await uploadEvidence2(peeps, b.batchId, mine);
      console.log(`[peeps] uploaded ${uploaded} test attachment(s) for batch ${b.batchNumber}`);
    }
    if (junitDir && input2.batches.length === 1) await uploadJunit(peeps, b.batchId, junitDir);
    try {
      await peeps.post(`/api/v1/ci/batches/${b.batchId}/complete`, {
        reportUploaded: false,
        ...input2.ranFullSuite ? { ranFullSuite: true } : {}
      });
    } catch (error) {
      console.log(`[peeps] could not complete batch ${b.batchId}: ${String(error)}`);
    }
  }
  console.log(`[peeps] wdio exited with ${code}`);
  if (code !== 0) process.exitCode = code;
}
function junitArtifactName(file) {
  return `data/${file.replace(/[^A-Za-z0-9._-]/g, "_")}.dat`;
}
async function uploadJunit(peeps, batchId, junitDir) {
  let names;
  try {
    names = (await (0, import_promises10.readdir)(junitDir)).filter((name) => name.endsWith(".xml")).sort();
  } catch {
    return;
  }
  let uploaded = 0;
  for (const name of names) {
    const file = import_node_path19.default.join(junitDir, name);
    try {
      if ((await (0, import_promises10.stat)(file)).size > MAX_UPLOAD_BYTES3) continue;
      await peeps.postBytes(
        `/api/v1/ci/batches/${batchId}/artifacts?path=${encodeURIComponent(junitArtifactName(name))}`,
        await (0, import_promises10.readFile)(file)
      );
      uploaded += 1;
    } catch (error) {
      console.log(`[peeps] skipped ${name}: ${String(error).slice(0, 200)}`);
    }
  }
  if (uploaded > 0) console.log(`[peeps] uploaded ${uploaded} JUnit file(s)`);
}
var AGENT_RUN_TIMEOUT_MS = 10 * 60 * 1e3;
var AGENT_PAGE_SOURCE_CHARS = 2e4;
var AGENT_PAGE_SOURCE_TESTS = 3;
function mochaGrepFromRegex(grep) {
  return grep.replace(/\n/g, "\\n").replace(/\r/g, "\\r").replace(/\u2028/g, "\\u2028").replace(/\u2029/g, "\\u2029");
}
function runWdioCaptured(env, configPath, extraEnv) {
  return new Promise((resolve) => {
    const child = (0, import_node_child_process7.spawn)("npx", ["wdio", "run", configPath], {
      cwd: env.workingDirectory,
      env: { ...process.env, CI: "1", ...extraEnv },
      stdio: ["ignore", "pipe", "pipe"],
      // Its own process group, so a timeout (or a signal: `stopAppiumRuns`) also stops the Appium service it started.
      detached: true
    });
    trackProcessGroup(child);
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => stdout = (stdout + d.toString("utf8")).slice(-2e5));
    child.stderr.on("data", (d) => stderr = (stderr + d.toString("utf8")).slice(-2e5));
    const timer = setTimeout(() => {
      stderr += `
[peeps] wdio did not finish in ${AGENT_RUN_TIMEOUT_MS / 1e3}s and was stopped`;
      try {
        process.kill(-child.pid, "SIGKILL");
      } catch {
        child.kill("SIGKILL");
      }
    }, AGENT_RUN_TIMEOUT_MS);
    child.on("error", (error) => {
      clearTimeout(timer);
      resolve({ code: 1, stdout, stderr: `${stderr}
could not start WebdriverIO: ${error.message}` });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code: code ?? 1, stdout, stderr });
    });
  });
}
async function readLocalResults(resultsDir) {
  let names;
  try {
    names = (await (0, import_promises10.readdir)(resultsDir)).filter((name) => name.endsWith(".jsonl")).sort();
  } catch {
    return [];
  }
  const byRunId = /* @__PURE__ */ new Map();
  for (const name of names) {
    for (const raw of (await (0, import_promises10.readFile)(import_node_path19.default.join(resultsDir, name), "utf8")).split("\n")) {
      if (!raw.trim()) continue;
      let line;
      try {
        line = JSON.parse(raw);
      } catch {
        continue;
      }
      const seen = byRunId.get(line.runId);
      if (seen) seen.events.push(...line.events);
      else byRunId.set(line.runId, { ...line, events: [...line.events] });
    }
  }
  return [...byRunId.values()];
}
async function runAppiumTests(env, input2, options = {}) {
  const redact = options.redact ?? ((text2) => text2);
  const configPath = wdioConfigPath(env);
  const scratch = await (0, import_promises10.mkdtemp)(import_node_path19.default.join(process.env.RUNNER_TEMP ?? (0, import_node_os5.tmpdir)(), "peeps-agent-run-"));
  const planFile = import_node_path19.default.join(scratch, "plan.json");
  const artifactsDir = import_node_path19.default.join(scratch, "evidence");
  const resultsDir = import_node_path19.default.join(scratch, "results");
  await (0, import_promises10.mkdir)(artifactsDir);
  const plan = { peepsUrl: env.peepsUrl, workspace: env.workspace, runs: [], resultsDir };
  await (0, import_promises10.writeFile)(planFile, JSON.stringify(plan), { mode: 384 });
  const wdioOptions = {
    junitDir: null,
    // As a file URL: WebdriverIO globs a plain path, and `[id].spec.ts` is a glob.
    specs: [(0, import_node_url3.pathToFileURL)(input2.file).href]
  };
  if (input2.grep) wdioOptions.grep = mochaGrepFromRegex(input2.grep);
  const started = Date.now();
  let run = { code: 1, stdout: "", stderr: "" };
  let wrapper;
  try {
    wrapper = await writeWrapperConfig(configPath, wdioOptions);
    const extraEnv = { ...input2.extraEnv, PEEPS_PLAN_FILE: planFile, PEEPS_ARTIFACTS_DIR: artifactsDir };
    run = await (options.runner ?? ((config, extra) => runWdioCaptured(env, config, extra)))(wrapper.configPath, extraEnv);
  } catch (error) {
    run = { ...run, stderr: `could not run WebdriverIO: ${String(error)}` };
  } finally {
    await wrapper?.cleanup().catch(() => void 0);
  }
  const sources = /* @__PURE__ */ new Map();
  const sourceOf = async (rel) => {
    if (!sources.has(rel)) sources.set(rel, await (0, import_promises10.readFile)(import_node_path19.default.join(env.workspace, rel), "utf8").catch(() => null));
    return sources.get(rel) ?? null;
  };
  const results = [];
  let inlined = 0;
  for (const line of await readLocalResults(resultsDir)) {
    const end = line.events.filter((event) => event.type === "test_end").at(-1);
    if (!end) continue;
    const titles = line.titlePath.split(TITLE_PATH_SEPARATOR);
    const source = await sourceOf(line.path);
    const result = {
      title: line.titlePath,
      file: line.path,
      line: source === null ? 1 : lineOf(source, titles),
      status: end.status ?? "unknown"
    };
    if (end.error) result.error = redact(end.error.slice(0, 2e3));
    if (end.errorStack) result.errorStack = redact(end.errorStack.slice(0, 4e3));
    if (end.attachments?.length) {
      result.evidence = end.attachments.map((a) => ({
        name: a.name,
        path: import_node_path19.default.join(artifactsDir, "upload", import_node_path19.default.basename(a.path)),
        size: a.size
      }));
      const pageSource = result.evidence.find((e) => e.name.startsWith("page-source"));
      if (pageSource && inlined < AGENT_PAGE_SOURCE_TESTS) {
        const text2 = await (0, import_promises10.readFile)(pageSource.path, "utf8").catch(() => null);
        if (text2 !== null) {
          inlined += 1;
          result.pageSource = redact(text2.slice(0, AGENT_PAGE_SOURCE_CHARS));
          if (text2.length > AGENT_PAGE_SOURCE_CHARS) result.pageSourceTruncated = true;
        }
      }
    }
    results.push(result);
  }
  const outcome = {
    exitCode: run.code,
    durationMs: Date.now() - started,
    results,
    stderr: redact(run.stderr.slice(-8e3))
  };
  if (run.code !== 0 || results.length === 0) outcome.stdoutTail = redact(run.stdout.slice(-4e3));
  return outcome;
}

// src/device-tools.ts
var import_node_child_process8 = require("node:child_process");
var import_node_fs10 = require("node:fs");
var import_promises11 = require("node:fs/promises");
var import_node_net = require("node:net");
var import_node_os6 = require("node:os");
var import_node_path20 = __toESM(require("node:path"));
var DEFAULT_DEVICE_LIMITS = {
  readyWaitMs: 6e4,
  callMs: 5e4,
  requestMs: 3e4,
  sessionCreateMs: 6 * 6e4,
  // GitHub gives a cancelled job about 7 s between SIGINT and SIGTERM: the
  // delete (3 s) and Appium's stop (SIGTERM, SIGKILL after 2 s, 1 s more)
  // fit inside it.
  closeMs: 3e3
};
var CLOSE_STARTUP_WAIT_MS = 500;
var PAGE_SOURCE_DEFAULT_CHARS = 6e4;
var PAGE_SOURCE_MAX_CHARS = 15e4;
var SCREENSHOT_INLINE_BASE64 = 18e4;
var SESSION_IDLE_SECONDS = 1800;
var ELEMENT_KEY = "element-6066-11e4-a52e-4f735466cecf";
var SENSITIVE = { "X-Appium-Is-Sensitive": "true" };
var W3C_CAPABILITIES = /* @__PURE__ */ new Set([
  "browserName",
  "browserVersion",
  "platformName",
  "acceptInsecureCerts",
  "pageLoadStrategy",
  "proxy",
  "setWindowRect",
  "timeouts",
  "strictFileInteractability",
  "unhandledPromptBehavior",
  "webSocketUrl"
]);
var DEVICE_STRATEGIES = [
  "accessibility id",
  "id",
  "xpath",
  "class name",
  "-android uiautomator",
  "-ios predicate string",
  "-ios class chain",
  "css selector"
];
var DIRECTIONS = ["up", "down", "left", "right"];
function sessionCapabilities(raw) {
  const caps = {};
  for (const [key, value] of Object.entries(raw)) {
    if (key.startsWith("wdio:")) continue;
    caps[W3C_CAPABILITIES.has(key) || key.includes(":") ? key : `appium:${key}`] = value;
  }
  const idle = Number(caps["appium:newCommandTimeout"]);
  if (idle !== 0 && !(idle >= SESSION_IDLE_SECONDS)) caps["appium:newCommandTimeout"] = SESSION_IDLE_SECONDS;
  return caps;
}
function pngSize(bytes) {
  if (bytes.length < 24 || bytes.readUInt32BE(0) !== 2303741511 || bytes.toString("ascii", 12, 16) !== "IHDR") return null;
  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
}
var DeviceError = class extends Error {
  constructor(message, code = null) {
    super(message);
    this.code = code;
  }
};
var sleep2 = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
var duration = (ms) => ms >= 1e3 ? `${Math.round(ms / 1e3)} s` : `${ms} ms`;
function withTimeout(promise, ms, message) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new DeviceError(message)), ms);
    })
  ]).finally(() => clearTimeout(timer));
}
async function webdriver(url, method, body, timeoutMs, headers = {}) {
  let response;
  try {
    response = await fetch(url, {
      method,
      headers: body === void 0 ? headers : { "Content-Type": "application/json; charset=utf-8", ...headers },
      body: body === void 0 ? void 0 : JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs)
    });
  } catch (error) {
    const name = error.name;
    if (name === "TimeoutError" || name === "AbortError") {
      throw new DeviceError(`Appium did not answer ${method} ${new URL(url).pathname} within ${duration(timeoutMs)}`);
    }
    throw new DeviceError(`could not reach Appium: ${error.message}`);
  }
  const text2 = await response.text();
  let json = null;
  try {
    json = JSON.parse(text2);
  } catch {
  }
  const value = json?.value;
  if (!response.ok || value && typeof value === "object" && typeof value.error === "string") {
    const code = typeof value?.error === "string" ? value.error : `HTTP ${response.status}`;
    const message = String(value?.message ?? text2).split("\n")[0].slice(0, 500);
    throw new DeviceError(`${code}: ${message}`, code);
  }
  return { value: json?.value ?? null, sessionId: json?.sessionId };
}
function elementIdOf(value) {
  if (!value || typeof value !== "object") return null;
  const record = value;
  const id = record[ELEMENT_KEY] ?? record.ELEMENT;
  return typeof id === "string" ? id : null;
}
function stringArg(args, key, required) {
  const value = args[key];
  if (typeof value === "string" && value.length > 0) return value;
  if (value === void 0 && !required) return null;
  throw new DeviceError(`argument "${key}" must be a non-empty string`);
}
function numberArg(args, key, min, max, fallback) {
  const value = args[key];
  if (value === void 0) return fallback;
  if (typeof value !== "number" || !Number.isFinite(value) || value < min || value > max) {
    throw new DeviceError(`argument "${key}" must be a number from ${min} to ${max}`);
  }
  return value;
}
function enumArg(args, key, allowed, fallback) {
  const value = args[key];
  if (value === void 0 && fallback !== null) return fallback;
  if (value === void 0) return null;
  if (typeof value !== "string" || !allowed.includes(value)) {
    throw new DeviceError(`argument "${key}" must be one of: ${allowed.join(", ")}`);
  }
  return value;
}
function obj(properties, required = []) {
  return { type: "object", properties, required, additionalProperties: false };
}
var str = (description) => ({ type: "string", description });
var strategy = { type: "string", enum: [...DEVICE_STRATEGIES], description: "Locator strategy. Prefer accessibility id; css selector only in a WEBVIEW context" };
var direction = (description) => ({ type: "string", enum: [...DIRECTIONS], description });
var DEVICE_TOOL_SPECS = [
  {
    name: "device_page_source",
    description: "The current screen's page source: the native view hierarchy as XML, or the page's HTML in a WEBVIEW context. Truncated to maxChars.",
    inputSchema: obj({ maxChars: { type: "integer", minimum: 1e3, maximum: PAGE_SOURCE_MAX_CHARS, description: `Default ${PAGE_SOURCE_DEFAULT_CHARS}` } })
  },
  {
    name: "device_screenshot",
    description: "A PNG screenshot of the device screen, returned as an image when it is small enough; always saved on the runner.",
    inputSchema: obj({})
  },
  {
    name: "device_find",
    description: "Find elements on the current screen. Returns each element's id (for device_tap / device_type), text, rect and whether it is displayed.",
    inputSchema: obj({ strategy, selector: str("The selector for that strategy, e.g. `signIn` for accessibility id"), limit: { type: "integer", minimum: 1, maximum: 50, description: "Most elements described; default 10" } }, ["strategy", "selector"])
  },
  {
    name: "device_tap",
    description: "Tap an element (elementId from device_find), or a point on the screen (x, y in screen pixels).",
    inputSchema: obj({ elementId: str("An element id from device_find"), x: { type: "number", minimum: 0 }, y: { type: "number", minimum: 0 } })
  },
  {
    name: "device_type",
    description: "Type text into an element (elementId from device_find), optionally clearing it first. The text is never echoed; a value typed into a secure field is masked in later results.",
    inputSchema: obj({ elementId: str("An element id from device_find"), text: str("The text to type"), clear: { type: "boolean", description: "Clear the field first" } }, ["elementId", "text"])
  },
  {
    name: "device_swipe",
    description: "Swipe a finger across the screen, or across one element, in a direction (the direction the finger moves).",
    inputSchema: obj({ direction: direction("The way the finger moves"), elementId: str("Swipe within this element instead of the whole screen"), distance: { type: "number", minimum: 0.1, maximum: 0.95, description: "Fraction of the area to travel; default 0.6" } }, ["direction"])
  },
  {
    name: "device_scroll",
    description: "Scroll the screen to reveal content in a direction (down reveals what is below), optionally until an element is displayed.",
    inputSchema: obj({ direction: direction("The content to reveal: down scrolls toward the end"), strategy, selector: str("Stop when an element matching this is displayed"), maxSwipes: { type: "integer", minimum: 1, maximum: 10, description: "Default 5" } }, ["direction"])
  },
  { name: "device_back", description: "Press the system back button (Android), or navigate back.", inputSchema: obj({}) },
  { name: "device_contexts", description: "The available contexts (NATIVE_APP, WEBVIEW_\u2026) and the current one.", inputSchema: obj({}) },
  {
    name: "device_switch_context",
    description: "Switch to a context from device_contexts: a WEBVIEW_\u2026 one to use css selectors and read the page's HTML, NATIVE_APP to return.",
    inputSchema: obj({ name: str("The context name") }, ["name"])
  },
  {
    name: "device_launch_app",
    description: "Bring an app to the foreground, launching it if needed. Defaults to the app under test (appium:appPackage / appium:bundleId).",
    inputSchema: obj({ appId: str("Android package or iOS bundle id; default the app under test") })
  },
  {
    name: "device_terminate_app",
    description: "Stop an app. Defaults to the app under test (appium:appPackage / appium:bundleId).",
    inputSchema: obj({ appId: str("Android package or iOS bundle id; default the app under test") })
  },
  {
    name: "device_logs",
    description: "The device log since the last read: logcat on Android, syslog on iOS, by default. The last maxLines entries.",
    inputSchema: obj({ type: str("Log type, e.g. logcat, syslog, crashlog, server"), maxLines: { type: "integer", minimum: 1, maximum: 1e3, description: "Default 200" } })
  }
];
function text(value) {
  return { content: [{ type: "text", text: value }] };
}
function failure(message) {
  return { content: [{ type: "text", text: message }], isError: true };
}
function createDeviceTools(env, options = {}) {
  const limits = { ...DEFAULT_DEVICE_LIMITS, ...options.limits };
  const redact = options.redact ?? ((t) => t);
  const deps = {
    readCapabilities: options.deps?.readCapabilities ?? ((extraEnv) => defaultReadCapabilities(env, extraEnv)),
    startAppium: options.deps?.startAppium ?? ((signal) => startAppiumServer(env, signal))
  };
  let ready = null;
  let startError = null;
  let appium = null;
  let sessionId = null;
  let caps = {};
  let closing = null;
  let ended = false;
  const stopping = new AbortController();
  const typedSecrets = /* @__PURE__ */ new Set();
  let screenshots = 0;
  let testEnv = {};
  let forLog = (text2) => text2;
  const mask = (value) => {
    let out = redact(value);
    for (const secret of [...typedSecrets].sort((a, b) => b.length - a.length)) out = out.split(secret).join("[redacted]");
    return out;
  };
  const platform = () => String(caps.platformName ?? "").toLowerCase();
  async function startup() {
    const raw = await deps.readCapabilities(testEnv);
    if (!raw) throw new DeviceError("the WebdriverIO config names no capabilities to open a device session with");
    caps = sessionCapabilities(raw);
    if (stopping.signal.aborted) return;
    appium = await deps.startAppium(stopping.signal);
    if (stopping.signal.aborted) {
      await appium.stop();
      return;
    }
    const created = await webdriver(
      `${appium.url}/session`,
      "POST",
      { capabilities: { alwaysMatch: caps, firstMatch: [{}] } },
      limits.sessionCreateMs
    );
    const value = created.value;
    sessionId = value?.sessionId ?? created.sessionId ?? null;
    if (!sessionId) throw new DeviceError("Appium answered the new session without a session id");
    console.log(
      `[peeps] device session ${sessionId} open (${String(caps.platformName ?? "?")}, ${String(caps["appium:automationName"] ?? "?")}); Appium log: ${appium.logFile}`
    );
  }
  function start(vars) {
    if (ready) return;
    if (vars) {
      testEnv = vars;
      forLog = hideEnvironmentUrls(vars);
    }
    console.log("[peeps] device tools: reading capabilities, starting Appium and a device session");
    ready = startup().catch(async (error) => {
      startError = error instanceof Error ? error : new Error(String(error));
      if (!stopping.signal.aborted) console.log(`[peeps] device session could not start: ${forLog(mask(startError.message)).slice(0, 2e3)}`);
      await appium?.stop().catch(() => void 0);
    });
  }
  async function session() {
    if (ended || stopping.signal.aborted) throw new DeviceError("the device session has ended");
    if (!ready) start();
    await withTimeout(
      ready,
      limits.readyWaitMs,
      "the device session is still starting (Appium and the app launch can take a few minutes); call again shortly"
    );
    if (startError) throw new DeviceError(`the device session could not start: ${startError.message.slice(0, 1500)}`);
    if (ended || stopping.signal.aborted || !appium || !sessionId) throw new DeviceError("the device session has ended");
    return { url: `${appium.url}/session/${sessionId}` };
  }
  async function wd(method, route, body, timeoutMs = limits.requestMs, headers) {
    const { url } = await session();
    return (await webdriver(`${url}${route}`, method, body, timeoutMs, headers)).value;
  }
  async function currentContext() {
    const value = await wd("GET", "/context").catch(() => null);
    return typeof value === "string" ? value : null;
  }
  async function findElements(using, value) {
    const found = await wd("POST", "/elements", { using, value });
    return (Array.isArray(found) ? found : []).map(elementIdOf).filter((id) => id !== null);
  }
  async function describe(id) {
    const quick = Math.min(limits.requestMs, 1e4);
    const [elementText, rect, displayed] = await Promise.all([
      wd("GET", `/element/${encodeURIComponent(id)}/text`, void 0, quick).catch(() => null),
      wd("GET", `/element/${encodeURIComponent(id)}/rect`, void 0, quick).catch(() => null),
      wd("GET", `/element/${encodeURIComponent(id)}/displayed`, void 0, quick).catch(() => null)
    ]);
    return {
      elementId: id,
      text: typeof elementText === "string" ? mask(elementText).slice(0, 500) : null,
      rect: rect && typeof rect === "object" ? rect : null,
      displayed: typeof displayed === "boolean" ? displayed : null
    };
  }
  async function performTouch(points, moveMs) {
    const [first, ...rest] = points;
    const actions = [
      { type: "pointerMove", duration: 0, x: Math.round(first.x), y: Math.round(first.y), origin: "viewport" },
      { type: "pointerDown", button: 0 },
      { type: "pause", duration: 100 },
      ...rest.map((p) => ({ type: "pointerMove", duration: moveMs, x: Math.round(p.x), y: Math.round(p.y), origin: "viewport" })),
      { type: "pointerUp", button: 0 }
    ];
    await wd("POST", "/actions", {
      actions: [{ type: "pointer", id: "finger1", parameters: { pointerType: "touch" }, actions }]
    });
    await wd("DELETE", "/actions").catch(() => void 0);
  }
  async function areaOf(elementId) {
    const rect = await wd("GET", elementId ? `/element/${encodeURIComponent(elementId)}/rect` : "/window/rect");
    const n = (key) => typeof rect?.[key] === "number" ? rect[key] : 0;
    if (!(n("width") > 0 && n("height") > 0)) throw new DeviceError("could not read the size of the area to swipe");
    return { x: n("x"), y: n("y"), width: n("width"), height: n("height") };
  }
  async function swipe(area, finger, distance) {
    const cx = area.x + area.width / 2;
    const cy = area.y + area.height / 2;
    const dx = area.width * distance / 2;
    const dy = area.height * distance / 2;
    const from = { up: { x: cx, y: cy + dy }, down: { x: cx, y: cy - dy }, left: { x: cx + dx, y: cy }, right: { x: cx - dx, y: cy } }[finger];
    const to = { up: { x: cx, y: cy - dy }, down: { x: cx, y: cy + dy }, left: { x: cx - dx, y: cy }, right: { x: cx + dx, y: cy } }[finger];
    await performTouch([from, to], 500);
    return { from: { x: Math.round(from.x), y: Math.round(from.y) }, to: { x: Math.round(to.x), y: Math.round(to.y) } };
  }
  function appIdFor(args) {
    const ios = platform() === "ios";
    const id = stringArg(args, "appId", false) ?? String(caps[ios ? "appium:bundleId" : "appium:appPackage"] ?? "");
    if (!id) {
      throw new DeviceError(
        `pass appId: the capabilities name no ${ios ? "appium:bundleId" : "appium:appPackage"} for the app under test`
      );
    }
    return { key: ios ? "bundleId" : "appId", id };
  }
  async function readLogs(type) {
    try {
      return await wd("POST", "/se/log", { type });
    } catch (error) {
      const code = error.code ?? "";
      if (!/unknown (command|method)|HTTP 404/.test(code)) throw error;
      return wd("POST", "/log", { type });
    }
  }
  const tools = {
    async device_page_source(args) {
      const maxChars = numberArg(args, "maxChars", 1e3, PAGE_SOURCE_MAX_CHARS, PAGE_SOURCE_DEFAULT_CHARS);
      const [source, context] = await Promise.all([wd("GET", "/source"), currentContext()]);
      const masked = mask(String(source ?? ""));
      const kind = pageSourceExtension(masked, context);
      const cut = masked.length > maxChars;
      return text(
        `Page source (${kind}, context ${context ?? "unknown"}, ${masked.length} characters${cut ? `; the first ${maxChars} follow` : ""}):
${masked.slice(0, maxChars)}`
      );
    },
    async device_screenshot() {
      const data = String(await wd("GET", "/screenshot") ?? "");
      const bytes = Buffer.from(data, "base64");
      const size = pngSize(bytes);
      const dir = import_node_path20.default.join(process.env.RUNNER_TEMP ?? (0, import_node_os6.tmpdir)(), "peeps-device");
      await (0, import_promises11.mkdir)(dir, { recursive: true });
      screenshots += 1;
      const file = import_node_path20.default.join(dir, `screenshot-${screenshots}.png`);
      await (0, import_promises11.writeFile)(file, bytes);
      const inline = data.length <= SCREENSHOT_INLINE_BASE64;
      const info = {
        width: size?.width ?? null,
        height: size?.height ?? null,
        bytes: bytes.length,
        savedOnRunner: file,
        returned: inline,
        ...inline ? {} : { note: `larger than ${SCREENSHOT_INLINE_BASE64} base64 characters, so not returned; read the screen with device_page_source` }
      };
      const parts = [{ type: "text", text: JSON.stringify(info) }];
      if (inline) parts.unshift({ type: "image", data, mimeType: "image/png" });
      return { content: parts };
    },
    async device_find(args) {
      const using = enumArg(args, "strategy", DEVICE_STRATEGIES, null);
      if (!using) throw new DeviceError('argument "strategy" is required');
      const selector = stringArg(args, "selector", true);
      const limit = numberArg(args, "limit", 1, 50, 10);
      const ids = await findElements(using, selector);
      const elements = await Promise.all(ids.slice(0, limit).map(describe));
      return text(JSON.stringify({ strategy: using, selector: mask(selector), count: ids.length, truncated: ids.length > limit, elements }));
    },
    async device_tap(args) {
      const elementId = stringArg(args, "elementId", false);
      if (elementId) {
        await wd("POST", `/element/${encodeURIComponent(elementId)}/click`, {});
        return text(`Tapped element ${elementId}.`);
      }
      const x = numberArg(args, "x", 0, 1e5, null);
      const y = numberArg(args, "y", 0, 1e5, null);
      if (x === null || y === null) throw new DeviceError("pass elementId, or both x and y");
      await performTouch([{ x, y }], 0);
      return text(`Tapped at (${Math.round(x)}, ${Math.round(y)}).`);
    },
    async device_type(args) {
      const elementId = stringArg(args, "elementId", true);
      const value = args.text;
      if (typeof value !== "string") throw new DeviceError('argument "text" must be a string');
      if (value.length > 1e4) throw new DeviceError('argument "text" is longer than 10000 characters');
      const element = `/element/${encodeURIComponent(elementId)}`;
      const quick = Math.min(limits.requestMs, 1e4);
      const [password, type] = await Promise.all([
        wd("GET", `${element}/attribute/password`, void 0, quick).catch(() => null),
        wd("GET", `${element}/attribute/type`, void 0, quick).catch(() => null)
      ]);
      const secure = String(password) === "true" || /SecureTextField|^password$/i.test(String(type ?? ""));
      if (secure && value.length >= 3) typedSecrets.add(value);
      if (args.clear === true) await wd("POST", `${element}/clear`, {});
      await wd("POST", `${element}/value`, { text: value, value: Array.from(value) }, limits.requestMs, SENSITIVE);
      return text(
        `Typed ${Array.from(value).length} characters into element ${elementId}${secure ? " (a secure field: the value is masked in later results)" : ""}.`
      );
    },
    async device_swipe(args) {
      const finger = enumArg(args, "direction", DIRECTIONS, null);
      if (!finger) throw new DeviceError('argument "direction" is required');
      const distance = numberArg(args, "distance", 0.1, 0.95, 0.6);
      const elementId = stringArg(args, "elementId", false);
      const moved = await swipe(await areaOf(elementId), finger, distance);
      return text(`Swiped ${finger} ${elementId ? `within element ${elementId}` : "across the screen"}, from (${moved.from.x}, ${moved.from.y}) to (${moved.to.x}, ${moved.to.y}).`);
    },
    async device_scroll(args) {
      const reveal = enumArg(args, "direction", DIRECTIONS, null);
      if (!reveal) throw new DeviceError('argument "direction" is required');
      const using = enumArg(args, "strategy", DEVICE_STRATEGIES, null);
      const selector = stringArg(args, "selector", false);
      if (using === null !== (selector === null)) throw new DeviceError("pass strategy and selector together, or neither");
      const maxSwipes = numberArg(args, "maxSwipes", 1, 10, 5);
      const finger = { down: "up", up: "down", right: "left", left: "right" }[reveal];
      const visible = async () => {
        if (!using || !selector) return [];
        const shown = [];
        for (const id of (await findElements(using, selector)).slice(0, 10)) {
          const element = await describe(id);
          if (element.displayed !== false) shown.push(element);
        }
        return shown;
      };
      const area = await areaOf(null);
      for (let swipes = 0; ; swipes++) {
        const shown = await visible();
        if (shown.length > 0) return text(JSON.stringify({ found: true, swipes, elements: shown }));
        if (swipes >= maxSwipes) break;
        await swipe(area, finger, 0.5);
      }
      return text(JSON.stringify(using ? { found: false, swipes: maxSwipes } : { scrolled: reveal, swipes: maxSwipes }));
    },
    async device_back() {
      await wd("POST", "/back", {});
      return text("Pressed back.");
    },
    async device_contexts() {
      const [contexts, current] = await Promise.all([wd("GET", "/contexts"), currentContext()]);
      const names = (Array.isArray(contexts) ? contexts : []).map((c) => typeof c === "string" ? c : String(c?.id ?? c));
      return text(JSON.stringify({ current, contexts: names }));
    },
    async device_switch_context(args) {
      const name = stringArg(args, "name", true);
      await wd("POST", "/context", { name });
      return text(`Switched to context ${name}.`);
    },
    async device_launch_app(args) {
      const { key, id } = appIdFor(args);
      await wd("POST", "/execute/sync", { script: "mobile: activateApp", args: [{ [key]: id }] });
      return text(`Brought ${id} to the foreground.`);
    },
    async device_terminate_app(args) {
      const { key, id } = appIdFor(args);
      const stopped = await wd("POST", "/execute/sync", { script: "mobile: terminateApp", args: [{ [key]: id }] });
      return text(stopped === false ? `${id} was not running.` : `Stopped ${id}.`);
    },
    async device_logs(args) {
      const type = stringArg(args, "type", false) ?? (platform() === "ios" ? "syslog" : "logcat");
      const maxLines = numberArg(args, "maxLines", 1, 1e3, 200);
      const entries = await readLogs(type);
      const list = Array.isArray(entries) ? entries : [];
      const lines = list.slice(-maxLines).map((entry) => {
        const at = typeof entry.timestamp === "number" ? new Date(entry.timestamp).toISOString() : "";
        return `${at} ${String(entry.level ?? "")} ${mask(String(entry.message ?? "")).slice(0, 500)}`.trim();
      });
      return text(`${type}: ${list.length} entr${list.length === 1 ? "y" : "ies"} since the last read${list.length > maxLines ? `, the last ${maxLines} follow` : ""}:
${lines.join("\n")}`);
    }
  };
  const handlers = {};
  for (const [name, tool] of Object.entries(tools)) {
    handlers[name] = async (args) => {
      try {
        await session();
        return await withTimeout(tool(args ?? {}), limits.callMs, `${name} did not finish within ${duration(limits.callMs)}`);
      } catch (error) {
        return failure(mask(error instanceof Error ? error.message : String(error)));
      }
    };
  }
  async function close(reason) {
    if (closing) return closing;
    closing = (async () => {
      ended = true;
      const live = appium && sessionId ? `${appium.url}/session/${sessionId}` : null;
      if (live) {
        await webdriver(live, "DELETE", void 0, limits.closeMs).catch((error) => {
          console.log(`[peeps] could not delete the device session: ${forLog(mask(String(error))).slice(0, 200)}`);
        });
      }
      stopping.abort();
      if (ready) await withTimeout(ready, CLOSE_STARTUP_WAIT_MS, "startup did not stop").catch(() => void 0);
      await appium?.stop().catch(() => void 0);
      if (ready) console.log(`[peeps] device session closed (${reason})`);
    })();
    return closing;
  }
  return {
    specs: DEVICE_TOOL_SPECS,
    handlers,
    start,
    close,
    info: () => ({ tools: DEVICE_TOOL_SPECS.map((t) => t.name) })
  };
}
async function defaultReadCapabilities(env, extraEnv) {
  return (await readAppiumCapabilities(env, wdioConfigPath(env), extraEnv)).capabilities;
}
function resolveAppiumBinary(from, pathEnv = process.env.PATH ?? "") {
  for (let dir = import_node_path20.default.resolve(from); ; dir = import_node_path20.default.dirname(dir)) {
    const candidate = import_node_path20.default.join(dir, "node_modules", ".bin", "appium");
    if ((0, import_node_fs10.existsSync)(candidate)) return candidate;
    if (import_node_path20.default.dirname(dir) === dir) break;
  }
  for (const dir of pathEnv.split(import_node_path20.default.delimiter)) {
    if (!dir) continue;
    const candidate = import_node_path20.default.join(dir, "appium");
    if ((0, import_node_fs10.existsSync)(candidate)) return candidate;
  }
  return null;
}
function freePort() {
  return new Promise((resolve, reject) => {
    const server = (0, import_node_net.createServer)();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      server.close(() => resolve(port));
    });
  });
}
var APPIUM_START_MS = 12e4;
async function startAppiumServer(env, signal, startMs = APPIUM_START_MS) {
  const bin = resolveAppiumBinary(env.workingDirectory);
  if (!bin) {
    throw new Error(
      "Appium is not installed where the job runs: add it to the working directory (npm i -D appium) and install your driver (npx appium driver install uiautomator2, or xcuitest) before the action runs"
    );
  }
  const port = await freePort();
  const logFile = import_node_path20.default.join(process.env.RUNNER_TEMP ?? (0, import_node_os6.tmpdir)(), `peeps-appium-${port}.log`);
  const child = (0, import_node_child_process8.spawn)(
    bin,
    // `warn`: at its default (debug) and at info Appium logs every request
    // body, so the text device_type types would land in this file.
    [
      "--address",
      "127.0.0.1",
      "--port",
      String(port),
      "--base-path",
      "/",
      "--log",
      logFile,
      "--log-level",
      "warn",
      "--log-no-colors",
      "--log-timestamp"
    ],
    { cwd: env.workingDirectory, env: process.env, stdio: ["ignore", "pipe", "pipe"], detached: true }
  );
  let output = "";
  const keep = (chunk) => {
    output = (output + chunk.toString("utf8")).slice(-4e3);
  };
  child.stdout?.on("data", keep);
  child.stderr?.on("data", keep);
  let exited = null;
  const exitedPromise = new Promise((resolve) => {
    child.on("exit", (code, sig) => {
      exited = String(code ?? sig);
      resolve();
    });
    child.on("error", (error) => {
      exited = error.message;
      resolve();
    });
  });
  const kill = (sig) => {
    try {
      process.kill(-child.pid, sig);
    } catch {
      try {
        child.kill(sig);
      } catch {
      }
    }
  };
  let stopped = null;
  const stop = () => {
    stopped ??= (async () => {
      if (exited !== null) return;
      kill("SIGTERM");
      await Promise.race([exitedPromise, sleep2(2e3)]);
      if (exited === null) {
        kill("SIGKILL");
        await Promise.race([exitedPromise, sleep2(1e3)]);
      }
    })();
    return stopped;
  };
  signal.addEventListener("abort", () => void stop(), { once: true });
  const url = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + startMs;
  for (; ; ) {
    if (signal.aborted) {
      await stop();
      throw new Error("stopped while Appium was starting");
    }
    if (exited !== null) throw new Error(`Appium exited before it was ready (${exited}):
${output.slice(-2e3)}`);
    try {
      const response = await fetch(`${url}/status`, { signal: AbortSignal.timeout(2e3) });
      if (response.ok) break;
    } catch {
    }
    if (Date.now() > deadline) {
      await stop();
      throw new Error(`Appium did not answer on port ${port} within ${Math.round(startMs / 1e3)} s:
${output.slice(-2e3)}`);
    }
    await sleep2(500);
  }
  console.log(`[peeps] Appium ${bin} listening on ${url}; log ${logFile}`);
  return { url, logFile, stop };
}

// src/tools.ts
var import_node_child_process9 = require("node:child_process");
var import_node_crypto7 = require("node:crypto");
var import_node_fs11 = require("node:fs");
var import_promises13 = require("node:fs/promises");
var import_node_os8 = require("node:os");
var import_node_path22 = __toESM(require("node:path"));
var import_node_util3 = require("node:util");

// src/pytest-run-tool.ts
var import_promises12 = require("node:fs/promises");
var import_node_os7 = require("node:os");
var import_node_path21 = __toESM(require("node:path"));
var RUN_TESTS_HOOK = ".peeps/run-tests";
var RUN_TESTS_TIMEOUT_MS = 90 * 60 * 1e3;
function redactHttpCalls(calls, redact) {
  return calls.map((x) => ({
    ...x,
    url: redact(x.url),
    requestHeaders: x.requestHeaders.map((h) => ({ name: h.name, value: redact(h.value) })),
    responseHeaders: x.responseHeaders.map((h) => ({ name: h.name, value: redact(h.value) })),
    ...x.requestBody !== void 0 ? { requestBody: redact(x.requestBody) } : {},
    ...x.responseBody !== void 0 ? { responseBody: redact(x.responseBody) } : {},
    ...x.error !== void 0 ? { error: redact(x.error) } : {}
  }));
}
var MAX_RESULTS_WITH_CALLS = 3;
function pytestNodeArgument(fileRelativeToCwd, titlePath, browser = null) {
  if (!titlePath) return fileRelativeToCwd;
  const scopes = titlePath.split(TITLE_PATH_SEPARATOR2);
  if (browser) {
    const last = scopes.length - 1;
    const bracket = scopes[last].indexOf("[");
    if (bracket !== -1) scopes[last] = scopes[last].slice(0, bracket);
  }
  return `${fileRelativeToCwd}::${scopes.join("::")}`;
}
var OUTPUT_TAIL_CHARS = 2e4;
var PENDING_MARKER = "peeps:pending";
function pendingMarkerNote(output) {
  let note = null;
  for (const raw of output.split(/\r?\n/)) {
    const line = raw.trim();
    if (line === PENDING_MARKER) note = "";
    else if (line.startsWith(PENDING_MARKER) && /\s/.test(line[PENDING_MARKER.length] ?? "")) {
      note = line.slice(PENDING_MARKER.length).trim();
    }
  }
  return note;
}
var ENTITIES = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };
function decodeEntities(text2) {
  return text2.replace(/&(#x[0-9a-f]+|#[0-9]+|[a-z]+);/gi, (whole, code) => {
    if (code.startsWith("#x") || code.startsWith("#X")) return String.fromCodePoint(parseInt(code.slice(2), 16));
    if (code.startsWith("#")) return String.fromCodePoint(parseInt(code.slice(1), 10));
    return ENTITIES[code.toLowerCase()] ?? whole;
  });
}
function attributes(tag) {
  const out = {};
  for (const m of tag.matchAll(/([A-Za-z_:][-\w:.]*)\s*=\s*"([^"]*)"/g)) out[m[1]] = decodeEntities(m[2]);
  return out;
}
function junitTitlePath(classname, name, file, requestedFile = null) {
  if (classname === "") return "";
  let scopes;
  const dotted = file?.replace(/\.py$/, "").split(/[\\/]/).join(".");
  const parts = classname.split(".");
  const stem = requestedFile ? import_node_path21.default.basename(requestedFile).replace(/\.py$/, "") : null;
  if (dotted && (classname === dotted || classname.startsWith(`${dotted}.`))) {
    scopes = classname.slice(dotted.length).split(".").filter(Boolean);
  } else if (stem && parts.includes(stem)) {
    scopes = parts.slice(parts.lastIndexOf(stem) + 1);
  } else {
    scopes = parts.filter((segment) => /^Test/.test(segment));
  }
  return [...scopes, name].join(TITLE_PATH_SEPARATOR2);
}
function parseJunitResults(xml, requestedFile = null) {
  const results = [];
  const cases = xml.matchAll(/<testcase\b([^>]*?)(?:\/>|>([\s\S]*?)<\/testcase>)/g);
  for (const m of cases) {
    const attrs = attributes(m[1] ?? "");
    const body = m[2] ?? "";
    const outcome = body.match(/<(failure|error|skipped)\b([^>]*?)(?:\/>|>([\s\S]*?)<\/\1>)/);
    const status = !outcome ? "passed" : outcome[1] === "skipped" ? "skipped" : "failed";
    const name = attrs.name ?? "";
    const file = attrs.file ?? (attrs.classname === "" ? `${name.split(".").join("/")}.py` : requestedFile ?? "");
    const error = outcome ? [attributes(outcome[2] ?? "").message, decodeEntities(outcome[3] ?? "")].filter((part) => part && part.trim()).join("\n").slice(0, 4e3) : void 0;
    results.push({
      title: junitTitlePath(attrs.classname ?? "", name, attrs.file, requestedFile),
      file,
      ...attrs.line ? { line: Number(attrs.line) } : {},
      status,
      ...error ? { error } : {}
    });
  }
  return results;
}
var RUN_ENV = { CI: "1", PYTHONDONTWRITEBYTECODE: "1" };
var defaultDeps = {
  run: async (cmd, args, cwd, timeoutMs, extraEnv) => {
    const { spawn: spawn8 } = await import("node:child_process");
    return new Promise((resolve) => {
      const child = spawn8(cmd, args, { cwd, env: { ...process.env, ...RUN_ENV, ...extraEnv }, stdio: ["ignore", "pipe", "pipe"] });
      let output = "";
      const keep = (chunk) => {
        output = (output + chunk.toString("utf8")).slice(-OUTPUT_TAIL_CHARS);
      };
      const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
      child.stdout.on("data", keep);
      child.stderr.on("data", keep);
      child.on("error", (error) => {
        clearTimeout(timer);
        resolve({ code: 127, output: `could not start ${cmd}: ${error.message}` });
      });
      child.on("close", (code) => {
        clearTimeout(timer);
        resolve({ code: code ?? 1, output });
      });
    });
  },
  pytest: (args, cwd, extraEnv) => spawnPytest(args, { cwd, env: { ...process.env, ...RUN_ENV, ...extraEnv }, capture: true })
};
function evidenceEnv(out) {
  const pythonPath = process.env.PYTHONPATH;
  return {
    PYTHONPATH: pythonPath ? `${PLUGIN_DIR}${import_node_path21.default.delimiter}${pythonPath}` : PLUGIN_DIR,
    PEEPS_EVIDENCE_OUT: out
  };
}
function withHttpCalls(results, evidenceJson) {
  if (evidenceJson === null) return results;
  let entries;
  try {
    entries = JSON.parse(evidenceJson);
  } catch {
    return results;
  }
  if (!Array.isArray(entries)) return results;
  const byTitle = /* @__PURE__ */ new Map();
  for (const entry of entries) {
    if (!entry || typeof entry !== "object" || typeof entry.nodeId !== "string") continue;
    if (!Array.isArray(entry.httpExchanges) || entry.httpExchanges.length === 0) continue;
    try {
      byTitle.set(pytestNodeIdToTest(entry.nodeId).titlePath, entry);
    } catch {
    }
  }
  let given = 0;
  return results.map((result) => {
    const entry = result.status === "failed" ? byTitle.get(result.title) : void 0;
    if (!entry || given === MAX_RESULTS_WITH_CALLS) return result;
    given++;
    return {
      ...result,
      httpExchanges: entry.httpExchanges,
      ...typeof entry.httpExchangesOmitted === "number" && entry.httpExchangesOmitted > 0 ? { httpExchangesOmitted: entry.httpExchangesOmitted } : {},
      ...entry.evidenceTrimmed === true ? { evidenceTrimmed: true } : {}
    };
  });
}
async function runPytestTool(env, input2, deps = defaultDeps) {
  const rel = import_node_path21.default.relative(env.workingDirectory, input2.fileAbs).split(import_node_path21.default.sep).join("/");
  const repoRel = import_node_path21.default.relative(env.workspace, input2.fileAbs).split(import_node_path21.default.sep).join("/");
  const browser = input2.browser ?? null;
  const extraEnv = input2.extraEnv ?? {};
  const target = pytestNodeArgument(rel, input2.titlePath, browser);
  const dir = await (0, import_promises12.mkdtemp)(import_node_path21.default.join((0, import_node_os7.tmpdir)(), "peeps-pytest-"));
  const junit = import_node_path21.default.join(dir, "junit.xml");
  const evidence = import_node_path21.default.join(dir, "http-calls.json");
  const started = Date.now();
  try {
    const plan = input2.hook ? await input2.hook(dir) : { kind: "none" };
    if (plan.kind === "changed") {
      return {
        exitCode: 1,
        durationMs: Date.now() - started,
        ranWith: RUN_TESTS_HOOK,
        pending: false,
        pendingNote: null,
        results: null,
        outputTail: `${RUN_TESTS_HOOK} differs from the commit under test, so Peeps did not run it. Undo the change under .peeps/ and run the test again.`
      };
    }
    const hook = plan.kind === "ready" ? plan.path : null;
    const ran = hook ? await deps.run(hook, [junit, target], env.workingDirectory, RUN_TESTS_TIMEOUT_MS, extraEnv) : await deps.pytest(
      [
        "-p",
        PLUGIN,
        ...configArgs(env),
        `--junitxml=${junit}`,
        "-o",
        "junit_family=legacy",
        ...input2.keyword ? ["-k", input2.keyword] : [],
        ...browser ? ["--browser", browser] : [],
        "--",
        target
      ],
      env.workingDirectory,
      { ...extraEnv, ...evidenceEnv(evidence) }
    );
    let xml = null;
    try {
      xml = await (0, import_promises12.readFile)(junit, "utf8");
    } catch {
    }
    let calls = null;
    if (!hook) {
      try {
        calls = await (0, import_promises12.readFile)(evidence, "utf8");
      } catch {
      }
    }
    const firstBreak = ran.output.indexOf("\n");
    const whole = ran.output.length < OUTPUT_TAIL_CHARS ? ran.output : firstBreak < 0 ? "" : ran.output.slice(firstBreak + 1);
    const note = hook && xml === null && ran.code === 0 ? pendingMarkerNote(whole) : null;
    return {
      exitCode: ran.code,
      durationMs: Date.now() - started,
      ranWith: hook ? RUN_TESTS_HOOK : "pytest",
      pending: note !== null,
      pendingNote: note ? note : null,
      results: xml === null ? null : withHttpCalls(parseJunitResults(xml, repoRel), calls),
      outputTail: ran.output.slice(-8e3)
    };
  } finally {
    await (0, import_promises12.rm)(dir, { recursive: true, force: true });
  }
}

// src/tools.ts
var execFileAsync3 = (0, import_node_util3.promisify)(import_node_child_process9.execFile);
var MAX_FILE_BYTES = 512 * 1024;
var MAX_LIST = 2e3;
var MAX_GREP_MATCHES = 500;
var MAX_PATTERN_CHARS = 500;
var DENY_SEGMENTS = /* @__PURE__ */ new Set([".git", "node_modules"]);
var ToolError = class extends Error {
};
function str2(args, key, required = true) {
  const v = args[key];
  if (typeof v === "string" && v.length > 0) return v;
  if (!required) return "";
  throw new ToolError(`argument "${key}" must be a non-empty string`);
}
function jail(workspace, relative) {
  const cleaned = relative.replace(/\\/g, "/").replace(/^\/+/, "");
  const abs = import_node_path22.default.resolve(workspace, cleaned);
  const rel = import_node_path22.default.relative(workspace, abs);
  if (rel.startsWith("..") || import_node_path22.default.isAbsolute(rel)) {
    throw new ToolError(`path escapes the workspace: ${relative}`);
  }
  for (const seg of rel.split(import_node_path22.default.sep)) {
    if (DENY_SEGMENTS.has(seg)) throw new ToolError(`path is off limits: ${relative}`);
    if (/^\.env(\..*)?$/.test(seg)) throw new ToolError(`path is off limits: ${relative}`);
  }
  return abs;
}
function jailForWrite(workspace, relative) {
  const abs = jail(workspace, relative);
  const rel = import_node_path22.default.relative(workspace, abs).split(import_node_path22.default.sep).join("/");
  if (isCiConfiguration(rel)) {
    throw new ToolError(`workflow files are not writable by Peeps: ${relative}`);
  }
  const folded = rel.toLowerCase();
  if (folded === ".peeps" || folded.startsWith(".peeps/")) {
    throw new ToolError(`.peeps/ holds your own hooks and is not writable by Peeps: ${relative}`);
  }
  return abs;
}
function isCiConfiguration(rel) {
  if (rel === ".github/workflows" || rel.startsWith(".github/workflows/")) return true;
  if (rel === ".gitlab" || rel.startsWith(".gitlab/")) return true;
  const base = rel.split("/").pop() ?? "";
  if (base === ".gitlab-ci.yml" || base.endsWith(".gitlab-ci.yml")) return true;
  const configured = process.env.PEEPS_CI_CONFIG_PATH?.replace(/^\.?\/+/, "");
  return !!configured && rel === configured;
}
function authenticatedPushUrl(remote, token, platform) {
  const match = /^https:\/\/(?:[^@/]+@)?(.+)$/.exec(remote.trim());
  if (!match) throw new ToolError("the checkout's origin is not an https remote");
  const user = platform === "gitlab" ? "oauth2" : "x-access-token";
  return `https://${user}:${token}@${match[1]}`;
}
function maskUrlCredentials(text2) {
  return text2.replace(/https:\/\/[^@\s/]+@/g, "https://***@");
}
async function ensureParentDirInside(workspace, abs) {
  const parent = import_node_path22.default.dirname(abs);
  let existing = parent;
  for (; ; ) {
    try {
      await (0, import_promises13.stat)(existing);
      break;
    } catch {
      const up = import_node_path22.default.dirname(existing);
      if (up === existing) break;
      existing = up;
    }
  }
  const [realWorkspace, realExisting] = await Promise.all([(0, import_promises13.realpath)(workspace), (0, import_promises13.realpath)(existing)]);
  const rel = import_node_path22.default.relative(realWorkspace, realExisting);
  if (rel.startsWith("..") || import_node_path22.default.isAbsolute(rel)) {
    throw new ToolError(`path escapes the workspace: ${import_node_path22.default.relative(workspace, abs)}`);
  }
  if (existing !== parent) await (0, import_promises13.mkdir)(parent, { recursive: true });
}
var GREP_FILE = /\.(ts|tsx|js|jsx|mjs|cjs|json|md|yml|yaml|py|pyi|toml|ini|cfg)$/;
async function patchPaths(runGit, patchFile) {
  let stdout;
  try {
    ({ stdout } = await runGit(["apply", "--recount", "--numstat", patchFile]));
  } catch (error) {
    const e = error;
    throw new ToolError(`patch is not a valid diff: ${(e.stderr ?? e.message).slice(0, 500)}`);
  }
  const paths = [];
  for (const line of stdout.split("\n")) {
    if (!line.trim()) continue;
    const field = line.split("	").slice(2).join("	");
    if (!field) continue;
    if (field.startsWith('"')) {
      throw new ToolError("patch touches a path this tool will not parse");
    }
    paths.push(...renameSides(field));
  }
  return paths;
}
function renameSides(field) {
  if (!field.includes(" => ")) return [field];
  const brace = /^(.*)\{(.*) => (.*)\}(.*)$/.exec(field);
  if (brace) {
    const [, pre = "", oldMid = "", newMid = "", post = ""] = brace;
    return [`${pre}${oldMid}${post}`, `${pre}${newMid}${post}`].map(
      (p) => p.replace(/\/{2,}/g, "/")
    );
  }
  const [oldPath = "", newPath = ""] = field.split(" => ");
  return [oldPath, newPath];
}
var MAX_HASH_BYTES = 5 * 1024 * 1024;
var DIGEST_BUDGET_MS = 2e4;
async function changedFilesWithDigests(workspace, runGit, limits = {}) {
  const started = Date.now();
  const { stdout } = await runGit(
    ["status", "--porcelain=v1", "-z", "--untracked-files=all"],
    { maxBuffer: 8 * 1024 * 1024, timeout: DIGEST_BUDGET_MS }
  );
  const fields = stdout.split("\0");
  const files = [];
  let truncated = false;
  const realWorkspace = await (0, import_promises13.realpath)(workspace);
  const hashing = {
    maxBytes: limits.maxHashBytes ?? MAX_HASH_BYTES,
    outOfTime: () => Date.now() - started >= (limits.budgetMs ?? DIGEST_BUDGET_MS)
  };
  for (let i = 0; i < fields.length; i++) {
    const field = fields[i];
    if (field.length < 4) continue;
    if (files.length >= MAX_LIST) {
      truncated = true;
      break;
    }
    const status = field.slice(0, 2);
    const entry = { path: field.slice(3), status, kind: "other", sha256: null };
    if (status.includes("R") || status.includes("C")) entry.from = fields[++i];
    Object.assign(entry, await digestOf(workspace, realWorkspace, entry.path, hashing));
    files.push(entry);
  }
  return { files, truncated };
}
function errorCode(error) {
  return error.code ?? String(error).slice(0, 100);
}
async function digestOf(workspace, realWorkspace, relative, hashing) {
  let abs;
  try {
    abs = jail(workspace, relative);
  } catch {
    return { kind: "off_limits", sha256: null };
  }
  const parent = import_node_path22.default.dirname(abs);
  let realParent;
  try {
    realParent = await (0, import_promises13.realpath)(parent);
  } catch (error) {
    const code = errorCode(error);
    if (code === "ENOENT" || code === "ENOTDIR") return { kind: "deleted", sha256: null };
    return { kind: "other", sha256: null, reason: `parent unreadable: ${code}` };
  }
  const resolved = import_node_path22.default.relative(realWorkspace, realParent);
  if (resolved !== import_node_path22.default.relative(workspace, parent)) {
    return resolved.startsWith("..") || import_node_path22.default.isAbsolute(resolved) ? { kind: "off_limits", sha256: null, reason: "under a symlinked directory that leads out of the workspace" } : { kind: "symlink", sha256: null, reason: "under a symlinked directory" };
  }
  let info;
  try {
    info = await (0, import_promises13.lstat)(abs);
  } catch (error) {
    const code = errorCode(error);
    if (code === "ENOENT") return { kind: "deleted", sha256: null };
    return { kind: "other", sha256: null, reason: `unreadable: ${code}` };
  }
  if (info.isSymbolicLink()) return { kind: "symlink", sha256: null };
  if (!info.isFile()) return { kind: "other", sha256: null };
  if (info.size > hashing.maxBytes) {
    return { kind: "file", sha256: null, reason: `larger than ${hashing.maxBytes} bytes` };
  }
  if (hashing.outOfTime()) return { kind: "file", sha256: null, reason: "time budget for digests spent" };
  try {
    const hash = (0, import_node_crypto7.createHash)("sha256");
    for await (const chunk of (0, import_node_fs11.createReadStream)(abs)) hash.update(chunk);
    return { kind: "file", sha256: hash.digest("hex") };
  } catch (error) {
    return { kind: "file", sha256: null, reason: `unreadable: ${errorCode(error)}` };
  }
}
var MAX_COMMIT_PATHS = 200;
async function commitPaths(workspace, value) {
  if (!Array.isArray(value) || value.length < 1 || value.length > MAX_COMMIT_PATHS || !value.every((p) => typeof p === "string" && p.length > 0)) {
    throw new ToolError(`argument "paths" must be an array of 1 to ${MAX_COMMIT_PATHS} non-empty strings`);
  }
  const realWorkspace = await (0, import_promises13.realpath)(workspace);
  const out = /* @__PURE__ */ new Set();
  for (const relative of value) {
    if (import_node_path22.default.isAbsolute(relative) || /^[\\/]/.test(relative) || /^[A-Za-z]:/.test(relative)) {
      throw new ToolError(`path must be repo-relative, not absolute: ${relative}`);
    }
    const abs = jailForWrite(workspace, relative);
    const info = await (0, import_promises13.lstat)(abs).catch(() => null);
    if (info?.isSymbolicLink()) throw new ToolError(`path is a symlink: ${relative}`);
    if (info?.isDirectory()) throw new ToolError(`path is a directory, not a file: ${relative}`);
    let existing = info ? abs : import_node_path22.default.dirname(abs);
    for (; ; ) {
      const found = await (0, import_promises13.lstat)(existing).then(() => true, () => false);
      if (found || import_node_path22.default.dirname(existing) === existing) break;
      existing = import_node_path22.default.dirname(existing);
    }
    const real = await (0, import_promises13.realpath)(existing).catch(() => null);
    if (real === null || import_node_path22.default.relative(realWorkspace, real) !== import_node_path22.default.relative(workspace, existing)) {
      throw new ToolError(
        `path does not resolve to itself (it is under a symlinked directory, or differs in case): ${relative}`
      );
    }
    out.add(import_node_path22.default.relative(workspace, abs).split(import_node_path22.default.sep).join("/"));
  }
  return [...out];
}
function makeRedactor(env) {
  const values = Object.entries(env).filter(([k, v]) => v && v.length >= 8 && isSecretish(k)).map(([, v]) => v).sort((a, b) => b.length - a.length);
  if (values.length === 0) return (t) => t;
  const pattern = new RegExp(values.map((v) => v.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|"), "g");
  return (text2) => text2.replace(pattern, "[redacted]");
}
function isSecretish(key) {
  if (ALWAYS_MASK_KEYS.has(key)) return true;
  if (SAFE_ENV_KEYS.has(key)) return false;
  return !/^(GITHUB|RUNNER|ACTIONS|INPUT|CI)_/.test(key);
}
var ALWAYS_MASK_KEYS = /* @__PURE__ */ new Set([
  "ACTIONS_ID_TOKEN_REQUEST_TOKEN",
  "ACTIONS_RUNTIME_TOKEN",
  "GITHUB_TOKEN",
  // The `github-token` input. main.ts removes it before anything spawns; this
  // is the backstop should it ever reach an environment the redactor reads.
  "INPUT_GITHUB-TOKEN",
  // GitLab's `CI_` variables are exempt by prefix like GitHub's, except the
  // ones that are credentials: the job token (and the clone URL it is in),
  // the legacy job JWTs, and the registry, deploy and proxy passwords.
  "CI_JOB_TOKEN",
  "CI_REPOSITORY_URL",
  "CI_JOB_JWT",
  "CI_JOB_JWT_V1",
  "CI_JOB_JWT_V2",
  "CI_REGISTRY_PASSWORD",
  "CI_DEPLOY_PASSWORD",
  "CI_DEPENDENCY_PROXY_PASSWORD"
]);
var SAFE_ENV_KEYS = /* @__PURE__ */ new Set(["PATH", "HOME", "PWD", "SHELL", "LANG", "TERM", "NODE_OPTIONS", "CI", "BASE_URL", "PEEPS_API_URL", "PEEPS_PREVIEW_URL"]);
function createToolServer(env, deps = {}) {
  const workspace = env.workspace;
  const redact = makeRedactor(process.env);
  let testEnv = {};
  const runGit = (args, options = {}) => execFileAsync3("git", ["-c", `safe.directory=${workspace}`, ...args], {
    cwd: workspace,
    ...options
  });
  const commitUnderTest = runGit(["rev-parse", "HEAD"]).then(
    (r) => r.stdout.trim() || null,
    () => null
  );
  const handlers = {
    async read_file(args) {
      const abs = jail(workspace, str2(args, "path"));
      const info = await (0, import_promises13.stat)(abs);
      if (!info.isFile()) throw new ToolError("not a file");
      if (info.size > MAX_FILE_BYTES) throw new ToolError(`file is ${info.size} bytes; limit ${MAX_FILE_BYTES}`);
      return { path: str2(args, "path"), content: redact(await (0, import_promises13.readFile)(abs, "utf8")) };
    },
    async list_files(args) {
      const dir = jail(workspace, str2(args, "path", false) || ".");
      const out = [];
      const walk3 = async (d, rel, depth) => {
        if (out.length >= MAX_LIST || depth > 12) return;
        let entries;
        try {
          entries = await (0, import_promises13.readdir)(d, { withFileTypes: true });
        } catch {
          return;
        }
        for (const e of entries) {
          if (DENY_SEGMENTS.has(e.name) || e.name.startsWith(".env")) continue;
          const r = rel ? `${rel}/${e.name}` : e.name;
          if (e.isDirectory()) await walk3(import_node_path22.default.join(d, e.name), r, depth + 1);
          else if (e.isFile()) {
            out.push(r);
            if (out.length >= MAX_LIST) return;
          }
        }
      };
      await walk3(dir, str2(args, "path", false).replace(/^\.\/?$/, ""), 0);
      return { files: out.sort(), truncated: out.length >= MAX_LIST };
    },
    async grep(args) {
      const source = str2(args, "pattern");
      if (source.length > MAX_PATTERN_CHARS) {
        throw new ToolError(`pattern is longer than ${MAX_PATTERN_CHARS} characters`);
      }
      let pattern;
      try {
        pattern = new RegExp(source, args.ignoreCase ? "i" : "");
      } catch (error) {
        throw new ToolError(`pattern is not a valid regular expression: ${String(error).slice(0, 200)}`);
      }
      const matches = [];
      const listed = await handlers.list_files({ path: str2(args, "path", false) || "." });
      for (const rel of listed.files) {
        if (matches.length >= MAX_GREP_MATCHES) break;
        if (!GREP_FILE.test(rel)) continue;
        let text2;
        try {
          text2 = await (0, import_promises13.readFile)(jail(workspace, rel), "utf8");
        } catch {
          continue;
        }
        const lines = text2.split("\n");
        for (let i = 0; i < lines.length && matches.length < MAX_GREP_MATCHES; i++) {
          if (pattern.test(lines[i])) matches.push({ path: redact(rel), line: i + 1, text: redact(lines[i].slice(0, 300)) });
        }
      }
      return { matches, truncated: matches.length >= MAX_GREP_MATCHES };
    },
    async write_file(args) {
      const rel = str2(args, "path");
      const abs = jailForWrite(workspace, rel);
      const content = str2(args, "content");
      if (content.length > MAX_FILE_BYTES) throw new ToolError("content too large");
      await ensureParentDirInside(workspace, abs);
      await (0, import_promises13.writeFile)(abs, content, "utf8");
      return { path: rel, bytes: Buffer.byteLength(content) };
    },
    async apply_patch(args) {
      const patch = str2(args, "patch");
      const dir = await (0, import_promises13.mkdtemp)(import_node_path22.default.join((0, import_node_os8.tmpdir)(), "peeps-patch-"));
      const file = import_node_path22.default.join(dir, "change.patch");
      await (0, import_promises13.writeFile)(file, patch.endsWith("\n") ? patch : `${patch}
`, "utf8");
      for (const touched of await patchPaths(runGit, file)) {
        jailForWrite(workspace, touched);
      }
      try {
        await runGit(["apply", "--recount", "--whitespace=nowarn", file]);
      } catch (error) {
        const e = error;
        throw new ToolError(`git apply failed: ${redact((e.stderr ?? e.message).slice(0, 2e3))}`);
      }
      const { stdout } = await runGit(["status", "--porcelain"]);
      return {
        applied: true,
        changedFiles: stdout.trim().split("\n").filter(Boolean).map(redact)
      };
    },
    async run_tests(args) {
      const file = str2(args, "file");
      if (resolveFramework(env) === "pytest") {
        const ran = await runPytestTool(env, {
          fileAbs: jail(workspace, file),
          titlePath: typeof args.test === "string" && args.test ? args.test : null,
          keyword: typeof args.grep === "string" && args.grep ? args.grep : null,
          browser: typeof args.project === "string" && args.project ? args.project : null,
          extraEnv: testEnv,
          hook: async (scratchDir) => {
            const sha = await commitUnderTest;
            if (!sha) return { kind: "none" };
            const listed = await runGit(["ls-tree", sha, "--", RUN_TESTS_HOOK]);
            if (!listed.stdout.startsWith("100755 blob ")) return { kind: "none" };
            try {
              await runGit(["diff", "--quiet", sha, "--", ".peeps"]);
              const untracked = await runGit(["ls-files", "--others", "--", ".peeps"]);
              if (untracked.stdout.trim() !== "") return { kind: "changed" };
            } catch {
              return { kind: "changed" };
            }
            const archive = import_node_path22.default.join(scratchDir, "peeps.tar");
            const copy = import_node_path22.default.join(scratchDir, "hook");
            await (0, import_promises13.mkdir)(copy);
            await runGit(["archive", "--format=tar", "-o", archive, sha, ".peeps"]);
            await execFileAsync3("tar", ["-xf", archive, "-C", copy]);
            return { kind: "ready", path: import_node_path22.default.join(copy, RUN_TESTS_HOOK) };
          }
        });
        return {
          ...ran,
          // Redacted whole, then cut, so no secret is split past the redactor.
          pendingNote: ran.pendingNote === null ? null : redact(ran.pendingNote).slice(0, 500),
          results: ran.results?.map((r) => {
            const title = redact(r.title);
            const file2 = redact(r.file);
            return {
              ...r,
              title,
              ...title === r.title ? {} : { titleRedacted: true },
              file: file2,
              ...file2 === r.file ? {} : { fileRedacted: true },
              ...r.error ? { error: redact(r.error) } : {},
              ...r.httpExchanges ? { httpExchanges: redactHttpCalls(r.httpExchanges, redact) } : {}
            };
          }) ?? null,
          outputTail: redact(ran.outputTail)
        };
      }
      const abs = jail(workspace, file);
      if (resolveFramework(env) === "appium") {
        return runAppiumTests(
          env,
          { file: abs, grep: typeof args.grep === "string" && args.grep ? args.grep : void 0, extraEnv: testEnv },
          { redact, runner: deps.appiumRunner }
        );
      }
      const rel = import_node_path22.default.relative(env.workingDirectory, abs).split(import_node_path22.default.sep).join("/");
      const project = typeof args.project === "string" && args.project ? args.project : null;
      let owners = [];
      if (project) {
        const graph = await projectGraph(env, runCapture, testEnv, redact);
        if (!Array.isArray(graph)) throw new ToolError(`project_graph_unavailable: ${graph.unavailable}`);
        owners = teardownOwners(graph, project);
      }
      const cmd = ["playwright", "test", "--reporter=json"];
      if (owners.length === 0 && typeof args.grep === "string" && args.grep) cmd.push("--grep", args.grep);
      for (const p of owners.length > 0 ? owners : project ? [project] : []) cmd.push("--project", p);
      if (env.configPath) cmd.push("--config", env.configPath);
      if (owners.length === 0) cmd.push("--", rel);
      const started = Date.now();
      const target = await jsonReportTarget();
      let run;
      let report = null;
      try {
        run = await runCapture("npx", cmd, env.workingDirectory, 10 * 60 * 1e3, { ...testEnv, ...target.env });
        report = await target.read(run.stdout);
      } finally {
        await target.cleanup();
      }
      const { code, stdout, stderr } = run;
      return {
        exitCode: code,
        durationMs: Date.now() - started,
        results: await playwrightResults(report, env, redact),
        stderr: redact(stderr.slice(-8e3)),
        stdoutTail: report ? void 0 : redact(stdout.slice(-4e3)),
        // Says the run was wider than asked, and why, so the results of the
        // owner's tests are not read as the target's.
        ...owners.length > 0 ? { ranUnder: { projects: owners.map(redact), reason: "teardown" } } : {}
      };
    },
    async git_status() {
      const { stdout } = await runGit(["status", "--porcelain"]);
      const changedFiles = stdout.trim().split("\n").filter(Boolean).map(redact);
      let digests;
      try {
        digests = await changedFilesWithDigests(workspace, runGit);
      } catch (error) {
        const e = error;
        return { changedFiles, filesTruncated: true, filesError: redact(String(e.message ?? error).slice(0, 300)) };
      }
      return {
        changedFiles,
        files: digests.files.map((f) => ({
          ...f,
          path: redact(f.path),
          ...f.from === void 0 ? {} : { from: redact(f.from) }
        })),
        filesTruncated: digests.truncated
      };
    },
    async git_diff() {
      const { stdout } = await runGit(["diff"], { maxBuffer: 8 * 1024 * 1024 });
      return { diff: redact(stdout.slice(0, MAX_FILE_BYTES)) };
    },
    async git_commit_push(args) {
      const branch = str2(args, "branch");
      const message = str2(args, "message");
      const token = str2(args, "token");
      if (!branch.startsWith("peeps/")) throw new ToolError("branch must start with peeps/");
      await commitUnderTest;
      const paths = args.paths === void 0 ? null : await commitPaths(workspace, args.paths);
      const remote = await runGit(["remote", "get-url", "origin"]);
      const url = authenticatedPushUrl(remote.stdout, token, env.platform);
      const git = (...a) => runGit(a);
      const lit = (...a) => runGit(["--literal-pathspecs", ...a], { maxBuffer: 8 * 1024 * 1024 });
      const gitSaid = (error) => {
        const e = error;
        return redact(maskUrlCredentials(`${e.stderr ?? ""}${e.stdout ?? ""}`.trim())).slice(-500);
      };
      let skippedPaths = [];
      let stage = [];
      let add = [];
      if (paths !== null) {
        try {
          const tracked = new Set(
            (await lit("ls-files", "-z", "--with-tree=HEAD", "--", ...paths)).stdout.split("\0").filter(Boolean)
          );
          const present = await Promise.all(
            paths.map((p) => (0, import_promises13.lstat)(import_node_path22.default.join(workspace, p)).then(() => true, () => false))
          );
          const indexed = new Set(
            (await lit("ls-files", "-z", "--", ...paths)).stdout.split("\0").filter(Boolean)
          );
          stage = paths.filter((p, i) => present[i] || tracked.has(p));
          add = paths.filter((p, i) => present[i] || indexed.has(p));
          skippedPaths = paths.filter((p) => !stage.includes(p));
          if (stage.length > 0) {
            const ignored = (await lit("ls-files", "-z", "--others", "--ignored", "--exclude-standard", "--", ...stage)).stdout.split("\0").filter(Boolean);
            if (ignored.length > 0) {
              throw new ToolError(`path is not committed because it is ignored by .gitignore: ${ignored.slice(0, 10).map(redact).join(", ")}`);
            }
          }
        } catch (error) {
          if (error instanceof ToolError) throw error;
          throw new ToolError(`could not read the listed paths' state: ${gitSaid(error)}`);
        }
        if (stage.length === 0) {
          throw new ToolError(`nothing to commit? none of the listed paths exists or is tracked: ${skippedPaths.slice(0, 10).map(redact).join(", ")}`);
        }
      }
      await git("config", "user.name", "peeps[bot]");
      await git(
        "config",
        "user.email",
        env.platform === "gitlab" ? "peeps-bot@noreply.peepsai.com" : "peeps[bot]@users.noreply.github.com"
      );
      await git("checkout", "-B", branch);
      let commit;
      if (paths === null) {
        await git("add", "-A", "--", ".", ":(exclude,glob)**/.peeps-*.wdio.conf.*");
        commit = await git("commit", "-m", message).catch((e) => {
          throw new ToolError(`nothing to commit? ${redact((e.stderr ?? "").slice(0, 500))}`);
        });
      } else {
        const unstage = (extra = []) => lit("reset", "-q", "--", ...stage, ...extra).catch(() => void 0);
        const base = (await git("rev-parse", "HEAD")).stdout.trim();
        try {
          if (add.length > 0) await lit("add", "-A", "--", ...add);
          commit = await lit("commit", "-m", message, "--only", "--", ...stage);
        } catch (error) {
          await unstage();
          const said = gitSaid(error);
          if (/did not match/.test(said)) {
            throw new ToolError(
              `a listed path did not match a file git knows (a different case, or a file in a nested repository): ${said}`
            );
          }
          if (/nothing to commit|nothing added to commit|no changes added to commit/.test(said)) {
            throw new ToolError(`nothing to commit? ${said}`);
          }
          throw new ToolError(
            `git commit refused: ${said || "no output from git or a commit hook (a hook such as pre-commit may have failed)"}`
          );
        }
        const listed = new Set(stage);
        let contains = null;
        let oneCommit = false;
        try {
          oneCommit = (await git("rev-parse", "HEAD~1")).stdout.trim() === base;
          contains = await commitContents(base);
        } catch {
        }
        const unlisted = (contains ?? []).filter((p) => !listed.has(p));
        if (contains === null || unlisted.length > 0 || !oneCommit) {
          await git("reset", "-q", "--soft", base).catch(() => void 0);
          await unstage(unlisted);
          if (contains === null) {
            throw new ToolError("the commit could not be listed, so it is not pushed; the commit was undone");
          }
          if (unlisted.length > 0) {
            throw new ToolError(
              `the commit holds paths that were not listed: ${unlisted.slice(0, 10).map(redact).join(", ")}${unlisted.length > 10 ? ` and ${unlisted.length - 10} more` : ""} (a commit hook staged or committed them, or a listed file replaced a folder); nothing was pushed`
            );
          }
          throw new ToolError("a commit hook made another commit after this one; both were undone and nothing was pushed");
        }
      }
      let committed = [];
      let committedPathsTruncated = false;
      try {
        committed = await commitContents();
      } catch {
        committedPathsTruncated = true;
      }
      if (committed.length > MAX_COMMIT_PATHS) committedPathsTruncated = true;
      await git(
        "-c",
        "http.extraheader=",
        "-c",
        "http.https://github.com/.extraheader=",
        "push",
        "--force",
        url,
        `HEAD:refs/heads/${branch}`
      ).catch((e) => {
        const stderr = maskUrlCredentials((e.stderr ?? e.message ?? "").replaceAll(token, "***"));
        throw new ToolError(`git push refused: ${stderr.slice(-600)}`);
      });
      const sha = (await git("rev-parse", "HEAD")).stdout.trim();
      return {
        branch,
        sha,
        summary: redact(commit.stdout.split("\n")[0] ?? ""),
        committedPaths: committed.slice(0, MAX_COMMIT_PATHS).map(redact),
        ...committedPathsTruncated ? { committedPathsTruncated: true } : {},
        ...paths === null ? {} : { skippedPaths: skippedPaths.map(redact) }
      };
    }
  };
  async function commitContents(since) {
    const prefix = (await runGit(["rev-parse", "--show-prefix"])).stdout.trim().replace(/\/+$/, "");
    const { stdout } = await runGit(
      since ? ["diff", "--name-only", "--no-renames", "-z", since, "HEAD"] : ["diff-tree", "-r", "--no-commit-id", "--name-only", "-z", "--root", "HEAD"],
      { maxBuffer: 8 * 1024 * 1024 }
    );
    return stdout.split("\0").filter(Boolean).map((p) => prefix ? import_node_path22.default.posix.relative(prefix, p) : p);
  }
  const specs = [
    { name: "read_file", description: "Read a file in the repository (repo-relative path). Up to 512 KB.", inputSchema: obj2({ path: s("Repo-relative path") }, ["path"]) },
    { name: "list_files", description: "List files under a repository directory, recursively.", inputSchema: obj2({ path: s("Repo-relative directory; default the repository root") }, []) },
    { name: "grep", description: "Search source files for a regular expression; returns matching lines.", inputSchema: obj2({ pattern: s("JavaScript regular expression"), path: s("Repo-relative directory to search; default the root"), ignoreCase: { type: "boolean" } }, ["pattern"]) },
    { name: "write_file", description: "Replace a file's contents (repo-relative path). Creates the file if missing.", inputSchema: obj2({ path: s("Repo-relative path"), content: s("Full new contents") }, ["path", "content"]) },
    { name: "apply_patch", description: "Apply a unified diff to the repository with git apply.", inputSchema: obj2({ patch: s("Unified diff text") }, ["patch"]) },
    { name: "run_tests", description: "Run one test file with the repository's own config: a Playwright spec; in a pytest suite a test module (through the repository's .peeps/run-tests hook when it has one); in an Appium suite a WebdriverIO spec. Optionally narrow it: Playwright and Appium by grep (a regular expression over the test's full title), Playwright also by project; pytest by test (the title path, e.g. TestClass \u203A test_name[param]) or grep (a pytest -k expression). Returns per-test results and errors; a failing Playwright test also carries what it printed (output), a failing pytest test the HTTP calls it made through requests or httpx (httpExchanges, the last one usually the failing call), and a failing Appium test its evidence paths and page source.", inputSchema: obj2({ file: s("Repo-relative spec or test module path"), grep: s("Optional filter: Playwright or Appium --grep regular expression, or pytest -k expression"), project: s("Optional Playwright project name (ignored for Appium)"), test: s("Optional pytest title path of one test, scopes joined by ' \u203A '") }, ["file"]) },
    { name: "git_status", description: "Files changed in the working tree: git's porcelain lines, and each changed file with its kind and the sha256 of its bytes.", inputSchema: obj2({}, []) },
    { name: "git_diff", description: "Unified diff of the working tree against HEAD.", inputSchema: obj2({}, []) },
    { name: "git_commit_push", description: "Commit on a new peeps/* branch and push it, using the token Peeps provides for this call: every change, or with `paths` only those files. Returns the paths the commit contains.", inputSchema: obj2({ branch: s("Branch name starting with peeps/"), message: s("Commit message"), token: s("The token Peeps minted for this push"), paths: { type: "array", items: { type: "string" }, minItems: 1, maxItems: MAX_COMMIT_PATHS, description: "Optional. Repo-relative paths to commit; nothing else is staged or committed. Omit to commit every change." } }, ["branch", "message", "token"]) }
  ];
  return {
    specs,
    handlers,
    setTestEnv: (vars) => {
      testEnv = vars;
    }
  };
}
function obj2(properties, required) {
  return { type: "object", properties, required, additionalProperties: false };
}
function s(description) {
  return { type: "string", description };
}
var ERROR_CONTEXT_MAX_BYTES = 16 * 1024;
var ERROR_CONTEXT_MAX_READ_BYTES = 1024 * 1024;
var ERROR_CONTEXT_TOTAL_BYTES = 128 * 1024;
var RUN_TESTS_RESULT_MAX_BYTES = 400 * 1024;
function jsonBytes(value) {
  return Buffer.byteLength(JSON.stringify(value));
}
async function readErrorContext(file, redact, allowedRoots) {
  if (import_node_path22.default.basename(file) !== "error-context.md") return null;
  let handle;
  try {
    if (!(await (0, import_promises13.lstat)(file)).isFile()) return null;
    const real = await (0, import_promises13.realpath)(file);
    const roots = await Promise.all(allowedRoots.map((r) => (0, import_promises13.realpath)(r).catch(() => null)));
    const inside = roots.some((root) => {
      if (root === null) return false;
      const rel = import_node_path22.default.relative(root, real);
      return rel !== "" && !rel.startsWith("..") && !import_node_path22.default.isAbsolute(rel);
    });
    if (!inside) return null;
    handle = await (0, import_promises13.open)(file, import_node_fs11.constants.O_RDONLY | import_node_fs11.constants.O_NOFOLLOW);
    const info = await handle.stat();
    if (!info.isFile()) return null;
    if (info.size > ERROR_CONTEXT_MAX_READ_BYTES) return "too_large";
    const raw = await handle.readFile();
    if (raw.length > ERROR_CONTEXT_MAX_READ_BYTES) return "too_large";
    let text2 = raw.toString("utf8");
    if (text2.startsWith("# Instructions\n")) {
      const next = text2.indexOf("\n# ");
      if (next === -1) return null;
      text2 = text2.slice(next + 1);
    }
    const bytes = Buffer.from(redact(text2), "utf8");
    if (bytes.length <= ERROR_CONTEXT_MAX_BYTES) return { text: bytes.toString("utf8"), truncated: false };
    let end = ERROR_CONTEXT_MAX_BYTES;
    while (end > 0 && (bytes[end] & 192) === 128) end--;
    return { text: bytes.subarray(0, end).toString("utf8"), truncated: true };
  } catch {
    return null;
  } finally {
    await handle?.close();
  }
}
async function playwrightResults(report, env, redact) {
  const summaries = summarizeReport(report);
  if (summaries === null) return null;
  const config = report.config;
  const rootDir = config?.rootDir;
  const outputDirs = (config?.projects ?? []).flatMap((p) => typeof p.outputDir === "string" ? [p.outputDir] : []);
  const allowedRoots = [env.workspace, ...outputDirs];
  const real = (p) => (0, import_promises13.realpath)(p).catch(() => p);
  const workspace = await real(env.workspace);
  let budget = ERROR_CONTEXT_TOTAL_BYTES;
  const results = [];
  for (const { test, specFile, errorContextPath } of summaries) {
    let file = null;
    if (typeof rootDir === "string" && specFile !== "") {
      const rel = import_node_path22.default.relative(workspace, await real(import_node_path22.default.resolve(rootDir, specFile)));
      if (rel !== "" && !rel.startsWith("..") && !import_node_path22.default.isAbsolute(rel)) file = rel.split(import_node_path22.default.sep).join("/");
    }
    let evidence = {};
    if (errorContextPath !== null) {
      const read = budget > 0 ? await readErrorContext(errorContextPath, redact, allowedRoots) : null;
      if (read === "too_large") {
        evidence = { errorContextOmitted: true };
      } else if (read !== null && jsonBytes(read.text) <= budget) {
        budget -= jsonBytes(read.text);
        evidence = { errorContext: read.text, errorContextTruncated: read.truncated };
      } else if (read !== null || budget <= 0) {
        budget = 0;
        evidence = { errorContextOmitted: true };
      }
    }
    const title = redact(test.title);
    results.push({
      ...test,
      // Redacted whole, then cut, so no secret is split past the redactor.
      title,
      ...title === test.title ? {} : { titleRedacted: true },
      error: test.error === void 0 ? void 0 : redact(test.error).slice(0, 2e3),
      errorSnippet: test.errorSnippet === void 0 ? void 0 : redact(test.errorSnippet).slice(0, 2e3),
      ...test.output === void 0 ? {} : { output: redact(test.output).slice(-TEST_OUTPUT_MAX_CHARS) },
      ...file === null ? {} : { file: redact(file), ...redact(file) === file ? {} : { fileRedacted: true } },
      ...evidence
    });
  }
  let size = jsonBytes(results);
  for (let i = results.length - 1; i >= 0 && size > RUN_TESTS_RESULT_MAX_BYTES; i--) {
    const r = results[i];
    if (r.errorContext === void 0) continue;
    const { errorContext: _dropped, errorContextTruncated: _cut, ...rest } = r;
    results[i] = { ...rest, errorContextOmitted: true };
    size = jsonBytes(results);
  }
  for (let i = results.length - 1; i >= 0 && size > RUN_TESTS_RESULT_MAX_BYTES; i--) {
    if (results[i].output === void 0) continue;
    const { output: _dropped, ...rest } = results[i];
    results[i] = rest;
    size = jsonBytes(results);
  }
  return results;
}
var TEST_OUTPUT_MAX_CHARS = 4e3;
function printed(stdout) {
  const text2 = (stdout ?? []).map((chunk) => chunk.text ?? (chunk.buffer ? Buffer.from(chunk.buffer, "base64").toString("utf8") : "")).join("");
  return text2.trim() === "" ? void 0 : text2;
}
function summarizeReport(report) {
  if (!report || typeof report !== "object" || !("suites" in report)) return null;
  const tests = [];
  const walk3 = (suite, titles, isFile) => {
    const next = isFile ? titles : [...titles, suite.title];
    for (const spec of suite.specs ?? []) {
      const last = spec.tests?.[0]?.results?.at(-1);
      const failed = last !== void 0 && last.status !== "passed" && last.status !== "skipped";
      const context = failed ? last.attachments?.find((a) => a.name === "error-context" && typeof a.path === "string") : void 0;
      tests.push({
        specFile: typeof spec.file === "string" ? spec.file : "",
        errorContextPath: context?.path ?? null,
        test: {
          title: [...next, spec.title].join(" \u203A "),
          line: spec.line,
          status: last?.status ?? "unknown",
          // The final attempt's index (0 = no retry), so a pass after a retry
          // is not read as a clean one. Absent when Playwright ran no attempt.
          ...typeof last?.retry === "number" ? { retry: last.retry } : {},
          // Cut to 2000 in `playwrightResults`, after redaction.
          error: last?.error?.message,
          errorSnippet: last?.error?.snippet,
          // What a failing test printed: an API test's probe of the response
          // it got is the only way to see that response. Cut in
          // `playwrightResults`, after redaction.
          ...failed && printed(last?.stdout) !== void 0 ? { output: printed(last?.stdout) } : {}
        }
      });
    }
    for (const child of suite.suites ?? []) walk3(child, next, false);
  };
  for (const suite of report.suites) walk3(suite, [], true);
  return tests;
}
var GRAPH_MARKER = "peeps:project-graph:";
var PROJECT_GRAPH_REPORTER = `
class PeepsProjectGraph {
  printsToStdio() { return true; }
  onBegin(config) {
    const projects = config.projects.map((p) => ({ name: p.name, dependencies: p.dependencies || [], teardown: p.teardown || null }));
    process.stdout.write("\\n" + ${JSON.stringify(GRAPH_MARKER)} + JSON.stringify(projects) + "\\n");
  }
}
module.exports = PeepsProjectGraph;
`;
async function projectGraph(env, run = runCapture, extraEnv = {}, scrub = (text2) => text2) {
  let dir = null;
  const limitMs = 2 * 60 * 1e3;
  try {
    dir = await (0, import_promises13.mkdtemp)(import_node_path22.default.join((0, import_node_os8.tmpdir)(), "peeps-graph-"));
    const reporter = import_node_path22.default.join(dir, "graph-reporter.cjs");
    await (0, import_promises13.writeFile)(reporter, PROJECT_GRAPH_REPORTER);
    const cmd = ["playwright", "test", "--list", `--reporter=${reporter}`];
    if (env.configPath) cmd.push("--config", env.configPath);
    const started = Date.now();
    const { code, stdout, stderr } = await run("npx", cmd, env.workingDirectory, limitMs, extraEnv);
    const ended = Date.now() - started >= limitMs ? "timed out after 2 minutes" : `exit ${code}`;
    const why = (what) => ({
      unavailable: `${what} (\`playwright test --list\` ${ended}): ${scrub(stderr).trim().slice(-2e3)}`
    });
    const line = stdout.split("\n").find((l) => l.startsWith(GRAPH_MARKER));
    if (!line) return why("no project graph in the listing");
    let parsed;
    try {
      parsed = JSON.parse(line.slice(GRAPH_MARKER.length));
    } catch {
      return why("unreadable project graph");
    }
    if (!Array.isArray(parsed)) return why("unreadable project graph");
    return parsed.flatMap((p) => {
      if (typeof p !== "object" || p === null || typeof p.name !== "string") return [];
      const { name, dependencies, teardown } = p;
      return [{
        name,
        dependencies: Array.isArray(dependencies) ? dependencies.filter((d) => typeof d === "string") : [],
        teardown: typeof teardown === "string" ? teardown : null
      }];
    });
  } catch (error) {
    return { unavailable: `the listing did not start: ${scrub(String(error.message ?? error)).slice(0, 500)}` };
  } finally {
    if (dir) await (0, import_promises13.rm)(dir, { recursive: true, force: true }).catch(() => {
    });
  }
}
function teardownOwners(graph, project) {
  const ownersOf = (name) => graph.filter((p) => p.teardown === name).map((p) => p.name);
  const roots = /* @__PURE__ */ new Set();
  const seen = /* @__PURE__ */ new Set([project]);
  const visit = (name) => {
    for (const owner of ownersOf(name)) {
      if (seen.has(owner)) continue;
      seen.add(owner);
      if (ownersOf(owner).length > 0) visit(owner);
      else roots.add(owner);
    }
  };
  visit(project);
  return [...roots];
}
function runCapture(cmd, args, cwd, timeoutMs, extraEnv = {}) {
  return new Promise((resolve) => {
    const child = (0, import_node_child_process9.spawn)(cmd, args, { cwd, env: { ...process.env, CI: "1", ...extraEnv }, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
    child.stdout.on("data", (d) => stdout += d.toString());
    child.stderr.on("data", (d) => stderr += d.toString());
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code: code ?? 1, stdout, stderr });
    });
  });
}

// src/agent.ts
var execFileAsync4 = (0, import_node_util4.promisify)(import_node_child_process10.execFile);
function frameworkOf(env) {
  try {
    return resolveFramework(env);
  } catch (error) {
    return `unknown (${error instanceof Error ? error.message : String(error)})`;
  }
}
async function runAgent(env, peeps, options = {}) {
  if (!env.sessionId) throw new Error("`session-id` is required in agent mode (Peeps passes it)");
  const server = createToolServer(env);
  const framework = frameworkOf(env);
  let device = null;
  if (env.deviceTools) {
    if (framework === "appium") {
      device = createDeviceTools(env, { redact: makeRedactor(process.env), deps: options.deviceDeps });
    } else {
      console.log(`[peeps] device-tools is for Appium suites; this one is ${framework}, so no device tools are offered`);
    }
  }
  const specs = [...server.specs, ...device?.specs ?? []];
  const handlers = { ...server.handlers, ...device?.handlers ?? {} };
  const attach = await peeps.post(
    `/api/v1/bridge/sessions/${env.sessionId}/attach`,
    {
      tools: specs,
      runnerInfo: {
        ...await runnerInfoFor(env),
        framework,
        ...device ? { deviceTools: device.info() } : {}
      }
    }
  );
  const expiresAt = new Date(attach.expiresAt).getTime();
  console.log(`[peeps] agent session ${attach.sessionId} (${attach.kind}) attached; ${specs.length} tools; cap ${attach.expiresAt}`);
  const environment = planEnvironmentVariables(attachEnvironment(attach.environment), process.env);
  if (environment.log) console.log(environment.log);
  server.setTestEnv(environment.vars);
  const host = device;
  const onSignal = (signal) => {
    console.log(`[peeps] ${signal}: stopping what the session started`);
    void stopForSignal(host, signal).finally(() => process.exit(signal === "SIGINT" ? 130 : 143));
  };
  const handleSignals = options.handleSignals !== false;
  if (handleSignals) {
    process.once("SIGTERM", onSignal);
    process.once("SIGINT", onSignal);
  }
  host?.start(environment.vars);
  try {
    await serve(env, peeps, handlers, expiresAt, hideEnvironmentUrls(environment.vars));
  } finally {
    if (handleSignals) {
      process.off("SIGTERM", onSignal);
      process.off("SIGINT", onSignal);
    }
    await host?.close("agent session over");
  }
}
async function stopForSignal(device, signal) {
  await Promise.allSettled([stopAppiumRuns(), device?.close(signal)]);
}
async function serve(env, peeps, handlers, expiresAt, forLog) {
  let transportErrors = 0;
  let handled = 0;
  for (; ; ) {
    if (Date.now() > expiresAt) {
      console.log("[peeps] session cap reached; leaving");
      return;
    }
    let call;
    try {
      call = await peeps.getOrNull(`/api/v1/bridge/sessions/${env.sessionId}/calls?wait=25`).then((r) => r?.call ?? null);
      transportErrors = 0;
    } catch (error) {
      const message = String(error);
      if (message.includes("\u2192 410")) {
        console.log(`[peeps] session ended by Peeps after ${handled} call(s)`);
        return;
      }
      transportErrors += 1;
      console.log(`[peeps] poll failed (${transportErrors}): ${message.slice(0, 200)}`);
      if (transportErrors >= 8) throw new Error("lost contact with Peeps");
      await new Promise((r) => setTimeout(r, 2e3 * transportErrors));
      continue;
    }
    if (!call) continue;
    const started = Date.now();
    const handler = handlers[call.tool];
    let outcome;
    if (!handler) {
      outcome = { ok: false, error: `unknown tool ${call.tool}` };
    } else {
      try {
        outcome = { ok: true, result: await handler(call.args) };
      } catch (error) {
        outcome = { ok: false, error: error instanceof Error ? error.message : String(error) };
      }
    }
    handled += 1;
    console.log(
      `[peeps] #${call.seq} ${call.tool}(${summarizeArgs(call.args)}) \u2192 ${describeOutcome(outcome, forLog)} in ${Date.now() - started} ms`
    );
    try {
      await peeps.post(`/api/v1/bridge/sessions/${env.sessionId}/calls/${call.id}/result`, outcome);
    } catch (error) {
      console.log(`[peeps] could not deliver result for #${call.seq}: ${String(error).slice(0, 200)}`);
    }
  }
}
function attachEnvironment(value) {
  if (value === void 0 || value === null) return null;
  const { name, baseUrl } = value;
  if (typeof name === "string" && name && !name.includes("\0") && (baseUrl === null || typeof baseUrl === "string" && !baseUrl.includes("\0"))) {
    return { name, baseUrl };
  }
  throw new Error("Peeps named an environment this action cannot read; stopping before any test runs");
}
async function runnerInfoFor(env) {
  const info = {
    workingDirectory: env.workingDirectory,
    configPath: env.configPath,
    node: process.version,
    sha: env.sha,
    ref: env.ref,
    actionVersion: ACTION_VERSION,
    // What this runner's tools can do beyond the basics, so Peeps need not
    // infer it from the version. `commit_paths`: git_commit_push takes
    // `paths` and commits only those files (PQA-2695). On a Playwright job,
    // `result_files`: each run_tests result's `file` is the repo-relative spec
    // it came from (PQA-2733); `error_context`: a failed one carries
    // Playwright's error-context.md as `errorContext` (PQA-2737). `environment`:
    // run_tests applies the environment the attach answer names (PQA-3033),
    // as do Appium's run_tests and the device session's capabilities.
    capabilities: ["commit_paths", "environment", ...playwrightJob(env) ? ["result_files", "error_context"] : []]
  };
  try {
    const { stdout } = await execFileAsync4(
      "git",
      ["-c", `safe.directory=${env.workspace}`, "rev-parse", "--show-toplevel", "HEAD"],
      { cwd: env.workspace }
    );
    const [toplevel = "", sha = ""] = stdout.trim().split("\n");
    const [realTop, realWorkspace] = await Promise.all([(0, import_promises14.realpath)(toplevel), (0, import_promises14.realpath)(env.workspace)]);
    if (realTop === realWorkspace && /^[0-9a-f]{40}([0-9a-f]{24})?$/.test(sha)) info.checkoutSha = sha;
  } catch {
  }
  return info;
}
function describeOutcome(outcome, forLog = (text2) => text2) {
  if (!outcome.ok) return `error: ${forLog(outcome.error).slice(0, 120)}`;
  const result = outcome.result;
  if (result?.isError === true) {
    const first = result.content?.find((part) => part.type === "text")?.text;
    return `error: ${forLog(String(first ?? "")).slice(0, 120)}`;
  }
  return "ok";
}
function summarizeArgs(args) {
  return Object.entries(args).filter(([k]) => k !== "token" && k !== "content" && k !== "patch" && k !== "text").map(([k, v]) => `${k}=${JSON.stringify(v).slice(0, 60)}`).join(", ");
}
function playwrightJob(env) {
  try {
    return resolveFramework(env) === "playwright";
  } catch {
    return false;
  }
}

// src/attach.ts
var import_node_crypto8 = require("node:crypto");
var import_promises15 = require("node:fs/promises");
var import_node_os9 = require("node:os");
var import_node_path23 = __toESM(require("node:path"));
var import_node_url4 = require("node:url");
var ATTACH_STATE_FILE = "state.json";
var CONFIG_RECORD = "config-path";
async function exportVariables(vars) {
  const file = process.env.GITHUB_ENV;
  const lines = Object.entries(vars).map(([k, v]) => `${k}=${v}`).join("\n") + "\n";
  if (!file) {
    console.log(`[peeps] GITHUB_ENV is not set; export these yourself:
${lines}`);
    return;
  }
  await (0, import_promises15.appendFile)(file, lines);
}
function attachConfigSource(input2) {
  const load = !input2.original ? "const loaded = {};" : input2.esm ? `import * as loaded from ${JSON.stringify((0, import_node_url4.pathToFileURL)(input2.original).href)};` : `const loaded = await require(${JSON.stringify(input2.original)});`;
  const body = `
const config = await (loaded && typeof loaded === "object" && "default" in loaded ? loaded.default : loaded);
if (!config || typeof config !== "object") throw new Error("Playwright config must export a single object");
const reporters = config.reporter === undefined
  ? [[process.env.CI ? "dot" : "list"]]
  : typeof config.reporter === "string"
    ? [[config.reporter]]
    : config.reporter;
const withPeeps = {
  ...config,
  reporter: [...reporters, [${JSON.stringify(input2.reporterPath)}, { attachDir: ${JSON.stringify(input2.stateDir)} }]],
};
`;
  return input2.esm ? `import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
${load}
${body}
export default withPeeps;
` : `module.exports = (async () => {
${load}
${body}
return { default: withPeeps };
})();
`;
}
async function runAttachStart(env) {
  const stateDir = import_node_path23.default.join(process.env.RUNNER_TEMP ?? (0, import_node_os9.tmpdir)(), `peeps-attach-${(0, import_node_crypto8.randomUUID)()}`);
  await (0, import_promises15.mkdir)(stateDir, { recursive: true, mode: 448 });
  const { dir, file } = await configLocation(env);
  const esm = file ? await isModule(file) : false;
  const configPath = import_node_path23.default.join(dir, `.peeps-attach-${(0, import_node_crypto8.randomUUID)()}.config.${esm ? "mjs" : "cjs"}`);
  const reporterPath = import_node_path23.default.join(__dirname, "reporter.js");
  try {
    await (0, import_promises15.writeFile)(configPath, attachConfigSource({ original: file, esm, reporterPath, stateDir }), {
      flag: "wx",
      mode: 384
    });
  } catch (error) {
    if (error.code !== "EEXIST") await (0, import_promises15.unlink)(configPath).catch(() => {
    });
    throw error;
  }
  await (0, import_promises15.writeFile)(import_node_path23.default.join(stateDir, CONFIG_RECORD), configPath, { mode: 384 });
  await exportVariables({
    PEEPS_ATTACH_CONFIG: configPath,
    PEEPS_ATTACH_DIR: stateDir,
    PEEPS_API_URL: env.peepsUrl
  });
  console.log(`[peeps] attach: the run reports to Peeps when Playwright is given --config ${configPath}`);
}
async function runAttachFinish(_env, peeps) {
  const stateDir = process.env.PEEPS_ATTACH_DIR;
  if (!stateDir) {
    console.log("[peeps] attach: no PEEPS_ATTACH_DIR (attach-start did not run); nothing to finish");
    return;
  }
  const configPath = await (0, import_promises15.readFile)(import_node_path23.default.join(stateDir, CONFIG_RECORD), "utf8").catch(() => null);
  if (configPath) await (0, import_promises15.unlink)(configPath).catch(() => {
  });
  const raw = await (0, import_promises15.readFile)(import_node_path23.default.join(stateDir, ATTACH_STATE_FILE), "utf8").catch(() => null);
  if (!raw) {
    console.log("[peeps] attach: the run planned nothing with Peeps (no tests ran, or Peeps was unreachable)");
    return;
  }
  const state = JSON.parse(raw);
  for (const b of state.batches) {
    let reportUploaded = false;
    if (state.reportDir) {
      try {
        const uploaded = await uploadReport(peeps, b.batchId, state.reportDir);
        reportUploaded = uploaded > 0;
        console.log(`[peeps] uploaded ${uploaded} report file(s) for batch ${b.batchNumber}`);
      } catch (error) {
        console.log(`[peeps] report upload failed for batch ${b.batchId}: ${String(error)}`);
      }
    }
    try {
      await peeps.post(`/api/v1/ci/batches/${b.batchId}/complete`, { reportUploaded });
    } catch (error) {
      console.log(`[peeps] could not complete batch ${b.batchId}: ${String(error)}`);
    }
  }
}
var ATTACH_START_DEADLINE_MS = 6e4;
var ATTACH_FINISH_DEADLINE_MS = 8 * 6e4;
async function runAttachStep(step, deadlineMs) {
  let timer;
  const expired = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`gave up after ${deadlineMs / 1e3}s without an answer from Peeps`)), deadlineMs);
  });
  try {
    await Promise.race([step(), expired]);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.log(`::warning::Peeps could not report this run: ${message}`);
  } finally {
    clearTimeout(timer);
  }
}

// src/browser-check.ts
var import_node_child_process11 = require("node:child_process");
var import_node_fs12 = require("node:fs");
var import_node_util5 = require("node:util");
var execFileAsync5 = (0, import_node_util5.promisify)(import_node_child_process11.execFile);
var PROBE = `
const { createRequire } = require("node:module");
const path = require("node:path");
const from = (file) => createRequire(file);
const here = path.join(process.cwd(), "noop.js");
let pkg;
try {
  pkg = from(here).resolve("playwright-core/package.json");
} catch {
  const test = from(here).resolve("@playwright/test/package.json");
  const pw = from(test).resolve("playwright/package.json");
  pkg = from(pw).resolve("playwright-core/package.json");
}
const core = require(path.dirname(pkg));
const browsers = [];
for (const name of ["chromium", "firefox", "webkit"]) {
  try { browsers.push({ name, executablePath: core[name].executablePath() }); } catch {}
}
process.stdout.write(JSON.stringify({ version: require(pkg).version, browsers }));
`;
async function probePlaywright(workingDirectory, env = process.env) {
  try {
    const { stdout } = await execFileAsync5(process.execPath, ["-e", PROBE], {
      cwd: workingDirectory,
      env,
      timeout: 2e4
    });
    const parsed = JSON.parse(stdout);
    return typeof parsed.version === "string" && Array.isArray(parsed.browsers) ? parsed : null;
  } catch {
    return null;
  }
}
var BROWSER_DIR = /^(chromium|chromium_headless_shell|firefox|webkit)-\d+$/;
function installOf(executablePath) {
  const parts = executablePath.split(/[\\/]/);
  const at = parts.findIndex((p) => BROWSER_DIR.test(p));
  if (at < 0) return null;
  return { root: parts.slice(0, at).join("/") || "/", dir: parts[at] };
}
function listDir(dir) {
  try {
    return (0, import_node_fs12.readdirSync)(dir);
  } catch {
    return [];
  }
}
function missingBrowsersMessage(probe, fs) {
  if (probe.browsers.length === 0) return null;
  const list = fs.list ?? listDir;
  const installs = probe.browsers.map((b) => ({ ...b, install: installOf(b.executablePath) }));
  for (const b of installs) {
    if (fs.exists(b.executablePath)) return null;
    if (b.name === "chromium" && b.install) {
      const shell2 = b.install.dir.replace(/^chromium-/, "chromium_headless_shell-");
      if (fs.exists(`${b.install.root}/${shell2}`)) return null;
    }
  }
  const expected = installs.map((b) => b.install?.dir ?? b.name).join(", ");
  const root = installs.find((b) => b.install)?.install?.root;
  const found = root ? list(root).filter((d) => BROWSER_DIR.test(d)).sort() : [];
  const where = root ? found.length > 0 ? ` ${root} has ${found.join(", ")}.` : ` ${root} has no Playwright browsers.` : "";
  return `Playwright ${probe.version} is installed, but none of its browsers (${expected}) are on this runner.${where} Run the job in mcr.microsoft.com/playwright:v${probe.version}-jammy, the image for your @playwright/test version, or add \`npx playwright install --with-deps\` before the Peeps step. If your Playwright config launches a browser channel such as Chrome, you can ignore this.`;
}
async function warnIfBrowsersMissing(workingDirectory, platform) {
  const probe = await probePlaywright(workingDirectory);
  if (!probe) return;
  const message = missingBrowsersMessage(probe, { exists: import_node_fs12.existsSync });
  if (!message) return;
  console.log(platform === "github" ? `::warning title=Playwright browsers missing::${message}` : `[peeps] warning: ${message}`);
}

// src/preview.ts
var import_node_child_process12 = require("node:child_process");
var import_node_fs13 = require("node:fs");
var GITHUB_TOKEN_INPUT = "INPUT_GITHUB-TOKEN";
function takeGithubToken(env) {
  const token = env[GITHUB_TOKEN_INPUT]?.trim() || null;
  delete env[GITHUB_TOKEN_INPUT];
  return token;
}
function readPreviewRequest(env, githubToken) {
  const provider = env["INPUT_PREVIEW"]?.trim().toLowerCase();
  if (!provider) return null;
  if (provider !== "vercel") throw new Error(`preview: "${nameForLog(provider)}" is not supported (supported: vercel)`);
  if (env.GITHUB_EVENT_NAME === "pull_request_target") {
    throw new Error(
      "preview: vercel does not run on pull_request_target: that event has the base repository's secrets, and a fork's preview runs the fork's code. Use pull_request."
    );
  }
  if (env.GITHUB_EVENT_NAME !== "pull_request") return null;
  const repository = env.GITHUB_REPOSITORY;
  const head = pullRequestHead(env.GITHUB_EVENT_PATH);
  if (!head || !repository) throw new Error("preview: vercel needs a pull_request event with a head commit");
  if (head.repository && head.repository.toLowerCase() !== repository.toLowerCase()) {
    throw new Error(
      `preview: vercel tests previews of this repository's own branches; this pull request comes from ${nameForLog(head.repository)}.`
    );
  }
  if (!githubToken) throw new Error("preview: vercel needs the github-token input (it defaults to the job's GITHUB_TOKEN)");
  const timeoutS = Number(env["INPUT_PREVIEW-TIMEOUT"]?.trim() || "600");
  if (!Number.isFinite(timeoutS) || timeoutS <= 0) throw new Error("preview-timeout must be a positive number of seconds");
  return {
    provider: "vercel",
    repository,
    sha: head.sha,
    token: githubToken,
    timeoutMs: timeoutS * 1e3,
    apiUrl: (env.GITHUB_API_URL ?? "https://api.github.com").replace(/\/+$/, ""),
    project: env["INPUT_PREVIEW-PROJECT"]?.trim() || null
  };
}
function pullRequestHead(eventPath) {
  if (!eventPath) return null;
  try {
    const payload = JSON.parse((0, import_node_fs13.readFileSync)(eventPath, "utf8"));
    const head = payload.pull_request?.head;
    const sha = head?.sha;
    if (typeof sha !== "string" || !/^[0-9a-f]{40}$/.test(sha)) return null;
    const repository = head?.repo?.full_name;
    return { sha, repository: typeof repository === "string" ? repository : null };
  } catch {
    return null;
  }
}
var VERCEL_BOT = "vercel[bot]";
var PREVIEW_PREFIX = "Preview \u2013 ";
function isVercelContextFor(context, project) {
  if (project === null) return context === "Vercel" || context.startsWith("Vercel \u2013 ");
  return context === `Vercel \u2013 ${project}`;
}
function latestPerContext(statuses) {
  const seen = /* @__PURE__ */ new Set();
  return statuses.filter((s2) => seen.has(s2.context) ? false : (seen.add(s2.context), true));
}
function previewProject(d) {
  if (d.creator?.login !== VERCEL_BOT) return null;
  if (d.environment === "Preview") return "";
  return d.environment.startsWith(PREVIEW_PREFIX) ? d.environment.slice(PREVIEW_PREFIX.length) : null;
}
function previewUrl(raw) {
  if (!raw || raw.includes("@")) return null;
  try {
    return new URL(raw).protocol === "https:" ? raw : null;
  } catch {
    return null;
  }
}
function verdictOf(statuses) {
  const latest = statuses[0];
  if (!latest) return { kind: "pending" };
  const success = latest.state === "success" || latest.state === "inactive" ? statuses.find((s2) => s2.state === "success") : void 0;
  if (success) {
    const raw = success.environment_url || success.target_url;
    const url = previewUrl(raw);
    return url ? { kind: "ready", url } : { kind: "failed", detail: `has no https URL to test: ${urlForLog(raw ?? "")}` };
  }
  if (latest.state === "failure" || latest.state === "error") {
    return { kind: "failed", detail: `failed: ${urlForLog(latest.target_url ?? "")}` };
  }
  return { kind: "pending" };
}
async function waitForVercelPreview(request, deps = {}) {
  const doFetch = deps.fetch ?? fetch;
  const sleep3 = deps.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  const now = deps.now ?? Date.now;
  const pollMs = deps.pollMs ?? 1e4;
  const short = request.sha.slice(0, 7);
  const github = async (path24) => {
    const res = await doFetch(`${request.apiUrl}/repos/${request.repository}${path24}`, {
      headers: {
        authorization: `Bearer ${request.token}`,
        accept: "application/vnd.github+json",
        "x-github-api-version": "2022-11-28"
      }
    });
    if ((res.status === 403 || res.status === 429) && (res.headers.get("x-ratelimit-remaining") === "0" || res.headers.has("retry-after"))) {
      throw new Error(`GitHub's API rate limit ran out while waiting for the Vercel preview of ${short}`);
    }
    if (res.status === 403 || res.status === 404) {
      throw new Error(
        `GitHub refused ${path24} (${res.status}). Give the job \`deployments: read\` and \`statuses: read\` in its permissions.`
      );
    }
    if (!res.ok) throw new Error(`GitHub ${path24}: ${res.status} ${nameForLog((await res.text()).slice(0, 300))}`);
    return await res.json();
  };
  const deadline = now() + request.timeoutMs;
  for (; ; ) {
    const all = await github(`/deployments?sha=${request.sha}&per_page=100`);
    const previews = all.map((d) => ({ d, project: previewProject(d) })).filter((p) => p.project !== null);
    const projects = [...new Set(previews.map((p) => p.project))];
    if (request.project === null && projects.length > 1) {
      throw new Error(
        `This commit has Vercel previews of ${projects.length} projects (${projects.map((p) => nameForLog(p) || "Preview").join(", ")}). Name the one to test with preview-project.`
      );
    }
    const candidates = previews.filter((p) => request.project === null || p.project === request.project).sort((a, b) => b.d.id - a.d.id);
    const failures = [];
    for (const { d } of candidates) {
      const verdict = verdictOf(await github(`/deployments/${d.id}/statuses?per_page=20`));
      if (verdict.kind === "ready") {
        if (request.project === null) {
          const statuses = latestPerContext(
            await github(`/commits/${request.sha}/statuses?per_page=100`)
          );
          const own = previewProject(d);
          const building = statuses.filter(
            (s2) => s2.state === "pending" && isVercelContextFor(s2.context, null) && s2.context !== (own ? `Vercel \u2013 ${own}` : "Vercel")
          );
          if (building.length > 0) {
            throw new Error(
              `This commit has Vercel previews of more than one project (${[own || "Preview", ...building.map((s2) => s2.context)].map((c) => nameForLog(c)).join(", ")}). Name the one to test with preview-project.`
            );
          }
        }
        return verdict.url;
      }
      if (verdict.kind === "pending") {
        failures.length = 0;
        break;
      }
      failures.push(`${nameForLog(d.environment)} deployment of ${short} ${verdict.detail}`);
    }
    if (candidates.length > 0 && failures.length === candidates.length) {
      throw new Error(`Vercel's ${failures[0]}`);
    }
    if (candidates.length === 0) {
      const statuses = await github(`/commits/${request.sha}/statuses?per_page=100`);
      const vercelStatuses = latestPerContext(statuses).filter((s2) => isVercelContextFor(s2.context, request.project));
      const onlyOtherEnvironments = all.some(
        (d) => d.creator?.login === VERCEL_BOT && (request.project === null || d.environment.endsWith(` \u2013 ${request.project}`))
      );
      if (!onlyOtherEnvironments && vercelStatuses.some((s2) => s2.state === "success")) {
        throw new Error(
          `Vercel deployed ${short} but recorded no GitHub deployment${request.project ? ` for ${nameForLog(request.project)}` : ""}, so there is no preview URL to test. Turn on "deployment_status Events" in the Vercel project (Settings > Git) and push again.`
        );
      }
      if (deps.onlyIfDeploying && (onlyOtherEnvironments || !vercelStatuses.some((s2) => s2.state === "pending"))) {
        throw new Error(`Vercel is not deploying a preview of ${short}`);
      }
    }
    if (now() >= deadline) {
      const others = request.project && projects.length > 0 ? ` This commit has previews of: ${projects.map((p) => nameForLog(p) || "Preview").join(", ")}; check preview-project.` : "";
      throw new Error(`No successful Vercel preview of ${short}${request.project ? ` for ${nameForLog(request.project)}` : ""} after ${Math.round(request.timeoutMs / 1e3)}s.${others}`);
    }
    await sleep3(pollMs);
  }
}
async function previewBaseUrl(mode, env, githubToken, deps = {}, log = console.log) {
  if (mode !== "report" || env.BASE_URL) return null;
  const request = readPreviewRequest(env, githubToken);
  if (!request) return null;
  log(`[peeps] waiting for the Vercel preview of ${request.sha.slice(0, 7)}`);
  const url = await waitForVercelPreview(request, deps);
  log(`[peeps] BASE_URL ${urlForLog(url)} (Vercel preview of ${request.sha.slice(0, 7)})`);
  return url;
}
var PREVIEW_URL_VAR = "PEEPS_PREVIEW_URL";
async function dispatchedPreviewUrl(mode, env, githubToken, checkedOutSha, deps = {}, log = console.log) {
  if (mode !== "run" && mode !== "agent" || env.BASE_URL) return null;
  if (env["INPUT_PREVIEW"]?.trim().toLowerCase() !== "vercel") return null;
  if (env.GITHUB_EVENT_NAME !== "workflow_dispatch" || !githubToken || !env.GITHUB_REPOSITORY) return null;
  const sha = checkedOutSha();
  if (!sha || !/^[0-9a-f]{40}$/.test(sha)) {
    log("[peeps] preview: vercel could not read the checked-out commit (git rev-parse HEAD), so no preview is looked up");
    return null;
  }
  const short = sha.slice(0, 7);
  const timeoutS = Number(env["INPUT_PREVIEW-TIMEOUT"]?.trim() || "600");
  const validTimeout = Number.isFinite(timeoutS) && timeoutS > 0;
  if (!validTimeout) log("[peeps] preview-timeout must be a positive number of seconds; waiting up to 600");
  try {
    const url = await waitForVercelPreview(
      {
        provider: "vercel",
        repository: env.GITHUB_REPOSITORY,
        sha,
        token: githubToken,
        timeoutMs: (validTimeout ? timeoutS : 600) * 1e3,
        apiUrl: (env.GITHUB_API_URL ?? "https://api.github.com").replace(/\/+$/, ""),
        project: env["INPUT_PREVIEW-PROJECT"]?.trim() || null
      },
      { ...deps, onlyIfDeploying: true }
    );
    log(`[peeps] Vercel preview of ${short}: ${urlForLog(url)} (used when Peeps sends no BASE_URL)`);
    return url;
  } catch (error) {
    log(`[peeps] no Vercel preview of ${short} to test: ${nameForLog(error instanceof Error ? error.message : String(error))}`);
    return null;
  }
}
function headSha(cwd) {
  try {
    return (0, import_node_child_process12.execFileSync)("git", ["-c", `safe.directory=${cwd}`, "rev-parse", "HEAD"], {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"]
    }).trim();
  } catch {
    return null;
  }
}

// src/main.ts
function onDefaultBranch(env) {
  if (env.defaultBranch) return env.ref === `refs/heads/${env.defaultBranch}`;
  return env.ref === "refs/heads/main" || env.ref === "refs/heads/master";
}
async function main() {
  const githubToken = takeGithubToken(process.env);
  const requested = (process.env["INPUT_MODE"] ?? process.env.PEEPS_MODE ?? "").trim();
  if (requested === "attach-start" || requested === "attach-finish") {
    const deadline = Number(process.env.PEEPS_ATTACH_DEADLINE_MS) || (requested === "attach-start" ? ATTACH_START_DEADLINE_MS : ATTACH_FINISH_DEADLINE_MS);
    await runAttachStep(async () => {
      const env2 = readRunnerEnv();
      if (requested === "attach-start") await runAttachStart(env2);
      else await runAttachFinish(env2, new PeepsClient(env2));
    }, deadline);
    process.exit(0);
  }
  const env = readRunnerEnv();
  const peeps = new PeepsClient(env);
  const mode = env.mode === "ci" ? "report" : env.mode;
  console.log(
    `[peeps] mode=${mode} repo=${env.repository ?? "?"} sha=${env.sha?.slice(0, 7) ?? "?"} ref=${env.ref ?? "?"} peeps=${env.peepsUrl}`
  );
  const previewUrl2 = await previewBaseUrl(mode, process.env, githubToken);
  if (previewUrl2) process.env.BASE_URL = previewUrl2;
  const dispatched = await dispatchedPreviewUrl(mode, process.env, githubToken, () => headSha(env.workspace));
  if (dispatched) process.env[PREVIEW_URL_VAR] = dispatched;
  const framework = mode === "agent" ? "playwright" : resolveFramework(env);
  if (framework === "pytest" || framework === "appium") {
    console.log(`[peeps] framework=${framework}`);
    const path24 = framework === "pytest" ? { inventory: runPytestInventory, report: runPytestReport, run: runPytestDispatched } : { inventory: runAppiumInventory, report: runAppiumReport, run: runAppiumDispatched };
    switch (mode) {
      case "inventory":
        await path24.inventory(env, peeps);
        return;
      case "report":
        if (onDefaultBranch(env)) {
          await path24.inventory(env, peeps).catch(
            (error) => console.log(`[peeps] inventory skipped: ${String(error)}`)
          );
        }
        await path24.report(env, peeps);
        return;
      case "run":
        await path24.run(env, peeps);
        return;
      default:
        throw new Error(`unknown mode ${mode}`);
    }
  }
  const agentFramework = mode === "agent" ? resolveFramework(env) : null;
  if (mode !== "inventory" && agentFramework !== "pytest" && agentFramework !== "appium") {
    await warnIfBrowsersMissing(env.workingDirectory, env.platform);
  }
  switch (mode) {
    case "inventory":
      await runInventory(env, peeps);
      return;
    case "report":
      if (onDefaultBranch(env)) {
        await runInventory(env, peeps).catch(
          (error) => console.log(`[peeps] inventory skipped: ${String(error)}`)
        );
      }
      await runReport(env, peeps);
      return;
    case "run":
      await runDispatched(env, peeps);
      return;
    case "agent":
      await runAgent(env, peeps);
      return;
    default:
      throw new Error(`unknown mode ${mode}`);
  }
}
main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`::error::${message}`);
  process.exit(1);
});
