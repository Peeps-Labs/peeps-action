/**
 * The executor's side of every send (T3). Each user has one Playwright `APIRequestContext`,
 * made with no `httpCredentials` (so Playwright has no auth challenge to answer by sending
 * again) and `maxRedirects: 0`. The journey never sees that context: it gets a guarded one
 * whose every call
 *
 *   - is refused if the turn is over, or if it asks for retries or redirects;
 *   - waits for a permit from the supervisor first, and is refused without one;
 *   - goes out at most once: `maxRetries: 0`, `maxRedirects: 0`, a `timeout` that ends at the
 *     turn's deadline, and the header `X-Peeps-Load-Permit: <id>`.
 *
 * Responses are disposed after the turn; cookies stay with the user's context. After a
 * timeout the user's context is disposed (which cancels what is in flight) and a fresh one is
 * made for its next turn.
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
}

/** Asks the supervisor for a permit; rejects with the refusal's reason. */
export type AskPermit = (request: { turn: string; method: string; url: string }) => Promise<PermitGrant>;

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

export interface Turn {
  id: string;
  /** `performance.now()` at which the turn's permission ends. */
  deadlineAt: number;
  ended: boolean;
}

export interface TransportOptions {
  baseURL: string | undefined;
  /** How long after a permit arrives the send must begin (a pause in between voids it). */
  permitTtlMs: number;
  now(): number;
  ask: AskPermit;
  /** A permitted send has finished, one way or another. */
  done(permitId: string): void;
}

/** One user's session: a real context, reset after a timeout. */
export class UserSession {
  private context: RealContext | null = null;
  private responses: RealResponse[] = [];

  constructor(
    private readonly playwright: PlaywrightRequest,
    private readonly options: TransportOptions,
  ) {}

  private async real(): Promise<RealContext> {
    this.context ??= await this.playwright.newContext({
      baseURL: this.options.baseURL,
      maxRedirects: 0,
      // Deliberately no httpCredentials: a 401 Basic challenge is an answer, never a resend.
    });
    return this.context;
  }

  /** The context the journey gets for one turn. */
  guarded(turn: Turn): Record<string, unknown> {
    const send = async (method: string, url: unknown, options: Record<string, unknown> = {}) => {
      if (turn.ended) throw new LoadRefusal("this turn has ended");
      if (typeof url !== "string") throw new LoadRefusal("requests take a URL string");
      if (options.maxRetries !== undefined && options.maxRetries !== 0) throw new LoadRefusal("retries are not allowed in a load journey");
      if (options.maxRedirects !== undefined && options.maxRedirects !== 0) throw new LoadRefusal("redirects are not followed in a load journey");
      const verb = String(options.method ?? method).toUpperCase();
      let absolute: string;
      try {
        absolute = new URL(url, this.options.baseURL).href;
      } catch {
        throw new LoadRefusal(`not a URL: ${url}`);
      }
      const context = await this.real();
      const permit = await this.options.ask({ turn: turn.id, method: verb, url: absolute });
      const receivedAt = this.options.now();
      const remaining = Math.floor(turn.deadlineAt - receivedAt);
      if (turn.ended || remaining <= 0) {
        this.options.done(permit.id);
        throw new LoadRefusal("this turn has ended");
      }
      try {
        // A pause between the permit and the send (SIGSTOP, a suspended VM) voids the permit.
        if (this.options.now() - receivedAt > this.options.permitTtlMs) throw new LoadRefusal("the permit expired before the send");
        const headers = { ...((options.headers as Record<string, string> | undefined) ?? {}), [PERMIT_HEADER]: permit.id };
        const timeout = typeof options.timeout === "number" && options.timeout > 0 ? Math.min(options.timeout, remaining) : remaining;
        let response: RealResponse;
        try {
          response = await context.fetch(absolute, {
            ...options,
            method: verb,
            headers,
            maxRetries: 0,
            maxRedirects: 0,
            timeout,
          });
        } catch (error) {
          // Playwright's own timeout, set to what was left of the turn, is the turn's deadline.
          if (this.options.now() >= turn.deadlineAt - 1) throw new TurnDeadline();
          throw error;
        }
        this.responses.push(response);
        return response;
      } finally {
        this.options.done(permit.id);
      }
    };
    const api: Record<string, unknown> = {
      fetch: (url: unknown, options?: Record<string, unknown>) => send("GET", url, options),
      storageState: async (options?: Record<string, unknown>) => (await this.real()).storageState(options),
      dispose: async () => {
        throw new LoadRefusal("a journey cannot dispose its request context");
      },
    };
    for (const [name, verb] of Object.entries(METHODS)) {
      api[name] = (url: unknown, options?: Record<string, unknown>) => send(verb, url, { ...options, method: verb });
    }
    return api;
  }

  /** After a turn: release response bodies, keep cookies. */
  async afterTurn(): Promise<void> {
    const responses = this.responses;
    this.responses = [];
    await Promise.allSettled(responses.map((r) => r.dispose()));
  }

  /** After a timeout: drop the context (cancelling what is in flight); the next turn gets a new one. */
  async reset(): Promise<void> {
    const context = this.context;
    this.context = null;
    this.responses = [];
    if (context) await context.dispose({ reason: "load: turn deadline" }).catch(() => undefined);
  }
}
