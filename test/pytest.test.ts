import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { readRunnerEnv, type RunnerEnv } from "../src/env";
import { PeepsClient } from "../src/peeps";
import {
  artifactName,
  buildPytestInventoryRequest,
  collectPytest,
  executePytestAndReport,
  nodeIdArgument,
  nodeIdsForRuns,
  plannedPytestTests,
  pytestNodeIdToTest,
  resolveFramework,
  stagedEvidence,
  type PytestCollection,
} from "../src/pytest";
import type { PlanEntry } from "../src/reporter";

const FIXTURE = path.join(__dirname, "fixtures", "pytest-suite");
/** A non-browser suite: skips, measurements, saved frames, a broken fixture. */
const CAMERA = path.join(__dirname, "fixtures", "pytest-camera");

/**
 * The interpreter the real-pytest tests use. CI installs pytest and sets
 * PEEPS_REQUIRE_PYTEST, so there a missing pytest FAILS rather than skips.
 */
function findPython(): string | null {
  const candidate = process.env.PEEPS_PYTHON ?? "python3";
  try {
    execFileSync(candidate, ["-c", "import pytest"], { stdio: "ignore" });
    return candidate;
  } catch {
    if (process.env.PEEPS_REQUIRE_PYTEST) {
      throw new Error(`PEEPS_REQUIRE_PYTEST is set but ${candidate} cannot import pytest`);
    }
    return null;
  }
}
const python = findPython();
const needsPytest = python
  ? {}
  : { skip: "no Python with pytest (set PEEPS_PYTHON; CI sets PEEPS_REQUIRE_PYTEST)" };
if (python) process.env.PEEPS_PYTHON = python;

/** A throwaway copy of the fixture as the job's workspace, suite under `e2e/`. */
function workspace(fixture = FIXTURE): { root: string; suite: string } {
  const root = mkdtempSync(path.join(tmpdir(), "peeps-pytest-"));
  const suite = path.join(root, "e2e");
  cpSync(fixture, suite, { recursive: true });
  return { root, suite };
}

function envFor(root: string, extra: Record<string, string> = {}): RunnerEnv {
  return readRunnerEnv({
    GITHUB_WORKSPACE: root,
    GITHUB_SHA: "0123456789abcdef0123456789abcdef01234567",
    ...extra,
  });
}

// ---------------------------------------------------------------------------
// Identity: must agree with Peeps' `pytestNodeIdToTest` case for case
// ---------------------------------------------------------------------------

test("a node id becomes Peeps' path + title path, the reported browser lifted off", () => {
  assert.deepEqual(
    pytestNodeIdToTest("tests/crm/test_contacts.py::TestContacts::test_add[chromium-lead-eu]", {
      browser: "chromium",
    }),
    { path: "tests/crm/test_contacts.py", titlePath: "TestContacts › test_add[lead-eu]" },
  );
  assert.deepEqual(
    pytestNodeIdToTest("tests/todo/test_lists.py::test_switch[chromium]", { browser: "chromium" }),
    { path: "tests/todo/test_lists.py", titlePath: "test_switch" },
  );
  assert.equal(
    pytestNodeIdToTest("tests/a_test.py::test_x[lead-firefox]", { browser: "firefox" }).titlePath,
    "test_x[lead]",
  );
  // No browser reported: `chromium` is the customer's own parameter.
  assert.equal(
    pytestNodeIdToTest("tests/test_a.py::test_a[chromium-card]").titlePath,
    "test_a[chromium-card]",
  );
  assert.equal(pytestNodeIdToTest("tests/test_urls.py::test_url[http::x]").titlePath, "test_url[http::x]");
  assert.deepEqual(pytestNodeIdToTest("tests/test_a.py::TestA::test_b[1]", { rootDir: "e2e/python/" }), {
    path: "e2e/python/tests/test_a.py",
    titlePath: "TestA › test_b[1]",
  });
  assert.equal(pytestNodeIdToTest("tests/test_a.py::test_b", { rootDir: ".e2e" }).path, ".e2e/tests/test_a.py");
  assert.deepEqual(pytestNodeIdToTest("tests/[id]/test_a.py::test_b[1]"), {
    path: "tests/[id]/test_a.py",
    titlePath: "test_b[1]",
  });
  assert.throws(() => pytestNodeIdToTest("tests/test_a.py"), /not a pytest test node id/);
  assert.throws(() => pytestNodeIdToTest("tests/test_a.py::"), /not a pytest test node id/);
});

