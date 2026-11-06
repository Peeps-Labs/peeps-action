/**
 * The first pass: the repository's module graph from the source text alone, with no
 * parser. It answers most changes in seconds, and bounds the files the parser has to
 * read. Type-only imports are not edges: `import type { AppRouter }` would otherwise
 * tie every router to every client. A string naming a tracked file is one, because
 * code reads fixtures and spawns scripts by path.
 */
import path from "node:path/posix";

const SOURCE = /\.[cm]?[jt]sx?$/;
const EXTS = [".ts", ".tsx", ".mts", ".cts", ".js", ".mjs", ".cjs", ".jsx", ".json"];
const SPECIFIER = /(?:\bfrom\s*|\bimport\s*\(\s*|\bimport\s+|\brequire\s*\(\s*)(["'`])([^"'`\n]+)\1/g;
const PATH_LITERAL = /(["'`])((?:\.{1,2}\/)?[\w@.[\]-]+(?:\/[\w@.[\]()-]+)+)\1/g;
const TYPE_ONLY = /\b(?:import|export)\s+type\s+[\w$*{][^;'"`]*?\bfrom\s*["'][^"'\n]+["'];?/g;

/** tsconfig is JSONC, and `"**\/*.ts"` looks like a block comment to a naive regex. */
export function stripJsonComments(text: string): string {
  let out = "";
  for (let i = 0; i < text.length; ) {
    const c = text[i];
    if (c === '"') {
      let j = i + 1;
      while (j < text.length && text[j] !== '"') j += text[j] === "\\" ? 2 : 1;
      out += text.slice(i, j + 1);
      i = j + 1;
    } else if (c === "/" && text[i + 1] === "/") {
      while (i < text.length && text[i] !== "\n") i++;
    } else if (c === "/" && text[i + 1] === "*") {
      const end = text.indexOf("*/", i + 2);
      i = end === -1 ? text.length : end + 2;
    } else {
      out += c;
      i++;
    }
  }
  return out.replace(/,(\s*[}\]])/g, "$1");
}

/** The source with comments blanked and strings kept, so a path in a comment is no edge. */
export function stripComments(text: string): string {
  let out = "";
  let i = 0;
  while (i < text.length) {
    const c = text[i];
    const next = text[i + 1];
    if (c === "/" && next === "/") {
      while (i < text.length && text[i] !== "\n") i++;
    } else if (c === "/" && next === "*") {
      const end = text.indexOf("*/", i + 2);
      i = end === -1 ? text.length : end + 2;
      out += " ";
    } else if (c === '"' || c === "'" || c === "`") {
      let j = i + 1;
      while (j < text.length && text[j] !== c && !(c !== "`" && text[j] === "\n")) j += text[j] === "\\" ? 2 : 1;
      out += text.slice(i, j + 1);
      i = j + 1;
    } else {
      out += c;
      i++;
    }
  }
  return out;
}

interface TsConfig {
  paths: Record<string, string[]>;
  baseUrl: string;
}

/** A specifier as TypeScript would resolve it inside the repository: null for a package. */
export class Resolver {
  private tsconfigs = new Map<string, TsConfig>();

  constructor(
    private files: ReadonlySet<string>,
    private read: (file: string) => string,
  ) {}

  resolve(from: string, spec: string): string | null {
    if (spec.startsWith("node:")) return null;
    if (spec.startsWith(".")) return this.firstExisting(path.normalize(path.join(path.dirname(from), spec)));
    const config = this.tsconfigFor(from);
    if (!config) return null;
    for (const [pattern, targets] of Object.entries(config.paths)) {
      const star = pattern.indexOf("*");
      const matches = star === -1 ? spec === pattern : spec.startsWith(pattern.slice(0, star)) && spec.endsWith(pattern.slice(star + 1));
      if (!matches) continue;
      const wild = star === -1 ? "" : spec.slice(star, spec.length - (pattern.length - star - 1));
      for (const target of targets) {
        const hit = this.firstExisting(path.normalize(path.join(config.baseUrl, target.replace("*", wild))));
        if (hit) return hit;
      }
      return null;
    }
    return this.firstExisting(path.normalize(path.join(config.baseUrl, spec)));
  }

  /** A string naming a tracked file, from the repository root or the file holding it. */
  resolveLiteral(from: string, literal: string): string | null {
    if (literal.startsWith(".")) return this.firstExisting(path.normalize(path.join(path.dirname(from), literal)));
    return this.firstExisting(path.normalize(literal)) ?? this.firstExisting(path.normalize(path.join(path.dirname(from), literal)));
  }

  private firstExisting(base: string): string | null {
    if (base.startsWith("..")) return null;
    if (this.files.has(base)) return base;
    for (const ext of EXTS) if (this.files.has(base + ext)) return base + ext;
    for (const ext of EXTS) if (this.files.has(`${base}/index${ext}`)) return `${base}/index${ext}`;
    if (/\.[cm]?js$/.test(base)) {
      for (const swap of [".$1ts", ".$1tsx"]) {
        const candidate = base.replace(/\.([cm]?)js$/, swap);
        if (this.files.has(candidate)) return candidate;
      }
    }
    return null;
  }

  private tsconfigFor(file: string): TsConfig | null {
    let dir = path.dirname(file);
    for (;;) {
      const candidate = dir === "." ? "tsconfig.json" : `${dir}/tsconfig.json`;
      if (this.files.has(candidate)) return this.loadTsconfig(candidate, new Set());
      if (dir === ".") return null;
      dir = path.dirname(dir);
    }
  }

  private loadTsconfig(file: string, seen: Set<string>): TsConfig {
    const cached = this.tsconfigs.get(file);
    if (cached) return cached;
    seen.add(file);
    let config: TsConfig = { paths: {}, baseUrl: path.dirname(file) };
    try {
      const raw = JSON.parse(stripJsonComments(this.read(file))) as {
        extends?: unknown;
        compilerOptions?: { baseUrl?: string; paths?: Record<string, string[]> };
      };
      if (typeof raw.extends === "string" && raw.extends.startsWith(".")) {
        const parent = path.normalize(path.join(path.dirname(file), raw.extends.endsWith(".json") ? raw.extends : `${raw.extends}.json`));
        if (this.files.has(parent) && !seen.has(parent)) config = { ...this.loadTsconfig(parent, seen) };
      }
      const options = raw.compilerOptions ?? {};
      if (options.baseUrl) config.baseUrl = path.normalize(path.join(path.dirname(file), options.baseUrl));
      if (options.paths) config.paths = { ...config.paths, ...options.paths };
    } catch {
      // An unreadable tsconfig means no aliases: an import through one then reads as a package, and the file it names has no user.
    }
    this.tsconfigs.set(file, config);
    return config;
  }
}

/** The tracked files this text names: by a module specifier, or a string holding a path. */
export function referencedFiles(file: string, text: string, resolver: Resolver, onPackage?: (spec: string) => void): Set<string> {
  const edges = new Set<string>();
  const runtime = text.replace(TYPE_ONLY, " ");
  for (const match of runtime.matchAll(SPECIFIER)) {
    const target = resolver.resolve(file, match[2]!);
    if (target) edges.add(target);
    else onPackage?.(match[2]!);
  }
  for (const match of runtime.matchAll(PATH_LITERAL)) {
    const target = resolver.resolveLiteral(file, match[2]!);
    if (target) edges.add(target);
  }
  edges.delete(file);
  return edges;
}

export interface TextGraph {
  forward: Map<string, Set<string>>;
  reverse: Map<string, Set<string>>;
  /** Bare package names imported anywhere: a workspace's own is a dependency this graph can't follow. */
  packages: Set<string>;
  resolver: Resolver;
}

export function buildTextGraph(files: string[], read: (file: string) => string, tick: () => void, scanText: (file: string, text: string) => void): TextGraph {
  const tracked = new Set(files);
  const resolver = new Resolver(tracked, read);
  const forward = new Map<string, Set<string>>();
  const reverse = new Map<string, Set<string>>();
  const packages = new Set<string>();
  for (const file of files) {
    if (!SOURCE.test(file)) continue;
    tick();
    let text: string;
    try {
      text = stripComments(read(file));
    } catch (error) {
      // Tracked but absent: a sparse checkout. The parser's read says so if it matters.
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ENOENT" || code === "EISDIR") continue;
      throw error;
    }
    const edges = referencedFiles(file, text, resolver, (spec) => {
      if (!spec.startsWith(".")) packages.add(spec.startsWith("@") ? spec.split("/").slice(0, 2).join("/") : spec.split("/")[0]!);
    });
    forward.set(file, edges);
    for (const target of edges) {
      const importers = reverse.get(target);
      if (importers) importers.add(file);
      else reverse.set(target, new Set([file]));
    }
    scanText(file, text);
  }
  return { forward, reverse, packages, resolver };
}

/** `from` and everything reaching it (or it reaches), through `edges`, keeping what `keep` allows. */
export function closure(edges: Map<string, Set<string>>, from: Iterable<string>, keep: (file: string) => boolean = () => true): Set<string> {
  const seen = new Set<string>();
  const queue: string[] = [];
  for (const file of from) {
    if (!seen.has(file)) {
      seen.add(file);
      queue.push(file);
    }
  }
  while (queue.length > 0) {
    for (const next of edges.get(queue.pop()!) ?? []) {
      if (!seen.has(next) && keep(next)) {
        seen.add(next);
        queue.push(next);
      }
    }
  }
  return seen;
}
