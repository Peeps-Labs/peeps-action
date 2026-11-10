/** What a test's browser coverage proves: its keys, and when it reads partial. Real Chromium is in evidence-cdp.test.ts. */
import { test } from "node:test";
import assert from "node:assert/strict";

import { browserFootprint, builtFileOf, partialReasons, type AttemptCoverage } from "../src/evidence/browser/rules";
import type { ScriptIndex } from "../src/evidence/fingerprint/rules";

const whole: AttemptCoverage = {
  browser: "chromium",
  scripts: [],
  sheets: [],
  assets: [],
  covered: [],
  lost: 0,
  errors: [],
  navigations: 0,
};

const scripts = new Map<string, ScriptIndex>([
  [
    "static/chunks/app.js",
    {
      spans: [
        { start: 10, end: 400, key: null, source: null },
        { start: 20, end: 120, key: "fn:browser:src/cart.tsx:addItem", source: "src/cart.tsx" },
        { start: 130, end: 200, key: "fn:browser:src/cart.tsx:removeItem", source: "src/cart.tsx" },
        { start: 210, end: 300, key: "fn:browser:src/lib/price.ts:price", source: "src/lib/price.ts" },
      ],
    },
  ],
  ["static/chunks/vendor.js", { spans: [], whole: "out:static/chunks/vendor.js" }],
]);
const sheets = new Map<string, ScriptIndex>([
  [
    "static/chunks/app.css",
    {
      spans: [
        { start: 0, end: 50, key: "css:src/app/globals.css", source: null },
        { start: 50, end: 90, key: "css:src/cart.module.css", source: null },
      ],
    },
  ],
]);
const index = { scripts, sheets };
const APP = "http://127.0.0.1:3000/_next/static/chunks/app.js";

test("a built asset's URL names its file under .next, with a basePath or an asset prefix", () => {
  assert.equal(builtFileOf("http://127.0.0.1:3000/_next/static/chunks/app.js"), "static/chunks/app.js");
  assert.equal(builtFileOf("https://cdn.example.com/u/_next/static/css/app.css?v=1"), "static/css/app.css");
  assert.equal(builtFileOf("http://127.0.0.1:3000/_next/static/chunks/a%20b.js"), "static/chunks/a b.js");
  assert.equal(builtFileOf("http://127.0.0.1:3000/api/cart"), null);
  assert.equal(builtFileOf(""), null);
});

test("ran functions map onto their keys, each with its file", () => {
  const footprint = browserFootprint(
    { ...whole, scripts: [{ url: APP, functions: [{ name: "addItem", start: 20, end: 120 }, { name: "price", start: 210, end: 300 }] }], covered: [APP], assets: [APP] },
    index,
  );
  assert.deepEqual(footprint, {
    keys: ["file:src/cart.tsx", "file:src/lib/price.ts", "fn:browser:src/cart.tsx:addItem", "fn:browser:src/lib/price.ts:price"],
    partial: [],
    reasons: [],
    mapped: 2,
    unmapped: 0,
  });
});

test("a function V8 starts elsewhere still maps by its end", () => {
  const footprint = browserFootprint({ ...whole, scripts: [{ url: APP, functions: [{ name: "removeItem", start: 127, end: 200 }] }], covered: [APP] }, index);
  assert.deepEqual(footprint.keys, ["file:src/cart.tsx", "fn:browser:src/cart.tsx:removeItem"]);
});

test("scaffolding and the script's own top level are no keys and no misses", () => {
  const footprint = browserFootprint(
    { ...whole, scripts: [{ url: APP, functions: [{ name: "", start: 0, end: 500 }, { name: "", start: 10, end: 400 }] }], covered: [APP] },
    index,
  );
  assert.deepEqual([footprint.keys, footprint.unmapped, footprint.partial], [[], 0, []]);
});

test("a built function with no key reads partial for code: what ran can't be named", () => {
  const footprint = browserFootprint({ ...whole, scripts: [{ url: APP, functions: [{ name: "mystery", start: 301, end: 350 }] }], covered: [APP] }, index);
  assert.deepEqual([footprint.unmapped, footprint.partial, footprint.reasons], [1, ["code", "css"], ["unmapped"]]);
});