test("planned runs map back to the node ids that execute them, per browser", () => {
  const collection: PytestCollection = {
    rootDir: "/w/e2e",
    playwright: true,
    items: [
      { nodeId: "tests/test_a.py::test_x[chromium]", browser: "chromium", line: 3, markers: [] },
      { nodeId: "tests/test_a.py::test_x[firefox]", browser: "firefox", line: 3, markers: [] },
      { nodeId: "tests/test_a.py::test_y", browser: null, line: 9, markers: [] },
      { nodeId: "tests/test_a.py", browser: null, line: null, markers: [] },
    ],
    errors: [],
  };
  const planned = plannedPytestTests(collection, "e2e");
  // The last item is not a test node id and is left out, not fatal.
  assert.deepEqual(
    planned.map((t) => [t.path, t.titlePath, t.pwProject]),
    [
      ["e2e/tests/test_a.py", "test_x", "chromium"],
      ["e2e/tests/test_a.py", "test_x", "firefox"],
      ["e2e/tests/test_a.py", "test_y", ""],
    ],
  );
  const run = (runId: string, titlePath: string, pwProject: string): PlanEntry => ({
    runId,
    path: "e2e/tests/test_a.py",
    titlePath,
    pwProject,
    credential: { exp: 1, sig: "s" },
  });
  const { byNodeId, unmatched } = nodeIdsForRuns(planned, [
    run("r1", "test_x", "firefox"),
    run("r2", "test_y", ""),
    run("r3", "test_gone", ""),
  ]);
  assert.deepEqual(Object.keys(byNodeId).sort(), [
    "tests/test_a.py::test_x[firefox]",
    "tests/test_a.py::test_y",
  ]);
  assert.equal(byNodeId["tests/test_a.py::test_x[firefox]"]!.runId, "r1");
  assert.deepEqual(unmatched.map((u) => u.runId), ["r3"]);
});

test("a node id is re-rooted from pytest's rootdir to the directory pytest runs in", () => {
  assert.equal(
    nodeIdArgument("tests/test_a.py::T::test_b[x::y]", "/w/e2e", "/w/e2e"),
    "tests/test_a.py::T::test_b[x::y]",
  );
  assert.equal(nodeIdArgument("tests/test_a.py::test_b", "/w/e2e", "/w"), "e2e/tests/test_a.py::test_b");
});

test("output files are named by the run they belong to, flat under data/", () => {
  const runs = new Map([["tests-test-a-py-test-x-chromium", "run-1"]]);
  assert.equal(artifactName("tests-test-a-py-test-x-chromium/trace.zip", runs), "data/run-1-trace.zip");
  assert.equal(
    artifactName("tests-test-a-py-test-x-chromium/nested/test-failed-1.png", runs),
    "data/run-1-nested-test-failed-1.png",
  );
  // Not a planned test's directory: kept, flattened.
  assert.equal(artifactName("other dir/video.webm", runs), "data/other_dir-video.webm");
  const long = artifactName(`${"x".repeat(250)}/trace.zip`, runs);
  assert.match(long, /^data\/[0-9a-f]{40}\.zip$/);
});

// ---------------------------------------------------------------------------
// Which framework: the Playwright path stays the default
// ---------------------------------------------------------------------------

test("framework: auto picks pytest only for a pytest directory without a Playwright config", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "peeps-fw-"));
  const at = (extra: Record<string, string> = {}) => resolveFramework(envFor(dir, extra));
  assert.equal(at(), "playwright");
  writeFileSync(path.join(dir, "conftest.py"), "");
  assert.equal(at(), "pytest");
  // A Playwright config anywhere beside it keeps the Playwright path.
  writeFileSync(path.join(dir, "playwright.config.ts"), "");
  assert.equal(at(), "playwright");
  // So does a `config` input, which names a Playwright config.
  const py = mkdtempSync(path.join(tmpdir(), "peeps-fw-"));
  writeFileSync(path.join(py, "pytest.ini"), "[pytest]\n");
  assert.equal(resolveFramework(envFor(py)), "pytest");
  assert.equal(resolveFramework(envFor(py, { INPUT_CONFIG: "pw.config.ts" })), "playwright");
  // pyproject.toml counts only when it configures pytest.
  const pp = mkdtempSync(path.join(tmpdir(), "peeps-fw-"));
  writeFileSync(path.join(pp, "pyproject.toml"), "[project]\nname='x'\n");
  assert.equal(resolveFramework(envFor(pp)), "playwright");
  writeFileSync(path.join(pp, "pyproject.toml"), "[tool.pytest.ini_options]\naddopts='-q'\n");
  assert.equal(resolveFramework(envFor(pp)), "pytest");
  // The input decides outright, and a typo is an error, not a guess.
  assert.equal(at({ INPUT_FRAMEWORK: "pytest" }), "pytest");
  assert.equal(resolveFramework(envFor(py, { INPUT_FRAMEWORK: "playwright" })), "playwright");
  assert.throws(() => at({ INPUT_FRAMEWORK: "jest" }), /unknown framework/);
});

