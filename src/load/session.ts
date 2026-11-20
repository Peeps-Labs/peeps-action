/**
 * The executor's side of every send (e4 plan v3 §2.5). Each turn gets its own Playwright
 * `APIRequestContext`, whose proxy credential is the turn's: so every request opens a CONNECT
 * the gate binds to that turn, and a closed turn's credential opens nothing. A slot (a user)
 * keeps one cookie jar across its turns, as `storageState`, capped at 1 MiB, written only by
 * the slot's current turn when the journey itself ended it.
 *
 * The journey never sees the context or Playwright's responses. It gets a facade whose every
 * call is checked (`prepare`), sent with `maxRedirects: 0`, `maxRetries: 0` and
 * `failOnStatusCode: false` forced per call (the context-level redirect limit arrived only in
 * Playwright 1.52), and whose answer is read for the gate's headers first:
 *
 *   - `x-peeps-load-denied: turn_closed | turn_deadline` ends the turn (`TurnDeadline`);
 *   - a reason the gate may lift later (`WAITABLE`) waits in one process-wide FIFO pacer, where
 *     only the head re-sends, never past the turn's deadline;
 *   - any other denial throws `GateDenied`;
 *   - `x-peeps-load-cut` is final: the gate ended an exchange it had admitted, so it is never
 *     re-sent.
 *
 * A target's own answer (a 503 included) is returned untouched; the gate strips its headers
 * from target responses, so they cannot be forged by the target. Nothing here is trusted for a
 * count, a time or a limit: the gate enforces those.
 */

import { setTimeout as sleep } from "node:timers/promises";

export const DENIED_HEADER = "x-peeps-load-denied";
export const CUT_HEADER = "x-peeps-load-cut";
export const RETRY_HEADER = "x-peeps-load-retry-after-ms";

/** Denials the gate may lift with time: the send waits and goes again. */
export const WAITABLE = new Set(["rate", "ceiling", "outstanding", "dials", "tunnels", "phase_total", "users", "memory"]);
const ENDS_TURN = new Set(["turn_closed", "turn_deadline"]);
const MAX_JAR_BYTES = 1024 * 1024;
const DEFAULT_WAIT_MS = 25;
const MIN_WAIT_MS = 5;

/** The part of Playwright's API used here: the customer's copy, never bundled. */
export interface PlaywrightRequest {
  newContext(options: Record<string, unknown>): Promise<RealContext>;
}

export interface RealResponse {
  status(): number;
  statusText(): string;
  headers(): Record<string, string>;
  dispose(): Promise<void>;
}

export interface RealContext {
  fetch(url: string, options: Record<string, unknown>): Promise<RealResponse>;
  storageState(options?: Record<string, unknown>): Promise<unknown>;
  dispose(options?: Record<string, unknown>): Promise<void>;
}

export class LoadRefusal extends Error {
  constructor(message: string) {
    super(`load: ${message}`);
    this.name = "LoadRefusal";
  }
}

/** A send ran into its turn's end: the turn timed out, it did not fail. */
export class TurnDeadline extends Error {
  constructor() {
    super("load: the turn's deadline was reached");
    this.name = "TurnDeadline";
  }
}

/** The gate refused for good (`x-peeps-load-denied`), or ended the exchange (`x-peeps-load-cut`). */
export class GateDenied extends Error {
  constructor(
    readonly reason: string,
    readonly cut: boolean,
  ) {
    super(`load: the gate ${cut ? "cut the exchange" : "refused the request"} (${reason})`);
    this.name = "GateDenied";
  }
}

const METHODS: Record<string, string> = { get: "GET", post: "POST", put: "PUT", patch: "PATCH", delete: "DELETE", head: "HEAD" };
const VERBS = new Set(Object.values(METHODS));
/** Options passed on to Playwright; anything else is refused. */
const FORWARDED = new Set(["data", "form", "multipart", "headers", "params", "timeout"]);
/** Options checked here and never passed on as given. */
const CHECKED = new Set(["method", "maxRetries", "maxRedirects", "failOnStatusCode", "ignoreHTTPSErrors"]);
const FORBIDDEN_HEADERS = new Set(["host", "proxy-authorization", "proxy-connection"]);

