/**
 * A pytest suite whose repository is connected to several projects: every run of a test hears
 * it, and files named by run are named for each batch's own run. Real pytest, through the
 * committed action where it can be; pytest-playwright's output is only reachable below that.
 */
import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { cpSync, mkdirSync, mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { readRunnerEnv } from "../src/env";
import { PeepsClient } from "../src/peeps";
import { collectPytest, executePytestAndReport, nodeIdsForRuns, plannedPytestTests } from "../src/pytest";
import type { PlanEntry } from "../src/reporter";
import {
  announceOf,
  eventsByRun,
  fakePeeps,
  pytestAvailable,
  pytestJob,
  shape,
  signatureOf,
  suite,
  suiteFrom,
  type BatchSpec,
} from "./support/ci-job";

const CAMERA = path.join(__dirname, "fixtures", "pytest-camera");
const SUITE = path.join(__dirname, "fixtures", "pytest-suite");
const needsPytest = pytestAvailable();
const everything = (name: string): BatchSpec => ({ name, picks: () => true });

type PlannedNode = ReturnType<typeof plannedPytestTests>[number];

const uploadsOf = (requests: Array<{ pathname: string; artifact: string | null }>, batch: string) =>
  requests.filter((v) => v.pathname === `/api/v1/ci/batches/batch-${batch}/artifacts`).map((v) => v.artifact!).sort();

test("two batches each hear every test under their own credential, with evidence named for their own run", needsPytest, async (t) => {
  const root = await suiteFrom(t, CAMERA);
  const peeps = await fakePeeps(t, { batches: [everything("a"), everything("b")] });
  const { code, output } = await pytestJob(root, peeps.url);
  assert.equal(code, 1, output);
  assert.match(output, /\[peeps\] reporting 10 planned run\(s\)/, "the log counts runs, not tests");
  assert.equal(announceOf(peeps.requests).reportsEveryBatch, true);

  const sent = eventsByRun(peeps.requests);
  assert.equal(sent.size, 10);
  for (const name of ["a", "b"]) {
    const runId = `${name}-test_saves_frame`;
    assert.deepEqual(shape(sent.get(runId)), ["run_start", "test_start", "test_end(passed,0)", "run_end"]);
    const post = peeps.requests.find((v) => v.pathname === `/api/v1/runs/${runId}/events`)!;
    assert.equal(post.authorization, `Bearer v1.99.${signatureOf(runId)}`);
    const end = sent.get(runId)!.find((e) => e.type === "test_end") as unknown as {
      attachments: Array<{ name: string; path: string; size: number }>;
      attachmentsOmitted: Array<{ name: string; reason: string }>;
    };
    assert.deepEqual(end.attachments, [
      { name: "frame.png", path: `data/${runId}-evidence-frame.png`, size: 19 },
      { name: "raw/frame.npy", path: `data/${runId}-evidence-raw-frame.npy.dat`, size: 11 },
      { name: "histogram.csv", path: `data/${runId}-evidence-histogram.csv`, size: 14 },
      { name: "session.log", path: `data/${runId}-evidence-session.log`, size: 7 },
    ]);
    assert.deepEqual(end.attachmentsOmitted, [
      { name: ".env", reason: "refused name" },
      { name: "hosts", reason: "outside the workspace" },
    ]);
    // Each batch holds its own run's files, and only those, with their bytes.
    assert.deepEqual(uploadsOf(peeps.requests, name), end.attachments.map((a) => a.path).sort());
    const frame = peeps.requests.find((v) => v.artifact === `data/${runId}-evidence-frame.png`)!;
    assert.match(frame.text, /fake frame/);
  }
  // The failure's text reaches both, once each.
  const failure = (name: string) => sent.get(`${name}-test_sharpness`)!.find((e) => e.type === "test_end")!;
  assert.equal(failure("a").status, "failed");
  assert.equal(failure("b").error, failure("a").error);
});

test("a test only one batch planned reaches only that batch's run", needsPytest, async (t) => {
  const root = await suiteFrom(t, CAMERA);
  const peeps = await fakePeeps(t, {
    batches: [{ name: "a", picks: (v) => v.titlePath === "test_saves_frame" }, everything("b")],
  });
  await pytestJob(root, peeps.url);
  const sent = eventsByRun(peeps.requests);
  assert.deepEqual([...sent.keys()].filter((v) => v.startsWith("a-")), ["a-test_saves_frame"]);
  assert.equal([...sent.keys()].filter((v) => v.startsWith("b-")).length, 5);
});

test("a retried test: each attempt reaches both runs, evidence on the final attempt's only", needsPytest, async (t) => {
  const root = await suite(t, {
    "pytest.ini": "[pytest]\ntestpaths = tests\n",
    "tests/test_flaky.py": `import os, pathlib
def test_flaky(request, peeps_artifacts_dir):
    (peeps_artifacts_dir / "note.txt").write_text("attempt")
    marker = pathlib.Path(os.environ["RUNNER_TEMP"]) / "tried"
    if not marker.exists():
        marker.write_text("x")
        assert False, "first attempt"
`,
  });
  const peeps = await fakePeeps(t, { batches: [everything("a"), everything("b")] });
  const { output } = await pytestJob(root, peeps.url, { PYTEST_ADDOPTS: "--reruns 1" });
  const sent = eventsByRun(peeps.requests);
  for (const name of ["a", "b"]) {
    const events = sent.get(`${name}-test_flaky`);
    assert.deepEqual(shape(events), ["run_start", "test_start", "test_end(failed,0)", "test_start", "test_end(passed,1)", "run_end"], output);
    const [retried, final] = events!.filter((e) => e.type === "test_end") as unknown as Array<{ attachments?: unknown }>;
    assert.equal(retried!.attachments, undefined);
    assert.deepEqual(final!.attachments, [{ name: "note.txt", path: `data/${name}-test_flaky-evidence-note.txt`, size: 7 }]);
  }
});

test("under xdist the controller still reports every run once", needsPytest, async (t) => {
  const root = await suiteFrom(t, CAMERA);
  const peeps = await fakePeeps(t, { batches: [everything("a"), everything("b")] });
  await pytestJob(root, peeps.url, { PYTEST_ADDOPTS: "-n 2" });
  const sent = eventsByRun(peeps.requests);
  assert.equal(sent.size, 10);
  for (const events of sent.values()) {
    assert.deepEqual(shape(events).filter((v) => !v.startsWith("test_end")), ["run_start", "test_start", "run_end"]);
  }
});

test("copies for a sibling don't spend the session's file cap: later tests keep their evidence", needsPytest, async (t) => {
  // 30 tests of 20 files is 600 files, within the session's 1000. Charged per run it would be
  // 1200, and the last tests would lose theirs.
  const root = await suite(t, {
    "pytest.ini": "[pytest]\ntestpaths = tests\n",
    "tests/test_many.py": `import pytest
@pytest.mark.parametrize("n", range(30))
def test_frames(n, peeps_artifacts_dir):
    for i in range(20):
        (peeps_artifacts_dir / f"frame-{i}.txt").write_text("x")
`,
  });
  const peeps = await fakePeeps(t, { batches: [everything("a"), everything("b")] });
  const { output } = await pytestJob(root, peeps.url);
  assert.doesNotMatch(output, /session over/);
  for (const name of ["a", "b"]) assert.equal(uploadsOf(peeps.requests, name).length, 600);
  const last = (name: string) =>
    eventsByRun(peeps.requests).get(`${name}-test_frames_29_`)!.find((e) => e.type === "test_end") as unknown as { attachments: unknown[] };
  assert.equal(last("a").attachments.length, 20);
  assert.equal(last("b").attachments.length, 20);
});

test("delivery widens only when a test has several runs", needsPytest, async (t) => {
  const widest = async (batches: BatchSpec[]) => {
    const root = await suiteFrom(t, CAMERA);
    const peeps = await fakePeeps(t, { batches, eventDelayMs: 200 });
    const { output } = await pytestJob(root, peeps.url);
    assert.doesNotMatch(output, /gave up delivering/);
    return peeps.widestEventDelivery();
  };
  assert.equal(await widest([everything("only")]), 1, "a single project posts one at a time, as it always has");
  assert.ok((await widest([everything("a"), everything("b")])) > 1);
});

/** The suite with pytest-playwright's output, run for `batchesFor`'s batches, below the action. */
async function outputJob(
  t: TestContext,
  batchesFor: (planned: PlannedNode[]) => Array<{ name: string; nodes: PlannedNode[] }>,
) {
  const root = mkdtempSync(path.join(realpathSync(tmpdir()), "peeps-pytest-overlap-"));
  const e2e = path.join(root, "e2e");
  mkdirSync(e2e);
  cpSync(SUITE, e2e, { recursive: true });
  const peeps = await fakePeeps(t);
  const env = readRunnerEnv({ GITHUB_WORKSPACE: root, GITHUB_SHA: "f".repeat(40), "INPUT_WORKING-DIRECTORY": "e2e", PEEPS_API_URL: peeps.url });
  const saved = { key: process.env.PEEPS_API_KEY, code: process.exitCode, temp: process.env.RUNNER_TEMP };
  process.env.PEEPS_API_KEY = "test-key";
  process.env.RUNNER_TEMP = root;
  t.after(() => {
    process.exitCode = saved.code;
    if (saved.key === undefined) delete process.env.PEEPS_API_KEY;
    else process.env.PEEPS_API_KEY = saved.key;
    if (saved.temp === undefined) delete process.env.RUNNER_TEMP;
    else process.env.RUNNER_TEMP = saved.temp;
  });
  const collection = await collectPytest(env);
  const planned = plannedPytestTests(collection, "e2e");
  const batches = batchesFor(planned).map(({ name, nodes }) => ({
    name,
    runs: nodes.map((v, i): PlanEntry => ({
      runId: `${name}-${i}`, path: v.path, titlePath: v.titlePath, pwProject: v.pwProject,
      credential: { exp: 99, sig: signatureOf(`${name}-${i}`) },
    })),
  }));
  const { byNodeId } = nodeIdsForRuns(planned, batches.flatMap((b) => b.runs));
  await executePytestAndReport(env, new PeepsClient(env), {
    collection: { ...collection, playwright: true },
    byNodeId,
    batches: batches.map((b, n) => ({ batchId: `batch-${b.name}`, batchNumber: n + 1, runIds: b.runs.map((r) => r.runId) })),
  });
  process.exitCode = saved.code;
  return { byNodeId, requests: peeps.requests };
}

const OPENS = "tests/shop/test_cart.py::test_opens[chromium]";
const WRONG = "tests/shop/test_cart.py::test_total_is_wrong";

test("pytest-playwright's output is stored under each batch's own run", needsPytest, async (t) => {
  const { byNodeId, requests } = await outputJob(t, (planned) => [{ name: "a", nodes: planned }, { name: "b", nodes: planned }]);
  const [ofA, ofB] = byNodeId[OPENS]!;
  assert.ok(ofA && ofB && ofA.runId.startsWith("a-") && ofB.runId.startsWith("b-"));
  const a = uploadsOf(requests, "a");
  const b = uploadsOf(requests, "b");
  assert.ok(a.includes(`data/${ofA.runId}-trace.zip`), a.join(", "));
  assert.ok(b.includes(`data/${ofB.runId}-trace.zip`), b.join(", "));
  assert.ok(!a.includes(`data/${ofB.runId}-trace.zip`), "nothing is stored under another batch's run");
  assert.ok(!b.includes(`data/${ofA.runId}-trace.zip`));
});

test("with several batches, a batch stores only the output of tests it holds", needsPytest, async (t) => {
  const { requests } = await outputJob(t, (planned) => [
    { name: "a", nodes: planned.filter((v) => v.nodeId === OPENS) },
    { name: "b", nodes: planned.filter((v) => v.nodeId !== WRONG) },
  ]);
  const a = uploadsOf(requests, "a");
  const b = uploadsOf(requests, "b");
  assert.deepEqual(a, ["data/a-0-trace.zip"], "a planned one test, and no other project's files reach it");
  assert.ok(b.length > 0);
  assert.ok(b.every((name) => name.startsWith("data/b-")), `a test nobody planned reaches no batch: ${b.join(", ")}`);
});

test("one batch still stores the output of a test it didn't plan, flattened, as main did", needsPytest, async (t) => {
  const { requests } = await outputJob(t, (planned) => [{ name: "only", nodes: planned.filter((v) => v.nodeId !== WRONG) }]);
  const uploads = uploadsOf(requests, "only");
  assert.ok(uploads.some((name) => !name.startsWith("data/only-")), uploads.join(", "));
});

test("a run whose results file is missing still uploads, without a run in the names", needsPytest, async (t) => {
  const root = await suite(t, {
    "pytest.ini": "[pytest]\ntestpaths = tests\n",
    "tests/test_die.py": "import os\ndef test_dies():\n    os._exit(3)\n",
  });
  const peeps = await fakePeeps(t, { batches: [everything("a"), everything("b")] });
  const { code } = await pytestJob(root, peeps.url);
  assert.notEqual(code, 0);
  for (const name of ["a", "b"]) {
    assert.equal(peeps.requests.filter((v) => v.pathname === `/api/v1/ci/batches/batch-${name}/complete`).length, 1);
  }
});