// ---------------------------------------------------------------------------
// Real pytest
// ---------------------------------------------------------------------------

test("collection reports every item in the runner contract, relative to pytest's rootdir", needsPytest, async () => {
  const { root, suite } = workspace();
  // A module that does not import: recorded as a collection error, and the
  // rest of the suite still collected.
  writeFileSync(path.join(suite, "tests", "shop", "test_broken.py"), "import not_a_module\n");
  const env = envFor(root, { "INPUT_WORKING-DIRECTORY": "e2e" });
  const collection = await collectPytest(env);
  // pytest reports the real path; the workspace here is under a symlink on macOS.
  assert.equal(collection.rootDir, realpathSync(suite));
  assert.equal(collection.playwright, false);
  assert.deepEqual(
    collection.errors.map((e) => e.nodeId),
    ["tests/shop/test_broken.py"],
  );
  assert.match(collection.errors[0]!.message, /not_a_module/);
  assert.deepEqual(collection.items.slice(0, 3), [
    { nodeId: "tests/shop/test_cart.py::test_opens[chromium]", browser: "chromium", line: 4, markers: ["smoke"] },
    {
      nodeId: "tests/shop/test_cart.py::TestCart::test_quantity[chromium-1]",
      browser: "chromium",
      line: 10,
      markers: ["parametrize"],
    },
    {
      nodeId: "tests/shop/test_cart.py::TestCart::test_quantity[chromium-2]",
      browser: "chromium",
      line: 10,
      markers: ["parametrize"],
    },
  ]);
  assert.equal(collection.items.length, 7);

  const request = await buildPytestInventoryRequest(env, collection);
  assert.equal(request.framework, "pytest");
  assert.equal(request.rootDir, "e2e");
  assert.deepEqual(request.collectionErrors, ["tests/shop/test_broken.py"]);
  assert.deepEqual(
    request.files.map((f) => f.path),
    ["e2e/tests/shop/test_cart.py"],
  );
  assert.equal(
    request.files[0]!.content,
    readFileSync(path.join(FIXTURE, "tests", "shop", "test_cart.py"), "utf8"),
  );
});

interface Received {
  events: Map<string, Array<Record<string, unknown>>>;
  completed: Array<{ batchId: string; body: unknown }>;
  artifacts: string[];
  /** Upload path → body (utf-8), for the uploads a test inspects. */
  bodies: Map<string, string>;
  auth: Set<string>;
}

async function fakePeeps(): Promise<{ url: string; received: Received; close: () => void }> {
  const received: Received = {
    events: new Map(),
    completed: [],
    artifacts: [],
    bodies: new Map(),
    auth: new Set(),
  };
  const body = (req: IncomingMessage) =>
    new Promise<string>((resolve) => {
      let data = "";
      req.on("data", (c: Buffer) => (data += c.toString("utf8")));
      req.on("end", () => resolve(data));
    });
  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://x");
    const text = await body(req);
    const events = url.pathname.match(/^\/api\/v1\/runs\/([^/]+)\/events$/);
    if (events) {
      received.auth.add(req.headers.authorization ?? "");
      const list = received.events.get(events[1]!) ?? [];
      list.push(...(JSON.parse(text) as { events: Array<Record<string, unknown>> }).events);
      received.events.set(events[1]!, list);
    }
    const complete = url.pathname.match(/^\/api\/v1\/ci\/batches\/([^/]+)\/complete$/);
    if (complete) received.completed.push({ batchId: complete[1]!, body: JSON.parse(text) });
    if (url.pathname.endsWith("/artifacts")) {
      received.artifacts.push(url.searchParams.get("path") ?? "");
      received.bodies.set(url.searchParams.get("path") ?? "", text);
    }
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end("{}");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return { url: `http://127.0.0.1:${port}`, received, close: () => server.close() };
}

