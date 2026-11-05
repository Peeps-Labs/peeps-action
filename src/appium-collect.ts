/**
 * Collects a WebdriverIO + mocha suite's tests without starting a device
 * session: `node appium-collect.mjs <wdio config, absolute> <out.json>`,
 * run by the action in its own process with the working directory as cwd.
 * Bundled to dist/appium-collect.mjs; everything it loads comes from the
 * customer's own node_modules.
 *
 *   1. TypeScript: the customer's `tsx` (WebdriverIO v9 depends on it and
 *      loads TS configs and specs with it, so this loads them exactly as the
 *      real run does). Without one, Node's own type stripping.
 *   2. Which spec files: WebdriverIO's own `ConfigParser` (`@wdio/config`),
 *      so `specs`, `exclude`, groups, `rootDir` and capability-level
 *      `wdio:specs` resolve exactly as `wdio run` resolves them. Without it,
 *      the config's `specs`/`exclude` globbed relative to its `rootDir`.
 *   3. Which tests: each spec file is loaded into its own mocha instance
 *      (the customer's mocha, found beside `@wdio/mocha-framework`), one file
 *      at a time, and that instance's suite tree is walked. Nothing runs: no hook, no test body. A file that
 *      does not load is reported as a collection error, and its tests (any
 *      it registered before failing) are left out.
 *
 * The output is raw (absolute files, title arrays); the action turns it into
 * the inventory payload.
 */