export interface SessionOptions {
  playwright: PlaywrightRequest;
  baseURL: string;
  /** The relay's URL: the only way out. */
  proxy: string;
  /** Sends at once per turn. */
  parallel: number;
  /** How long to wait after a `ceiling` denial: the supervisor's renewal period. */
  renewEveryMs: number;
  /** The shared monotonic clock (`sharedClocks().monoMs`). */
  now(): number;
}

export interface TurnSpec {
  turn: number;
  slot: number;
  password: string;
  deadlineMono: number;
}

export type Journey = (request: Record<string, unknown>) => unknown;

export interface TurnResult {
  kind: "success" | "failure" | "timeout" | "cancelled";
  error?: unknown;
}

interface TurnState {
  spec: TurnSpec;
  context?: RealContext;
  closed: boolean;
  cancelled: boolean;
  /** Aborted when the turn closes: its place in the pacer's queue and its wait end at once. */
  pace: AbortController;
  /** The one disposal of the context, shared by cancel and the turn's end. */
  disposing?: Promise<void>;
  outstanding: Set<Promise<unknown>>;
  responses: RealResponse[];
  /** Per-turn FIFO semaphore: `parallel` sends at once. */
  active: number;
  queue: (() => void)[];
  /** Resolves on cancel: the journey's own promise may never settle. */
  onCancel: Promise<void>;
  markCancelled: () => void;
}

interface Slot {
  jar?: unknown;
  /** The turn this slot is running, if any. */
  turn?: TurnState;
}

/** One process-wide FIFO: only its head waits out a denial and starts its re-send. */
class Pacer {
  private active = false;
  private readonly queue: (() => void)[] = [];

  /** Runs `body` once every earlier waiter is done. An aborted waiter leaves the queue at once. */
  async run<T>(signal: AbortSignal, body: () => Promise<T>): Promise<T> {
    signal.throwIfAborted();
    if (this.active) {
      await new Promise<void>((resolve, reject) => {
        const enter = () => {
          signal.removeEventListener("abort", abort);
          resolve();
        };
        const abort = () => {
          this.queue.splice(this.queue.indexOf(enter), 1);
          reject(signal.reason);
        };
        this.queue.push(enter);
        signal.addEventListener("abort", abort, { once: true });
      });
    }
    this.active = true;
    try {
      signal.throwIfAborted();
      return await body();
    } finally {
      const next = this.queue.shift();
      if (next) next();
      else this.active = false;
    }
  }
}

/** What the journey gets back: a plain object with a response's readers, and nothing else. */
function facade(response: RealResponse): Record<string, unknown> {
  const r = response as unknown as Record<string, (...a: unknown[]) => unknown>;
  const call = (name: string) => (...args: unknown[]) => r[name]!.apply(response, args);
  return {
    status: call("status"),
    statusText: call("statusText"),
    ok: call("ok"),
    url: call("url"),
    headers: call("headers"),
    headersArray: call("headersArray"),
    body: call("body"),
    text: call("text"),
    json: call("json"),
    // Disposed with the turn.
    dispose: async () => undefined,
  };
}

function isPlainMultipartValue(value: unknown): boolean {
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean" || Buffer.isBuffer(value)) return true;
  if (value && typeof value === "object" && Object.getPrototypeOf(value) === Object.prototype) {
    const f = value as Record<string, unknown>;
    return typeof f.name === "string" && typeof f.mimeType === "string" && Buffer.isBuffer(f.buffer) && Object.keys(f).every((k) => ["name", "mimeType", "buffer"].includes(k));
  }
  return false;
}

export class Sessions {
  private readonly slots = new Map<number, Slot>();
  private readonly turns = new Map<number, TurnState>();
  private readonly pacer = new Pacer();

  constructor(private readonly o: SessionOptions) {}

  /** Whether a slot is running a turn. */
  busy(slot: number): boolean {
    return this.slots.get(slot)?.turn !== undefined;
  }

