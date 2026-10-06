/** Failure evidence defaults for Playwright runs in the customer's checkout. */
import { randomUUID } from "node:crypto";
import { readFile, realpath, stat, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import type { RunnerEnv } from "./env";

/** Same default-config discovery order as Playwright's CLI. */
const CONFIG_EXTENSIONS = [".ts", ".js", ".mts", ".mjs", ".cts", ".cjs"];

async function configLocation(env: RunnerEnv): Promise<{ dir: string; file?: string }> {
  // A child process resolves a relative --config from its real cwd (not a
  // symlink alias such as macOS /var -> /private/var). Match inventory's CLI.
  const cwd = await realpath(env.workingDirectory);
  const selected = env.configPath ? path.resolve(cwd, env.configPath) : cwd;
  if (!(await stat(selected)).isDirectory()) return { dir: path.dirname(selected), file: selected };
  for (const ext of CONFIG_EXTENSIONS) {
    const file = path.join(selected, `playwright.config${ext}`);
    try {
      await stat(file);
      return { dir: selected, file };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  return { dir: selected };
}

/** Playwright classifies .ts/.js by the nearest package.json, not by syntax. */
async function isModule(file: string): Promise<boolean> {
  if (/\.(mjs|mts)$/.test(file)) return true;
  if (/\.(cjs|cts)$/.test(file)) return false;
  let dir = path.dirname(file);
  for (;;) {
    try {
      const text = await readFile(path.join(dir, "package.json"), "utf8");
      // Like Playwright, a malformed nearest package is not an ES module.
      try { return (JSON.parse(text) as { type?: unknown }).type === "module"; }
      catch { return false; }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    const parent = path.dirname(dir);
    if (parent === dir) return false;
    dir = parent;
  }
}

/**
 * Playwright loads this wrapper in place of the original. Keeping it beside
 * that file preserves every config-relative directory and module resolution.
 * Load in the original's module format, then unwrap default exactly once as
 * Playwright does; cross-format imports can silently discard a TS/CJS config.
 */
export async function prepareCaptureConfig(env: RunnerEnv): Promise<{
  configPath: string;
  cleanup: () => Promise<void>;
}> {
  const { dir, file } = await configLocation(env);
  const esm = file ? await isModule(file) : false;
  const configPath = path.join(dir, `.peeps-capture-${randomUUID()}.config.${esm ? "mjs" : "cjs"}`);
  const load = !file ? "const loaded = {};" : esm
    ? `import * as loaded from ${JSON.stringify(pathToFileURL(file).href)};`
    : `const loaded = await require(${JSON.stringify(file)});`;
  const body = `
const config = await (loaded && typeof loaded === "object" && "default" in loaded ? loaded.default : loaded);
if (!config || typeof config !== "object") throw new Error("Playwright config must export a single object");
if (config.use !== undefined && (!config.use || typeof config.use !== "object"))
  throw new Error("Playwright config.use must be an object");
let defaultVideo = "retain-on-failure";
if (config.use?.video === undefined) {
  // A system browser may exist without Playwright's video encoder. Use its
  // own registry to resolve the encoder, including host revision overrides.
  try {
    const fs = require("node:fs");
    const path = require("node:path");
    const createRequire = require("node:module").createRequire;
    const fromCli = createRequire(fs.realpathSync(process.argv[1]));
    const fromPlaywright = createRequire(fromCli.resolve("playwright/package.json"));
    const coreDir = path.dirname(fromPlaywright.resolve("playwright-core/package.json"));
    // Playwright moved its registry into coreBundle in newer releases.
    // Resolve from the CLI's core, not an unrelated hoisted dependency.
    const bundledRegistry = path.join(coreDir, "lib", "coreBundle.js");
    const registry = fs.existsSync(bundledRegistry)
      ? require(bundledRegistry).registry.registry
      : require(path.join(coreDir, "lib", "server", "registry", "index.js")).registry;
    const encoderPath = registry.findExecutable("ffmpeg").executablePath();
    if (!fs.statSync(encoderPath).isFile()) throw new Error("Encoder is not a file");
    fs.accessSync(encoderPath, fs.constants.X_OK);
  } catch {
    defaultVideo = "off";
    console.warn("[peeps] default video disabled: Playwright FFmpeg unavailable or unverifiable; run npx playwright install ffmpeg to enable failure video. Screenshot defaults still apply.");
  }
}
const withEvidence = {
  ...config,
  use: {
    ...config.use,
    screenshot: config.use?.screenshot === undefined ? "only-on-failure" : config.use.screenshot,
    video: config.use?.video === undefined ? defaultVideo : config.use.video,
  },
};
`;
  // Await both raw CJS exports and the unwrapped value, matching Playwright's
  // async loader. Export a default envelope so its own unwrap cannot discard
  // an original config's unrelated `default` property.
  const source = esm
    ? `import { createRequire } from "node:module";\nconst require = createRequire(import.meta.url);\n${load}\n${body}\nexport default withEvidence;\n`
    : `module.exports = (async () => {\n${load}\n${body}\nreturn { default: withEvidence };\n})();\n`;
  try {
    await writeFile(configPath, source, { flag: "wx", mode: 0o600 });
  } catch (error) {
    // A write may create the file before failing. Do not leave a partial
    // wrapper in the checkout, or remove somebody else's file on EEXIST.
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") await unlink(configPath).catch(() => {});
    throw error;
  }
  return { configPath, cleanup: () => unlink(configPath) };
}
