/** A fetch of the application's own path: the caller depends on the route, which imports don't show. */
import ts from "typescript";
import type { ConventionFactory, Node } from "../convention";
import { surfaceMeetsPath } from "../match";

const FETCH = /\b(?:fetch|\$fetch|axios\.\w+|ky\.\w+)\(\s*(["'`])(\/[^"'`\n]*)\1/g;

/** A fetched path as a footprint would read it: no query, and `${id}` as a folded segment. */
function fetchedPath(literal: string): string {
  const path = literal.split(/[?#]/)[0]!.replace(/\$\{[^}]*\}/g, ":id");
  return path.length > 1 ? path.replace(/\/+$/, "") : path;
}

function isFetchCallee(callee: ts.Expression): boolean {
  if (ts.isIdentifier(callee)) return callee.text === "fetch" || callee.text === "$fetch";
  return ts.isPropertyAccessExpression(callee) && ts.isIdentifier(callee.expression) && (callee.expression.text === "axios" || callee.expression.text === "ky");
}

export const fetchCalls: ConventionFactory = () => {
  const holders = new Map<string, Set<string>>();
  return {
    scanText(file, text) {
      for (const match of text.matchAll(FETCH)) {
        const path = fetchedPath(match[2]!);
        const files = holders.get(path);
        if (files) files.add(file);
        else holders.set(path, new Set([file]));
      }
    },
    readNode(node, sym) {
      if (!ts.isCallExpression(node) || !isFetchCallee(node.expression)) return false;
      const first = node.arguments[0];
      const fetches = (sym.marks.fetch ??= []) as string[];
      if (first && ts.isStringLiteralLike(first) && first.text.startsWith("/")) fetches.push(fetchedPath(first.text));
      if (first && ts.isTemplateExpression(first) && first.head.text.startsWith("/")) {
        fetches.push(fetchedPath(first.head.text + first.templateSpans.map((span) => `\${x}${span.literal.text}`).join("")));
      }
      return false;
    },
    link(view) {
      const fetchers: Array<{ path: string; node: Node }> = [];
      for (const node of view.nodes()) for (const path of (node.sym.marks.fetch as string[] | undefined) ?? []) fetchers.push({ path, node });
      return {
        dependents: (node, surfaces) => surfaces.flatMap((surface) => fetchers.filter((f) => f.node.sym !== node.sym && surfaceMeetsPath(surface, f.path)).map((f) => f.node)),
        wanted(_reached, surfaces) {
          const files: string[] = [];
          for (const surface of surfaces) {
            for (const [path, holding] of holders) if (surfaceMeetsPath(surface, path)) files.push(...holding);
          }
          return { files };
        },
      };
    },
  };
};
