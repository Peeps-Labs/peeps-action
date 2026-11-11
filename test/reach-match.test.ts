import { test } from "node:test";
import assert from "node:assert/strict";

import { surfaceMeetsPath } from "../src/reach/match";

const cases: Array<[string, string, boolean, string]> = [
  ["/:orgSlug/test-cases", "/peepsai/test-cases", true, "a parameter meets any one segment"],
  ["/:orgSlug", "/acme", true, "a route group contributed nothing, so this is one segment"],
  ["/:orgSlug", "/acme/settings", false, "one segment, not two"],
  ["/settings/**", "/settings/billing", true, "a layout meets what's beneath it"],
  ["/settings/**", "/settings", true, "and its own path"],
  ["/settings/**", "/settingsx", false, "a segment, not a prefix"],
  ["/docs/*", "/docs/a/b/c", true, "a catch-all meets any depth"],
  ["/docs/*", "/docs", false, "a catch-all needs a segment"],
  ["/cart", "/cart/items", false, "/cart/items is not /cart"],
  ["/cart", "/cart", true, "exact"],
  ["/cart", "/cart/", true, "a trailing slash is the same page"],
  ["/orders/:id", "/orders/:id", true, "a folded segment meets a parameter"],
  ["/invites/accept", "/invites/:id", true, "a folded segment could be anything, so it meets a literal"],
  ["/invites/accept", "/other/:id", false, "the other segments still count"],
  ["/api/trpc/runs.list", "/api/trpc/runs.list", true, "a procedure"],
  ["/api/trpc/runs.list", "/api/trpc/runs.get", false, "another procedure"],
  ["/api/trpc/:trpc", "/api/trpc/runs.get", true, "the handler meets every procedure"],
  ["/Cart", "/cart", true, "Express ignores case by default, so a doubt meets"],
  ["/café", "/caf%C3%A9", true, "an encoded path is the same page"],
  ["/my page", "/my%20page", true, "a space"],
  ["/caf%C3%A9", "/café", true, "both ways"],
  ["/cart", "/cart;jsessionid=A1B2", true, "a path parameter isn't the path"],
  ["/cart", "/cart;v=1/", true, "with a trailing slash"],
  ["/cart", "/%E0%A4%A", true, "a malformed escape meets, not misses"],
  ["/%E0%A4%A", "/cart", true, "on either side"],
  ["/cart/items", "/%E0%A4%A", false, "the shape still counts"],
  ["/", "/", true, "the root"],
  ["/", "/cart", false, "the root page isn't every page"],
];

for (const [surface, path, expected, why] of cases) {
  test(`${surface} ${expected ? "meets" : "does not meet"} ${path}: ${why}`, () => {
    assert.equal(surfaceMeetsPath(surface, path), expected);
  });
}
