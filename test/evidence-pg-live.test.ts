/**
 * The log format the docs promise, from a real Postgres: `postgres:16-alpine` with the
 * documented flags writing jsonlog into a directory the job reads, spike 4's six tests
 * run through psql, and the collector's tables checked against them. A private container,
 * removed after; skipped only when Docker isn't there. psql's `\bind` gives the
 * `execute <unnamed>:` form; the checked-in fixture covers a driver's named statements.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { chmodSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { collectTables } from "../src/evidence/pg/collector";
import { readJsonlog } from "../src/evidence/pg/log";
import { tablesOfPlan } from "../src/evidence/pg/plan";

/** What the docs tell customers, plus what this test learned they need on a Linux runner. */
const FLAGS = [
  "shared_preload_libraries=auto_explain",
  "auto_explain.log_min_duration=0",
  "auto_explain.log_nested_statements=on",
  "auto_explain.log_format=json",
  "auto_explain.log_verbose=on",
  "log_statement=all",
  "logging_collector=on",
  "log_destination=jsonlog",
  "log_directory=/var/log/postgresql",
  "log_file_mode=0644",
  "log_parameter_max_length=0",
];

const SCHEMA = `
CREATE TABLE users    (id serial PRIMARY KEY, email text UNIQUE NOT NULL, name text);
CREATE TABLE products (id serial PRIMARY KEY, sku text UNIQUE NOT NULL, stock int NOT NULL);
CREATE TABLE orders   (id serial PRIMARY KEY, user_id int REFERENCES users(id), product_id int REFERENCES products(id), status text NOT NULL);
CREATE TABLE audit_log(id serial PRIMARY KEY, event text NOT NULL, at timestamptz DEFAULT now());
CREATE TABLE coupons  (id serial PRIMARY KEY, code text NOT NULL);
CREATE VIEW order_summary AS SELECT o.id, u.email, o.status FROM orders o JOIN users u ON u.id = o.user_id;
CREATE FUNCTION restock(p_sku text, p_n int) RETURNS int LANGUAGE plpgsql AS $$
DECLARE s int;
BEGIN
  UPDATE products SET stock = stock + p_n WHERE sku = p_sku RETURNING stock INTO s;
  INSERT INTO audit_log(event) VALUES ('restock ' || p_sku);
  RETURN s;
END $$;
INSERT INTO products(sku, stock) VALUES ('A', 10), ('B', 5);
`;

/** Spike 4's six tests, each in its own session under its own application name. */
const TESTS: Array<[app: string, sql: string]> = [
  ["T1", "INSERT INTO users(email, name) VALUES ($1, $2) \\bind 'a@x.io' 'Ann' \\g\n"],
  ["T2", "BEGIN;\nSELECT id, stock FROM products WHERE sku = 'A';\nSELECT id FROM users WHERE email = 'a@x.io';\nINSERT INTO orders(user_id, product_id, status) VALUES (1, 1, 'placed');\nUPDATE products SET stock = stock - 1 WHERE id = 1;\nCOMMIT;\n"],
  // The late job, tagged with the test that enqueued it.
  ["worker", "BEGIN;\nSET LOCAL application_name = 'T2';\nINSERT INTO audit_log(event) VALUES ('order placed');\nCOMMIT;\n"],
  ["T3", "SELECT id FROM orders WHERE status = 'refunded';\nSELECT * FROM order_summary WHERE email = 'a@x.io';\nSELECT id FROM coupons WHERE code = 'NOPE';\n"],
  ["T4", "SELECT restock('B', 3);\n"],
  ["T5", "SELECT id, email, name FROM users WHERE email = 'a@x.io';\nUPDATE users SET name = 'Annie' WHERE email = 'a@x.io';\n"],
];

const docker = (args: string[], input?: string, env: string[] = []) => spawnSync("docker", [...args.slice(0, 1), ...env.flatMap((e) => ["-e", e]), ...args.slice(1)], { encoding: "utf8", input, timeout: 120_000 });
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

