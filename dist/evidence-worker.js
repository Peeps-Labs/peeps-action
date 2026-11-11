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

// src/evidence/browser/worker.ts
var worker_exports = {};
__export(worker_exports, {
  installCoverage: () => installCoverage,
  pickPort: () => pickPort
});
module.exports = __toCommonJS(worker_exports);
var import_node_child_process = require("node:child_process");
var import_node_crypto = require("node:crypto");
var import_node_fs = require("node:fs");
var import_node_path = __toESM(require("node:path"));

// src/evidence/browser/cdp-coverage.ts
var COVERED = /* @__PURE__ */ new Set(["page", "iframe", "worker", "service_worker", "shared_worker"]);
var DOCUMENTS = /* @__PURE__ */ new Set(["page", "iframe"]);
var ASSET_TYPES = /* @__PURE__ */ new Set(["Script", "Stylesheet"]);
var SETTLE_MS = 300;
var CdpCoverage = class _CdpCoverage {
  constructor(cdp, options) {
    this.cdp = cdp;
    this.options = options;
    cdp.onClose?.(() => this.dead = true);
    cdp.onEvent((method, params, sessionId) => {
      try {
        this.onEvent(method, params, sessionId);
      } catch (error) {
        this.attempt.errors.push(`${method}: ${String(error)}`);
      }
    });
  }
  targets = /* @__PURE__ */ new Map();
  seen = /* @__PURE__ */ new Set();
  sheets = /* @__PURE__ */ new Map();
  documents = /* @__PURE__ */ new Set();
  attempt = _CdpCoverage.empty();
  /** The connection closed: nothing the browser runs from now on is seen, so no attempt is ever whole again. */
  dead = false;
  /** Setup replies still to come: a target runs before them is a target lost. */
  setups = /* @__PURE__ */ new Set();
  static empty() {
    return { ran: /* @__PURE__ */ new Map(), used: /* @__PURE__ */ new Map(), assets: /* @__PURE__ */ new Set(), covered: /* @__PURE__ */ new Set(), errors: [], navigations: 0 };
  }
  /** How many live pages of a browser context it has attached to. */
  pages(context) {
    return [...this.targets.values()].filter((t) => t.covered && !t.detached && t.type === "page" && t.context === context).length;
  }
  /** Once every setup reply so far is in (tests: run a page only after its coverage started). */
  async settled() {
    while (this.setups.size > 0) await Promise.allSettled([...this.setups]);
  }
  /** `settled`, for at most `ms`: a reply that hasn't come by then leaves its target unstarted. */
  async settledWithin(ms) {
    let timer;
    await Promise.race([this.settled(), new Promise((resolve) => timer = setTimeout(resolve, ms))]);
    clearTimeout(timer);
  }
  /** Attach to every target the browser has or opens. */
  async attach() {
    await this.cdp.send("Target.setAutoAttach", { autoAttach: true, waitForDebuggerOnStart: true, flatten: true });
  }
  /**
   * Start an attempt: what ran before it is taken and dropped, and so is a target that
   * can't answer (a closed context's service worker can stay attached, and silent).
   */
  async begin() {
    if (this.dead) return;
    for (const [sessionId, target] of this.targets) if (target.detached) this.targets.delete(sessionId);
    await Promise.all([...this.targets].map(([sessionId, target]) => this.take(target).catch(() => this.targets.delete(sessionId))));
    this.attempt = _CdpCoverage.empty();
    this.documents.clear();
    for (const target of this.targets.values()) {
      target.finalTaken = false;
      if (target.profiler && (!DOCUMENTS.has(target.type) || target.css)) target.proven = true;
      target.ranBefore = false;
      target.isolates.clear();
      target.isolateUnknown = false;
    }
  }
  /** A delta from every live target: before each test action, so a navigation it starts loses nothing. */
  async takeAll() {
    await Promise.all([...this.targets.values()].filter((t) => !t.detached).map((t) => this.take(t).catch(() => {
    })));
  }
  /**
   * The attempt's last deltas, and what it covered. Two scopes, kept apart:
   * - Completeness covers every target that contributed to the attempt, whatever its
   *   context. Each must be wholly seen: every domain it measures (JS, and CSS for a
   *   document) set up, and either taken successfully now or already taken finally. A
   *   target that isn't, live or gone, counts as `lost`, and the attempt reads partial.
   * - Finality is per context: only the closing context's targets (one with no context id,
   *   only at the last close) are taken finally, so a later close still checks the rest.
   */
  async finish(scope) {
    await this.settledWithin(this.options.settleMs ?? SETTLE_MS);
    if (this.dead) return { browser: this.options.browser, scripts: [], sheets: [], assets: [], covered: [], lost: 0, errors: [], navigations: 0, refused: "collector_disconnected" };
    const inScope = (t) => !scope || (t.context === void 0 ? scope.last : t.context === scope.context);
    const ready = (t) => t.profiler && (!DOCUMENTS.has(t.type) || t.css);
    const seen = /* @__PURE__ */ new Set();
    await Promise.all(
      [...this.targets.values()].filter((target) => !target.detached && target.profiler).map(
        (target) => this.take(target).then(
          () => {
            if (!ready(target)) return;
            seen.add(target);
            if (inScope(target)) target.finalTaken = true;
          },
          () => {
          }
        )
      )
    );
    await Promise.all([...this.targets.values()].filter((t) => t.covered && !t.detached).map((t) => this.readIsolate(t)));
    const covered = [...this.targets.values()].filter((t) => t.covered);
    const sharing = covered.filter(
      (t) => t.sharesIsolate || t.isolateUnknown || covered.some((u) => u !== t && [...t.isolates].some((id) => u.isolates.has(id)))
    );
    const lost = [...this.targets.values()].filter((t) => t.covered && !t.finalTaken && !seen.has(t));
    const late = [...this.targets.values()].filter((t) => t.covered && (!t.proven || t.ranBefore));
    const a = this.attempt;
    return {
      browser: this.options.browser,
      scripts: [...a.ran].map(([url, functions]) => ({ url, functions: [...functions.values()] })),
      sheets: [...a.used].map(([key, used]) => {
        const sheet = this.sheets.get(key);
        return { url: sheet.url, used, ...this.options.sheetText ? { text: sheet.text ?? "" } : {} };
      }),
      assets: [...a.assets],
      covered: [...a.covered, ...[...this.sheets.values()].map((s) => s.url).filter((url) => url !== "")],
      lost: lost.length,
      late: late.length,
      sharedIsolate: sharing.length,
      lateDetail: late.map((t) => ({ type: t.type, held: t.held, ranBefore: t.ranBefore })),
      lostDetail: lost.map((t) => ({ type: t.type, targetId: t.targetId, url: t.url, context: t.context ?? null, inScope: inScope(t), profiler: t.profiler, css: t.css, detached: t.detached })),
      errors: a.errors,
      navigations: a.navigations
    };
  }
  /** Which isolate the target runs in now, added to those it ran in. Unreadable is unknown, so shared. */
  readIsolate(target) {
    const read = this.cdp.send("Runtime.getIsolateId", {}, target.sessionId).then(
      (answer) => {
        const id = answer?.id;
        if (typeof id === "string" && id !== "") target.isolates.add(id);
        else if (!target.detached) target.isolateUnknown = true;
      },
      () => {
        if (!target.detached) target.isolateUnknown = true;
      }
    );
    this.setups.add(read);
    void read.finally(() => this.setups.delete(read));
    return read;
  }
  /** A take's functions that ran, into the attempt. */
  record(result) {
    for (const script of result) {
      if (script.url) this.attempt.covered.add(script.url);
      const ran = script.functions.filter((fn) => (fn.ranges[0]?.count ?? 0) > 0);
      if (ran.length === 0) continue;
      let functions = this.attempt.ran.get(script.url);
      if (!functions) this.attempt.ran.set(script.url, functions = /* @__PURE__ */ new Map());
      for (const fn of ran) {
        const { startOffset: start, endOffset: end } = fn.ranges[0];
        functions.set(`${start}:${end}`, { name: fn.functionName, start, end });
      }
    }
  }
  async take(target) {
    const send = (method) => this.cdp.send(method, {}, target.sessionId);
    if (target.profiler) {
      try {
        this.record((await send("Profiler.takePreciseCoverage"))?.result ?? []);
      } catch (error) {
        if (!target.detached) this.attempt.errors.push(`take js: ${String(error)}`);
        throw error;
      }
    }
    if (target.css) {
      try {
        const { coverage = [] } = await send("CSS.takeCoverageDelta");
        for (const rule of coverage) {
          const key = `${target.sessionId}:${rule.styleSheetId}`;
          if (!rule.used || !this.sheets.has(key)) continue;
          let used = this.attempt.used.get(key);
          if (!used) this.attempt.used.set(key, used = []);
          used.push({ start: rule.startOffset, end: rule.endOffset });
        }
      } catch (error) {
        if (!target.detached) this.attempt.errors.push(`take css: ${String(error)}`);
        throw error;
      }
    }
  }
  onEvent(method, params, sessionId) {
    if (method === "Target.attachedToTarget") return this.onAttached(params);
    if (method === "Target.detachedFromTarget") {
      const target = this.targets.get(params.sessionId);
      if (target) target.detached = true;
      return;
    }
    if (!sessionId || !this.targets.has(sessionId)) return;
    if (method === "CSS.styleSheetAdded") {
      const header = params.header;
      const sheet = { url: header.sourceURL ?? "", text: null };
      this.sheets.set(`${sessionId}:${header.styleSheetId}`, sheet);
      if (this.options.sheetText) {
        this.cdp.send("CSS.getStyleSheetText", { styleSheetId: header.styleSheetId }, sessionId).then((answer) => sheet.text = answer.text ?? null).catch(() => {
        });
      }
    } else if (method === "Page.frameNavigated") {
      const frame = params.frame;
      const navigated = this.targets.get(sessionId);
      if (navigated?.covered && !frame.parentId) void this.readIsolate(navigated);
      if (frame.url === "about:blank") return;
      const key = `${sessionId}:${frame.id}`;
      if (this.documents.has(key)) this.attempt.navigations++;
      this.documents.add(key);
    } else if (method === "Network.responseReceived") {
      const { type, response } = params;
      if (type && ASSET_TYPES.has(type) && response?.url && /^https?:/.test(response.url)) this.attempt.assets.add(response.url);
    }
  }
  onAttached({ sessionId, targetInfo, waitingForDebugger }) {
    const duplicate = this.seen.has(targetInfo.targetId);
    this.seen.add(targetInfo.targetId);
    const target = {
      sessionId,
      type: targetInfo.type,
      targetId: targetInfo.targetId,
      url: targetInfo.url ?? "",
      covered: !duplicate && COVERED.has(targetInfo.type),
      ...targetInfo.browserContextId ? { context: targetInfo.browserContextId } : {},
      profiler: false,
      css: false,
      detached: false,
      finalTaken: false,
      proven: false,
      held: waitingForDebugger === true,
      sharesIsolate: typeof targetInfo.openerId === "string" && targetInfo.canAccessOpener !== false,
      isolates: /* @__PURE__ */ new Set(),
      isolateUnknown: false,
      ranBefore: false
    };
    if (!duplicate) this.targets.set(sessionId, target);
    const send = (method, params = {}) => this.cdp.send(method, params, sessionId);
    const started = () => target.profiler && (!DOCUMENTS.has(target.type) || target.css);
    const job = (method, params = {}) => {
      const reply = send(method, params).then(
        () => {
          if (method === "Profiler.startPreciseCoverage") target.profiler = true;
          if (method === "CSS.startRuleUsageTracking") target.css = true;
          if (target.held && started()) target.proven = true;
        },
        (error) => {
          if (!target.detached) this.attempt.errors.push(`setup ${method}: ${String(error)}`);
        }
      );
      this.setups.add(reply);
      void reply.finally(() => this.setups.delete(reply));
    };
    if (!duplicate && COVERED.has(target.type)) {
      job("Profiler.enable");
      job("Profiler.startPreciseCoverage", { callCount: true, detailed: true });
      if (DOCUMENTS.has(target.type)) {
        job("DOM.enable");
        job("CSS.enable");
        job("CSS.startRuleUsageTracking");
        job("Page.enable");
      }
      send("Network.enable").catch(() => {
      });
    }
    job("Target.setAutoAttach", { autoAttach: true, waitForDebuggerOnStart: true, flatten: true });
    if (waitingForDebugger) job("Runtime.runIfWaitingForDebugger");
    if (!duplicate && COVERED.has(target.type)) void this.readIsolate(target);
    if (!duplicate && COVERED.has(target.type)) {
      const baseline = send("Profiler.takePreciseCoverage").then(
        (answer) => {
          const result = answer?.result ?? [];
          if (result.some((script) => script.url !== "" && !script.url.startsWith("__playwright") && script.functions.some((fn) => fn.ranges[0]?.startOffset === 0 && fn.ranges[0].count === 0)))
            target.ranBefore = true;
          this.record(result);
        },
        () => {
        }
      );
      this.setups.add(baseline);
      void baseline.finally(() => this.setups.delete(baseline));
    }
  }
};

