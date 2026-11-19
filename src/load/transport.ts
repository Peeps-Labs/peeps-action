/**
 * The executor's side of every send (T3). Each user has one Playwright `APIRequestContext`,
 * made once (parallel first sends share it) with no `httpCredentials` (so Playwright has no
 * auth challenge to answer by sending again) and `maxRedirects: 0`. The journey never sees
 * that context or Playwright's responses: it gets a guarded context whose every call
 *
 *   - is refused if the turn is over, if it asks for retries or redirects, if its URL is not a
 *     string or carries credentials, or if it passes an option outside `ALLOWED_OPTIONS`
 *     (Playwright reads a `url` or `method` option over the positional ones, so an unknown
 *     option could send somewhere the permit never approved), a `Host` header or a permit
 *     header of its own;
 *   - asks the supervisor for a permit for exactly the URL it will send (its `params` folded
 *     into the query first), and is refused without one;
 *   - checks the permit again at the send: still before its absolute expiry and from a
 *     generation the executor has not fenced;
 *   - goes out once, to that URL: `maxRetries: 0`, `maxRedirects: 0`, a `timeout` that ends
 *     at the turn's deadline, and the header `X-Peeps-Load-Permit: <id>`;
 *   - answers with a plain response facade that holds no reference to Playwright.
 *
 * Each turn tracks its own sends and responses: when the journey returns, its outstanding
 * sends are drained (or cancelled at the deadline) before the user is free, and its
 * responses disposed; cookies stay with the user's context. After a timeout the user's
 * context is disposed (which cancels what is in flight) and a fresh one is made for its next
 * turn.
 */

export const PERMIT_HEADER = "X-Peeps-Load-Permit";

/** The part of Playwright's API the transport uses: the customer's copy, never bundled. */
export interface PlaywrightRequest {
  newContext(options: Record<string, unknown>): Promise<RealContext>;
}

export interface RealResponse {
  dispose(): Promise<void>;
}

export interface RealContext {
  fetch(url: string, options: Record<string, unknown>): Promise<RealResponse>;
  storageState(options?: Record<string, unknown>): Promise<unknown>;
  dispose(options?: Record<string, unknown>): Promise<void>;
}

export interface PermitGrant {
  id: string;
  /** When the permit lapses, on the shared monotonic clock (`sharedNowMs`). */
  expiresAt: number;
  /** The lease generation it was given under. */
  generation: number;
}

/** Asks the supervisor for a permit; rejects with the refusal's reason. */
export type AskPermit = (request: { turn: string; method: string; url: string }) => Promise<PermitGrant>;

export { sharedNowMs } from "./shared-clock";

export class LoadRefusal extends Error {
  constructor(message: string) {
    super(`load: ${message}`);
    this.name = "LoadRefusal";
  }
}

/** A send ran into its turn's deadline: the turn timed out, it did not fail. */
export class TurnDeadline extends Error {
  constructor() {
    super("load: the turn's deadline was reached");
    this.name = "TurnDeadline";
  }
}

const METHODS: Record<string, string> = { get: "GET", post: "POST", put: "PUT", patch: "PATCH", delete: "DELETE", head: "HEAD" };
const VERBS = new Set(Object.values(METHODS));

/** The request options passed on to Playwright; anything else is refused. */
const ALLOWED_OPTIONS = new Set(["data", "form", "multipart", "headers", "params", "timeout", "failOnStatusCode", "ignoreHTTPSErrors"]);
/** Options checked here and never passed on as given. */
const CHECKED_OPTIONS = new Set(["method", "maxRetries", "maxRedirects"]);
const FORBIDDEN_HEADERS = new Set(["host", PERMIT_HEADER.toLowerCase()]);

export interface Turn {
  id: string;
  /** When the turn's permission ends, on the shared monotonic clock. */
  deadlineAt: number;
  ended: boolean;
}

export interface TransportOptions {
  baseURL: string | undefined;
  /** The shared monotonic clock (`sharedNowMs`); tests hand in their own. */
  now(): number;
  /** Whether a permit's generation is still good: false once the executor saw itself paused. */
  usable(permit: PermitGrant): boolean;
  ask: AskPermit;
  /** A permitted send has finished, one way or another. */
  done(permitId: string): void;
}

interface TurnState {
  outstanding: Set<Promise<unknown>>;
  responses: RealResponse[];
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

/** One user's session: a real context, reset after a timeout. */
export class UserSession {
  private context: Promise<RealContext> | null = null;
  private readonly turnStates = new Map<string, TurnState>();

  constructor(
    private readonly playwright: PlaywrightRequest,
    private readonly options: TransportOptions,
  ) {}

