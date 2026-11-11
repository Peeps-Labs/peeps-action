/**
 * A Postgres `jsonlog` file (PG15+, `log_destination=jsonlog`) as the entries the table
 * collector reads: each statement `log_statement=all` logged, each plan auto_explain
 * logged, and everything else, with the session and application name each came from.
 * A line that isn't a whole jsonlog entry makes the file unreadable. Pure.
 */

export interface PgEntry {
  session: string;
  /** `application_name` at the time, or "" when the entry has none. */
  app: string;
  /** `error`: an ERROR the server logged, as for a statement it aborted. */
  kind: "statement" | "plan" | "error" | "other";
  /** A statement's SQL, a plan's JSON, or another entry's message. */
  text: string;
}

const STATEMENT = /^(?:statement|execute (?!fetch from )[^:\n]*): /;
const PLAN = /^duration: \d+(?:\.\d+)? ms {2}plan:\n/;

/** Every entry of one file, or null when any line isn't one. */
export function readJsonlog(text: string): PgEntry[] | null {
  const lines = text.split("\n");
  const entries: PgEntry[] = [];
  for (const [index, line] of lines.entries()) {
    // The newline that ends the last entry.
    if (line === "" && index === lines.length - 1) continue;
    const entry = entryOf(line);
    if (entry === null) return null;
    entries.push(entry);
  }
  return entries;
}

function entryOf(line: string): PgEntry | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const { timestamp, error_severity, session_id, message, application_name } = parsed as Record<string, unknown>;
  if (typeof timestamp !== "string" || typeof error_severity !== "string" || typeof session_id !== "string" || typeof message !== "string") return null;
  const app = typeof application_name === "string" ? application_name : "";
  const statement = STATEMENT.exec(message);
  if (statement) return { session: session_id, app, kind: "statement", text: message.slice(statement[0].length) };
  const plan = PLAN.exec(message);
  if (plan) return { session: session_id, app, kind: "plan", text: message.slice(plan[0].length) };
  if (error_severity === "ERROR") return { session: session_id, app, kind: "error", text: message };
  return { session: session_id, app, kind: "other", text: message };
}
