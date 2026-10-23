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
var import_promises = require("node:fs/promises");
var import_node_path2 = __toESM(require("node:path"));
var import_node_util = require("node:util");
var execFileAsync = (0, import_node_util.promisify)(import_node_child_process.execFile);
function gitBlobSha(content) {
  return (0, import_node_crypto.createHash)("sha1").update(`blob ${content.length}\0`).update(content).digest("hex");
}
function specFilesOf(list) {
  const files = /* @__PURE__ */ new Set();
  const walk2 = (suite) => {
    for (const spec of suite.specs ?? []) files.add(spec.file);
    for (const child of suite.suites ?? []) walk2(child);
  };
  for (const suite of list.suites) walk2(suite);
  return [...files].sort();
}
async function listTests(env) {
  const args = ["playwright", "test", "--list", "--reporter=json"];
  if (env.configPath) args.push("--config", env.configPath);
  const { stdout } = await execFileAsync("npx", args, {
    cwd: env.workingDirectory,
    maxBuffer: 64 * 1024 * 1024,
    env: { ...process.env, CI: "1" }
  });
  return JSON.parse(stdout);
}
async function specFilePayload(env, list) {
  const rootDirAbs = list.config.rootDir ?? env.workingDirectory;
  const files = [];
  for (const file of specFilesOf(list)) {
    const abs = import_node_path2.default.join(rootDirAbs, file);
    const bytes = await (0, import_promises.readFile)(abs);
    files.push({
      path: import_node_path2.default.relative(env.workspace, abs).split(import_node_path2.default.sep).join("/"),
      blobSha: gitBlobSha(bytes),
      content: bytes.toString("utf8")
    });
  }
  return files;
}
async function buildInventoryRequest(env, list) {
  if (!env.sha) throw new Error("The commit sha is not set (GITHUB_SHA / CI_COMMIT_SHA)");
  const rootDirAbs = list.config.rootDir ?? env.workingDirectory;
  const rootDir = import_node_path2.default.relative(env.workspace, rootDirAbs).split(import_node_path2.default.sep).join("/") || ".";
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
  const walk2 = (suite) => {
    n += suite.specs?.length ?? 0;
    for (const child of suite.suites ?? []) walk2(child);
  };
  for (const suite of list.suites) walk2(suite);
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
  constructor(path11, status, body) {
    super(`Peeps ${path11} \u2192 ${status}: ${body.slice(0, 500)}`);
    this.path = path11;
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
  async postBytes(path11, bytes) {
    let lastError;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const response = await fetch(`${this.env.peepsUrl}${path11}`, {
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
          throw new Error(`Peeps ${path11} \u2192 ${response.status}: ${text2.slice(0, 300)}`);
        }
        lastError = new Error(`Peeps ${path11} \u2192 ${response.status}`);
      } catch (error) {
        lastError = error;
      }
      await new Promise((r) => setTimeout(r, 1500 * (attempt + 1)));
    }
    throw lastError instanceof Error ? lastError : new Error(String(lastError));
  }
  /** GET that treats 204 as "nothing" (long-poll idle) instead of an error. */
  async getOrNull(path11) {
    const response = await fetch(`${this.env.peepsUrl}${path11}`, {
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
      throw new PeepsHttpError(path11, response.status, text2);
    }
    return JSON.parse(text2);
  }
  async get(path11) {
    const response = await fetch(`${this.env.peepsUrl}${path11}`, {
      headers: {
        Authorization: `Bearer ${await this.token()}`,
        Accept: "application/json",
        "User-Agent": "peeps-action/0.1"
      }
    });
    const text2 = await response.text();
    if (!response.ok) {
      throw new PeepsHttpError(path11, response.status, text2);
    }
    return JSON.parse(text2);
  }
  async post(path11, body) {
    const response = await fetch(`${this.env.peepsUrl}${path11}`, {
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
      throw new PeepsHttpError(path11, response.status, text2);
    }
    return text2 ? JSON.parse(text2) : {};
  }
};

// src/report.ts
var import_node_child_process2 = require("node:child_process");

// src/capture-config.ts
var import_node_crypto2 = require("node:crypto");
var import_promises2 = require("node:fs/promises");
var import_node_path3 = __toESM(require("node:path"));
var import_node_url = require("node:url");
var CONFIG_EXTENSIONS = [".ts", ".js", ".mts", ".mjs", ".cts", ".cjs"];
async function configLocation(env) {
  const cwd = await (0, import_promises2.realpath)(env.workingDirectory);
  const selected = env.configPath ? import_node_path3.default.resolve(cwd, env.configPath) : cwd;
  if (!(await (0, import_promises2.stat)(selected)).isDirectory()) return { dir: import_node_path3.default.dirname(selected), file: selected };
  for (const ext of CONFIG_EXTENSIONS) {
    const file = import_node_path3.default.join(selected, `playwright.config${ext}`);
    try {
      await (0, import_promises2.stat)(file);
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
  let dir = import_node_path3.default.dirname(file);
  for (; ; ) {
    try {
      const text2 = await (0, import_promises2.readFile)(import_node_path3.default.join(dir, "package.json"), "utf8");
      try {
        return JSON.parse(text2).type === "module";
      } catch {
        return false;
      }
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    const parent = import_node_path3.default.dirname(dir);
    if (parent === dir) return false;
    dir = parent;
  }
}
async function prepareCaptureConfig(env) {
  const { dir, file } = await configLocation(env);
  const esm = file ? await isModule(file) : false;
  const configPath = import_node_path3.default.join(dir, `.peeps-capture-${(0, import_node_crypto2.randomUUID)()}.config.${esm ? "mjs" : "cjs"}`);
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
  ...config,
  use: {
    ...config.use,
    screenshot: config.use?.screenshot === undefined ? "only-on-failure" : config.use.screenshot,
    video: config.use?.video === undefined ? defaultVideo : config.use.video,
  },
};
`;
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
    await (0, import_promises2.writeFile)(configPath, source, { flag: "wx", mode: 384 });
  } catch (error) {
    if (error.code !== "EEXIST") await (0, import_promises2.unlink)(configPath).catch(() => {
    });
    throw error;
  }
  return { configPath, cleanup: () => (0, import_promises2.unlink)(configPath) };
}

// src/report.ts
var import_promises3 = require("node:fs/promises");
var import_node_os = require("node:os");
var import_node_path4 = __toESM(require("node:path"));
var MAX_UPLOAD_BYTES = 128 * 1024 * 1024;
function plannedTestsOf(list, rootDir) {
  const out = [];
  const trimmed = rootDir.trim();
  const root = trimmed === "" || trimmed === "." || trimmed === "./" ? "" : trimmed.replace(/^\.\//, "").replace(/\/+$/, "");
  const walk2 = (suite, titles, isFile) => {
    const next = isFile ? titles : [...titles, suite.title];
    for (const spec of suite.specs ?? []) {
      const file = spec.file.replace(/^\.\//, "");
      const specPath = root === "" ? file : `${root}/${file}`;
      const projects = (spec.tests ?? []).map(
        (t) => t.projectName ?? ""
      );
      for (const pwProject of projects.length ? [...new Set(projects)] : [""]) {
        out.push({ path: specPath, titlePath: [...next, spec.title].join(" \u203A "), pwProject });
      }
    }
    for (const child of suite.suites ?? []) walk2(child, next, false);
  };
  for (const suite of list.suites) walk2(suite, [], true);
  return out;
}
async function runReport(env, peeps) {
  if (!env.sha) throw new Error("The commit sha is not set (GITHUB_SHA / CI_COMMIT_SHA)");
  const list = await listTests(env);
  const rootDirAbs = list.config.rootDir ?? env.workingDirectory;
  const rootDir = import_node_path4.default.relative(env.workspace, rootDirAbs).split(import_node_path4.default.sep).join("/") || ".";
  const tests = plannedTestsOf(list, rootDir);
  console.log(`[peeps] report: ${tests.length} tests at ${env.sha.slice(0, 7)} (${env.ref ?? "?"})`);
  const jobUrl = env.runUrl;
  const files = await specFilePayload(env, list);
  const response = await peeps.post("/api/v1/ci/batches", {
    sha: env.sha,
    jobUrl,
    baseUrl: process.env.BASE_URL ?? null,
    tests,
    files
  });
  const runs = response.batches.flatMap((b) => b.runs);
  const unmatched = response.batches.flatMap((b) => b.unmatched);
  console.log(
    `[peeps] planned ${runs.length} run(s) in ${response.batches.length} batch(es); ${unmatched.length} test(s) unknown to Peeps`
  );
  for (const u of unmatched.slice(0, 10)) console.log(`[peeps]   unknown: ${u.path} \u203A ${u.titlePath}`);
  await executeAndReport(env, peeps, {
    rootDir,
    runs,
    batches: response.batches.map((b) => ({ batchId: b.batchId, batchNumber: b.batchNumber }))
  });
}
async function executeAndReport(env, peeps, input2) {
  const scratch = await (0, import_promises3.mkdtemp)(import_node_path4.default.join(process.env.RUNNER_TEMP ?? (0, import_node_os.tmpdir)(), "peeps-"));
  const planFile = import_node_path4.default.join(scratch, "plan.json");
  const reportDir = import_node_path4.default.join(scratch, "report");
  const plan = { peepsUrl: env.peepsUrl, rootDir: input2.rootDir, runs: input2.runs };
  await (0, import_promises3.writeFile)(planFile, JSON.stringify(plan), { mode: 384 });
  const exitCode = await runPlaywright(env, planFile, reportDir, input2.selection);
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
      await peeps.post(`/api/v1/ci/batches/${b.batchId}/complete`, { reportUploaded });
    } catch (error) {
      console.log(`[peeps] could not complete batch ${b.batchId}: ${String(error)}`);
    }
  }
  console.log(`[peeps] playwright exited with ${exitCode}`);
  if (exitCode !== 0) process.exitCode = exitCode;
}
async function runPlaywright(env, planFile, reportDir, selection) {
  const reporterPath = import_node_path4.default.join(__dirname, "reporter.js");
  const args = ["playwright", "test", `--reporter=${reporterPath},list,html`];
  let capture;
  try {
    capture = await prepareCaptureConfig(env);
  } catch (error) {
    console.warn(`[peeps] screenshot/video defaults could not be applied; using the original config: ${String(error)}`);
  }
  const configPath = capture?.configPath ?? env.configPath;
  if (configPath) args.push("--config", configPath);
  if (selection) {
    args.push("--grep", selection.grep, "--", ...selection.files);
  }
  try {
    return await new Promise((resolve) => {
      const child = (0, import_node_child_process2.spawn)("npx", args, {
        cwd: env.workingDirectory,
        stdio: "inherit",
        env: {
          ...process.env,
          CI: "1",
          PEEPS_PLAN_FILE: planFile,
          PLAYWRIGHT_HTML_OUTPUT_DIR: reportDir,
          PLAYWRIGHT_HTML_OPEN: "never"
        }
      });
      child.on("error", (error) => {
        console.error(`[peeps] could not start Playwright: ${String(error)}`);
        resolve(1);
      });
      child.on("close", (code) => resolve(code ?? 1));
    });
  } finally {
    await capture?.cleanup().catch((error) => {
      console.warn(`[peeps] could not remove temporary capture config: ${String(error)}`);
    });
  }
}
async function* walk(dir, rel = "") {
  let entries;
  try {
    entries = await (0, import_promises3.readdir)(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const abs = import_node_path4.default.join(dir, entry.name);
    const relPath = rel ? `${rel}/${entry.name}` : entry.name;
    if (entry.isDirectory()) yield* walk(abs, relPath);
    else if (entry.isFile()) yield { abs, rel: relPath };
  }
}
async function uploadReport(peeps, batchId, reportDir) {
  let uploaded = 0;
  for await (const file of walk(reportDir)) {
    const info = await (0, import_promises3.stat)(file.abs);
    if (info.size > MAX_UPLOAD_BYTES) {
      console.log(`[peeps] skipping ${file.rel}: ${info.size} bytes exceeds the upload limit`);
      continue;
    }
    const bytes = await (0, import_promises3.readFile)(file.abs);
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
var import_node_path5 = __toESM(require("node:path"));

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

// src/run.ts
function escapeRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
function grepFor(titlePaths) {
  const alternatives = [...new Set(titlePaths)].map(
    (t) => escapeRegex(t.split(" \u203A ").join(" ")) + "(?: @[^ ]+)*$"
  );
  return `(?:^| )(?:${alternatives.join("|")})`;
}
async function runDispatched(env, peeps) {
  if (!env.sessionId) throw new Error("`session-id` is required in run mode (Peeps passes it)");
  const list = await listTests(env);
  const rootDirAbs = list.config.rootDir ?? env.workingDirectory;
  const rootDir = import_node_path5.default.relative(env.workspace, rootDirAbs).split(import_node_path5.default.sep).join("/") || ".";
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
    (p) => import_node_path5.default.relative(env.workingDirectory, import_node_path5.default.join(env.workspace, p)).split(import_node_path5.default.sep).join("/")
  );
  await executeAndReport(env, peeps, {
    rootDir,
    runs: plan.runs,
    batches: [{ batchId: plan.batchId, batchNumber: plan.batchNumber }],
    selection: { files, grep: grepFor(plan.runs.map((r) => r.titlePath)) }
  });
}

// src/appium.ts
var import_node_child_process4 = require("node:child_process");
var import_node_crypto4 = require("node:crypto");
var import_node_fs4 = require("node:fs");
var import_promises5 = require("node:fs/promises");
var import_node_os3 = require("node:os");
var import_node_path8 = __toESM(require("node:path"));
var import_node_url2 = require("node:url");

// src/appium-reporter.ts
var import_node_fs2 = require("node:fs");
var import_node_path6 = __toESM(require("node:path"));
var TITLE_PATH_SEPARATOR = " \u203A ";
function repoRelative(workspace, abs) {
  const attempt = (root, file) => {
    const rel = import_node_path6.default.relative(root, file).split(import_node_path6.default.sep).join("/");
    return rel === "" || rel === ".." || rel.startsWith("../") || import_node_path6.default.isAbsolute(rel) ? null : rel;
  };
  const direct = attempt(workspace, abs);
  if (direct !== null) return direct;
  try {
    return attempt((0, import_node_fs2.realpathSync)(workspace), (0, import_node_fs2.realpathSync)(abs));
  } catch {
    return null;
  }
}
var MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024;
function pageSourceExtension(source, context) {
  if (context && /^(WEBVIEW|CHROMIUM)/i.test(context)) return "html";
  const head = source.trimStart().slice(0, 512);
  if (/^<\?xml|^<hierarchy[\s>]|^<AppiumAUT[\s>]/i.test(head)) return "xml";
  if (/^<!doctype html|<html[\s>]/i.test(head)) return "html";
  return context && /^NATIVE/i.test(context) ? "xml" : "html";
}

// src/pytest.ts
var import_node_child_process3 = require("node:child_process");
var import_node_crypto3 = require("node:crypto");
var import_node_fs3 = require("node:fs");
var import_promises4 = require("node:fs/promises");
var import_node_os2 = require("node:os");
var import_node_path7 = __toESM(require("node:path"));
var WDIO_CONFIG = /^wdio(\..+)?\.conf\.[cm]?[jt]s$/;
var PLUGIN_DIR = import_node_path7.default.join(__dirname, "..", "python");
var PLUGIN = "peeps_pytest_plugin";
var PLAYWRIGHT_CONFIG = /^playwright(\..+)?\.config\.[cm]?[jt]s$/;
function resolveFramework(env) {
  const declared = env.framework;
  if (declared === "playwright" || declared === "pytest" || declared === "appium") return declared;
  if (declared !== null && declared !== "auto") {
    throw new Error(`unknown framework "${declared}": use playwright, pytest, appium or auto`);
  }
  if (env.configPath) return WDIO_CONFIG.test(import_node_path7.default.basename(env.configPath)) ? "appium" : "playwright";
  let names;
  try {
    names = (0, import_node_fs3.readdirSync)(env.workingDirectory);
  } catch {
    return "playwright";
  }
  if (names.some((name) => PLAYWRIGHT_CONFIG.test(name))) return "playwright";
  if (names.some((name) => WDIO_CONFIG.test(name))) return "appium";
  if (names.includes("pytest.ini") || names.includes("conftest.py")) return "pytest";
  const pyproject = import_node_path7.default.join(env.workingDirectory, "pyproject.toml");
  if ((0, import_node_fs3.existsSync)(pyproject) && /^\s*\[tool\.pytest(\.ini_options)?\]/m.test((0, import_node_fs3.readFileSync)(pyproject, "utf8"))) {
    return "pytest";
  }
  return "playwright";
}
var TITLE_PATH_SEPARATOR2 = " \u203A ";
function splitParameter(nodeId) {
  const open = nodeId.indexOf("[", Math.max(0, nodeId.indexOf("::")));
  if (open === -1 || !nodeId.endsWith("]")) return { head: nodeId, parameter: null };
  return { head: nodeId.slice(0, open), parameter: nodeId.slice(open + 1, -1) };
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
  env.PYTHONPATH = process.env.PYTHONPATH ? `${PLUGIN_DIR}${import_node_path7.default.delimiter}${process.env.PYTHONPATH}` : PLUGIN_DIR;
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
    const child = (0, import_node_child_process3.spawn)(candidates[index], ["-m", "pytest", ...args], {
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
  const scratch = await (0, import_promises4.mkdtemp)(import_node_path7.default.join(process.env.RUNNER_TEMP ?? (0, import_node_os2.tmpdir)(), "peeps-collect-"));
  const out = import_node_path7.default.join(scratch, "collection.json");
  const { code, output } = await spawnPytest(
    ["--collect-only", "-q", "-p", PLUGIN, ...configArgs(env)],
    { cwd: env.workingDirectory, env: pytestEnv({ PEEPS_COLLECT_OUT: out }), capture: true }
  );
  if (![0, 2, 5].includes(code) || !(0, import_node_fs3.existsSync)(out)) {
    throw new Error(`pytest --collect-only exited with ${code}:
${output.slice(-4e3)}`);
  }
  const collection = JSON.parse(await (0, import_promises4.readFile)(out, "utf8"));
  for (const error of collection.errors) {
    console.log(`[peeps] collection error in ${error.nodeId}:
${error.message}`);
  }
  return collection;
}
function repoRelative2(env, abs) {
  let workspace = env.workspace;
  try {
    workspace = (0, import_node_fs3.realpathSync)(workspace);
  } catch {
  }
  const rel = import_node_path7.default.relative(workspace, abs).split(import_node_path7.default.sep).join("/");
  if (rel === ".." || rel.startsWith("../") || import_node_path7.default.isAbsolute(rel)) {
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
    const abs = import_node_path7.default.join(collection.rootDir, file);
    const bytes = await (0, import_promises4.readFile)(abs);
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
  await executePytestAndReport(env, peeps, {
    collection,
    byNodeId,
    batches: [{ batchId: plan.batchId, batchNumber: plan.batchNumber }],
    nodeIds
  });
}
function nodeIdArgument(nodeId, rootDirAbs, cwd) {
  const separator = nodeId.indexOf("::");
  const file = separator === -1 ? nodeId : nodeId.slice(0, separator);
  const rest = separator === -1 ? "" : nodeId.slice(separator);
  let from = cwd;
  try {
    from = (0, import_node_fs3.realpathSync)(cwd);
  } catch {
  }
  const relative = import_node_path7.default.relative(from, import_node_path7.default.join(rootDirAbs, file)).split(import_node_path7.default.sep).join("/");
  return relative + rest;
}
async function executePytestAndReport(env, peeps, input2) {
  const scratch = await (0, import_promises4.mkdtemp)(import_node_path7.default.join(process.env.RUNNER_TEMP ?? (0, import_node_os2.tmpdir)(), "peeps-"));
  const planFile = import_node_path7.default.join(scratch, "plan.json");
  const resultsFile = import_node_path7.default.join(scratch, "results.json");
  const outputDir = import_node_path7.default.join(scratch, "output");
  const artifactsDir = import_node_path7.default.join(scratch, "evidence");
  await (0, import_promises4.mkdir)(artifactsDir);
  const runs = Object.fromEntries(
    Object.entries(input2.byNodeId).map(([nodeId, run]) => [
      nodeId,
      { runId: run.runId, credential: run.credential }
    ])
  );
  await (0, import_promises4.writeFile)(planFile, JSON.stringify({ peepsUrl: env.peepsUrl, runs }), { mode: 384 });
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
  const evidence = await stagedEvidence(import_node_path7.default.join(artifactsDir, "upload"), input2.byNodeId);
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
      const uploaded = await uploadEvidence(peeps, b.batchId, mine);
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
    const results = JSON.parse(await (0, import_promises4.readFile)(resultsFile, "utf8"));
    for (const [nodeId, dir] of Object.entries(results.outputDirs ?? {})) {
      const run = byNodeId[nodeId];
      if (run) map.set(import_node_path7.default.basename(dir), run.runId);
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
  const ext = import_node_path7.default.extname(flat);
  return `data/${(0, import_node_crypto3.createHash)("sha1").update(rel).digest("hex")}${ext}`;
}
async function* walkOutput(dir, rel = "") {
  let entries;
  try {
    entries = await (0, import_promises4.readdir)(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const abs = import_node_path7.default.join(dir, entry.name);
    const relPath = rel ? `${rel}/${entry.name}` : entry.name;
    if (entry.isDirectory()) yield* walkOutput(abs, relPath);
    else if (entry.isFile()) yield { abs, rel: relPath };
  }
}
var MAX_EVIDENCE_BYTES = 25 * 1024 * 1024;
async function stagedEvidence(uploadDir, byNodeId) {
  try {
    if (!(await (0, import_promises4.lstat)(uploadDir)).isDirectory()) return [];
  } catch {
    return [];
  }
  const runIds = Object.values(byNodeId).map((run) => run.runId);
  const staged = [];
  for (const entry of await (0, import_promises4.readdir)(uploadDir, { withFileTypes: true })) {
    const name = entry.name;
    if (!entry.isFile() || !/^[A-Za-z0-9._-]{1,200}$/.test(name)) {
      console.log(`[peeps] not uploading ${JSON.stringify(name)}: not a staged attachment`);
      continue;
    }
    const runId = runIds.find((id) => name.startsWith(`${id}-evidence-`));
    if (runId === void 0) continue;
    staged.push({ abs: import_node_path7.default.join(uploadDir, name), name, runId });
  }
  return staged.sort((a, b) => a.name.localeCompare(b.name));
}
async function uploadEvidence(peeps, batchId, files) {
  let uploaded = 0;
  for (const file of files) {
    try {
      const info = await (0, import_promises4.lstat)(file.abs);
      if (!info.isFile() || info.size > MAX_EVIDENCE_BYTES) {
        console.log(`[peeps] skipping attachment ${file.name}: not a file within ${MAX_EVIDENCE_BYTES} bytes`);
        continue;
      }
      await peeps.postBytes(
        `/api/v1/ci/batches/${batchId}/artifacts?path=${encodeURIComponent(`data/${file.name}`)}`,
        await (0, import_promises4.readFile)(file.abs)
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
    const info = await (0, import_promises4.stat)(file.abs);
    if (info.size > MAX_UPLOAD_BYTES2) {
      console.log(`[peeps] skipping ${file.rel}: ${info.size} bytes exceeds the upload limit`);
      continue;
    }
    const name = artifactName(file.rel, runIdByOutputDir);
    try {
      await peeps.postBytes(
        `/api/v1/ci/batches/${batchId}/artifacts?path=${encodeURIComponent(name)}`,
        await (0, import_promises4.readFile)(file.abs)
      );
      uploaded += 1;
    } catch (error) {
      console.log(`[peeps] skipped ${file.rel}: ${String(error).slice(0, 200)}`);
    }
  }
  return uploaded;
}

// src/appium.ts
var COLLECTOR = import_node_path8.default.join(__dirname, "..", "dist", "appium-collect.mjs");
var APPIUM_REPORTER = import_node_path8.default.join(__dirname, "..", "dist", "appium-reporter.js");
var DEFAULT_CONFIGS = ["ts", "mts", "js", "mjs", "cjs", "cts"].map((ext) => `wdio.conf.${ext}`);
var COLLECT_TIMEOUT_MS = 10 * 60 * 1e3;
async function readAppiumCapabilities(env, configPath = wdioConfigPath(env)) {
  const read = await runCollector(env, ["--capabilities", configPath], "reading the WebdriverIO capabilities");
  for (const note of read.notes) console.log(`[peeps] ${note}`);
  return read;
}
var MAX_UPLOAD_BYTES3 = 128 * 1024 * 1024;
function wdioConfigPath(env) {
  if (env.configPath) return import_node_path8.default.resolve(env.workingDirectory, env.configPath);
  for (const name of DEFAULT_CONFIGS) {
    const candidate = import_node_path8.default.join(env.workingDirectory, name);
    if ((0, import_node_fs4.existsSync)(candidate)) return candidate;
  }
  let names = [];
  try {
    names = (0, import_node_fs4.readdirSync)(env.workingDirectory).filter((name) => WDIO_CONFIG.test(name)).sort();
  } catch {
  }
  if (names.length === 1) return import_node_path8.default.join(env.workingDirectory, names[0]);
  throw new Error(
    names.length > 1 ? `several WebdriverIO configs in ${env.workingDirectory} (${names.join(", ")}): set \`config\` to the one this job runs` : `no wdio.conf.ts (or .js, .mjs, .cjs) in ${env.workingDirectory}: set \`config\` to your WebdriverIO config`
  );
}
async function runCollector(env, args, what) {
  const scratch = await (0, import_promises5.mkdtemp)(import_node_path8.default.join(process.env.RUNNER_TEMP ?? (0, import_node_os3.tmpdir)(), "peeps-collect-"));
  const out = import_node_path8.default.join(scratch, "collection.json");
  const { code, output } = await new Promise((resolve, reject) => {
    const child = (0, import_node_child_process4.spawn)(process.execPath, [COLLECTOR, ...args, out], {
      cwd: env.workingDirectory,
      env: { ...process.env, CI: "1" },
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
  if (code !== 0 || !(0, import_node_fs4.existsSync)(out)) {
    throw new Error(`${what} failed (${code}):
${output.slice(-4e3)}`);
  }
  return JSON.parse(await (0, import_promises5.readFile)(out, "utf8"));
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
  if (import_node_path8.default.resolve(abs) === import_node_path8.default.resolve(env.workspace)) return "";
  const rel = repoRelative(env.workspace, abs);
  if (rel === null) throw new Error(`${abs} is outside the repository (${env.workspace})`);
  return rel;
}
function appiumRootDir(env, collection) {
  let root = repoPath(env, collection.rootDir);
  const files = collection.specs.map((file) => repoPath(env, file));
  const holds = (file) => root === "" || file.startsWith(`${root}/`);
  while (!files.every(holds)) {
    const parent = import_node_path8.default.posix.dirname(root);
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
      const bytes = await (0, import_promises5.readFile)(test.file);
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
      config: { rootDir: import_node_path8.default.join(env.workspace, rootDir === "." ? "" : rootDir), projects: [] },
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
async function runAppiumReport(env, peeps) {
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
    files: built.files
  });
  const runs = response.batches.flatMap((b) => b.runs);
  const unmatched = response.batches.flatMap((b) => b.unmatched);
  console.log(
    `[peeps] planned ${runs.length} run(s) in ${response.batches.length} batch(es); ${unmatched.length} test(s) unknown to Peeps`
  );
  for (const u of unmatched.slice(0, 10)) console.log(`[peeps]   unknown: ${u.path} \u203A ${u.titlePath}`);
  await executeAppiumAndReport(env, peeps, {
    configPath,
    runs,
    batches: response.batches.map((b) => ({
      batchId: b.batchId,
      batchNumber: b.batchNumber,
      runIds: b.runs.map((r) => r.runId)
    }))
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
function escapeRegex2(value) {
  return value.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&").replace(/\n/g, "\\n").replace(/\r/g, "\\r").replace(/\u2028/g, "\\u2028").replace(/\u2029/g, "\\u2029");
}
function mochaGrepFor(titlePaths) {
  const alternatives = [...new Set(titlePaths)].map((t) => escapeRegex2(t.split(TITLE_PATH_SEPARATOR).join(" ")));
  return `^(?:${alternatives.join("|")})$`;
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
  await executeAppiumAndReport(env, peeps, {
    configPath,
    runs: matched,
    batches: [{ batchId: plan.batchId, batchNumber: plan.batchNumber }],
    selection: { specs, capabilitySpecs, grep: mochaGrepFor(matched.map((r) => r.titlePath)) }
  });
}
function hasPackage(name, from) {
  for (let dir = from; ; dir = import_node_path8.default.dirname(dir)) {
    if ((0, import_node_fs4.existsSync)(import_node_path8.default.join(dir, "node_modules", name, "package.json"))) return true;
    if (import_node_path8.default.dirname(dir) === dir) return false;
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
      (0, import_node_fs4.unlinkSync)(file);
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
  const wrapper = import_node_path8.default.join(import_node_path8.default.dirname(configPath), `.peeps-${(0, import_node_crypto4.randomUUID)()}.wdio.conf.${ts ? "mts" : "mjs"}`);
  const source = [
    "// Written by peeps-action for this run and removed after it; never committed.",
    'import { createRequire } from "node:module";',
    `import * as loaded from ${JSON.stringify((0, import_node_url2.pathToFileURL)(configPath).href)};`,
    "const require = createRequire(import.meta.url);",
    `const { withPeeps } = require(${JSON.stringify(APPIUM_REPORTER)});`,
    "const base = loaded.config ?? loaded.default?.config;",
    `export const config = withPeeps(base, ${JSON.stringify(options)});`,
    ""
  ].join("\n");
  await (0, import_promises5.writeFile)(wrapper, source, { flag: "wx", mode: 384 });
  liveWrappers.add(wrapper);
  return {
    configPath: wrapper,
    cleanup: async () => {
      liveWrappers.delete(wrapper);
      await (0, import_promises5.unlink)(wrapper).catch((error) => {
        if (error.code !== "ENOENT") throw error;
      });
    }
  };
}
function runWdio(env, configPath, extraEnv) {
  return new Promise((resolve) => {
    const child = (0, import_node_child_process4.spawn)("npx", ["wdio", "run", configPath], {
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
  const scratch = await (0, import_promises5.mkdtemp)(import_node_path8.default.join(process.env.RUNNER_TEMP ?? (0, import_node_os3.tmpdir)(), "peeps-"));
  const planFile = import_node_path8.default.join(scratch, "plan.json");
  const artifactsDir = import_node_path8.default.join(scratch, "evidence");
  await (0, import_promises5.mkdir)(artifactsDir);
  const plan = { peepsUrl: env.peepsUrl, workspace: env.workspace, runs: input2.runs };
  if (input2.selection) plan.onlyPlanned = true;
  await (0, import_promises5.writeFile)(planFile, JSON.stringify(plan), { mode: 384 });
  const junitDir = hasPackage("@wdio/junit-reporter", import_node_path8.default.dirname(input2.configPath)) ? import_node_path8.default.join(scratch, "junit") : null;
  const options = { junitDir };
  if (input2.selection) {
    options.specs = input2.selection.specs.map((file) => (0, import_node_url2.pathToFileURL)(file).href);
    if (input2.selection.capabilitySpecs) {
      options.capabilitySpecs = input2.selection.capabilitySpecs.map((list) => list.map((file) => (0, import_node_url2.pathToFileURL)(file).href));
    }
    options.grep = input2.selection.grep;
    options.onlyPlanned = true;
  }
  let code = 1;
  let wrapper;
  const release = stopOnSignal();
  try {
    wrapper = await writeWrapperConfig(input2.configPath, options);
    const extraEnv = { PEEPS_PLAN_FILE: planFile, PEEPS_ARTIFACTS_DIR: artifactsDir };
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
  const evidence = await stagedEvidence(import_node_path8.default.join(artifactsDir, "upload"), byRunId);
  for (const b of input2.batches) {
    const mine = evidence.filter((file) => input2.batches.length === 1 || (b.runIds ?? []).includes(file.runId));
    if (mine.length > 0) {
      const uploaded = await uploadEvidence(peeps, b.batchId, mine);
      console.log(`[peeps] uploaded ${uploaded} test attachment(s) for batch ${b.batchNumber}`);
    }
    if (junitDir) await uploadJunit(peeps, b.batchId, junitDir);
    try {
      await peeps.post(`/api/v1/ci/batches/${b.batchId}/complete`, { reportUploaded: false });
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
    names = (await (0, import_promises5.readdir)(junitDir)).filter((name) => name.endsWith(".xml")).sort();
  } catch {
    return;
  }
  let uploaded = 0;
  for (const name of names) {
    const file = import_node_path8.default.join(junitDir, name);
    try {
      if ((await (0, import_promises5.stat)(file)).size > MAX_UPLOAD_BYTES3) continue;
      await peeps.postBytes(
        `/api/v1/ci/batches/${batchId}/artifacts?path=${encodeURIComponent(junitArtifactName(name))}`,
        await (0, import_promises5.readFile)(file)
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
    const child = (0, import_node_child_process4.spawn)("npx", ["wdio", "run", configPath], {
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
    names = (await (0, import_promises5.readdir)(resultsDir)).filter((name) => name.endsWith(".jsonl")).sort();
  } catch {
    return [];
  }
  const byRunId = /* @__PURE__ */ new Map();
  for (const name of names) {
    for (const raw of (await (0, import_promises5.readFile)(import_node_path8.default.join(resultsDir, name), "utf8")).split("\n")) {
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
  const scratch = await (0, import_promises5.mkdtemp)(import_node_path8.default.join(process.env.RUNNER_TEMP ?? (0, import_node_os3.tmpdir)(), "peeps-agent-run-"));
  const planFile = import_node_path8.default.join(scratch, "plan.json");
  const artifactsDir = import_node_path8.default.join(scratch, "evidence");
  const resultsDir = import_node_path8.default.join(scratch, "results");
  await (0, import_promises5.mkdir)(artifactsDir);
  const plan = { peepsUrl: env.peepsUrl, workspace: env.workspace, runs: [], resultsDir };
  await (0, import_promises5.writeFile)(planFile, JSON.stringify(plan), { mode: 384 });
  const wdioOptions = {
    junitDir: null,
    // As a file URL: WebdriverIO globs a plain path, and `[id].spec.ts` is a glob.
    specs: [(0, import_node_url2.pathToFileURL)(input2.file).href]
  };
  if (input2.grep) wdioOptions.grep = mochaGrepFromRegex(input2.grep);
  const started = Date.now();
  let run = { code: 1, stdout: "", stderr: "" };
  let wrapper;
  try {
    wrapper = await writeWrapperConfig(configPath, wdioOptions);
    const extraEnv = { PEEPS_PLAN_FILE: planFile, PEEPS_ARTIFACTS_DIR: artifactsDir };
    run = await (options.runner ?? ((config, extra) => runWdioCaptured(env, config, extra)))(wrapper.configPath, extraEnv);
  } catch (error) {
    run = { ...run, stderr: `could not run WebdriverIO: ${String(error)}` };
  } finally {
    await wrapper?.cleanup().catch(() => void 0);
  }
  const sources = /* @__PURE__ */ new Map();
  const sourceOf = async (rel) => {
    if (!sources.has(rel)) sources.set(rel, await (0, import_promises5.readFile)(import_node_path8.default.join(env.workspace, rel), "utf8").catch(() => null));
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
        path: import_node_path8.default.join(artifactsDir, "upload", import_node_path8.default.basename(a.path)),
        size: a.size
      }));
      const pageSource = result.evidence.find((e) => e.name.startsWith("page-source"));
      if (pageSource && inlined < AGENT_PAGE_SOURCE_TESTS) {
        const text2 = await (0, import_promises5.readFile)(pageSource.path, "utf8").catch(() => null);
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
var import_node_child_process5 = require("node:child_process");
var import_node_fs5 = require("node:fs");
var import_promises6 = require("node:fs/promises");
var import_node_net = require("node:net");
var import_node_os4 = require("node:os");
var import_node_path9 = __toESM(require("node:path"));
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
var sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
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
    readCapabilities: options.deps?.readCapabilities ?? (() => defaultReadCapabilities(env)),
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
  const mask = (value) => {
    let out = redact(value);
    for (const secret of [...typedSecrets].sort((a, b) => b.length - a.length)) out = out.split(secret).join("[redacted]");
    return out;
  };
  const platform = () => String(caps.platformName ?? "").toLowerCase();
  async function startup() {
    const raw = await deps.readCapabilities();
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
  function start() {
    if (ready) return;
    console.log("[peeps] device tools: reading capabilities, starting Appium and a device session");
    ready = startup().catch(async (error) => {
      startError = error instanceof Error ? error : new Error(String(error));
      if (!stopping.signal.aborted) console.log(`[peeps] device session could not start: ${mask(startError.message).slice(0, 2e3)}`);
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
      const dir = import_node_path9.default.join(process.env.RUNNER_TEMP ?? (0, import_node_os4.tmpdir)(), "peeps-device");
      await (0, import_promises6.mkdir)(dir, { recursive: true });
      screenshots += 1;
      const file = import_node_path9.default.join(dir, `screenshot-${screenshots}.png`);
      await (0, import_promises6.writeFile)(file, bytes);
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
          console.log(`[peeps] could not delete the device session: ${mask(String(error)).slice(0, 200)}`);
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
async function defaultReadCapabilities(env) {
  return (await readAppiumCapabilities(env)).capabilities;
}
function resolveAppiumBinary(from, pathEnv = process.env.PATH ?? "") {
  for (let dir = import_node_path9.default.resolve(from); ; dir = import_node_path9.default.dirname(dir)) {
    const candidate = import_node_path9.default.join(dir, "node_modules", ".bin", "appium");
    if ((0, import_node_fs5.existsSync)(candidate)) return candidate;
    if (import_node_path9.default.dirname(dir) === dir) break;
  }
  for (const dir of pathEnv.split(import_node_path9.default.delimiter)) {
    if (!dir) continue;
    const candidate = import_node_path9.default.join(dir, "appium");
    if ((0, import_node_fs5.existsSync)(candidate)) return candidate;
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
  const logFile = import_node_path9.default.join(process.env.RUNNER_TEMP ?? (0, import_node_os4.tmpdir)(), `peeps-appium-${port}.log`);
  const child = (0, import_node_child_process5.spawn)(
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
      await Promise.race([exitedPromise, sleep(2e3)]);
      if (exited === null) {
        kill("SIGKILL");
        await Promise.race([exitedPromise, sleep(1e3)]);
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
    await sleep(500);
  }
  console.log(`[peeps] Appium ${bin} listening on ${url}; log ${logFile}`);
  return { url, logFile, stop };
}

// src/tools.ts
var import_node_child_process6 = require("node:child_process");
var import_promises7 = require("node:fs/promises");
var import_node_os5 = require("node:os");
var import_node_path10 = __toESM(require("node:path"));
var import_node_util2 = require("node:util");
var execFileAsync2 = (0, import_node_util2.promisify)(import_node_child_process6.execFile);
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
  const abs = import_node_path10.default.resolve(workspace, cleaned);
  const rel = import_node_path10.default.relative(workspace, abs);
  if (rel.startsWith("..") || import_node_path10.default.isAbsolute(rel)) {
    throw new ToolError(`path escapes the workspace: ${relative}`);
  }
  for (const seg of rel.split(import_node_path10.default.sep)) {
    if (DENY_SEGMENTS.has(seg)) throw new ToolError(`path is off limits: ${relative}`);
    if (/^\.env(\..*)?$/.test(seg)) throw new ToolError(`path is off limits: ${relative}`);
  }
  return abs;
}
function jailForWrite(workspace, relative) {
  const abs = jail(workspace, relative);
  const rel = import_node_path10.default.relative(workspace, abs).split(import_node_path10.default.sep).join("/");
  if (isCiConfiguration(rel)) {
    throw new ToolError(`workflow files are not writable by Peeps: ${relative}`);
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
  const parent = import_node_path10.default.dirname(abs);
  let existing = parent;
  for (; ; ) {
    try {
      await (0, import_promises7.stat)(existing);
      break;
    } catch {
      const up = import_node_path10.default.dirname(existing);
      if (up === existing) break;
      existing = up;
    }
  }
  const [realWorkspace, realExisting] = await Promise.all([(0, import_promises7.realpath)(workspace), (0, import_promises7.realpath)(existing)]);
  const rel = import_node_path10.default.relative(realWorkspace, realExisting);
  if (rel.startsWith("..") || import_node_path10.default.isAbsolute(rel)) {
    throw new ToolError(`path escapes the workspace: ${import_node_path10.default.relative(workspace, abs)}`);
  }
  if (existing !== parent) await (0, import_promises7.mkdir)(parent, { recursive: true });
}
async function patchPaths(runGit, patchFile) {
  let stdout;
  try {
    ({ stdout } = await runGit(["apply", "--numstat", patchFile]));
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
var SAFE_ENV_KEYS = /* @__PURE__ */ new Set(["PATH", "HOME", "PWD", "SHELL", "LANG", "TERM", "NODE_OPTIONS", "CI", "BASE_URL", "PEEPS_API_URL"]);
function createToolServer(env, deps = {}) {
  const workspace = env.workspace;
  const redact = makeRedactor(process.env);
  const runGit = (args, options = {}) => execFileAsync2("git", ["-c", `safe.directory=${workspace}`, ...args], {
    cwd: workspace,
    ...options
  });
  const handlers = {
    async read_file(args) {
      const abs = jail(workspace, str2(args, "path"));
      const info = await (0, import_promises7.stat)(abs);
      if (!info.isFile()) throw new ToolError("not a file");
      if (info.size > MAX_FILE_BYTES) throw new ToolError(`file is ${info.size} bytes; limit ${MAX_FILE_BYTES}`);
      return { path: str2(args, "path"), content: redact(await (0, import_promises7.readFile)(abs, "utf8")) };
    },
    async list_files(args) {
      const dir = jail(workspace, str2(args, "path", false) || ".");
      const out = [];
      const walk2 = async (d, rel, depth) => {
        if (out.length >= MAX_LIST || depth > 12) return;
        let entries;
        try {
          entries = await (0, import_promises7.readdir)(d, { withFileTypes: true });
        } catch {
          return;
        }
        for (const e of entries) {
          if (DENY_SEGMENTS.has(e.name) || e.name.startsWith(".env")) continue;
          const r = rel ? `${rel}/${e.name}` : e.name;
          if (e.isDirectory()) await walk2(import_node_path10.default.join(d, e.name), r, depth + 1);
          else if (e.isFile()) {
            out.push(r);
            if (out.length >= MAX_LIST) return;
          }
        }
      };
      await walk2(dir, str2(args, "path", false).replace(/^\.\/?$/, ""), 0);
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
        if (!/\.(ts|tsx|js|jsx|mjs|cjs|json|md|yml|yaml)$/.test(rel)) continue;
        let text2;
        try {
          text2 = await (0, import_promises7.readFile)(jail(workspace, rel), "utf8");
        } catch {
          continue;
        }
        const lines = text2.split("\n");
        for (let i = 0; i < lines.length && matches.length < MAX_GREP_MATCHES; i++) {
          if (pattern.test(lines[i])) matches.push({ path: rel, line: i + 1, text: redact(lines[i].slice(0, 300)) });
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
      await (0, import_promises7.writeFile)(abs, content, "utf8");
      return { path: rel, bytes: Buffer.byteLength(content) };
    },
    async apply_patch(args) {
      const patch = str2(args, "patch");
      const dir = await (0, import_promises7.mkdtemp)(import_node_path10.default.join((0, import_node_os5.tmpdir)(), "peeps-patch-"));
      const file = import_node_path10.default.join(dir, "change.patch");
      await (0, import_promises7.writeFile)(file, patch, "utf8");
      for (const touched of await patchPaths(runGit, file)) {
        jailForWrite(workspace, touched);
      }
      try {
        await runGit(["apply", "--whitespace=nowarn", file]);
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
      const abs = jail(workspace, file);
      if (resolveFramework(env) === "appium") {
        return runAppiumTests(
          env,
          { file: abs, grep: typeof args.grep === "string" && args.grep ? args.grep : void 0 },
          { redact, runner: deps.appiumRunner }
        );
      }
      const rel = import_node_path10.default.relative(env.workingDirectory, abs).split(import_node_path10.default.sep).join("/");
      const cmd = ["playwright", "test", "--reporter=json"];
      if (typeof args.grep === "string" && args.grep) cmd.push("--grep", args.grep);
      if (typeof args.project === "string" && args.project) cmd.push("--project", args.project);
      if (env.configPath) cmd.push("--config", env.configPath);
      cmd.push("--", rel);
      const started = Date.now();
      const { code, stdout, stderr } = await runCapture("npx", cmd, env.workingDirectory, 10 * 60 * 1e3);
      let report = null;
      try {
        report = JSON.parse(stdout);
      } catch {
      }
      return {
        exitCode: code,
        durationMs: Date.now() - started,
        results: summarizeReport(report),
        stderr: redact(stderr.slice(-8e3)),
        stdoutTail: report ? void 0 : redact(stdout.slice(-4e3))
      };
    },
    async git_status() {
      const { stdout } = await runGit(["status", "--porcelain"]);
      return { changedFiles: stdout.trim().split("\n").filter(Boolean).map(redact) };
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
      const remote = await runGit(["remote", "get-url", "origin"]);
      const url = authenticatedPushUrl(remote.stdout, token, env.platform);
      const git = (...a) => runGit(a);
      await git("config", "user.name", "peeps[bot]");
      await git(
        "config",
        "user.email",
        env.platform === "gitlab" ? "peeps-bot@noreply.peepsai.com" : "peeps[bot]@users.noreply.github.com"
      );
      await git("checkout", "-B", branch);
      await git("add", "-A", "--", ".", ":(exclude,glob)**/.peeps-*.wdio.conf.*");
      const commit = await git("commit", "-m", message).catch((e) => {
        throw new ToolError(`nothing to commit? ${redact((e.stderr ?? "").slice(0, 500))}`);
      });
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
      return { branch, sha, summary: redact(commit.stdout.split("\n")[0] ?? "") };
    }
  };
  const specs = [
    { name: "read_file", description: "Read a file in the repository (repo-relative path). Up to 512 KB.", inputSchema: obj2({ path: s("Repo-relative path") }, ["path"]) },
    { name: "list_files", description: "List files under a repository directory, recursively.", inputSchema: obj2({ path: s("Repo-relative directory; default the repository root") }, []) },
    { name: "grep", description: "Search source files for a regular expression; returns matching lines.", inputSchema: obj2({ pattern: s("JavaScript regular expression"), path: s("Repo-relative directory to search; default the root"), ignoreCase: { type: "boolean" } }, ["pattern"]) },
    { name: "write_file", description: "Replace a file's contents (repo-relative path). Creates the file if missing.", inputSchema: obj2({ path: s("Repo-relative path"), content: s("Full new contents") }, ["path", "content"]) },
    { name: "apply_patch", description: "Apply a unified diff to the repository with git apply.", inputSchema: obj2({ patch: s("Unified diff text") }, ["patch"]) },
    { name: "run_tests", description: "Run one spec file with the repository's own config (Playwright; WebdriverIO for an Appium suite); optionally filter by a grep regular expression over the test's full title, or by Playwright project. Returns per-test results and errors (Appium: plus a failure's evidence paths and page source).", inputSchema: obj2({ file: s("Repo-relative spec path"), grep: s("Optional --grep regular expression"), project: s("Optional Playwright project name (ignored for Appium)") }, ["file"]) },
    { name: "git_status", description: "Files changed in the working tree.", inputSchema: obj2({}, []) },
    { name: "git_diff", description: "Unified diff of the working tree against HEAD.", inputSchema: obj2({}, []) },
    { name: "git_commit_push", description: "Commit every change on a new peeps/* branch and push it, using the token Peeps provides for this call.", inputSchema: obj2({ branch: s("Branch name starting with peeps/"), message: s("Commit message"), token: s("The token Peeps minted for this push") }, ["branch", "message", "token"]) }
  ];
  return { specs, handlers };
}
function obj2(properties, required) {
  return { type: "object", properties, required, additionalProperties: false };
}
function s(description) {
  return { type: "string", description };
}
function summarizeReport(report) {
  if (!report || typeof report !== "object" || !("suites" in report)) return null;
  const tests = [];
  const walk2 = (suite, titles, isFile) => {
    const next = isFile ? titles : [...titles, suite.title];
    for (const spec of suite.specs ?? []) {
      const last = spec.tests?.[0]?.results?.at(-1);
      tests.push({
        title: [...next, spec.title].join(" \u203A "),
        file: spec.file,
        line: spec.line,
        status: last?.status ?? "unknown",
        error: last?.error?.message?.slice(0, 2e3),
        errorSnippet: last?.error?.snippet?.slice(0, 2e3)
      });
    }
    for (const child of suite.suites ?? []) walk2(child, next, false);
  };
  for (const suite of report.suites) walk2(suite, [], true);
  return tests;
}
function runCapture(cmd, args, cwd, timeoutMs) {
  return new Promise((resolve) => {
    const child = (0, import_node_child_process6.spawn)(cmd, args, { cwd, env: { ...process.env, CI: "1" }, stdio: ["ignore", "pipe", "pipe"] });
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
        workingDirectory: env.workingDirectory,
        configPath: env.configPath,
        framework,
        node: process.version,
        sha: env.sha,
        ref: env.ref,
        ...device ? { deviceTools: device.info() } : {}
      }
    }
  );
  const expiresAt = new Date(attach.expiresAt).getTime();
  console.log(`[peeps] agent session ${attach.sessionId} (${attach.kind}) attached; ${specs.length} tools; cap ${attach.expiresAt}`);
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
  host?.start();
  try {
    await serve(env, peeps, handlers, expiresAt);
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
async function serve(env, peeps, handlers, expiresAt) {
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
      `[peeps] #${call.seq} ${call.tool}(${summarizeArgs(call.args)}) \u2192 ${describeOutcome(outcome)} in ${Date.now() - started} ms`
    );
    try {
      await peeps.post(`/api/v1/bridge/sessions/${env.sessionId}/calls/${call.id}/result`, outcome);
    } catch (error) {
      console.log(`[peeps] could not deliver result for #${call.seq}: ${String(error).slice(0, 200)}`);
    }
  }
}
function describeOutcome(outcome) {
  if (!outcome.ok) return `error: ${outcome.error.slice(0, 120)}`;
  const result = outcome.result;
  if (result?.isError === true) {
    const first = result.content?.find((part) => part.type === "text")?.text;
    return `error: ${String(first ?? "").slice(0, 120)}`;
  }
  return "ok";
}
function summarizeArgs(args) {
  return Object.entries(args).filter(([k]) => k !== "token" && k !== "content" && k !== "patch" && k !== "text").map(([k, v]) => `${k}=${JSON.stringify(v).slice(0, 60)}`).join(", ");
}

// src/main.ts
function onDefaultBranch(env) {
  if (env.defaultBranch) return env.ref === `refs/heads/${env.defaultBranch}`;
  return env.ref === "refs/heads/main" || env.ref === "refs/heads/master";
}
async function main() {
  const env = readRunnerEnv();
  const peeps = new PeepsClient(env);
  const mode = env.mode === "ci" ? "report" : env.mode;
  console.log(
    `[peeps] mode=${mode} repo=${env.repository ?? "?"} sha=${env.sha?.slice(0, 7) ?? "?"} ref=${env.ref ?? "?"} peeps=${env.peepsUrl}`
  );
  const framework = mode === "agent" ? "playwright" : resolveFramework(env);
  if (framework === "pytest" || framework === "appium") {
    console.log(`[peeps] framework=${framework}`);
    const path11 = framework === "pytest" ? { inventory: runPytestInventory, report: runPytestReport, run: runPytestDispatched } : { inventory: runAppiumInventory, report: runAppiumReport, run: runAppiumDispatched };
    switch (mode) {
      case "inventory":
        await path11.inventory(env, peeps);
        return;
      case "report":
        if (onDefaultBranch(env)) {
          await path11.inventory(env, peeps).catch(
            (error) => console.log(`[peeps] inventory skipped: ${String(error)}`)
          );
        }
        await path11.report(env, peeps);
        return;
      case "run":
        await path11.run(env, peeps);
        return;
      default:
        throw new Error(`unknown mode ${mode}`);
    }
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
