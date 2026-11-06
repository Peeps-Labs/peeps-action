/**
 * The symbol graph over the closure, and the walk backwards from a changed symbol to
 * the surfaces it can affect. What a framework means comes from its convention
 * (`convention.ts`); this knows symbols, their users, and what each serves.
 */
import type { Convention, GraphView, Linked, Node, Served } from "./convention";
import type { FileFacts, Sym } from "./graph";
import type { Resolver } from "./text-graph";

export type { Node } from "./convention";

export type Doubt = "module_effect" | "unknown_route" | "global_file" | "global_surface";

export interface Walk {
  surfaces: Set<string>;
  doubt: Doubt | null;
  reached: Node[];
}

export class SymbolGraph {
  private dependents = new Map<Sym, Set<Node>>();
  private surfaceCache = new Map<Sym, Served>();
  private linked: Linked[] = [];
  /** Files a convention needs that aren't parsed yet. */
  neededFiles = new Set<string>();

  constructor(
    private factsByFile: Map<string, FileFacts>,
    private resolver: Resolver,
    private conventions: Convention[],
  ) {
    this.build();
    const view = this.view();
    for (const convention of conventions) {
      const linked = convention.link?.(view);
      if (linked) this.linked.push(linked);
    }
  }

  private view(): GraphView {
    const facts = this.factsByFile;
    return {
      *nodes() {
        for (const [file, fileFacts] of facts) for (const sym of fileFacts.symbols) yield { file, sym };
      },
      facts: (file) => facts.get(file),
      resolve: (from, spec) => this.resolver.resolve(from, spec),
      bindingOf: (file, local) => this.bindingOf(file, local),
      exportedBinding: (file, imported) => this.aliased(file, imported),
      constant: (file, local) => this.constant(file, local),
      addEdge: (from, to) => this.addEdge(from, to),
      fileSurface: (file) => this.fileSurface(file),
    };
  }

  private fileSurface(file: string): string | null {
    for (const convention of this.conventions) {
      const surface = convention.fileSurface?.(file);
      if (surface) return surface;
    }
    return null;
  }

  private addEdge(from: Sym, to: Node) {
    const set = this.dependents.get(from);
    if (set) set.add(to);
    else this.dependents.set(from, new Set([to]));
  }

  /** Every symbol an import of `imported` from `file` reads. */
  private exported(file: string, imported: string, seen = new Set<string>()): Sym[] {
    const key = `${file}\0${imported}`;
    if (seen.has(key)) return [];
    seen.add(key);
    const facts = this.factsByFile.get(file);
    if (!facts) return [];
    const everything = () => {
      const named = [...new Set(facts.exports.values())].map((index) => facts.symbols[index]!);
      for (const star of facts.stars) {
        const target = this.resolver.resolve(file, star.spec);
        if (target) named.push(...this.exported(target, "*", seen));
      }
      return named.length > 0 ? named : facts.symbols;
    };
    if (imported === "*") return everything();
    const index = facts.exports.get(imported);
    if (index !== undefined) return [facts.symbols[index]!];
    const out: Sym[] = [];
    for (const star of facts.stars) {
      const target = this.resolver.resolve(file, star.spec);
      if (target) out.push(...this.exported(target, imported, seen));
    }
    // Interop, or a name nothing here declares: it could be any of them.
    return out.length > 0 ? out : everything();
  }

  /** The binding `imported` holds in `file`, followed through re-exports: for routers and callers. */
  private aliased(file: string, imported: string, depth = 0): { file: string; name: string } | null {
    const facts = this.factsByFile.get(file);
    if (!facts || depth > 8) return null;
    const alias = facts.aliases.get(imported === "*" ? "default" : imported);
    if (alias) return { file, name: alias };
    const index = facts.exports.get(imported);
    const reexport = index === undefined ? undefined : facts.symbols[index]?.reexport;
    if (reexport) {
      const target = this.resolver.resolve(file, reexport.spec);
      return target ? this.aliased(target, reexport.imported, depth + 1) : null;
    }
    for (const star of facts.stars) {
      const target = this.resolver.resolve(file, star.spec);
      const hit = target ? this.aliased(target, imported, depth + 1) : null;
      if (hit) return hit;
    }
    return null;
  }

  /** The binding a local name stands for: its own file's, or what an import brings. */
  private bindingOf(file: string, local: string): { file: string; name: string } | null {
    const facts = this.factsByFile.get(file)!;
    const fact = facts.imports.find((i) => i.local === local);
    if (!fact) return { file, name: local };
    const target = this.resolver.resolve(file, fact.spec);
    return target ? this.aliased(target, fact.imported) : null;
  }

