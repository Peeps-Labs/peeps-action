/**
 * The second pass: from one file's syntax tree, its runtime symbols and what each
 * refers to, by name. The tree is dropped straight after, so the closure of a large
 * repository stays small in memory. Types are nothing here: they don't run.
 */
import ts from "typescript";
import type { Convention, ReadContext } from "./convention";
import { bindingNames, keyName, staticChain } from "./syntax";

export interface Sym {
  /** The top-level names this binds; empty for a statement. */
  names: string[];
  start: number;
  end: number;
  /** A statement that runs when the module loads: nothing says who it affects. */
  effect: boolean;
  /** Names it reads directly. */
  refs: Set<string>;
  /** Member chains it reads, from their root: `["api", "runs", "list"]`. */
  chains: string[][];
  /** Files it names at run time: `import("./x")`, `require("./x")`. */
  dynamic: string[];
  /** Short strings it holds: a file's path, an id something else dispatches by. */
  literals: Set<string>;
  reexport?: { spec: string; imported: string };
  /** What each convention noted about it. */
  marks: Record<string, unknown>;
}

export interface ImportFact {
  local: string;
  spec: string;
  /** `default`, a name, or `*` for the whole module. */
  imported: string;
  start: number;
  end: number;
}

export interface FileFacts {
  file: string;
  symbols: Sym[];
  imports: ImportFact[];
  bareImports: Array<{ spec: string; start: number; end: number }>;
  stars: Array<{ spec: string; start: number; end: number }>;
  /** Export name to the symbol's index. */
  exports: Map<string, number>;
  /** Export name to the binding it holds, for following a router or a caller across files. */
  aliases: Map<string, string>;
  types: Array<[number, number]>;
  /** The lines holding code, for a changed file: comments and blanks don't. Index 0 is line 1. */
  code: boolean[] | null;
  strings: Map<string, string>;
  /** What each convention noted about the file. */
  data: Record<string, unknown>;
}

const MAX_LITERAL = 120;

const hasModifier = (node: ts.Node, kind: ts.SyntaxKind): boolean =>
  ts.canHaveModifiers(node) && (ts.getModifiers(node) ?? []).some((modifier) => modifier.kind === kind);

const isStringy = (node: ts.Node): node is ts.StringLiteralLike => ts.isStringLiteralLike(node);

/** What this symbol reads. Types are nothing here: they don't run. */
function collect(node: ts.Node | undefined, sym: Sym, context: ReadContext, conventions: Convention[]): void {
  if (!node) return;
  if (ts.isTypeNode(node) || ts.isInterfaceDeclaration(node) || ts.isTypeAliasDeclaration(node)) return;
  for (const convention of conventions) if (convention.readNode?.(node, sym, context)) return;
  const walk = (child: ts.Node) => collect(child, sym, context, conventions);
  if (ts.isIdentifier(node)) {
    sym.refs.add(node.text);
    return;
  }
  if (ts.isHeritageClause(node)) {
    if (node.token === ts.SyntaxKind.ExtendsKeyword) for (const type of node.types) walk(type.expression);
    return;
  }
  if (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) {
    const chain = staticChain(node.tagName);
    if (chain && chain.length > 1) sym.chains.push(chain);
    else if (chain && /^[A-Z]/.test(chain[0]!)) sym.refs.add(chain[0]!);
    walk(node.attributes);
    return;
  }
  if (ts.isJsxClosingElement(node)) return;
  if (ts.isJsxAttribute(node)) {
    if (node.initializer) walk(node.initializer);
    return;
  }
  if (ts.isPropertyAccessExpression(node)) {
    const chain = staticChain(node);
    if (chain) {
      sym.chains.push(chain);
      return;
    }
    walk(node.expression);
    return;
  }
  if (ts.isPropertyAssignment(node)) {
    if (ts.isComputedPropertyName(node.name)) walk(node.name);
    walk(node.initializer);
    return;
  }
  if (ts.isMethodDeclaration(node) || ts.isPropertyDeclaration(node) || ts.isGetAccessor(node) || ts.isSetAccessor(node) || ts.isEnumMember(node)) {
    ts.forEachChild(node, (child) => {
      if (child !== node.name || ts.isComputedPropertyName(child)) walk(child);
    });
    return;
  }
  if (ts.isLabeledStatement(node)) {
    walk(node.statement);
    return;
  }
  if (ts.isBreakOrContinueStatement(node)) return;
  if (isStringy(node)) {
    if (node.text.length <= MAX_LITERAL && !/\s/.test(node.text)) sym.literals.add(node.text);
    return;
  }
  if (ts.isCallExpression(node)) {
    const callee = node.expression;
    const first = node.arguments[0];
    const named = callee.kind === ts.SyntaxKind.ImportKeyword || (ts.isIdentifier(callee) && callee.text === "require");
    if (named && first && isStringy(first)) {
      sym.dynamic.push(first.text);
      return;
    }
  }
  ts.forEachChild(node, walk);
}

