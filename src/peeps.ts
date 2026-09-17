/**
 * The runner's client for Peeps cloud. Authenticates with the job's GitHub
 * OIDC token (audience fixed to https://peepsai.com, the same for every Peeps
 * environment) or, outside GitHub Actions, with PEEPS_API_KEY.
 */

import type { RunnerEnv } from "./env";

export const PEEPS_OIDC_AUDIENCE = "https://peepsai.com";

/** `exp` of a JWT in ms, or "far future" for an opaque API key. */
function expiryOf(token: string): number {
  const parts = token.split(".");
  if (parts.length !== 3) return Number.MAX_SAFE_INTEGER;
  try {
    const payload = JSON.parse(Buffer.from(parts[1]!, "base64url").toString("utf8")) as { exp?: number };
    return typeof payload.exp === "number" ? payload.exp * 1000 : Number.MAX_SAFE_INTEGER;
  } catch {
    return Number.MAX_SAFE_INTEGER;
  }
}

export class PeepsClient {
  private tokenPromise: Promise<string> | null = null;
  private tokenExpiresAt = 0;

  constructor(private readonly env: RunnerEnv) {}

  /**
   * The bearer token Peeps accepts for this job. GitHub's OIDC tokens live
   * about ten minutes and can be re-requested for as long as the job runs, so
   * an agent session lasting longer than that re-mints transparently.
   */
  async token(): Promise<string> {
    if (this.tokenPromise && Date.now() < this.tokenExpiresAt - 60_000) return this.tokenPromise;
    this.tokenPromise = this.mintToken().then((token) => {
      this.tokenExpiresAt = expiryOf(token);
      return token;
    });
    return this.tokenPromise;
  }

  private async mintToken(): Promise<string> {
    // OIDC first, and `PEEPS_API_KEY` only as the off-GitHub fallback. The key
    // used to be read at the top of this function, which read as though it
    // were being preferred.
    if (this.env.oidc) {
      const url = new URL(this.env.oidc.requestUrl);
      url.searchParams.set("audience", PEEPS_OIDC_AUDIENCE);
      // GitHub's token service answers 5xx now and then (a 503 killed one
      // agent job before it attached); a 4xx is a real permissions problem.
      for (let attempt = 1; ; attempt++) {
        const response = await fetch(url, {
          headers: {
            Authorization: `Bearer ${this.env.oidc.requestToken}`,
            Accept: "application/json",
          },
        });
        if (response.ok) {
          const data = (await response.json()) as { value?: string };
          if (!data.value) throw new Error("GitHub returned no OIDC token value");
          return data.value;
        }
        if (response.status < 500 || attempt >= 5) {
          throw new Error(
            `Could not obtain a GitHub OIDC token (${response.status}). Does the job have \`permissions: id-token: write\`?`,
          );
        }
        console.log(`[peeps] OIDC token request returned ${response.status}; retrying (${attempt}/5)`);
        await new Promise((r) => setTimeout(r, 2_000 * attempt));
      }
    }
    const apiKey = process.env.PEEPS_API_KEY;
    if (apiKey) return apiKey;
    throw new Error(
      "No credentials: run inside GitHub Actions with `id-token: write`, or set PEEPS_API_KEY.",
    );
  }

  /** Raw upload (artifacts). Retries transient failures a couple of times. */
  async postBytes(path: string, bytes: Buffer): Promise<void> {
    let lastError: unknown;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const response = await fetch(`${this.env.peepsUrl}${path}`, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${await this.token()}`,
            "Content-Type": "application/octet-stream",
            "Content-Length": String(bytes.byteLength),
            "User-Agent": "peeps-action/0.1",
          },
          body: new Uint8Array(bytes),
          signal: AbortSignal.timeout(120_000),
        });
        if (response.ok) return;
        const text = await response.text();
        if (response.status < 500 && response.status !== 408 && response.status !== 429) {
          throw new Error(`Peeps ${path} → ${response.status}: ${text.slice(0, 300)}`);
        }
        lastError = new Error(`Peeps ${path} → ${response.status}`);
      } catch (error) {
        lastError = error;
      }
      await new Promise((r) => setTimeout(r, 1500 * (attempt + 1)));
    }
    throw lastError instanceof Error ? lastError : new Error(String(lastError));
  }

  /** GET that treats 204 as "nothing" (long-poll idle) instead of an error. */
  async getOrNull<T>(path: string): Promise<T | null> {
    const response = await fetch(`${this.env.peepsUrl}${path}`, {
      headers: {
        Authorization: `Bearer ${await this.token()}`,
        Accept: "application/json",
        "User-Agent": "peeps-action/0.1",
      },
      signal: AbortSignal.timeout(40_000),
    });
    if (response.status === 204) return null;
    const text = await response.text();
    if (!response.ok) {
      throw new Error(`Peeps ${path} → ${response.status}: ${text.slice(0, 500)}`);
    }
    return JSON.parse(text) as T;
  }

  async get<T>(path: string): Promise<T> {
    const response = await fetch(`${this.env.peepsUrl}${path}`, {
      headers: {
        Authorization: `Bearer ${await this.token()}`,
        Accept: "application/json",
        "User-Agent": "peeps-action/0.1",
      },
    });
    const text = await response.text();
    if (!response.ok) {
      throw new Error(`Peeps ${path} → ${response.status}: ${text.slice(0, 500)}`);
    }
    return JSON.parse(text) as T;
  }

  async post<T>(path: string, body: unknown): Promise<T> {
    const response = await fetch(`${this.env.peepsUrl}${path}`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${await this.token()}`,
        "Content-Type": "application/json",
        Accept: "application/json",
        "User-Agent": "peeps-action/0.1",
      },
      body: JSON.stringify(body),
    });
    const text = await response.text();
    if (!response.ok) {
      throw new Error(`Peeps ${path} → ${response.status}: ${text.slice(0, 500)}`);
    }
    return (text ? JSON.parse(text) : {}) as T;
  }
}
