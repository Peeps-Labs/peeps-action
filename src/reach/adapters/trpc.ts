/** tRPC conventions: a router is a call with an object of procedures, served by one of the adapters' handlers. */
import ts from "typescript";
import type { ConventionFactory, Linked, Node, ReadContext } from "../convention";
import type { FileFacts, Sym } from "../graph";
import { bindingNames, keyName, staticChain } from "../syntax";

const ROUTER_CALLEE = new Set(["createTRPCRouter", "router"]);
const HANDLER_CALLEE = new Set(["fetchRequestHandler", "createNextApiHandler", "createExpressMiddleware", "createHTTPHandler", "createHTTPServer"]);
const CALLER = new Set(["createCaller", "createCallerFactory"]);

const calleeName = (callee: ts.Expression): string | null =>
  ts.isIdentifier(callee) ? callee.text : ts.isPropertyAccessExpression(callee) ? callee.name.text : null;

export function isRouterCall(node: ts.Node | undefined): node is ts.CallExpression {
  return (
    node !== undefined &&
    ts.isCallExpression(node) &&
    ROUTER_CALLEE.has(calleeName(node.expression) ?? "") &&
    node.arguments[0] !== undefined &&
    ts.isObjectLiteralExpression(node.arguments[0])
  );
}

export function isHandlerCall(node: ts.CallExpression): boolean {
  return HANDLER_CALLEE.has(calleeName(node.expression) ?? "");
}

export function isCallerName(name: string): boolean {
  return CALLER.has(name);
}

/** What a handler's options say: which router, and at what endpoint when it says. */
export function handlerOptions(call: ts.CallExpression): { routerRef: string | null; endpoint: string | null } {
  const options = call.arguments[0];
  let routerRef: string | null = null;
  let endpoint: string | null = null;
  if (!options || !ts.isObjectLiteralExpression(options)) return { routerRef, endpoint };
  for (const property of options.properties) {
    if (ts.isShorthandPropertyAssignment(property) && property.name.text === "router") routerRef = "router";
    if (!ts.isPropertyAssignment(property) || !ts.isIdentifier(property.name)) continue;
    if (property.name.text === "router" && ts.isIdentifier(property.initializer)) routerRef = property.initializer.text;
    if (property.name.text === "endpoint" && ts.isStringLiteralLike(property.initializer)) endpoint = property.initializer.text;
  }
  return { routerRef, endpoint };
}

function buildsCaller(node: ts.Node | undefined, callers: ReadonlySet<string>): boolean {
  if (!node) return false;
  if (ts.isIdentifier(node) && (isCallerName(node.text) || callers.has(node.text))) return true;
  return ts.forEachChild(node, (child) => buildsCaller(child, callers)) === true;
}

interface RouterFact {
  name: string;
  /** Each property's name and the binding it holds, when that may be another router. */
  nested: Array<{ prop: string; ref: string }>;
}

interface FileData {
  /** Whether the file names a caller at all, asked once: this is read at every node. */
  hasCaller?: boolean;
  routers: RouterFact[];
  /** Top-level names holding a caller. */
  callers: Set<string>;
}

interface Marks {
  procedure?: { router: string; path: string[] };
  handler?: { routerRef: string | null; endpoint: string | null };
  /** Locals holding a caller. */
  callers?: Set<string>;
}

const dataOf = (facts: FileFacts): FileData => (facts.data.trpc ??= { routers: [], callers: new Set() }) as FileData;
const namesCaller = ({ facts, text }: ReadContext): boolean => (dataOf(facts).hasCaller ??= text.includes("createCaller"));
const marksOf = (sym: Sym): Marks => (sym.marks.trpc ??= {}) as Marks;

/** The properties of a router: each procedure its own symbol, so a hunk in one is that one alone. */
function readRouter(name: string, object: ts.ObjectLiteralExpression, path: string[], routerSym: Sym, context: ReadContext) {
  const data = dataOf(context.facts);
  let router = data.routers.find((r) => r.name === name);
  if (!router) {
    router = { name, nested: [] };
    data.routers.push(router);
  }
  for (const property of object.properties) {
    if (ts.isSpreadAssignment(property)) {
      context.collect(property.expression, routerSym);
      continue;
    }
    const prop = keyName(property.name);
    if (prop === null) {
      context.collect(property, routerSym);
      continue;
    }
    const ref = ts.isShorthandPropertyAssignment(property) ? property.name.text : ts.isPropertyAssignment(property) && ts.isIdentifier(property.initializer) ? property.initializer.text : null;
    if (ref) {
      if (path.length === 0) router.nested.push({ prop, ref });
      routerSym.refs.add(ref);
      continue;
    }
    if (ts.isPropertyAssignment(property) && isRouterCall(property.initializer)) {
      readRouter(name, property.initializer.arguments[0] as ts.ObjectLiteralExpression, [...path, prop], routerSym, context);
      continue;
    }
    const procedure = context.newSym(property, []);
    marksOf(procedure).procedure = { router: name, path: [...path, prop] };
    context.collect(property, procedure);
    context.add(procedure);
  }
}

