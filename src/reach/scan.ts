/**
 * A pull request's reach: its changed lines, walked backwards through the code to
 * the pages, routes and procedures they can affect. Pure and offline, so a bench can
 * replay it. Text pass first, which answers most changes without a parser; then the
 * closure, one file at a time, its syntax tree dropped straight after. Every doubt is
 * `global`, and everything runs.
 */
import path from "node:path/posix";
import { createConventions } from "./adapters";
import type { Convention } from "./convention";
import { extractFacts, type FileFacts } from "./graph";
import { capReach, MAX_REACH_BYTES } from "./limits";
import { parseSource } from "./parse";
import { buildTextGraph, closure, type TextGraph } from "./text-graph";
import type { FileChange, Hunk, Reach } from "./types";
import { SymbolGraph, type Node } from "./walk";

export const MAX_CHANGED_FILES = 300;
const MAX_TRACKED_FILES = 50_000;
const MAX_FILE_BYTES = 1024 * 1024;
const MAX_SURFACES = 2000;
const DEFAULT_DEADLINE_MS = 90_000;

const SOURCE = /\.[cm]?[jt]sx?$/;
const UNIT_TEST = /(?:\.(?:test|spec)\.[cm]?[jt]sx?$|(?:^|\/)__tests__\/)/;
const DOC = /(?:\.md$|^docs\/|^LICENSE)/i;
const PLAYWRIGHT_CONFIG = /^playwright\.config\.[cm]?[jt]s$/;
const LOCKFILE = /^(?:package-lock\.json|npm-shrinkwrap\.json|yarn\.lock|pnpm-lock\.yaml|bun\.lockb?)$/;
const ALWAYS_GLOBAL = /^(?:package\.json|tsconfig(?:\.[^/]*)?\.json|playwright\.config\.[cm]?[jt]s)$/;

export interface ScanInput {
  files: string[];
  read: (file: string) => string;
  changes: FileChange[];
  /** The spec files, repo-relative. */
  specFiles: string[];
  base: string;
  parse?: typeof parseSource;
  now?: () => number;
  deadlineMs?: number;
}

class Global extends Error {
  constructor(
    readonly why: string,
    readonly file: string | null = null,
  ) {
    super(why);
  }
}

export function scan(input: ScanInput): Reach {
  const changedFiles = input.changes.map((change) => change.path);
  const out: Reach = { global: false, why: null, surfaces: [], reasons: [], changedFiles, changedTestFiles: [], base: input.base };
  try {
    bound(input, out);
    if (out.surfaces.length > MAX_SURFACES) throw new Global("too_many_surfaces");
    if (Buffer.byteLength(JSON.stringify(out)) > MAX_REACH_BYTES) throw new Global("too_many_surfaces");
    return out;
  } catch (error) {
    if (!(error instanceof Global)) throw error;
    const first = changedFiles[0];
    const file = error.file ?? first;
    return capReach({ ...out, global: true, why: error.why, surfaces: [], reasons: file ? [{ surface: null, file }] : [] });
  }
}

function isGlobalByNature(file: string, conventions: Convention[]): boolean {
  const base = path.basename(file);
  if (LOCKFILE.test(base) || ALWAYS_GLOBAL.test(base) || file.startsWith(".github/")) return true;
  return conventions.some((convention) => convention.isGlobalFile?.(file));
}

function fileSurface(file: string, conventions: Convention[]): string | null {
  for (const convention of conventions) {
    const surface = convention.fileSurface?.(file);
    if (surface) return surface;
  }
  return null;
}

function workspacePackages(files: string[], read: (file: string) => string, imported: Set<string>): string[] {
  const dirs: string[] = [];
  for (const file of files) {
    if (path.basename(file) !== "package.json" || file === "package.json") continue;
    try {
      const { name } = JSON.parse(read(file)) as { name?: unknown };
      if (typeof name === "string" && imported.has(name)) dirs.push(`${path.dirname(file)}/`);
    } catch {
      // An unreadable package.json names no package.
    }
  }
  return dirs;
}

