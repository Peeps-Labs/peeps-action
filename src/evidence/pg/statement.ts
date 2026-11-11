/**
 * How many auto_explain plans a statement `log_statement=all` logged owes: one per
 * statement in it the executor runs. Transaction, session and schema statements owe
 * none (auto_explain never plans them, and a migration is everything on Peeps' side
 * anyway). A statement that moves rows without a plan (TRUNCATE, COPY, DO, CALL), or
 * one this can't read, owes an unknown number: the log can't prove its tables. Pure.
 */

const PLANNED = new Set(["SELECT", "INSERT", "UPDATE", "DELETE", "MERGE", "WITH", "VALUES", "TABLE", "EXECUTE"]);
const UNPLANNED = new Set([
  // Transaction and session control.
  "BEGIN", "START", "COMMIT", "END", "ROLLBACK", "ABORT", "SAVEPOINT", "RELEASE", "PREPARE", "SET", "RESET", "SHOW",
  "DISCARD", "DEALLOCATE", "LISTEN", "UNLISTEN", "NOTIFY", "CHECKPOINT",
  // Schema.
  "CREATE", "ALTER", "DROP", "GRANT", "REVOKE", "COMMENT",
]);

/** The plans owed, or null when the statement's tables can't be proven from plans. */
export function plansOwed(sql: string): number | null {
  const statements = statementsOf(sql);
  if (statements === null) return null;
  let owed = 0;
  for (const statement of statements) {
    if (statement.trim() === "") continue;
    const verb = /^[\s(]*([A-Za-z]+)/.exec(statement)?.[1]?.toUpperCase();
    if (verb !== undefined && PLANNED.has(verb)) owed += 1;
    else if (verb === undefined || !UNPLANNED.has(verb)) return null;
  }
  return owed;
}

const DOLLAR_TAG = /\$(?:[A-Za-z_][A-Za-z0-9_]*)?\$/y;
const WORD = /[A-Za-z0-9_]/;

/** One simple-protocol message split at its top-level semicolons, comments blanked; null when a quote or comment never closes. */
function statementsOf(sql: string): string[] | null {
  const statements: string[] = [];
  let current = "";
  let i = 0;
  while (i < sql.length) {
    const c = sql[i]!;
    let end = i + 1;
    if (c === ";") {
      statements.push(current);
      current = "";
      i = end;
      continue;
    }
    if (c === "-" && sql[i + 1] === "-") {
      const newline = sql.indexOf("\n", i);
      i = newline < 0 ? sql.length : newline;
      current += " ";
      continue;
    }
    if (c === "/" && sql[i + 1] === "*") {
      let depth = 0;
      for (end = i; end < sql.length; end++) {
        if (sql.startsWith("/*", end)) (depth++, end++);
        else if (sql.startsWith("*/", end) && --depth === 0) break;
      }
      if (end >= sql.length) return null;
      i = end + 2;
      current += " ";
      continue;
    }
    if (c === "'" || c === '"') {
      // E'…' takes backslash escapes; every quote doubles its own quote character.
      const escapes = c === "'" && /[eE]/.test(sql[i - 1] ?? "") && !WORD.test(sql[i - 2] ?? "");
      for (end = i + 1; end < sql.length; end++) {
        if (escapes && sql[end] === "\\") end++;
        else if (sql[end] === c && sql[end + 1] === c) end++;
        else if (sql[end] === c) break;
      }
      if (end >= sql.length) return null;
      end += 1;
    } else if (c === "$" && !WORD.test(sql[i - 1] ?? "")) {
      DOLLAR_TAG.lastIndex = i;
      const tag = DOLLAR_TAG.exec(sql)?.[0];
      if (tag !== undefined) {
        const close = sql.indexOf(tag, i + tag.length);
        if (close < 0) return null;
        end = close + tag.length;
      }
    }
    current += sql.slice(i, end);
    i = end;
  }
  statements.push(current);
  return statements;
}
