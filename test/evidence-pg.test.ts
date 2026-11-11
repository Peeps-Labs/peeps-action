/**
 * The Postgres table collector on a real jsonlog: spike 4's six tests (PQA-3201) logged by
 * `postgres:16-alpine` under the documented flags, plus copies broken the ways a CI log
 * can be. Any doubt reads partial for tables; nothing textual leaves the job.
 *
 * The fixture is one run of `~/.claude/plans/pqa-3201/spikes/spike-4/harness.mjs` (tag mode,
 * pg_stat_statements removed) against `postgres:16-alpine` with trust auth and the flags in
 * `evidence-pg-live.test.ts` (less `log_parameter_max_length=0`), the whole file from initdb on.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { appendFileSync, chmodSync, cpSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { decodePayload, encodePayload } from "../src/evidence/codec";
import { tokenOf } from "../src/evidence/hash";
import { collectTables } from "../src/evidence/pg/collector";
import { readJsonlog } from "../src/evidence/pg/log";
import { tablesOfPlan } from "../src/evidence/pg/plan";
import { plansOwed } from "../src/evidence/pg/statement";
import { footprintsRecording } from "../src/evidence/recording";

const FIXTURE = path.join(__dirname, "fixtures/evidence/pg-jsonlog");
const LOG = readdirSync(FIXTURE).find((name) => name.endsWith(".json"))!;
const KEY = Buffer.alloc(32, 7);

/** Each of spike 4's tests' tables, read from the plans logged under its application name. */
function tablesByApp(text: string) {
  const sets = new Map<string, { reads: Set<string>; writes: Set<string> }>();
  for (const entry of readJsonlog(text)!) {
    if (entry.kind !== "plan") continue;
    const tables = tablesOfPlan(entry.text);
    assert.ok(!("reason" in tables), entry.text.slice(0, 200));
    const set = sets.get(entry.app) ?? { reads: new Set(), writes: new Set() };
    sets.set(entry.app, set);
    tables.reads.forEach((t) => set.reads.add(t));
    tables.writes.forEach((t) => set.writes.add(t));
  }
  return (app: string) => ({ reads: [...(sets.get(app)?.reads ?? [])].sort(), writes: [...(sets.get(app)?.writes ?? [])].sort() });
}

/** A copy of the fixture directory with its log rewritten, entry by entry. */
function brokenCopy(edit: (lines: string[]) => string[]): string {
  const dir = mkdtempSync(path.join(tmpdir(), "peeps-pg-"));
  cpSync(FIXTURE, dir, { recursive: true });
  const file = path.join(dir, LOG);
  const lines = readFileSync(file, "utf8").split("\n").slice(0, -1);
  writeFileSync(file, edit(lines).map((line) => `${line}\n`).join(""));
  return dir;
}
const message = (line: string) => (JSON.parse(line) as { message: string }).message;
const withMessage = (line: string, text: string) => JSON.stringify({ ...(JSON.parse(line) as object), message: text });

test("spike 4's six tests: each one's exact tables, both directions, from its plans", () => {
  const of = tablesByApp(readFileSync(path.join(FIXTURE, LOG), "utf8"));
  assert.deepEqual(of("T1"), { reads: [], writes: ["public.users"] });
  // The transaction, its foreign key checks, and the late job tagged with T2's name.
  assert.deepEqual(of("T2"), { reads: ["public.products", "public.users"], writes: ["public.audit_log", "public.orders", "public.products"] });
  // An empty read, a view (expanded to its tables) and an empty table.
  assert.deepEqual(of("T3"), { reads: ["public.coupons", "public.orders", "public.users"], writes: [] });
  // A plpgsql function: only its nested statements' plans name a table.
  assert.deepEqual(of("T4"), { reads: ["public.products"], writes: ["public.audit_log", "public.products"] });
  assert.deepEqual(of("T5"), { reads: ["public.users"], writes: ["public.users"] });
  // A simple-protocol pair of statements in one message.
  assert.deepEqual(of("T6"), { reads: ["public.coupons"], writes: ["public.coupons"] });
});

test("a foreign key check is a read, from a plan nested under the insert's", () => {
  const entries = readJsonlog(readFileSync(path.join(FIXTURE, LOG), "utf8"))!;
  const checks = entries.filter((e) => e.kind === "plan" && e.app === "T2" && e.text.includes("FOR KEY SHARE"));
  assert.deepEqual(checks.map((e) => tablesOfPlan(e.text)).map((t) => ("reason" in t ? t : { reads: t.reads, writes: t.writes })), [
    { reads: ["public.users"], writes: [] },
    { reads: ["public.products"], writes: [] },
  ]);
});

