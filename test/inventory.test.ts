import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { gitBlobSha, specFilesOf, testFilesOf } from "../src/inventory";

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

test("the test files Playwright filters on are its file suites, not where a helper registered a test (PQA-3201 PR 3)", () => {
  const list = {
    config: {},
    suites: [
      { title: "a.spec.ts", file: "a.spec.ts", specs: [{ title: "own", file: "a.spec.ts", line: 2 }], suites: [{ title: "group", file: "a.spec.ts", specs: [{ title: "shared", file: "../helpers/shared.ts", line: 3 }] }] },
      { title: "b.spec.ts", file: "b.spec.ts", specs: [] },
    ],
  };
  assert.deepEqual(testFilesOf(list), ["a.spec.ts", "b.spec.ts"]);
  assert.deepEqual(specFilesOf(list), ["../helpers/shared.ts", "a.spec.ts"]);
});

test("a file only setup or teardown projects run isn't a test file of its own: Playwright runs it with every dependent file", () => {
  const spec = (title: string, file: string, projectName: string) => ({ title, file, line: 1, tests: [{ projectName }] });
  const list = {
    config: { projects: [{ name: "setup", dependencies: [] }, { name: "cleanup" }, { name: "chromium", dependencies: ["setup"], teardown: "cleanup" }] },
    suites: [
      { title: "auth.setup.ts", file: "auth.setup.ts", specs: [spec("logs in", "auth.setup.ts", "setup")] },
      { title: "db.teardown.ts", file: "db.teardown.ts", specs: [spec("cleans", "db.teardown.ts", "cleanup")] },
      { title: "a.spec.ts", file: "a.spec.ts", specs: [spec("a", "a.spec.ts", "chromium")] },
    ],
  };
  assert.deepEqual(testFilesOf(list as never), ["a.spec.ts"]);
});
