/**
 * The journey loader, bundled into `dist/load-executor.js` so it never depends on the
 * customer's toolchain (no ts-node, tsx or Playwright transform). It registers synchronous
 * module hooks (`module.registerHooks`) that:
 *
 *   resolve  extensionless relative imports (`./helpers` → `./helpers.ts`, `./dir` →
 *            `./dir/index.ts`), TypeScript's `./x.js` → `./x.ts`, and the nearest
 *            `tsconfig.json`'s `compilerOptions.paths` (following relative `extends`);
 *   load     TypeScript (`.ts`, `.tsx`, `.cts`, `.mts`) with Sucrase, which keeps every line
 *            where it was, so a thrown assertion reports the journey's own `file:line`.
 *
 * Playwright itself is never bundled: the executor resolves the customer's copy
 * (docs/load-loader.md has the spike that chose Sucrase).
 */
import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { createRequire, registerHooks } from "node:module";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { transform } from "sucrase";

const TS_FILE = /\.(?:[cm]?ts|tsx)$/;
const EXTENSIONS = [".ts", ".tsx", ".mts", ".cts", ".js", ".mjs", ".cjs", ".json"];
const JS_TO_TS: Record<string, string[]> = {
  ".js": [".ts", ".tsx"],
  ".jsx": [".tsx"],
  ".mjs": [".mts"],
  ".cjs": [".cts"],
};

function isFile(file: string): boolean {
  try {
    return statSync(file).isFile();
  } catch {
    return false;
  }
}

/** The file a TypeScript-style specifier names, trying what `tsc` would. */
export function resolveTsFile(base: string): string | null {
  if (isFile(base) && !/\.(?:js|jsx|mjs|cjs)$/.test(base)) return base;
  const ext = path.extname(base);
  for (const swap of JS_TO_TS[ext] ?? []) {
    const candidate = base.slice(0, -ext.length) + swap;
    if (isFile(candidate)) return candidate;
  }
  if (isFile(base)) return base;
  for (const extension of EXTENSIONS) if (isFile(base + extension)) return base + extension;
  for (const extension of EXTENSIONS) {
    const index = path.join(base, `index${extension}`);
    if (isFile(index)) return index;
  }
  return null;
}

/** JSON with comments and trailing commas, as `tsconfig.json` allows. */
export function parseJsonc(text: string): unknown {
  let out = "";
  let inString = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (inString) {
      out += c;
      if (c === "\\") out += text[++i] ?? "";
      else if (c === '"') inString = false;
    } else if (c === '"') {
      inString = true;
      out += c;
    } else if (c === "/" && text[i + 1] === "/") {
      while (i < text.length && text[i] !== "\n") i++;
      out += "\n";
    } else if (c === "/" && text[i + 1] === "*") {
      i += 2;
      while (i < text.length && !(text[i] === "*" && text[i + 1] === "/")) i++;
      i++;
    } else out += c;
  }
  return JSON.parse(out.replace(/,(\s*[}\]])/g, "$1"));
}

export interface PathsConfig {
  /** Directory the `paths` targets are relative to. */
  base: string;
  paths: Record<string, string[]>;
}

interface RawCompilerOptions {
  baseUrl?: string;
  paths?: Record<string, string[]>;
}

/** `compilerOptions.paths` of one tsconfig, following `extends` (at most 8 deep). */
export function readPathsConfig(tsconfig: string, depth = 0): PathsConfig | null {
  if (depth > 8) return null;
  let json: { extends?: string | string[]; compilerOptions?: RawCompilerOptions };
  try {
    json = parseJsonc(readFileSync(tsconfig, "utf8")) as typeof json;
  } catch {
    return null;
  }
  const dir = path.dirname(tsconfig);
  let inherited: PathsConfig | null = null;
  let inheritedBaseUrl: string | null = null;
  for (const parent of [json.extends ?? []].flat()) {
    let file: string | null = null;
    if (parent.startsWith(".") || path.isAbsolute(parent)) {
      const target = path.resolve(dir, parent);
      file = isFile(target) ? target : isFile(`${target}.json`) ? `${target}.json` : null;
    } else {
      try {
        file = createRequire(path.join(dir, "tsconfig.json")).resolve(parent);
      } catch {
        file = null;
      }
    }
    if (!file) continue;
    const found = readPathsConfig(file, depth + 1);
    if (found) inherited = found;
    const parentJson = safeCompilerOptions(file);
    if (parentJson?.baseUrl) inheritedBaseUrl = path.resolve(path.dirname(file), parentJson.baseUrl);
  }
  const options = json.compilerOptions ?? {};
  const baseUrl = options.baseUrl ? path.resolve(dir, options.baseUrl) : inheritedBaseUrl;
  if (options.paths) return { base: baseUrl ?? dir, paths: options.paths };
  if (inherited && options.baseUrl) return { ...inherited, base: baseUrl ?? inherited.base };
  return inherited;
}

function safeCompilerOptions(file: string): RawCompilerOptions | null {
  try {
    return ((parseJsonc(readFileSync(file, "utf8")) as { compilerOptions?: RawCompilerOptions }).compilerOptions ?? null);
  } catch {
    return null;
  }
}

