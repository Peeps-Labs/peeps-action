// src/appium-collect.ts
import { existsSync, globSync, readFileSync, realpathSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
function findPackage(name, from) {
  let dir = from;
  for (; ; ) {
    const candidate = path.join(dir, "node_modules", name);
    if (existsSync(path.join(candidate, "package.json"))) return realpathSync(candidate);
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}
function locate(name, from, via) {
  const direct = findPackage(name, from);
  if (direct) return direct;
  for (const parent of via) {
    const dir = findPackage(parent, from);
    const found = dir && findPackage(name, dir);
    if (found) return found;
  }
  return null;
}
function pickExport(value, conditions) {
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
function entryOf(pkgDir, subpath = ".") {
  const pkg = JSON.parse(readFileSync(path.join(pkgDir, "package.json"), "utf8"));
  const conditions = ["node", "import", "default"];
  let target = null;
  if (pkg.exports !== void 0) {
    const map = pkg.exports;
    const keyed = typeof map === "object" && map !== null && !Array.isArray(map) && Object.keys(map).some((k) => k.startsWith("."));
    target = pickExport(keyed ? map[subpath] : subpath === "." ? pkg.exports : void 0, conditions);
  }
  if (!target && subpath === ".") target = pkg.main ?? "index.js";
  if (!target) throw new Error(`${pkgDir} exports no ${subpath}`);
  return path.join(pkgDir, target);
}
async function importFile(file) {
  return await import(pathToFileURL(file).href);
}
var message = (error) => error instanceof Error ? error.stack ?? error.message : String(error);
async function registerTsx(configDir, notes) {
  const tsx = locate("tsx", configDir, ["@wdio/cli"]);
  if (!tsx) {
    notes.push("tsx not found; TypeScript specs load through Node's own type stripping");
    return false;
  }
  const tsconfig = path.join(configDir, "tsconfig.json");
  if (!process.env.TSX_TSCONFIG_PATH && existsSync(tsconfig)) process.env.TSX_TSCONFIG_PATH = tsconfig;
  try {
    const esm = await importFile(entryOf(tsx, "./esm/api"));
    esm.register();
    const cjs = await importFile(entryOf(tsx, "./cjs/api"));
    cjs.register();
    return true;
  } catch (error) {
    notes.push(`tsx could not be registered: ${message(error).split("\n")[0]}`);
    return false;
  }
}
function installGlobalStubs() {
  const stub = new Proxy(function stub2() {
  }, {
    get(_target, prop) {
      if (prop === "then") return void 0;
      if (prop === Symbol.toPrimitive) return () => "";
      if (prop === Symbol.iterator) return function* () {
      };
      return stub;
    },
    apply: () => stub,
    construct: () => stub
  });
  const g = globalThis;
  for (const name of ["browser", "driver", "$", "$$", "expect", "multiremotebrowser"]) {
    if (g[name] === void 0) g[name] = stub;
  }
  const registry = g._wdioGlobals ?? /* @__PURE__ */ new Map();
  for (const name of ["browser", "driver", "$", "$$", "expect"]) {
    if (!registry.has(name)) registry.set(name, stub);
  }
  g._wdioGlobals = registry;
}
function flatten(specs) {
  return specs.flatMap((s) => Array.isArray(s) ? flatten(s) : typeof s === "string" ? [s] : []);
}
function toPath(spec, rootDir) {
  return spec.startsWith("file://") ? fileURLToPath(spec) : path.resolve(rootDir, spec);
}
async function specsFromWdio(configPath, wdioConfig) {
  const { ConfigParser } = await importFile(entryOf(wdioConfig, "./node"));
  const parser = new ConfigParser(configPath);
  await parser.initialize();
  const config = parser.getConfig();
  const rootDir = config.rootDir ?? path.dirname(configPath);
  const lists = [parser.getSpecs()];
  const capabilities = parser.getCapabilities();
  if (Array.isArray(capabilities)) {
    for (const cap of capabilities) {
      if (cap && (cap["wdio:specs"] || cap["wdio:exclude"])) {
        lists.push(parser.getSpecs(cap["wdio:specs"], cap["wdio:exclude"]));
      }
    }
  }
  return {
    rootDir,
    specs: [...new Set(lists.flatMap((list) => flatten(list)).map((s) => toPath(s, rootDir)))],
    mochaOpts: config.mochaOpts ?? {}
  };
}
function glob(patterns, rootDir) {
  const list = flatten(Array.isArray(patterns) ? patterns : typeof patterns === "string" ? [patterns] : []);
  return list.flatMap((pattern) => {
    if (pattern.startsWith("file://")) return [fileURLToPath(pattern)];
    return globSync(pattern.replace(/\\/g, "/"), { cwd: rootDir }).map((match) => path.resolve(rootDir, match));
  });
}
async function specsFromConfig(configPath) {
  const loaded = await importFile(configPath);
  const config = loaded.config ?? loaded.default?.config;
  if (!config || typeof config !== "object") throw new Error(`${configPath} exports no \`config\` object`);
  const rootDir = config.rootDir ? path.resolve(path.dirname(configPath), config.rootDir) : path.dirname(configPath);
  const specs = new Set(glob(config.specs, rootDir));
  if (Array.isArray(config.capabilities)) {
    for (const cap of config.capabilities) {
      for (const file of glob(cap?.["wdio:specs"], rootDir)) specs.add(file);
    }
  }
  const excluded = new Set(glob(config.exclude, rootDir));
  return {
    rootDir,
    specs: [...specs].filter((file) => !excluded.has(file) && statSync(file).isFile()),
    mochaOpts: config.mochaOpts ?? {}
  };
}
async function collect(configPath) {
  const configDir = path.dirname(configPath);
  const notes = [];
  const tsx = await registerTsx(configDir, notes);
  installGlobalStubs();
  let list;
  let specsFrom = "config";
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
  const Mocha = loaded.default ?? loaded;
  let mocha;
  try {
    mocha = new Mocha({ ui: list.mochaOpts.ui ?? "bdd" });
  } catch (error) {
    notes.push(`mocha ui ${String(list.mochaOpts.ui)} unavailable, using bdd: ${message(error).split("\n")[0]}`);
    mocha = new Mocha({ ui: "bdd" });
  }
  const errors = [];
  for (const file of list.specs) {
    mocha.files = [file];
    try {
      await mocha.loadFilesAsync();
    } catch (error) {
      errors.push({ file, message: message(error).slice(0, 4e3) });
    }
  }
  const broken = new Set(errors.map((e) => e.file));
  const tests = [];
  const walk = (suite) => {
    for (const test of suite.tests) {
      const file = test.file ?? suite.file;
      if (!file || broken.has(file)) continue;
      tests.push({
        file,
        titlePath: test.titlePath(),
        pending: Boolean(typeof test.isPending === "function" ? test.isPending() : test.pending)
      });
    }
    for (const child of suite.suites) walk(child);
  };
  walk(mocha.suite);
  return { rootDir: list.rootDir, specs: list.specs, tests, errors, loader: tsx ? "tsx" : "node", specsFrom, notes };
}
var isMain = process.argv[1] && /appium-collect\.(mjs|ts)$/.test(process.argv[1]);
if (isMain) {
  const [configPath, out] = process.argv.slice(2);
  if (!configPath || !out) {
    console.error("usage: appium-collect <wdio config> <out.json>");
    process.exit(2);
  }
  collect(path.resolve(configPath)).then(
    (collection) => {
      writeFileSync(out, JSON.stringify(collection));
      process.exit(0);
    },
    (error) => {
      console.error(message(error));
      process.exit(1);
    }
  );
}
export {
  collect
};