import fs, { existsSync, readFileSync, realpathSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export interface CollectedTest {
  file: string;
  titlePath: string[];
  pending: boolean;
}

export interface AppiumCollection {
  /** WebdriverIO's `rootDir` (the config's directory unless it sets one), absolute. */
  rootDir: string;
  /** Every spec file the config names, absolute. */
  specs: string[];
  /**
   * Each capability's own spec files (absolute), in the config's order, as
   * WebdriverIO resolves them: its `wdio:specs` (else the config's `specs`)
   * less its excludes. Null when `capabilities` is not a list (multiremote).
   */
  capabilitySpecs?: string[][] | null;
  tests: CollectedTest[];
  /** Spec files that did not load: present, but what they hold is unknown. */
  errors: Array<{ file: string; message: string }>;
  /** How TypeScript was loaded, and where the spec list came from. */
  loader: "tsx" | "node";
  specsFrom: "@wdio/config" | "config";
  notes: string[];
}

type Exports = string | null | { [condition: string]: Exports } | Exports[];

/** A package's directory, found the way Node walks `node_modules` up from `from`. */
function findPackage(name: string, from: string): string | null {
  let dir = from;
  for (;;) {
    const candidate = path.join(dir, "node_modules", name);
    if (existsSync(path.join(candidate, "package.json"))) return realpathSync(candidate);
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

/**
 * Where to look for a package: the config's directory, then beside the
 * WebdriverIO packages that depend on it (a strict layout such as pnpm's
 * keeps a dependency of a dependency out of the project's own node_modules).
 */
function locate(name: string, from: string, via: string[]): string | null {
  const direct = findPackage(name, from);
  if (direct) return direct;
  for (const parent of via) {
    const dir = findPackage(parent, from);
    const found = dir && findPackage(name, dir);
    if (found) return found;
  }
  return null;
}

function pickExport(value: Exports | undefined, conditions: string[]): string | null {
  if (typeof value === "string") return value;
  if (!value) return null;
  if (Array.isArray(value)) {
    for (const item of value) {
      const picked = pickExport(item, conditions);
      if (picked) return picked;
    }
    return null;
  }
  for (const [key, inner] of Object.entries(value)) {
    if (conditions.includes(key)) {
      const picked = pickExport(inner, conditions);
      if (picked) return picked;
    }
  }
  return null;
}

/** The ESM entry of `pkgDir` for `subpath` ("." or "./node"), as `import` resolves it. */
function entryOf(pkgDir: string, subpath = "."): string {
  const pkg = JSON.parse(readFileSync(path.join(pkgDir, "package.json"), "utf8")) as {
    exports?: Exports | Record<string, Exports>;
    main?: string;
  };
  const conditions = ["node", "import", "default"];
  let target: string | null = null;
  if (pkg.exports !== undefined) {
    const map = pkg.exports as Record<string, Exports>;
    const keyed = typeof map === "object" && map !== null && !Array.isArray(map) && Object.keys(map).some((k) => k.startsWith("."));
    target = pickExport(keyed ? map[subpath] : subpath === "." ? (pkg.exports as Exports) : undefined, conditions);
  }
  if (!target && subpath === ".") target = pkg.main ?? "index.js";
  if (!target) throw new Error(`${pkgDir} exports no ${subpath}`);
  return path.join(pkgDir, target);
}

async function importFile(file: string): Promise<Record<string, unknown>> {
  return (await import(pathToFileURL(file).href)) as Record<string, unknown>;
}

const message = (error: unknown) =>
  error instanceof Error ? (error.stack ?? error.message) : String(error);

/** Register the customer's tsx for both module systems; false when there is none. */
async function registerTsx(configDir: string, notes: string[]): Promise<boolean> {
  const tsx = locate("tsx", configDir, ["@wdio/cli"]);
  if (!tsx) {
    notes.push("tsx not found; TypeScript specs load through Node's own type stripping");
    return false;
  }
  // Where WebdriverIO points tsx: the tsconfig beside the config.
  const tsconfig = path.join(configDir, "tsconfig.json");
  if (!process.env.TSX_TSCONFIG_PATH && existsSync(tsconfig)) process.env.TSX_TSCONFIG_PATH = tsconfig;
  try {
    const esm = await importFile(entryOf(tsx, "./esm/api"));
    (esm.register as () => unknown)();
    const cjs = await importFile(entryOf(tsx, "./cjs/api"));
    (cjs.register as () => unknown)();
    return true;
  } catch (error) {
    notes.push(`tsx could not be registered: ${message(error).split("\n")[0]}`);
    return false;
  }
}

/**
 * Harmless stand-ins for WebdriverIO's globals, for a spec that touches
 * `browser` or `$` while it is being defined (a describe body, a page object
 * built at import). Every property, call and construction answers another
 * stand-in; it is never a thenable, so nothing awaits it forever.
 */
function installGlobalStubs(): void {
  const stub: unknown = new Proxy(function stub() {}, {
    get(_target, prop) {
      if (prop === "then") return undefined;
      if (prop === Symbol.toPrimitive) return () => "";
      if (prop === Symbol.iterator) return function* () {};
      return stub;
    },
    apply: () => stub,
    construct: () => stub as object,
  });
  const g = globalThis as Record<string, unknown>;
  for (const name of ["browser", "driver", "$", "$$", "expect", "multiremotebrowser"]) {
    if (g[name] === undefined) g[name] = stub;
  }
  // `import { browser } from "@wdio/globals"` reads this map.
  const registry = (g._wdioGlobals as Map<string, unknown> | undefined) ?? new Map<string, unknown>();
  for (const name of ["browser", "driver", "$", "$$", "expect"]) {
    if (!registry.has(name)) registry.set(name, stub);
  }
  g._wdioGlobals = registry;
}

interface SpecList {
  rootDir: string;
  specs: string[];
  capabilitySpecs: string[][] | null;
  mochaOpts: { ui?: string };
}

function flatten(specs: unknown[]): string[] {
  return specs.flatMap((s) => (Array.isArray(s) ? flatten(s) : typeof s === "string" ? [s] : []));
}

function toPath(spec: string, rootDir: string): string {
  return spec.startsWith("file://") ? fileURLToPath(spec) : path.resolve(rootDir, spec);
}

async function specsFromWdio(configPath: string, wdioConfig: string): Promise<SpecList> {
  const { ConfigParser } = (await importFile(entryOf(wdioConfig, "./node"))) as {
    ConfigParser: new (file: string) => {
      initialize(): Promise<void>;
      getConfig(): { rootDir?: string; mochaOpts?: { ui?: string } };
      getCapabilities(): unknown;
      getSpecs(capSpecs?: unknown, capExclude?: unknown): unknown[];
    };
  };
  const parser = new ConfigParser(configPath);
  await parser.initialize();
  const config = parser.getConfig();
  const rootDir = config.rootDir ?? path.dirname(configPath);
  const lists = [parser.getSpecs()];
  const capabilities = parser.getCapabilities();
  let capabilitySpecs: string[][] | null = null;
  if (Array.isArray(capabilities)) {
    // `getSpecs` with a capability's own `wdio:specs`/`wdio:exclude` is what
    // WebdriverIO schedules on it (without them: the config's specs).
    capabilitySpecs = (capabilities as Array<Record<string, unknown> | null>).map((cap) => {
      const list = parser.getSpecs(cap?.["wdio:specs"], cap?.["wdio:exclude"]);
      lists.push(list);
      return [...new Set(flatten(list).map((s) => toPath(s, rootDir)))];
    });
  }
  return {
    rootDir,
    specs: [...new Set(lists.flatMap((list) => flatten(list)).map((s) => toPath(s, rootDir)))],
    capabilitySpecs,
    mochaOpts: config.mochaOpts ?? {},
  };
}

function glob(patterns: unknown, rootDir: string): string[] {
  const list = flatten(Array.isArray(patterns) ? patterns : typeof patterns === "string" ? [patterns] : []);
  return list.flatMap((pattern) => {
    if (pattern.startsWith("file://")) return [fileURLToPath(pattern)];
    // Node 22+; read off the module so an older Node fails here, with a reason, not at load.
    const globSync = (fs as { globSync?: (p: string, o: { cwd: string }) => string[] }).globSync;
    if (!globSync) throw new Error(`globbing specs without @wdio/config needs Node 22 or later (this is ${process.version})`);
    return globSync(pattern.replace(/\\/g, "/"), { cwd: rootDir }).map((match) => path.resolve(rootDir, match));
  });
}

/** Without `@wdio/config`: the config's own `specs` and `exclude`, globbed. */
async function specsFromConfig(configPath: string): Promise<SpecList> {
  const loaded = await importFile(configPath);
  const config = (loaded.config ?? (loaded.default as Record<string, unknown> | undefined)?.config) as
    | { rootDir?: string; specs?: unknown; exclude?: unknown; capabilities?: unknown; mochaOpts?: { ui?: string } }
    | undefined;
  if (!config || typeof config !== "object") throw new Error(`${configPath} exports no \`config\` object`);
  const rootDir = config.rootDir ? path.resolve(path.dirname(configPath), config.rootDir) : path.dirname(configPath);
  const globalSpecs = glob(config.specs, rootDir);
  const globalExclude = glob(config.exclude, rootDir);
  const isFile = (file: string) => statSync(file).isFile();
  const specs = new Set(globalSpecs);
  let capabilitySpecs: string[][] | null = null;
  if (Array.isArray(config.capabilities)) {
    // WebdriverIO's rule: a capability's own specs replace the config's, and
    // its own excludes apply only when the config sets none.
    capabilitySpecs = (config.capabilities as Array<Record<string, unknown> | null>).map((cap) => {
      const own = cap?.["wdio:specs"];
      const mine = own ? glob(own, rootDir) : globalSpecs;
      for (const file of mine) specs.add(file);
      const excluded = new Set(globalExclude.length > 0 ? globalExclude : glob(cap?.["wdio:exclude"], rootDir));
      return [...new Set(mine)].filter((file) => !excluded.has(file) && isFile(file));
    });
  }
  const excluded = new Set(globalExclude);
  return {
    rootDir,
    specs: [...specs].filter((file) => !excluded.has(file) && isFile(file)),
    capabilitySpecs,
    mochaOpts: config.mochaOpts ?? {},
  };
}

interface MochaSuite {
  title: string;
  root?: boolean;
  file?: string;
  suites: MochaSuite[];
  tests: Array<{ title: string; file?: string; pending?: boolean; titlePath(): string[]; isPending?(): boolean }>;
}

interface MochaInstance {
  files: string[];
  suite: MochaSuite;
  loadFilesAsync(): Promise<void>;
}

export async function collect(configPath: string): Promise<AppiumCollection> {
  const configDir = path.dirname(configPath);
  const notes: string[] = [];
  const tsx = await registerTsx(configDir, notes);
  installGlobalStubs();

  let list: SpecList;
  let specsFrom: AppiumCollection["specsFrom"] = "config";
  const wdioConfig = locate("@wdio/config", configDir, ["@wdio/cli", "webdriverio"]);
  try {
    if (!wdioConfig) throw new Error("@wdio/config is not installed");
    list = await specsFromWdio(configPath, wdioConfig);
    specsFrom = "@wdio/config";
  } catch (error) {
    notes.push(`spec list from the config itself (${message(error).split("\n")[0]})`);
    list = await specsFromConfig(configPath);
  }

  const mochaDir = locate("mocha", configDir, ["@wdio/mocha-framework"]);
  if (!mochaDir) throw new Error("mocha is not installed (it comes with @wdio/mocha-framework)");
  const loaded = await importFile(entryOf(mochaDir));
  const Mocha = (loaded.default ?? loaded) as new (options: Record<string, unknown>) => MochaInstance;
  let ui = list.mochaOpts.ui ?? "bdd";
  /**
   * A fresh mocha, and so a fresh suite tree, for every spec file: the bdd
   * interface pushes a describe's suite, runs its body and pops it with no
   * `finally`, so a body that throws leaves its suite on the stack, and one
   * shared instance would file every later spec's tests under it.
   */
  const fresh = (): MochaInstance => {
    try {
      return new Mocha({ ui });
    } catch (error) {
      notes.push(`mocha ui ${String(ui)} unavailable, using bdd: ${message(error).split("\n")[0]}`);
      ui = "bdd";
      return new Mocha({ ui });
    }
  };

  const errors: AppiumCollection["errors"] = [];
  const tests: CollectedTest[] = [];
  for (const file of list.specs) {
    const mocha = fresh();
    mocha.files = [file];
    try {
      await mocha.loadFilesAsync();
    } catch (error) {
      // What it registered before failing is left out with it.
      errors.push({ file, message: message(error).slice(0, 4000) });
      continue;
    }
    const walk = (suite: MochaSuite) => {
      for (const test of suite.tests) {
        tests.push({
          file: test.file ?? suite.file ?? file,
          titlePath: test.titlePath(),
          pending: Boolean(typeof test.isPending === "function" ? test.isPending() : test.pending),
        });
      }
      for (const child of suite.suites) walk(child);
    };
    walk(mocha.suite);
  }
  return {
    rootDir: list.rootDir,
    specs: list.specs,
    capabilitySpecs: list.capabilitySpecs,
    tests,
    errors,
    loader: tsx ? "tsx" : "node",
    specsFrom,
    notes,
  };
}

/** What `--capabilities` writes: the capabilities the first WebdriverIO worker would get. */
export interface CapabilitiesRead {
  capabilities: Record<string, unknown> | null;
  /** WebdriverIO's `rootDir`, absolute. */
  rootDir: string;
  from: "@wdio/config" | "config";
  notes: string[];
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * The first capability set of a config's `capabilities`: the first entry of
 * the usual array; for multiremote (`{ name: { capabilities } }`, or an
 * array of those) the first instance's.
 */
export function firstCapabilities(capabilities: unknown): Record<string, unknown> | null {
  const first = Array.isArray(capabilities) ? capabilities[0] : capabilities;
  if (!isPlainObject(first)) return null;
  const looksLikeCaps = (o: Record<string, unknown>) =>
    "platformName" in o || "browserName" in o || Object.keys(o).some((k) => k.includes(":"));
  if (looksLikeCaps(first)) return first;
  if (isPlainObject(first.capabilities)) return firstCapabilities(first.capabilities);
  for (const value of Object.values(first)) {
    if (isPlainObject(value) && isPlainObject(value.capabilities)) return firstCapabilities(value.capabilities);
  }
  return null;
}

/**
 * The capabilities `wdio run` would open its first session with, read the
 * way it reads them: WebdriverIO's own `ConfigParser`, in this process, with
 * the job's environment, so `"appium:app": process.env.APP_PATH` resolves as
 * it does under wdio. Without `@wdio/config`, the config's own export.
 */
export async function capabilitiesOf(configPath: string): Promise<CapabilitiesRead> {
  const configDir = path.dirname(configPath);
  const notes: string[] = [];
  await registerTsx(configDir, notes);
  installGlobalStubs();
  const wdioConfig = locate("@wdio/config", configDir, ["@wdio/cli", "webdriverio"]);
  try {
    if (!wdioConfig) throw new Error("@wdio/config is not installed");
    const { ConfigParser } = (await importFile(entryOf(wdioConfig, "./node"))) as {
      ConfigParser: new (file: string) => {
        initialize(): Promise<void>;
        getConfig(): { rootDir?: string };
        getCapabilities(): unknown;
      };
    };
    const parser = new ConfigParser(configPath);
    await parser.initialize();
    return {
      capabilities: firstCapabilities(parser.getCapabilities()),
      rootDir: parser.getConfig().rootDir ?? configDir,
      from: "@wdio/config",
      notes,
    };
  } catch (error) {
    notes.push(`capabilities from the config itself (${message(error).split("\n")[0]})`);
  }
  const loaded = await importFile(configPath);
  const config = (loaded.config ?? (loaded.default as Record<string, unknown> | undefined)?.config) as
    | { rootDir?: string; capabilities?: unknown }
    | undefined;
  if (!config || typeof config !== "object") throw new Error(`${configPath} exports no \`config\` object`);
  return {
    capabilities: firstCapabilities(config.capabilities),
    rootDir: config.rootDir ? path.resolve(configDir, config.rootDir) : configDir,
    from: "config",
    notes,
  };
}

const isMain = process.argv[1] && /appium-collect\.(mjs|ts)$/.test(process.argv[1]);
if (isMain && process.argv[2] === "--capabilities") {
  const [configPath, out] = process.argv.slice(3);
  if (!configPath || !out) {
    console.error("usage: appium-collect --capabilities <wdio config> <out.json>");
    process.exit(2);
  }
  capabilitiesOf(path.resolve(configPath)).then(
    (read) => {
      writeFileSync(out, JSON.stringify(read));
      process.exit(0);
    },
    (error: unknown) => {
      console.error(message(error));
      process.exit(1);
    },
  );
} else if (isMain) {
  const [configPath, out] = process.argv.slice(2);
  if (!configPath || !out) {
    console.error("usage: appium-collect <wdio config> <out.json>");
    process.exit(2);
  }
  collect(path.resolve(configPath)).then(
    (collection) => {
      writeFileSync(out, JSON.stringify(collection));
      // A spec may leave a handle open (a connection made at import): the
      // collection is written, so nothing it does after this matters.
      process.exit(0);
    },
    (error: unknown) => {
      console.error(message(error));
      process.exit(1);
    },
  );
}