  /**
   * Runs one turn to its end and cleans it up: the result is known only once the turn's
   * context is disposed. Throws only when the slot is already busy.
   */
  async run(spec: TurnSpec, journey: Journey): Promise<TurnResult> {
    const slot = this.slots.get(spec.slot) ?? {};
    this.slots.set(spec.slot, slot);
    if (slot.turn) throw new LoadRefusal(`slot ${spec.slot} is busy`);
    let markCancelled!: () => void;
    const onCancel = new Promise<void>((resolve) => (markCancelled = resolve));
    const state: TurnState = { spec, closed: false, cancelled: false, pace: new AbortController(), outstanding: new Set(), responses: [], active: 0, queue: [], onCancel, markCancelled };
    slot.turn = state;
    this.turns.set(spec.turn, state);
    let result: TurnResult;
    try {
      state.context = await this.o.playwright.newContext({
        baseURL: this.o.baseURL,
        proxy: { server: this.o.proxy, username: String(spec.turn), password: spec.password },
        ...(slot.jar ? { storageState: slot.jar } : {}),
        // Deliberately no httpCredentials: a 401 challenge is an answer, never a resend.
      });
      if (state.cancelled) result = { kind: "cancelled" };
      else {
        await Promise.race([journey(this.guarded(state)), state.onCancel]);
        result = state.cancelled ? { kind: "cancelled" } : { kind: "success" };
      }
    } catch (error) {
      result = state.cancelled ? { kind: "cancelled" } : error instanceof TurnDeadline ? { kind: "timeout" } : { kind: "failure", error };
    }
    await this.finishTurn(state, slot);
    // A cancel that arrived while the turn was cleaning up still decides its outcome.
    return state.cancelled ? { kind: "cancelled" } : result;
  }

  /**
   * Cancel a running turn: the facade is closed first, then the context disposed, which ends
   * what it has in flight. `run` then settles with `cancelled`. A turn already ended: no-op.
   */
  cancel(turn: number): void {
    const state = this.turns.get(turn);
    if (!state || state.cancelled) return;
    state.cancelled = true;
    state.closed = true;
    state.pace.abort(new TurnDeadline());
    state.markCancelled();
    for (const wake of state.queue.splice(0)) wake();
    if (state.context) void this.disposeContext(state);
  }

  /** Every running turn, cancelled. */
  cancelAll(): void {
    for (const turn of [...this.turns.keys()]) this.cancel(turn);
  }

  /**
   * After a turn: its outstanding sends end (each by the deadline, or by the dispose of a
   * cancel), the jar is kept when the journey itself ended the turn, then the context goes.
   */
  private async finishTurn(state: TurnState, slot: Slot): Promise<void> {
    state.closed = true;
    state.pace.abort(new TurnDeadline());
    for (const wake of state.queue.splice(0)) wake();
    while (state.outstanding.size > 0) await Promise.allSettled([...state.outstanding]);
    if (!state.cancelled && state.context && slot.turn === state) {
      try {
        const jar = await state.context.storageState();
        if (!state.cancelled && Buffer.byteLength(JSON.stringify(jar)) <= MAX_JAR_BYTES) slot.jar = jar;
      } catch {
        // The context is gone: keep the earlier cookies.
      }
    }
    await Promise.allSettled(state.responses.map((r) => r.dispose()));
    state.responses.length = 0;
    await this.disposeContext(state);
    this.turns.delete(state.spec.turn);
    if (slot.turn === state) slot.turn = undefined;
  }

  private disposeContext(state: TurnState): Promise<void> | undefined {
    return (state.disposing ??= state.context?.dispose({ reason: "load: turn ended" }).catch(() => undefined));
  }

  private remaining(state: TurnState): number {
    return Math.floor(state.spec.deadlineMono - this.o.now());
  }

