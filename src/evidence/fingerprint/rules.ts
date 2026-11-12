/**
 * A Next build's fingerprint, the decisions (spike 2): one entity per thing a change
 * can touch, keyed so the same source gives the same key in every build, and valued by
 * a hash of its normalised text. Pure: `read-build.ts` walks `.next`.
 *
 * The five rules that made spike 2's change table exact:
 * 1. A chunk's map is the one its `sourceMappingURL` names.
 * 2. A function is `fn:<layer>:<source>:<name>`, with no ordinal; its value is the set
 *    of every copy's hash, so regrouping chunks changes nothing.
 * 3. A function's source is the majority of its own mapped segments, nested functions
 *    excluded. None means chunk scaffolding: no entity.
 * 4. A stylesheet's index map is split per section, each its module's `css:` entity.
 * 5. Client minification off (a build setting; the docs say so, nothing here checks it).
 *
 * And the two a minified server build needs (PQA-3494): its minifier names locals per
 * chunk, so a module beside a changed one gets new names in both its keys and its text.
 * 6. A name the minifier may have chosen never reaches a key or a value. A binding (a
 *    function's or variable's name, a parameter) is its original name where the map
 *    names it or the source text shows it, else its original position; the binding is
 *    the one TypeScript resolves, so two bindings never share a position. A function with
 *    no such name is `@<line>:<column>` where it starts in its source. Property names,
 *    and anything that resolves to no binding (a global), stay as built.
 * 7. Next's build templates (`next/…/build/templates/`) are scaffolding: every route
 *    compiles a copy, so one entity would join every route to every other, and the copy
 *    a boot-time health check ran would make every route's change ambient. A template only
 *    changes with Next itself, which the traced runtime makes global.
 *
 * Normalised away: the random `BUILD_ID`, preview and encryption keys, hashed chunk names.
 * Keys hold plaintext source paths here; `hash.ts` keys them before anything leaves.
 */
import { createHash } from "node:crypto";
import path from "node:path/posix";
import ts from "typescript";
import { nextEntry } from "../../reach/adapters/next";
import { decodeMappings, parseSourceMap, type Section } from "./source-map";

export interface BuildInput {
  /** Every file under `.next`, relative to it, `/`-separated. */
  files: string[];
  /** A file relative to `.next` (`../node_modules/…` reaches outside it), or null when it can't be read. */
  read: (file: string) => string | null;
  /** The Next app's directory, repo-relative: "" at the repository's root, `apps/web` in a monorepo. */
  sourcePrefix: string;
}

/** A function or stylesheet section of a built file, for mapping coverage onto keys. Null: scaffolding. */
export interface Span {
  start: number;
  end: number;
  key: string | null;
  /** The source file the key is in: a footprint holding `fn:` holds its `file:` too. */
  source: string | null;
}

export interface ScriptIndex {
  spans: Span[];
  /** A built script with no map is one entity, whatever ran in it. */
  whole?: string;
}

export interface Fingerprint {
  /** Key → its copies' hashes, sorted and joined with `,`. */
  entities: Map<string, string>;
  /** Key → the one source file it is in, for the keys that have one. */
  files: Map<string, string>;
  /** Keys whose change means everything: the Next runtime every route loads, and routing itself. */
  global: string[];
  /** By built file, relative to `.next`. */
  scripts: Map<string, ScriptIndex>;
  sheets: Map<string, ScriptIndex>;
}

const SKIP = /^(?:cache|standalone|trace|trace-build|diagnostics|types|turbopack|node_modules)(?:\/|$)/;
const MANIFESTS = [
  "routes-manifest.json",
  "app-path-routes-manifest.json",
  "server/app-paths-manifest.json",
  "prerender-manifest.json",
  "build-manifest.json",
  "server/server-reference-manifest.json",
  "server/middleware-manifest.json",
  "server/pages-manifest.json",
  "required-server-files.json",
  "images-manifest.json",
];
/** What routes every request: a rewrite or middleware change can reach any page. */
const ROUTING = new Set(["out:routes-manifest.json", "out:server/middleware-manifest.json"]);
const RANDOM_KEYS = /^(?:previewModeId|previewModeSigningKey|previewModeEncryptionKey|encryptionKey)$/;
const MAX_VOTES = 200;
/** Next's route and page templates, from its source or its built `dist` (rule 7). */
const TEMPLATE = /(?:^|\/)node_modules\/next\/(?:src|dist(?:\/esm)?)\/build\/templates\//;

