/** The private scratch directory raw evidence passes through (W6): its own, its files the job's only, and gone however the job ends. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, readdirSync, statSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { openScratch } from "../src/evidence/scratch";

test("the directory is 0700, each file 0600, and dispose removes it", async (t) => {
  const parent = await mkdtemp(path.join(tmpdir(), "peeps-scratch-test-"));
  t.after(() => rm(parent, { recursive: true, force: true }));
  const scratch = await openScratch(parent);
  assert.equal(statSync(scratch.dir).mode & 0o777, 0o700);
  const file = scratch.write("cov-a.json", { a: 1 });
  assert.equal(statSync(file).mode & 0o777, 0o600);
  assert.deepEqual(scratch.read("cov-"), [{ a: 1 }]);
  await scratch.dispose();
  assert.equal(existsSync(scratch.dir), false);
  await scratch.dispose();
});

for (const signal of ["SIGTERM", "SIGINT"] as const) {
  test(`a job stopped by ${signal} leaves no scratch directory`, async (t) => {
    const parent = await mkdtemp(path.join(tmpdir(), "peeps-scratch-test-"));
    t.after(() => rm(parent, { recursive: true, force: true }));
    const script = `
      const { openScratch } = require(${JSON.stringify(path.resolve(__dirname, "../src/evidence/scratch.ts"))});
      openScratch(${JSON.stringify(parent)}).then((s) => { s.write("cov-x.json", { raw: "/cart" }); console.log("ready"); setInterval(() => {}, 1000); });
    `;
    const child = spawn(process.execPath, ["--import", "tsx", "-e", script], { stdio: ["ignore", "pipe", "inherit"] });
    await new Promise<void>((resolve) => child.stdout.on("data", (chunk: Buffer) => chunk.toString().includes("ready") && resolve()));
    assert.equal(readdirSync(parent).length, 1, "it was there");
    const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => child.on("exit", (code, sig) => resolve({ code, signal: sig })));
    child.kill(signal);
    const result = await exited;
    assert.deepEqual(readdirSync(parent), []);
    // It still dies of the signal, as it would have.
    assert.equal(result.signal, signal);
  });
}
