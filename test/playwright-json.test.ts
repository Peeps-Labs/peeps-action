import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { readRunnerEnv } from "../src/env";
import { listTests, specFilesOf } from "../src/inventory";
import { parseJsonReport } from "../src/playwright-json";

const modules = process.env.PEEPS_CAPTURE_TEST_MODULES ?? path.resolve(__dirname, "../node_modules");

test("parseJsonReport skips lines a config printed before the report", () => {
  assert.deepEqual(parseJsonReport('{"a":1}'), { a: 1 });
  assert.deepEqual(parseJsonReport('◇ injected env (0) from .env // tip: …\n{\n  "a": 1\n}\n'), { a: 1 });
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
