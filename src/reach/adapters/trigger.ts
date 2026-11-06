/** Trigger.dev: a task is dispatched by its id, which imports don't show. Whoever quotes the id depends on the task. */
import ts from "typescript";
import type { ConventionFactory, Node } from "../convention";
import { keyName, staticChain } from "../syntax";

interface Mark {
  id: string | null;
  idRef: string | null;
}

function readTask(init: ts.Expression | undefined): Mark | null {
  if (!init || !ts.isCallExpression(init)) return null;
  const name = staticChain(init.expression)?.join(".");
  if (name !== "task" && name !== "schemaTask" && name !== "schedules.task") return null;
  const options = init.arguments[0];
  if (!options || !ts.isObjectLiteralExpression(options)) return { id: null, idRef: null };
  for (const property of options.properties) {
    if (!ts.isPropertyAssignment(property) || keyName(property.name) !== "id") continue;
    if (ts.isStringLiteralLike(property.initializer)) return { id: property.initializer.text, idRef: null };
    if (ts.isIdentifier(property.initializer)) return { id: null, idRef: property.initializer.text };
  }
  return { id: null, idRef: null };
}

export const trigger: ConventionFactory = () => ({
  readBinding(_name, init, sym) {
    const task = readTask(init);
    if (task) sym.marks.trigger = task;
    return false;
  },
  link(view) {
    const ids = new Map<unknown, string>();
    const holders = new Map<string, Node[]>();
    const nodes = [...view.nodes()];
    for (const node of nodes) {
      const task = node.sym.marks.trigger as Mark | undefined;
      if (!task) continue;
      const id = task.id ?? (task.idRef ? view.constant(node.file, task.idRef) : null);
      if (id) ids.set(node.sym, id);
    }
    if (ids.size > 0) {
      const wanted = new Set(ids.values());
      for (const node of nodes) {
        for (const literal of node.sym.literals) if (wanted.has(literal)) holders.set(literal, [...(holders.get(literal) ?? []), node]);
      }
    }
    return {
      dependents(node) {
        const id = ids.get(node.sym);
        return id ? (holders.get(id) ?? []) : [];
      },
      wanted(reached) {
        return { literals: reached.flatMap((node) => ids.get(node.sym) ?? []) };
      },
    };
  },
});
