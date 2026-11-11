import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { readRunnerEnv } from "../src/env";
import { listTests, specFilesOf, testFilesOf } from "../src/inventory";
import { parseJsonReport } from "../src/playwright-json";

const modules = process.env.PEEPS_CAPTURE_TEST_MODULES ?? path.resolve(__dirname, "../node_modules");

test("parseJsonReport skips lines a config printed before the report", () => {
  assert.deepEqual(parseJsonReport('{"a":1}'), { a: 1 });
  assert.deepEqual(parseJsonReport('◇ injected env (0) from .env // tip: …\n{\n  "suites": []\n}\n'), { suites: [] });
  // A config's own object after its log line is not a report: the caller keeps stdout instead.
  assert.equal(parseJsonReport('loading config\n{\n  "a": 1\n}\n'), null);
  assert.equal(parseJsonReport("Error: no tests found"), null);
  assert.equal(parseJsonReport(""), null);
});

test("listTests reads the list even when the config prints to stdout (dotenv 17 does on every load)", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "peeps-json-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const suite = path.join(root, "e2e");
  await mkdir(path.join(suite, "tests"), { recursive: true });
  await symlink(modules, path.join(root, "node_modules"), "dir");
  await writeFile(
    path.join(suite, "playwright.config.ts"),
    `import { defineConfig } from "@playwright/test";
// What dotenv 17's config() prints, on stdout, before Playwright writes anything.
console.log("◇ injected env (0) from .env // tip: ⌁ auth for agents");
export default defineConfig({ testDir: "./tests" });
`,
  );
  await writeFile(
    path.join(suite, "tests/shop.spec.ts"),
    `import { test } from "@playwright/test";\ntest("checkout works", { tag: "@SHOP-1" }, async () => {});\n`,
  );

  // The control: stdout really does start with the config's line, so it is not JSON.
  const cli = path.join(modules, "playwright/cli.js");
  const raw = execFileSync(process.execPath, [cli, "test", "--list", "--reporter=json"], { cwd: suite, encoding: "utf8" });
  assert.match(raw, /^◇ injected env/);
  assert.throws(() => JSON.parse(raw));

  const list = await listTests(readRunnerEnv({ GITHUB_WORKSPACE: root, "INPUT_WORKING-DIRECTORY": "e2e" }));
  assert.deepEqual(specFilesOf(list), ["shop.spec.ts"]);
});

test("the list carries each project's dependencies and teardown, which Playwright's JSON report leaves out (PQA-3201 PR 3)", async (t) => {
  const { mkdtemp, writeFile, mkdir, rm, symlink, realpath } = await import("node:fs/promises");
  const os = await import("node:os");
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "peeps-projects-")));
  t.after(() => rm(root, { recursive: true, force: true }));
  await symlink(path.resolve(__dirname, "../node_modules"), path.join(root, "node_modules"), "dir");
  await mkdir(path.join(root, "specs"));
  await writeFile(path.join(root, "playwright.config.ts"), `import { defineConfig } from "@playwright/test";
export default defineConfig({ testDir: "./specs", projects: [
  { name: "setup", testMatch: /.*\\.setup\\.ts/, teardown: "cleanup" },
  { name: "cleanup", testMatch: /.*\\.teardown\\.ts/ },
  { name: "chromium", testMatch: /.*\\.spec\\.ts/, dependencies: ["setup"] },
] });
`);
  for (const [file, title] of [["auth.setup.ts", "logs in"], ["db.teardown.ts", "cleans"], ["a.spec.ts", "a"]] as Array<[string, string]>) await writeFile(path.join(root, "specs", file), `import { test } from "@playwright/test";\ntest(${JSON.stringify(title)}, () => {});\n`);
  const list = await listTests(readRunnerEnv({ GITHUB_WORKSPACE: root }));
  const projects = Object.fromEntries((list.config.projects ?? []).map((p) => [p.name, p]));
  assert.deepEqual([projects.chromium?.dependencies, projects.setup?.teardown], [["setup"], "cleanup"]);
  assert.deepEqual(testFilesOf(list), ["a.spec.ts"]);
});