function planFor(collection: PytestCollection, rootDir: string, only?: string[]) {
  const planned = plannedPytestTests(collection, rootDir).filter(
    (t) => !only || only.includes(t.nodeId),
  );
  const runs: PlanEntry[] = planned.map((t, i) => ({
    runId: `run-${i}`,
    path: t.path,
    titlePath: t.titlePath,
    pwProject: t.pwProject,
    credential: { exp: 99, sig: `sig${i}` },
  }));
  return nodeIdsForRuns(plannedPytestTests(collection, rootDir), runs);
}

test("a run streams one test_start/test_end per planned node id, pytest's outcomes mapped", needsPytest, async () => {
  const peeps = await fakePeeps();
  process.env.PEEPS_API_KEY = "test-key";
  const exitCode = process.exitCode;
  try {
    const { root } = workspace();
    const env = envFor(root, { "INPUT_WORKING-DIRECTORY": "e2e", PEEPS_API_URL: peeps.url });
    const collection = await collectPytest(env);
    const { byNodeId } = planFor(collection, "e2e");
    await executePytestAndReport(env, new PeepsClient(env), {
      // The fixture's conftest offers pytest-playwright's `--output`.
      collection: { ...collection, playwright: true },
      byNodeId,
      batches: [{ batchId: "b-1", batchNumber: 1 }],
    });
    // A failing test fails the job, as it would without Peeps.
    assert.equal(process.exitCode, 1);
    // Each test's output directory is uploaded under the run it belongs to.
    const opens = byNodeId["tests/shop/test_cart.py::test_opens[chromium]"]!.runId;
    assert.ok(peeps.received.artifacts.includes(`data/${opens}-trace.zip`), String(peeps.received.artifacts));
    assert.equal(peeps.received.artifacts.length, 6); // all but the skip-marked test

    const statusOf = (nodeId: string) => {
      const events = peeps.received.events.get(byNodeId[nodeId]!.runId) ?? [];
      assert.deepEqual(
        events.map((e) => e.type),
        ["run_start", "test_start", "test_end", "run_end"],
        nodeId,
      );
      return events[2]!;
    };
    const base = "tests/shop/test_cart.py::";
    assert.equal(statusOf(`${base}test_opens[chromium]`).status, "passed");
    assert.equal(statusOf(`${base}test_opens[chromium]`).testName, "test_opens[chromium]");
    assert.equal(statusOf(`${base}TestCart::test_quantity[chromium-2]`).status, "passed");
    const failed = statusOf(`${base}test_total_is_wrong`);
    assert.equal(failed.status, "failed");
    assert.match(String(failed.error), /the total is wrong/);
    assert.match(String(failed.errorStack), /assert 1 \+ 1 == 3/);
    assert.equal(statusOf(`${base}test_skipped`).status, "skipped");
    // An xfail is the suite behaving as declared.
    assert.equal(statusOf(`${base}test_known_bug`).status, "passed");
    // A teardown that breaks after a passing call fails the test.
    const teardown = statusOf(`${base}test_teardown_breaks`);
    assert.equal(teardown.status, "failed");
    assert.match(String(teardown.error), /teardown broke/);
    assert.equal(peeps.received.events.size, 7);
    assert.ok(peeps.received.auth.has("Bearer v1.99.sig0"));
    // No HTML report exists, so none is claimed.
    assert.deepEqual(peeps.received.completed, [{ batchId: "b-1", body: { reportUploaded: false } }]);
  } finally {
    process.exitCode = exitCode;
    peeps.close();
  }
});

test("run mode executes exactly the planned node ids, from a working directory below the rootdir", needsPytest, async () => {
  const peeps = await fakePeeps();
  process.env.PEEPS_API_KEY = "test-key";
  const exitCode = process.exitCode;
  try {
    const { root, suite } = workspace();
    // pytest runs from `e2e/tests` while its rootdir (pytest.ini) is `e2e`.
    mkdirSync(path.join(suite, "tests"), { recursive: true });
    // A nested pytest config beside the selected module: given node ids under
    // it, pytest would move its rootdir there and rename every test.
    writeFileSync(path.join(suite, "tests", "shop", "pytest.ini"), "[pytest]\n");
    const env = envFor(root, { "INPUT_WORKING-DIRECTORY": "e2e/tests", PEEPS_API_URL: peeps.url });
    const collection = await collectPytest(env);
    assert.equal(collection.rootDir, realpathSync(suite));
    const chosen = [
      "tests/shop/test_cart.py::TestCart::test_quantity[chromium-1]",
      "tests/shop/test_cart.py::test_skipped",
    ];
    const { byNodeId } = planFor(collection, "e2e", chosen);
    await executePytestAndReport(env, new PeepsClient(env), {
      collection,
      byNodeId,
      batches: [{ batchId: "b-2", batchNumber: 2 }],
      nodeIds: Object.keys(byNodeId),
    });
    assert.equal(process.exitCode, undefined);
    assert.deepEqual(
      [...peeps.received.events.values()].map((events) => events[2]!.status).sort(),
      ["passed", "skipped"],
    );
  } finally {
    process.exitCode = exitCode;
    peeps.close();
  }
});

