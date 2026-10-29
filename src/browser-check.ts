/**
 * A startup check that the browsers of the Playwright the tests use are on
 * this runner (PQA-2669).
 *
 * The workflow Peeps suggests runs in `mcr.microsoft.com/playwright:vX-jammy`,
 * which carries only Playwright X's browsers. A repository on another
 * `@playwright/test` version then fails every test with Playwright's
 * "Executable doesn't exist" error, which says nothing about the image. This
 * names both versions and the fix before Playwright starts.
 *
 * It WARNS and never fails the job: a config that launches a browser channel
 * (`channel: "chrome"`) runs without any of Playwright's own browsers, and
 * failing it here would break a suite that works. When the browsers really are
 * missing, Playwright fails right after this message.
 */

import { execFile } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export interface PlaywrightProbe {
  /** The installed playwright-core version, which `@playwright/test` pins. */
  version: string;
  browsers: Array<{ name: string; executablePath: string }>;
}

/**
 * Run in a separate Node process, in the directory Playwright runs in, so the
 * customer's own `playwright-core` is loaded there and never into the action.
 * It resolves `playwright-core` directly, or through `@playwright/test` and
 * `playwright` where the package manager does not hoist it (pnpm).
 */
const PROBE = `
const { createRequire } = require("node:module");
const path = require("node:path");
const from = (file) => createRequire(file);
const here = path.join(process.cwd(), "noop.js");
let pkg;
try {
  pkg = from(here).resolve("playwright-core/package.json");
} catch {
  const test = from(here).resolve("@playwright/test/package.json");
  const pw = from(test).resolve("playwright/package.json");
  pkg = from(pw).resolve("playwright-core/package.json");
}
const core = require(path.dirname(pkg));
const browsers = [];
for (const name of ["chromium", "firefox", "webkit"]) {
  try { browsers.push({ name, executablePath: core[name].executablePath() }); } catch {}
}
process.stdout.write(JSON.stringify({ version: require(pkg).version, browsers }));
`;

/** The Playwright installed where the tests run, or null when there is none to check. */
export async function probePlaywright(
  workingDirectory: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<PlaywrightProbe | null> {
  try {
    const { stdout } = await execFileAsync(process.execPath, ["-e", PROBE], {
      cwd: workingDirectory,
      env,
      timeout: 20_000,
    });
    const parsed = JSON.parse(stdout) as PlaywrightProbe;
    return typeof parsed.version === "string" && Array.isArray(parsed.browsers) ? parsed : null;
  } catch {
    return null;
  }
}

const BROWSER_DIR = /^(chromium|chromium_headless_shell|firefox|webkit)-\d+$/;

/** `<root>/chromium-1200/chrome-linux/chrome` → `{ root, dir: "chromium-1200" }`. */
function installOf(executablePath: string): { root: string; dir: string } | null {
  const parts = executablePath.split(/[\\/]/);
  const at = parts.findIndex((p) => BROWSER_DIR.test(p));
  if (at < 0) return null;
  return { root: parts.slice(0, at).join("/") || "/", dir: parts[at]! };
}

function listDir(dir: string): string[] {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
}

/**
 * The warning to print, or null when one of the installed Playwright's
 * browsers is present (any one: a suite may use only firefox, or only
 * chromium's headless shell).
 */
export function missingBrowsersMessage(
  probe: PlaywrightProbe,
  fs: { exists: (p: string) => boolean; list?: (dir: string) => string[] },
): string | null {
  if (probe.browsers.length === 0) return null;
  const list = fs.list ?? listDir;
  const installs = probe.browsers.map((b) => ({ ...b, install: installOf(b.executablePath) }));
  for (const b of installs) {
    if (fs.exists(b.executablePath)) return null;
    // `playwright install --only-shell` installs chromium's headless shell
    // alone, at chromium's revision.
    if (b.name === "chromium" && b.install) {
      const shell = b.install.dir.replace(/^chromium-/, "chromium_headless_shell-");
      if (fs.exists(`${b.install.root}/${shell}`)) return null;
    }
  }
  const expected = installs.map((b) => b.install?.dir ?? b.name).join(", ");
  const root = installs.find((b) => b.install)?.install?.root;
  const found = root ? list(root).filter((d) => BROWSER_DIR.test(d)).sort() : [];
  const where = root
    ? found.length > 0
      ? ` ${root} has ${found.join(", ")}.`
      : ` ${root} has no Playwright browsers.`
    : "";
  return (
    `Playwright ${probe.version} is installed, but none of its browsers (${expected}) are on this runner.${where} ` +
    `Run the job in mcr.microsoft.com/playwright:v${probe.version}-jammy, the image for your @playwright/test version, ` +
    "or add `npx playwright install --with-deps` before the Peeps step. " +
    "If your Playwright config launches a browser channel such as Chrome, you can ignore this."
  );
}

/** Print the warning (a GitHub annotation on GitHub) when the browsers are missing. */
export async function warnIfBrowsersMissing(
  workingDirectory: string,
  platform: "github" | "gitlab",
): Promise<void> {
  const probe = await probePlaywright(workingDirectory);
  if (!probe) return;
  const message = missingBrowsersMessage(probe, { exists: existsSync });
  if (!message) return;
  console.log(platform === "github" ? `::warning title=Playwright browsers missing::${message}` : `[peeps] warning: ${message}`);
}
