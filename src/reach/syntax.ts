/** Small readings of the TypeScript syntax tree, shared by the symbol pass and the conventions. */
import ts from "typescript";

export const keyName = (name: ts.Node | undefined): string | null => {
  if (!name) return null;
  if (ts.isIdentifier(name) || ts.isStringLiteralLike(name) || ts.isPrivateIdentifier(name)) return name.text;
  return null;
};

/** A static member chain from an identifier, or null. */
export function staticChain(node: ts.Node): string[] | null {
  if (ts.isIdentifier(node)) return [node.text];
  if (ts.isPropertyAccessExpression(node)) {
    const base = staticChain(node.expression);
    return base ? [...base, node.name.text] : null;
  }
  if (ts.isNonNullExpression(node)) return staticChain(node.expression);
  return null;
}

export function bindingNames(name: ts.BindingName, out: string[] = []): string[] {
  if (ts.isIdentifier(name)) out.push(name.text);
  else for (const element of name.elements) if (ts.isBindingElement(element)) bindingNames(element.name, out);
  return out;
}