test("the whole job's log: every table any session touched, ambient, and nothing partial", async () => {
  const tables = await collectTables(FIXTURE);
  assert.deepEqual(tables, {
    keys: [
      // The client's and psql's own catalog reads: a superset is never a miss.
      "table:r:pg_catalog.pg_authid",
      "table:r:pg_catalog.pg_database",
      "table:r:pg_catalog.pg_type",
      "table:r:public.coupons",
      "table:r:public.orders",
      "table:r:public.products",
      "table:r:public.users",
      "table:w:public.audit_log",
      "table:w:public.coupons",
      "table:w:public.orders",
      "table:w:public.products",
      "table:w:public.users",
    ],
    partial: [],
    reasons: [],
  });
});

test("a truncated last line reads partial, never as a log without it", async () => {
  const dir = brokenCopy((lines) => [...lines.slice(0, -1), lines.at(-1)!.slice(0, 40)]);
  // No trailing newline: the writer stopped mid-entry.
  writeFileSync(path.join(dir, LOG), readFileSync(path.join(dir, LOG), "utf8").replace(/\n$/, ""));
  assert.deepEqual(await collectTables(dir), { keys: [], partial: ["table"], reasons: ["pg_log_unreadable"] });
  rmSync(dir, { recursive: true });
});

test("a log with no plan at all reads partial: silence is auto_explain not loaded", async () => {
  const dir = brokenCopy((lines) => lines.filter((line) => !/plan:\n/.test(message(line))));
  assert.deepEqual(await collectTables(dir), { keys: [], partial: ["table"], reasons: ["pg_no_statements"] });
  rmSync(dir, { recursive: true });
  // Only the stderr file, no jsonlog: the same.
  const empty = mkdtempSync(path.join(tmpdir(), "peeps-pg-"));
  cpSync(path.join(FIXTURE, LOG.replace(/\.json$/, ".log")), path.join(empty, "postgresql.log"));
  assert.deepEqual(await collectTables(empty), { keys: [], partial: ["table"], reasons: ["pg_no_statements"] });
  rmSync(empty, { recursive: true });
});

test("plans with no statement logged at all read partial: log_statement off leaves the count check nothing to check", async () => {
  const dir = brokenCopy((lines) => lines.filter((line) => !/^(?:statement|execute [^:\n]*): /.test(message(line))));
  assert.deepEqual(await collectTables(dir), { keys: [], partial: ["table"], reasons: ["pg_statements_not_logged"] });
  rmSync(dir, { recursive: true });
});

test("a statement whose plan is missing reads partial, though its session has more plans than statements", async () => {
  // T5's update ran, and its plan never made the log (a duration threshold above 0). The
  // session's foreign key checks and function body logged more plans than it has statements.
  const dir = brokenCopy((lines) => lines.filter((line) => !(message(line).includes("plan:\n") && message(line).includes('update \\"users\\"'))));
  assert.deepEqual(await collectTables(dir), { keys: [], partial: ["table"], reasons: ["pg_statements_unexplained"] });
  rmSync(dir, { recursive: true });
});

/** An ERROR entry the server logs right after a statement it aborted, in that statement's session. */
const uniqueViolationAfter = (line: string) =>
  JSON.stringify({ ...(JSON.parse(line) as object), error_severity: "ERROR", state_code: "23505", message: 'duplicate key value violates unique constraint "users_email_key"' });
const isUsersUpdate = (line: string) => /^execute [^:\n]*: update "users"/.test(message(line));

test("a statement that errored owes no plan: a unique violation no longer makes the job partial, and it is counted (PQA-3435)", async () => {
  // T5's update hits a unique violation: logged, aborted, so auto_explain logs no plan.
  const dir = brokenCopy((lines) =>
    lines
      .filter((line) => !(message(line).includes("plan:\n") && message(line).includes('update \\"users\\"')))
      .flatMap((line) => (isUsersUpdate(line) ? [line, uniqueViolationAfter(line)] : [line])),
  );
  const out = await collectTables(dir);
  assert.deepEqual([out.partial, out.reasons, out.errored], [[], [], 1]);
  assert.ok(out.keys.includes("table:w:public.orders"), "the job's other tables are still read");
  rmSync(dir, { recursive: true });
});

