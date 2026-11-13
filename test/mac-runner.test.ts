import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import path from "node:path";

const script = path.join(__dirname, "..", "mac-runner", "setup.sh");

function run(env: Record<string, string>, args: string[] = []) {
  const { PATH, HOME } = process.env;
  return spawnSync("bash", [script, ...args], {
    env: { PATH: PATH ?? "", HOME: HOME ?? "/tmp", ...env },
    encoding: "utf8",
  });
}

test("setup.sh refuses to install without a scope and a label", () => {
  // No customer's repository or label is a default: the script is public.
  const r = run({});
  assert.equal(r.status, 1);
  assert.match(r.stderr, /set RUNNER_SCOPE .* and RUNNER_LABEL/);
});

test("setup.sh refuses a label runs-on could not match", () => {
  const r = run({ RUNNER_SCOPE: "acme/ios", RUNNER_LABEL: "ios mac" });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /RUNNER_LABEL may hold only/);
});

test("setup.sh stops before touching anything off macOS", { skip: process.platform === "darwin" }, () => {
  const r = run({ RUNNER_SCOPE: "acme/ios", RUNNER_LABEL: "ios-mac" });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /this script is for macOS/);
});

test("mac-runner commands need an installed runner", () => {
  const r = run({ RUNNER_LABEL: "nothing-installed-here" }, ["status"]);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /no runner installed/);
});

test("setup.sh rejects an unknown command", () => {
  const r = run({}, ["launch"]);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /usage:/);
});
