/**
 * What specs may do that a trace can't show, read from their syntax, through the symbols
 * they really reach.
 *
 * Recording stays off only when the customer's trace or test is at risk: a test that
 * starts its own tracing would fail ("Tracing has been already started"), and one whose
 * trace setting can't be read could lose a trace it asked for. So every spec must take
 * `test` from `@playwright/test`, or from a local file extending it, and every `.use` and
 * `.extend` on that test must be readable, or nothing is recorded for that run.
 *
 * Requests a test's trace won't hold cost only that spec's footprint: it can't claim to
 * be whole. Those are the ones made from Node, in a `beforeAll`, by a worker fixture, or
 * in a global setup, which hides them from every spec.
 */
import ts from "typescript";
import type { Convention } from "../reach/convention";
import { extractFacts, type FileFacts, type Sym } from "../reach/graph";
import { parseSource } from "../reach/parse";
import { keyName, staticChain } from "../reach/syntax";
import { Resolver } from "../reach/text-graph";

const PLAYWRIGHT = "@playwright/test";
const BROWSER_ARGS = new Set(["evaluate", "evaluateHandle", "evaluateAll", "$eval", "$$eval", "waitForFunction", "addInitScript", "exposeFunction"]);
const REQUEST_GLOBALS = new Set(["fetch", "$fetch"]);
const GLOBAL_ROOTS = new Set(["globalThis", "global"]);
const OUTSIDE_THE_TRACE = new Set(["beforeAll", "afterAll"]);
const REQUEST_MODULES = new Set([
  "http", "https", "http2", "net", "tls", "dgram", "child_process",
  "undici", "node-fetch", "cross-fetch", "isomorphic-fetch", "axios", "got", "ky", "ofetch", "ohmyfetch",
  "superagent", "supertest", "request", "request-promise", "needle", "phin", "wretch",
]);
const BROWSERS = new Set(["chromium", "firefox", "webkit", "request", "_electron", "_android"]);

const moduleName = (spec: string) => (spec.startsWith("node:") ? spec.slice(5) : spec.startsWith("@") ? spec : spec.split("/")[0]!);

/** How a value is made, read only as far as telling whether it's a test. */
type Made =
  | { kind: "name"; name: string }
  | { kind: "member"; root: string; member: string }
  | { kind: "extended"; of: Made }
  | { kind: "merged"; of: Made[] };

function madeOf(node: ts.Expression | undefined): Made | null {
  if (!node) return null;
  if (ts.isIdentifier(node)) return { kind: "name", name: node.text };
  if (ts.isPropertyAccessExpression(node)) {
    const chain = staticChain(node);
    return chain?.length === 2 ? { kind: "member", root: chain[0]!, member: chain[1]! } : null;
  }
  if (!ts.isCallExpression(node)) return null;
  if (ts.isPropertyAccessExpression(node.expression) && node.expression.name.text === "extend") {
    const of = madeOf(node.expression.expression);
    return of ? { kind: "extended", of } : null;
  }
  if (ts.isIdentifier(node.expression) && node.expression.text === "mergeTests") {
    const of = node.arguments.map(madeOf);
    return of.every(Boolean) ? { kind: "merged", of: of as Made[] } : null;
  }
  return null;
}

/** What makes a `.use` or `.extend` unreadable, or null. */
function optionsDoubt(argument: ts.Expression | undefined): string | null {
  if (!argument || !ts.isObjectLiteralExpression(argument)) return "sets options this can't read";
  for (const property of argument.properties) {
    if (ts.isSpreadAssignment(property)) {
      const chain = ts.isElementAccessExpression(property.expression) ? staticChain(property.expression.expression) : staticChain(property.expression);
      if (chain?.[0] !== "devices") return "spreads options this can't read";
      continue;
    }
    const name = keyName(property.name);
    if (name === null) return "computes an option's name";
    if (name === "trace") return "sets its own trace";
  }
  return null;
}