  /** Checks a call and builds exactly what will be sent; throws a refusal. */
  private prepare(verb: string, url: unknown, options: Record<string, unknown>): { url: string; forward: Record<string, unknown>; failOnStatusCode: boolean; timeout?: number } {
    if (typeof url !== "string") throw new LoadRefusal("requests take a URL string");
    for (const key of Object.keys(options)) {
      if (!FORWARDED.has(key) && !CHECKED.has(key)) throw new LoadRefusal(`the request option "${key}" is not supported in a load journey`);
    }
    if (options.ignoreHTTPSErrors !== undefined && options.ignoreHTTPSErrors !== false) throw new LoadRefusal("ignoreHTTPSErrors is not allowed in a load journey");
    if (options.maxRetries !== undefined && options.maxRetries !== 0) throw new LoadRefusal("retries are not allowed in a load journey");
    if (options.maxRedirects !== undefined && options.maxRedirects !== 0) throw new LoadRefusal("redirects are not followed in a load journey");
    if (!VERBS.has(verb)) throw new LoadRefusal(`the method ${verb} is not supported in a load journey`);
    let target: URL;
    try {
      target = new URL(url, this.o.baseURL);
    } catch {
      throw new LoadRefusal(`not a URL: ${url}`);
    }
    if (target.username || target.password) throw new LoadRefusal("a URL may not carry credentials");
    if (options.params !== undefined) {
      const params = options.params;
      if (typeof params === "string") for (const [k, v] of new URLSearchParams(params)) target.searchParams.append(k, v);
      else if (params && typeof params === "object") {
        for (const [k, v] of Object.entries(params as Record<string, unknown>)) target.searchParams.append(k, String(v));
      } else throw new LoadRefusal("params must be an object or a string");
    }
    const headers: Record<string, string> = {};
    if (options.headers !== undefined) {
      if (!options.headers || typeof options.headers !== "object") throw new LoadRefusal("headers must be an object");
      for (const [k, v] of Object.entries(options.headers as Record<string, unknown>)) {
        if (FORBIDDEN_HEADERS.has(k.toLowerCase())) throw new LoadRefusal(`the header ${k} cannot be set in a load journey`);
        headers[k] = String(v);
      }
    }
    if (options.multipart !== undefined) {
      const m = options.multipart;
      if (!m || typeof m !== "object" || Object.getPrototypeOf(m) !== Object.prototype || !Object.values(m).every(isPlainMultipartValue)) {
        throw new LoadRefusal("multipart takes strings, numbers, booleans, Buffers and {name, mimeType, buffer}; streams are not supported");
      }
    }
    const forward: Record<string, unknown> = { headers };
    for (const key of ["data", "form", "multipart"]) if (options[key] !== undefined) forward[key] = options[key];
    const timeout = typeof options.timeout === "number" && options.timeout > 0 ? options.timeout : undefined;
    return { url: target.href, forward, failOnStatusCode: options.failOnStatusCode === true, timeout };
  }

  /** The context the journey gets for one turn. */
  private guarded(state: TurnState): Record<string, unknown> {
    const send = async (method: string, url: unknown, options: Record<string, unknown> = {}) => {
      if (state.closed) throw new LoadRefusal("this turn has ended");
      if (options === null || typeof options !== "object") throw new LoadRefusal("request options must be an object");
      const verb = String(method).toUpperCase();
      const prepared = this.prepare(verb, url, options);
      const work = this.sendWithin(state, verb, prepared);
      state.outstanding.add(work);
      try {
        return await work;
      } finally {
        state.outstanding.delete(work);
      }
    };
    const api: Record<string, unknown> = {
      fetch: (url: unknown, options: Record<string, unknown> = {}) => {
        const { method, ...rest } = options ?? {};
        return send(method === undefined ? "GET" : String(method), url, rest);
      },
      storageState: async () => {
        if (state.closed || !state.context) throw new LoadRefusal("this turn has ended");
        return state.context.storageState();
      },
      dispose: async () => {
        throw new LoadRefusal("a journey cannot dispose its request context");
      },
    };
    for (const [name, verb] of Object.entries(METHODS)) {
      api[name] = async (url: unknown, options: Record<string, unknown> = {}) => {
        if (options && typeof options === "object" && options.method !== undefined) throw new LoadRefusal(`${name}() takes no method option`);
        return send(verb, url, options);
      };
    }
    return api;
  }

