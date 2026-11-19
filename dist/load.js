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

// src/load/engine.ts
var engine_exports = {};
__export(engine_exports, {
  PlanInputRefused: () => PlanInputRefused,
  runEngine: () => runEngine,
  startEngine: () => startEngine,
  validatePlanInput: () => validatePlanInput
});
module.exports = __toCommonJS(engine_exports);

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
    const name = c.text(journey.export, "plan.journey.export");
    if (name !== null && !IDENTIFIER.test(name)) c.fail("plan.journey.export", "must be an export name");
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
      const request = c.object(rawRequest, at, ["method", "path"]);
      if (!request) return;
      if (typeof request.method !== "string" || !ALLOWED_METHODS.has(request.method)) {
        c.fail(`${at}.method`, "must be POST, PUT, PATCH or DELETE");
      }
      const path3 = c.text(request.path, `${at}.path`);
      if (path3 !== null && (!path3.startsWith("/") || /[?#\s\\]/.test(path3))) {
        c.fail(`${at}.path`, "must be a path starting with /, without a query or fragment");
      }
      const key = `${String(request.method)} ${String(request.path)}`;
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
var import_node_crypto = require("node:crypto");
var import_node_fs2 = require("node:fs");
var import_node_os = require("node:os");
var import_node_path2 = __toESM(require("node:path"));
var import_node_perf_hooks = require("node:perf_hooks");

// src/load/accounting.ts
var emptyCounters = () => ({ due: 0, started: 0, missed: 0, success: 0, failure: 0, timeout: 0, interrupted: 0 });
var Accounting = class {
  constructor(intervalMs = 1e4) {
    this.intervalMs = intervalMs;
  }
  starts = /* @__PURE__ */ new Map();
  counters = /* @__PURE__ */ new Map();
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
    return { interval, fromMs: interval * this.intervalMs, untilMs, ...counters, inFlight, oldestInFlightMs: oldest };
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

// src/load/budget.ts
var MILLI = 1e3;
var PhaseGate = class {
  constructor(budget, phaseStartMs, absoluteEndMs) {
    this.budget = budget;
    this.phaseStartMs = phaseStartMs;
    this.absoluteEndMs = absoluteEndMs;
    this.milliTokens = budget.burst * MILLI;
    this.lastRefillMs = phaseStartMs;
  }
  milliTokens;
  lastRefillMs;
  issuedCount = 0;
  inFlightCount = 0;
  get issued() {
    return this.issuedCount;
  }
  get inFlight() {
    return this.inFlightCount;
  }
  get phaseEndMs() {
    return Math.min(this.phaseStartMs + this.budget.phaseDeadlineMs, this.absoluteEndMs);
  }
  refill(nowMs) {
    if (nowMs <= this.lastRefillMs) return;
    const added = (nowMs - this.lastRefillMs) * this.budget.ratePerSecond;
    this.milliTokens = Math.min(this.budget.burst * MILLI, this.milliTokens + added);
    this.lastRefillMs = nowMs;
  }
  /** Whether a turn that began at `turnStartMs` may send now; takes the permit when it may. */
  permit(nowMs, turnStartMs) {
    if (nowMs >= this.absoluteEndMs) return { ok: false, reason: "absolute_end", final: true };
    if (nowMs >= this.phaseStartMs + this.budget.phaseDeadlineMs) return { ok: false, reason: "phase_deadline", final: true };
    if (nowMs >= turnStartMs + this.budget.turnDeadlineMs) return { ok: false, reason: "turn_deadline", final: true };
    if (this.issuedCount >= this.budget.totalRequests) return { ok: false, reason: "total", final: true };
    if (this.inFlightCount >= this.budget.concurrency) return { ok: false, reason: "concurrency", final: false, retryInMs: 1 };
    this.refill(nowMs);
    if (this.milliTokens < MILLI) {
      const retryInMs = Math.ceil((MILLI - this.milliTokens) / this.budget.ratePerSecond);
      return { ok: false, reason: "rate", final: false, retryInMs };
    }
    this.milliTokens -= MILLI;
    this.issuedCount += 1;
    this.inFlightCount += 1;
    return { ok: true, seq: this.issuedCount };
  }
  /** A permitted request has finished (answered, failed or abandoned). */
  release() {
    if (this.inFlightCount > 0) this.inFlightCount -= 1;
  }
};

// src/load/clock.ts
var QualifiedClock = class {
  constructor(sources, bounds) {
    this.sources = sources;
    this.bounds = bounds;
    this.lastMono = sources.monoMs();
    this.lastWall = sources.wallMs();
  }
  lastMono;
  lastWall;
  elapsed = 0;
  fencedAt = null;
  reason = null;
  /** Elapsed milliseconds since the clock was made, as permission counts them. */
  get nowMs() {
    return this.elapsed;
  }
  get fenced() {
    return this.fencedAt !== null;
  }
  get fenceReason() {
    return this.reason;
  }
  /** When the current fence was raised, on this clock; null when not fenced. */
  get fencedAtMs() {
    return this.fencedAt;
  }
  tick() {
    const mono = this.sources.monoMs();
    const wall = this.sources.wallMs();
    const dMono = mono - this.lastMono;
    const dWall = wall - this.lastWall;
    this.lastMono = mono;
    this.lastWall = wall;
    this.elapsed += Math.max(0, dMono, dWall);
    let reason = null;
    if (dMono < 0 || dWall < 0) reason = "backwards";
    else if (dMono > this.bounds.maxGapMs || dWall > this.bounds.maxGapMs) reason = "gap";
    else if (Math.abs(dWall - dMono) > this.bounds.maxDivergenceMs) reason = "divergence";
    if (reason) {
      this.fencedAt = this.elapsed;
      this.reason = reason;
    }
    return this.elapsed;
  }
  /**
   * A renewal came back for a request sent at `sentAtMs` (this clock). It lifts the fence
   * only when that request was sent after the fence was raised. Returns whether the clock is
   * clear now.
   */
  renewed(sentAtMs) {
    if (this.fencedAt !== null && sentAtMs >= this.fencedAt) {
      this.fencedAt = null;
      this.reason = null;
    }
    return this.fencedAt === null;
  }
};

// src/load/containment.ts
var import_node_child_process = require("node:child_process");
var import_node_fs = require("node:fs");
var import_node_path = __toESM(require("node:path"));
var privilegeCache = null;
function privilege() {
  if (privilegeCache) return privilegeCache;
  const root = typeof process.getuid === "function" && process.getuid() === 0;
  let sudo = false;
  if (!root) {
    const probe = (0, import_node_child_process.spawnSync)("sudo", ["-n", "true"], { stdio: "ignore", timeout: 5e3 });
    sudo = probe.status === 0;
  }
  privilegeCache = { root, sudo };
  return privilegeCache;
}
function canUnshare(p) {
  const prefix = p.root ? [] : ["sudo", "-n"];
  if (!p.root && !p.sudo) return false;
  const [cmd, ...args] = [...prefix, "unshare", "--pid", "--fork", "--kill-child", "true"];
  const probe = (0, import_node_child_process.spawnSync)(cmd, args, { stdio: "ignore", timeout: 5e3 });
  return probe.status === 0;
}
function cgroupV2Dir() {
  let mountinfo;
  let self;
  try {
    mountinfo = (0, import_node_fs.readFileSync)("/proc/self/mountinfo", "utf8");
    self = (0, import_node_fs.readFileSync)("/proc/self/cgroup", "utf8");
  } catch {
    return null;
  }
  const mount = mountinfo.split("\n").map((line) => line.split(" ")).find((fields) => fields[fields.indexOf("-") + 1] === "cgroup2");
  const relative = self.split("\n").find((line) => line.startsWith("0::"))?.slice(3);
  if (!mount || relative === void 0) return null;
  return import_node_path.default.join(mount[4], relative);
}
function makeCgroup(name) {
  const base = cgroupV2Dir();
  if (!base) return null;
  const dir = import_node_path.default.join(base, `peeps-load-${name}`);
  try {
    (0, import_node_fs.mkdirSync)(dir);
  } catch {
    return null;
  }
  if (!(0, import_node_fs.existsSync)(import_node_path.default.join(dir, "cgroup.procs"))) {
    try {
      (0, import_node_fs.rmdirSync)(dir);
    } catch {
    }
    return null;
  }
  return dir;
}
function killCgroup(dir) {
  if ((0, import_node_fs.existsSync)(import_node_path.default.join(dir, "cgroup.kill"))) {
    try {
      (0, import_node_fs.writeFileSync)(import_node_path.default.join(dir, "cgroup.kill"), "1");
      return;
    } catch {
    }
  }
  try {
    for (const pid of (0, import_node_fs.readFileSync)(import_node_path.default.join(dir, "cgroup.procs"), "utf8").split("\n").filter(Boolean)) {
      try {
        process.kill(Number(pid), "SIGKILL");
      } catch {
      }
    }
  } catch {
  }
}
function spawnContained(spec, options) {
  const p = privilege();
  const prefer = options.prefer ?? "auto";
  const reasons = [];
  if (prefer === "auto" || prefer === "pid-namespace") {
    if (canUnshare(p)) return spawnInPidNamespace(spec, p);
    reasons.push(p.root || p.sudo ? "unshare --pid is not permitted here" : "neither root nor sudo");
  }
  if (prefer === "auto" || prefer === "cgroup") {
    const dir = makeCgroup(options.name);
    if (dir) return spawnInCgroup(spec, dir, p);
    reasons.push("no writable cgroup v2 directory");
  }
  return spawnLimited(spec, reasons.join("; ") || "limited containment was requested", p);
}
var STDIO = ["pipe", "pipe", "pipe"];
function spawnInPidNamespace(spec, p) {
  const unshare = ["unshare", "--pid", "--fork", "--kill-child", "--", spec.command, ...spec.args];
  let child;
  if (p.root) {
    child = (0, import_node_child_process.spawn)(unshare[0], unshare.slice(1), { env: spec.env, cwd: spec.cwd, stdio: STDIO, detached: true });
  } else {
    const assignments = Object.entries(spec.env).flatMap(([k, v]) => v === void 0 ? [] : [`${k}=${v}`]);
    child = (0, import_node_child_process.spawn)("sudo", ["-n", "env", "-i", ...assignments, ...unshare], { cwd: spec.cwd, stdio: STDIO, detached: true });
  }
  let hostPid = null;
  let killed = false;
  return {
    child,
    level: "pid-namespace",
    limitedBecause: null,
    startsAsRoot: true,
    enclose() {
    },
    setHostPid(pid) {
      hostPid = pid;
    },
    kill() {
      if (killed) return;
      killed = true;
      if (child.exitCode !== null || child.signalCode !== null) return;
      if (hostPid !== null) {
        if (p.root) {
          try {
            process.kill(hostPid, "SIGKILL");
          } catch {
          }
        } else {
          (0, import_node_child_process.spawnSync)("sudo", ["-n", "kill", "-KILL", String(hostPid)], { stdio: "ignore", timeout: 5e3 });
        }
      }
      try {
        if (child.pid) process.kill(-child.pid, "SIGKILL");
      } catch {
      }
      if (!p.root && child.pid) (0, import_node_child_process.spawnSync)("sudo", ["-n", "kill", "-KILL", String(child.pid)], { stdio: "ignore", timeout: 5e3 });
    },
    dispose() {
    }
  };
}
function spawnInCgroup(spec, dir, p) {
  const child = (0, import_node_child_process.spawn)(spec.command, spec.args, { env: spec.env, cwd: spec.cwd, stdio: STDIO, detached: true });
  let enclosed = false;
  return {
    child,
    level: "cgroup",
    limitedBecause: null,
    startsAsRoot: p.root,
    enclose() {
      if (enclosed || !child.pid) return;
      (0, import_node_fs.writeFileSync)(import_node_path.default.join(dir, "cgroup.procs"), String(child.pid));
      enclosed = true;
    },
    setHostPid() {
    },
    kill() {
      killCgroup(dir);
      try {
        if (child.pid) process.kill(-child.pid, "SIGKILL");
      } catch {
      }
    },
    dispose() {
      for (let i = 0; i < 50; i++) {
        try {
          (0, import_node_fs.rmdirSync)(dir);
          return;
        } catch {
          killCgroup(dir);
          (0, import_node_child_process.spawnSync)("sleep", ["0.02"]);
        }
      }
    }
  };
}
function spawnLimited(spec, because, p) {
  const child = (0, import_node_child_process.spawn)(spec.command, spec.args, { env: spec.env, cwd: spec.cwd, stdio: STDIO, detached: true });
  return {
    child,
    level: "limited",
    limitedBecause: because,
    startsAsRoot: p.root,
    enclose() {
    },
    setHostPid() {
    },
    kill() {
      try {
        if (child.pid) process.kill(-child.pid, "SIGKILL");
      } catch {
      }
    },
    dispose() {
    }
  };
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

// src/load/lease.ts
var Lease = class {
  constructor(bounds) {
    this.bounds = bounds;
  }
  untilMs = Number.NEGATIVE_INFINITY;
  acceptedSeq = 0;
  gen = 0;
  lostFlag = false;
  /** When permission ends, on the engine's clock. */
  get until() {
    return this.untilMs;
  }
  get generation() {
    return this.gen;
  }
  get lost() {
    return this.lostFlag;
  }
  /** Whether permission is running at `nowMs`. */
  held(nowMs) {
    return !this.lostFlag && nowMs < this.untilMs;
  }
  /** Marks the lease lost once permission it had has ended; true the one time it does. */
  check(nowMs) {
    if (this.lostFlag || this.acceptedSeq === 0 || nowMs < this.untilMs) return false;
    this.lostFlag = true;
    return true;
  }
  /** An answer to the request `seq` sent at `sentAtMs`, read at `nowMs`. */
  answer(seq, sentAtMs, answer, nowMs) {
    if (this.check(nowMs)) return { accepted: false, reason: "expired", lost: true };
    if (this.lostFlag) return { accepted: false, reason: "lost", lost: false };
    if (answer.seq !== seq) return { accepted: false, reason: "wrong_seq", lost: false };
    if (seq <= this.acceptedSeq) return { accepted: false, reason: "stale_seq", lost: false };
    if (!answer.granted) return { accepted: false, reason: "not_granted", lost: false };
    if (nowMs - sentAtMs > this.bounds.maxAgeMs) return { accepted: false, reason: "too_old", lost: false };
    const validFor = Math.min(this.bounds.leaseMs, answer.validForMs ?? this.bounds.leaseMs);
    const grant = sentAtMs + validFor;
    if (grant <= nowMs) return { accepted: false, reason: "expired", lost: false };
    this.acceptedSeq = seq;
    this.gen += 1;
    this.untilMs = Math.max(this.untilMs, grant);
    return { accepted: true, lost: false };
  }
};

// src/load/frames.ts
var MAX_FRAME_BYTES = 256 * 1024;
function encodeFrame(message) {
  const body = Buffer.from(JSON.stringify(message), "utf8");
  if (body.length > MAX_FRAME_BYTES) throw new Error(`frame of ${body.length} bytes is over the limit`);
  const head = Buffer.alloc(4);
  head.writeUInt32BE(body.length, 0);
  return Buffer.concat([head, body]);
}
var FrameError = class extends Error {
};
var FrameReader = class {
  buffer = Buffer.alloc(0);
  push(chunk) {
    this.buffer = this.buffer.length === 0 ? chunk : Buffer.concat([this.buffer, chunk]);
    const frames = [];
    while (this.buffer.length >= 4) {
      const length = this.buffer.readUInt32BE(0);
      if (length > MAX_FRAME_BYTES) throw new FrameError(`frame of ${length} bytes is over the limit`);
      if (this.buffer.length < 4 + length) break;
      const body = this.buffer.subarray(4, 4 + length).toString("utf8");
      this.buffer = this.buffer.subarray(4 + length);
      let parsed;
      try {
        parsed = JSON.parse(body);
      } catch {
        throw new FrameError("frame is not JSON");
      }
      if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed) || typeof parsed.t !== "string") {
        throw new FrameError("frame is not a message");
      }
      frames.push(parsed);
    }
    return frames;
  }
};

// src/load/policy.ts
var READ_METHODS = /* @__PURE__ */ new Set(["GET", "HEAD", "OPTIONS"]);
function checkRequest(policy, method, url) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return { ok: false, reason: "url" };
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return { ok: false, reason: "url" };
  if (parsed.username || parsed.password) return { ok: false, reason: "url" };
  if (!policy.allowedOrigins.includes(parsed.origin)) return { ok: false, reason: "origin" };
  const verb = method.toUpperCase();
  if (READ_METHODS.has(verb)) return { ok: true, origin: parsed.origin };
  const allowed = policy.allowedRequests.some((r) => r.method === verb && r.path === parsed.pathname);
  return allowed ? { ok: true, origin: parsed.origin } : { ok: false, reason: "method" };
}

// src/load/timing.ts
var HIST_VERSION = "hist/1";
var HIST_MAX_MICROS = 36e8;
var LINEAR = 128;
var SUB = 64;
function bucketOf(micros) {
  if (micros < LINEAR) return micros;
  const bits = Math.floor(Math.log2(micros)) + 1;
  let shift = bits - 7;
  let mantissa = Math.floor(micros / 2 ** shift);
  if (mantissa >= 2 * SUB) {
    shift += 1;
    mantissa = Math.floor(micros / 2 ** shift);
  } else if (mantissa < SUB) {
    shift -= 1;
    mantissa = Math.floor(micros / 2 ** shift);
  }
  return LINEAR + (shift - 1) * SUB + (mantissa - SUB);
}
function bucketUpper(bucket) {
  if (bucket < LINEAR) return bucket;
  const shift = Math.floor((bucket - LINEAR) / SUB) + 1;
  const mantissa = (bucket - LINEAR) % SUB + SUB;
  return (mantissa + 1) * 2 ** shift - 1;
}
function histogramOf(values) {
  const counts = /* @__PURE__ */ new Map();
  let overflow = 0;
  for (const value of values) {
    if (!Number.isSafeInteger(value) || value < 0) throw new RangeError(`not a duration in microseconds: ${value}`);
    if (value > HIST_MAX_MICROS) overflow += 1;
    else counts.set(bucketOf(value), (counts.get(bucketOf(value)) ?? 0) + 1);
  }
  return {
    v: HIST_VERSION,
    counts: [...counts.entries()].sort((a, b) => a[0] - b[0]),
    overflow,
    n: values.length
  };
}
function mergeHistograms(parts) {
  const counts = /* @__PURE__ */ new Map();
  let overflow = 0;
  let n = 0;
  for (const part of parts) {
    if (part.v !== HIST_VERSION) throw new Error(`cannot merge ${String(part.v)} into ${HIST_VERSION}`);
    for (const [bucket, count] of part.counts) counts.set(bucket, (counts.get(bucket) ?? 0) + count);
    overflow += part.overflow;
    n += part.n;
  }
  return { v: HIST_VERSION, counts: [...counts.entries()].sort((a, b) => a[0] - b[0]), overflow, n };
}
function percentile(hist, q) {
  if (!(q > 0 && q <= 1)) throw new RangeError("q must be in (0, 1]");
  if (hist.n === 0) return null;
  const rank = Math.ceil(q * hist.n);
  let seen = 0;
  for (const [bucket, count] of hist.counts) {
    seen += count;
    if (seen >= rank) return bucketUpper(bucket);
  }
  return "overflow";
}

// src/load/shared-clock.ts
function sharedNowMs() {
  return Number(process.hrtime.bigint()) / 1e6;
}

// src/load/supervisor.ts
var MAX_RENEWALS_IN_FLIGHT = 3;
var ALLOWED_ENV = ["PATH", "LANG", "LC_ALL", "TZ"];
var JOURNEY_ENV_NAME = /^[A-Z_][A-Z0-9_]*$/;
var JOURNEY_ENV_FORBIDDEN = /^(?:NODE_|LD_|DYLD_|UV_|PEEPS_LOAD_)/;
var realSources = { monoMs: () => import_node_perf_hooks.performance.now(), wallMs: () => Date.now() };
var Supervisor = class {
  constructor(input, port, options) {
    this.input = input;
    this.port = port;
    this.options = options;
    this.constants = { ...ENGINE_LIMITS, ...options.constants };
    this.budgets = engineBudgets(input, this.constants);
    this.clock = new QualifiedClock(options.clockSources ?? realSources, options.clockBounds ?? { maxDivergenceMs: 1e3, maxGapMs: 2e3 });
    this.runId = options.runId ?? (0, import_node_crypto.randomBytes)(6).toString("hex");
    this.ownsSpool = !options.spoolDir;
    this.spoolDir = options.spoolDir ?? (0, import_node_fs2.mkdtempSync)(import_node_path2.default.join((0, import_node_os.tmpdir)(), "peeps-load-spool-"));
    this.tickMs = options.tickMs ?? 20;
    this.heartbeatMs = options.heartbeatMs ?? Math.max(10, Math.min(250, Math.floor((options.deadManMs ?? this.budgets.leaseMs) / 4)));
    this.killGraceMs = options.killGraceMs ?? 2e3;
    this.maxRenewalAgeMs = options.maxRenewalAgeMs ?? Math.floor(this.budgets.leaseMs / 2);
    this.lease = new Lease({ leaseMs: this.budgets.leaseMs, maxAgeMs: this.maxRenewalAgeMs });
    this.scheduler = new Scheduler(input.plan.cohort, this.budgets.startSlackMs);
    this.accounting = new Accounting(options.intervalMs ?? 1e4);
    this.checkingAccounting = new Accounting(options.intervalMs ?? 1e4);
    this.done = new Promise((resolve) => this.resolveDone = resolve);
  }
  budgets;
  constants;
  clock;
  runId;
  spoolDir;
  ownsSpool;
  tickMs;
  heartbeatMs;
  killGraceMs;
  maxRenewalAgeMs;
  contained = null;
  reader = new FrameReader();
  executorExited = false;
  killed = false;
  isolation = { uid: null, level: "limited", limitedBecause: "not started" };
  playwrightVersion = null;
  lease;
  renewSeq = 0;
  /** Renewals asked and not yet answered. A few may overlap, so one lost answer doesn't stall
   * the lease; their answers can then arrive out of order, and only a newer seq counts. */
  renewalsInFlight = 0;
  lastRenewSentAt = Number.NEGATIVE_INFINITY;
  fenceMarked = false;
  /** The executor was told to load the journey. */
  went = false;
  phase = "starting";
  gate = null;
  accounting;
  checkingAccounting;
  phaseStart = 0;
  turnSeq = 0;
  turns = /* @__PURE__ */ new Map();
  busy = /* @__PURE__ */ new Set();
  pending = [];
  permitGates = /* @__PURE__ */ new Map();
  issued = [];
  denied = {};
  bypasses = [];
  bypassCount = 0;
  successMicros = [];
  checkingResult = { users: 0, success: 0, failure: 0, timeout: 0, failures: [] };
  /** Starts and misses; outcomes are the accounting's own totals, so every path counts once. */
  measured = { started: 0, missed: 0 };
  intervalsPublished = 0;
  stopMode = null;
  drainUntil = Number.POSITIVE_INFINITY;
  status = "finished";
  reason = null;
  finishing = false;
  resolveDone;
  done;
  timer = null;
  lastHeartbeat = Number.NEGATIVE_INFINITY;
  readyWaiter = null;
  scheduler;
  // ---------------------------------------------------------------- events and markers
  emit(event) {
    try {
      this.options.observer?.(event);
    } catch {
    }
  }
  marker(kind, detail) {
    const marker = { kind, atMs: this.clock.nowMs, ...detail ? { detail } : {} };
    this.emit({ type: "marker", marker, wallMs: Date.now() });
    this.port.publishMarker(marker).catch(() => void 0);
  }
  sendToExecutor(frame) {
    const stdin = this.contained?.child.stdin;
    if (!stdin || stdin.destroyed || this.executorExited) return;
    stdin.write(encodeFrame(frame));
  }
  // ---------------------------------------------------------------- start up
  async start() {
    this.renew();
    this.timer = setInterval(() => this.tick(), this.tickMs);
    try {
      await this.spawnExecutor(this.options.dropPrivileges ?? true);
    } catch (error) {
      if (this.finishing) return;
      if (this.stopMode === null) {
        this.status = "didnt_start";
        this.reason = error instanceof Error ? error.message : String(error);
      }
      await this.finish(true);
    }
  }
  /** Resolves once the lease is held and nothing stops or fences the run; rejects otherwise. */
  waitForLease() {
    return new Promise((resolve, reject) => {
      const check = () => {
        if (this.finishing || this.stopMode !== null) return reject(new Error("stopped before the journey was loaded"));
        const now = this.observe();
        if (this.lease.held(now) && !this.clock.fenced) return resolve();
        if (now > this.budgets.leaseMs) return reject(new Error("no lease"));
        setTimeout(check, this.tickMs);
      };
      check();
    });
  }
  async spawnExecutor(drop) {
    const executor = this.options.executorPath ?? import_node_path2.default.join(__dirname, "load-executor.js");
    const env = {};
    for (const key of ALLOWED_ENV) if (process.env[key]) env[key] = process.env[key];
    env.HOME = (0, import_node_os.tmpdir)();
    const baseURL = this.options.baseURL ?? this.input.limits.allowedOrigins[0];
    const journeyEnv = { ...this.options.executorEnv ?? {}, BASE_URL: baseURL };
    for (const key of Object.keys(journeyEnv)) {
      if (!JOURNEY_ENV_NAME.test(key) || JOURNEY_ENV_FORBIDDEN.test(key)) throw new Error(`the journey's environment may not set ${key}`);
    }
    this.contained = spawnContained(
      { command: process.execPath, args: [executor], env: { ...env, ...drop ? { PEEPS_LOAD_DROP_UID: "65534" } : {} }, cwd: "/" },
      { prefer: this.options.containment ?? "auto", name: this.runId }
    );
    const child = this.contained.child;
    this.executorExited = false;
    this.reader = new FrameReader();
    const current = () => this.contained?.child === child;
    child.stdout.on("data", (chunk) => {
      if (current()) this.onExecutorBytes(chunk);
    });
    child.stderr.on("data", (chunk) => {
      for (const line of chunk.toString("utf8").split("\n").filter(Boolean)) this.emit({ type: "log", line: line.slice(0, 2e3) });
    });
    child.on("exit", () => {
      if (!current()) return;
      this.executorExited = true;
      this.onExecutorExit();
    });
    child.stdin.on("error", () => void 0);
    const hello = await this.expect("hello", 15e3);
    this.contained.setHostPid(Number(hello.hostPid));
    this.emit({ type: "executor", pid: child.pid ?? null, hostPid: Number(hello.hostPid), containment: this.contained.level });
    this.sendToExecutor({
      t: "init",
      runId: this.runId,
      repositoryRoot: import_node_path2.default.resolve(this.options.repositoryRoot),
      workingDirectory: import_node_path2.default.resolve(this.options.workingDirectory ?? this.options.repositoryRoot),
      journey: this.input.plan.journey,
      baseURL,
      deadManMs: this.options.deadManMs ?? this.budgets.leaseMs,
      env: journeyEnv
    });
    this.contained.enclose();
    await this.waitForLease();
    this.went = true;
    this.sendToExecutor({ t: "go" });
    const ready = await this.expect("ready", 6e4);
    if (ready.t === "fatal") {
      if (ready.code === "unreadable" && drop) {
        this.kill("unreadable workspace");
        this.killed = false;
        this.contained.dispose();
        await this.spawnExecutor(false);
        this.isolation = { uid: this.isolation.uid, level: "limited", limitedBecause: "uid 65534 cannot read the workspace or node_modules" };
        return;
      }
      throw new Error(`the executor could not start: ${String(ready.message)}${ready.location ? ` (${String(ready.location)})` : ""}`);
    }
    this.playwrightVersion = String(ready.playwright);
    const uid = Number(hello.uid);
    this.isolation = hello.dropped ? { uid, level: "uid-65534", limitedBecause: null } : { uid, level: "limited", limitedBecause: drop ? "the supervisor is neither root nor able to use sudo" : "isolation was turned off" };
  }
  /** Waits for the next frame of type `t` (or `fatal`) during start-up. */
  expect(t, timeoutMs) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.readyWaiter = null;
        reject(new Error(`the executor did not say ${t} in time`));
      }, timeoutMs);
      this.readyWaiter = (frame) => {
        if (frame.t !== t && frame.t !== "fatal") return;
        clearTimeout(timer);
        this.readyWaiter = null;
        resolve(frame);
      };
      this.onEarlyExit = () => {
        clearTimeout(timer);
        reject(new Error("the executor exited while starting"));
      };
    });
  }
  onEarlyExit = null;
  // ---------------------------------------------------------------- executor messages
  /**
   * What the executor says is the journey's word too: the journey shares its process and can
   * write frames to fd 1 itself. A forged `done` frees a concurrency slot early, a forged
   * `outcome` falsifies results, and a raw `node:http` send that sets its own permit header is
   * not reported as a bypass. So concurrency, outcomes and the bypass counters are diagnostic
   * here, not enforced; what does hold against a hostile journey is the total, the rate and
   * the policy, since every permit is issued here. PR 3's host fence counts concurrency itself.
   */
  onExecutorBytes(chunk) {
    this.observe();
    let frames;
    try {
      frames = this.reader.push(chunk);
    } catch (error) {
      if (error instanceof FrameError) this.fail(`executor protocol: ${error.message}`, true);
      return;
    }
    for (const frame of frames) {
      if (this.readyWaiter) {
        this.readyWaiter(frame);
        continue;
      }
      this.onExecutorFrame(frame);
    }
  }
  onExecutorFrame(frame) {
    switch (frame.t) {
      case "started": {
        const turn = this.turns.get(String(frame.turn));
        if (turn) this.emit({ type: "started", turn: turn.id, user: turn.user, phase: turn.phase, wallMs: Number(frame.wallMs) });
        return;
      }
      case "ask":
        this.pending.push({ req: Number(frame.req), turn: String(frame.turn), method: String(frame.method), url: String(frame.url) });
        this.answerAsks();
        return;
      case "done": {
        const gate = this.permitGates.get(String(frame.permit));
        this.permitGates.delete(String(frame.permit));
        gate?.release();
        this.answerAsks();
        return;
      }
      case "outcome":
        this.onOutcome(String(frame.turn), frame.kind, frame);
        return;
      case "bypass": {
        this.bypassCount += 1;
        const sample = { kind: String(frame.kind), url: String(frame.url) };
        if (this.bypasses.length < 100) this.bypasses.push(sample);
        this.emit({ type: "bypass", ...sample });
        this.marker("bypass", `${sample.kind} ${sample.url}`);
        return;
      }
      case "stats":
        this.emit({ type: "log", line: `stats ${JSON.stringify(frame)}` });
        return;
      default:
        this.fail(`executor protocol: unexpected ${frame.t}`, true);
    }
  }
  onOutcome(id, kind, frame) {
    const turn = this.turns.get(id);
    if (!turn) return;
    this.turns.delete(id);
    this.busy.delete(turn.user);
    const now = this.observe();
    const message = typeof frame.message === "string" ? frame.message : void 0;
    const location = typeof frame.location === "string" ? frame.location : null;
    this.emit({ type: "outcome", turn: id, kind, phase: turn.phase, ...message ? { message, location } : {} });
    if (turn.phase === "checking") {
      if (kind !== "interrupted" && now >= turn.deadlineAt) kind = "timeout";
      this.checkingAccounting.outcome(id, kind, now - this.phaseStart);
      if (kind === "success") this.checkingResult.success += 1;
      else if (kind === "timeout" || kind === "interrupted") this.checkingResult.timeout += 1;
      else {
        this.checkingResult.failure += 1;
        if (this.checkingResult.failures.length < 10) this.checkingResult.failures.push({ message: message ?? kind, location });
      }
      return;
    }
    const final = this.accounting.record(id, kind, now - this.phaseStart);
    if (final === "success" && typeof frame.durationUs === "number") this.successMicros.push(Math.max(0, Math.round(frame.durationUs)));
  }
  onExecutorExit() {
    this.onEarlyExit?.();
    this.onEarlyExit = null;
    if (this.finishing || this.killed) return;
    this.fail("the executor exited", false);
  }
  // ---------------------------------------------------------------- lease
  renew() {
    if (this.renewalsInFlight >= MAX_RENEWALS_IN_FLIGHT || this.finishing) return;
    this.renewalsInFlight += 1;
    const seq = ++this.renewSeq;
    const sentAtMs = this.clock.nowMs;
    this.lastRenewSentAt = sentAtMs;
    this.port.renewLease({ seq, sentAtMs }).then((answer) => this.onLease(seq, sentAtMs, answer)).catch(() => this.emit({ type: "renewal", seq, accepted: false, reason: "error", generation: this.lease.generation, wallMs: Date.now() })).finally(() => {
      this.renewalsInFlight -= 1;
    });
  }
  onLease(seq, sentAtMs, answer) {
    const now = this.observe();
    const verdict = this.lease.answer(seq, sentAtMs, answer, now);
    this.emit({ type: "renewal", seq, accepted: verdict.accepted, ...verdict.reason ? { reason: verdict.reason } : {}, generation: this.lease.generation, wallMs: Date.now() });
    if (verdict.lost) this.loseLease(now);
    if (answer.stop && answer.seq === seq && !this.lease.lost) this.stop(answer.stop);
    if (!verdict.accepted) return;
    if (this.clock.fenced) {
      if (this.clock.renewed(sentAtMs)) {
        this.fenceMarked = false;
        this.marker("resume_cleared");
      }
    }
  }
  /**
   * Samples the clock (raising a fence on a gap) and checks the lease against it. Called by
   * the timer and before anything the executor or the port says is admitted.
   */
  observe() {
    if (this.finishing) return this.clock.nowMs;
    const before = this.clock.fenced;
    const now = this.clock.tick();
    if (this.clock.fenced && (!before || !this.fenceMarked)) {
      this.fenceMarked = true;
      this.marker("resume_fence", this.clock.fenceReason ?? void 0);
    }
    if (this.lease.check(now)) this.loseLease(now);
    return now;
  }
  /** Lease lost: no start or permit from its end; drain for the grace, then the kill. */
  loseLease(now) {
    if (this.stopMode === "now" || this.finishing) return;
    this.stopMode = "lease";
    this.status = "lease_lost";
    this.reason = "the lease was not renewed";
    this.drainUntil = now + this.budgets.stopGraceMs;
    this.marker("lease_lost");
    this.marker("starts_fenced");
  }
  /** An instant on the engine's clock, on the shared monotonic clock the executor reads. */
  shared(engineMs) {
    return sharedNowMs() + (engineMs - this.clock.nowMs);
  }
  // ---------------------------------------------------------------- stopping
  stop(mode) {
    if (this.finishing) return;
    if (this.stopMode === "now" || this.stopMode === mode) return;
    if (this.stopMode === null) this.marker("stop_requested", mode);
    if (mode === "now") {
      this.stopMode = "now";
      this.status = "stopped";
      this.reason = "stop now";
      this.marker("starts_fenced");
      void this.finish(true);
      return;
    }
    if (this.stopMode === null) {
      this.stopMode = "graceful";
      this.status = "stopped";
      this.reason = "stopped";
      this.drainUntil = this.clock.nowMs + this.budgets.stopGraceMs;
      this.marker("starts_fenced");
    }
  }
  fail(reason, kill) {
    if (this.finishing) return;
    this.status = "failed";
    this.reason = reason;
    void this.finish(kill);
  }
  kill(why) {
    if (this.killed || !this.contained) return;
    this.killed = true;
    this.contained.kill();
    this.marker("executor_killed", why);
  }
  // ---------------------------------------------------------------- the loop
  permitted(now) {
    return !this.clock.fenced && this.lease.held(now) && this.stopMode !== "now" && this.stopMode !== "lease" && !this.executorExited;
  }
  canStart(now) {
    return this.permitted(now) && this.stopMode === null;
  }
  startTurn(user, phase, now) {
    const gate = this.gate;
    const deadlineIn = Math.max(0, Math.min(this.budgets[phase].turnDeadlineMs, gate.phaseEndMs - (now - this.phaseStart)));
    const id = `${phase === "checking" ? "c" : "m"}${++this.turnSeq}`;
    const turn = { id, user, phase, startAt: now, deadlineAt: now + deadlineIn, sends: 0 };
    this.turns.set(id, turn);
    this.busy.add(user);
    this.sendToExecutor({
      t: "start",
      turn: id,
      user,
      deadlineAt: this.shared(turn.deadlineAt),
      leaseEndsAt: this.shared(this.lease.until),
      generation: this.lease.generation
    });
    return turn;
  }
  answerAsks() {
    if (this.pending.length === 0) return;
    const now = this.observe();
    const still = [];
    for (const ask of this.pending) {
      const deny = (reason) => {
        this.denied[reason] = (this.denied[reason] ?? 0) + 1;
        this.sendToExecutor({ t: "deny", req: ask.req, reason });
      };
      const turn = this.turns.get(ask.turn);
      if (!turn) {
        deny("turn_over");
        continue;
      }
      if (now >= turn.deadlineAt) {
        deny("turn_deadline");
        continue;
      }
      if (!this.permitted(now)) {
        if (this.clock.fenced && this.stopMode === null && this.lease.held(now)) still.push(ask);
        else deny(this.clock.fenced ? "fenced" : "lease");
        continue;
      }
      if (this.stopMode === "graceful" && now >= this.drainUntil) {
        deny("stopped");
        continue;
      }
      const policy = checkRequest(
        { allowedOrigins: this.input.limits.allowedOrigins, allowedRequests: this.input.plan.allowedRequests },
        ask.method,
        ask.url
      );
      if (!policy.ok) {
        deny(policy.reason);
        continue;
      }
      if (turn.sends >= this.input.plan.requests.perJourneyMax) {
        deny("per_journey");
        continue;
      }
      const gate = this.gate;
      const answer = gate.permit(now - this.phaseStart, turn.startAt - this.phaseStart);
      if (answer.ok) {
        turn.sends += 1;
        const id = `${this.runId}.${turn.phase === "checking" ? "c" : "m"}.${answer.seq}`;
        this.issued.push(id);
        this.permitGates.set(id, gate);
        const generation = this.lease.generation;
        this.emit({ type: "permit", id, turn: turn.id, method: ask.method, url: ask.url, generation, wallMs: Date.now() });
        const expiresAt = Math.min(turn.deadlineAt, this.lease.until, now + (this.options.permitTtlMs ?? 1e3));
        this.sendToExecutor({ t: "permit", req: ask.req, id, expiresAt: this.shared(expiresAt), generation });
      } else if (answer.final) deny(answer.reason);
      else still.push(ask);
    }
    this.pending = still;
  }
  tick() {
    if (this.finishing) return;
    const now = this.observe();
    if (this.finishing) return;
    if (now - this.lastRenewSentAt >= this.budgets.leaseMs / 3 || this.clock.fenced && this.lastRenewSentAt < (this.clock.fencedAtMs ?? 0)) {
      this.renew();
    }
    if (now - this.lastHeartbeat >= this.heartbeatMs) {
      this.lastHeartbeat = now;
      this.sendToExecutor({ t: "hb", generation: this.lease.generation });
    }
    if (now >= this.budgets.absoluteEndMs) {
      if (this.stopMode === null) this.status = "stopped";
      this.reason = "the run reached its absolute end";
      void this.finish(true);
      return;
    }
    if (this.phase === "starting") {
      if (this.stopMode !== null) void this.finish(true);
      else if (this.went && this.playwrightVersion !== null && this.canStart(now)) this.beginChecking(now);
      return;
    }
    for (const turn of this.turns.values()) {
      if (now > turn.deadlineAt + this.killGraceMs) {
        this.status = "failed";
        this.reason = "the executor stopped responding";
        void this.finish(true);
        return;
      }
    }
    this.answerAsks();
    if (this.phase === "checking") this.tickChecking(now);
    else if (this.phase === "measurement") this.tickMeasurement(now);
  }
  beginChecking(now) {
    const users = this.budgets.checking.users;
    this.phase = "checking";
    this.phaseStart = now;
    this.gate = new PhaseGate(this.budgets.checking, 0, this.budgets.absoluteEndMs - now);
    this.checkingResult.users = users;
    this.marker("phase_started", "checking");
    for (let user = 1; user <= users; user++) {
      const turn = this.startTurn(user, "checking", now);
      this.checkingAccounting.start(turn.id, 0, 0, turn.deadlineAt - now);
    }
  }
  tickChecking(now) {
    const elapsed = now - this.phaseStart;
    if (this.turns.size > 0 && elapsed >= this.budgets.checking.phaseDeadlineMs) {
      for (const turn of [...this.turns.values()]) this.onOutcome(turn.id, "timeout", { t: "outcome" });
      if (this.stopMode === null) this.status = "didnt_start";
      this.reason = "checking timed out";
      void this.finish(true);
      return;
    }
    if (this.stopMode !== null) {
      if (this.turns.size === 0 || now >= this.drainUntil) {
        this.status = this.stopMode === "lease" ? "lease_lost" : "stopped";
        void this.finish(this.turns.size > 0);
      }
      return;
    }
    if (this.turns.size > 0) {
      if (elapsed >= this.budgets.checking.phaseDeadlineMs) {
        this.status = "didnt_start";
        this.reason = "checking timed out";
        void this.finish(true);
      }
      return;
    }
    if (this.checkingResult.success !== this.checkingResult.users) {
      this.status = "didnt_start";
      this.reason = "checking failed";
      void this.finish(false);
      return;
    }
    const left = Math.max(0, this.input.limits.requestBudget - this.gate.issued);
    const measurement = { ...this.budgets.measurement, totalRequests: Math.min(this.budgets.measurement.totalRequests, left) };
    this.phase = "measurement";
    this.phaseStart = now;
    this.gate = new PhaseGate(measurement, 0, this.budgets.absoluteEndMs - now);
    this.marker("phase_started", "measurement");
    this.tickMeasurement(now);
  }
  tickMeasurement(now) {
    const planNow = now - this.phaseStart;
    const poll = this.scheduler.poll(planNow, (user) => this.busy.has(user));
    for (const order of poll.starts) {
      this.accounting.due(order.dueMs);
      if (this.canStart(now)) {
        const turn = this.startTurn(order.userId, "measurement", now);
        this.accounting.start(turn.id, planNow, order.stage, turn.deadlineAt - this.phaseStart);
        this.measured.started += 1;
      } else {
        this.accounting.missed(planNow);
        this.measured.missed += 1;
      }
    }
    for (const missed of poll.missed) {
      this.accounting.due(missed.dueMs);
      this.accounting.missed(missed.dueMs);
      this.measured.missed += 1;
    }
    this.accounting.expire(planNow);
    this.publish(planNow, false);
    const grace = this.budgets.stopGraceMs;
    if (planNow >= this.input.plan.durationMs + grace) {
      if (this.turns.size > 0) this.reason = "turns still running at the end of the grace";
      void this.finish(this.turns.size > 0);
      return;
    }
    if (this.stopMode !== null) {
      if (this.turns.size === 0 || now >= this.drainUntil) void this.finish(this.turns.size > 0);
      return;
    }
    if (this.scheduler.finished(planNow) && this.turns.size === 0) void this.finish(false);
  }
  publish(planNow, force) {
    const intervals = this.accounting.closeIntervals(force ? Math.ceil((planNow + 1) / this.accounting.intervalMs) * this.accounting.intervalMs : planNow);
    for (const record of intervals) {
      this.intervalsPublished += 1;
      const published = { ...record, phase: "measurement" };
      try {
        (0, import_node_fs2.appendFileSync)(import_node_path2.default.join(this.spoolDir, "intervals.jsonl"), JSON.stringify(published) + "\n", { mode: 384 });
      } catch {
      }
      this.port.publishInterval(published).catch(() => void 0);
    }
    for (const cohort of this.accounting.sealCohorts(planNow, this.budgets.stopGraceMs, force)) {
      this.port.publishCohort({ ...cohort, phase: "measurement" }).catch(() => void 0);
    }
  }
  // ---------------------------------------------------------------- the end
  async finish(kill) {
    if (this.finishing) return;
    this.finishing = true;
    if (this.timer) clearInterval(this.timer);
    for (const ask of this.pending) this.sendToExecutor({ t: "deny", req: ask.req, reason: "stopped" });
    this.pending = [];
    if (kill) this.kill(this.reason ?? "stop");
    else if (this.contained && !this.executorExited) {
      this.sendToExecutor({ t: "exit" });
      await waitFor(() => this.executorExited, 3e3);
    }
    this.kill("end of run");
    if (this.contained && !this.executorExited) await waitFor(() => this.executorExited, 5e3);
    this.contained?.dispose();
    this.marker("traffic_stopped");
    const now = this.clock.tick();
    if (this.phase === "measurement") {
      for (const id of this.accounting.unresolved()) {
        this.accounting.record(id, "interrupted", now - this.phaseStart);
      }
      this.publish(now - this.phaseStart, true);
    }
    this.phase = "done";
    const successTime = mergeHistograms([histogramOf(this.successMicros)]);
    const result = {
      status: this.status,
      reason: this.reason,
      runId: this.runId,
      containment: this.contained ? { level: this.contained.level, limitedBecause: this.contained.limitedBecause } : { level: "limited", limitedBecause: "not started" },
      isolation: this.isolation,
      playwright: this.playwrightVersion,
      checking: this.checkingResult,
      measurement: { ...this.measured, ...this.accounting.totals, successTime, p95Micros: percentile(successTime, 0.95) },
      permits: { issued: this.issued.length, ids: this.issued, denied: this.denied },
      bypasses: { count: this.bypassCount, samples: this.bypasses },
      intervalsPublished: this.intervalsPublished,
      spoolDir: this.spoolDir
    };
    await this.port.publishFinal(result).catch(() => void 0);
    if (this.ownsSpool) (0, import_node_fs2.rmSync)(this.spoolDir, { recursive: true, force: true });
    this.resolveDone(result);
  }
};
function waitFor(condition, timeoutMs) {
  return new Promise((resolve) => {
    const started = Date.now();
    const check = () => {
      if (condition() || Date.now() - started > timeoutMs) resolve();
      else setTimeout(check, 10);
    };
    check();
  });
}

// src/load/engine.ts
var PlanInputRefused = class extends Error {
  constructor(errors) {
    super(`the load plan was refused: ${errors.join("; ")}`);
    this.errors = errors;
    this.name = "PlanInputRefused";
  }
};
function startEngine(planInput, controlPort, options) {
  const checked = validatePlanInput(planInput);
  if (!checked.ok) throw new PlanInputRefused(checked.errors);
  const supervisor = new Supervisor(checked.value, controlPort, options);
  void supervisor.start();
  return { done: supervisor.done, stop: (mode) => supervisor.stop(mode) };
}
function runEngine(planInput, controlPort, options) {
  return startEngine(planInput, controlPort, options).done;
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  PlanInputRefused,
  runEngine,
  startEngine,
  validatePlanInput
});
