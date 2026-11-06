/** A fetch of the application's own path: the caller depends on the route, which imports don't show. */
import ts from "typescript";
import type { ConventionFactory, Node } from "../convention";
import { surfaceMeetsPath } from "../match";

const FETCH = /\b(?:fetch|\$fetch|axios\.\w+|ky\.\w+)\(\s*(?:new\s+URL\(\s*)?(["'`])([^"'`\n]*)\1/g;

/**
 * A fetched address as a footprint would read it: no host, no query, and `${id}` as a
 * folded segment. A server fetching its own absolute URL is the same route, whatever the
 * host: another's only matches by coincidence, which widens. Null with no path to read.
 */
function fetchedPath(literal: string): string | null {
  const address = literal.replace(/^(?:https?:)?\/\/[^/]*/, "").replace(/^\$\{[^}]*\}(?=\/)/, "");
  if (!address.startsWith("/")) return null;
  const path = address.split(/[?#]/)[0]!.replace(/\$\{[^}]*\}/g, ":id");
  return path.length > 1 ? path.replace(/\/+$/, "") : path;
}

/** The address in a call's first argument, however it's written. */
function addressOf(node: ts.Expression | undefined): string | null {
  if (!node) return null;
  if (ts.isStringLiteralLike(node)) return node.text;
  if (ts.isTemplateExpression(node)) return node.head.text + node.templateSpans.map((span) => `\${x}${span.literal.text}`).join("");
  if (ts.isNewExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === "URL") return addressOf(node.arguments?.[0]);
  return null;
}

function isFetchCallee(callee: ts.Expression): boolean {
  if (ts.isIdentifier(callee)) return callee.text === "fetch" || callee.text === "$fetch";
  return ts.isPropertyAccessExpression(callee) && ts.isIdentifier(callee.expression) && (callee.expression.text === "axios" || callee.expression.text === "ky");
}

/**
 * Whether this fetch is of this route. It must meet it, and share a word with it: a URL
 * of placeholders where the route has words is another API's, and would tie every route
 * to it. Fetching a wholly computed path is a known limit: nothing can bound it.
 */
function bridges(surface: string, path: string): boolean {
  if (!surfaceMeetsPath(surface, path)) return false;
  const want = surface.split("/").filter(Boolean);
  const have = path.split("/").filter(Boolean);
  if (want.length === 0 && have.length === 0) return true;
  return want.some((segment, i) => !/^(?::|\*)/.test(segment) && have[i] !== undefined && !have[i]!.startsWith(":") && segment.toLowerCase() === have[i]!.toLowerCase());
}

export const fetchCalls: ConventionFactory = () => {
  const holders = new Map<string, Set<string>>();
  return {
    scanText(file, text) {
      for (const match of text.matchAll(FETCH)) {
        const path = fetchedPath(match[2]!);
        if (path === null) continue;
        const files = holders.get(path);
        if (files) files.add(file);
        else holders.set(path, new Set([file]));
      }
    },
    readNode(node, sym) {
      if (!ts.isCallExpression(node) || !isFetchCallee(node.expression)) return false;
      const address = addressOf(node.arguments[0]);
      const path = address === null ? null : fetchedPath(address);
      if (path !== null) ((sym.marks.fetch ??= []) as string[]).push(path);
      return false;
    },
    link(view) {
      const fetchers: Array<{ path: string; node: Node }> = [];
      for (const node of view.nodes()) for (const path of (node.sym.marks.fetch as string[] | undefined) ?? []) fetchers.push({ path, node });
      return {
        dependents: (node, surfaces) => surfaces.flatMap((surface) => fetchers.filter((f) => f.node.sym !== node.sym && bridges(surface, f.path)).map((f) => f.node)),
        wanted(_reached, surfaces) {
          const files: string[] = [];
          for (const surface of surfaces) {
            for (const [path, holding] of holders) if (bridges(surface, path)) files.push(...holding);
          }
          return { files };
        },
      };
    },
  };
};