test("a job made only of errored statements still reads partial: no plan proves anything", async () => {
  const dir = brokenCopy((lines) => lines.filter(isUsersUpdate).flatMap((line) => [line, uniqueViolationAfter(line)]));
  assert.deepEqual(await collectTables(dir), { keys: [], partial: ["table"], reasons: ["pg_no_statements"], errored: 1 });
  rmSync(dir, { recursive: true });
});

test("an ERROR that doesn't follow a statement in its session excuses nothing", async () => {
  // A plan sits between T5's update and the error: the error isn't the update's, so the update still owes its plan.
  const dir = brokenCopy((lines) =>
    lines
      .filter((line) => !(message(line).includes("plan:\n") && message(line).includes('update \\"users\\"')))
      .flatMap((line) => (isUsersUpdate(line) ? [line, withMessage(line, 'duration: 0.010 ms  plan:\n{"Query Text": "select 1", "Plan": {"Node Type": "Result"}}'), uniqueViolationAfter(line)] : [line])),
  );
  assert.deepEqual((await collectTables(dir)).reasons, ["pg_statements_unexplained"]);
  rmSync(dir, { recursive: true });
});

test("a statement that moves rows with no plan (TRUNCATE, COPY, DO, CALL) reads partial, however many plans its session has", async () => {
  const dir = brokenCopy((lines) => {
    const at = lines.findIndex((line) => message(line).startsWith("execute") && message(line).includes("INSERT INTO orders"));
    return [...lines.slice(0, at), withMessage(lines[at]!, "statement: TRUNCATE audit_log"), ...lines.slice(at)];
  });
  assert.deepEqual(await collectTables(dir), { keys: [], partial: ["table"], reasons: ["pg_statements_unexplained"] });
  rmSync(dir, { recursive: true });
});