export const sha16 = (text: string | Buffer) => createHash("sha256").update(text).digest("hex").slice(0, 16);

function decoded(text: string): string {
  try {
    return decodeURIComponent(text);
  } catch {
    return text;
  }
}

/** A map's source as a repo-relative path: Turbopack's `[project]`, webpack's `_N_E`, or relative to the map. */
export function sourceName(source: string, mapFile: string, sourcePrefix: string): string {
  let appRelative: string;
  const turbopack = /^turbopack:\/\/\/(?:\[project\]\/)?(.*)$/.exec(source);
  const webpack = /^webpack:\/\/[^/]*\/(.*)$/.exec(source);
  // A map's sources are URLs: `[id]` and `(group)` segments arrive percent-encoded.
  if (turbopack) appRelative = decoded(turbopack[1]!);
  else if (webpack) appRelative = decoded(webpack[1]!);
  else if (/^[a-z]+:/.test(source) || source.startsWith("[")) return source;
  // Relative to the map, which sits in `.next`, inside the app.
  else appRelative = path.join(".next", path.dirname(mapFile), decoded(source));
  return path.normalize(path.join(sourcePrefix || ".", appRelative)).replace(/^\.\//, "");
}

export function fingerprintBuild(input: BuildInput): Fingerprint {
  const files = input.files.filter((file) => !SKIP.test(file));
  const fingerprint: Fingerprint = { entities: new Map(), files: new Map(), global: [], scripts: new Map(), sheets: new Map() };
  const sets = new Map<string, Set<string>>();
  const put = (key: string, hash: string) => {
    let set = sets.get(key);
    if (!set) sets.set(key, (set = new Set()));
    set.add(hash);
  };
  const norm = normaliser(input.read("BUILD_ID")?.trim() ?? "", files);

  for (const file of files.filter((f) => f.endsWith(".js"))) {
    const code = input.read(file);
    if (code === null) continue;
    const index = fingerprintScript(file, code, input, norm, put);
    for (const span of index.spans) if (span.key && span.source) fingerprint.files.set(span.key, span.source);
    fingerprint.scripts.set(file, index);
  }
  for (const file of files.filter((f) => /^server\/(?:app|pages)\//.test(f) && /\.(?:html|rsc|meta)$/.test(f))) {
    const text = input.read(file);
    if (text !== null) put(`out:${file}`, sha16(norm(text)));
  }
  for (const file of files.filter((f) => f.endsWith(".css"))) {
    const css = input.read(file);
    if (css === null) continue;
    const index = fingerprintSheet(file, css, input, norm, put);
    for (const span of index.spans) if (span.key && span.source) fingerprint.files.set(span.key, span.source);
    fingerprint.sheets.set(file, index);
  }
  fingerprint.global.push(...traced(files, input, put));
  for (const name of MANIFESTS) {
    const text = input.read(name);
    if (text === null) continue;
    let value: unknown;
    try {
      value = JSON.parse(text);
    } catch {
      put(`out:${name}`, sha16(norm(text)));
      continue;
    }
    put(`out:${name}`, sha16(norm(JSON.stringify(value, (key, v) => (RANDOM_KEYS.test(key) ? "<random>" : v)))));
    if (ROUTING.has(`out:${name}`)) fingerprint.global.push(`out:${name}`);
  }
  routes(input, put);
  for (const [key, set] of sets) fingerprint.entities.set(key, [...set].sort().join(","));
  fingerprint.global.sort();
  return fingerprint;
}

/** The keys whose values differ between two fingerprints, either side's included. */
export function diffFingerprints(a: Fingerprint, b: Fingerprint): string[] {
  const keys = new Set([...a.entities.keys(), ...b.entities.keys()]);
  return [...keys].filter((key) => a.entities.get(key) !== b.entities.get(key));
}

function normaliser(buildId: string, files: string[]): (text: string) => string {
  // Longest first, so a name that contains another is replaced whole.
  const chunks = files
    .filter((f) => /^(?:static|server)\/chunks\//.test(f) && /\.(?:js|css)$/.test(f))
    .map((f) => path.basename(f).replace(/\.(?:js|css)$/, ""))
    .filter((name) => name.length >= 8)
    .sort((a, b) => b.length - a.length);
  const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const chunkPattern = chunks.length ? new RegExp(chunks.flatMap((n) => [escape(n), escape(encodeURIComponent(n))]).join("|"), "g") : null;
  return (text) => {
    let out = buildId ? text.split(buildId).join("<BUILD_ID>") : text;
    out = out.replace(/(\\?"encryptionKey\\?"\s*:\s*\\?")[^"\\]*/g, "$1<random>");
    if (chunkPattern) out = out.replace(chunkPattern, "<chunk>");
    return out.replace(/\/[/*][#@] sourceMappingURL=[^\s*]+/g, "//# sourceMappingURL=<map>");
  };
}

function mapFor(file: string, code: string, read: BuildInput["read"]): { file: string; sections: Section[] } | null {
  const named = /\/[/*][#@] sourceMappingURL=([^\s*]+)\s*(?:\*\/)?\s*$/.exec(code.slice(-500));
  const candidates = named && !named[1]!.startsWith("data:") ? [path.join(path.dirname(file), decodeURIComponent(named[1]!))] : [];
  candidates.push(`${file}.map`);
  for (const candidate of candidates) {
    const text = read(candidate);
    const sections = text === null ? null : parseSourceMap(text);
    if (sections) return { file: candidate, sections };
  }
  return null;
}

interface Mapped {
  col: number;
  source: string;
  name: string | null;
  /** Where it is in its source, 0-based. */
  line: number;
  column: number;
  /** The source's original text, when the map carries it. */
  content: string | null;
}

/** Each generated line's mapped segments, with an index map's sections laid at their offsets. */
function flatten(sections: Section[], mapFile: string, sourcePrefix: string): Mapped[][] {
  const lines: Mapped[][] = [];
  for (const { offset, map } of sections) {
    const decoded = decodeMappings(map.mappings);
    const sources = map.sources.map((s) => sourceName(s, mapFile, sourcePrefix));
    decoded.forEach((segments, i) => {
      const line = (lines[offset.line + i] ??= []);
      for (const segment of segments) {
        line.push({
          col: segment[0] + (i === 0 ? offset.column : 0),
          source: sources[segment[1]] ?? sourceName("", mapFile, sourcePrefix),
          name: segment.length === 5 ? map.names[segment[4]] ?? null : null,
          line: segment[2],
          column: segment[3],
          content: map.sourcesContent[segment[1]] ?? null,
        });
      }
    });
  }
  return lines;
}

const lineStartsOf = new Map<string, number[]>();

/** Whether the source's own text at a segment is this identifier: an unminified name. */
function sourceSays(segment: Mapped, name: string): boolean {
  const content = segment.content;
  if (content === null) return false;
  let starts = lineStartsOf.get(content);
  if (!starts) {
    starts = [0];
    for (let i = 0; i < content.length; i++) if (content.charCodeAt(i) === 10) starts.push(i + 1);
    lineStartsOf.set(content, starts);
  }
  const at = (starts[segment.line] ?? Infinity) + segment.column;
  return content.startsWith(name, at) && !/[\w$]/.test(content[at + name.length] ?? "") && !/[\w$]/.test(content[at - 1] ?? "");
}

interface Fn {
  node: ts.Node;
  start: number;
  end: number;
  name: FnName | null;
  kids: Fn[];
}

/** A function's name, and whether a minifier may have chosen it: a binding's may, a property's never. */
interface FnName {
  text: string;
  /** The binding's identifier, for its original name (rule 6); null for a property's or a literal key. */
  binding: ts.Identifier | null;
}

const FUNCTION_KINDS = new Set([
  ts.SyntaxKind.FunctionDeclaration,
  ts.SyntaxKind.FunctionExpression,
  ts.SyntaxKind.ArrowFunction,
  ts.SyntaxKind.MethodDeclaration,
  ts.SyntaxKind.Constructor,
  ts.SyntaxKind.GetAccessor,
  ts.SyntaxKind.SetAccessor,
  // V8 runs a class's `static { … }` as its own function, `<static_initializer>`.
  ts.SyntaxKind.ClassStaticBlockDeclaration,
]);

function keyText(name: ts.Node | undefined): string | null {
  if (!name) return null;
  if (ts.isIdentifier(name) || ts.isPrivateIdentifier(name) || ts.isStringLiteralLike(name) || ts.isNumericLiteral(name)) return name.text;
  return "computed";
}

/** What the code calls a function, as spike 2's `astName` did. Parentheses don't count. */
function nameOf(node: ts.Node, parent: ts.Node | undefined): FnName | null {
  const ownNode = (node as { name?: ts.Node }).name;
  const own = keyText(ownNode);
  // A function declaration's or expression's own name is a binding; a method's is a property.
  const bindingOwn = ts.isFunctionDeclaration(node) || ts.isFunctionExpression(node);
  if (own) return { text: own, binding: bindingOwn && ownNode && ts.isIdentifier(ownNode) ? ownNode : null };
  if (!parent) return null;
  if (ts.isVariableDeclaration(parent) && ts.isIdentifier(parent.name)) return { text: parent.name.text, binding: parent.name };
  if (ts.isPropertyAssignment(parent) || ts.isPropertyDeclaration(parent)) {
    const text = keyText(parent.name);
    return text === null ? null : { text, binding: null };
  }
  if (ts.isBinaryExpression(parent) && parent.operatorToken.kind === ts.SyntaxKind.EqualsToken && parent.right === node) {
    return { text: ts.isPropertyAccessExpression(parent.left) ? parent.left.name.text : "member", binding: null };
  }
  return null;
}

/** An identifier that names a property, a label or an import's export: never a binding to rename. */
function notBinding(id: ts.Identifier): boolean {
  const parent = id.parent;
  if (!parent) return true;
  if (ts.isPropertyAccessExpression(parent) || ts.isMetaProperty(parent)) return parent.name === id;
  if (ts.isQualifiedName(parent)) return parent.right === id;
  if (
    ts.isPropertyAssignment(parent) ||
    ts.isPropertyDeclaration(parent) ||
    ts.isMethodDeclaration(parent) ||
    ts.isGetAccessorDeclaration(parent) ||
    ts.isSetAccessorDeclaration(parent) ||
    ts.isPropertySignature(parent) ||
    ts.isEnumMember(parent) ||
    ts.isPropertyAccessChain(parent)
  ) {
    return parent.name === id;
  }
  if (ts.isBindingElement(parent)) return parent.propertyName === id;
  // An import or export names the other module's binding too: left as built.
  return ts.isLabeledStatement(parent) || ts.isBreakOrContinueStatement(parent) || ts.isImportSpecifier(parent) || ts.isExportSpecifier(parent) || ts.isImportClause(parent) || ts.isNamespaceImport(parent) || ts.isNamespaceExport(parent);
}

/** What declares a binding under its `name`. */
const DECLARES = new Set([
  ts.SyntaxKind.VariableDeclaration,
  ts.SyntaxKind.Parameter,
  ts.SyntaxKind.BindingElement,
  ts.SyntaxKind.FunctionDeclaration,
  ts.SyntaxKind.FunctionExpression,
  ts.SyntaxKind.ClassDeclaration,
  ts.SyntaxKind.ClassExpression,
]);

/** One chunk's syntax tree with a checker to resolve its bindings: no library, no other file. */
function bound(file: string, code: string): { source: ts.SourceFile; checker: ts.TypeChecker } {
  const name = `/${file}`;
  const source = ts.createSourceFile(name, code, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  const host: ts.CompilerHost = {
    getSourceFile: (f) => (f === name ? source : undefined),
    getDefaultLibFileName: () => "/lib.d.ts",
    writeFile: () => {},
    getCurrentDirectory: () => "/",
    getCanonicalFileName: (f) => f,
    useCaseSensitiveFileNames: () => true,
    getNewLine: () => "\n",
    fileExists: (f) => f === name,
    readFile: (f) => (f === name ? code : undefined),
  };
  const options: ts.CompilerOptions = { allowJs: true, noLib: true, noResolve: true, types: [], noEmit: true, target: ts.ScriptTarget.Latest };
  return { source, checker: ts.createProgram({ rootNames: [name], options, host }).getTypeChecker() };
}

function functionsOf(source: ts.SourceFile): Fn[] {
  const top: Fn[] = [];
  const visit = (node: ts.Node, parent: ts.Node | undefined, holder: Fn[]) => {
    let into = holder;
    if (FUNCTION_KINDS.has(node.kind)) {
      const fn: Fn = { node, start: node.getStart(source), end: node.end, name: nameOf(node, parent), kids: [] };
      holder.push(fn);
      into = fn.kids;
    }
    // A parenthesised function's parent is what holds the parentheses.
    const next = ts.isParenthesizedExpression(node) ? parent : node;
    ts.forEachChild(node, (child) => visit(child, next, into));
  };
  ts.forEachChild(source, (child) => visit(child, undefined, top));
  return top;
}

function fingerprintScript(
  file: string,
  code: string,
  input: BuildInput,
  norm: (text: string) => string,
  put: (key: string, hash: string) => void,
): ScriptIndex {
  const layer = file.startsWith("static/") ? "browser" : "server";
  const whole = (): ScriptIndex => {
    const key = `out:${norm(file)}`;
    put(key, sha16(norm(code)));
    return { spans: [], whole: key };
  };
  const map = mapFor(file, code, input.read);
  if (!map) return whole();
  const { source, checker } = bound(file, code);
  if ((source as unknown as { parseDiagnostics: unknown[] }).parseDiagnostics.length > 0) return whole();
  const lines = flatten(map.sections, map.file, input.sourcePrefix);
  const lineStarts = source.getLineStarts();
  const spans: Span[] = [];
  // The segment that starts exactly at a generated offset: an identifier's own mapping.
  const at = new Map<number, Mapped>();
  lines.forEach((segments, l) => {
    for (const segment of segments) if (!at.has(lineStarts[l]! + segment.col)) at.set(lineStarts[l]! + segment.col, segment);
  });

  /** A binding's original name, from the map or its source's text; null when neither says (rule 6). */
  const originalName = (id: ts.Identifier): string | null => {
    const segment = at.get(id.getStart(source));
    if (!segment) return null;
    if (segment.name) return segment.name;
    return sourceSays(segment, id.text) ? id.text : null;
  };
  /** What a binding is called in a value: its original name, else its original place, else null (as built). */
  const canonical = new Map<ts.Symbol, string | null>();
  const bindingName = (symbol: ts.Symbol | undefined): string | null => {
    if (!symbol) return null;
    if (canonical.has(symbol)) return canonical.get(symbol)!;
    let name: string | null = null;
    const declared = symbol.declarations?.find((d) => d.getSourceFile() === source);
    const id = declared && (declared as { name?: ts.Node }).name;
    if (id && ts.isIdentifier(id)) {
      const segment = at.get(id.getStart(source));
      name = originalName(id) ?? (segment ? `\u0000${segment.source}@${segment.line + 1}:${segment.column + 1}` : unmapped().get(id) ?? null);
    }
    canonical.set(symbol, name);
    return name;
  };
  /**
   * A binding the minifier made (a temporary, say) maps nowhere: it is its function's
   * k-th such binding, that function placed by where it starts in its source. Its own
   * function changing renumbers it, which is that function's change anyway.
   */
  let unmappedNames: Map<ts.Identifier, string | null> | null = null;
  const unmapped = () => {
    if (unmappedNames) return unmappedNames;
    unmappedNames = new Map();
    const byContainer = new Map<ts.Node, ts.Identifier[]>();
    const visit = (node: ts.Node) => {
      const parent = node.parent;
      if (ts.isIdentifier(node) && parent && (parent as { name?: ts.Node }).name === node && DECLARES.has(parent.kind) && !at.has(node.getStart(source))) {
        let container: ts.Node = parent;
        while (!FUNCTION_KINDS.has(container.kind) && container.parent) container = container.parent;
        const list = byContainer.get(container);
        if (list) list.push(node);
        else byContainer.set(container, [node]);
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
    for (const [container, ids] of byContainer) {
      const fn = fnOf.get(container);
      const found = fn ? origin(fn) : null;
      ids.forEach((id, k) => unmappedNames!.set(id, found ? `\u0000${found.source}@${found.start.line + 1}:${found.start.column + 1}#${k}` : null));
    }
    return unmappedNames;
  };
  const fnOf = new Map<ts.Node, Fn>();

  const origin = (fn: Fn): { source: string; name: string | null; start: Mapped } | null => {
    const votes = new Map<string, number>();
    const firstOf = new Map<string, Mapped>();
    let first: Mapped | null = null;
    let count = 0;
    const startLine = source.getLineAndCharacterOfPosition(fn.start).line;
    const endLine = source.getLineAndCharacterOfPosition(fn.end).line;
    let kid = 0;
    outer: for (let l = startLine; l <= endLine && l < lines.length; l++) {
      for (const segment of lines[l] ?? []) {
        const at = lineStarts[l]! + segment.col;
        if (at < fn.start) continue;
        if (at >= fn.end) break outer;
        while (kid < fn.kids.length && fn.kids[kid]!.end <= at) kid++;
        // A nested function's segments are its own vote, not this one's.
        if (kid < fn.kids.length && fn.kids[kid]!.start <= at) continue;
        first ??= segment;
        if (!firstOf.has(segment.source)) firstOf.set(segment.source, segment);
        votes.set(segment.source, (votes.get(segment.source) ?? 0) + 1);
        if (++count >= MAX_VOTES) break outer;
      }
    }
    if (!first) return null;
    const winner = [...votes].sort((a, b) => b[1] - a[1])[0]![0];
    // Every route's copy of a template is no one's code (rule 7).
    if (TEMPLATE.test(winner)) return null;
    return { source: winner, name: first.source === winner ? first.name : null, start: firstOf.get(winner)! };
  };
  /** The function's text, nested functions as a marker, every binding by its rule 6 name. */
  const ownText = (fn: Fn) => {
    const edits: Array<[number, number, string]> = [];
    for (const kid of fn.kids) edits.push([kid.start, kid.end, "\u0000F"]);
    const kidAt = new Set(fn.kids.map((kid) => kid.node));
    const visit = (node: ts.Node) => {
      if (kidAt.has(node)) return;
      if (ts.isIdentifier(node)) {
        const parent = node.parent;
        if (ts.isShorthandPropertyAssignment(parent) && parent.name === node) {
          // `{ a }` is the property `a` and the binding `a`: keep the one, rename the other.
          const name = bindingName(checker.getShorthandAssignmentValueSymbol(parent));
          if (name !== null && name !== node.text) edits.push([node.getStart(source), node.end, `${node.text}:${name}`]);
        } else if (!notBinding(node)) {
          const name = bindingName(checker.getSymbolAtLocation(node));
          if (name !== null && name !== node.text) edits.push([node.getStart(source), node.end, name]);
        }
        return;
      }
      ts.forEachChild(node, visit);
    };
    ts.forEachChild(fn.node, visit);
    edits.sort((a, b) => a[0] - b[0]);
    let text = "";
    let from = fn.start;
    for (const [start, end, replacement] of edits) {
      text += code.slice(from, start) + replacement;
      from = end;
    }
    return text + code.slice(from, fn.end);
  };
  /** A function's key name: the map's, a property's, a binding's original, else where it starts (rule 6). */
  const keyName = (fn: Fn, found: { name: string | null; start: Mapped }) => {
    if (found.name) return found.name;
    if (fn.name && fn.name.binding === null) return fn.name.text;
    const original = fn.name?.binding ? originalName(fn.name.binding) : null;
    return original ?? `@${found.start.line + 1}:${found.start.column + 1}`;
  };
  const walk = (fns: Fn[]) => {
    for (const fn of fns) {
      const found = origin(fn);
      const key = found ? `fn:${layer}:${found.source}:${keyName(fn, found)}` : null;
      if (key) put(key, sha16(norm(ownText(fn))));
      spans.push({ start: fn.start, end: fn.end, key, source: found?.source ?? null });
      walk(fn.kids);
    }
  };
  const fns = functionsOf(source);
  const index = (list: Fn[]) => list.forEach((fn) => (fnOf.set(fn.node, fn), index(fn.kids)));
  index(fns);
  walk(fns);
  spans.sort((a, b) => a.start - b.start || b.end - a.end);
  return { spans };
}

function fingerprintSheet(
  file: string,
  css: string,
  input: BuildInput,
  norm: (text: string) => string,
  put: (key: string, hash: string) => void,
): ScriptIndex {
  const map = mapFor(file, css, input.read);
  if (!map) {
    const key = `css:${norm(file)}`;
    put(key, sha16(norm(css)));
    return { spans: [], whole: key };
  }
  const lineStarts = [0];
  for (let i = 0; i < css.length; i++) if (css.charCodeAt(i) === 10) lineStarts.push(i + 1);
  const at = (offset: Section["offset"]) => (lineStarts[offset.line] ?? css.length) + offset.column;
  const spans: Span[] = [];
  map.sections.forEach((section, i) => {
    const start = at(section.offset);
    const next = map.sections[i + 1];
    const end = next ? at(next.offset) : css.length;
    const sources = section.map.sources.map((s) => sourceName(s, map.file, input.sourcePrefix)).sort();
    const key = `css:${sources.join("|")}`;
    put(key, sha16(norm(css.slice(start, end))));
    spans.push({ start, end, key, source: sources.length === 1 ? sources[0]! : null });
  });
  return { spans };
}

/** Every `node_modules` file a route's trace names, and those that are the Next runtime. */
function traced(files: string[], input: BuildInput, put: (key: string, hash: string) => void): string[] {
  const traces = files.filter((f) => f.endsWith(".nft.json"));
  const counts = new Map<string, number>();
  for (const trace of traces) {
    let list: unknown;
    try {
      list = (JSON.parse(input.read(trace) ?? "") as { files?: unknown }).files;
    } catch {
      continue;
    }
    if (!Array.isArray(list)) continue;
    for (const entry of new Set(list.filter((f): f is string => typeof f === "string"))) {
      const file = path.normalize(path.join(path.dirname(trace), entry));
      if (file.includes("node_modules/")) counts.set(file, (counts.get(file) ?? 0) + 1);
    }
  }
  const global: string[] = [];
  for (const [file, count] of counts) {
    const content = input.read(file);
    // `.next` sits in the app: one `..` is the app's directory.
    const key = `file:${path.normalize(path.join(input.sourcePrefix || ".", file.replace(/^\.\.\//, "")))}`;
    put(key, content === null ? "missing" : sha16(content));
    if (/(?:^|\/)node_modules\/next\//.test(file) || (traces.length >= 2 && count === traces.length)) global.push(key);
  }
  return global;
}

/**
 * Each route in the app and pages manifests, by the built file's own route (`nextEntry`
 * with the empty root: a manifest's value is relative to the app's build, Z1). A route
 * that doesn't normalise (an intercepting or private segment) is only its built file.
 * Its value is the manifest entry itself: code under it changes its `fn:` entities.
 */
function routes(input: BuildInput, put: (key: string, hash: string) => void): void {
  for (const manifest of ["server/app-paths-manifest.json", "server/pages-manifest.json"]) {
    let entries: unknown;
    try {
      entries = JSON.parse(input.read(manifest) ?? "");
    } catch {
      continue;
    }
    if (typeof entries !== "object" || entries === null) continue;
    for (const [key, value] of Object.entries(entries)) {
      if (typeof value !== "string") continue;
      const route = nextEntry(value, [""]);
      put(route ? `route:${route}` : `out:server/${value}`, sha16(`${key}\u0000${value}`));
    }
  }
}

