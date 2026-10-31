import { test } from "node:test";
import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { RunnerEnv } from "../src/env";
import {
  junitTitlePath,
  OUTPUT_TAIL_CHARS,
  parseJunitResults,
  pendingMarkerNote,
  pytestNodeArgument,
  redactHttpCalls,
  runPytestTool,
  withHttpCalls,
  type HttpExchange,
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

function fakeDeps(xml: string | null, httpCalls: string | null = null) {
  const calls: Array<{ via: string; cmd?: string; args: string[] }> = [];
  const writeJunit = async (args: string[]) => {
    const junit = args.find((a) => a.startsWith("--junitxml="))?.slice("--junitxml=".length) ?? args[0]!;
    if (xml !== null) await writeFile(junit, xml);
  };
  const envs: Array<Record<string, string>> = [];
  const deps: PytestRunDeps = {
    run: async (cmd, args) => {
      calls.push({ via: "hook", cmd, args });
      await writeJunit(args);
      return { code: 1, output: "lab says hi" };
    },
    pytest: async (args, _cwd, extraEnv) => {
      calls.push({ via: "pytest", args });
      envs.push(extraEnv);
      await writeJunit(args);
      if (httpCalls !== null) await writeFile(extraEnv.PEEPS_EVIDENCE_OUT!, httpCalls);
      return { code: 0, output: "1 passed" };
    },
  };
  return { deps, calls, envs };
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
  let scratch: string | null = null;
  const out = await runPytestTool(
    env,
    {
      fileAbs: path.join(env.workspace, "tests/test_a.py"),
      titlePath: "test_up",
      keyword: null,
      hook: async (dir) => {
        scratch = dir;
        return { kind: "ready", path: path.join(dir, "hook", ".peeps", "run-tests") };
      },
    },
    deps,
  );
  assert.equal(calls[0]!.via, "hook");
  // The copy the hook plan made, never the checkout's own file.
  assert.equal(calls[0]!.cmd, path.join(scratch!, "hook", ".peeps", "run-tests"));
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
      hook: async () => ({ kind: "changed" }),
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

function hookDeps(code: number, output: string, xml: string | null = null) {
  const deps: PytestRunDeps = {
    run: async (_cmd, args) => {
      if (xml !== null) await writeFile(args[0]!, xml);
      return { code, output };
    },
    pytest: async () => {
      throw new Error("pytest must not run while a hook is ready");
    },
  };
  return deps;
}

async function runHook(deps: PytestRunDeps) {
  const env = await workspace(true);
  return runPytestTool(
    env,
    {
      fileAbs: path.join(env.workspace, "tests/test_a.py"),
      titlePath: "test_up",
      keyword: null,
      hook: async (dir) => ({ kind: "ready", path: path.join(dir, "run-tests") }),
    },
    deps,
  );
}

test("a hook that started a lab run and printed peeps:pending reports a pending run", async () => {
  const out = await runHook(hookDeps(0, "reserving a camera\npeeps:pending\nbye\n"));
  assert.equal(out.pending, true);
  assert.equal(out.pendingNote, null);
  assert.equal(out.results, null);
  assert.equal(out.ranWith, ".peeps/run-tests");
  assert.equal(out.exitCode, 0);
});

test("the pending line may carry a note, such as the lab run's link", async () => {
  const out = await runHook(hookDeps(0, "  peeps:pending https://lab.example/runs/42  \r\n"));
  assert.equal(out.pending, true);
  assert.equal(out.pendingNote, "https://lab.example/runs/42");
});

test("a pending marker counts only on its own line, after a clean exit, with no JUnit", async () => {
  // Not its own line: a log that mentions the marker.
  assert.equal((await runHook(hookDeps(0, "echo peeps:pending later\n"))).pending, false);
  assert.equal((await runHook(hookDeps(0, "peeps:pendingness\n"))).pending, false);
  // A failed hook did not start anything Peeps can wait for.
  assert.equal((await runHook(hookDeps(2, "peeps:pending\n"))).pending, false);
  // A JUnit file is a verdict, and a verdict wins.
  const withJunit = await runHook(hookDeps(0, "peeps:pending\n", ONE_PASS));
  assert.equal(withJunit.pending, false);
  assert.equal(withJunit.results?.[0]?.status, "passed");
});

test("a marker manufactured by cutting the output to its tail does not count", async () => {
  // The run keeps the last OUTPUT_TAIL_CHARS of output, so its first line may
  // be the end of a longer one: here, a log line that mentions the marker.
  const cut = `peeps:pending ${"x".repeat(OUTPUT_TAIL_CHARS - 19)}\nbye\n`;
  assert.equal(cut.length, OUTPUT_TAIL_CHARS);
  assert.equal((await runHook(hookDeps(0, cut))).pending, false);
  // A marker on a later, whole line still counts.
  const kept = `${"x".repeat(OUTPUT_TAIL_CHARS)}\npeeps:pending\n`.slice(-OUTPUT_TAIL_CHARS);
  assert.equal((await runHook(hookDeps(0, kept))).pending, true);
  // A full tail with no line break at all is one cut line, so nothing counts.
  const unbroken = `peeps:pending ${"x".repeat(OUTPUT_TAIL_CHARS - 14)}`;
  assert.equal(unbroken.length, OUTPUT_TAIL_CHARS);
  assert.equal((await runHook(hookDeps(0, unbroken))).pending, false);
});

test("the note is kept whole, for the redactor to see every secret in it", () => {
  const note = "y".repeat(800);
  assert.equal(pendingMarkerNote(`peeps:pending ${note}\n`), note);
});

test("pytest output is never read as a pending marker", async () => {
  const env = await workspace(false);
  const deps: PytestRunDeps = {
    run: async () => {
      throw new Error("no hook");
    },
    pytest: async () => ({ code: 0, output: "peeps:pending\n" }),
  };
  const out = await runPytestTool(
    env,
    { fileAbs: path.join(env.workspace, "tests/test_a.py"), titlePath: "test_up", keyword: null },
    deps,
  );
  assert.equal(out.pending, false);
});

test("a .peeps/run-tests in the checkout runs only through a hook plan", async () => {
  const env = await workspace(true);
  const { deps, calls } = fakeDeps(ONE_PASS);
  await runPytestTool(
    env,
    { fileAbs: path.join(env.workspace, "tests/test_a.py"), titlePath: "test_up", keyword: null },
    deps,
  );
  assert.equal(calls[0]!.via, "pytest");
});

// ---------------------------------------------------------------------------
// The HTTP calls a failed test made
// ---------------------------------------------------------------------------

function exchange(url: string, status: number | null, extra: Partial<HttpExchange> = {}): HttpExchange {
  return { method: "GET", url, status, durationMs: 3, requestHeaders: [], responseHeaders: [], ...extra };
}

const TWO_FAILED = `<testsuite>
<testcase classname="tests.test_a" name="test_up" file="tests/test_a.py"/>
<testcase classname="tests.test_a.TestFleet" name="test_list[eu]" file="tests/test_a.py"><failure message="assert 404 == 200"/></testcase>
<testcase classname="tests.test_a" name="test_down" file="tests/test_a.py"><failure message="boom"/></testcase>
</testsuite>`;

test("pytest runs with the plugin recording HTTP calls, and a failed test carries its own", async () => {
  const env = await workspace(false);
  const evidence = JSON.stringify([
    {
      nodeId: "tests/test_a.py::TestFleet::test_list[eu]",
      httpExchanges: [exchange("http://api/robots?region=eu", 404, { responseBody: '{"error":"no region"}' })],
      httpExchangesOmitted: 2,
    },
    // A passed test's calls never attach, even if a file says so.
    { nodeId: "tests/test_a.py::test_up", httpExchanges: [exchange("http://api/up", 200)] },
  ]);
  const { deps, calls, envs } = fakeDeps(TWO_FAILED, evidence);
  const out = await runPytestTool(
    env,
    { fileAbs: path.join(env.workspace, "tests/test_a.py"), titlePath: null, keyword: null },
    deps,
  );
  assert.deepEqual(calls[0]!.args.slice(0, 2), ["-p", "peeps_pytest_plugin"]);
  assert.match(envs[0]!.PEEPS_EVIDENCE_OUT!, /http-calls\.json$/);
  assert.match(envs[0]!.PYTHONPATH!, /python/);
  const [up, list, down] = out.results!;
  assert.equal(up!.httpExchanges, undefined);
  assert.equal(list!.httpExchanges?.[0]?.status, 404);
  assert.equal(list!.httpExchanges?.[0]?.responseBody, '{"error":"no region"}');
  assert.equal(list!.httpExchangesOmitted, 2);
  assert.equal(down!.httpExchanges, undefined);
});

test("the customer's hook runs without the plugin, and its results carry no calls", async () => {
  const env = await workspace(true);
  const { deps, calls } = fakeDeps(TWO_FAILED, "[]");
  const out = await runPytestTool(
    env,
    {
      fileAbs: path.join(env.workspace, "tests/test_a.py"),
      titlePath: null,
      keyword: null,
      hook: async (dir) => ({ kind: "ready", path: path.join(dir, "hook") }),
    },
    deps,
  );
  assert.equal(calls[0]!.via, "hook");
  assert.ok(!calls[0]!.args.includes("peeps_pytest_plugin"));
  assert.ok(out.results!.every((r) => r.httpExchanges === undefined));
});

test("calls attach by title path to failed results only, at most three, and a bad file adds nothing", () => {
  const failed = (title: string) => ({ title, file: "t.py", status: "failed" as const });
  const results = [failed("test_a"), failed("test_b"), failed("test_c"), failed("test_d"), failed("TestX › test_e[1]")];
  const evidence = JSON.stringify([
    ...["test_a", "test_b", "test_c", "test_d"].map((name) => ({
      nodeId: `t.py::${name}`,
      httpExchanges: [exchange(`http://api/${name}`, 500)],
    })),
    { nodeId: "t.py::TestX::test_e[1]", httpExchanges: [exchange("http://api/e", 500)], evidenceTrimmed: true },
    { nodeId: "not a node id", httpExchanges: [exchange("http://api/x", 500)] },
    { nodeId: "t.py::test_none", httpExchanges: [] },
  ]);
  const out = withHttpCalls(results, evidence);
  assert.deepEqual(
    out.map((r) => r.httpExchanges?.[0]?.url ?? null),
    ["http://api/test_a", "http://api/test_b", "http://api/test_c", null, null],
  );
  assert.equal(withHttpCalls([failed("TestX › test_e[1]")], evidence)[0]!.evidenceTrimmed, true);
  assert.deepEqual(withHttpCalls(results, null), results);
  assert.deepEqual(withHttpCalls(results, "{not json"), results);
  assert.deepEqual(withHttpCalls(results, '{"nodeId":"t.py::test_a"}'), results);
});

test("every value a secret could reach in a call is redacted, and only those", () => {
  const redact = (text: string) => text.replaceAll("s3cret-value", "[redacted]");
  const [out] = redactHttpCalls(
    [
      exchange("http://api/x?k=s3cret-value", 401, {
        method: "POST",
        requestHeaders: [{ name: "X-Key", value: "s3cret-value" }],
        responseHeaders: [{ name: "X-Echo", value: "s3cret-value" }],
        requestBody: '{"k":"s3cret-value"}',
        responseBody: "denied s3cret-value",
        error: "HTTPError: s3cret-value",
      }),
    ],
    redact,
  );
  assert.ok(!JSON.stringify(out).includes("s3cret-value"));
  assert.equal(out!.method, "POST");
  assert.equal(out!.status, 401);
  assert.equal(out!.requestHeaders[0]!.name, "X-Key");
  // An absent body stays absent, never an empty string.
  assert.ok(!("requestBody" in redactHttpCalls([exchange("http://api/y", 200)], redact)[0]!));
});