  private build() {
    const localIndex = new Map<string, Map<string, Sym[]>>();
    for (const [file, facts] of this.factsByFile) {
      const names = new Map<string, Sym[]>();
      for (const sym of facts.symbols) {
        for (const name of sym.names) names.set(name, [...(names.get(name) ?? []), sym]);
      }
      localIndex.set(file, names);
    }
    for (const [file, facts] of this.factsByFile) {
      const locals = localIndex.get(file)!;
      const importsByLocal = new Map(facts.imports.map((i) => [i.local, i]));
      // A side-effect import: everything here depends on all of that module.
      for (const bare of facts.bareImports) {
        const target = this.resolver.resolve(file, bare.spec);
        if (!target) continue;
        for (const dep of this.factsByFile.get(target)?.symbols ?? []) for (const sym of facts.symbols) this.addEdge(dep, { file, sym });
        for (const sym of facts.symbols) this.addEdge(this.wholeFile(target), { file, sym });
      }
      for (const sym of facts.symbols) {
        const node: Node = { file, sym };
        for (const name of sym.refs) this.reference(file, node, name, null, locals, importsByLocal);
        for (const chain of sym.chains) this.reference(file, node, chain[0]!, chain[1] ?? null, locals, importsByLocal);
        for (const spec of sym.dynamic) {
          const target = this.resolver.resolve(file, spec);
          if (!target) continue;
          this.addEdge(this.wholeFile(target), node);
          for (const dep of this.exported(target, "*")) this.addEdge(dep, node);
        }
        if (sym.reexport) {
          const target = this.resolver.resolve(file, sym.reexport.spec);
          if (target) for (const dep of this.exported(target, sym.reexport.imported)) this.addEdge(dep, node);
        }
        for (const literal of sym.literals) {
          if (!literal.includes("/")) continue;
          const target = this.resolver.resolveLiteral(file, literal);
          if (target && target !== file) this.addEdge(this.wholeFile(target), node);
        }
      }
    }
  }

  private wholeFiles = new Map<string, Sym>();

  /** A file as one node: what a non-source file's users hang from. */
  wholeFile(file: string): Sym {
    let sym = this.wholeFiles.get(file);
    if (!sym) {
      sym = { names: [], start: 0, end: 0, effect: false, refs: new Set(), chains: [], dynamic: [], literals: new Set(), marks: {} };
      this.wholeFiles.set(file, sym);
    }
    return sym;
  }

  /** The string a local name holds, following an import. A file not yet parsed is asked for. */
  private constant(file: string, local: string): string | null {
    const facts = this.factsByFile.get(file)!;
    const own = facts.strings.get(local);
    if (own !== undefined) return own;
    const fact = facts.imports.find((i) => i.local === local);
    if (!fact) return null;
    const target = this.resolver.resolve(file, fact.spec);
    if (!target) return null;
    if (!this.factsByFile.has(target)) {
      this.neededFiles.add(target);
      return null;
    }
    return this.factsByFile.get(target)!.strings.get(fact.imported) ?? null;
  }

  private reference(
    file: string,
    node: Node,
    name: string,
    member: string | null,
    locals: Map<string, Sym[]>,
    imports: Map<string, { spec: string; imported: string }>,
  ) {
    for (const local of locals.get(name) ?? []) {
      if (local !== node.sym) this.addEdge(local, node);
    }
    const fact = imports.get(name);
    if (!fact) return;
    const target = this.resolver.resolve(file, fact.spec);
    if (!target) return;
    this.addEdge(this.wholeFile(target), node);
    // `ns.a` reads one export of a namespace; a member of anything else reads the export it's on.
    const imported = fact.imported === "*" && member !== null && this.factsByFile.get(target)?.exports.has(member) ? member : fact.imported;
    for (const dep of this.exported(target, imported)) this.addEdge(dep, node);
  }

  /** What a symbol serves. */
  surfacesOf(node: Node): Served {
    const cached = this.surfaceCache.get(node.sym);
    if (cached) return cached;
    const surfaces: string[] = [];
    let unknown = false;
    const own = this.fileSurface(node.file);
    if (own) surfaces.push(own);
    for (const linked of this.linked) {
      const served = linked.surfacesOf?.(node);
      if (!served) continue;
      surfaces.push(...served.surfaces);
      unknown ||= served.unknown;
    }
    const answer = { surfaces, unknown };
    this.surfaceCache.set(node.sym, answer);
    return answer;
  }

  /** Backwards from these symbols, through every user, collecting what they serve. */
  walk(starts: Node[]): Walk {
    const surfaces = new Set<string>();
    let doubt: Doubt | null = null;
    const seen = new Set<Sym>();
    const queue = [...starts];
    const reached: Node[] = [];
    for (const start of starts) seen.add(start.sym);
    while (queue.length > 0) {
      const node = queue.pop()!;
      reached.push(node);
      const served = this.surfacesOf(node);
      if (this.conventions.some((convention) => convention.isGlobalSymbol?.(node.file))) doubt ??= "global_file";
      if (served.unknown) doubt ??= "unknown_route";
      for (const surface of served.surfaces) {
        surfaces.add(surface);
        if (surface === "/**") doubt ??= "global_surface";
      }
      if (node.sym.effect && served.surfaces.length === 0) doubt ??= "module_effect";
      const next = [...(this.dependents.get(node.sym) ?? [])];
      for (const linked of this.linked) next.push(...(linked.dependents?.(node, served.surfaces) ?? []));
      for (const dependent of next) {
        if (!seen.has(dependent.sym)) {
          seen.add(dependent.sym);
          queue.push(dependent);
        }
      }
    }
    return { surfaces, doubt, reached };
  }

  /** What the conventions ask of the tree, given what's been reached. */
  wanted(reached: Node[], surfaces: Iterable<string>): { files: string[]; literals: string[] } {
    const files: string[] = [...this.neededFiles];
    const literals: string[] = [];
    for (const linked of this.linked) {
      const asked = linked.wanted?.(reached, surfaces);
      files.push(...(asked?.files ?? []));
      literals.push(...(asked?.literals ?? []));
    }
    return { files, literals };
  }

  /** The nodes for a file's symbols. */
  nodesOf(file: string): Node[] {
    return (this.factsByFile.get(file)?.symbols ?? []).map((sym) => ({ file, sym }));
  }
}