/** The file `specifier` names through `paths`, or null when no pattern matches a file. */
export function matchPaths(specifier: string, config: PathsConfig): string | null {
  // TypeScript's rule: the matching pattern with the longest prefix before `*` wins.
  const patterns = Object.keys(config.paths).sort(
    (a, b) => b.indexOf("*") - a.indexOf("*") || b.length - a.length,
  );
  for (const pattern of patterns) {
    const star = pattern.indexOf("*");
    let captured: string | null = null;
    if (star < 0) {
      if (pattern === specifier) captured = "";
    } else {
      const prefix = pattern.slice(0, star);
      const suffix = pattern.slice(star + 1);
      if (specifier.startsWith(prefix) && specifier.endsWith(suffix) && specifier.length >= prefix.length + suffix.length) {
        captured = specifier.slice(prefix.length, specifier.length - suffix.length);
      }
    }
    if (captured === null) continue;
    for (const target of config.paths[pattern] ?? []) {
      const file = resolveTsFile(path.resolve(config.base, target.replace("*", captured)));
      if (file) return file;
    }
  }
  return null;
}

const tsconfigCache = new Map<string, PathsConfig | null>();

function pathsFor(fromDir: string): PathsConfig | null {
  const seen: string[] = [];
  let dir = fromDir;
  for (;;) {
    if (tsconfigCache.has(dir)) {
      const cached = tsconfigCache.get(dir) ?? null;
      for (const d of seen) tsconfigCache.set(d, cached);
      return cached;
    }
    seen.push(dir);
    const candidate = path.join(dir, "tsconfig.json");
    if (existsSync(candidate)) {
      const found = readPathsConfig(candidate);
      for (const d of seen) tsconfigCache.set(d, found);
      return found;
    }
    const parent = path.dirname(dir);
    if (parent === dir) {
      for (const d of seen) tsconfigCache.set(d, null);
      return null;
    }
    dir = parent;
  }
}

function parentDir(parentURL: string | undefined): string | null {
  if (!parentURL?.startsWith("file:")) return null;
  return path.dirname(fileURLToPath(parentURL));
}

/**
 * A namespace that holds values. Sucrase compiles it to nothing, so a journey using one would
 * fail later with a misleading ReferenceError; refuse it by name instead (docs/load-loader.md).
 */
const VALUE_NAMESPACE = /^[ \t]*(?:export[ \t]+)?(?:namespace|module)[ \t]+[A-Za-z_$][\w$.]*[ \t]*\{/m;

/** TypeScript source as JavaScript, every line where it was. */
export function transformTypeScript(source: string, file: string): { code: string; format: "commonjs" | "module" } {
  if (VALUE_NAMESPACE.test(source)) {
    throw new Error(`${file}: TypeScript namespaces aren't supported in load journeys; use a module or an object instead`);
  }
  const esm = file.endsWith(".mts");
  const transforms: ("typescript" | "imports" | "jsx")[] = esm ? ["typescript"] : ["typescript", "imports"];
  if (file.endsWith(".tsx")) transforms.push("jsx");
  const { code } = transform(source, { transforms, filePath: file, disableESTransforms: true, preserveDynamicImport: true });
  return { code, format: esm ? "module" : "commonjs" };
}

let installed = false;

/** Registers the hooks once for this process. */
export function installLoader(): void {
  if (installed) return;
  installed = true;
  registerHooks({
    resolve(specifier, context, nextResolve) {
      const from = parentDir(context.parentURL);
      const relative = specifier.startsWith("./") || specifier.startsWith("../") || specifier === "." || specifier === "..";
      if (from && !relative && !path.isAbsolute(specifier) && !specifier.startsWith("node:") && !specifier.includes(":")) {
        const config = pathsFor(from);
        const mapped = config ? matchPaths(specifier, config) : null;
        if (mapped) return { url: pathToFileURL(mapped).href, shortCircuit: true };
      }
      try {
        return nextResolve(specifier, context);
      } catch (error) {
        if (!from || !(relative || path.isAbsolute(specifier))) throw error;
        const file = resolveTsFile(path.resolve(from, specifier));
        if (!file) throw error;
        return { url: pathToFileURL(file).href, shortCircuit: true };
      }
    },
    load(url, context, nextLoad) {
      if (url.startsWith("file:")) {
        const file = fileURLToPath(url);
        if (TS_FILE.test(file) && !file.endsWith(".d.ts")) {
          const { code, format } = transformTypeScript(readFileSync(file, "utf8"), file);
          return { format, source: code, shortCircuit: true };
        }
      }
      return nextLoad(url, context);
    },
  });
}

/**
 * The journey export, loaded through the hooks. `module` is repository-relative, and must
 * stay inside the repository after symlinks are followed.
 */
export function loadJourney(repositoryRoot: string, module: string, exportName: string): (...args: unknown[]) => unknown {
  installLoader();
  const root = realpathOrSelf(repositoryRoot);
  const file = resolveTsFile(path.resolve(root, module));
  if (!file) throw new Error(`journey module ${module} was not found`);
  const real = realpathOrSelf(file);
  if (real !== root && !real.startsWith(root + path.sep)) throw new Error(`journey module ${module} is outside the repository`);
  const loaded = createRequire(path.join(root, "package.json"))(real) as Record<string, unknown>;
  const fn = loaded[exportName];
  if (typeof fn !== "function") throw new Error(`journey module ${module} has no exported function ${exportName}`);
  return fn as (...args: unknown[]) => unknown;
}

function realpathOrSelf(file: string): string {
  try {
    return realpathSync.native(file);
  } catch {
    return path.resolve(file);
  }
}

/** The first stack frame in the customer's own code: `file:line`, or null. */
export function originalLocation(stack: string | undefined, root: string): string | null {
  for (const line of (stack ?? "").split("\n")) {
    const match = /\(?((?:file:\/\/)?\/[^():]+):(\d+):\d+\)?\s*$/.exec(line.trim());
    if (!match) continue;
    const file = match[1]!.replace(/^file:\/\//, "");
    if (file.includes(`${path.sep}node_modules${path.sep}`)) continue;
    if (!file.startsWith(root)) continue;
    return `${path.relative(root, file)}:${match[2]}`;
  }
  return null;
}
