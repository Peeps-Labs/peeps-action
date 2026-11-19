/**
 * What a journey may send: only to the environment's exact origins; GET, HEAD and OPTIONS
 * anywhere on them; any other method only as one of the plan's allowed requests, matched on
 * method and exact path. Redirects are never followed (the transport sets `maxRedirects: 0`):
 * a redirect is an answer, not a second request.
 *
 * Pure: no file system, network or Playwright.
 */
import type { AllowedRequest } from "./plan-input";

export const READ_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);
export const FOLLOWS_REDIRECTS = false;

export interface RequestPolicy {
  allowedOrigins: readonly string[];
  allowedRequests: readonly AllowedRequest[];
}

export type PolicyAnswer = { ok: true; origin: string } | { ok: false; reason: "url" | "origin" | "method" };

export function checkRequest(policy: RequestPolicy, method: string, url: string): PolicyAnswer {
  let parsed: URL;
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
