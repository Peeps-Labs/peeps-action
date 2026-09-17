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
  TITLE_PATH_SEPARATOR: () => TITLE_PATH_SEPARATOR,
  default: () => PeepsCiReporter,
  identityOf: () => identityOf
});
module.exports = __toCommonJS(reporter_exports);
var import_node_fs = require("node:fs");
var import_node_path = __toESM(require("node:path"));
var TITLE_PATH_SEPARATOR = " \u203A ";
function identityOf(test, rootDirAbs, rootDirRepo) {
  const rel = import_node_path.default.relative(rootDirAbs, test.location.file).split(import_node_path.default.sep).join("/");
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
var PeepsCiReporter = class {
  plan;
  entries = /* @__PURE__ */ new Map();
  rootDirAbs = "";
  queues = /* @__PURE__ */ new Map();
  started = /* @__PURE__ */ new Set();
  pending = [];
  constructor() {
    const planPath = process.env.PEEPS_PLAN_FILE;
    if (!planPath) throw new Error("PEEPS_PLAN_FILE is not set");
    this.plan = JSON.parse((0, import_node_fs.readFileSync)(planPath, "utf8"));
    for (const entry of this.plan.runs) this.entries.set(key(entry), entry);
  }
  printsToStdio() {
    return false;
  }
  onBegin(config, _suite) {
    this.rootDirAbs = config.rootDir;
    console.log(`[peeps] reporting ${this.entries.size} planned run(s) to ${this.plan.peepsUrl}`);
  }
  onTestBegin(test) {
    const entry = this.entryFor(test);
    if (!entry) return;
    const now = Date.now();
    if (!this.started.has(entry.runId)) {
      this.started.add(entry.runId);
      this.enqueue(entry, { type: "run_start", timestamp: now });
    }
    this.enqueue(entry, { type: "test_start", timestamp: now, testName: test.title });
  }
  onTestEnd(test, result) {
    const entry = this.entryFor(test);
    if (!entry) {
      console.log(`[peeps] not planned, not reported: ${test.titlePath().join(" \u203A ")} (${result.status})`);
      return;
    }
    const error = result.errors[0];
    this.enqueue(entry, {
      type: "test_end",
      timestamp: Date.now(),
      testName: test.title,
      status: result.status,
      duration: Math.round(result.duration),
      error: error?.message?.slice(0, 4e3),
      errorStack: error?.stack?.slice(0, 8e3)
    });
    if (result.retry >= test.retries || result.status === "passed") {
      this.enqueue(entry, { type: "run_end", timestamp: Date.now() });
      this.pending.push(this.flush(entry));
    }
  }
  async onEnd() {
    for (const [runId, events] of this.queues) {
      if (events.length === 0) continue;
      const entry = this.plan.runs.find((r) => r.runId === runId);
      if (entry) this.pending.push(this.flush(entry));
    }
    await Promise.allSettled(this.pending);
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
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  TITLE_PATH_SEPARATOR,
  identityOf
});
