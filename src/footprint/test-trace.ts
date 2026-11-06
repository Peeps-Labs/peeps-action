/**
 * What specs may do that a trace can't show, read from their text through what they
 * import; any doubt answers yes.
 *
 * A test may set or start its own trace, which the reporter can't see. Recording over it
 * can fail the test ("Tracing has been already started"), and deleting it is the wrong
 * way to fail, so such a run records nothing for Peeps, and its tests read unknown.
 *
 * A test may make requests its trace doesn't hold: from Node, or in a `beforeAll`. Its
 * footprint can't claim to be whole, so that spec's tests read unknown too.
 */
import { builtinModules } from "node:module";
import { referencedFiles, Resolver, stripComments } from "../reach/text-graph";

const SETS_TRACE = /\btrace\b\s*[:,}]|["'`]trace["'`]\s*[:\]]|\btracing\b/;
const OPTION_CALL = /\.(?:use|extend)\s*(?:<[^(]*>)?\(/g;
const HIDDEN_REQUESTS = /\b(?:beforeAll|afterAll)\b|(?<![.\w$])fetch\s*\(|\baxios\b|\bgot\s*\(|\bhttps?\.(?:get|request)\b|\bsuperagent\b|\bundici\b|["']node-fetch["']|\bky\.\w+\(/;
const IMPORT_CLAUSE = /\bimport\s+(?!type\b)([^;'"`]*?)\s*from\s*["']([^"']+)["']/g;
const IMPORT_BARE = /\bimport\s*["']([^"']+)["']/g;
const REQUIRE_CLAUSE = /\b(?:const|let|var)\s+([^=;]+?)\s*=\s*require\(\s*["']([^"']+)["']\s*\)/g;
const TEST_BINDING = /\b(?:test|base|it)\b/;
const BUILTIN = new Set(builtinModules);

const isPackage = (spec: string) => !spec.startsWith(".") && !spec.startsWith("node:") && !BUILTIN.has(spec) && !BUILTIN.has(spec.split("/")[0]!);

/**
 * Whether a `.use(…)` or `.extend(…)` can't be read: its argument isn't an object
 * written here, or it spreads or computes a key at its own level. A fixture's body may
 * do what it likes.
 */
export function optionsCallInDoubt(text: string): boolean {
  for (const match of text.matchAll(OPTION_CALL)) {
    let at = match.index + match[0].length;
    while (/\s/.test(text[at] ?? "")) at++;
    if (text[at] !== "{") return true;
    let depth = 0;
    for (; at < text.length; at++) {
      const c = text[at]!;
      if (c === '"' || c === "'" || c === "`") {
        let end = at + 1;
        while (end < text.length && text[end] !== c) end += text[end] === "\\" ? 2 : 1;
        at = end;
      } else if (depth === 1 && (c === "[" || text.startsWith("...", at))) {
        return true;
      } else if (c === "{" || c === "(" || c === "[") {
        depth++;
      } else if (c === "}" || c === ")" || c === "]") {
        depth--;
        if (depth === 0) break;
      }
    }
  }
  return false;
}

/** A package that could hand this file its test. A library the test only calls can't reach the option. */
function testFromPackage(text: string): boolean {
  const named = (clause: string, spec: string) =>
    isPackage(spec) && spec !== "@playwright/test" && (TEST_BINDING.test(clause) || /playwright|fixture/i.test(spec));
  for (const match of text.matchAll(IMPORT_CLAUSE)) if (named(match[1]!, match[2]!)) return true;
  for (const match of text.matchAll(REQUIRE_CLAUSE)) if (named(match[1]!, match[2]!)) return true;
  for (const match of text.matchAll(IMPORT_BARE)) if (isPackage(match[1]!)) return true;
  return false;
}

export interface TestSources {
  maySetTrace: boolean;
  /** The specs, as given, whose tests may make requests their trace won't hold. */
  hiddenRequests: string[];
}

export function readTestSources(specs: string[], files: string[], read: (file: string) => string): TestSources {
  const resolver = new Resolver(new Set(files), read);
  const memo = new Map<string, { doubt: boolean; hidden: boolean; edges: Set<string> }>();
  const factsOf = (file: string) => {
    let facts = memo.get(file);
    if (facts) return facts;
    facts = { doubt: false, hidden: false, edges: new Set<string>() };
    memo.set(file, facts);
    if (!/\.[cm]?[jt]sx?$/.test(file)) return facts;
    let text: string;
    try {
      text = stripComments(read(file));
    } catch {
      facts.doubt = true;
      facts.hidden = true;
      return facts;
    }
    let unresolved = false;
    facts.edges = referencedFiles(file, text, resolver, (spec) => {
      if (spec.startsWith(".")) unresolved = true;
    });
    facts.doubt = unresolved || SETS_TRACE.test(text) || optionsCallInDoubt(text) || testFromPackage(text);
    facts.hidden = HIDDEN_REQUESTS.test(text);
    return facts;
  };
  let maySetTrace = false;
  const hiddenRequests: string[] = [];
  for (const spec of specs) {
    const seen = new Set([spec]);
    const queue = [spec];
    let hidden = false;
    while (queue.length > 0) {
      const facts = factsOf(queue.pop()!);
      maySetTrace ||= facts.doubt;
      hidden ||= facts.hidden;
      for (const next of facts.edges) {
        if (!seen.has(next)) {
          seen.add(next);
          queue.push(next);
        }
      }
    }
    if (hidden) hiddenRequests.push(spec);
  }
  return { maySetTrace, hiddenRequests };
}