  private real(): Promise<RealContext> {
    this.context ??= this.playwright.newContext({
      baseURL: this.options.baseURL,
      maxRedirects: 0,
      // Deliberately no httpCredentials: a 401 Basic challenge is an answer, never a resend.
    });
    return this.context;
  }

  private stateOf(turn: Turn): TurnState {
    let state = this.turnStates.get(turn.id);
    if (!state) {
      state = { outstanding: new Set(), responses: [] };
      this.turnStates.set(turn.id, state);
    }
    return state;
  }

  /** Checks a call and builds exactly what will be asked for and sent; throws a refusal. */
  private prepare(verb: string, url: unknown, options: Record<string, unknown>): { absolute: string; forward: Record<string, unknown> } {
    if (typeof url !== "string") throw new LoadRefusal("requests take a URL string");
    for (const key of Object.keys(options)) {
      if (!ALLOWED_OPTIONS.has(key) && !CHECKED_OPTIONS.has(key)) throw new LoadRefusal(`the request option "${key}" is not supported in a load journey`);
    }
    if (options.maxRetries !== undefined && options.maxRetries !== 0) throw new LoadRefusal("retries are not allowed in a load journey");
    if (options.maxRedirects !== undefined && options.maxRedirects !== 0) throw new LoadRefusal("redirects are not followed in a load journey");
    if (!VERBS.has(verb)) throw new LoadRefusal(`the method ${verb} is not supported in a load journey`);
    let target: URL;
    try {
      target = new URL(url, this.options.baseURL);
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
    const forward: Record<string, unknown> = {};
    for (const key of ALLOWED_OPTIONS) if (key !== "params" && key !== "headers" && options[key] !== undefined) forward[key] = options[key];
    forward.headers = headers;
    return { absolute: target.href, forward };
  }

  /** The context the journey gets for one turn. */
  guarded(turn: Turn): Record<string, unknown> {
    const state = this.stateOf(turn);
    const send = async (method: string, url: unknown, options: Record<string, unknown> = {}) => {
      if (turn.ended) throw new LoadRefusal("this turn has ended");
      if (options === null || typeof options !== "object") throw new LoadRefusal("request options must be an object");
      const verb = String(method).toUpperCase();
      const { absolute, forward } = this.prepare(verb, url, options);
      const work = this.sendOnce(turn, state, verb, absolute, forward, options.timeout);
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
      storageState: async (options?: Record<string, unknown>) => (await this.real()).storageState(options),
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

  private async sendOnce(turn: Turn, state: TurnState, verb: string, absolute: string, forward: Record<string, unknown>, asked: unknown) {
    const context = await this.real();
    const permit = await this.options.ask({ turn: turn.id, method: verb, url: absolute });
    try {
      // Checked again at the send: a pause between the grant and here voids the permit.
      const now = this.options.now();
      if (now >= permit.expiresAt || !this.options.usable(permit)) throw new LoadRefusal("the permit expired before the send");
      // The permit bounds when the send may begin; the turn's deadline, how long it may last.
      const remaining = Math.floor(turn.deadlineAt - now);
      if (turn.ended || remaining <= 0) throw new LoadRefusal("this turn has ended");
      const timeout = typeof asked === "number" && asked > 0 ? Math.min(asked, remaining) : remaining;
      let response: RealResponse;
      try {
        response = await context.fetch(absolute, {
          ...forward,
          method: verb,
          headers: { ...(forward.headers as Record<string, string>), [PERMIT_HEADER]: permit.id },
          maxRetries: 0,
          maxRedirects: 0,
          timeout,
        });
      } catch (error) {
        // Playwright's own timeout, set to what was left of the turn, is the turn's deadline.
        if (this.options.now() >= turn.deadlineAt - 1) throw new TurnDeadline();
        throw error;
      }
      state.responses.push(response);
      return facade(response);
    } finally {
      this.options.done(permit.id);
    }
  }

  /**
   * After a turn: wait for the sends it left outstanding (each ends by the turn's deadline),
   * then release its responses. Cookies stay.
   */
  async afterTurn(turn: Turn): Promise<void> {
    const state = this.turnStates.get(turn.id);
    if (!state) return;
    while (state.outstanding.size > 0) await Promise.allSettled([...state.outstanding]);
    this.turnStates.delete(turn.id);
    await Promise.allSettled(state.responses.map((r) => r.dispose()));
  }

  /** After a timeout: drop the context (cancelling what is in flight); the next turn gets a new one. */
  async reset(): Promise<void> {
    const context = this.context;
    this.context = null;
    if (context) await context.then((c) => c.dispose({ reason: "load: turn deadline" })).catch(() => undefined);
  }
}
