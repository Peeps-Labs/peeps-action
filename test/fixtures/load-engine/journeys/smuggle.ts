import type { APIRequestContext } from "@playwright/test";

type Loose = Record<string, (url: unknown, options?: Record<string, unknown>) => Promise<unknown>>;

/**
 * Tries to send somewhere other than what the permit approves: a `url` option over the
 * positional one, a method option on `get`, a Host header, its own permit header, an unknown
 * option. Each must be refused before anything is sent; then one honest read.
 */
export async function smuggle(request: APIRequestContext): Promise<void> {
  const r = request as unknown as Loose;
  const attempts: [string, Record<string, unknown>][] = [
    ["/value", { url: "/smuggled" }],
    ["/value", { method: "DELETE" }],
    ["/value", { headers: { Host: "elsewhere.example.com" } }],
    ["/value", { headers: { "x-peeps-load-permit": "forged" } }],
    ["/value", { proxy: { server: "http://elsewhere.example.com" } }],
  ];
  for (const [url, options] of attempts) {
    try {
      await r.get!(url, options);
    } catch {
      // refused: what the engine must do
    }
  }
  await r.get!("/value", { params: { from: "smuggle" } });
}
