/**
 * Frames on the control socket between the supervisor and the jail's init, and on the
 * executor's pipes (fd 0 in, fd 3 out): one JSON object per line (e4 plan v3 §2.4). Init
 * relays the executor's frames both ways and handles only its own. Pure: no sockets here.
 *
 * Every field is validated: an unknown type or a bad field rejects the frame, and a field a
 * frame does not define is dropped, so nothing unvalidated is relayed.
 */

/** A start or launch ticket: minted by the supervisor at the send, checked by init. */
export interface Ticket {
  claimId: string;
  epoch: number;
  planHash: string;
  leaseSeq: number;
  nonce: string;
  /** CLOCK_MONOTONIC (shared by the unit), ms. */
  monoDeadline: number;
  wallDeadline: number;
}

export type RefusedReason = "stale_ticket" | "used_ticket" | "foreign_ticket" | "early_ticket";
export type FatalCode = "unreadable" | "playwright" | "journey" | "protocol";
export type OutcomeKind = "success" | "failure" | "timeout" | "cancelled";

export type CtlFrame =
  // init ⇄ supervisor
  | { type: "hello"; nonce: string }
  | { type: "ready" }
  | { type: "start"; ticket: Ticket }
  | { type: "launch"; ticket: Ticket }
  | { type: "refused"; reason: RefusedReason }
  | { type: "installed"; code: number | null; signal: string | null; ms: number }
  | { type: "launched" }
  | { type: "exit"; code: number | null; signal: string | null }
  // supervisor → executor, relayed by init
  | { type: "init"; journey: { module: string; export: string }; baseURL: string; proxy: string; renewEveryMs: number; parallel: number }
  | { type: "turn"; turn: number; slot: number; password: string; deadlineMono: number }
  | { type: "cancel"; turn: number }
  | { type: "stop" }
  // executor → supervisor, relayed by init
  | { type: "loaded"; playwright: string }
  | { type: "fatal"; code: FatalCode; message: string; location?: string; error?: ErrorClass; playwright?: PlaywrightCompat }
  | { type: "outcome"; turn: number; kind: OutcomeKind; message?: string; location?: string; error?: ErrorClass };

export type CtlType = CtlFrame["type"];

/** A line longer than this is a protocol violation: frames are small. */
export const MAX_FRAME_BYTES = 64 * 1024;
export const MAX_MESSAGE = 2000;
/**
 * What a journey's error was, as a closed set the executor picks and `decode` checks: the only
 * thing about it, besides the frame's own code, that leaves the runner (CW-A round 2, Sol r2c).
 */
export const ERROR_CLASSES = ["assertion", "timeout", "network", "other"] as const;
export type ErrorClass = (typeof ERROR_CLASSES)[number];
/** Why the checkout's Playwright could not be used, as a closed set; `ok` when it loaded. */
export const PLAYWRIGHT_COMPAT = ["ok", "not_found", "below_floor", "unreadable"] as const;
export type PlaywrightCompat = (typeof PLAYWRIGHT_COMPAT)[number];
export const MAX_LOCATION = 500;

const TO_EXECUTOR = new Set<CtlType>(["init", "turn", "cancel", "stop"]);
const TO_SUPERVISOR = new Set<CtlType>(["loaded", "fatal", "outcome"]);

/** Whether init may pass `frame` on when it came `from` that side. Everything else on a relayed channel is a violation. */
export function relayable(frame: CtlFrame, from: "supervisor" | "executor"): boolean {
  return (from === "supervisor" ? TO_EXECUTOR : TO_SUPERVISOR).has(frame.type);
}

export function encode(frame: CtlFrame): string {
  return `${JSON.stringify(frame)}\n`;
}

type Fields = Record<string, unknown>;
const isSafePositive = (v: unknown): v is number => Number.isSafeInteger(v) && (v as number) > 0;
const isSafeCount = (v: unknown): v is number => Number.isSafeInteger(v) && (v as number) >= 0;
const isFinitePositive = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v) && v > 0;
const isText = (v: unknown, max: number, min = 0): v is string => typeof v === "string" && v.length >= min && v.length <= max;
const isCode = (v: unknown): v is number | null => v === null || Number.isSafeInteger(v);
const isSignal = (v: unknown): v is string | null => v === null || isText(v, 32, 1);
const PASSWORD = /^[A-Za-z0-9_-]{43}$/;
const NONCE = /^[0-9a-f]{64}$/;
const IDENT = /^[A-Za-z_$][A-Za-z0-9_$]{0,255}$/;

function ticketOf(v: unknown): Ticket | null {
  if (typeof v !== "object" || v === null) return null;
  const t = v as Fields;
  if (!isText(t.claimId, 256, 1) || !isSafeCount(t.epoch) || !isText(t.planHash, 256, 1) || !isSafeCount(t.leaseSeq) || !isText(t.nonce, 256, 1)) return null;
  if (!isFinitePositive(t.monoDeadline) || !isFinitePositive(t.wallDeadline)) return null;
  return { claimId: t.claimId, epoch: t.epoch, planHash: t.planHash, leaseSeq: t.leaseSeq, nonce: t.nonce, monoDeadline: t.monoDeadline, wallDeadline: t.wallDeadline };
}

function optional(v: Fields, name: string, max: number): Record<string, string> | null {
  if (v[name] === undefined) return {};
  return isText(v[name], max) ? { [name]: v[name] as string } : null;
}

/** An optional field from a closed set: absent, or one of `set`; anything else makes the frame not one. */
function oneOf<T extends string>(v: Fields, name: string, set: readonly T[]): Record<string, T> | null {
  if (v[name] === undefined) return {};
  return typeof v[name] === "string" && (set as readonly string[]).includes(v[name] as string) ? { [name]: v[name] as T } : null;
}

