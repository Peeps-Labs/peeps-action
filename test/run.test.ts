import { test } from "node:test";
import assert from "node:assert/strict";
import { grepFor } from "../src/run";

test("grepFor anchors each planned title at the end of Playwright's space-joined title", () => {
  const grep = grepFor([
    "Order approval › approve button is available @smoke",
    "dispatch board is ready @flaky",
    "Order approval › approve button is available @smoke",
  ]);
  const re = new RegExp(grep);
  assert.equal(
    re.test("core/order-approval.spec.ts Order approval approve button is available @smoke"),
    true,
  );
  assert.equal(re.test("chromium core/x.spec.ts dispatch board is ready @flaky"), true);
  assert.equal(re.test("core/x.spec.ts dispatch board is ready @flaky and more"), false);
  assert.equal(re.test("core/x.spec.ts dispatchboard is ready @flaky"), false);
  // Duplicates collapse: the first title appears once in the pattern. Split on
  // the title text alone, not on a trailing `$`: the title is followed by the
  // optional-tag group, so anchoring this assertion to the pattern's exact
  // suffix would make it fail whenever that suffix legitimately changes.
  assert.equal(
    grep.split("Order approval approve button is available @smoke").length,
    2,
  );
});

test("grepFor escapes regex metacharacters in titles", () => {
  const re = new RegExp(grepFor(["handles (parens) and [brackets] + dots."]));
  assert.equal(re.test("a.spec.ts handles (parens) and [brackets] + dots."), true);
  assert.equal(re.test("a.spec.ts handles (parens) and [brackets] + dotsX"), false);
});