function hasPlugins(...modules: string[]): boolean {
  if (!python) return false;
  try {
    execFileSync(python, ["-c", modules.map((m) => `import ${m}`).join("; ")], { stdio: "ignore" });
    return true;
  } catch {
    if (process.env.PEEPS_REQUIRE_PYTEST) throw new Error(`PEEPS_REQUIRE_PYTEST is set but ${modules} missing`);
    return false;
  }
}
const needsPlugins = hasPlugins("xdist", "pytest_rerunfailures")
  ? {}
  : { skip: "pytest-xdist and pytest-rerunfailures not installed" };

/** Run the whole fixture suite once, with extra pytest options, and return what Peeps received. */
async function runSuiteWith(addopts: string, prepare?: (suite: string) => void, fixture = FIXTURE) {
  const peeps = await fakePeeps();
  process.env.PEEPS_API_KEY = "test-key";
  const exitCode = process.exitCode;
  const previous = process.env.PYTEST_ADDOPTS;
  process.env.PYTEST_ADDOPTS = addopts;
  try {
    const { root, suite } = workspace(fixture);
    prepare?.(suite);
    const env = envFor(root, { "INPUT_WORKING-DIRECTORY": "e2e", PEEPS_API_URL: peeps.url });
    const collection = await collectPytest(env);
    const { byNodeId } = planFor(collection, "e2e");
    await executePytestAndReport(env, new PeepsClient(env), {
      // The Playwright fixture's conftest offers `--output`; the camera suite's does not.
      collection: { ...collection, playwright: fixture === FIXTURE },
      byNodeId,
      batches: [{ batchId: "b-3", batchNumber: 3 }],
    });
    return { received: peeps.received, byNodeId, root };
  } finally {
    process.exitCode = exitCode;
    if (previous === undefined) delete process.env.PYTEST_ADDOPTS;
    else process.env.PYTEST_ADDOPTS = previous;
    peeps.close();
  }
}

test("under pytest-xdist each run is reported once, with its artifacts", needsPlugins, async () => {
  const { received, byNodeId } = await runSuiteWith("-n 2");
  for (const [nodeId, run] of Object.entries(byNodeId)) {
    assert.deepEqual(
      (received.events.get(run.runId) ?? []).map((e) => e.type),
      ["run_start", "test_start", "test_end", "run_end"],
      nodeId,
    );
  }
  // The output directories were recorded in the workers and still name runs.
  const opens = byNodeId["tests/shop/test_cart.py::test_opens[chromium]"]!.runId;
  assert.ok(received.artifacts.includes(`data/${opens}-trace.zip`), String(received.artifacts));
});

test("with pytest-rerunfailures each attempt is a test_end and only the final one closes the run", needsPlugins, async () => {
  const { received, byNodeId } = await runSuiteWith("--reruns 1", (suite) => {
    // Fails on its first attempt, passes on the retry.
    writeFileSync(
      path.join(suite, "tests", "shop", "test_flaky.py"),
      [
        "import os",
        "def test_flaky(tmp_path_factory):",
        "    marker = os.path.join(str(tmp_path_factory.getbasetemp()), 'tried')",
        "    if not os.path.exists(marker):",
        "        open(marker, 'w').close()",
        "        assert False, 'first attempt'",
        "",
      ].join("\n"),
    );
  });
  const flaky = received.events.get(byNodeId["tests/shop/test_flaky.py::test_flaky"]!.runId) ?? [];
  // As the Playwright reporter sends a retried attempt: a failed test_end,
  // then the retry, and run_end only after the attempt that decides.
  assert.deepEqual(
    flaky.map((e) => [e.type, e.status]),
    [
      ["run_start", undefined],
      ["test_start", undefined],
      ["test_end", "failed"],
      ["test_start", undefined],
      ["test_end", "passed"],
      ["run_end", undefined],
    ],
  );
  assert.match(String(flaky[2]!.error), /first attempt/);
  // A test that fails every attempt still fails.
  const wrong = received.events.get(byNodeId["tests/shop/test_cart.py::test_total_is_wrong"]!.runId) ?? [];
  assert.equal(wrong[2]!.status, "failed");
});