test("a real Postgres 16 under the documented flags: the collector reads each test's tables, and the whole log proves itself", { timeout: 300_000 }, async (t) => {
  const version = spawnSync("docker", ["version", "--format", "{{.Server.Version}}"], { encoding: "utf8", timeout: 20_000 });
  if (version.status !== 0) return t.skip(`Docker is unavailable: ${(version.stderr || String(version.error)).trim().slice(0, 200)}`);
  const dir = mkdtempSync(path.join(tmpdir(), "peeps-pg-live-"));
  // Postgres writes as its own user in the container; the job reads as the runner.
  chmodSync(dir, 0o777);
  const name = `peeps-action-pg-live-${process.pid}-${randomBytes(4).toString("hex")}`;
  try {
    const started = docker(["run", "-d", "--name", name, "-e", "POSTGRES_HOST_AUTH_METHOD=trust", "-e", "POSTGRES_DB=spike", "-v", `${dir}:/var/log/postgresql`, "postgres:16-alpine", ...FLAGS.flatMap((flag) => ["-c", flag])]);
    assert.equal(started.status, 0, started.stderr);
    // The entrypoint's own temporary server answers too: wait for the real one.
    for (let i = 0; ; i++) {
      const logs = docker(["logs", name]);
      const ready = `${logs.stdout}${logs.stderr}`;
      if (/init process complete/.test(ready) && docker(["exec", name, "pg_isready", "-U", "postgres", "-d", "spike"]).status === 0) break;
      assert.ok(i < 120, `Postgres never came up: ${ready.slice(-500)}`);
      await sleep(500);
    }
    const psql = (app: string, sql: string, extra: string[] = []) => {
      const run = docker(["exec", "-i", name, "psql", "-X", "-q", "-v", "ON_ERROR_STOP=1", "-U", "postgres", "-d", "spike", ...extra], sql, [`PGAPPNAME=${app}`]);
      assert.equal(run.status, 0, `${app}: ${run.stderr}`);
    };
    psql("setup", SCHEMA);
    for (const [app, sql] of TESTS) psql(app, sql);
    // One simple-protocol message holding two statements.
    psql("T6", "", ["-c", "INSERT INTO coupons(code) VALUES ('WELCOME10'); SELECT count(*) FROM coupons"]);
    psql("end", "SELECT 'peeps-live-end';\n");

    // The logging collector writes after the statement returns: wait for the last plan.
    const texts = () => readdirSync(dir).filter((n) => n.endsWith(".json")).sort().map((n) => readFileSync(path.join(dir, n), "utf8"));
    for (let i = 0; !texts().some((text) => readJsonlog(text)?.some((e) => e.app === "end" && e.kind === "plan")); i++) {
      assert.ok(i < 60, "the last plan never reached the log");
      await sleep(250);
    }

    const sets = new Map<string, { reads: Set<string>; writes: Set<string> }>();
    for (const entry of texts().flatMap((text) => readJsonlog(text)!)) {
      if (entry.kind !== "plan") continue;
      const tables = tablesOfPlan(entry.text);
      assert.ok(!("reason" in tables), entry.text.slice(0, 200));
      const set = sets.get(entry.app) ?? { reads: new Set(), writes: new Set() };
      sets.set(entry.app, set);
      tables.reads.forEach((table) => set.reads.add(table));
      tables.writes.forEach((table) => set.writes.add(table));
    }
    const of = (app: string) => ({ reads: [...(sets.get(app)?.reads ?? [])].sort(), writes: [...(sets.get(app)?.writes ?? [])].sort() });
    assert.deepEqual(of("T1"), { reads: [], writes: ["public.users"] });
    assert.deepEqual(of("T2"), { reads: ["public.products", "public.users"], writes: ["public.audit_log", "public.orders", "public.products"] });
    assert.deepEqual(of("T3"), { reads: ["public.coupons", "public.orders", "public.users"], writes: [] });
    assert.deepEqual(of("T4"), { reads: ["public.products"], writes: ["public.audit_log", "public.products"] });
    assert.deepEqual(of("T5"), { reads: ["public.users"], writes: ["public.users"] });
    assert.deepEqual(of("T6"), { reads: ["public.coupons"], writes: ["public.coupons"] });

    const tables = await collectTables(dir);
    assert.deepEqual([tables.partial, tables.reasons], [[], []]);
    for (const key of ["table:r:public.coupons", "table:r:public.orders", "table:r:public.products", "table:r:public.users", "table:w:public.audit_log", "table:w:public.coupons", "table:w:public.orders", "table:w:public.products", "table:w:public.users"])
      assert.ok(tables.keys.includes(key), key);
  } finally {
    spawnSync("docker", ["rm", "-f", name], { timeout: 60_000 });
    rmSync(dir, { recursive: true, force: true });
  }
});