function bound(input: ScanInput, out: Reach): void {
  const { changes, read, files } = input;
  const now = input.now ?? Date.now;
  const started = now();
  const deadline = input.deadlineMs ?? DEFAULT_DEADLINE_MS;
  const tick = () => {
    if (now() - started > deadline) throw new Global("timeout");
  };
  if (changes.length > MAX_CHANGED_FILES) throw new Global("too_many_files");
  if (files.length > MAX_TRACKED_FILES) throw new Global("too_many_tracked_files");

  const conventions = createConventions({ files, read });
  const looksLikeDoc = (file: string) => DOC.test(file) && !conventions.some((convention) => convention.ownsFile?.(file));
  for (const change of changes) {
    if (looksLikeDoc(change.path)) continue;
    for (const file of [change.path, change.oldPath]) {
      if (file && isGlobalByNature(file, conventions)) throw new Global("global_file", file);
    }
  }

  const graph = buildTextGraph(files, read, tick, (file, text) => {
    for (const convention of conventions) convention.scanText?.(file, text);
  });
  // A document something reads isn't only a document.
  const relevant = changes.filter((change) => !looksLikeDoc(change.path) || graph.reverse.has(change.path));
  if (relevant.length === 0) return;
  if (graph.unread.length > 0) throw new Global("unread_file", graph.unread[0]);
  for (const convention of conventions) {
    const refused = convention.refusal?.();
    if (refused) throw new Global(refused);
  }

  const specs = new Set(input.specFiles);
  // What Playwright's config reaches is the suite's too: a global setup is no spec, and not the app.
  const specClosure = closure(graph.forward, [...specs, ...files.filter((file) => PLAYWRIGHT_CONFIG.test(path.basename(file)))]);
  // A helper only tests reach is theirs alone. Where the tests sit says nothing: Playwright's rootDir can hold the app.
  const onlyTests = new Map<string, boolean>();
  const isOnlyTests = (file: string) => {
    if (!specClosure.has(file)) return false;
    let answer = onlyTests.get(file);
    if (answer === undefined) {
      answer = [...closure(graph.reverse, [file])].every((user) => specClosure.has(user));
      onlyTests.set(file, answer);
    }
    return answer;
  };
  const appFile = (file: string) => !UNIT_TEST.test(file) && !specs.has(file) && !isOnlyTests(file);

  // What's a test's, and what's the application's.
  const applied: FileChange[] = [];
  for (const change of relevant) {
    if (specClosure.has(change.path)) out.changedTestFiles.push(change.path);
    if (appFile(change.path)) applied.push(change);
  }
  if (applied.length === 0) return;

  const surfaces = new Map<string, string>();
  const addSurface = (surface: string, file: string) => {
    if (!surfaces.has(surface)) surfaces.set(surface, file);
  };

  // A file that's gone is only its route: its users changed too, or the build broke.
  const present: FileChange[] = [];
  for (const change of applied) {
    if (change.status === "deleted") {
      const entry = fileSurface(change.path, conventions);
      if (!entry) throw new Global("deleted_file", change.path);
      addSurface(entry, change.path);
      continue;
    }
    if (change.oldPath) {
      const entry = fileSurface(change.oldPath, conventions);
      if (entry) addSurface(entry, change.path);
    }
    present.push(change);
  }
  if (present.length > 0) walkChanges(input, present, graph, conventions, appFile, addSurface, tick);

  out.surfaces = [...surfaces.keys()].sort();
  out.reasons = out.surfaces.map((surface) => ({ surface, file: surfaces.get(surface)! }));
}

