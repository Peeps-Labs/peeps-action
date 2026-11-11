/**
 * The port a framework convention plugs into. Everything a framework means lives behind
 * it, one file per convention (`adapters/`), so the scan and the walk know symbols,
 * files and surfaces, and adding a framework is a new file and a line in `adapters/index.ts`.
 */
import type ts from "typescript";
import type { FileFacts, Sym } from "./graph";

export interface Node {
  file: string;
  sym: Sym;
}

export interface Served {
  surfaces: string[];
  /** It serves something this can't name: the reach is global. */
  unknown: boolean;
}

/** What a convention can do while one file's tree is open. */
export interface ReadContext {
  facts: FileFacts;
  text: string;
  newSym(node: ts.Node, names: string[]): Sym;
  add(sym: Sym): number;
  collect(node: ts.Node | undefined, sym: Sym): void;
}

/** The symbol graph, as a convention sees it when linking files together. */
export interface GraphView {
  nodes(): Iterable<Node>;
  facts(file: string): FileFacts | undefined;
  resolve(from: string, spec: string): string | null;
  /** The binding a local name stands for: its own file's, or what an import brings. */
  bindingOf(file: string, local: string): { file: string; name: string } | null;
  /** The binding an export holds, followed through re-exports. */
  exportedBinding(file: string, imported: string): { file: string; name: string } | null;
  /** The string a local name holds. A file not yet parsed is asked for, and read next round. */
  constant(file: string, local: string): string | null;
  /** Asks for a file's facts next round, without treating it as affected. */
  read(file: string): void;
  /** `to` uses `from`. */
  addEdge(from: Sym, to: Node): void;
  fileSurface(file: string): string | null;
}

export interface Linked {
  /** Reaching this symbol can't be bounded, and why. */
  doubt?(node: Node): string | null;
  /** What this symbol serves, beyond its file. */
  surfacesOf?(node: Node): Served;
  /** Who else depends on this symbol, in ways imports don't show. */
  dependents?(node: Node, surfaces: string[]): Node[];
  /** What the walk has reached asks for more of the tree: files, or strings to find quoted in it. */
  wanted?(reached: Node[], surfaces: Iterable<string>): { files?: string[]; literals?: string[] };
}

export interface Convention {
  /** Sees every source file in the first pass. */
  scanSource?(file: string, source: ts.SourceFile): void;
  /** Why this tree can't be read by its routes, if it can't. */
  refusal?(): string | null;
  /** This file is the framework's to read, whatever it looks like: it isn't a mere document. */
  ownsFile?(file: string): boolean;
  /** A change here, or to anything it imports, can reach everything. */
  isGlobalFile?(file: string): boolean;
  /** Reaching a symbol here can reach everything. */
  isGlobalSymbol?(file: string): boolean;
  /** The surface a file is by its path alone, present or deleted. */
  fileSurface?(file: string): string | null;
  /** What a change took away named a route no surface of the new tree can recover. */
  removesRoute?(removed: string[], added: string[]): boolean;
  /** Any node of a symbol. True when it has read that node whole. */
  readNode?(node: ts.Node, sym: Sym, context: ReadContext): boolean;
  /** A top-level binding. True when it has read the initializer whole. */
  readBinding?(name: string, init: ts.Expression | undefined, sym: Sym, context: ReadContext): boolean;
  /** A top-level expression statement. True when it isn't an effect nobody can place. */
  readStatement?(statement: ts.ExpressionStatement, sym: Sym, context: ReadContext): boolean;
  link?(view: GraphView): Linked;
}

export type ConventionFactory = (tree: { files: string[]; read: (file: string) => string }) => Convention;