interface Marks {
  /** `.use` and `.extend` calls: on what, and what's wrong with their options. */
  options?: Array<{ on: Made; doubt: string | null }>;
  /** Roots of calls shaped like a test: a title, then a function. */
  testCalls?: string[][];
  tracing?: boolean;
  hidden?: boolean;
  /** Names put on `globalThis`: they run only when something calls them by name. */
  globals?: Map<string, string>;
}

const marksOf = (sym: Sym): Marks => (sym.marks.testSource ??= {}) as Marks;
const madeIn = (facts: FileFacts): Map<string, Made> => (facts.data.testSourceMade ??= new Map<string, Made>()) as Map<string, Made>;

const reading: Convention = {
  readBinding(name, init, _sym, { facts }) {
    const made = madeOf(init);
    if (made) madeIn(facts).set(name, made);
    return false;
  },
  readNode(node, sym, context) {
    if (ts.isPropertyAccessExpression(node) && node.name.text === "tracing") marksOf(sym).tracing = true;
    if (ts.isPropertyAssignment(node) && keyName(node.name) === "scope" && ts.isStringLiteralLike(node.initializer) && node.initializer.text === "worker") marksOf(sym).hidden = true;
    if (!ts.isCallExpression(node)) return false;
    const callee = node.expression;
    if (staticChain(callee)?.join(".") === "Object.assign" && node.arguments[0] && ts.isIdentifier(node.arguments[0]) && node.arguments[0].text === "globalThis" && node.arguments[1] && ts.isObjectLiteralExpression(node.arguments[1])) {
      const globals = (marksOf(sym).globals ??= new Map());
      for (const property of node.arguments[1].properties) {
        if (ts.isShorthandPropertyAssignment(property)) globals.set(property.name.text, property.name.text);
        else if (ts.isPropertyAssignment(property) && ts.isIdentifier(property.initializer)) globals.set(keyName(property.name) ?? "", property.initializer.text);
        else context.collect(property, sym);
      }
      return true;
    }
    const last = node.arguments[node.arguments.length - 1];
    if (ts.isPropertyAccessExpression(callee)) {
      if (BROWSER_ARGS.has(callee.name.text)) {
        // Its callback runs in the browser, where the trace sees it.
        context.collect(callee, sym);
        for (const argument of node.arguments) if (!ts.isArrowFunction(argument) && !ts.isFunctionExpression(argument)) context.collect(argument, sym);
        return true;
      }
      if (callee.name.text === "use" || callee.name.text === "extend") {
        const on = madeOf(callee.expression);
        if (on) (marksOf(sym).options ??= []).push({ on, doubt: optionsDoubt(node.arguments[0]) });
      }
      if (OUTSIDE_THE_TRACE.has(callee.name.text)) marksOf(sym).hidden = true;
    }
    const chain = staticChain(callee);
    if (chain && last && node.arguments.length >= 2 && ts.isStringLiteralLike(node.arguments[0]!) && (ts.isArrowFunction(last) || ts.isFunctionExpression(last))) {
      (marksOf(sym).testCalls ??= []).push(chain);
    }
    return false;
  },
};

export interface TestSources {
  /** Why recording must stay off, with where. Empty when it's safe. */
  reasons: Array<{ file: string; why: string }>;
  /** The specs, as given, whose tests may make requests their trace won't hold. */
  hiddenRequests: string[];
}