/** `module.exports`, `exports.a`, `module.exports.a`: the export it assigns. */
function cjsExport(left: ts.Node): string | null {
  const chain = staticChain(left);
  if (!chain) return null;
  if (chain.join(".") === "module.exports") return "default";
  if (chain.length === 2 && chain[0] === "exports") return chain[1]!;
  if (chain.length === 3 && chain[0] === "module" && chain[1] === "exports") return chain[2]!;
  return null;
}

/** The lines any token touches. A comment is trivia, so it touches none. */
function linesOfCode(source: ts.SourceFile): boolean[] {
  const code: boolean[] = new Array(source.getLineStarts().length).fill(false);
  const visit = (node: ts.Node) => {
    if (node.kind >= ts.SyntaxKind.FirstJSDocNode && node.kind <= ts.SyntaxKind.LastJSDocNode) return;
    const children = node.getChildren(source);
    if (children.length > 0) {
      children.forEach(visit);
      return;
    }
    if (node.kind === ts.SyntaxKind.EndOfFileToken || node.getWidth(source) === 0) return;
    const first = source.getLineAndCharacterOfPosition(node.getStart(source)).line;
    const last = source.getLineAndCharacterOfPosition(node.getEnd()).line;
    for (let line = first; line <= last; line++) code[line] = true;
  };
  visit(source);
  return code;
}