// src/evidence/browser/cdp-socket.ts
var REPLY_TIMEOUT_MS = 5e3;
var CONNECT_DEADLINE_MS = 3e3;
async function connectCdp(port, options = {}) {
  const deadline = Date.now() + (options.deadlineMs ?? CONNECT_DEADLINE_MS);
  const left = () => Math.max(1, deadline - Date.now());
  const version = await (await fetch(`http://127.0.0.1:${port}/json/version`, { signal: AbortSignal.timeout(left()) })).json();
  if (!version.webSocketDebuggerUrl) throw new Error("The browser named no debugging socket");
  const socket = new WebSocket(version.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error("Could not open the browser's debugging socket in time"));
      socket.onerror = null;
      socket.close();
    }, left());
    socket.onopen = () => {
      clearTimeout(timer);
      resolve();
    };
    socket.onerror = () => {
      clearTimeout(timer);
      reject(new Error("Could not open the browser's debugging socket"));
    };
  });
  const closers = [];
  let closed = false;
  let next = 0;
  const pending = /* @__PURE__ */ new Map();
  const handlers = [];
  socket.onmessage = (event) => {
    const message = JSON.parse(String(event.data));
    if (message.id !== void 0) {
      const waiting = pending.get(message.id);
      if (!waiting) return;
      pending.delete(message.id);
      clearTimeout(waiting.timer);
      if (message.error) waiting.reject(new Error(message.error.message));
      else waiting.resolve(message.result);
    } else if (message.method) {
      for (const handler of handlers) handler(message.method, message.params, message.sessionId);
    }
  };
  const onClosed = () => {
    if (closed) return;
    closed = true;
    for (const waiting of pending.values()) {
      clearTimeout(waiting.timer);
      waiting.reject(new Error("The browser's debugging socket closed"));
    }
    pending.clear();
    for (const closer of closers) closer();
  };
  socket.onclose = onClosed;
  socket.onerror = onClosed;
  return {
    send(method, params = {}, sessionId) {
      if (closed) return Promise.reject(new Error("The browser's debugging socket closed"));
      const id = ++next;
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          pending.delete(id);
          reject(new Error(`No reply to ${method}`));
        }, REPLY_TIMEOUT_MS);
        pending.set(id, { resolve, reject, timer });
        socket.send(JSON.stringify({ id, method, params, ...sessionId ? { sessionId } : {} }));
      });
    },
    onEvent(handler) {
      handlers.push(handler);
    },
    close() {
      socket.close();
      onClosed();
    },
    onClose(handler) {
      closers.push(handler);
    }
  };
}

