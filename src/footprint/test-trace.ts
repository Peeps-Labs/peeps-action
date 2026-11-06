/**
 * Whether a test may set its own trace with `test.use`, which the reporter can't see. A
 * policy it can't read it can't honour, and deleting a customer's trace is the wrong way
 * to fail, so such a run records nothing for Peeps: its tests read unknown, and always
 * run. Read through what specs import, from the text; any doubt answers yes.
 */
import { referencedFiles, Resolver, stripComments } from "../reach/text-graph";

const SETS_TRACE = /\btrace\b\s*[:,}]/;

export function testsMaySetTrace(specs: string[], files: string[], read: (file: string) => string): boolean {
  const resolver = new Resolver(new Set(files), read);
  const seen = new Set(specs);
  const queue = [...specs];
  while (queue.length > 0) {
    const file = queue.pop()!;
    if (!/\.[cm]?[jt]sx?$/.test(file)) continue;
    let text: string;
    try {
      text = stripComments(read(file));
    } catch {
      return true;
    }
    if (SETS_TRACE.test(text)) return true;
    for (const next of referencedFiles(file, text, resolver)) {
      if (!seen.has(next)) {
        seen.add(next);
        queue.push(next);
      }
    }
  }
  return false;
}