test("V8's synthetic class initializers land on the span that encloses them", () => {
  for (const name of ["<static_initializer>", "<instance_members_initializer>"]) {
    const footprint = browserFootprint({ ...whole, scripts: [{ url: APP, functions: [{ name, start: 135, end: 180 }] }], covered: [APP] }, index);
    assert.deepEqual([footprint.keys, footprint.unmapped], [["file:src/cart.tsx", "fn:browser:src/cart.tsx:removeItem"], 0], name);
  }
  // A named function that matches nothing still reads unmapped: containment is only for what V8 invents.
  const named = browserFootprint({ ...whole, scripts: [{ url: APP, functions: [{ name: "helper", start: 135, end: 180 }] }], covered: [APP] }, index);
  assert.equal(named.unmapped, 1);
});

test("a script with no map is one key, whatever ran in it; foreign scripts aren't the app's build", () => {
  const vendor = "http://127.0.0.1:3000/_next/static/chunks/vendor.js";
  const footprint = browserFootprint(
    {
      ...whole,
      scripts: [
        { url: vendor, functions: [{ name: "x", start: 5, end: 9 }] },
        { url: "https://www.googletagmanager.com/gtag/js", functions: [{ name: "gtag", start: 1, end: 5 }] },
        { url: "", functions: [{ name: "evaled", start: 1, end: 5 }] },
      ],
    },
    index,
  );
  assert.deepEqual([footprint.keys, footprint.unmapped], [["out:static/chunks/vendor.js"], 0]);
});

test("a built script missing from the fingerprint reads partial", () => {
  const stale = "http://127.0.0.1:3000/_next/static/chunks/other.js";
  const footprint = browserFootprint({ ...whole, scripts: [{ url: stale, functions: [{ name: "f", start: 1, end: 5 }] }] }, index);
  assert.deepEqual([footprint.unmapped, footprint.reasons], [1, ["unmapped"]]);
});

test("used CSS maps onto its stylesheet section", () => {
  const css = "http://127.0.0.1:3000/_next/static/chunks/app.css";
  const footprint = browserFootprint({ ...whole, sheets: [{ url: css, used: [{ start: 55, end: 70 }] }], covered: [css], assets: [css] }, index);
  assert.deepEqual([footprint.keys, footprint.partial], [["css:src/cart.module.css"], []]);
});

test("partial: a lost target, a take error, a cross-document navigation, an asset coverage never saw", () => {
  assert.deepEqual(partialReasons(whole), []);
  assert.deepEqual(partialReasons({ ...whole, lost: 1 }), ["target_lost"]);
  assert.deepEqual(partialReasons({ ...whole, errors: ["take js: timeout"] }), ["take_error"]);
  assert.deepEqual(partialReasons({ ...whole, navigations: 1 }), ["navigation"]);
  assert.deepEqual(partialReasons({ ...whole, assets: [APP], covered: [] }), ["asset_missing"]);
  assert.deepEqual(partialReasons({ ...whole, assets: [`${APP}#x`], covered: [APP] }), []);
  assert.deepEqual(partialReasons({ ...whole, refused: "page_coverage" }), ["refused:page_coverage"]);
});

test("a WebKit or Firefox leg reads partial for code and CSS, never empty", () => {
  for (const browser of ["webkit", "firefox"]) {
    const footprint = browserFootprint({ ...whole, browser }, index);
    assert.deepEqual([footprint.partial, footprint.reasons], [["code", "css"], ["browser_unsupported"]]);
  }
});

test("a target whose coverage started late reads partial", () => {
  assert.deepEqual(partialReasons({ ...whole, late: 1 }), ["started_late"]);
  assert.deepEqual(partialReasons({ ...whole, late: 0 }), []);
});

test("a target that may share another's isolate reads partial", () => {
  assert.deepEqual(partialReasons({ ...whole, sharedIsolate: 1 }), ["shared_isolate"]);
});
