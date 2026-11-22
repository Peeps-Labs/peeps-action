/**
 * The load-job-v1 corpus peeps owns (`src/server/load-testing/protocol/__fixtures__/load-job-v1/`),
 * copied byte for byte into `test/fixtures/load-job/v1/` and pinned by the same root hash peeps'
 * `load-job-corpus.test.ts` pins (CW plan §3.4, §6.2). The action's own constants must agree with
 * it: the control origins, the refusal codes and their slots, the copy (unhashed, beside it), the
 * job's Node and the loader variables it blanks.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { LOAD_CONTROL_ORIGINS } from "../src/load/control-origin";
import { LOAD_NODE_VERSION, PRELOAD_VARS, REFUSAL_COPY } from "../src/load/customer";
import { SUPPORTED_TOOLCHAIN } from "../src/load/install";

/** sha256 of `v1/MANIFEST` without its first (status) line; the same constant as peeps' `load-job-corpus.test.ts`. */
const LOAD_JOB_V1_ROOT_HASH = "8edcbb829e7087dcf3c8b13b06d2bf6bdbd1cae275dd955985e8a15648ecd195";

const DIR = path.resolve(__dirname, "fixtures/load-job");
const V1 = path.join(DIR, "v1");
const sha256 = (bytes: Buffer | string) => createHash("sha256").update(bytes).digest("hex");
const read = (file: string) => readFileSync(path.join(V1, file), "utf8");

test("the copy matches peeps' pinned root hash, which leaves out the status line", () => {
  const manifest = read("MANIFEST");
  assert.match(manifest.split("\n")[0]!, /^status: (draft|frozen)$/);
  assert.equal(sha256(manifest.slice(manifest.indexOf("\n") + 1)), LOAD_JOB_V1_ROOT_HASH);
});

test("SOURCE records the peeps commit and the root hash", () => {
  const source = readFileSync(path.join(DIR, "SOURCE"), "utf8");
  assert.match(source, /commit:\s+[0-9a-f]{40}/);
  assert.match(source, new RegExp(LOAD_JOB_V1_ROOT_HASH));
});

test("MANIFEST lists every file with its sha256, and nothing else", () => {
  const listed = read("MANIFEST").trim().split("\n").slice(1).map((line) => line.split(/\s+/) as [string, string]);
  const files = (readdirSync(V1, { recursive: true }) as string[])
    .filter((f) => f !== "MANIFEST" && !readdirSync(V1, { withFileTypes: true, recursive: true }).some((e) => e.isDirectory() && path.relative(V1, path.join(e.parentPath, e.name)) === f))
    .sort();
  assert.deepEqual(listed.map(([, file]) => file).sort(), files);
  for (const [hash, file] of listed) assert.equal(sha256(readFileSync(path.join(V1, file))), hash, file);
});

test("control-origins.json is the action's LOAD_CONTROL_ORIGINS", () => {
  assert.deepEqual(JSON.parse(read("control-origins.json")), [...LOAD_CONTROL_ORIGINS]);
});

test("refusal-codes.json is the action's codes, each with the slots its copy fills", () => {
  const codes = JSON.parse(read("refusal-codes.json")) as Record<string, string[]>;
  const ours = Object.fromEntries(Object.entries(REFUSAL_COPY).map(([code, copy]) => [code, [...copy.matchAll(/\{(\w+)\}/g)].map((m) => m[1]!)]));
  assert.deepEqual(codes, ours);
});

test("the unhashed refusal-copy.json is the action's copy, byte for byte", () => {
  assert.equal(readFileSync(path.join(DIR, "v1-copy/refusal-copy.json"), "utf8"), `${JSON.stringify(REFUSAL_COPY, null, 2)}\n`);
});

const job = read("peeps-load-job.yml");

test("the job's Node is the toolchain the action pins and checks", () => {
  const version = /^ {10}node-version: "([^"]+)"$/m.exec(job)?.[1];
  assert.equal(version, LOAD_NODE_VERSION);
  assert.equal(version, SUPPORTED_TOOLCHAIN[0]!.node);
});

test("the job blanks exactly the loader variables the action refuses when set", () => {
  const env = job.slice(job.indexOf("\n    env:\n") + 10, job.indexOf("\n    steps:\n"));
  const names = [...env.matchAll(/^ {6}([A-Z_]+): ""$/gm)].map((m) => m[1]);
  assert.equal(names.length, env.trim().split("\n").length, "every line is a blank");
  assert.deepEqual(names, [...PRELOAD_VARS]);
});

test("the job hands the action exactly mode, load-grant and load-workload, and every one is a declared input", () => {
  const step = job.slice(job.indexOf("- uses: Peeps-Labs/peeps-action@"));
  const withBlock = step.slice(step.indexOf("        with:\n") + 14);
  const keys = [...withBlock.matchAll(/^ {10}([a-z-]+):/gm)].map((m) => m[1]!);
  assert.deepEqual(keys, ["mode", "load-grant", "load-workload"]);
  const actionYml = readFileSync(path.resolve(__dirname, "../action.yml"), "utf8");
  const declared = [...actionYml.slice(actionYml.indexOf("\ninputs:\n"), actionYml.indexOf("\nruns:")).matchAll(/^ {2}([a-z-]+):$/gm)].map((m) => m[1]);
  for (const key of keys) assert.ok(declared.includes(key), key);
  assert.match(step, /^ {10}PEEPS_API_URL: https:\/\/dev\.peepsai\.com$/m);
});
