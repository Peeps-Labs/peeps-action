import { test } from "node:test";
import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { RunnerEnv } from "../src/env";
import {
  junitTitlePath,
  parseJunitResults,
  pytestNodeArgument,
  runPytestTool,
  type PytestRunDeps,
} from "../src/pytest-run-tool";

const FIXTURE = path.join(__dirname, "fixtures", "pytest-junit", "lab-legacy.xml");

test("a node argument names the module, then each title scope", () => {
  assert.equal(pytestNodeArgument("tests/a/test_b.py", null), "tests/a/test_b.py");
  assert.equal(pytestNodeArgument("tests/a/test_b.py", "test_x[max]"), "tests/a/test_b.py::test_x[max]");
  assert.equal(
    pytestNodeArgument("test_b.py", "TestCam › TestZoom › test_wide"),
    "test_b.py::TestCam::TestZoom::test_wide",
  );
});

test("a pytest-playwright test is selected by its function, since its id carries the browser", () => {
  assert.equal(pytestNodeArgument("t/test_ui.py", "test_x[admin]", "chromium"), "t/test_ui.py::test_x");
  assert.equal(pytestNodeArgument("t/test_ui.py", "test_x[a[b]]", "chromium"), "t/test_ui.py::test_x");
  assert.equal(pytestNodeArgument("t/test_ui.py", "test_home", "chromium"), "t/test_ui.py::test_home");
});

test("a JUnit testcase's title path is its class nesting and name, not its module", () => {
  const file = "tests/coverage/test_01.py";
  assert.equal(junitTitlePath("tests.coverage.test_01", "test_up", file), "test_up");
  assert.equal(junitTitlePath("tests.coverage.test_01.TestCam", "test_up[x]", file), "TestCam › test_up[x]");
  // Without `file`, only class-like segments survive.
  assert.equal(junitTitlePath("tests.coverage.test_01.TestCam", "test_up", undefined), "TestCam › test_up");
  assert.equal(junitTitlePath("tests.coverage.test_01", "test_up", undefined), "test_up");
  // pytest's default xunit2 family has no `file`: the requested module's name
  // marks where the class scopes start.
  assert.equal(junitTitlePath("tests.test_a.Checks", "test_ok", undefined, "tests/test_a.py"), "Checks › test_ok");
  assert.equal(
    junitTitlePath("Tests.test_a.TestOuter.TestInner", "test_ok[x::y]", undefined, "Tests/test_a.py"),
    "TestOuter › TestInner › test_ok[x::y]",
  );
  // A collection error stands for the whole module.
  assert.equal(junitTitlePath("", "tests.coverage.test_01", undefined), "");
});

test("a lab JUnit file reads as run_tests results, collection error included", async () => {
  const results = parseJunitResults(await readFile(FIXTURE, "utf8"));
  assert.equal(results.length, 9);
  const collection = results[0]!;
  assert.deepEqual(
    { title: collection.title, file: collection.file, status: collection.status },
    { title: "", file: "tests/coverage/streaming/test_03_codec.py", status: "failed" },
  );
  assert.match(collection.error ?? "", /ImportError: cannot import name 'hevc_capable_for_model'/);
  const sweep = results.find((r) => r.title === "test_brightness_sweep_is_monotonic")!;
  assert.equal(sweep.status, "failed");
  assert.equal(sweep.file, "tests/coverage/image/test_02_image_settings.py");
  assert.match(sweep.error ?? "", /assert/);
  const passed = results.find((r) => r.title === "test_upgrade_reaches_target")!;
  assert.equal(passed.status, "passed");
  assert.equal(passed.error, undefined);
  assert.equal(passed.line, 9);
});

test("skipped and self-closing testcases, and escaped text, read correctly", () => {
  const xml = `<testsuite><testcase classname="t.test_a" name="test_skip" file="t/test_a.py"><skipped message="no camera &amp; no lab" /></testcase><testcase classname="t.test_a" name="test_ok" file="t/test_a.py"/><testcase classname="t.test_a" name="test_err" file="t/test_a.py"><error message="boom">x &lt; y</error></testcase></testsuite>`;
  assert.deepEqual(parseJunitResults(xml), [
    { title: "test_skip", file: "t/test_a.py", status: "skipped", error: "no camera & no lab" },
    { title: "test_ok", file: "t/test_a.py", status: "passed" },
    { title: "test_err", file: "t/test_a.py", status: "failed", error: "boom\nx < y" },
  ]);
});

