/**
 * `action.yml`'s load inputs (CW plan §4.1, §6.2): optional, with no default, so the action adds
 * no expression GitHub evaluates in existing customers' jobs.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";

const text = readFileSync(path.resolve(__dirname, "../action.yml"), "utf8");
const inputsBlock = text.slice(text.indexOf("\ninputs:\n") + 9, text.indexOf("\nruns:"));
/** Each input's own lines, by name. */
const inputs = new Map(inputsBlock.split(/\n(?= {2}[a-z-]+:\n)/).map((block) => [/^ {2}([a-z-]+):/.exec(block)![1]!, block]));

test("load-grant and load-workload exist, are optional and have no default", () => {
  for (const name of ["load-grant", "load-workload"]) {
    const block = inputs.get(name);
    assert.ok(block, name);
    assert.match(block, /^ {4}required: false$/m);
    assert.doesNotMatch(block, /^ {4}default:/m);
  }
});

test("no input default but github-token's is an expression, and none reads the job or the matrix", () => {
  for (const [name, block] of inputs) {
    const value = /^ {4}default: (.*)$/m.exec(block)?.[1] ?? "";
    if (name === "github-token") assert.equal(value, '"${{ github.token }}"');
    else assert.doesNotMatch(value, /\$\{\{/, name);
    assert.doesNotMatch(value, /\b(?:job|strategy|matrix)\./, name);
  }
});

test("mode's description no longer says load refuses, and names the commit pin", () => {
  const mode = inputs.get("mode")!;
  assert.doesNotMatch(mode, /refuses and exits 1|isn't available yet/);
  assert.match(mode, /load \(a Peeps load run[^)]*pinned to a commit\)/);
});