function walkChanges(
  input: ScanInput,
  changes: FileChange[],
  graph: TextGraph,
  conventions: Convention[],
  appFile: (file: string) => boolean,
  addSurface: (surface: string, file: string) => void,
  tick: () => void,
) {
  const { read, files } = input;
  const parse = input.parse ?? parseSource;
  const parsedFacts = new Map<string, FileFacts>();
  const packages = workspacePackages(files, read, graph.packages);
  const changedPaths = new Set(changes.map((change) => change.path));

  const checkClosure = (set: Set<string>) => {
    for (const file of set) {
      if (isGlobalByNature(file, conventions)) throw new Global("global_file", changes[0]!.path);
      if (packages.some((dir) => file.startsWith(dir))) throw new Global("workspace_package", changes[0]!.path);
    }
  };

  const wanted = closure(graph.reverse, changes.map((change) => change.path), appFile);
  checkClosure(wanted);

  const parseAll = () => {
    for (const file of wanted) {
      if (parsedFacts.has(file) || !SOURCE.test(file)) continue;
      tick();
      let text: string;
      try {
        text = read(file);
      } catch {
        throw new Global("unparsed_file", file);
      }
      if (Buffer.byteLength(text) > MAX_FILE_BYTES) throw new Global("unparsed_file", file);
      try {
        parsedFacts.set(file, extractFacts(file, text, parse(file, text), conventions, { code: changedPaths.has(file) }));
      } catch (error) {
        if (error instanceof Global) throw error;
        throw new Global("unparsed_file", file);
      }
    }
  };

  const searchedLiterals = new Set<string>();
  // Bridges bring in files imports don't: repeat until nothing new is needed.
  for (;;) {
    parseAll();
    const symbols = new SymbolGraph(parsedFacts, graph.resolver, conventions);
    const answers: Array<{ change: FileChange; walked: ReturnType<SymbolGraph["walk"]>; starts: Node[] }> = [];
    const reached: Node[] = [];
    const surfaces = new Set<string>();
    for (const change of changes) {
      for (const starts of startsOf(change, symbols, parsedFacts)) {
        const walked = symbols.walk(starts);
        if (walked.doubt) throw new Global(walked.doubt, change.path);
        answers.push({ change, walked, starts });
        reached.push(...walked.reached);
        for (const surface of walked.surfaces) surfaces.add(surface);
      }
    }
    const asked = symbols.wanted(reached, surfaces);
    const newLiterals = new Set(asked.literals.filter((literal) => !searchedLiterals.has(literal)));
    for (const literal of newLiterals) searchedLiterals.add(literal);
    const more = new Set([...asked.files.filter((file) => appFile(file) || symbols.neededFiles.has(file)), ...filesHolding(files, read, newLiterals, appFile, tick)]);
    const added = [...more].filter((file) => !wanted.has(file));
    if (added.length > 0) {
      const grown = closure(graph.reverse, added, appFile);
      checkClosure(grown);
      for (const file of grown) wanted.add(file);
      continue;
    }
    for (const { change, walked, starts } of answers) {
      if (walked.surfaces.size === 0 && starts.length > 0) {
        const placed = SOURCE.test(change.path);
        throw new Global(placed ? "no_entry" : "unplaced_file", change.path);
      }
      for (const surface of walked.surfaces) addSurface(surface, change.path);
    }
    return;
  }
}

/** The source files quoting any of these strings. One read of the tree a round, however many strings. */
function filesHolding(files: string[], read: (file: string) => string, literals: Set<string>, appFile: (file: string) => boolean, tick: () => void): string[] {
  if (literals.size === 0) return [];
  const out: string[] = [];
  for (const file of files) {
    if (!SOURCE.test(file) || !appFile(file)) continue;
    tick();
    try {
      for (const match of read(file).matchAll(QUOTED)) {
        if (literals.has(match[2]!)) {
          out.push(file);
          break;
        }
      }
    } catch {
      // Tracked but absent: nothing to read here.
    }
  }
  return out;
}