export function extractFacts(file: string, text: string, source: ts.SourceFile, conventions: Convention[], options: { code?: boolean } = {}): FileFacts {
  const facts: FileFacts = {
    file,
    symbols: [],
    imports: [],
    bareImports: [],
    stars: [],
    exports: new Map(),
    aliases: new Map(),
    types: [],
    code: options.code ? linesOfCode(source) : null,
    strings: new Map(),
    data: {},
  };
  const lineOf = (position: number) => source.getLineAndCharacterOfPosition(position).line + 1;
  const range = (node: ts.Node) => ({ start: lineOf(node.getStart(source)), end: lineOf(node.getEnd()) });

  const newSym = (node: ts.Node, names: string[], effect = false): Sym => ({
    names,
    ...range(node),
    effect,
    refs: new Set(),
    chains: [],
    dynamic: [],
    literals: new Set(),
    marks: {},
  });
  const add = (sym: Sym) => facts.symbols.push(sym) - 1;
  const typeRange = (node: ts.Node) => {
    const { start, end } = range(node);
    facts.types.push([start, end]);
  };
  const importRange = (statement: ts.Node, local: string, spec: string, imported: string) => facts.imports.push({ local, spec, imported, ...range(statement) });
  const exportAs = (name: string, index: number, alias: string | null) => {
    facts.exports.set(name, index);
    if (alias) facts.aliases.set(name, alias);
  };
  const context: ReadContext = { facts, text, newSym, add, collect: (node, sym) => collect(node, sym, context, conventions) };

  /** One binding's declaration. */
  const declarator = (statement: ts.Node, list: ts.VariableDeclarationList, node: ts.VariableDeclaration, exported: boolean) => {
    const init = node.initializer;
    const names = bindingNames(node.name);
    // const x = require("./x"), const { a, b: c } = require("./x")
    if (init && ts.isCallExpression(init) && ts.isIdentifier(init.expression) && init.expression.text === "require" && init.arguments[0] && isStringy(init.arguments[0])) {
      const spec = init.arguments[0].text;
      if (ts.isIdentifier(node.name)) {
        importRange(statement, node.name.text, spec, "*");
      } else if (ts.isObjectBindingPattern(node.name)) {
        for (const element of node.name.elements) {
          if (!ts.isIdentifier(element.name) || element.dotDotDotToken) {
            for (const name of bindingNames(element.name)) importRange(statement, name, spec, "*");
            continue;
          }
          const imported = element.propertyName ? keyName(element.propertyName) ?? "*" : element.name.text;
          importRange(statement, element.name.text, spec, imported);
        }
      }
      if (!exported) return;
    }
    const sym = newSym(list.declarations.length === 1 ? statement : node, names);
    if (ts.isIdentifier(node.name) && init && isStringy(init)) facts.strings.set(node.name.text, init.text);
    const index = add(sym);
    if (exported) for (const name of names) exportAs(name, index, name);
    let read = false;
    for (const convention of conventions) {
      for (const name of names) read = convention.readBinding?.(name, init, sym, context) === true || read;
    }
    if (read) return;
    collect(init, sym, context, conventions);
    if (!ts.isIdentifier(node.name)) collect(node.name, sym, context, conventions);
    // A destructuring's own names are no reference.
    for (const name of names) sym.refs.delete(name);
  };

  for (const statement of source.statements) {
    const exported = hasModifier(statement, ts.SyntaxKind.ExportKeyword);
    const isDefault = hasModifier(statement, ts.SyntaxKind.DefaultKeyword);
    if (hasModifier(statement, ts.SyntaxKind.DeclareKeyword)) {
      typeRange(statement);
    } else if (ts.isImportDeclaration(statement)) {
      const clause = statement.importClause;
      const spec = (statement.moduleSpecifier as ts.StringLiteral).text;
      if (!clause) {
        facts.bareImports.push({ spec, ...range(statement) });
      } else if (clause.isTypeOnly) {
        typeRange(statement);
      } else {
        let runtime = 0;
        if (clause.name) {
          runtime++;
          importRange(statement, clause.name.text, spec, "default");
        }
        const bindings = clause.namedBindings;
        if (bindings && ts.isNamespaceImport(bindings)) {
          runtime++;
          importRange(statement, bindings.name.text, spec, "*");
        } else if (bindings) {
          for (const element of bindings.elements) {
            if (element.isTypeOnly) continue;
            runtime++;
            const imported = element.propertyName?.text ?? element.name.text;
            importRange(statement, element.name.text, spec, imported);
          }
        }
        if (runtime === 0) typeRange(statement);
      }
    } else if (ts.isImportEqualsDeclaration(statement)) {
      const reference = statement.moduleReference;
      if (statement.isTypeOnly) typeRange(statement);
      else if (ts.isExternalModuleReference(reference) && isStringy(reference.expression)) importRange(statement, statement.name.text, reference.expression.text, "*");
      else add(newSym(statement, [statement.name.text]));
    } else if (ts.isExportDeclaration(statement)) {
      const spec = statement.moduleSpecifier && isStringy(statement.moduleSpecifier) ? statement.moduleSpecifier.text : null;
      const clause = statement.exportClause;
      if (statement.isTypeOnly) {
        typeRange(statement);
      } else if (!clause) {
        if (spec) facts.stars.push({ spec, ...range(statement) });
      } else if (ts.isNamespaceExport(clause)) {
        const sym = newSym(statement, [`export:${clause.name.text}`]);
        if (spec) sym.reexport = { spec, imported: "*" };
        facts.exports.set(clause.name.text, add(sym));
      } else {
        for (const element of clause.elements) {
          if (element.isTypeOnly) continue;
          const name = element.name.text;
          const local = element.propertyName?.text ?? name;
          const sym = newSym(spec ? statement : element, [`export:${name}`]);
          if (spec) sym.reexport = { spec, imported: local };
          else {
            sym.refs.add(local);
            facts.aliases.set(name, local);
          }
          facts.exports.set(name, add(sym));
        }
      }
    } else if (ts.isExportAssignment(statement)) {
      const sym = newSym(statement, [statement.isExportEquals ? "module.exports" : "export:default"]);
      collect(statement.expression, sym, context, conventions);
      exportAs("default", add(sym), ts.isIdentifier(statement.expression) ? statement.expression.text : null);
    } else if (ts.isVariableStatement(statement)) {
      for (const node of statement.declarationList.declarations) declarator(statement, statement.declarationList, node, exported);
    } else if (ts.isFunctionDeclaration(statement) || ts.isClassDeclaration(statement) || ts.isEnumDeclaration(statement) || ts.isModuleDeclaration(statement)) {
      if (ts.isFunctionDeclaration(statement) && !statement.body) {
        typeRange(statement);
        continue;
      }
      const name = statement.name?.text ?? "default";
      const sym = newSym(statement, [name]);
      const index = add(sym);
      ts.forEachChild(statement, (child) => {
        if (child !== statement.name) collect(child, sym, context, conventions);
      });
      if (isDefault) exportAs("default", index, name);
      else if (exported) exportAs(name, index, name);
    } else if (ts.isTypeAliasDeclaration(statement) || ts.isInterfaceDeclaration(statement)) {
      typeRange(statement);
    } else if (ts.isEmptyStatement(statement)) {
      continue;
    } else if (ts.isExpressionStatement(statement)) {
      const expression = statement.expression;
      // A directive: no symbol, so a hunk on it marks the whole file.
      if (isStringy(expression)) continue;
      if (ts.isBinaryExpression(expression) && expression.operatorToken.kind === ts.SyntaxKind.EqualsToken) {
        const name = cjsExport(expression.left);
        if (name) {
          const sym = newSym(statement, [name === "default" ? "module.exports" : `exports.${name}`]);
          collect(expression.right, sym, context, conventions);
          const index = add(sym);
          exportAs(name, index, ts.isIdentifier(expression.right) ? expression.right.text : null);
          if (name === "default" && ts.isObjectLiteralExpression(expression.right)) {
            for (const property of expression.right.properties) {
              const key = ts.isSpreadAssignment(property) ? null : keyName(property.name);
              if (!key) continue;
              const alias = ts.isShorthandPropertyAssignment(property) ? property.name.text : ts.isPropertyAssignment(property) && ts.isIdentifier(property.initializer) ? property.initializer.text : null;
              exportAs(key, index, alias);
            }
          }
          continue;
        }
      }
      const sym = newSym(statement, [], true);
      for (const convention of conventions) if (convention.readStatement?.(statement, sym, context)) sym.effect = false;
      collect(expression, sym, context, conventions);
      add(sym);
    } else {
      const sym = newSym(statement, [], true);
      collect(statement, sym, context, conventions);
      add(sym);
    }
  }
  return facts;
}