test("a pytest that cannot start still closes its batches and fails the job", async () => {
  const peeps = await fakePeeps();
  process.env.PEEPS_API_KEY = "test-key";
  const exitCode = process.exitCode;
  const previous = process.env.PEEPS_PYTHON;
  process.env.PEEPS_PYTHON = "/nonexistent/python";
  try {
    const { root } = workspace();
    const env = envFor(root, { "INPUT_WORKING-DIRECTORY": "e2e", PEEPS_API_URL: peeps.url });
    await executePytestAndReport(env, new PeepsClient(env), {
      collection: { rootDir: root, playwright: false, items: [], errors: [] },
      byNodeId: {},
      batches: [{ batchId: "b-4", batchNumber: 4 }],
      nodeIds: ["tests/shop/test_cart.py::test_skipped"],
    });
    assert.equal(process.exitCode, 1);
    assert.deepEqual(peeps.received.completed, [{ batchId: "b-4", body: { reportUploaded: false } }]);
  } finally {
    process.exitCode = exitCode;
    if (previous === undefined) delete process.env.PEEPS_PYTHON;
    else process.env.PEEPS_PYTHON = previous;
    peeps.close();
  }
});

test("the inventory lists tests -m deselected, while a run plans only the selected", needsPytest, async () => {
  const previous = process.env.PYTEST_ADDOPTS;
  process.env.PYTEST_ADDOPTS = '-m "not smoke"';
  try {
    const { root } = workspace();
    const env = envFor(root, { "INPUT_WORKING-DIRECTORY": "e2e" });
    const collection = await collectPytest(env);
    const opens = "tests/shop/test_cart.py::test_opens[chromium]";
    assert.deepEqual(
      collection.deselected?.map((item) => item.nodeId),
      [opens],
    );
    assert.equal(collection.items.some((item) => item.nodeId === opens), false);
    // Planned runs come from what this session runs...
    assert.equal(
      plannedPytestTests(collection, "e2e").some((t) => t.nodeId === opens),
      false,
    );
    // ...and the inventory from everything the repository holds.
    const request = await buildPytestInventoryRequest(env, collection);
    assert.equal(request.items.length, 7);
    assert.ok(request.items.some((item) => item.nodeId === opens));
  } finally {
    if (previous === undefined) delete process.env.PYTEST_ADDOPTS;
    else process.env.PYTEST_ADDOPTS = previous;
  }
});

test("run mode executes only the plan even when addopts names a whole directory", needsPytest, async () => {
  const peeps = await fakePeeps();
  process.env.PEEPS_API_KEY = "test-key";
  const exitCode = process.exitCode;
  const previous = process.env.PYTEST_ADDOPTS;
  try {
    const { root } = workspace();
    const env = envFor(root, { "INPUT_WORKING-DIRECTORY": "e2e", PEEPS_API_URL: peeps.url });
    const collection = await collectPytest(env);
    const { byNodeId } = planFor(collection, "e2e", ["tests/shop/test_cart.py::test_skipped"]);
    // pytest adds an addopts target to the node ids rather than replacing it.
    process.env.PYTEST_ADDOPTS = "tests";
    await executePytestAndReport(env, new PeepsClient(env), {
      collection,
      byNodeId,
      batches: [{ batchId: "b-5", batchNumber: 5 }],
      nodeIds: Object.keys(byNodeId),
    });
    // The failing and teardown-breaking tests in `tests/` never ran.
    assert.equal(process.exitCode, undefined);
    assert.equal(peeps.received.events.size, 1);
  } finally {
    process.exitCode = exitCode;
    if (previous === undefined) delete process.env.PYTEST_ADDOPTS;
    else process.env.PYTEST_ADDOPTS = previous;
    peeps.close();
  }
});

// ---------------------------------------------------------------------------
// Evidence: what a non-browser test leaves behind, on its final test_end
// ---------------------------------------------------------------------------

