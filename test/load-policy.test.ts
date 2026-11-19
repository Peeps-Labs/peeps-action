/** What a journey may send: exact origins, read methods, the plan's allowed requests. */
import { test } from "node:test";
import assert from "node:assert/strict";

import { FOLLOWS_REDIRECTS, checkRequest } from "../src/load/policy";

const policy = {
  allowedOrigins: ["https://staging.example.com", "http://127.0.0.1:3200"],
  allowedRequests: [{ method: "POST" as const, path: "/auth/token" }],
};

test("reads go anywhere on an allowed origin", () => {
  for (const method of ["GET", "HEAD", "OPTIONS", "get"]) {
    assert.deepEqual(checkRequest(policy, method, "https://staging.example.com/api/robots?x=1"), { ok: true, origin: "https://staging.example.com" });
  }
  assert.equal(checkRequest(policy, "GET", "http://127.0.0.1:3200/c/api/robots").ok, true);
});

test("writes go only where the plan allows, by method and exact path", () => {
  assert.equal(checkRequest(policy, "POST", "https://staging.example.com/auth/token").ok, true);
  assert.equal(checkRequest(policy, "POST", "https://staging.example.com/auth/token?next=1").ok, true);
  assert.deepEqual(checkRequest(policy, "POST", "https://staging.example.com/auth/token/x"), { ok: false, reason: "method" });
  assert.deepEqual(checkRequest(policy, "PUT", "https://staging.example.com/auth/token"), { ok: false, reason: "method" });
  assert.deepEqual(checkRequest(policy, "DELETE", "https://staging.example.com/"), { ok: false, reason: "method" });
});

test("an unlisted origin is refused: another host, port, scheme or a lookalike", () => {
  for (const url of [
    "https://prod.example.com/",
    "https://staging.example.com:8443/",
    "http://staging.example.com/",
    "https://staging.example.com.evil.test/",
    "http://127.0.0.1:3201/",
    "http://localhost:3200/",
  ]) {
    assert.deepEqual(checkRequest(policy, "GET", url), { ok: false, reason: "origin" }, url);
  }
});

test("credentials in the URL, other schemes and garbage are refused", () => {
  assert.deepEqual(checkRequest(policy, "GET", "https://u:p@staging.example.com/"), { ok: false, reason: "url" });
  assert.deepEqual(checkRequest(policy, "GET", "file:///etc/passwd"), { ok: false, reason: "url" });
  assert.deepEqual(checkRequest(policy, "GET", "/relative"), { ok: false, reason: "url" });
});

test("redirects are not followed", () => {
  assert.equal(FOLLOWS_REDIRECTS, false);
});
