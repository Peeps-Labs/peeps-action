/**
 * A request the application's own code makes. A fetch of a route ties the caller to it,
 * which imports don't show, and a request whose address can't be read could be to
 * anything, so reaching one is a doubt. What a browser runs is in the trace instead.
 */
import ts from "typescript";
import type { ConventionFactory, Node } from "../convention";
import type { FileFacts, Sym } from "../graph";
import { surfaceMeetsPath } from "../match";
import { staticChain } from "../syntax";

const CALLABLE = new Set(["fetch", "$fetch", "ofetch", "got", "ky", "axios", "superagent"]);
const CLIENT = new Set(["axios", "ky", "got", "ofetch", "superagent", "$fetch"]);
const VERBS = new Set(["get", "post", "put", "patch", "delete", "head", "options", "request"]);
const GLOBALS = new Set(["globalThis", "global", "window", "self"]);
const MENTIONS_REQUEST = /\b(?:fetch|ofetch|got|ky|axios|superagent)\b|\.(?:get|post|put|patch|delete|head|options|request)\(/;

/** A fetched path, and whether it was written from `/` rather than after a base or a host. */
interface Fetched {
  path: string;
  own: boolean;
}

interface Marks {
  paths?: Fetched[];
  unresolved?: boolean;
  /** `x.get(…)` on a binding that may be a client, settled once files are linked. */
  maybe?: Array<{ root: string; path: Fetched | null }>;
}

const marksOf = (sym: Sym): Marks => (sym.marks.fetch ??= {}) as Marks;
const clientsOf = (facts: FileFacts): Set<string> => (facts.data.fetchClients ??= new Set<string>()) as Set<string>;

/**
 * A fetched address as a footprint would read it: no host, no query, and `${id}` as a
 * folded segment. A server fetching its own absolute URL is the same route, whatever the
 * host. Null with no path to read.
 */
function fetchedPath(literal: string): Fetched | null {
  const address = literal.replace(/^(?:https?:)?\/\/[^/]*/, "").replace(/^\$\{x\}(?=\/)/, "");
  if (!address.startsWith("/")) return null;
  const path = address.split(/[?#]/)[0]!.replace(/\$\{x\}/g, ":id");
  return { path: path.length > 1 ? path.replace(/\/+$/, "") : path, own: literal.startsWith("/") && !literal.startsWith("//") };
}

/** The address in a call's first argument, however it's written, with `${x}` for what's computed. */
function addressOf(node: ts.Expression | undefined): string | null {
  if (!node) return null;
  if (ts.isStringLiteralLike(node)) return node.text;
  if (ts.isTemplateExpression(node)) return node.head.text + node.templateSpans.map((span) => `\${x}${span.literal.text}`).join("");
  if (ts.isNewExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === "URL") return addressOf(node.arguments?.[0]);
  if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.PlusToken) {
    const left = addressOf(node.left) ?? "${x}";
    const right = addressOf(node.right) ?? "${x}";
    return left + right;
  }
  return null;
}

/** What kind of request a call is, if any. */
function requestOf(call: ts.CallExpression): { direct: boolean; root?: string } | null {
  const callee = call.expression;
  if (ts.isIdentifier(callee)) return CALLABLE.has(callee.text) ? { direct: true } : null;
  if (!ts.isPropertyAccessExpression(callee)) return null;
  const chain = staticChain(callee);
  if (!chain) return null;
  const [root, member] = [chain[0]!, chain[chain.length - 1]!];
  if (chain.length === 2 && GLOBALS.has(root) && member === "fetch") return { direct: true };
  if (chain.length === 2 && CLIENT.has(root) && (VERBS.has(member) || root === "$fetch")) return { direct: true };
  if (chain.length === 2 && VERBS.has(member)) return { direct: false, root };
  return null;
}

const pathOf = (call: ts.CallExpression): Fetched | null => {
  const address = addressOf(call.arguments[0]);
  return address === null ? null : fetchedPath(address);
};

/**
 * Whether this fetch is of this route. It must meet it. A path written from `/` is this
 * application's, so one word of its own is enough: nothing but placeholders would tie
 * every route to it. After a computed base or a host it may be another API's, so it must
 * share a word with the route: `${GITHUB}/repos/${o}/${r}/${id}` isn't `/:org/settings/:p`.
 */
function bridges(surface: string, path: string, ownPath: boolean): boolean {
  if (!surfaceMeetsPath(surface, path)) return false;
  const have = path.split("/").filter(Boolean);
  if (have.length === 0) return true;
  if (ownPath) return have.some((segment) => !segment.startsWith(":"));
  const want = surface.split("/").filter(Boolean);
  return want.some((segment, i) => !/^(?::|\*)/.test(segment) && have[i] !== undefined && !have[i]!.startsWith(":") && segment.toLowerCase() === have[i]!.toLowerCase());
}

/** Fetched paths by their segments, so a surface finds what might meet it without trying them all. */
class PathIndex<T> {
  private root: TrieNode<T> = { children: new Map(), values: [] };
  private memo = new Map<string, T[]>();

  add(fetched: Fetched, value: T) {
    let node = this.root;
    for (const segment of indexSegments(fetched.path)) {
      let next = node.children.get(segment);
      if (!next) {
        next = { children: new Map(), values: [] };
        node.children.set(segment, next);
      }
      node = next;
    }
    node.values.push({ fetched, value });
  }

  meeting(surface: string): T[] {
    let found = this.memo.get(surface);
    if (found) return found;
    found = [];
    const want = surface.split("/").filter(Boolean);
    const collect = (node: TrieNode<T>) => {
      for (const entry of node.values) if (bridges(surface, entry.fetched.path, entry.fetched.own)) found!.push(entry.value);
      for (const child of node.children.values()) collect(child);
    };
    const visit = (node: TrieNode<T>, at: number) => {
      if (at === want.length) {
        for (const entry of node.values) if (bridges(surface, entry.fetched.path, entry.fetched.own)) found!.push(entry.value);
        return;
      }
      const segment = want[at]!;
      if (segment === "*" || segment === "**") return collect(node);
      if (segment.startsWith(":")) {
        for (const child of node.children.values()) visit(child, at + 1);
        return;
      }
      for (const key of new Set([normal(segment), ":id"])) {
        const child = node.children.get(key);
        if (child) visit(child, at + 1);
      }
    };
    visit(this.root, 0);
    this.memo.set(surface, found);
    return found;
  }
}

interface TrieNode<T> {
  children: Map<string, TrieNode<T>>;
  values: Array<{ fetched: Fetched; value: T }>;
}

function normal(segment: string): string {
  try {
    return decodeURIComponent(segment.split(";")[0]!).toLowerCase();
  } catch {
    return ":id";
  }
}

function indexSegments(path: string): string[] {
  return path
    .split("/")
    .filter(Boolean)
    .map((segment) => (segment.startsWith(":") ? ":id" : normal(segment)));
}

const BROWSER_FILE = /^\s*(?:\/\/[^\n]*\n\s*|\/\*[\s\S]*?\*\/\s*)*["']use client["']/;

export const fetchCalls: ConventionFactory = () => {
  const holders = new PathIndex<string>();
  return {
    scanSource(file, source) {
      if (!MENTIONS_REQUEST.test(source.text)) return;
      const visit = (node: ts.Node): void => {
        if (ts.isCallExpression(node) && requestOf(node)) {
          const path = pathOf(node);
          if (path !== null) holders.add(path, file);
        }
        ts.forEachChild(node, visit);
      };
      visit(source);
    },
    readBinding(name, init, _sym, { facts }) {
      if (init && ts.isCallExpression(init) && ts.isPropertyAccessExpression(init.expression) && init.expression.name.text === "create") {
        const root = staticChain(init.expression.expression)?.[0];
        if (root && CLIENT.has(root)) clientsOf(facts).add(name);
      }
      return false;
    },
    readNode(node, sym, { facts, text }) {
      if (!ts.isCallExpression(node)) return false;
      const request = requestOf(node);
      if (!request) return false;
      if ((facts.data.fetchBrowser ??= BROWSER_FILE.test(text)) === true && !request.root) {
        const path = pathOf(node);
        if (path !== null) (marksOf(sym).paths ??= []).push(path);
        return false;
      }
      const path = pathOf(node);
      if (request.root) (marksOf(sym).maybe ??= []).push({ root: request.root, path });
      else if (path !== null) (marksOf(sym).paths ??= []).push(path);
      else marksOf(sym).unresolved = true;
      return false;
    },
    link(view) {
      const fetchers = new PathIndex<Node>();
      const unresolved = new Set<Sym>();
      for (const node of view.nodes()) {
        const marks = node.sym.marks.fetch as Marks | undefined;
        if (!marks) continue;
        for (const path of marks.paths ?? []) fetchers.add(path, node);
        if (marks.unresolved) unresolved.add(node.sym);
        for (const { root, path } of marks.maybe ?? []) {
          // Whether it's a client is in the file it comes from.
          const fact = view.facts(node.file)?.imports.find((i) => i.local === root);
          const source = fact ? view.resolve(node.file, fact.spec) : null;
          if (source) view.read(source);
          const binding = view.bindingOf(node.file, root);
          const facts = binding ? view.facts(binding.file) : undefined;
          if (!binding || !facts || !clientsOf(facts).has(binding.name)) continue;
          if (path !== null) fetchers.add(path, node);
          else if (view.facts(node.file)?.data.fetchBrowser !== true) unresolved.add(node.sym);
        }
      }
      return {
        doubt: (node) => (unresolved.has(node.sym) ? "unresolved_request" : null),
        dependents: (node, surfaces) => surfaces.flatMap((surface) => fetchers.meeting(surface).filter((other) => other.sym !== node.sym)),
        wanted(_reached, surfaces) {
          const files = new Set<string>();
          for (const surface of surfaces) for (const file of holders.meeting(surface)) files.add(file);
          return { files: [...files] };
        },
      };
    },
  };
};