/** The frame a line holds, or null when it is not one. */
export function decode(line: string): CtlFrame | null {
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    return null;
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const v = value as Fields;
  switch (v.type) {
    case "hello":
      return typeof v.nonce === "string" && NONCE.test(v.nonce) ? { type: "hello", nonce: v.nonce } : null;
    case "ready":
    case "launched":
    case "stop":
      return { type: v.type };
    case "start":
    case "launch": {
      const ticket = ticketOf(v.ticket);
      return ticket ? { type: v.type, ticket } : null;
    }
    case "refused":
      return v.reason === "stale_ticket" || v.reason === "used_ticket" || v.reason === "foreign_ticket" || v.reason === "early_ticket" ? { type: "refused", reason: v.reason } : null;
    case "installed":
      return isCode(v.code) && isSignal(v.signal) && typeof v.ms === "number" && Number.isFinite(v.ms) && v.ms >= 0 ? { type: "installed", code: v.code, signal: v.signal, ms: v.ms } : null;
    case "exit":
      return isCode(v.code) && isSignal(v.signal) ? { type: "exit", code: v.code, signal: v.signal } : null;
    case "init": {
      const j = v.journey as Fields | null;
      if (typeof j !== "object" || j === null || !isText(j.module, 1024, 1) || typeof j.export !== "string" || !IDENT.test(j.export)) return null;
      if (!isText(v.baseURL, 2048, 1) || !isText(v.proxy, 256, 1) || !isFinitePositive(v.renewEveryMs)) return null;
      if (!Number.isInteger(v.parallel) || (v.parallel as number) < 1 || (v.parallel as number) > 8) return null;
      return { type: "init", journey: { module: j.module, export: j.export }, baseURL: v.baseURL, proxy: v.proxy, renewEveryMs: v.renewEveryMs, parallel: v.parallel as number };
    }
    case "turn":
      if (!isSafePositive(v.turn) || !isSafePositive(v.slot) || typeof v.password !== "string" || !PASSWORD.test(v.password) || !isFinitePositive(v.deadlineMono)) return null;
      return { type: "turn", turn: v.turn, slot: v.slot, password: v.password, deadlineMono: v.deadlineMono };
    case "cancel":
      return isSafePositive(v.turn) ? { type: "cancel", turn: v.turn } : null;
    case "loaded":
      return isText(v.playwright, 64, 1) ? { type: "loaded", playwright: v.playwright } : null;
    case "fatal": {
      if (v.code !== "unreadable" && v.code !== "playwright" && v.code !== "journey" && v.code !== "protocol") return null;
      const location = optional(v, "location", MAX_LOCATION);
      const error = oneOf(v, "error", ERROR_CLASSES);
      const playwright = oneOf(v, "playwright", PLAYWRIGHT_COMPAT);
      if (!isText(v.message, MAX_MESSAGE) || !location || !error || !playwright) return null;
      return { type: "fatal", code: v.code, message: v.message, ...location, ...error, ...playwright };
    }
    case "outcome": {
      if (!isSafePositive(v.turn) || (v.kind !== "success" && v.kind !== "failure" && v.kind !== "timeout" && v.kind !== "cancelled")) return null;
      const message = optional(v, "message", MAX_MESSAGE);
      const location = optional(v, "location", MAX_LOCATION);
      const error = oneOf(v, "error", ERROR_CLASSES);
      if (!message || !location || !error) return null;
      return { type: "outcome", turn: v.turn, kind: v.kind, ...message, ...location, ...error };
    }
    default:
      return null;
  }
}

/** Splits a byte stream into lines; `push` returns the complete lines, or null once a line is too long. */
export class LineSplitter {
  private buffer = "";

  /** Bytes after the last newline: at end of input, a frame cut short. */
  get incomplete(): boolean {
    return this.buffer !== "";
  }

  push(chunk: string): string[] | null {
    this.buffer += chunk;
    const lines = this.buffer.split("\n");
    this.buffer = lines.pop() ?? "";
    if (Buffer.byteLength(this.buffer) > MAX_FRAME_BYTES || lines.some((line) => Buffer.byteLength(line) > MAX_FRAME_BYTES)) return null;
    return lines;
  }
}

/** Constant-time comparison of two hex nonces. */
export function sameNonce(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/** Init's record of the tickets it has used. */
export interface TicketState {
  used: Set<"start" | "launch">;
  /** The install `start` began has finished: only then may `launch` be used. */
  installed: boolean;
}

export function newTicketState(): TicketState {
  return { used: new Set(), installed: false };
}

/**
 * Init's ticket rule (e4 plan v3 §2.1): one use per kind, for this claim, before both
 * deadlines, and `launch` only after `installed`. Only "ok" uses the ticket up: a stale,
 * foreign or early one leaves the use in place.
 */
export function consumeTicket(
  kind: "start" | "launch",
  ticket: Ticket,
  now: { monoMs: number; wallMs: number },
  config: { claimId: string },
  state: TicketState,
): "ok" | "stale" | "used" | "foreign" | "early" {
  if (!sameText(ticket.claimId, config.claimId)) return "foreign";
  if (state.used.has(kind)) return "used";
  if (kind === "launch" && !state.installed) return "early";
  if (!(now.monoMs < ticket.monoDeadline) || !(now.wallMs < ticket.wallDeadline)) return "stale";
  state.used.add(kind);
  return "ok";
}

function sameText(a: string, b: string): boolean {
  return a.length === b.length && sameNonce(a, b);
}
