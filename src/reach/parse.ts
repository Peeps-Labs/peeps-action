/**
 * The parser, chosen on a replay of 90 real merges: @babel/parser bundles to 0.64 MB
 * against TypeScript's 3.6 MB, at the same speed, but refuses valid TypeScript (an
 * annotated async arrow in a ternary), and one such file in a repository reads most of
 * its pull requests global. Parent nodes stay off: they cost several times the memory.
 */
import ts from "typescript";

export function scriptKind(file: string): ts.ScriptKind {
  return /\.[cm]?ts$/.test(file) ? ts.ScriptKind.TS : /\.tsx$/.test(file) ? ts.ScriptKind.TSX : ts.ScriptKind.JSX;
}

export function parseSource(file: string, text: string): ts.SourceFile {
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, false, scriptKind(file));
  const { parseDiagnostics } = source as unknown as { parseDiagnostics: unknown[] };
  if (parseDiagnostics.length > 0) throw new Error(`${file} doesn't parse`);
  return source;
}
