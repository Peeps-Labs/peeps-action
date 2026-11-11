/**
 * Express conventions: `app.get("/cart", handler)`, `router.post(…)`, a router mounted
 * with `app.use("/api", router)`, `app.route("/x").get(…)`. Only top-level statements on
 * a binding made by `express()` or `Router()`. Anything else has no route, and a change
 * reaching it reads global.
 */
import ts from "typescript";
import type { ConventionFactory, Linked, Node, Served } from "../convention";
import type { FileFacts } from "../graph";

const METHODS = new Set(["get", "post", "put", "patch", "delete", "options", "head", "all"]);

export type ExpressBinding = "app" | "router";

function isRequireExpress(node: ts.Node): boolean {
  if (!ts.isCallExpression(node) || !ts.isIdentifier(node.expression) || node.expression.text !== "require") return false;
  const first = node.arguments[0];
  return first !== undefined && ts.isStringLiteralLike(first) && first.text === "express";
}

/** `express()`, `express.Router()`, `Router()`, `require("express")()`, `require("express").Router()`. */
export function expressBinding(init: ts.Node | undefined, isExpress: (name: string) => boolean, isRouterFn: (name: string) => boolean): ExpressBinding | null {
  if (!init || !ts.isCallExpression(init)) return null;
  const callee = init.expression;
  if (ts.isIdentifier(callee)) {
    if (isExpress(callee.text)) return "app";
    if (isRouterFn(callee.text)) return "router";
  }
  if (isRequireExpress(callee)) return "app";
  if (ts.isPropertyAccessExpression(callee) && callee.name.text === "Router") {
    if (ts.isIdentifier(callee.expression) && isExpress(callee.expression.text)) return "router";
    if (isRequireExpress(callee.expression)) return "router";
  }
  return null;
}

export interface RouteCall {
  owner: string;
  /** A literal path, or null when it can't be read. */
  path: string | null;
}

export interface MountCall {
  owner: string;
  path: string | null;
  /** The arguments that may be routers: a binding, or a required file. */
  targets: Array<{ local: string } | { spec: string }>;
}

function literalPath(node: ts.Node | undefined, constant: (name: string) => string | null): string | null {
  if (!node) return null;
  if (ts.isStringLiteralLike(node)) return node.text;
  if (ts.isIdentifier(node)) return constant(node.text);
  return null;
}

const PLAIN_SEGMENT = /^(?:[\w.~%-]+|:[A-Za-z_]\w*)$/;

/**
 * A path this reads: each segment a word or a whole `:param`, with a catch-all only at
 * the end. A regex, an optional `{/:id}`, or `/user-:id` has no matcher here.
 */
export function routePath(path: string | null): string | null {
  if (path === null) return null;
  const segments = path.split("/").filter(Boolean);
  const last = segments[segments.length - 1];
  const catchAll = last !== undefined && /^\*\w*$/.test(last);
  if (!(catchAll ? segments.slice(0, -1) : segments).every((segment) => PLAIN_SEGMENT.test(segment))) return null;
  return path.replace(/\/\*\w*$/, "/*");
}