export function readTestSources(specs: string[], globalSetups: string[], files: string[], read: (file: string) => string, tick: () => void = () => {}): TestSources {
  const resolver = new Resolver(new Set(files), read);
  const parsed = new Map<string, FileFacts | null>();
  const factsOf = (file: string): FileFacts | null => {
    if (parsed.has(file)) return parsed.get(file)!;
    tick();
    let facts: FileFacts | null = null;
    try {
      const text = read(file);
      facts = extractFacts(file, text, parseSource(file, text), [reading]);
    } catch {
      // Unread or unparsed, which the caller reads as a doubt.
    }
    parsed.set(file, facts);
    return facts;
  };

  const isTest = (file: string, made: Made, seen: Set<string>): boolean => {
    switch (made.kind) {
      case "name":
        return nameIsTest(file, made.name, seen);
      case "extended":
        return isTest(file, made.of, seen);
      case "merged":
        return made.of.length > 0 && made.of.every((one) => isTest(file, one, new Set(seen)));
      case "member": {
        const fact = factsOf(file)?.imports.find((i) => i.local === made.root && i.imported === "*");
        if (!fact) return false;
        if (fact.spec === PLAYWRIGHT) return made.member === "test";
        const target = resolver.resolve(file, fact.spec);
        return target ? exportIsTest(target, made.member, seen) : false;
      }
    }
  };
  const nameIsTest = (file: string, name: string, seen: Set<string>): boolean => {
    const key = `${file}\0${name}`;
    if (seen.has(key)) return false;
    seen.add(key);
    const facts = factsOf(file);
    if (!facts) return false;
    const made = madeIn(facts).get(name);
    if (made) return isTest(file, made, seen);
    const fact = facts.imports.find((i) => i.local === name);
    if (!fact) return false;
    if (fact.spec === PLAYWRIGHT) return fact.imported === "test";
    const target = resolver.resolve(file, fact.spec);
    return target ? exportIsTest(target, fact.imported, seen) : false;
  };
  const exportIsTest = (file: string, exported: string, seen: Set<string>): boolean => {
    const facts = factsOf(file);
    if (!facts) return false;
    const index = facts.exports.get(exported);
    const reexport = index === undefined ? undefined : facts.symbols[index]?.reexport;
    if (reexport) {
      if (reexport.spec === PLAYWRIGHT) return reexport.imported === "test";
      const target = resolver.resolve(file, reexport.spec);
      return target ? exportIsTest(target, reexport.imported, seen) : false;
    }
    const alias = facts.aliases.get(exported);
    if (alias) return nameIsTest(file, alias, seen);
    return facts.stars.some((star) => {
      if (star.spec === PLAYWRIGHT) return exported === "test";
      const target = resolver.resolve(file, star.spec);
      return target ? exportIsTest(target, exported, seen) : false;
    });
  };

  const reasons = new Map<string, { file: string; why: string }>();
  const addReason = (file: string, why: string) => reasons.set(`${file}\0${why}`, { file, why });

  /** Every symbol this reaches from these: the spec's, what they use, and what runs on import. */
  const walk = (roots: string[]): { hidden: boolean; browsers: boolean; sawTest: boolean; unread: boolean } => {
    const out = { hidden: false, browsers: false, sawTest: false, unread: false };
    const seenSyms = new Set<Sym>();
    const seenFiles = new Set<string>();
    const queue: Array<{ file: string; sym: Sym }> = [];
    const installed = new Map<string, { file: string; local: string }>();
    const bareNames = new Set<string>();
    const enter = (file: string) => {
      if (seenFiles.has(file)) return;
      seenFiles.add(file);
      if (!/\.[cm]?[jt]sx?$/.test(file)) return;
      const facts = factsOf(file);
      if (!facts) {
        out.unread = true;
        addReason(file, "can't be read");
        return;
      }
      for (const sym of facts.symbols) {
        if (sym.effect) push(file, sym);
        for (const [name, local] of (sym.marks.testSource as Marks | undefined)?.globals ?? []) installed.set(name, { file, local });
      }
      for (const bare of facts.bareImports) follow(file, bare.spec, "*", null);
    };
    const push = (file: string, sym: Sym) => {
      if (!seenSyms.has(sym)) {
        seenSyms.add(sym);
        queue.push({ file, sym });
      }
    };
    const exportedSyms = (file: string, name: string, seen = new Set<string>()): void => {
      enter(file);
      const facts = factsOf(file);
      if (!facts || seen.has(`${file}\0${name}`)) return;
      seen.add(`${file}\0${name}`);
      if (name === "*") {
        for (const index of new Set(facts.exports.values())) push(file, facts.symbols[index]!);
      } else {
        const index = facts.exports.get(name);
        if (index !== undefined) return push(file, facts.symbols[index]!);
      }
      for (const star of facts.stars) follow(file, star.spec, name, null);
    };
    const follow = (file: string, spec: string, imported: string, member: string | null) => {
      const target = resolver.resolve(file, spec);
      if (target) return exportedSyms(target, imported === "*" && member && factsOf(target)?.exports.has(member) ? member : imported);
      if (spec.startsWith(".")) out.hidden = true;
      else if (REQUEST_MODULES.has(moduleName(spec))) out.hidden = true;
    };
    for (const root of roots) {
      enter(root);
      for (const sym of factsOf(root)?.symbols ?? []) push(root, sym);
    }
    for (;;) {
      if (queue.length === 0) {
        for (const name of bareNames) {
          const global = installed.get(name);
          if (global) for (const other of factsOf(global.file)?.symbols ?? []) if (other.names.includes(global.local)) push(global.file, other);
        }
        bareNames.clear();
        if (queue.length === 0) break;
      }
      tick();
      const { file, sym } = queue.pop()!;
      const facts = factsOf(file)!;
      const marks = sym.marks.testSource as Marks | undefined;
      if (marks?.hidden) out.hidden = true;
      if (marks?.tracing) addReason(file, "starts its own tracing");
      for (const { on, doubt } of marks?.options ?? []) {
        if (doubt && isTest(file, on, new Set())) addReason(file, doubt);
      }
      for (const chain of marks?.testCalls ?? []) {
        const made: Made = chain.length === 1 ? { kind: "name", name: chain[0]! } : { kind: "member", root: chain[0]!, member: chain[1]! };
        if (isTest(file, made, new Set()) || (chain.length > 1 && nameIsTest(file, chain[0]!, new Set()))) {
          out.sawTest = true;
          continue;
        }
        const fact = facts.imports.find((i) => i.local === chain[0]);
        if (fact && fact.spec !== PLAYWRIGHT && !resolver.resolve(file, fact.spec)) addReason(file, `takes its test from ${fact.spec}`);
      }
      const reads = (name: string, member: string | null) => {
        for (const other of facts.symbols) if (other !== sym && other.names.includes(name)) push(file, other);
        const fact = facts.imports.find((i) => i.local === name);
        if (fact) {
          if (fact.spec === PLAYWRIGHT && BROWSERS.has(fact.imported)) out.browsers = true;
          follow(file, fact.spec, fact.imported, member);
        } else if (!facts.symbols.some((other) => other.names.includes(name))) {
          if (REQUEST_GLOBALS.has(name)) out.hidden = true;
          bareNames.add(name);
        }
      };
      for (const name of sym.refs) reads(name, null);
      for (const chain of sym.chains) {
        if (chain.includes("tracing")) addReason(file, "starts its own tracing");
        if (GLOBAL_ROOTS.has(chain[0]!) && REQUEST_GLOBALS.has(chain[1] ?? "")) out.hidden = true;
        reads(chain[0]!, chain[1] ?? null);
      }
      for (const spec of sym.dynamic) follow(file, spec, "*", null);
      if (sym.reexport) follow(file, sym.reexport.spec, sym.reexport.imported, null);
    }
    return out;
  };

  const setupHides = globalSetups.some((setup) => {
    const found = walk([setup]);
    return found.hidden || found.browsers || found.unread;
  });
  const hiddenRequests: string[] = [];
  for (const spec of specs) {
    const found = walk([spec]);
    if (!found.sawTest && !found.unread) addReason(spec, "takes its test from somewhere this can't read");
    // A standalone request context is outside the test's trace; a page from the fixture isn't.
    if (setupHides || found.hidden || found.browsers || found.unread) hiddenRequests.push(spec);
  }
  return { reasons: [...reasons.values()], hiddenRequests };
}
