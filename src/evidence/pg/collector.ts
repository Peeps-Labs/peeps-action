/**
 * The table collector: the whole job's Postgres log as `table:r:` / `table:w:` keys,
 * ambient to every test, since nothing here says which test ran a statement. Whole only
 * when the log proves it: every line a jsonlog entry, at least one plan, and in each
 * session at least as many plans for each statement's text as its statements owe.
 * Otherwise partial for tables, with no keys. Plaintext here; `hash.ts` keys it before anything leaves the job.
 */
import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import type { EvidenceKind } from "../port";
import { readJsonlog } from "./log";
import { tablesOfPlan } from "./plan";
import { plansOwed } from "./statement";

export interface TableEvidence {
  keys: string[];
  partial: EvidenceKind[];
  reasons: string[];
}

const partial = (reasons: string[]): TableEvidence => ({ keys: [], partial: ["table"], reasons: [...new Set(reasons)].sort() });

/** How long the log must stay unchanged before it's read, the most to wait for that, and how often to look. */
export interface Settle {
  quietMs: number;
  limitMs: number;
  pollMs: number;
}

const SETTLE: Settle = { quietMs: 500, limitMs: 10_000, pollMs: 100 };

const jsonFiles = async (dir: string) => (await readdir(dir)).filter((n) => n.endsWith(".json")).sort();

/** Every `*.json` file's name, size and modification time: unchanged means nothing more was written. */
async function signature(dir: string): Promise<string> {
  const parts: string[] = [];
  for (const name of await jsonFiles(dir)) {
    const { size, mtimeMs } = await stat(path.join(dir, name));
    parts.push(`${name}\u0000${size}\u0000${mtimeMs}`);
  }
  return parts.join("\n");
}

/** True once the log has been quiet for `quietMs`; false when it is still being written at `limitMs`. */
async function settled(dir: string, { quietMs, limitMs, pollMs }: Settle): Promise<boolean> {
  const started = Date.now();
  let last = await signature(dir);
  let quietSince = started;
  while (Date.now() - quietSince < quietMs) {
    if (Date.now() - started >= limitMs) return false;
    await new Promise((resolve) => setTimeout(resolve, pollMs));
    const now = await signature(dir);
    if (now !== last) {
      last = now;
      quietSince = Date.now();
    }
  }
  return true;
}

/**
 * The `*.json` files of `PEEPS_PG_LOG`'s directory, in name order, once they stop changing:
 * Postgres's logging collector writes after a statement returns, so the job's last
 * entries can land after the tests end, and a log read too early would miss them silently.
 */
export async function collectTables(dir: string, settle: Settle = SETTLE): Promise<TableEvidence> {
  const texts: string[] = [];
  try {
    if (!(await settled(dir, settle))) return partial(["pg_log_unsettled"]);
    for (const name of await jsonFiles(dir)) texts.push(await readFile(path.join(dir, name), "utf8"));
  } catch {
    return partial(["pg_log_unreadable"]);
  }
  return tablesOfLog(texts);
}

/** Pure: the tables of a job's jsonlog files. */
export function tablesOfLog(texts: string[]): TableEvidence {
  /** Per session and statement text: the plans its statements owe, and the plans logged for it. */
  const owing = new Map<string, { owed: number; plans: number }>();
  const count = (session: string, text: string) => {
    const key = JSON.stringify([session, text]);
    const tally = owing.get(key) ?? { owed: 0, plans: 0 };
    owing.set(key, tally);
    return tally;
  };
  const keys = new Set<string>();
  const reasons: string[] = [];
  let plans = 0;
  let statements = 0;
  for (const text of texts) {
    const entries = readJsonlog(text);
    if (entries === null) return partial(["pg_log_unreadable"]);
    for (const entry of entries) {
      if (entry.kind === "other") continue;
      if (entry.kind === "statement") {
        statements += 1;
        const owed = plansOwed(entry.text);
        if (owed === null) reasons.push("pg_statements_unexplained");
        else count(entry.session, entry.text).owed += owed;
        continue;
      }
      plans += 1;
      const tables = tablesOfPlan(entry.text);
      if ("reason" in tables) {
        reasons.push(tables.reason);
        continue;
      }
      count(entry.session, tables.query).plans += 1;
      for (const name of tables.reads) keys.add(`table:r:${name}`);
      for (const name of tables.writes) keys.add(`table:w:${name}`);
    }
  }
  // Silence is indistinguishable from auto_explain not loaded.
  if (plans === 0) return partial(["pg_no_statements"]);
  // Plans with no statement logged: log_statement is off, so no plan's absence could show.
  if (statements === 0) return partial(["pg_statements_not_logged"]);
  // One-sided: a nested plan carries its own text and only adds, so fewer means a statement went unplanned.
  for (const tally of owing.values()) if (tally.plans < tally.owed) reasons.push("pg_statements_unexplained");
  if (reasons.length > 0) return partial(reasons);
  return { keys: [...keys].sort(), partial: [], reasons: [] };
}
