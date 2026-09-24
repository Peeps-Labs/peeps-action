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
function readRunnerEnv(env = process.env) {
  const requestUrl = env.ACTIONS_ID_TOKEN_REQUEST_URL;
  const requestToken = env.ACTIONS_ID_TOKEN_REQUEST_TOKEN;
  const workspace = env.GITHUB_WORKSPACE ?? process.cwd();
  const workingDirectory = input(env, "working-directory");
  return {
    mode: input(env, "mode") ?? env.PEEPS_MODE ?? "ci",
    sessionId: input(env, "session-id") ?? env.PEEPS_SESSION_ID ?? null,
    configPath: input(env, "config") ?? env.PEEPS_PLAYWRIGHT_CONFIG ?? null,
    framework: input(env, "framework") ?? env.PEEPS_FRAMEWORK ?? null,
    peepsUrl: resolvePeepsUrl(env.PEEPS_API_URL ?? "https://app.peepsai.com"),
    workingDirectory: workingDirectory ? import_node_path.default.resolve(workspace, workingDirectory) : workspace,
    repository: env.GITHUB_REPOSITORY ?? null,
    sha: env.GITHUB_SHA ?? null,
    ref: env.GITHUB_REF ?? null,
    eventName: env.GITHUB_EVENT_NAME ?? null,
    defaultBranch: readDefaultBranch(env),
    runId: env.GITHUB_RUN_ID ?? null,
    workspace,
    oidc: requestUrl && requestToken ? { requestUrl, requestToken } : null
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
  if (!env.sha) throw new Error("GITHUB_SHA is not set");
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
      "No credentials: run inside GitHub Actions with `id-token: write`, or set PEEPS_API_KEY."
    );
  }
  /** Raw upload (artifacts). Retries transient failures a couple of times. */
  async postBytes(path7, bytes) {
    let lastError;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const response = await fetch(`${this.env.peepsUrl}${path7}`, {
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
          throw new Error(`Peeps ${path7} \u2192 ${response.status}: ${text.slice(0, 300)}`);
        }
        lastError = new Error(`Peeps ${path7} \u2192 ${response.status}`);
      } catch (error) {
        lastError = error;
      }
      await new Promise((r) => setTimeout(r, 1500 * (attempt + 1)));
    }
    throw lastError instanceof Error ? lastError : new Error(String(lastError));
  }
  /** GET that treats 204 as "nothing" (long-poll idle) instead of an error. */
  async getOrNull(path7) {
    const response = await fetch(`${this.env.peepsUrl}${path7}`, {
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
      throw new Error(`Peeps ${path7} \u2192 ${response.status}: ${text.slice(0, 500)}`);
    }
    return JSON.parse(text);
  }
  async get(path7) {
    const response = await fetch(`${this.env.peepsUrl}${path7}`, {
      headers: {
        Authorization: `Bearer ${await this.token()}`,
        Accept: "application/json",
        "User-Agent": "peeps-action/0.1"
      }
    });
    const text = await response.text();
    if (!response.ok) {
      throw new Error(`Peeps ${path7} \u2192 ${response.status}: ${text.slice(0, 500)}`);
    }
    return JSON.parse(text);
  }
  async post(path7, body) {
    const response = await fetch(`${this.env.peepsUrl}${path7}`, {
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
      throw new Error(`Peeps ${path7} \u2192 ${response.status}: ${text.slice(0, 500)}`);
    }
    return text ? JSON.parse(text) : {};
  }
};

// src/report.ts
var import_node_child_process2 = require("node:child_process");
var import_promises2 = require("node:fs/promises");
var import_node_os = require("node:os");
var import_node_path3 = __toESM(require("node:path"));
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
  if (!env.sha) throw new Error("GITHUB_SHA is not set");
  const list = await listTests(env);
  const rootDirAbs = list.config.rootDir ?? env.workingDirectory;
  const rootDir = import_node_path3.default.relative(env.workspace, rootDirAbs).split(import_node_path3.default.sep).join("/") || ".";
  const tests = plannedTestsOf(list, rootDir);
  console.log(`[peeps] report: ${tests.length} tests at ${env.sha.slice(0, 7)} (${env.ref ?? "?"})`);
  const jobUrl = env.repository && env.runId ? `https://github.com/${env.repository}/actions/runs/${env.runId}` : null;
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
  const scratch = await (0, import_promises2.mkdtemp)(import_node_path3.default.join(process.env.RUNNER_TEMP ?? (0, import_node_os.tmpdir)(), "peeps-"));
  const planFile = import_node_path3.default.join(scratch, "plan.json");
  const reportDir = import_node_path3.default.join(scratch, "report");
  const plan = { peepsUrl: env.peepsUrl, rootDir: input2.rootDir, runs: input2.runs };
  await (0, import_promises2.writeFile)(planFile, JSON.stringify(plan), { mode: 384 });
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
function runPlaywright(env, planFile, reportDir, selection) {
  const reporterPath = import_node_path3.default.join(__dirname, "reporter.js");
  const args = ["playwright", "test", `--reporter=${reporterPath},list,html`];
  if (env.configPath) args.push("--config", env.configPath);
  if (selection) {
    args.push("--grep", selection.grep, "--", ...selection.files);
  }
  return new Promise((resolve) => {
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
    child.on("close", (code) => resolve(code ?? 1));
  });
}
async function* walk(dir, rel = "") {
  let entries;
  try {
    entries = await (0, import_promises2.readdir)(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const abs = import_node_path3.default.join(dir, entry.name);
    const relPath = rel ? `${rel}/${entry.name}` : entry.name;
    if (entry.isDirectory()) yield* walk(abs, relPath);
    else if (entry.isFile()) yield { abs, rel: relPath };
  }
}
async function uploadReport(peeps, batchId, reportDir) {
  let uploaded = 0;
  for await (const file of walk(reportDir)) {
    const info = await (0, import_promises2.stat)(file.abs);
    if (info.size > MAX_UPLOAD_BYTES) {
      console.log(`[peeps] skipping ${file.rel}: ${info.size} bytes exceeds the upload limit`);
      continue;
    }
    const bytes = await (0, import_promises2.readFile)(file.abs);
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
var import_node_path4 = __toESM(require("node:path"));
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
  const rootDir = import_node_path4.default.relative(env.workspace, rootDirAbs).split(import_node_path4.default.sep).join("/") || ".";
  const plan = await peeps.post(`/api/v1/ci/batches/${env.sessionId}/plan`, {
    tests: plannedTestsOf(list, rootDir).slice(0, 2e3)
  });
  console.log(`[peeps] run: batch ${plan.batchNumber} holds ${plan.runs.length} run(s)`);
  if (plan.runs.length === 0) {
    await peeps.post(`/api/v1/ci/batches/${plan.batchId}/complete`, { reportUploaded: false });
    return;
  }
  const files = [...new Set(plan.runs.map((r) => r.path))].map(
    (p) => import_node_path4.default.relative(env.workingDirectory, import_node_path4.default.join(env.workspace, p)).split(import_node_path4.default.sep).join("/")
  );
  await executeAndReport(env, peeps, {
    rootDir,
    runs: plan.runs,
    batches: [{ batchId: plan.batchId, batchNumber: plan.batchNumber }],
    selection: { files, grep: grepFor(plan.runs.map((r) => r.titlePath)) }
  });
}

// src/tools.ts
var import_node_child_process3 = require("node:child_process");
var import_promises3 = require("node:fs/promises");
var import_node_os2 = require("node:os");
var import_node_path5 = __toESM(require("node:path"));
var import_node_util2 = require("node:util");
var execFileAsync2 = (0, import_node_util2.promisify)(import_node_child_process3.execFile);
var MAX_FILE_BYTES = 512 * 1024;
var MAX_LIST = 2e3;
var MAX_GREP_MATCHES = 500;
var MAX_PATTERN_CHARS = 500;
var DENY_SEGMENTS = /* @__PURE__ */ new Set([".git", "node_modules"]);
var ToolError = class extends Error {
};
function str(args, key, required = true) {
  const v = args[key];
  if (typeof v === "string" && v.length > 0) return v;
  if (!required) return "";
  throw new ToolError(`argument "${key}" must be a non-empty string`);
}
function jail(workspace, relative) {
  const cleaned = relative.replace(/\\/g, "/").replace(/^\/+/, "");
  const abs = import_node_path5.default.resolve(workspace, cleaned);
  const rel = import_node_path5.default.relative(workspace, abs);
  if (rel.startsWith("..") || import_node_path5.default.isAbsolute(rel)) {
    throw new ToolError(`path escapes the workspace: ${relative}`);
  }
  for (const seg of rel.split(import_node_path5.default.sep)) {
    if (DENY_SEGMENTS.has(seg)) throw new ToolError(`path is off limits: ${relative}`);
    if (/^\.env(\..*)?$/.test(seg)) throw new ToolError(`path is off limits: ${relative}`);
  }
  return abs;
}
function jailForWrite(workspace, relative) {
  const abs = jail(workspace, relative);
  const rel = import_node_path5.default.relative(workspace, abs).split(import_node_path5.default.sep).join("/");
  if (rel === ".github/workflows" || rel.startsWith(".github/workflows/")) {
    throw new ToolError(`workflow files are not writable by Peeps: ${relative}`);
  }
  return abs;
}
async function ensureParentDirInside(workspace, abs) {
  const parent = import_node_path5.default.dirname(abs);
  let existing = parent;
  for (; ; ) {
    try {
      await (0, import_promises3.stat)(existing);
      break;
    } catch {
      const up = import_node_path5.default.dirname(existing);
      if (up === existing) break;
      existing = up;
    }
  }
  const [realWorkspace, realExisting] = await Promise.all([(0, import_promises3.realpath)(workspace), (0, import_promises3.realpath)(existing)]);
  const rel = import_node_path5.default.relative(realWorkspace, realExisting);
  if (rel.startsWith("..") || import_node_path5.default.isAbsolute(rel)) {
    throw new ToolError(`path escapes the workspace: ${import_node_path5.default.relative(workspace, abs)}`);
  }
  if (existing !== parent) await (0, import_promises3.mkdir)(parent, { recursive: true });
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
  return (text) => text.replace(pattern, "[redacted]");
}
function isSecretish(key) {
  if (ALWAYS_MASK_KEYS.has(key)) return true;
  if (SAFE_ENV_KEYS.has(key)) return false;
  return !/^(GITHUB|RUNNER|ACTIONS|INPUT)_/.test(key);
}
var ALWAYS_MASK_KEYS = /* @__PURE__ */ new Set([
  "ACTIONS_ID_TOKEN_REQUEST_TOKEN",
  "ACTIONS_RUNTIME_TOKEN",
  "GITHUB_TOKEN"
]);
var SAFE_ENV_KEYS = /* @__PURE__ */ new Set(["PATH", "HOME", "PWD", "SHELL", "LANG", "TERM", "NODE_OPTIONS", "CI", "BASE_URL", "PEEPS_API_URL"]);
function createToolServer(env) {
  const workspace = env.workspace;
  const redact = makeRedactor(process.env);
  const runGit = (args, options = {}) => execFileAsync2("git", ["-c", `safe.directory=${workspace}`, ...args], {
    cwd: workspace,
    ...options
  });
  const handlers = {
    async read_file(args) {
      const abs = jail(workspace, str(args, "path"));
      const info = await (0, import_promises3.stat)(abs);
      if (!info.isFile()) throw new ToolError("not a file");
      if (info.size > MAX_FILE_BYTES) throw new ToolError(`file is ${info.size} bytes; limit ${MAX_FILE_BYTES}`);
      return { path: str(args, "path"), content: redact(await (0, import_promises3.readFile)(abs, "utf8")) };
    },
    async list_files(args) {
      const dir = jail(workspace, str(args, "path", false) || ".");
      const out = [];
      const walk2 = async (d, rel, depth) => {
        if (out.length >= MAX_LIST || depth > 12) return;
        let entries;
        try {
          entries = await (0, import_promises3.readdir)(d, { withFileTypes: true });
        } catch {
          return;
        }
        for (const e of entries) {
          if (DENY_SEGMENTS.has(e.name) || e.name.startsWith(".env")) continue;
          const r = rel ? `${rel}/${e.name}` : e.name;
          if (e.isDirectory()) await walk2(import_node_path5.default.join(d, e.name), r, depth + 1);
          else if (e.isFile()) {
            out.push(r);
            if (out.length >= MAX_LIST) return;
          }
        }
      };
      await walk2(dir, str(args, "path", false).replace(/^\.\/?$/, ""), 0);
      return { files: out.sort(), truncated: out.length >= MAX_LIST };
    },
    async grep(args) {
      const source = str(args, "pattern");
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
      const listed = await handlers.list_files({ path: str(args, "path", false) || "." });
      for (const rel of listed.files) {
        if (matches.length >= MAX_GREP_MATCHES) break;
        if (!/\.(ts|tsx|js|jsx|mjs|cjs|json|md|yml|yaml)$/.test(rel)) continue;
        let text;
        try {
          text = await (0, import_promises3.readFile)(jail(workspace, rel), "utf8");
        } catch {
          continue;
        }
        const lines = text.split("\n");
        for (let i = 0; i < lines.length && matches.length < MAX_GREP_MATCHES; i++) {
          if (pattern.test(lines[i])) matches.push({ path: rel, line: i + 1, text: redact(lines[i].slice(0, 300)) });
        }
      }
      return { matches, truncated: matches.length >= MAX_GREP_MATCHES };
    },
    async write_file(args) {
      const rel = str(args, "path");
      const abs = jailForWrite(workspace, rel);
      const content = str(args, "content");
      if (content.length > MAX_FILE_BYTES) throw new ToolError("content too large");
      await ensureParentDirInside(workspace, abs);
      await (0, import_promises3.writeFile)(abs, content, "utf8");
      return { path: rel, bytes: Buffer.byteLength(content) };
    },
    async apply_patch(args) {
      const patch = str(args, "patch");
      const dir = await (0, import_promises3.mkdtemp)(import_node_path5.default.join((0, import_node_os2.tmpdir)(), "peeps-patch-"));
      const file = import_node_path5.default.join(dir, "change.patch");
      await (0, import_promises3.writeFile)(file, patch, "utf8");
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
      const file = str(args, "file");
      const abs = jail(workspace, file);
      const rel = import_node_path5.default.relative(env.workingDirectory, abs).split(import_node_path5.default.sep).join("/");
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
      const branch = str(args, "branch");
      const message = str(args, "message");
      const token = str(args, "token");
      if (!branch.startsWith("peeps/")) throw new ToolError("branch must start with peeps/");
      const remote = await runGit(["remote", "get-url", "origin"]);
      const url = remote.stdout.trim().replace(/^https:\/\/(?:[^@]+@)?github\.com\//, `https://x-access-token:${token}@github.com/`);
      const git = (...a) => runGit(a);
      await git("config", "user.name", "peeps[bot]");
      await git("config", "user.email", "peeps[bot]@users.noreply.github.com");
      await git("checkout", "-B", branch);
      await git("add", "-A");
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
        const stderr = (e.stderr ?? e.message ?? "").replaceAll(token, "***").replace(/https:\/\/x-access-token:[^@\s]+@/g, "https://***@");
        throw new ToolError(`git push refused: ${stderr.slice(-600)}`);
      });
      const sha = (await git("rev-parse", "HEAD")).stdout.trim();
      return { branch, sha, summary: redact(commit.stdout.split("\n")[0] ?? "") };
    }
  };
  const specs = [
    { name: "read_file", description: "Read a file in the repository (repo-relative path). Up to 512 KB.", inputSchema: obj({ path: s("Repo-relative path") }, ["path"]) },
    { name: "list_files", description: "List files under a repository directory, recursively.", inputSchema: obj({ path: s("Repo-relative directory; default the repository root") }, []) },
    { name: "grep", description: "Search source files for a regular expression; returns matching lines.", inputSchema: obj({ pattern: s("JavaScript regular expression"), path: s("Repo-relative directory to search; default the root"), ignoreCase: { type: "boolean" } }, ["pattern"]) },
    { name: "write_file", description: "Replace a file's contents (repo-relative path). Creates the file if missing.", inputSchema: obj({ path: s("Repo-relative path"), content: s("Full new contents") }, ["path", "content"]) },
    { name: "apply_patch", description: "Apply a unified diff to the repository with git apply.", inputSchema: obj({ patch: s("Unified diff text") }, ["patch"]) },
    { name: "run_tests", description: "Run one Playwright spec file with the repository's own config; optionally filter by --grep or project. Returns per-test results and errors.", inputSchema: obj({ file: s("Repo-relative spec path"), grep: s("Optional --grep regular expression"), project: s("Optional Playwright project name") }, ["file"]) },
    { name: "git_status", description: "Files changed in the working tree.", inputSchema: obj({}, []) },
    { name: "git_diff", description: "Unified diff of the working tree against HEAD.", inputSchema: obj({}, []) },
    { name: "git_commit_push", description: "Commit every change on a new peeps/* branch and push it, using the GitHub token Peeps provides for this call.", inputSchema: obj({ branch: s("Branch name starting with peeps/"), message: s("Commit message"), token: s("Installation token Peeps minted for this push") }, ["branch", "message", "token"]) }
  ];
  return { specs, handlers };
}
function obj(properties, required) {
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
    const child = (0, import_node_child_process3.spawn)(cmd, args, { cwd, env: { ...process.env, CI: "1" }, stdio: ["ignore", "pipe", "pipe"] });
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
async function runAgent(env, peeps) {
  if (!env.sessionId) throw new Error("`session-id` is required in agent mode (Peeps passes it)");
  const server = createToolServer(env);
  const attach = await peeps.post(
    `/api/v1/bridge/sessions/${env.sessionId}/attach`,
    {
      tools: server.specs,
      runnerInfo: {
        workingDirectory: env.workingDirectory,
        configPath: env.configPath,
        node: process.version,
        sha: env.sha,
        ref: env.ref
      }
    }
  );
  const expiresAt = new Date(attach.expiresAt).getTime();
  console.log(`[peeps] agent session ${attach.sessionId} (${attach.kind}) attached; ${server.specs.length} tools; cap ${attach.expiresAt}`);
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
    const handler = server.handlers[call.tool];
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
      `[peeps] #${call.seq} ${call.tool}(${summarizeArgs(call.args)}) \u2192 ${outcome.ok ? "ok" : `error: ${outcome.error.slice(0, 120)}`} in ${Date.now() - started} ms`
    );
    try {
      await peeps.post(`/api/v1/bridge/sessions/${env.sessionId}/calls/${call.id}/result`, outcome);
    } catch (error) {
      console.log(`[peeps] could not deliver result for #${call.seq}: ${String(error).slice(0, 200)}`);
    }
  }
}
function summarizeArgs(args) {
  return Object.entries(args).filter(([k]) => k !== "token" && k !== "content" && k !== "patch").map(([k, v]) => `${k}=${JSON.stringify(v).slice(0, 60)}`).join(", ");
}

// src/pytest.ts
var import_node_child_process4 = require("node:child_process");
var import_node_crypto2 = require("node:crypto");
var import_node_fs2 = require("node:fs");
var import_promises4 = require("node:fs/promises");
var import_node_os3 = require("node:os");
var import_node_path6 = __toESM(require("node:path"));
var PLUGIN_DIR = import_node_path6.default.join(__dirname, "..", "python");
var PLUGIN = "peeps_pytest_plugin";
var PLAYWRIGHT_CONFIG = /^playwright(\..+)?\.config\.[cm]?[jt]s$/;
function resolveFramework(env) {
  const declared = env.framework;
  if (declared === "playwright" || declared === "pytest") return declared;
  if (declared !== null && declared !== "auto") {
    throw new Error(`unknown framework "${declared}": use playwright, pytest or auto`);
  }
  if (env.configPath) return "playwright";
  let names;
  try {
    names = (0, import_node_fs2.readdirSync)(env.workingDirectory);
  } catch {
    return "playwright";
  }
  if (names.some((name) => PLAYWRIGHT_CONFIG.test(name))) return "playwright";
  if (names.includes("pytest.ini") || names.includes("conftest.py")) return "pytest";
  const pyproject = import_node_path6.default.join(env.workingDirectory, "pyproject.toml");
  if ((0, import_node_fs2.existsSync)(pyproject) && /^\s*\[tool\.pytest(\.ini_options)?\]/m.test((0, import_node_fs2.readFileSync)(pyproject, "utf8"))) {
    return "pytest";
  }
  return "playwright";
}
var TITLE_PATH_SEPARATOR = " \u203A ";
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
    titlePath: scopes.join(TITLE_PATH_SEPARATOR) + (kept === null ? "" : `[${kept}]`)
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
  env.PYTHONPATH = process.env.PYTHONPATH ? `${PLUGIN_DIR}${import_node_path6.default.delimiter}${process.env.PYTHONPATH}` : PLUGIN_DIR;
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
    const child = (0, import_node_child_process4.spawn)(candidates[index], ["-m", "pytest", ...args], {
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
  const scratch = await (0, import_promises4.mkdtemp)(import_node_path6.default.join(process.env.RUNNER_TEMP ?? (0, import_node_os3.tmpdir)(), "peeps-collect-"));
  const out = import_node_path6.default.join(scratch, "collection.json");
  const { code, output } = await spawnPytest(
    ["--collect-only", "-q", "-p", PLUGIN, ...configArgs(env)],
    { cwd: env.workingDirectory, env: pytestEnv({ PEEPS_COLLECT_OUT: out }), capture: true }
  );
  if (![0, 2, 5].includes(code) || !(0, import_node_fs2.existsSync)(out)) {
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
function repoRelative(env, abs) {
  let workspace = env.workspace;
  try {
    workspace = (0, import_node_fs2.realpathSync)(workspace);
  } catch {
  }
  const rel = import_node_path6.default.relative(workspace, abs).split(import_node_path6.default.sep).join("/");
  if (rel === ".." || rel.startsWith("../") || import_node_path6.default.isAbsolute(rel)) {
    throw new Error(`${abs} is outside the repository (${env.workspace})`);
  }
  return rel;
}
function repoRootDir(env, collection) {
  return repoRelative(env, collection.rootDir) || ".";
}
async function moduleFilePayload(env, collection) {
  const modules = new Set(
    [...collection.items, ...collection.deselected ?? []].map((item) => item.nodeId.split("::")[0])
  );
  const files = [];
  for (const file of [...modules].sort()) {
    const abs = import_node_path6.default.join(collection.rootDir, file);
    const bytes = await (0, import_promises4.readFile)(abs);
    files.push({
      path: repoRelative(env, abs),
      blobSha: gitBlobSha(bytes),
      content: bytes.toString("utf8")
    });
  }
  return files;
}
async function buildPytestInventoryRequest(env, collection) {
  if (!env.sha) throw new Error("GITHUB_SHA is not set");
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
  if (!env.sha) throw new Error("GITHUB_SHA is not set");
  const collection = await collectPytest(env);
  const rootDir = repoRootDir(env, collection);
  const planned = plannedPytestTests(collection, rootDir);
  console.log(`[peeps] report: ${planned.length} tests at ${env.sha.slice(0, 7)} (${env.ref ?? "?"})`);
  const jobUrl = env.repository && env.runId ? `https://github.com/${env.repository}/actions/runs/${env.runId}` : null;
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
  const plan = await peeps.post(`/api/v1/ci/batches/${env.sessionId}/plan`, {
    tests: planned.map(({ path: p, titlePath, pwProject }) => ({ path: p, titlePath, pwProject })).slice(0, 2e3)
  });
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
    from = (0, import_node_fs2.realpathSync)(cwd);
  } catch {
  }
  const relative = import_node_path6.default.relative(from, import_node_path6.default.join(rootDirAbs, file)).split(import_node_path6.default.sep).join("/");
  return relative + rest;
}
async function executePytestAndReport(env, peeps, input2) {
  const scratch = await (0, import_promises4.mkdtemp)(import_node_path6.default.join(process.env.RUNNER_TEMP ?? (0, import_node_os3.tmpdir)(), "peeps-"));
  const planFile = import_node_path6.default.join(scratch, "plan.json");
  const resultsFile = import_node_path6.default.join(scratch, "results.json");
  const outputDir = import_node_path6.default.join(scratch, "output");
  const artifactsDir = import_node_path6.default.join(scratch, "evidence");
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
  const evidence = await stagedEvidence(import_node_path6.default.join(artifactsDir, "upload"), input2.byNodeId);
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
      if (run) map.set(import_node_path6.default.basename(dir), run.runId);
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
  const ext = import_node_path6.default.extname(flat);
  return `data/${(0, import_node_crypto2.createHash)("sha1").update(rel).digest("hex")}${ext}`;
}
async function* walkOutput(dir, rel = "") {
  let entries;
  try {
    entries = await (0, import_promises4.readdir)(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const abs = import_node_path6.default.join(dir, entry.name);
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
    staged.push({ abs: import_node_path6.default.join(uploadDir, name), name, runId });
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
  if (mode !== "agent" && resolveFramework(env) === "pytest") {
    console.log("[peeps] framework=pytest");
    switch (mode) {
      case "inventory":
        await runPytestInventory(env, peeps);
        return;
      case "report":
        if (onDefaultBranch(env)) {
          await runPytestInventory(env, peeps).catch(
            (error) => console.log(`[peeps] inventory skipped: ${String(error)}`)
          );
        }
        await runPytestReport(env, peeps);
        return;
      case "run":
        await runPytestDispatched(env, peeps);
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