const PROCEDURE_LINE = /^\s*["']?([\w$]+)["']?\s*:\s*.*(?:rocedure|outer)\b/;

export const trpc: ConventionFactory = () => ({
  removesRoute(removed, added) {
    const kept = new Set(added.map((line) => PROCEDURE_LINE.exec(line)?.[1]));
    return removed.some((line) => {
      const name = PROCEDURE_LINE.exec(line)?.[1];
      return name !== undefined && !kept.has(name);
    });
  },
  readBinding(name, init, sym, context) {
    if (namesCaller(context) && buildsCaller(init, dataOf(context.facts).callers)) dataOf(context.facts).callers.add(name);
    if (!isRouterCall(init)) return false;
    readRouter(name, init.arguments[0] as ts.ObjectLiteralExpression, [], sym, context);
    context.collect(init.expression, sym);
    return true;
  },
  readNode(node, sym, context) {
    if (ts.isCallExpression(node) && isHandlerCall(node)) marksOf(sym).handler = handlerOptions(node);
    if (!namesCaller(context)) return false;
    if (ts.isVariableDeclaration(node) && buildsCaller(node.initializer, marksOf(sym).callers ?? new Set())) {
      const callers = (marksOf(sym).callers ??= new Set());
      for (const name of bindingNames(node.name)) callers.add(name);
    }
    // createCaller(ctx).runs.list()
    if (ts.isPropertyAccessExpression(node) && !staticChain(node)) {
      const props: string[] = [];
      let base: ts.Expression = node;
      while (ts.isPropertyAccessExpression(base)) {
        props.unshift(base.name.text);
        base = base.expression;
      }
      if (ts.isCallExpression(base) && buildsCaller(base.expression, new Set())) sym.chains.push(["<caller>", ...props]);
    }
    return false;
  },
  link(view): Linked {
    const handlers: Array<{ file: string; router: string; prefix: string | null }> = [];
    const parents = new Map<string, Array<{ file: string; router: string; prop: string }>>();
    const nodes = [...view.nodes()];
    for (const { file, sym } of nodes) {
      const handler = (sym.marks.trpc as Marks | undefined)?.handler;
      if (!handler?.routerRef) continue;
      const router = view.bindingOf(file, handler.routerRef);
      if (router) {
        // With no endpoint the file's own route says it; with neither, nothing does.
        const surface = view.fileSurface(file);
        const prefix = handler.endpoint ?? (surface ? surface.replace(/\/(?::[^/]+|\*|\*\*)$/, "") : null);
        handlers.push({ file: router.file, router: router.name, prefix });
      }
    }
    const seenFiles = new Set(nodes.map((node) => node.file));
    for (const file of seenFiles) {
      for (const router of (view.facts(file)?.data.trpc as FileData | undefined)?.routers ?? []) {
        for (const { prop, ref } of router.nested) {
          const child = view.bindingOf(file, ref);
          if (!child) continue;
          const key = `${child.file}\0${child.name}`;
          parents.set(key, [...(parents.get(key) ?? []), { file, router: router.name, prop }]);
        }
      }
    }
    /** Where a router is served: each way down from a handler to it. */
    const ways = (file: string, router: string, seen = new Set<string>()): Array<{ prefix: string | null; chain: string[] }> => {
      const key = `${file}\0${router}`;
      if (seen.has(key)) return [];
      seen.add(key);
      const out: Array<{ prefix: string | null; chain: string[] }> = [];
      for (const handler of handlers) if (handler.file === file && handler.router === router) out.push({ prefix: handler.prefix, chain: [] });
      for (const parent of parents.get(key) ?? []) {
        for (const up of ways(parent.file, parent.router, new Set(seen))) out.push({ prefix: up.prefix, chain: [...up.chain, parent.prop] });
      }
      return out;
    };
    const waysOf = new Map<Sym, ReturnType<typeof ways>>();
    const byPath = new Map<string, Node[]>();
    for (const node of nodes) {
      const procedure = (node.sym.marks.trpc as Marks | undefined)?.procedure;
      if (!procedure) continue;
      const found = ways(node.file, procedure.router);
      waysOf.set(node.sym, found);
      for (const way of found) {
        const dotted = [...way.chain, ...procedure.path].join(".");
        byPath.set(dotted, [...(byPath.get(dotted) ?? []), node]);
      }
    }
    /** Whether a chain's root is a caller: a local, a top-level name, or an import of one. */
    const holdsCaller = ({ file, sym }: Node, root: string): boolean => {
      if (root === "<caller>" || (sym.marks.trpc as Marks | undefined)?.callers?.has(root)) return true;
      const binding = view.bindingOf(file, root);
      if (!binding) return false;
      const data = view.facts(binding.file)?.data.trpc as FileData | undefined;
      return data?.callers.has(binding.name) ?? false;
    };
    for (const node of nodes) {
      for (const chain of node.sym.chains) {
        if (chain.length < 2 || !holdsCaller(node, chain[0]!)) continue;
        for (let n = 2; n <= chain.length; n++) {
          for (const procedure of byPath.get(chain.slice(1, n).join(".")) ?? []) view.addEdge(procedure.sym, node);
        }
      }
    }
    return {
      surfacesOf({ sym }) {
        const procedure = (sym.marks.trpc as Marks | undefined)?.procedure;
        if (!procedure) return { surfaces: [], unknown: false };
        const found = waysOf.get(sym) ?? [];
        return {
          surfaces: found.filter((way) => way.prefix !== null).map((way) => `${way.prefix}/${[...way.chain, ...procedure.path].join(".")}`),
          unknown: found.some((way) => way.prefix === null),
        };
      },
    };
  },
});