  private async acquire(state: TurnState): Promise<void> {
    while (state.active >= this.o.parallel && !state.closed) await new Promise<void>((resolve) => state.queue.push(resolve));
    if (state.closed) throw state.cancelled ? new LoadRefusal("this turn has ended") : new TurnDeadline();
    state.active += 1;
  }

  private release(state: TurnState): void {
    state.active -= 1;
    state.queue.shift()?.();
  }

  private async sendWithin(state: TurnState, verb: string, p: ReturnType<Sessions["prepare"]>): Promise<Record<string, unknown>> {
    await this.acquire(state);
    try {
      let answer = await this.sendOnce(state, verb, p);
      while (answer.waitMs !== undefined) {
        const waitMs = answer.waitMs;
        // Only the head of the process-wide queue waits and starts its re-send. The exchange
        // itself is awaited outside the queue: a slow target holds no other send back, and a
        // send the gate refuses again goes to the back.
        const started = this.pacer.run(state.pace.signal, async () => {
          const left = this.remaining(state);
          if (left <= 0 || state.closed) throw new TurnDeadline();
          await sleep(Math.min(waitMs, left), undefined, { signal: state.pace.signal }).catch((error: unknown) => {
            if (state.pace.signal.aborted) throw state.pace.signal.reason;
            throw error;
          });
          const sent = this.sendOnce(state, verb, p);
          sent.catch(() => undefined);
          return { sent };
        });
        // A cancelled turn leaves the queue at once: its outcome does not wait for the turns ahead.
        const cancelled = state.onCancel.then(() => {
          throw new LoadRefusal("this turn has ended");
        });
        answer = await (await Promise.race([started, cancelled])).sent;
      }
      const response = answer.response!;
      // Playwright's own failOnStatusCode passes 200-399: a returned redirect is an answer.
      if (p.failOnStatusCode && !(response.status() >= 200 && response.status() < 400)) {
        throw new Error(`${response.status()} ${response.statusText()}`);
      }
      return facade(response);
    } finally {
      this.release(state);
    }
  }

  /** One send. Returns the target's response, or how long to wait before trying again. */
  private async sendOnce(state: TurnState, verb: string, p: ReturnType<Sessions["prepare"]>): Promise<{ response?: RealResponse; waitMs?: number }> {
    const context = state.context!;
    const left = this.remaining(state);
    if (state.closed || left <= 0) throw state.cancelled ? new LoadRefusal("this turn has ended") : new TurnDeadline();
    let response: RealResponse;
    try {
      response = await context.fetch(p.url, {
        ...p.forward,
        method: verb,
        timeout: p.timeout === undefined ? left : Math.min(p.timeout, left),
        maxRedirects: 0,
        maxRetries: 0,
        failOnStatusCode: false,
      });
    } catch (error) {
      if (state.cancelled) throw new LoadRefusal("this turn has ended");
      if (this.remaining(state) <= 1) throw new TurnDeadline();
      throw error;
    }
    const headers = response.headers();
    const cut = headers[CUT_HEADER];
    const denied = headers[DENIED_HEADER];
    // A refusal is never handed to the journey: its body is let go now, not at the turn's end.
    if (cut !== undefined) {
      await response.dispose().catch(() => undefined);
      throw new GateDenied(cut, true);
    }
    if (denied === undefined) {
      state.responses.push(response);
      return { response };
    }
    await response.dispose().catch(() => undefined);
    if (ENDS_TURN.has(denied)) throw new TurnDeadline();
    if (!WAITABLE.has(denied)) throw new GateDenied(denied, false);
    if (denied === "ceiling") return { waitMs: this.o.renewEveryMs };
    const hinted = Number(headers[RETRY_HEADER]);
    return { waitMs: headers[RETRY_HEADER] !== undefined && Number.isFinite(hinted) ? Math.max(hinted, MIN_WAIT_MS) : DEFAULT_WAIT_MS };
  }
}
