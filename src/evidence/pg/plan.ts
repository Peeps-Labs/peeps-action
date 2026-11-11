/**
 * The tables one auto_explain JSON plan touches, as `schema.relation`: a `ModifyTable`
 * node's target is written, any other node naming a relation reads it, and every nested
 * plan counts. Needs `auto_explain.log_verbose=on`, which is what names the schema. Pure.
 */

export interface PlanTables {
  /** The statement the plan is for: a top-level one's is the text `log_statement` logged. */
  query: string;
  reads: string[];
  writes: string[];
}

type PlanNode = Record<string, unknown>;

const isNode = (value: unknown): value is PlanNode => typeof value === "object" && value !== null && !Array.isArray(value);

/** The plan's tables, or why it can't say. */
export function tablesOfPlan(json: string): PlanTables | { reason: "pg_log_unreadable" | "pg_plans_unqualified" } {
  let parsed: { "Query Text"?: unknown; Plan?: unknown } | null;
  try {
    parsed = JSON.parse(json) as typeof parsed;
  } catch {
    return { reason: "pg_log_unreadable" };
  }
  const query = parsed?.["Query Text"];
  const root = parsed?.Plan;
  if (typeof query !== "string" || !isNode(root)) return { reason: "pg_log_unreadable" };
  const reads = new Set<string>();
  const writes = new Set<string>();
  let unqualified = false;
  let malformed = false;
  const nameOf = (node: PlanNode): string | null => {
    if (typeof node["Relation Name"] !== "string") return null;
    if (typeof node.Schema === "string") return `${node.Schema}.${node["Relation Name"]}`;
    unqualified = true;
    return null;
  };
  const nodesOf = (value: unknown): PlanNode[] => {
    if (value === undefined) return [];
    if (Array.isArray(value) && value.every(isNode)) return value;
    malformed = true;
    return [];
  };
  const walk = (node: PlanNode) => {
    const name = nameOf(node);
    if (node["Node Type"] === "ModifyTable") {
      if (name) writes.add(name);
      // An inherited or partitioned target lists each table it wrote.
      for (const target of nodesOf(node["Target Tables"])) {
        const table = nameOf(target);
        if (table) writes.add(table);
      }
    } else if (name) reads.add(name);
    for (const child of nodesOf(node.Plans)) walk(child);
  };
  walk(root);
  if (malformed) return { reason: "pg_log_unreadable" };
  if (unqualified) return { reason: "pg_plans_unqualified" };
  return { query, reads: [...reads].sort(), writes: [...writes].sort() };
}