// src/evidence/browser/worker.ts
function pickPort() {
  const probe = "const s=require('net').createServer();s.listen(0,'127.0.0.1',()=>{process.stdout.write(String(s.address().port));s.close()})";
  const result = (0, import_node_child_process.spawnSync)(process.execPath, ["-e", probe], { encoding: "utf8", timeout: 5e3 });
  const port = Number(result.stdout);
  return Number.isSafeInteger(port) && port > 0 ? port : null;
}
var SAME_BROWSER_MS = 3e3;
var HOOK_MS = 8e3;
var empty = (browser, refused) => ({ browser, scripts: [], sheets: [], assets: [], covered: [], lost: 0, errors: [], navigations: 0, refused });
async function sameBrowser(browser, cdp) {
  const session = await browser.newBrowserCDPSession();
  try {
    const ids = (answer) => [...answer.browserContextIds ?? []].sort().join(",");
    const theirs = ids(await session.send("Target.getBrowserContexts"));
    return theirs !== "" && theirs === ids(await cdp.send("Target.getBrowserContexts"));
  } finally {
    await session.detach().catch(() => {
    });
  }
}
var attemptName = (prefix, attempt, contextId) => `${prefix}-${(0, import_node_crypto.createHash)("sha256").update(attempt.testId).digest("hex").slice(0, 16)}-${attempt.retry}-${contextId}.json`;
function installCoverage(input) {
  const instrumentation = input.core._instrumentation;
  if (!instrumentation?.addListener) return null;
  const hookMs = input.hookMs ?? HOOK_MS;
  const collectors = /* @__PURE__ */ new Map();
  const opened = /* @__PURE__ */ new Map();
  const write = (name, value) => {
    try {
      (0, import_node_fs.writeFileSync)(import_node_path.default.join(input.dir, name), JSON.stringify(value), { mode: 384, flag: "wx" });
      return true;
    } catch {
      return false;
    }
  };
  const tainted = /* @__PURE__ */ new Map();
  const attemptKey = (a) => `${a.testId}\0${a.retry}`;
  const flushTaints = () => {
    for (const taint of tainted.values()) {
      if (!taint.written) taint.written = write(attemptName("taint", taint, "attempt"), { testId: taint.testId, retry: taint.retry });
    }
  };
  process.once("exit", flushTaints);
  const within = (promise, ms) => Promise.race([promise, new Promise((_, reject) => setTimeout(() => reject(new Error("timed out")), ms).unref())]);
  const currentAttempt = () => {
    try {
      const { testId, retry } = input.test.info();
      return { testId, retry };
    } catch {
      return null;
    }
  };
  const collectorFor = (browser) => {
    let collector = collectors.get(browser);
    if (!collector) {
      collector = (async () => {
        const open = /* @__PURE__ */ new Set();
        let cdp;
        try {
          cdp = await (input.connect ?? connectCdp)(input.port);
        } catch {
          return { coverage: null, refused: "no_debugging_port", open };
        }
        try {
          if (!await within(sameBrowser(browser, cdp), SAME_BROWSER_MS).catch(() => false)) {
            cdp.close();
            return { coverage: null, refused: "not_this_browser", open };
          }
          const coverage = new CdpCoverage(cdp, { browser: browser.browserType().name() });
          await coverage.attach();
          return { coverage, cdp, open };
        } catch {
          cdp.close();
          return { coverage: null, refused: "collector_failed", open };
        }
      })();
      collectors.set(browser, collector);
    }
    return collector;
  };
  const cdpContextOf = async (collector) => {
    const answer = await collector.cdp.send("Target.getBrowserContexts");
    const claimed = new Set([...opened.values()].map((o) => o.cdpContext));
    const free = (answer.browserContextIds ?? []).filter((id) => !claimed.has(id));
    return free.length === 1 ? free[0] : null;
  };
  const listener = {
    runAfterCreateBrowserContext: async (context) => {
      const entry = { attempt: currentAttempt(), contextId: (0, import_node_crypto.randomUUID)(), collector: null, cdpContext: null };
      opened.set(context, entry);
      if (entry.attempt && !write(attemptName("ctx", entry.attempt, entry.contextId), { ...entry.attempt, contextId: entry.contextId })) {
        tainted.set(attemptKey(entry.attempt), { ...entry.attempt, written: false });
        flushTaints();
      }
      let joined = null;
      try {
        const browser = context.browser();
        if (!browser || browser.browserType().name() !== "chromium") return;
        entry.collector = collectorFor(browser);
        const collector = await within(entry.collector, hookMs);
        if (!collector.coverage) return;
        entry.cdpContext = await within(cdpContextOf(collector), hookMs);
        collector.open.add(context);
        joined = collector;
        if (collector.open.size === 1) await within(collector.coverage.begin(), hookMs);
      } catch {
        joined?.open.delete(context);
        entry.collector = Promise.resolve({ coverage: null, refused: "collector_failed", open: /* @__PURE__ */ new Set() });
      }
    },
    runBeforeCloseBrowserContext: async (context) => {
      const entry = opened.get(context);
      opened.delete(context);
      try {
        const attempt = currentAttempt();
        const browser = context.browser();
        const name = browser?.browserType().name() ?? "unknown";
        const version = browser?.version() ?? "";
        let coverage;
        if (!entry?.collector) {
          coverage = { browser: name, scripts: [], sheets: [], assets: [], covered: [], lost: 0, errors: [], navigations: 0 };
        } else {
          const collector = await within(entry.collector, hookMs).catch(() => ({ coverage: null, refused: "collector_timeout", open: /* @__PURE__ */ new Set() }));
          collector.open.delete(context);
          if (!collector.coverage) coverage = empty(name, collector.refused ?? "no_collector");
          else if (entry.cdpContext === null) coverage = empty(name, "context_unknown");
          else coverage = await within(collector.coverage.finish({ context: entry.cdpContext, last: collector.open.size === 0 }), hookMs).catch((error) => ({ ...empty(name, "take_failed"), errors: [String(error)] }));
        }
        if (!attempt || !entry?.attempt || attempt.testId !== entry.attempt.testId || attempt.retry !== entry.attempt.retry) return;
        if (tainted.has(attemptKey(attempt))) coverage = empty(name, "marker_failed");
        const file = { testId: attempt.testId, retry: attempt.retry, contextId: entry.contextId, browser: { name, version }, coverage };
        write(attemptName("cov", attempt, entry.contextId), file);
      } catch {
      }
    }
  };
  instrumentation.addListener(listener);
  const openContexts = async () => {
    let count = 0;
    for (const collector of collectors.values()) count += (await collector).open.size;
    return count;
  };
  const settled = async (deadlineMs = 2e3) => {
    const deadline = Date.now() + deadlineMs;
    for (const [context, entry] of opened) {
      const collector = entry.collector && await entry.collector;
      if (!collector?.coverage || entry.cdpContext === null) continue;
      while (collector.coverage.pages(entry.cdpContext) < context.pages().length && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 10));
      await collector.coverage.settled();
    }
  };
  return Object.assign(listener, { flushTaints, openContexts, settled });
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  installCoverage,
  pickPort
});