const QUOTED = /(["'`])([^\s"'`]{1,120})\1/g;
const COMMENT_ONLY = /^\s*(?:\/\/.*|\/\*.*\*\/\s*)?$/;
const COMMENT_BODY = /^\s*(?:\/\*|\*)/;
const TYPE_ONLY_LINE = /^\s*(?:import|export)\s+type\b/;

/**
 * What a change marks, as groups walked apart: each symbol a hunk touches is its own,
 * and must reach an entry itself; a whole file is one group, since it only has to have
 * a user somewhere.
 */
function startsOf(change: FileChange, symbols: SymbolGraph, facts: Map<string, FileFacts>): Node[][] {
  const whole = (file: string): Node[] => {
    const nodes = symbols.nodesOf(file);
    return [...nodes, { file, sym: symbols.wholeFile(file) }];
  };
  const fileFacts = facts.get(change.path);
  if (!fileFacts) return [[{ file: change.path, sym: symbols.wholeFile(change.path) }]];
  if (change.hunks.length === 0 || change.binary) return [whole(change.path)];

  const lines = fileFacts.code ?? [];
  const groups: Node[][] = [];
  const marked = new Set<unknown>();
  const mark = (node: Node) => {
    if (!marked.has(node.sym)) {
      marked.add(node.sym);
      groups.push([node]);
    }
  };
  const inFile = (line: number) => {
    const inner = fileFacts.symbols.filter((sym) => sym.start <= line && line <= sym.end);
    // A procedure inside its router: the innermost is what changed.
    const smallest = inner.reduce<typeof inner>((best, sym) => {
      const size = sym.end - sym.start;
      const bestSize = best.length ? best[0]!.end - best[0]!.start : Infinity;
      return size < bestSize ? [sym] : size === bestSize ? [...best, sym] : best;
    }, []);
    return smallest;
  };
  const markLine = (line: number): boolean => {
    const placed = inFile(line);
    if (placed.length > 0) {
      for (const sym of placed) mark({ file: change.path, sym });
      return true;
    }
    const imports = fileFacts.imports.filter((fact) => fact.start <= line && line <= fact.end);
    if (imports.length > 0) {
      const locals = new Set(imports.map((fact) => fact.local));
      for (const sym of fileFacts.symbols) {
        if ([...sym.refs].some((name) => locals.has(name)) || sym.chains.some((chain) => locals.has(chain[0]!))) mark({ file: change.path, sym });
      }
      return true;
    }
    if (fileFacts.bareImports.some((bare) => bare.start <= line && line <= bare.end) || fileFacts.stars.some((star) => star.start <= line && line <= star.end)) {
      return false;
    }
    return fileFacts.types.some(([start, end]) => start <= line && line <= end);
  };

  let wholeFile = false;
  for (const hunk of change.hunks) {
    if (hunk.newCount > 0) {
      for (let line = hunk.newStart; line < hunk.newStart + hunk.newCount; line++) {
        if (lines[line - 1] && !markLine(line)) wholeFile = true;
      }
    }
    if (removedCode(hunk, hunk.newCount > 0 && !lines.slice(hunk.newStart - 1, hunk.newStart - 1 + hunk.newCount).some(Boolean))) {
      // With nothing added, git says the removal came after this line. With lines added, they're what's marked,
      // unless all of them are comments or blanks, when the code that went is placed by their position too.
      const at = hunk.newStart;
      const addedCode = hunk.newCount > 0 && lines.slice(at - 1, at - 1 + hunk.newCount).some(Boolean);
      if (addedCode) continue;
      const within = fileFacts.symbols.filter((sym) => sym.start <= at && (hunk.newCount > 0 ? at <= sym.end : at < sym.end));
      if (within.length > 0) for (const sym of within) mark({ file: change.path, sym });
      else wholeFile = true;
    }
  }
  if (wholeFile) return [whole(change.path)];
  return groups;
}

/** Whether a hunk took code away. A block comment's inner lines read as comment only beside the comment that replaced them. */
function removedCode(hunk: Hunk, replacedByComment: boolean): boolean {
  return hunk.removed.some((line) => !COMMENT_ONLY.test(line) && !TYPE_ONLY_LINE.test(line) && !(replacedByComment && COMMENT_BODY.test(line)));
}
