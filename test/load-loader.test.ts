/**
 * The journey loader (P5): TypeScript journeys load without the customer's toolchain, through
 * extensionless imports, `tsconfig` `paths` (with `extends`), enums and a monorepo layout, and
 * a failed assertion reports the journey's own `file:line`.
 *
 * Two ways in. The loader module itself, bundled the way the executor bundles it and run with
 * plain `node` (tsx's own hooks would hide whether ours work), and the committed
 * `dist/load-executor.js` driven over its framed protocol. Both run in place, inside the
 * checked-out workspace; CI also runs this file in Playwright's stock image.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { build } from "esbuild";

import { matchPaths, originalLocation, parseJsonc, readPathsConfig, resolveTsFile } from "../src/load/loader";

const run = promisify(execFile);
const fixtures = path.resolve(__dirname, "fixtures/load-engine/loader");

export const LOADER_FIXTURES = [
  { name: "plain", root: "plain", module: "journey.ts", export: "journey", line: 10 },
  { name: "paths alias", root: "paths", module: "journey.ts", export: "journey", line: 7 },
  { name: "enum", root: "enum", module: "journey.ts", export: "journey", line: 15 },
  { name: "extensionless imports", root: "extensionless", module: "journey.ts", export: "journey", line: 7 },
  {
    name: "monorepo",
    root: "monorepo",
    module: "tools/e2e/src/journeys/checkout-quote.ts",
    export: "quoteCheckout",
    line: 7,
  },
] as const;

const PROBE = `
import { loadJourney, originalLocation } from ${JSON.stringify(path.resolve(__dirname, "../src/load/loader"))};
const [root, module, name, value] = process.argv.slice(2);
const request = { get: async (url: string) => ({ json: async () => ({ value: Number(value), url }) }) };
(async () => {
  try {
    const journey = loadJourney(root, module, name);
    await journey(request);
    process.stdout.write(JSON.stringify({ ok: true }));
  } catch (error) {
    const e = error as Error;
    process.stdout.write(JSON.stringify({ ok: false, message: e.message, location: originalLocation(e.stack, root) }));
  }
})();
`;

let probe: Promise<string> | null = null;
function probeBundle(): Promise<string> {
  probe ??= (async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "peeps-loader-probe-"));
    process.on("exit", () => void rm(dir, { recursive: true, force: true }));
    const entry = path.join(dir, "probe.ts");
    await writeFile(entry, PROBE);
    const outfile = path.join(dir, "probe.js");
    await build({
      entryPoints: [entry],
      bundle: true,
      platform: "node",
      target: "node22",
      format: "cjs",
      outfile,
      external: ["@playwright/test", "playwright-core", "playwright"],
      logLevel: "warning",
    });
    return outfile;
  })();
  return probe;
}

async function runProbe(fixture: (typeof LOADER_FIXTURES)[number], value: number) {
  const bundle = await probeBundle();
  const root = path.join(fixtures, fixture.root);
  const { stdout } = await run(process.execPath, [bundle, root, fixture.module, fixture.export, String(value)], {
    cwd: root,
    env: { PATH: process.env.PATH ?? "" },
  });
  return JSON.parse(stdout) as { ok: boolean; message?: string; location?: string | null };
}

for (const fixture of LOADER_FIXTURES) {
  test(`the loader runs the ${fixture.name} journey`, async () => {
    assert.deepEqual(await runProbe(fixture, 42), { ok: true });
  });

  test(`a failed assertion in the ${fixture.name} journey reports its own file:line`, async () => {
    const result = await runProbe(fixture, 41);
    assert.equal(result.ok, false);
    assert.match(result.message ?? "", /expect\(received\)\.toBe\(expected\)/);
    assert.equal(result.location, `${fixture.module}:${fixture.line}`);
  });
}

test("parseJsonc reads comments and trailing commas, and keeps them inside strings", () => {
  assert.deepEqual(parseJsonc(`{ // c\n "a": "x // not a comment", /* b */ "b": [1, 2,], }`), {
    a: "x // not a comment",
    b: [1, 2],
  });
  assert.deepEqual(parseJsonc(`{"a": "quote \\" // still a string"}`), { a: 'quote " // still a string' });
});

test("paths follow extends, relative to the declaring baseUrl", () => {
  const config = readPathsConfig(path.join(fixtures, "monorepo/tools/e2e/tsconfig.json"));
  assert.ok(config);
  assert.equal(config.base, path.join(fixtures, "monorepo"));
  assert.equal(
    matchPaths("@shop/api-client", config),
    path.join(fixtures, "monorepo/packages/api-client/src/index.ts"),
  );
  assert.equal(
    matchPaths("@shop/api-client/paths", config),
    path.join(fixtures, "monorepo/packages/api-client/src/paths.ts"),
  );
  assert.equal(matchPaths("@shop/other", config), null);
});

test("resolveTsFile tries what tsc would", () => {
  const dir = path.join(fixtures, "extensionless");
  assert.equal(resolveTsFile(path.join(dir, "read")), path.join(dir, "read.ts"));
  assert.equal(resolveTsFile(path.join(dir, "helpers")), path.join(dir, "helpers/index.ts"));
  assert.equal(resolveTsFile(path.join(dir, "helpers/expected.js")), path.join(dir, "helpers/expected.ts"));
  assert.equal(resolveTsFile(path.join(dir, "missing")), null);
});

test("originalLocation skips node_modules and frames outside the repository", () => {
  const stack = [
    "Error: expect(received).toBe(expected)",
    "    at captureRawStack (/repo/node_modules/playwright-core/lib/x.js:1:2)",
    "    at Object.<anonymous> (/elsewhere/a.js:3:4)",
    "    at journey (/repo/tools/e2e/j.ts:7:21)",
    "    at async run (/repo/tools/e2e/k.ts:9:1)",
  ].join("\n");
  assert.equal(originalLocation(stack, "/repo"), "tools/e2e/j.ts:7");
  assert.equal(originalLocation("Error: x", "/repo"), null);
  assert.equal(originalLocation(undefined, "/repo"), null);
});

test("a namespace that holds values is refused by name, not miscompiled", async () => {
  const result = await runProbe({ name: "namespace", root: "namespace", module: "journey.ts", export: "journey", line: 0 } as never, 42);
  assert.equal(result.ok, false);
  assert.match(result.message ?? "", /TypeScript namespaces aren't supported in load journeys/);
});
