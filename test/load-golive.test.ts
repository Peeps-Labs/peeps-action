/**
 * The go line's workflow source (e5 plan §7, v3 §4): pinned by its checksum, never run from
 * peeps-action, and unable to aim load anywhere but the harness. Text assertions: the file is
 * small, and nothing here needs a YAML parser.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";

const DIR = path.resolve(__dirname, "../fixtures/load-golive");
const text = readFileSync(path.join(DIR, "workflow.yml"), "utf8");
const lines = text.split("\n").filter((l) => !/^\s*#/.test(l));
const code = lines.join("\n");

test("the source's bytes are the ones its checksum pins", () => {
  const [digest, name] = readFileSync(path.join(DIR, "workflow.yml.sha256"), "utf8").trim().split(/\s+/);
  assert.equal(name, "workflow.yml");
  assert.equal(createHash("sha256").update(text).digest("hex"), digest);
});

test("it is a source, not a workflow of this repository", () => {
  const workflows = path.resolve(__dirname, "../.github/workflows");
  for (const file of readdirSync(workflows)) assert.doesNotMatch(readFileSync(path.join(workflows, file), "utf8"), /dist\/load\.js|PEEPS_LOAD_GRANT/, file);
  assert.equal(existsSync(path.join(workflows, "load-golive.yml")), false);
});

test("dispatch only, with the grant and the runner image as its only inputs", () => {
  const on = code.slice(code.indexOf("\non:"), code.indexOf("\npermissions:"));
  assert.match(on, /^\s{2}workflow_dispatch:$/m);
  assert.doesNotMatch(on, /\b(?:push|pull_request|pull_request_target|schedule|workflow_run|workflow_call|repository_dispatch|issue_comment)\b/);
  const inputs = [...on.matchAll(/^ {6}([a-z-]+):$/gm)].map((m) => m[1]);
  assert.deepEqual(inputs, ["peeps-load-grant", "runner"]);
  assert.match(on, /options:\n\s+- ubuntu-24\.04\n\s+- ubuntu-22\.04\n?$/);
});

test("it runs only in the fixture repository, on a first attempt, with read access and an OIDC token", () => {
  assert.match(code, /^ {4}if: github\.repository == 'Peeps-Labs\/peeps-load-fixture' && github\.run_attempt == 1$/m);
  assert.match(code, /^permissions:\n {2}contents: read\n {2}id-token: write\n/m);
  assert.doesNotMatch(code, /secrets\./);
  assert.equal(code.match(/persist-credentials: false/g)?.length, 2);
});

test("Peeps' origin and the sink are written in the file; only the grant comes from an input, and only through the environment", () => {
  const env = code.slice(code.indexOf("        env:\n"));
  assert.match(env, /^ {10}PEEPS_URL: https:\/\/peeps-dev\.fly\.dev$/m);
  assert.match(env, /^ {10}PEEPS_LOAD_SINK_HOSTS: [a-z0-9.-]+$/m);
  assert.match(env, /^ {10}PEEPS_LOAD_GRANT: \$\{\{ inputs\.peeps-load-grant \}\}$/m);
  for (const line of lines) {
    if (/inputs\.peeps-load-grant/.test(line)) assert.match(line, /^ {10}PEEPS_LOAD_GRANT: /, "the grant reaches no script text");
    if (/^\s+run:/.test(line)) assert.doesNotMatch(line, /\$\{\{/, "no expression is spliced into a script");
  }
  assert.match(code, /run: node "\$GITHUB_WORKSPACE\/action\/dist\/load\.js"/);
});

test("the action is checked out at one pinned commit, the all-zero placeholder the fixture's copy replaces", () => {
  assert.match(code, /repository: Peeps-Labs\/peeps-action\n\s+ref: 0{40}\n/);
  assert.equal(text.match(/\b[0-9a-f]{40}\b/g)?.length, 1);
});
