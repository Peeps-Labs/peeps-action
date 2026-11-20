/**
 * The engine's input: Peeps' compiled `Plan` and the environment's `Limits`, exactly as peeps
 * defines them (`src/server/load-testing/protocol/domain/{plan,limits}.ts`; peeps owns the
 * shape and the `v1/common` corpus this is tested against). The action never parses a
 * workload file; it checks what it was handed and refuses anything it does not understand:
 * unknown fields, values out of range, sums that do not add up, a planned start count that
 * is not what the schedule produces, and a journey module that escapes the repository.
 *
 * Pure: no file system, network or Playwright.
 */
import { scheduleStageStarts } from "./scheduler";

export const PLAN_PROTOCOL_VERSION = 1;

export type StageKind = "ramp" | "hold";

export interface PlanStage {
  name: string;
  kind: StageKind;
  startMs: number;
  durationMs: number;
  fromUsers: number;
  toUsers: number;
  plannedStarts: number;
}

export interface AllowedRequest {
  method: "POST" | "PUT" | "PATCH" | "DELETE";
  path: string;
}

export interface Plan {
  protocolVersion: 1;
  journey: { module: string; export: string };
  cohort: {
    kind: "protocol";
    demand: "users";
    pacingEveryMs: number;
    stages: PlanStage[];
  };
  durationMs: number;
  peakUsers: number;
  plannedStarts: number;
  requests: { perJourneyMax: number; ceiling: number };
  allowedRequests: AllowedRequest[];
  onReduced: "refuse";
}

export interface Limits {
  allowedOrigins: string[];
  maxUsers: number;
  requestBudget: number;
  policyRevision: number;
}

export interface PlanInput {
  plan: Plan;
  limits: Limits;
}

export type PlanInputResult = { ok: true; value: PlanInput } | { ok: false; errors: string[] };

/** The same bounds peeps' compiler applies (PR 1 "Compiler bounds"), checked again here. */
export const PLAN_BOUNDS = {
  maxStages: 20,
  maxDurationMs: 60 * 60 * 1000,
  maxUsers: 1000,
  minPacingMs: 1000,
  maxPlannedStarts: 1_000_000,
  maxPerJourney: 1000,
  maxAllowedRequests: 50,
  maxOrigins: 20,
  maxText: 512,
} as const;

const ALLOWED_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);
const IDENTIFIER = /^[A-Za-z_$][\w$]*$/;

type Obj = Record<string, unknown>;

class Check {
  readonly errors: string[] = [];

  fail(at: string, message: string): void {
    this.errors.push(`${at}: ${message}`);
  }