type Event = Record<string, unknown>;

/** The one test_end of each node id, with the checks every run must pass. */
function testEnds(received: Received, byNodeId: Record<string, PlanEntry>): Record<string, Event> {
  const ends: Record<string, Event> = {};
  for (const [nodeId, run] of Object.entries(byNodeId)) {
    const events = received.events.get(run.runId) ?? [];
    assert.deepEqual(
      events.map((e) => e.type),
      ["run_start", "test_start", "test_end", "run_end"],
      nodeId,
    );
    ends[nodeId.split("::").pop()!] = events[2]!;
  }
  return ends;
}

/** What every run of the camera suite reports, however pytest ran it. */
function assertCameraEvidence(received: Received, byNodeId: Record<string, PlanEntry>) {
  const ends = testEnds(received, byNodeId);
  const EVIDENCE = ["skipReason", "failure", "properties", "propertiesOmitted", "output", "attachments", "attachmentsOmitted"];
  const evidenceOf = (event: Event) => EVIDENCE.filter((key) => key in event);

  // Skip reasons: pytest.skip() in the body, and a skipif marker.
  assert.equal(ends.test_unsupported_model!.status, "skipped");
  assert.equal(ends.test_unsupported_model!.skipReason, "not supported on model X");
  assert.equal(ends.test_thermal!.skipReason, "needs a thermal sensor");
  assert.deepEqual(evidenceOf(ends.test_thermal!), ["skipReason"]);

  // A failing assert with its measurements, the rewrite detail and the output.
  const sharp = ends.test_sharpness!;
  assert.equal(sharp.status, "failed");
  const failure = sharp.failure as Record<string, unknown>;
  assert.equal(failure.phase, "call");
  assert.equal(failure.exceptionType, "AssertionError");
  assert.match(String(failure.message), /assert 0\.41 >= 0\.6/);
  assert.match(String(failure.traceback), /def test_sharpness/);
  assert.match(String(failure.traceback), /E\s+assert 0\.41 >= 0\.6/);
  assert.deepEqual(sharp.properties, [
    { name: "sharpness", value: 0.41 },
    { name: "exposure_ms", value: 12 },
    { name: "lens", value: "wide" },
    { name: "roi", value: '{"x": 10, "y": 20}' },
    // Not JSON: NaN would make the whole events request unparseable.
    { name: "noise", value: "nan" },
  ]);
  const output = sharp.output as Array<{ name: string; text: string }>;
  const section = (name: string) => output.find((s) => s.name === name)?.text ?? "";
  assert.match(section("Captured stdout call"), /focusing on target 3/);
  assert.match(section("Captured stderr call"), /sensor warm/);
  assert.match(section("Captured log call"), /autofocus hunting/);

  // A broken fixture fails at setup, with its own exception type.
  const offline = ends.test_camera_offline!;
  assert.equal(offline.status, "failed");
  assert.deepEqual((offline.failure as Record<string, unknown>).phase, "setup");
  assert.equal((offline.failure as Record<string, unknown>).exceptionType, "conftest.CameraError");
  assert.equal((offline.failure as Record<string, unknown>).message, "camera 2 did not answer");

  // Saved files: the per-test directory and an attached tmp_path file are
  // uploaded under the test's run; a path outside the workspace is not.
  const frame = ends.test_saves_frame!;
  assert.equal(frame.status, "passed");
  const runId = byNodeId["tests/test_camera.py::test_saves_frame"]!.runId;
  assert.deepEqual(frame.attachments, [
    { name: "frame.png", path: `data/${runId}-evidence-frame.png`, size: 19 },
    // `.npy` is not a type Peeps' data/ accepts, so it travels as `.dat`.
    { name: "raw/frame.npy", path: `data/${runId}-evidence-raw-frame.npy.dat`, size: 11 },
    { name: "histogram.csv", path: `data/${runId}-evidence-histogram.csv`, size: 14 },
  ]);
  assert.deepEqual(frame.attachmentsOmitted, [{ name: "hosts", reason: "outside the workspace" }]);
  assert.deepEqual(frame.properties, [{ name: "frames", value: 2 }]);
  // A passing test sends no output, and no evidence it does not have.
  assert.deepEqual(evidenceOf(frame), ["properties", "attachments", "attachmentsOmitted"]);
  // Every name the event references was uploaded, once, with its bytes.
  const evidenceUploads = received.artifacts.filter((name) => name.includes("-evidence-"));
  assert.deepEqual(
    [...evidenceUploads].sort(),
    (frame.attachments as Array<{ path: string }>).map((a) => a.path).sort(),
  );
  assert.match(received.bodies.get(`data/${runId}-evidence-frame.png`) ?? "", /fake frame/);
  assert.equal(received.bodies.get(`data/${runId}-evidence-histogram.csv`), "bin,count\n0,1\n");
}