const ROUTE_LINE = /\.(?:get|post|put|patch|delete|options|head|all|use|route)\(\s*(["'`])([^"'`]*)\1/;

export function readExpressCall(
  statement: ts.ExpressionStatement,
  bindings: Map<string, ExpressBinding>,
  constant: (name: string) => string | null,
): { route?: RouteCall; mount?: MountCall } | null {
  const call = statement.expression;
  if (!ts.isCallExpression(call) || !ts.isPropertyAccessExpression(call.expression)) return null;
  const method = call.expression.name.text;
  const object = call.expression.expression;
  if (ts.isCallExpression(object) && ts.isPropertyAccessExpression(object.expression)) {
    // app.route("/x").get(h).post(h)
    let base: ts.Expression = object;
    while (ts.isCallExpression(base) && ts.isPropertyAccessExpression(base.expression) && base.expression.name.text !== "route") base = base.expression.expression;
    if (ts.isCallExpression(base) && ts.isPropertyAccessExpression(base.expression) && ts.isIdentifier(base.expression.expression) && bindings.has(base.expression.expression.text)) {
      return { route: { owner: base.expression.expression.text, path: routePath(literalPath(base.arguments[0], constant)) } };
    }
    return null;
  }
  if (!ts.isIdentifier(object) || !bindings.has(object.text)) return null;
  if (method === "use") {
    const args = [...call.arguments];
    const single = args.length === 1;
    const path = single ? "/" : literalPath(args[0], constant);
    const targets: MountCall["targets"] = [];
    for (const arg of single ? args : args.slice(1)) {
      if (ts.isIdentifier(arg)) targets.push({ local: arg.text });
      if (ts.isCallExpression(arg) && ts.isIdentifier(arg.expression) && arg.expression.text === "require" && arg.arguments[0] && ts.isStringLiteralLike(arg.arguments[0])) {
        targets.push({ spec: arg.arguments[0].text });
      }
    }
    return { mount: { owner: object.text, path: routePath(path), targets } };
  }
  if (METHODS.has(method) && call.arguments.length >= 2) {
    return { route: { owner: object.text, path: routePath(literalPath(call.arguments[0], constant)) } };
  }
  return null;
}

/** Two paths as one route: `/cart` and `/` is `/cart`. */
export function joinRoute(prefix: string, path: string): string {
  const joined = `${prefix}/${path}`.replace(/\/+/g, "/");
  return joined.length > 1 ? joined.replace(/\/$/, "") : joined;
}

interface Marks {
  route?: RouteCall;
  mount?: MountCall;
}

const bindingsOf = (facts: FileFacts): Map<string, ExpressBinding> => (facts.data.express ??= new Map()) as Map<string, ExpressBinding>;
const marksOf = (node: Node): Marks | undefined => node.sym.marks.express as Marks | undefined;

export const express: ConventionFactory = () => ({
  removesRoute(removed, added) {
    const kept = added.join("\n");
    return removed.some((line) => {
      const match = ROUTE_LINE.exec(line);
      return match !== null && !kept.includes(`${match[1]}${match[2]}${match[1]}`);
    });
  },
  readBinding(name, init, _sym, { facts }) {
    const fromExpress = (local: string, imported: string[]) => facts.imports.some((fact) => fact.local === local && fact.spec === "express" && imported.includes(fact.imported));
    const kind = expressBinding(init, (local) => fromExpress(local, ["default", "*"]), (local) => fromExpress(local, ["Router"]));
    if (kind) bindingsOf(facts).set(name, kind);
    return false;
  },
  readStatement(statement, sym, { facts }) {
    const call = readExpressCall(statement, bindingsOf(facts), (name) => facts.strings.get(name) ?? null);
    if (!call) return false;
    sym.marks.express = call;
    return true;
  },
  link(view): Linked {
    const mounts: Array<{ file: string; owner: string; path: string | null; target: string }> = [];
    for (const node of view.nodes()) {
      const mount = marksOf(node)?.mount;
      if (!mount) continue;
      for (const target of mount.targets) {
        let binding: { file: string; name: string } | null;
        if ("local" in target) binding = view.bindingOf(node.file, target.local);
        else {
          const file = view.resolve(node.file, target.spec);
          binding = file ? view.exportedBinding(file, "default") : null;
        }
        if (binding) mounts.push({ file: node.file, owner: mount.owner, path: mount.path, target: `${binding.file}\0${binding.name}` });
      }
    }
    /** Where a binding is served: `""` for an app, joined mount paths for a router. */
    const prefixes = (file: string, owner: string, seen = new Set<string>()): { paths: string[]; unknown: boolean } => {
      const facts = view.facts(file);
      if (facts && bindingsOf(facts).get(owner) === "app") return { paths: [""], unknown: false };
      const key = `${file}\0${owner}`;
      if (seen.has(key)) return { paths: [], unknown: false };
      seen.add(key);
      const paths: string[] = [];
      let unknown = false;
      for (const mount of mounts) {
        if (mount.target !== key) continue;
        if (mount.path === null) {
          unknown = true;
          continue;
        }
        const up = prefixes(mount.file, mount.owner, new Set(seen));
        unknown ||= up.unknown;
        for (const prefix of up.paths) paths.push(joinRoute(prefix, mount.path));
      }
      return { paths, unknown };
    };
    const served = (file: string, call: { owner: string; path: string | null }, shape: (route: string) => string): Served => {
      if (call.path === null) return { surfaces: [], unknown: true };
      const up = prefixes(file, call.owner);
      return { surfaces: up.paths.map((prefix) => shape(joinRoute(prefix, call.path!))), unknown: up.unknown || up.paths.length === 0 };
    };
    return {
      surfacesOf(node) {
        const marks = marksOf(node);
        if (marks?.route) return served(node.file, marks.route, (route) => route);
        if (marks?.mount) return served(node.file, marks.mount, (route) => `${route}/**`.replace(/\/+/g, "/"));
        return { surfaces: [], unknown: false };
      },
    };
  },
});