  object(value: unknown, at: string, keys: readonly string[]): Obj | null {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      this.fail(at, "must be an object");
      return null;
    }
    const obj = value as Obj;
    for (const key of Object.keys(obj)) if (!keys.includes(key)) this.fail(`${at}.${key}`, "is not a known field");
    for (const key of keys) if (!(key in obj)) this.fail(`${at}.${key}`, "is missing");
    return obj;
  }

  int(value: unknown, at: string, min: number, max: number): number | null {
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

  text(value: unknown, at: string): string | null {
    if (typeof value !== "string" || value.length === 0 || value.length > PLAN_BOUNDS.maxText) {
      this.fail(at, `must be text of 1 to ${PLAN_BOUNDS.maxText} characters`);
      return null;
    }
    return value;
  }

  literal<T extends string | number>(value: unknown, at: string, expected: T): T | null {
    if (value !== expected) {
      this.fail(at, `must be ${JSON.stringify(expected)}`);
      return null;
    }
    return expected;
  }

  array(value: unknown, at: string, min: number, max: number): unknown[] | null {
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
}

/** A repository-relative POSIX path that cannot leave the repository. */
export function isContainedModulePath(module: string): boolean {
  if (module.length === 0 || module.length > PLAN_BOUNDS.maxText) return false;
  if (module.startsWith("/") || module.startsWith("~") || /^[A-Za-z]:/.test(module)) return false;
  if (module.includes("\\") || module.includes("\0") || module.includes("//")) return false;
  return module.split("/").every((segment) => segment !== "" && segment !== "." && segment !== "..");
}

/** `scheme://host[:port]` exactly as `URL` renders its origin: no path, user, query or case. */
export function isCanonicalOrigin(origin: string): boolean {
  let url: URL;
  try {
    url = new URL(origin);
  } catch {
    return false;
  }
  return (url.protocol === "https:" || url.protocol === "http:") && url.origin === origin;
}

const STAGE_KEYS = ["name", "kind", "startMs", "durationMs", "fromUsers", "toUsers", "plannedStarts"] as const;
const PLAN_KEYS = [
  "protocolVersion",
  "journey",
  "cohort",
  "durationMs",
  "peakUsers",
  "plannedStarts",
  "requests",
  "allowedRequests",
  "onReduced",
] as const;
const LIMITS_KEYS = ["allowedOrigins", "maxUsers", "requestBudget", "policyRevision"] as const;

function checkPlan(c: Check, raw: unknown): void {
  const plan = c.object(raw, "plan", PLAN_KEYS);
  if (!plan) return;
  c.literal(plan.protocolVersion, "plan.protocolVersion", PLAN_PROTOCOL_VERSION);
  c.literal(plan.onReduced, "plan.onReduced", "refuse");

  const journey = c.object(plan.journey, "plan.journey", ["module", "export"]);
  if (journey) {
    const module = c.text(journey.module, "plan.journey.module");
    if (module !== null && !isContainedModulePath(module)) {
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
  const stages: PlanStage[] = [];
  let pacing: number | null = null;
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
        const durationMs = c.int(stage.durationMs, `${at}.durationMs`, 1, PLAN_BOUNDS.maxDurationMs);
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
        sumDuration += durationMs!;
        sumStarts += stage.plannedStarts as number;
        peak = Math.max(peak, fromUsers!, toUsers!);
        stages.push(stage as unknown as PlanStage);
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
    // The schedule the engine will run must be the one Peeps showed: same starts per stage.
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
      c.fail("plan.requests.ceiling", "must be plannedStarts × perJourneyMax");
    }
  }

  const allowed = c.array(plan.allowedRequests, "plan.allowedRequests", 0, PLAN_BOUNDS.maxAllowedRequests);
  if (allowed) {
    const seen = new Set<string>();
    allowed.forEach((rawRequest, i) => {
      const at = `plan.allowedRequests[${i}]`;
      const request = c.object(rawRequest, at, ["method", "path"]);
      if (!request) return;
      if (typeof request.method !== "string" || !ALLOWED_METHODS.has(request.method)) {
        c.fail(`${at}.method`, "must be POST, PUT, PATCH or DELETE");
      }
      const path = c.text(request.path, `${at}.path`);
      if (path !== null && (!path.startsWith("/") || /[?#\s\\]/.test(path))) {
        c.fail(`${at}.path`, "must be a path starting with /, without a query or fragment");
      }
      const key = `${String(request.method)} ${String(request.path)}`;
      if (seen.has(key)) c.fail(at, "is listed twice");
      seen.add(key);
    });
  }
}

function checkLimits(c: Check, raw: unknown): void {
  const limits = c.object(raw, "limits", LIMITS_KEYS);
  if (!limits) return;
  const origins = c.array(limits.allowedOrigins, "limits.allowedOrigins", 1, PLAN_BOUNDS.maxOrigins);
  if (origins) {
    const seen = new Set<unknown>();
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

/** `{plan, limits}` checked in full, or every reason it is refused. */
export function validatePlanInput(raw: unknown): PlanInputResult {
  const c = new Check();
  const input = c.object(raw, "input", ["plan", "limits"]);
  if (!input) return { ok: false, errors: c.errors };
  checkPlan(c, input.plan);
  checkLimits(c, input.limits);
  if (c.errors.length === 0) {
    const { plan, limits } = input as unknown as PlanInput;
    if (plan.peakUsers > limits.maxUsers) c.fail("plan.peakUsers", `is more than the environment allows (${limits.maxUsers})`);
    if (plan.requests.ceiling > limits.requestBudget) {
      c.fail("plan.requests.ceiling", `is more than the environment's request budget (${limits.requestBudget})`);
    }
  }
  if (c.errors.length > 0) return { ok: false, errors: c.errors };
  return { ok: true, value: structuredClone(input) as unknown as PlanInput };
}