test("a plan without its relations' schema (log_verbose off) or in text format reads partial", async () => {
  const unqualified = brokenCopy((lines) => lines.map((line) => withMessage(line, message(line).replace(/\n\s*"Schema": "[^"]*",/g, ""))));
  // A plan that can't be read explains no statement either.
  assert.deepEqual(await collectTables(unqualified), { keys: [], partial: ["table"], reasons: ["pg_plans_unqualified", "pg_statements_unexplained"] });
  rmSync(unqualified, { recursive: true });
  const text = brokenCopy((lines) => lines.map((line) => (message(line).includes("plan:\n") ? withMessage(line, "duration: 0.010 ms  plan:\nQuery Text: SELECT 1\nResult  (cost=0.00..0.01 rows=1 width=4)") : line)));
  assert.deepEqual(await collectTables(text), { keys: [], partial: ["table"], reasons: ["pg_log_unreadable", "pg_statements_unexplained"] });
  rmSync(text, { recursive: true });
});

test("a line that isn't a jsonlog entry reads partial", async () => {
  const dir = brokenCopy((lines) => [...lines.slice(0, 3), "2026-11-11 17:14:01.000 UTC [1] LOG:  a stderr line", ...lines.slice(3)]);
  assert.deepEqual(await collectTables(dir), { keys: [], partial: ["table"], reasons: ["pg_log_unreadable"] });
  rmSync(dir, { recursive: true });
  const shapeless = brokenCopy((lines) => [...lines, JSON.stringify({ message: "no session" })]);
  assert.deepEqual(await collectTables(shapeless), { keys: [], partial: ["table"], reasons: ["pg_log_unreadable"] });
  rmSync(shapeless, { recursive: true });
});

/** A late session's two entries, as the logging collector writes them: the statement, then its plan. */
const lateEntries = () => {
  const entry = (message: string) => `${JSON.stringify({ timestamp: "2026-11-11 17:20:00.000 UTC", error_severity: "LOG", session_id: "late.1", application_name: "T7", message })}\n`;
  const plan = { "Query Text": "INSERT INTO late_table(n) VALUES (1)", Plan: { "Node Type": "ModifyTable", "Relation Name": "late_table", Schema: "public", Plans: [{ "Node Type": "Result" }] } };
  return [entry("statement: INSERT INTO late_table(n) VALUES (1)"), entry(`duration: 0.010 ms  plan:\n${JSON.stringify(plan, null, 2)}`)];
};

test("a log still being written when the read starts: the collector waits until it settles, and sees every entry", async () => {
  const dir = brokenCopy((lines) => lines);
  const file = path.join(dir, LOG);
  const [statement, plan] = lateEntries();
  const reading = collectTables(dir);
  // The test ended a moment ago: its statement lands, then its plan.
  setTimeout(() => appendFileSync(file, statement!), 100);
  setTimeout(() => appendFileSync(file, plan!), 400);
  const tables = await reading;
  assert.deepEqual([tables.partial, tables.reasons], [[], []]);
  assert.ok(tables.keys.includes("table:w:public.late_table"), JSON.stringify(tables.keys));
  rmSync(dir, { recursive: true });
});

test("a log that never stops growing within the limit reads partial", async () => {
  const dir = brokenCopy((lines) => lines);
  const file = path.join(dir, LOG);
  const [statement] = lateEntries();
  const writer = setInterval(() => appendFileSync(file, statement!.replace("late.1", `late.${Date.now()}`)), 100);
  try {
    assert.deepEqual(await collectTables(dir, { quietMs: 500, limitMs: 1500, pollMs: 50 }), { keys: [], partial: ["table"], reasons: ["pg_log_unsettled"] });
  } finally {
    clearInterval(writer);
    rmSync(dir, { recursive: true });
  }
});

test("PEEPS_PG_LOG set but unreadable reads partial", async () => {
  assert.deepEqual(await collectTables(path.join(tmpdir(), "peeps-pg-no-such-directory")), { keys: [], partial: ["table"], reasons: ["pg_log_unreadable"] });
  if (process.getuid?.() === 0) return; // root reads a 000 file
  const dir = brokenCopy((lines) => lines);
  chmodSync(path.join(dir, LOG), 0o000);
  assert.deepEqual(await collectTables(dir), { keys: [], partial: ["table"], reasons: ["pg_log_unreadable"] });
  rmSync(dir, { recursive: true, force: true });
});

test("plans owed: one per planned statement, none for transaction, session or schema statements, and unknown for the rest", () => {
  const cases: Array<[string, number | null]> = [
    ["SELECT 1", 1],
    ["  /* a; comment */ -- another;\n select 1", 1],
    ["(SELECT 1) UNION (SELECT 2)", 1],
    ["WITH gone AS (DELETE FROM t RETURNING id) SELECT count(*) FROM gone", 1],
    ["INSERT INTO coupons(code) VALUES ('WELCOME10'); SELECT count(*) FROM coupons", 2],
    ["SELECT 'a;b', \"c;d\", E'e\\';f' ;", 1],
    ["begin ", 0],
    ["commit", 0],
    ["SET application_name = 'T1'", 0],
    ["CREATE FUNCTION f() RETURNS int LANGUAGE plpgsql AS $body$ BEGIN UPDATE t SET n = 1; RETURN 1; END $body$;", 0],
    ["GRANT USAGE ON SCHEMA public TO app; GRANT ALL ON ALL TABLES IN SCHEMA public TO app;", 0],
    ["TRUNCATE audit_log", null],
    ["COPY users FROM STDIN", null],
    ["DO $$ BEGIN DELETE FROM t; END $$", null],
    ["CALL archive()", null],
    ["BEGIN; TRUNCATE t; COMMIT", null],
    ["SELECT 'unterminated", null],
    ["SELECT 1 /* unterminated", null],
  ];
  for (const [sql, owed] of cases) assert.equal(plansOwed(sql), owed, sql);
});

test("privacy: the recording holds no parameter value, query text or table name, only keyed ids", async () => {
  const log = readFileSync(path.join(FIXTURE, LOG), "utf8");
  assert.ok(log.includes("$1 = 'a@x.io'") && log.includes("Query Text"), "the fixture carries both");
  const tables = await collectTables(FIXTURE);
  const blob = footprintsRecording(KEY, { layers: ["database"], measured: ["table"], ambient: tables.keys, members: [{ run: "run-1", attempts: [{ retry: 0, passed: true }], evidence: [] }] });
  const bytes = Buffer.from(encodePayload(blob)).toString("latin1");
  for (const secret of ["a@x.io", "Query", "INSERT", "public", "pg_catalog", "users", "products", "orders", "audit_log", "coupons"]) assert.ok(!bytes.includes(secret), secret);
  // What does leave: the ambient tables as their tokens.
  const decoded = decodePayload(encodePayload(blob));
  assert.ok(decoded.kind === "footprints");
  assert.deepEqual(decoded.universe.ambient, tables.keys.map((k) => tokenOf(KEY, k)).sort());
  assert.ok(decoded.universe.ambient.includes(tokenOf(KEY, "table:w:public.users")));
});
