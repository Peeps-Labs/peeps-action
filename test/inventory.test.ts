import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { gitBlobSha, specFilesOf } from "../src/inventory";

test("gitBlobSha matches git hash-object", () => {
  const content = Buffer.from('import { test } from "@playwright/test";\ntest("a", () => {});\n');
  const expected = execFileSync("git", ["hash-object", "--stdin"], { input: content })
    .toString()
    .trim();
  assert.equal(gitBlobSha(content), expected);
});

test("specFilesOf lists each spec file once, sorted", () => {
  const files = specFilesOf({
    config: {},
    suites: [
      { title: "b.spec.ts", specs: [{ title: "x", file: "b.spec.ts", line: 1 }] },
      {
        title: "a.spec.ts",
        suites: [
          { title: "D", specs: [{ title: "y", file: "a.spec.ts", line: 2 }, { title: "z", file: "a.spec.ts", line: 3 }] },
        ],
      },
    ],
  });
  assert.deepEqual(files, ["a.spec.ts", "b.spec.ts"]);
});
