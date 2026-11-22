/**
 * The control origin a customer load run accepts (CW plan §4.2, §6.2): one of Peeps' three
 * origins, exactly, or a refusal. No production default.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { LOAD_CONTROL_ORIGINS, loadControlOrigin } from "../src/load/control-origin";

const REFUSED = { ok: false, refused: "control_origin" };

test("unset or empty is refused: there is no production default", () => {
  assert.deepEqual(loadControlOrigin(undefined), REFUSED);
  assert.deepEqual(loadControlOrigin(""), REFUSED);
});

test("each of Peeps' origins is itself, with one trailing slash dropped", () => {
  for (const origin of LOAD_CONTROL_ORIGINS) {
    assert.deepEqual(loadControlOrigin(origin), { ok: true, origin });
    assert.deepEqual(loadControlOrigin(`${origin}/`), { ok: true, origin });
    assert.deepEqual(loadControlOrigin(`${origin}//`), REFUSED, "only one slash");
  }
});

test("anything else is refused: another scheme, a port, a path, a query, credentials, an alias, loopback, case", () => {
  for (const raw of [
    "http://dev.peepsai.com",
    "https://dev.peepsai.com:8443",
    "https://dev.peepsai.com:443",
    "https://dev.peepsai.com/api",
    "https://dev.peepsai.com?x=1",
    "https://dev.peepsai.com#x",
    "https://user@dev.peepsai.com",
    "https://peeps-dev.fly.dev",
    "http://localhost:3000",
    "https://localhost",
    "https://127.0.0.1",
    "https://DEV.peepsai.com",
    " https://dev.peepsai.com",
    "https://dev.peepsai.com.evil.example",
  ]) assert.deepEqual(loadControlOrigin(raw), REFUSED, raw);
});

test("the set is load-job-v1's control-origins.json, and src/ reads nothing from test/", () => {
  const copied = JSON.parse(readFileSync(path.resolve(__dirname, "fixtures/load-job/v1/control-origins.json"), "utf8")) as string[];
  assert.deepEqual([...LOAD_CONTROL_ORIGINS], copied);
  assert.doesNotMatch(readFileSync(path.resolve(__dirname, "../src/load/control-origin.ts"), "utf8"), /from "[^"]*test\//);
});
