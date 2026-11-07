/**
 * The first pass: the repository's module graph, read with the parser and thrown away,
 * so it answers most changes before the symbol pass reads anything. It's the parser and
 * not a tokenizer of ours because a regex, a template or JSX holding `/*` or `//` kept
 * hiding the imports after it: a hand-written reader failed on each new form, and this
 * cost 1 to 2 s on 10,000 files. Type-only imports are not edges: `import type {
 * AppRouter }` would otherwise tie every router to every client. A string naming a
 * tracked file is one, because code reads fixtures and spawns scripts by path.
 */
import path from "node:path/posix";
import ts from "typescript";
import { scriptKind } from "./parse";

const SOURCE = /\.[cm]?[jt]sx?$/;
const EXTS = [".ts", ".tsx", ".mts", ".cts", ".js", ".mjs", ".cjs", ".jsx", ".json"];
/** Over this a file isn't parsed for its edges: generated output. Its specifiers are read from the raw text, comments and all, which only adds edges. */
const MAX_PARSED_BYTES = 1024 * 1024;
const SPECIFIER = /(?:\bfrom\s*|\bimport\s*\(\s*|\bimport\s+|\brequire\s*\(\s*)(["'`])([^"'`\n]+)\1/g;
const PATH_SHAPE = /^(?:(?:\.{1,2}\/)?[\w@.[\]-]+(?:\/[\w@.[\]()-]+)+|\.{1,2}\/[\w@.[\]()-]+)$/;

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

/** The tracked files this source names at run time: by a module specifier, or a string holding a path. */
function referencedFiles(file: string, source: ts.SourceFile, resolver: Resolver, onPackage: (spec: string) => void): Set<string> {
  const edges = new Set<string>();
  const specifier = (spec: string) => {
    const target = resolver.resolve(file, spec);
    if (target) edges.add(target);
    else onPackage(spec);
  };
  const visit = (node: ts.Node): void => {
    if (ts.isTypeNode(node) || ts.isInterfaceDeclaration(node) || ts.isTypeAliasDeclaration(node)) return;
    if (ts.isImportDeclaration(node)) {
      const clause = node.importClause;
      const bindings = clause?.namedBindings;
      const onlyTypes = clause?.isTypeOnly || (clause && !clause.name && bindings && ts.isNamedImports(bindings) && bindings.elements.length > 0 && bindings.elements.every((element) => element.isTypeOnly));
      if (!onlyTypes && ts.isStringLiteralLike(node.moduleSpecifier)) specifier(node.moduleSpecifier.text);
      return;
    }
    if (ts.isExportDeclaration(node)) {
      if (!node.isTypeOnly && node.moduleSpecifier && ts.isStringLiteralLike(node.moduleSpecifier)) specifier(node.moduleSpecifier.text);
      if (node.moduleSpecifier) return;
    }
    if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference) && ts.isStringLiteralLike(node.moduleReference.expression)) {
      specifier(node.moduleReference.expression.text);
      return;
    }
    if (ts.isCallExpression(node) && node.arguments[0] && ts.isStringLiteralLike(node.arguments[0])) {
      const callee = node.expression;
      if (callee.kind === ts.SyntaxKind.ImportKeyword || (ts.isIdentifier(callee) && callee.text === "require")) {
        specifier(node.arguments[0].text);
        return;
      }
    }
    if (ts.isStringLiteralLike(node) && PATH_SHAPE.test(node.text)) {
      const target = resolver.resolveLiteral(file, node.text);
      if (target) edges.add(target);
      return;
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  edges.delete(file);
  return edges;
}

/** What a file too large to parse names, from its raw text. */
function referencedInRawText(file: string, text: string, resolver: Resolver): Set<string> {
  const edges = new Set<string>();
  for (const match of text.matchAll(SPECIFIER)) {
    const target = resolver.resolve(file, match[2]!);
    if (target) edges.add(target);
  }
  edges.delete(file);
  return edges;
}

export interface TextGraph {
  forward: Map<string, Set<string>>;
  reverse: Map<string, Set<string>>;
  /** Tracked source files the checkout doesn't have: they might import anything. */
  unread: string[];
  /** Bare package names imported anywhere: a workspace's own is a dependency this graph can't follow. */
  packages: Set<string>;
  resolver: Resolver;
}

export function buildTextGraph(files: string[], read: (file: string) => string, tick: () => void, scanSource: (file: string, source: ts.SourceFile) => void): TextGraph {
  const tracked = new Set(files);
  const resolver = new Resolver(tracked, read);
  const forward = new Map<string, Set<string>>();
  const reverse = new Map<string, Set<string>>();
  const packages = new Set<string>();
  const unread: string[] = [];
  for (const file of files) {
    if (!SOURCE.test(file)) continue;
    tick();
    let text: string;
    try {
      text = read(file);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ENOENT" || code === "EISDIR") {
        unread.push(file);
        continue;
      }
      throw error;
    }
    let edges: Set<string>;
    if (text.length > MAX_PARSED_BYTES) edges = referencedInRawText(file, text, resolver);
    else {
      const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, false, scriptKind(file));
      edges = referencedFiles(file, source, resolver, (spec) => {
        if (!spec.startsWith(".")) packages.add(spec.startsWith("@") ? spec.split("/").slice(0, 2).join("/") : spec.split("/")[0]!);
      });
      scanSource(file, source);
    }
    forward.set(file, edges);
    for (const target of edges) {
      const importers = reverse.get(target);
      if (importers) importers.add(file);
      else reverse.set(target, new Set([file]));
    }
  }
  return { forward, reverse, unread, packages, resolver };
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
