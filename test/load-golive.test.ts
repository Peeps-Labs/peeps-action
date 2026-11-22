/**
 * The go line's workflow sources (e5 plan §7, v3 §4; CW plan §4.8): one per runner image, each
 * pinned by its checksum, never run from peeps-action, dispatched by P4a on exactly its four
 * inputs, and unable to aim load anywhere but the harness. Text assertions: the files are small,
 * and nothing here needs a YAML parser.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { PRELOAD_VARS } from "../src/load/customer";

const DIR = path.resolve(__dirname, "../fixtures/load-golive");
const FILES = { "load-golive.yml": "ubuntu-24.04", "load-golive-2204.yml": "ubuntu-22.04" } as const;
const CHECKOUT = "actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1";
const SETUP_NODE = "actions/setup-node@249970729cb0ef3589644e2896645e5dc5ba9c38";
const template = readFileSync(path.resolve(__dirname, "fixtures/load-job/v1/peeps-load-job.yml"), "utf8");

function read(file: string) {
  const text = readFileSync(path.join(DIR, file), "utf8");
  const lines = text.split("\n").filter((l) => !/^\s*#/.test(l));
  return { text, lines, code: lines.join("\n").replace(/ +# v\d+$/gm, "") };
}

test("the folder holds exactly the two sources and their checksums", () => {
  assert.deepEqual(readdirSync(DIR).sort(), ["load-golive-2204.yml", "load-golive-2204.yml.sha256", "load-golive.yml", "load-golive.yml.sha256"]);
});

test("the two files differ only in their runner image, their names and their artifact", () => {
  const a = read("load-golive.yml").code.replaceAll("ubuntu-24.04", "IMAGE");
  const b = read("load-golive-2204.yml").code.replaceAll("ubuntu-22.04", "IMAGE");
  assert.equal(a, b);
});

for (const [file, image] of Object.entries(FILES)) {
  const { text, lines, code } = read(file);

  test(`${file}: its bytes are the ones its checksum pins`, () => {
    const [digest, name] = readFileSync(path.join(DIR, `${file}.sha256`), "utf8").trim().split(/\s+/);
    assert.equal(name, file);
    assert.equal(createHash("sha256").update(text).digest("hex"), digest);
  });

  test(`${file}: a source, not a workflow of this repository`, () => {
    const workflows = path.resolve(__dirname, "../.github/workflows");
    for (const w of readdirSync(workflows)) assert.doesNotMatch(readFileSync(path.join(workflows, w), "utf8"), /dist\/load\.js|PEEPS_LOAD_GRANT/, w);
    assert.equal(existsSync(path.join(workflows, file)), false);
  });

  test(`${file}: dispatch only, on exactly P4a's four inputs, the two load inputs declared as the template's are`, () => {
    const on = code.slice(code.indexOf("\non:"), code.indexOf("\npermissions:"));
    assert.match(on, /^\s{2}workflow_dispatch:$/m);
    assert.doesNotMatch(on, /\b(?:push|pull_request|pull_request_target|schedule|workflow_run|workflow_call|repository_dispatch|issue_comment)\b/);
    assert.deepEqual([...on.matchAll(/^ {6}([A-Za-z-]+):$/gm)].map((m) => m[1]), ["mode", "ref", "loadGrant", "loadWorkload"]);
    for (const input of ["loadGrant", "loadWorkload"]) assert.match(on, new RegExp(`^ {6}${input}:\\n(?: {8}.*\\n)*? {8}required: false\\n(?: {8}.*\\n)*? {8}type: string$`, "m"), input);
  });

  test(`${file}: job peeps-load runs only in the fixture repository, on a first attempt, for mode load, on ${image}`, () => {
    assert.match(code, /^jobs:\n {2}peeps-load:\n/m);
    assert.match(code, /^ {4}if: github\.repository == 'Peeps-Labs\/peeps-load-fixture' && github\.run_attempt == 1 && inputs\.mode == 'load'$/m);
    assert.match(code, new RegExp(`^ {4}runs-on: ${image.replace(".", "\\.")}$`, "m"));
    assert.match(code, /^permissions:\n {2}contents: read\n {2}id-token: write\n/m);
    assert.doesNotMatch(code, /secrets\.|container:|strategy:/);
    assert.equal(code.match(/persist-credentials: false/g)?.length, 2);
  });

  test(`${file}: the job blanks the template's six loader variables`, () => {
    const env = code.slice(code.indexOf("\n    env:\n") + 10, code.indexOf("\n    steps:\n"));
    assert.deepEqual([...env.matchAll(/^ {6}([A-Z_]+): ""$/gm)].map((m) => m[1]), [...PRELOAD_VARS]);
    assert.equal(env.trim().split("\n").length, PRELOAD_VARS.length);
  });

  test(`${file}: checkout and setup-node at the template's commits, the app at inputs.ref, setup-node's cache off`, () => {
    for (const pin of [CHECKOUT, SETUP_NODE]) assert.ok(template.includes(pin), `the template pins ${pin}`);
    assert.equal(code.match(new RegExp(`uses: ${CHECKOUT}$`, "gm"))?.length, 2);
    assert.equal(code.match(new RegExp(`uses: ${SETUP_NODE}$`, "gm"))?.length, 1);
    assert.match(code, /with:\n {10}ref: \$\{\{ inputs\.ref \}\}\n {10}path: app\n/);
    assert.match(code, /with:\n {10}node-version: "24\.22\.3"\n {10}package-manager-cache: false\n/);
  });

  test(`${file}: Peeps' origin and the sink are written in the file; the grant and workload come from inputs only through the environment`, () => {
    const env = code.slice(code.indexOf("        env:\n"));
    assert.match(env, /^ {10}PEEPS_URL: https:\/\/dev\.peepsai\.com$/m);
    assert.match(env, /^ {10}PEEPS_LOAD_SINK_HOSTS: [a-z0-9.-]+$/m);
    assert.match(env, /^ {10}PEEPS_LOAD_GRANT: \$\{\{ inputs\.loadGrant \}\}$/m);
    assert.match(env, /^ {10}PEEPS_LOAD_WORKLOAD: \$\{\{ inputs\.loadWorkload \}\}$/m);
    assert.match(env, /^ {10}PEEPS_LOAD_ACTION_VERSION: \$\{\{ steps\.action\.outputs\.commit \}\}$/m);
    for (const line of lines) {
      if (/inputs\.load(?:Grant|Workload)/.test(line)) assert.match(line, /^ {10}PEEPS_LOAD_(?:GRANT|WORKLOAD): /, "an input reaches no script text");
      if (/^\s+run:/.test(line)) assert.doesNotMatch(line, /\$\{\{/, "no expression is spliced into a script");
    }
    assert.match(code, /run: exec node "\$GITHUB_WORKSPACE\/action\/dist\/load\.js"/);
  });

  test(`${file}: the action is checked out by id at one quoted all-zero commit, the placeholder the fixture's copy replaces`, () => {
    assert.match(code, /- id: action\n {8}uses: [^\n]+\n {8}with:\n {10}repository: Peeps-Labs\/peeps-action\n {10}ref: "0{40}"\n/);
    assert.equal(text.match(/\b0{40}\b/g)?.length, 1);
  });

  test(`${file}: a fixed artifact name, and failure to produce the result fails its upload step`, () => {
    assert.match(code, new RegExp(`name: peeps-load-result-${image.replace(".", "\\.")}\n`));
    assert.doesNotMatch(code, /inputs\.runner/);
    assert.match(code, /path: \$\{\{ runner\.temp \}\}\/peeps-load-result\.json\n\s+if-no-files-found: error\n/);
  });
}

const { code } = read("load-golive.yml");

test("the workflow shell delivers GitHub cancellation signals to the load process", {
  skip: process.platform !== "linux", timeout: 10_000,
}, async (t) => {
  const root = mkdtempSync(path.join(os.tmpdir(), "peeps-load-step-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const dist = path.join(root, "action", "dist");
  mkdirSync(dist, { recursive: true });
  writeFileSync(path.join(dist, "load.js"), `
    process.on("SIGINT", () => process.exit(21));
    process.on("SIGTERM", () => process.exit(22));
    console.log(process.pid);
    setInterval(() => {}, 1000);
  `);
  const script = path.join(root, "step.sh");
  const command = code.match(/^ {8}run: (.+)$/m);
  assert.ok(command);
  writeFileSync(script, `${command[1]}\n`);

  for (const [signal, exitCode] of [["SIGINT", 21], ["SIGTERM", 22]] as const) {
    // The runner invokes the script as a file and signals that PID, not its group.
    const child = spawn("/bin/bash", ["-e", script], {
      env: { ...process.env, GITHUB_WORKSPACE: root, PATH: `${path.dirname(process.execPath)}:${process.env.PATH}` },
      detached: true, stdio: ["ignore", "pipe", "ignore"],
    });
    const exited = once(child, "close", { signal: t.signal });
    // A timeout can also reject this promise while the test is waiting for the ready line.
    void exited.catch(() => undefined);
    try {
      const [pid] = await once(child.stdout!, "data", { signal: t.signal });
      assert.equal(Number(String(pid).trim()), child.pid, "node must own the step entry PID");
      assert.equal(child.kill(signal), true);
      assert.deepEqual(await exited, [exitCode, null]);
    } finally {
      if (child.pid && child.exitCode === null) {
        try {
          process.kill(-child.pid, "SIGKILL");
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
        }
      }
    }
  }
});