async function workspace(withHook: boolean) {
  const ws = await mkdtemp(path.join(tmpdir(), "peeps-ws-"));
  await mkdir(path.join(ws, "tests"), { recursive: true });
  if (withHook) {
    await mkdir(path.join(ws, ".peeps"));
    await writeFile(path.join(ws, ".peeps", "run-tests"), "#!/bin/sh\n");
    await chmod(path.join(ws, ".peeps", "run-tests"), 0o755);
  }
  return { workspace: ws, workingDirectory: ws, configPath: null } as unknown as RunnerEnv;
}

function fakeDeps(xml: string | null) {
  const calls: Array<{ via: string; cmd?: string; args: string[] }> = [];
  const writeJunit = async (args: string[]) => {
    const junit = args.find((a) => a.startsWith("--junitxml="))?.slice("--junitxml=".length) ?? args[0]!;
    if (xml !== null) await writeFile(junit, xml);
  };
  const deps: PytestRunDeps = {
    run: async (cmd, args) => {
      calls.push({ via: "hook", cmd, args });
      await writeJunit(args);
      return { code: 1, output: "lab says hi" };
    },
    pytest: async (args) => {
      calls.push({ via: "pytest", args });
      await writeJunit(args);
      return { code: 0, output: "1 passed" };
    },
  };
  return { deps, calls };
}

const ONE_PASS = `<testsuite><testcase classname="tests.test_a" name="test_up" file="tests/test_a.py"/></testsuite>`;

test("without a hook, pytest runs the one test with legacy JUnit and the -k filter", async () => {
  const env = await workspace(false);
  const { deps, calls } = fakeDeps(ONE_PASS);
  const out = await runPytestTool(
    env,
    { fileAbs: path.join(env.workspace, "tests/test_a.py"), titlePath: "test_up", keyword: "up" },
    deps,
  );
  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.via, "pytest");
  assert.ok(calls[0]!.args.includes("junit_family=legacy"));
  assert.deepEqual(calls[0]!.args.slice(-4), ["-k", "up", "--", "tests/test_a.py::test_up"]);
  assert.equal(out.ranWith, "pytest");
  assert.deepEqual(out.results, [{ title: "test_up", file: "tests/test_a.py", status: "passed" }]);
});

test("an executable .peeps/run-tests runs instead, with the JUnit path and the node id", async () => {
  const env = await workspace(true);
  const { deps, calls } = fakeDeps(ONE_PASS);
  const out = await runPytestTool(
    env,
    { fileAbs: path.join(env.workspace, "tests/test_a.py"), titlePath: "test_up", keyword: null },
    deps,
  );
  assert.equal(calls[0]!.via, "hook");
  assert.equal(calls[0]!.cmd, path.join(env.workspace, ".peeps", "run-tests"));
  assert.match(calls[0]!.args[0]!, /junit\.xml$/);
  assert.equal(calls[0]!.args[1], "tests/test_a.py::test_up");
  // The JUnit file is the verdict, not the hook's exit code.
  assert.equal(out.exitCode, 1);
  assert.equal(out.ranWith, ".peeps/run-tests");
  assert.equal(out.results?.[0]?.status, "passed");
});

test("a hook that differs from the commit under test is not run", async () => {
  const env = await workspace(true);
  const { deps, calls } = fakeDeps(ONE_PASS);
  const out = await runPytestTool(
    env,
    {
      fileAbs: path.join(env.workspace, "tests/test_a.py"),
      titlePath: "test_up",
      keyword: null,
      hookUnchanged: async () => false,
    },
    deps,
  );
  assert.equal(calls.length, 0);
  assert.equal(out.results, null);
  assert.match(out.outputTail, /differs from the commit under test/);
});

test("a browser narrows the pytest run to that browser", async () => {
  const env = await workspace(false);
  const { deps, calls } = fakeDeps(ONE_PASS);
  await runPytestTool(
    env,
    { fileAbs: path.join(env.workspace, "tests/test_a.py"), titlePath: "test_up[admin]", keyword: null, browser: "firefox" },
    deps,
  );
  assert.deepEqual(calls[0]!.args.slice(-4), ["--browser", "firefox", "--", "tests/test_a.py::test_up"]);
});

test("a run that wrote no JUnit reports no results and keeps the output", async () => {
  const env = await workspace(false);
  const { deps } = fakeDeps(null);
  const out = await runPytestTool(
    env,
    { fileAbs: path.join(env.workspace, "tests/test_a.py"), titlePath: null, keyword: null },
    deps,
  );
  assert.equal(out.results, null);
  assert.equal(out.outputTail, "1 passed");
});
