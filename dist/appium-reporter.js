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

// src/appium-reporter.ts
var appium_reporter_exports = {};
__export(appium_reporter_exports, {
  DATA_EXTENSIONS: () => DATA_EXTENSIONS,
  MAX_ATTACHMENT_BYTES: () => MAX_ATTACHMENT_BYTES,
  PeepsAppiumReporter: () => PeepsAppiumReporter,
  TITLE_PATH_SEPARATOR: () => TITLE_PATH_SEPARATOR,
  captureEvidence: () => captureEvidence,
  evidenceFileName: () => evidenceFileName,
  failureEvidence: () => failureEvidence,
  identityKey: () => identityKey,
  pageSourceExtension: () => pageSourceExtension,
  peepsAfterHook: () => peepsAfterHook,
  peepsAfterTest: () => peepsAfterTest,
  repoRelative: () => repoRelative,
  resetForTests: () => resetForTests,
  withPeeps: () => withPeeps
});
module.exports = __toCommonJS(appium_reporter_exports);
var import_node_fs = require("node:fs");
var import_node_path = __toESM(require("node:path"));
var import_node_url = require("node:url");
var TITLE_PATH_SEPARATOR = " \u203A ";
function repoRelative(workspace, abs) {
  const attempt = (root, file) => {
    const rel = import_node_path.default.relative(root, file).split(import_node_path.default.sep).join("/");
    return rel === "" || rel === ".." || rel.startsWith("../") || import_node_path.default.isAbsolute(rel) ? null : rel;
  };
  const direct = attempt(workspace, abs);
  if (direct !== null) return direct;
  try {
    return attempt((0, import_node_fs.realpathSync)(workspace), (0, import_node_fs.realpathSync)(abs));
  } catch {
    return null;
  }
}
function identityKey(test) {
  return `${test.path}
${test.titlePath}`;
}
var Plan = class {
  constructor(file) {
    this.file = file;
    for (const run of file.runs) {
      const key = identityKey(run);
      if (!this.entries.has(key)) this.entries.set(key, run);
    }
  }
  entries = /* @__PURE__ */ new Map();
  /** The run a test reports to: its spec file (absolute) and title chain. */
  entryFor(file, titles) {
    if (!file) return null;
    const rel = repoRelative(this.file.workspace, file.startsWith("file://") ? (0, import_node_url.fileURLToPath)(file) : file);
    if (rel === null) return null;
    return this.entries.get(identityKey({ path: rel, titlePath: titles.join(TITLE_PATH_SEPARATOR) })) ?? null;
  }
};
var cachedPlan;
function loadPlan() {
  if (cachedPlan !== void 0) return cachedPlan;
  const planPath = process.env.PEEPS_PLAN_FILE;
  if (!planPath) {
    cachedPlan = null;
    return null;
  }
  cachedPlan = new Plan(JSON.parse((0, import_node_fs.readFileSync)(planPath, "utf8")));
  return cachedPlan;
}
function resetForTests() {
  cachedPlan = void 0;
  captured.clear();
}
var DATA_EXTENSIONS = /* @__PURE__ */ new Set([
  "dat",
  "png",
  "jpg",
  "jpeg",
  "gif",
  "webp",
  "webm",
  "mp4",
  "zip",
  "md",
  "txt",
  "log",
  "json",
  "csv",
  "har",
  "pdf"
]);
var MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024;
var CAPTURE_TIMEOUT_MS = 2e4;
function evidenceFileName(runId, name) {
  let flat = name.replace(/\//g, "-").replace(/[^A-Za-z0-9._-]/g, "_").replace(/^\.+/, "") || "file";
  const ext = import_node_path.default.extname(flat).slice(1).toLowerCase();
  if (!DATA_EXTENSIONS.has(ext)) flat = `${flat}.dat`;
  return `${runId}-evidence-${flat}`;
}
function pageSourceExtension(source, context) {
  if (context && /^(WEBVIEW|CHROMIUM)/i.test(context)) return "html";
  const head = source.trimStart().slice(0, 512);
  if (/^<\?xml|^<hierarchy[\s>]|^<AppiumAUT[\s>]/i.test(head)) return "xml";
  if (/^<!doctype html|<html[\s>]/i.test(head)) return "html";
  return context && /^NATIVE/i.test(context) ? "xml" : "html";
}
var captured = /* @__PURE__ */ new Map();
function discardCaptured(runId) {
  for (const file of captured.get(runId)?.files ?? []) {
    try {
      (0, import_node_fs.unlinkSync)(file);
    } catch {
    }
  }
  captured.delete(runId);
}
function withTimeout(promise, label) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${label} timed out after ${CAPTURE_TIMEOUT_MS} ms`)), CAPTURE_TIMEOUT_MS);
    })
  ]).finally(() => clearTimeout(timer));
}
function reasonOf(error) {
  return `capture failed: ${(error instanceof Error ? error.message : String(error)).split("\n")[0].slice(0, 200)}`;
}
async function captureEvidence(runId, browser) {
  const artifacts = process.env.PEEPS_ARTIFACTS_DIR;
  if (!artifacts) return;
  discardCaptured(runId);
  const dir = import_node_path.default.join(artifacts, "upload");
  const out = { attachments: [], omitted: [], context: null, files: [] };
  const keep = (name, file) => {
    out.files.push(file);
    const size = (0, import_node_fs.statSync)(file).size;
    if (size > MAX_ATTACHMENT_BYTES) {
      (0, import_node_fs.unlinkSync)(file);
      out.omitted.push({ name, reason: `larger than ${MAX_ATTACHMENT_BYTES} bytes` });
      return;
    }
    out.attachments.push({ name, path: `data/${import_node_path.default.basename(file)}`, size });
  };
  try {
    (0, import_node_fs.mkdirSync)(dir, { recursive: true });
    try {
      const file = import_node_path.default.join(dir, evidenceFileName(runId, "screenshot.png"));
      await withTimeout(Promise.resolve(browser.saveScreenshot(file)), "saveScreenshot");
      keep("screenshot.png", file);
    } catch (error) {
      out.omitted.push({ name: "screenshot.png", reason: reasonOf(error) });
    }
    if (browser.isMobile && typeof browser.getContext === "function") {
      try {
        const context = await withTimeout(Promise.resolve(browser.getContext()), "getContext");
        const id = typeof context === "string" ? context : context?.id;
        out.context = typeof id === "string" ? id : null;
      } catch {
      }
    }
    let name = "page-source";
    try {
      const source = String(await withTimeout(Promise.resolve(browser.getPageSource()), "getPageSource"));
      name = `page-source.${pageSourceExtension(source, out.context)}`;
      const file = import_node_path.default.join(dir, evidenceFileName(runId, name));
      (0, import_node_fs.writeFileSync)(file, source);
      keep(name, file);
    } catch (error) {
      out.omitted.push({ name, reason: reasonOf(error) });
    }
  } catch (error) {
    console.log(`[peeps] evidence for ${runId} not captured: ${String(error)}`);
  }
  captured.set(runId, out);
}
function workerBrowser() {
  const browser = globalThis.browser;
  return browser && typeof browser.saveScreenshot === "function" && typeof browser.getPageSource === "function" ? browser : null;
}
function titlesOf(test) {
  return test && typeof test.titlePath === "function" ? test.titlePath() : null;
}
async function peepsAfterTest(_test, context, result) {
  try {
    if (!result || result.passed || !result.error) return;
    const plan = loadPlan();
    const titles = titlesOf(context?.test);
    const browser = workerBrowser();
    if (!plan || !titles || !browser) return;
    const entry = plan.entryFor(context?.test?.file, titles);
    if (entry) await captureEvidence(entry.runId, browser);
  } catch (error) {
    console.log(`[peeps] afterTest evidence not captured: ${String(error)}`);
  }
}
async function peepsAfterHook(_hook, context, result) {
  try {
    if (!result?.error || !/^"before each" hook/.test(context?.test?.title ?? "")) return;
    const plan = loadPlan();
    const titles = titlesOf(context?.currentTest);
    const browser = workerBrowser();
    if (!plan || !titles || !browser) return;
    const entry = plan.entryFor(context?.currentTest?.file, titles);
    if (entry) await captureEvidence(entry.runId, browser);
  } catch (error) {
    console.log(`[peeps] afterHook evidence not captured: ${String(error)}`);
  }
}
function trimMiddle(text, head = 2e3, tail = 1e4) {
  if (text.length <= head + tail) return text;
  return `${text.slice(0, head)}
\u2026 (trimmed) \u2026
${text.slice(-tail)}`;
}
function failureEvidence(error, phase, evidence) {
  const fields = {};
  if (error) {
    const message = error.message ?? "";
    fields.failure = {
      phase,
      exceptionType: error.name || error.type || null,
      message: message.slice(0, 4e3),
      traceback: trimMiddle(error.stack ?? message)
    };
  }
  if (evidence?.attachments.length) fields.attachments = evidence.attachments;
  if (evidence?.omitted.length) fields.attachmentsOmitted = evidence.omitted;
  if (evidence?.context) fields.properties = [{ name: "context", value: evidence.context }];
  return fields;
}
var BEFORE_HOOK = /^"before (all|each)" hook/;
var PeepsAppiumReporter = class {
  plan;
  /** The describe titles enclosing what runs now, outermost first. */
  suites = [];
  queues = /* @__PURE__ */ new Map();
  started = /* @__PURE__ */ new Set();
  ended = /* @__PURE__ */ new Set();
  attemptStart = /* @__PURE__ */ new Map();
  inflight = 0;
  file;
  constructor(_options) {
    this.plan = loadPlan();
    if (!this.plan) console.log("[peeps] PEEPS_PLAN_FILE is not set; nothing is reported");
  }
  /** WebdriverIO waits for this before the worker exits (`reporterSyncTimeout`). */
  get isSynchronised() {
    return this.inflight === 0;
  }
  emit(event, payload = {}) {
    if (!this.plan) return;
    switch (event) {
      case "runner:start":
        console.log(`[peeps] reporting ${this.plan.entries.size} planned run(s) to ${this.plan.file.peepsUrl}`);
        return;
      case "suite:start":
        this.suites.push(payload.title ?? "");
        if (payload.file) this.file = payload.file;
        return;
      case "suite:end":
        this.suites.pop();
        return;
      case "test:start":
        this.onTestStart(payload);
        return;
      case "test:pass":
        this.onTestEnd(payload, "passed");
        return;
      case "test:fail":
        this.onTestEnd(payload, "failed");
        return;
      case "test:pending":
        this.onTestEnd(payload, "skipped");
        return;
      case "test:retry":
        this.onTestRetry(payload);
        return;
      case "hook:end":
        if (payload.error && BEFORE_HOOK.test(payload.title ?? "")) this.onSetupFailure(payload);
        return;
      case "runner:end":
        for (const runId of this.queues.keys()) this.flush(runId);
        return;
      default:
        return;
    }
  }
  entryOf(payload) {
    return this.plan.entryFor(payload.file ?? this.file, [...this.suites, payload.title ?? ""]);
  }
  begin(entry, testName) {
    const now = Date.now();
    if (!this.started.has(entry.runId)) {
      this.started.add(entry.runId);
      this.enqueue(entry.runId, { type: "run_start", timestamp: now });
    }
    this.enqueue(entry.runId, { type: "test_start", timestamp: now, testName });
    this.attemptStart.set(entry.runId, now);
  }
  onTestStart(payload) {
    const entry = this.entryOf(payload);
    if (entry && !this.ended.has(entry.runId)) this.begin(entry, payload.title ?? "");
  }
  onTestEnd(payload, status) {
    const entry = this.entryOf(payload);
    if (!entry) {
      console.log(
        `[peeps] not planned, not reported: ${[...this.suites, payload.title ?? ""].join(TITLE_PATH_SEPARATOR)} (${status})`
      );
      return;
    }
    if (this.ended.has(entry.runId)) return;
    if (!this.attemptStart.has(entry.runId)) this.begin(entry, payload.title ?? "");
    const error = payload.error ?? payload.errors?.[0];
    const event = {
      type: "test_end",
      timestamp: Date.now(),
      testName: payload.title ?? "",
      status,
      duration: this.durationOf(entry.runId, payload)
    };
    if (status === "failed") {
      if (error?.message) event.error = error.message.slice(0, 4e3);
      if (error?.stack) event.errorStack = error.stack.slice(0, 8e3);
      Object.assign(event, failureEvidence(error, "call", captured.get(entry.runId)));
    }
    this.close(entry, event);
  }
  /** A failed attempt mocha retries: a failed `test_end`, without evidence. */
  onTestRetry(payload) {
    const entry = this.entryOf(payload);
    if (!entry || this.ended.has(entry.runId)) return;
    const error = payload.error ?? payload.errors?.[0];
    this.enqueue(entry.runId, {
      type: "test_end",
      timestamp: Date.now(),
      testName: payload.title ?? "",
      status: "failed",
      duration: this.durationOf(entry.runId, payload),
      error: (error?.message ?? "failed; retried").slice(0, 4e3),
      ...error?.stack ? { errorStack: error.stack.slice(0, 8e3) } : {}
    });
    this.attemptStart.delete(entry.runId);
    discardCaptured(entry.runId);
  }
  /**
   * A failed `before`/`beforeEach` hook: mocha runs none of the tests below
   * it and reports none of them. Each planned test there that has not ended
   * fails at setup, with the hook's error, as a pytest fixture error does.
   */
  onSetupFailure(payload) {
    const file = payload.file ?? this.file;
    const rel = file ? repoRelative(this.plan.file.workspace, file) : null;
    if (rel === null) return;
    const owner = payload.parent === "" ? 0 : this.suites.lastIndexOf(payload.parent ?? "") + 1;
    const scope = owner > 0 || payload.parent === "" ? this.suites.slice(0, owner) : this.suites;
    const prefix = scope.length ? scope.join(TITLE_PATH_SEPARATOR) + TITLE_PATH_SEPARATOR : "";
    const error = payload.error ?? payload.errors?.[0];
    for (const entry of this.plan.entries.values()) {
      if (entry.path !== rel || !entry.titlePath.startsWith(prefix) || this.ended.has(entry.runId)) continue;
      const testName = entry.titlePath.split(TITLE_PATH_SEPARATOR).pop() ?? "";
      if (!this.attemptStart.has(entry.runId)) this.begin(entry, testName);
      const message = `${payload.title ?? "a before hook"} failed: ${error?.message ?? ""}`;
      this.close(entry, {
        type: "test_end",
        timestamp: Date.now(),
        testName,
        status: "failed",
        duration: 0,
        error: message.slice(0, 4e3),
        ...error?.stack ? { errorStack: error.stack.slice(0, 8e3) } : {},
        ...failureEvidence(error, "setup", captured.get(entry.runId))
      });
    }
  }
  durationOf(runId, payload) {
    if (typeof payload.duration === "number" && Number.isFinite(payload.duration)) {
      return Math.max(0, Math.round(payload.duration));
    }
    const start = this.attemptStart.get(runId);
    return start === void 0 ? 0 : Date.now() - start;
  }
  close(entry, event) {
    this.enqueue(entry.runId, event);
    this.enqueue(entry.runId, { type: "run_end", timestamp: Date.now() });
    this.ended.add(entry.runId);
    this.attemptStart.delete(entry.runId);
    this.flush(entry.runId);
  }
  enqueue(runId, event) {
    const queue = this.queues.get(runId) ?? [];
    queue.push(event);
    this.queues.set(runId, queue);
  }
  flush(runId) {
    const events = this.queues.get(runId) ?? [];
    if (events.length === 0) return;
    this.queues.set(runId, []);
    const entry = this.plan.file.runs.find((run) => run.runId === runId);
    if (!entry) return;
    this.inflight += 1;
    void deliver(this.plan.file.peepsUrl, entry, events).finally(() => {
      this.inflight -= 1;
    });
  }
};
async function deliver(peepsUrl, entry, events) {
  const url = `${peepsUrl}/api/v1/runs/${entry.runId}/events`;
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
    if (attempt < 2) await new Promise((r) => setTimeout(r, 1e3 * (attempt + 1)));
  }
}
function hooksOf(value) {
  if (typeof value === "function") return [value];
  return Array.isArray(value) ? value.filter((h) => typeof h === "function") : [];
}
function isJunit(reporter) {
  const name = Array.isArray(reporter) ? reporter[0] : reporter;
  return name === "junit" || name === "@wdio/junit-reporter";
}
function withPeeps(base, options = {}) {
  if (!base || typeof base !== "object") throw new Error("the WebdriverIO config must export a `config` object");
  const reporters = Array.isArray(base.reporters) ? [...base.reporters] : [];
  reporters.push(PeepsAppiumReporter);
  if (options.junitDir && !reporters.some(isJunit)) {
    reporters.push([
      "junit",
      { outputDir: options.junitDir, outputFileFormat: (o) => `junit-${o.cid}.xml` }
    ]);
  }
  const config = {
    ...base,
    reporters,
    afterTest: [...hooksOf(base.afterTest), peepsAfterTest],
    afterHook: [...hooksOf(base.afterHook), peepsAfterHook],
    // Room for the last test's events to reach Peeps before the worker exits.
    reporterSyncTimeout: Math.max(Number(base.reporterSyncTimeout) || 5e3, 6e4)
  };
  if (options.specs) {
    config.specs = options.specs;
    config.exclude = [];
    if (Array.isArray(base.capabilities)) {
      config.capabilities = base.capabilities.map((cap) => {
        if (!cap || typeof cap !== "object") return cap;
        const { "wdio:specs": _s, "wdio:exclude": _e, ...rest } = cap;
        return rest;
      });
    }
  }
  if (options.grep !== void 0) {
    const mochaOpts = base.mochaOpts && typeof base.mochaOpts === "object" ? base.mochaOpts : {};
    config.mochaOpts = { ...mochaOpts, grep: options.grep, invert: false };
  }
  return config;
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  DATA_EXTENSIONS,
  MAX_ATTACHMENT_BYTES,
  PeepsAppiumReporter,
  TITLE_PATH_SEPARATOR,
  captureEvidence,
  evidenceFileName,
  failureEvidence,
  identityKey,
  pageSourceExtension,
  peepsAfterHook,
  peepsAfterTest,
  repoRelative,
  resetForTests,
  withPeeps
});