test("a camera suite reports skip reasons, failures, measurements, output and saved files", needsPytest, async () => {
  const { received, byNodeId } = await runSuiteWith("", undefined, CAMERA);
  assertCameraEvidence(received, byNodeId);
});

test("under pytest-xdist the evidence arrives once, attachments from the workers included", needsPlugins, async () => {
  const { received, byNodeId } = await runSuiteWith("-n 2", undefined, CAMERA);
  assertCameraEvidence(received, byNodeId);
});

test("with pytest-rerunfailures only the final attempt's evidence is reported", needsPlugins, async () => {
  const { received, byNodeId } = await runSuiteWith(
    "--reruns 2",
    (suite) => {
      // Fails twice, passes the third time; records and saves per attempt.
      writeFileSync(
        path.join(suite, "tests", "test_flaky_camera.py"),
        [
          "import os",
          "def test_flaky(tmp_path_factory, record_property, peeps_artifacts_dir):",
          "    marker = os.path.join(str(tmp_path_factory.getbasetemp()), 'tries')",
          "    tries = int(open(marker).read()) + 1 if os.path.exists(marker) else 1",
          "    open(marker, 'w').write(str(tries))",
          "    record_property('attempt', tries)",
          "    (peeps_artifacts_dir / f'frame-{tries}.png').write_bytes(b'x')",
          "    assert tries >= 3, f'attempt {tries}'",
          "",
        ].join("\n"),
      );
    },
    CAMERA,
  );
  const runId = byNodeId["tests/test_flaky_camera.py::test_flaky"]!.runId;
  const ends = (received.events.get(runId) ?? []).filter((e) => e.type === "test_end");
  assert.deepEqual(
    ends.map((e) => e.status),
    ["failed", "failed", "passed"],
  );
  // The retried attempts' test_ends are as they always were.
  assert.equal("properties" in ends[0]!, false);
  assert.equal("failure" in ends[1]!, false);
  assert.equal("attachments" in ends[1]!, false);
  // The final one: its own property, not every attempt's, and its own frame.
  assert.deepEqual(ends[2]!.properties, [{ name: "attempt", value: 3 }]);
  assert.deepEqual(ends[2]!.attachments, [
    { name: "frame-3.png", path: `data/${runId}-evidence-frame-3.png`, size: 1 },
  ]);
  assert.deepEqual(
    received.artifacts.filter((name) => name.startsWith(`data/${runId}-`)),
    [`data/${runId}-evidence-frame-3.png`],
  );
  // A test that fails on every attempt reports its final failure.
  const sharp = (received.events.get(byNodeId["tests/test_camera.py::test_sharpness"]!.runId) ?? []).filter(
    (e) => e.type === "test_end",
  );
  assert.equal(sharp.length, 3);
  assert.equal("failure" in sharp[1]!, false);
  assert.equal((sharp[2]!.failure as Record<string, unknown>).phase, "call");
  assert.equal((sharp[2]!.properties as unknown[]).length, 5);
});

test("only plain files the plugin staged for a run of this job are uploaded", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "peeps-staged-"));
  const run: PlanEntry = { runId: "run-7", path: "a.py", titlePath: "t", pwProject: "", credential: { exp: 1, sig: "s" } };
  writeFileSync(path.join(dir, "run-7-evidence-frame.png"), "x");
  writeFileSync(path.join(dir, "run-8-evidence-frame.png"), "x"); // not this job's run
  writeFileSync(path.join(dir, "run-7-evidence-a b.png"), "x"); // not a name the plugin writes
  symlinkSync("/etc/hosts", path.join(dir, "run-7-evidence-hosts.txt"));
  mkdirSync(path.join(dir, "run-7-evidence-dir.png"));
  const staged = await stagedEvidence(dir, { "a.py::t": run });
  assert.deepEqual(
    staged.map((s) => [s.name, s.runId]),
    [["run-7-evidence-frame.png", "run-7"]],
  );
  assert.deepEqual(await stagedEvidence(path.join(dir, "missing"), { "a.py::t": run }), []);
});
