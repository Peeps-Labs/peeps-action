import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  MAX_VIDEO_BYTES,
  PeepsAppiumReporter,
  peepsAfterHook,
  peepsAfterTest,
  peepsBeforeHook,
  peepsBeforeTest,
  recordingOptions,
  resetForTests,
  setVideoToolsForTests,
  videoFrameOffsets,
  withPeeps,
  type AppiumPlanFile,
  type CaptureBrowser,
} from "../src/appium-reporter";
import { executeAppiumAndReport, ffmpegAvailable, recordVideoRunIdsOf } from "../src/appium";
import { readRunnerEnv } from "../src/env";
import { uploadEvidence } from "../src/pytest";
import { PeepsClient } from "../src/peeps";
import type { PlanEntry } from "../src/reporter";

const HAS_FFMPEG = spawnSync("ffmpeg", ["-version"]).status === 0 && spawnSync("ffprobe", ["-version"]).status === 0;

const SPEC = "/w/mobile/test/specs/checkout.spec.ts";
const REL = "mobile/test/specs/checkout.spec.ts";

const run = (runId: string, titlePath: string): PlanEntry => ({
  runId,
  path: REL,
  titlePath,
  pwProject: "",
  credential: { exp: 99, sig: `sig-${runId}` },
});

/** A mocha Test as WebdriverIO's hooks see it, with a running timeout. */
function mochaTest(titles: string[], timeout = 60_000) {
  const calls: number[] = [];
  let current = timeout;
  return {
    calls,
    title: titles.at(-1),
    file: SPEC,
    titlePath: () => titles,
    timeout(ms?: number) {
      if (ms === undefined) return current;
      calls.push(ms);
      current = ms;
      return this;
    },
  };
}

interface Recorder {
  starts: Array<Record<string, unknown> | undefined>;
  stops: number;
}

/** A WebdriverIO browser on a device; `video` is what stopRecordingScreen returns. */
function device(
  recorder: Recorder,
  over: Partial<CaptureBrowser> & { video?: Buffer; platform?: "android" | "ios" } = {},
): CaptureBrowser {
  const { video = Buffer.from("MP4!"), platform = "android", ...rest } = over;
  return {
    isMobile: true,
    isAndroid: platform === "android",
    isIOS: platform === "ios",
    saveScreenshot: async (file: string) => writeFileSync(file, "PNG!"),
    getPageSource: async () => '<?xml version="1.0"?><hierarchy/>',
    getContext: async () => "NATIVE_APP",
    startRecordingScreen: async (options?: Record<string, unknown>) => {
      recorder.starts.push(options);
      return null;
    },
    stopRecordingScreen: async () => {
      recorder.stops += 1;
      return video.toString("base64");
    },
    ...rest,
  };
}

async function fakePeeps(): Promise<{ url: string; events: Map<string, Array<Record<string, unknown>>>; close: () => void }> {
  const events = new Map<string, Array<Record<string, unknown>>>();
  const read = (req: IncomingMessage) =>
    new Promise<string>((resolve) => {
      let data = "";
      req.on("data", (c: Buffer) => (data += c.toString("utf8")));
      req.on("end", () => resolve(data));
    });
  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://x");
    const text = await read(req);
    const match = url.pathname.match(/^\/api\/v1\/runs\/([^/]+)\/events$/);
    if (match) {
      const list = events.get(match[1]!) ?? [];
      list.push(...(JSON.parse(text) as { events: Array<Record<string, unknown>> }).events);
      events.set(match[1]!, list);
    }
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end("{}");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return { url: `http://127.0.0.1:${port}`, events, close: () => server.close() };
}

function usePlan(peepsUrl: string, runs: PlanEntry[], extra: Partial<AppiumPlanFile> = {}): string {
  const dir = mkdtempSync(path.join(tmpdir(), "peeps-video-"));
  const plan: AppiumPlanFile = { peepsUrl, workspace: "/w", runs, ...extra };
  writeFileSync(path.join(dir, "plan.json"), JSON.stringify(plan));
  mkdirSync(path.join(dir, "evidence"));
  process.env.PEEPS_PLAN_FILE = path.join(dir, "plan.json");
  process.env.PEEPS_ARTIFACTS_DIR = path.join(dir, "evidence");
  resetForTests();
  return dir;
}

async function synchronised(reporter: PeepsAppiumReporter): Promise<void> {
  for (let i = 0; i < 200 && !reporter.isSynchronised; i++) await new Promise((r) => setTimeout(r, 10));
  assert.equal(reporter.isSynchronised, true);
}

const setBrowser = (browser: CaptureBrowser | undefined) => {
  (globalThis as { browser?: unknown }).browser = browser;
};

/** One test through the hooks and the reporter, as a WebdriverIO worker runs it. */
async function runOne(
  reporter: PeepsAppiumReporter,
  titles: string[],
  outcome: "pass" | "fail",
  testTimeout = 60_000,
) {
  const t = mochaTest(titles, testTimeout);
  const error = { name: "Error", message: "element wasn't found", stack: "Error: element wasn't found" };
  reporter.emit("suite:start", { title: titles[0], file: SPEC });
  reporter.emit("test:start", { title: titles.at(-1), file: SPEC });
  await peepsBeforeTest({}, { test: t });
  await peepsAfterTest({}, { test: t }, outcome === "pass" ? { passed: true } : { passed: false, error });
  reporter.emit(outcome === "pass" ? "test:pass" : "test:fail", {
    title: titles.at(-1),
    file: SPEC,
    duration: 10,
    ...(outcome === "fail" ? { error } : {}),
  });
  reporter.emit("suite:end", { title: titles[0] });
  return t;
}

const endOf = (events: Map<string, Array<Record<string, unknown>>>, runId: string) =>
  events.get(runId)?.find((e) => e.type === "test_end");

test("withPeeps appends beforeTest and beforeHook after the customer's own", () => {
  const theirs = () => undefined;
  const config = withPeeps({ beforeTest: theirs, beforeHook: [theirs] });
  assert.deepEqual(config.beforeTest, [theirs, peepsBeforeTest]);
  assert.deepEqual(config.beforeHook, [theirs, peepsBeforeHook]);
  assert.deepEqual(withPeeps({}).beforeTest, [peepsBeforeTest]);
});

test("an older Peeps sends no video run ids: nothing records", async () => {
  const peeps = await fakePeeps();
  try {
    const recorder: Recorder = { starts: [], stops: 0 };
    usePlan(peeps.url, [run("r-1", "Checkout › pays")]);
    setBrowser(device(recorder));
    const reporter = new PeepsAppiumReporter({});
    await runOne(reporter, ["Checkout", "pays"], "pass");
    reporter.emit("runner:end", {});
    await synchronised(reporter);
    assert.equal(recorder.starts.length, 0);
    assert.equal(recorder.stops, 0);
    assert.equal("attachments" in endOf(peeps.events, "r-1")!, false);
  } finally {
    setBrowser(undefined);
    peeps.close();
  }
});

test("only the runs Peeps names are recorded", async () => {
  const peeps = await fakePeeps();
  try {
    const recorder: Recorder = { starts: [], stops: 0 };
    usePlan(peeps.url, [run("r-on", "Checkout › pays"), run("r-off", "Checkout › refunds")], {
      recordVideoRunIds: ["r-on"],
      ffmpeg: true,
    });
    setBrowser(device(recorder));
    const reporter = new PeepsAppiumReporter({});
    await runOne(reporter, ["Checkout", "pays"], "pass");
    await runOne(reporter, ["Checkout", "refunds"], "pass");
    reporter.emit("runner:end", {});
    await synchronised(reporter);
    assert.equal(recorder.starts.length, 1);
    assert.deepEqual(endOf(peeps.events, "r-on")!.attachments, [
      { name: "video.mp4", path: "data/r-on-evidence-video.mp4", size: 4 },
    ]);
    assert.equal("attachments" in endOf(peeps.events, "r-off")!, false);
  } finally {
    setBrowser(undefined);
    peeps.close();
  }
});

test("a passing test sends its video and nothing a failure would", async () => {
  const peeps = await fakePeeps();
  try {
    const recorder: Recorder = { starts: [], stops: 0 };
    const dir = usePlan(peeps.url, [run("r-1", "Checkout › pays")], { recordVideoRunIds: ["r-1"], ffmpeg: true });
    setBrowser(device(recorder));
    const reporter = new PeepsAppiumReporter({});
    const t = await runOne(reporter, ["Checkout", "pays"], "pass");
    reporter.emit("runner:end", {});
    await synchronised(reporter);
    const end = endOf(peeps.events, "r-1")!;
    assert.equal(end.status, "passed");
    assert.deepEqual(end.attachments, [{ name: "video.mp4", path: "data/r-1-evidence-video.mp4", size: 4 }]);
    assert.equal("failure" in end, false);
    assert.equal("properties" in end, false);
    assert.deepEqual(readdirSync(path.join(dir, "evidence", "upload")), ["r-1-evidence-video.mp4"]);
    assert.equal(readFileSync(path.join(dir, "evidence", "upload", "r-1-evidence-video.mp4"), "utf8"), "MP4!");
    // The stop runs inside the test's own timeout, so it is given room first.
    assert.ok(t.calls.length > 0 && t.calls.at(-1)! >= 60_000);
  } finally {
    setBrowser(undefined);
    peeps.close();
  }
});

test("a test with no timeout keeps none", async () => {
  const peeps = await fakePeeps();
  try {
    const recorder: Recorder = { starts: [], stops: 0 };
    usePlan(peeps.url, [run("r-1", "Checkout › pays")], { recordVideoRunIds: ["r-1"], ffmpeg: true });
    setBrowser(device(recorder));
    const reporter = new PeepsAppiumReporter({});
    const t = await runOne(reporter, ["Checkout", "pays"], "pass", 0);
    assert.deepEqual(t.calls, []);
  } finally {
    setBrowser(undefined);
    peeps.close();
  }
});

test("recording options: Android's own recorder at 1 Mbps, iOS H.264 a browser plays; 30 minutes only with ffmpeg", () => {
  const recorder: Recorder = { starts: [], stops: 0 };
  assert.deepEqual(recordingOptions(device(recorder, { platform: "android" }), true), {
    bitRate: 1_000_000,
    timeLimit: 1800,
    forceRestart: true,
  });
  // Above 180 s the Android driver joins chunks with ffmpeg; without it, it refuses to start.
  assert.equal(recordingOptions(device(recorder, { platform: "android" }), false)?.timeLimit, 180);
  assert.deepEqual(recordingOptions(device(recorder, { platform: "ios" }), true), {
    videoType: "libx264",
    videoQuality: "medium",
    videoFps: 10,
    videoScale: "720:-2",
    pixelFormat: "yuv420p",
    timeLimit: 1800,
    forceRestart: true,
  });
  // The iOS driver encodes with ffmpeg on the runner: without it there is nothing to record with.
  assert.equal(recordingOptions(device(recorder, { platform: "ios" }), false), null);
});

test("iOS without ffmpeg: no recording, and the test says why", async () => {
  const peeps = await fakePeeps();
  try {
    const recorder: Recorder = { starts: [], stops: 0 };
    usePlan(peeps.url, [run("r-1", "Checkout › pays")], { recordVideoRunIds: ["r-1"], ffmpeg: false });
    setBrowser(device(recorder, { platform: "ios" }));
    const reporter = new PeepsAppiumReporter({});
    await runOne(reporter, ["Checkout", "pays"], "pass");
    reporter.emit("runner:end", {});
    await synchronised(reporter);
    assert.equal(recorder.starts.length, 0);
    assert.deepEqual(endOf(peeps.events, "r-1")!.attachmentsOmitted, [
      { name: "video.mp4", reason: "not recorded: ffmpeg was not found on the runner" },
    ]);
  } finally {
    setBrowser(undefined);
    peeps.close();
  }
});

test("a recorder that fails never fails the test, says why, and is not tried again in that worker", async () => {
  const peeps = await fakePeeps();
  try {
    const recorder: Recorder = { starts: [], stops: 0 };
    usePlan(peeps.url, [run("r-1", "Checkout › pays"), run("r-2", "Checkout › refunds")], {
      recordVideoRunIds: ["r-1", "r-2"],
      ffmpeg: true,
    });
    let tries = 0;
    setBrowser(
      device(recorder, {
        startRecordingScreen: async () => {
          tries += 1;
          throw new Error("screenrecord: not supported\nmore");
        },
      }),
    );
    const reporter = new PeepsAppiumReporter({});
    await runOne(reporter, ["Checkout", "pays"], "pass");
    await runOne(reporter, ["Checkout", "refunds"], "pass");
    reporter.emit("runner:end", {});
    await synchronised(reporter);
    assert.equal(tries, 1);
    assert.equal(recorder.stops, 0);
    for (const id of ["r-1", "r-2"]) {
      const end = endOf(peeps.events, id)!;
      assert.equal(end.status, "passed");
      assert.deepEqual(end.attachmentsOmitted, [{ name: "video.mp4", reason: "capture failed: screenrecord: not supported" }]);
    }
  } finally {
    setBrowser(undefined);
    peeps.close();
  }
});

test("a stop that fails is listed as omitted", async () => {
  const peeps = await fakePeeps();
  try {
    const recorder: Recorder = { starts: [], stops: 0 };
    usePlan(peeps.url, [run("r-1", "Checkout › pays")], { recordVideoRunIds: ["r-1"], ffmpeg: true });
    setBrowser(
      device(recorder, {
        stopRecordingScreen: async () => {
          throw new Error("session gone");
        },
      }),
    );
    const reporter = new PeepsAppiumReporter({});
    await runOne(reporter, ["Checkout", "pays"], "pass");
    reporter.emit("runner:end", {});
    await synchronised(reporter);
    assert.deepEqual(endOf(peeps.events, "r-1")!.attachmentsOmitted, [{ name: "video.mp4", reason: "capture failed: session gone" }]);
  } finally {
    setBrowser(undefined);
    peeps.close();
  }
});

test("a failed test sends its screenshot, page source, video and frames from the end of the video, in that order", async () => {
  const peeps = await fakePeeps();
  try {
    const recorder: Recorder = { starts: [], stops: 0 };
    const dir = usePlan(peeps.url, [run("r-1", "Checkout › pays")], { recordVideoRunIds: ["r-1"], ffmpeg: true });
    const asked: number[] = [];
    setVideoToolsForTests({
      durationMs: async () => 30_000,
      frame: async (_video, positionMs, out) => {
        asked.push(positionMs);
        writeFileSync(out, "JPG!");
      },
    });
    setBrowser(device(recorder));
    const reporter = new PeepsAppiumReporter({});
    await runOne(reporter, ["Checkout", "pays"], "fail");
    reporter.emit("runner:end", {});
    await synchronised(reporter);
    const end = endOf(peeps.events, "r-1")!;
    const names = (end.attachments as Array<{ name: string }>).map((a) => a.name);
    assert.deepEqual(names, [
      "screenshot.png",
      "page-source.xml",
      "video.mp4",
      "video-frame-0010000.jpg",
      "video-frame-0018000.jpg",
      "video-frame-0022000.jpg",
      "video-frame-0025000.jpg",
      "video-frame-0027000.jpg",
      "video-frame-0028000.jpg",
      "video-frame-0029000.jpg",
      "video-frame-0029800.jpg",
    ]);
    assert.deepEqual(asked, [10_000, 18_000, 22_000, 25_000, 27_000, 28_000, 29_000, 29_800]);
    assert.ok(readdirSync(path.join(dir, "evidence", "upload")).includes("r-1-evidence-video-frame-0029800.jpg"));
  } finally {
    setVideoToolsForTests(null);
    setBrowser(undefined);
    peeps.close();
  }
});

test("without ffmpeg on Android the video is kept and the frames are said to be missing", async () => {
  const peeps = await fakePeeps();
  try {
    const recorder: Recorder = { starts: [], stops: 0 };
    usePlan(peeps.url, [run("r-1", "Checkout › pays")], { recordVideoRunIds: ["r-1"], ffmpeg: false });
    setBrowser(device(recorder));
    const reporter = new PeepsAppiumReporter({});
    await runOne(reporter, ["Checkout", "pays"], "fail");
    reporter.emit("runner:end", {});
    await synchronised(reporter);
    const end = endOf(peeps.events, "r-1")!;
    assert.deepEqual((end.attachments as Array<{ name: string }>).map((a) => a.name), ["screenshot.png", "page-source.xml", "video.mp4"]);
    assert.deepEqual(end.attachmentsOmitted, [{ name: "video frames", reason: "not extracted: ffmpeg was not found on the runner" }]);
  } finally {
    setBrowser(undefined);
    peeps.close();
  }
});

test("a video over the limit is omitted, and its frames are still cut from it", async () => {
  const peeps = await fakePeeps();
  try {
    const recorder: Recorder = { starts: [], stops: 0 };
    const dir = usePlan(peeps.url, [run("r-1", "Checkout › pays")], { recordVideoRunIds: ["r-1"], ffmpeg: true });
    setVideoToolsForTests({
      durationMs: async () => 500,
      frame: async (_video, _ms, out) => writeFileSync(out, "JPG!"),
    });
    setBrowser(device(recorder, { video: Buffer.alloc(MAX_VIDEO_BYTES + 1) }));
    const reporter = new PeepsAppiumReporter({});
    await runOne(reporter, ["Checkout", "pays"], "fail");
    reporter.emit("runner:end", {});
    await synchronised(reporter);
    const end = endOf(peeps.events, "r-1")!;
    assert.deepEqual(end.attachmentsOmitted, [{ name: "video.mp4", reason: `larger than ${MAX_VIDEO_BYTES} bytes` }]);
    const names = (end.attachments as Array<{ name: string }>).map((a) => a.name);
    assert.ok(names.includes("video-frame-0000300.jpg"));
    assert.equal(readdirSync(path.join(dir, "evidence", "upload")).some((n) => n.endsWith("video.mp4")), false);
  } finally {
    setVideoToolsForTests(null);
    setBrowser(undefined);
    peeps.close();
  }
});

test("frame positions: the last 20 seconds, densest at the end, within the video", () => {
  assert.deepEqual(videoFrameOffsets(30_000), [10_000, 18_000, 22_000, 25_000, 27_000, 28_000, 29_000, 29_800]);
  assert.deepEqual(videoFrameOffsets(4_000), [0, 1_000, 2_000, 3_000, 3_800]);
  assert.deepEqual(videoFrameOffsets(500), [0, 300]);
  assert.deepEqual(videoFrameOffsets(100), [0]);
  assert.deepEqual(videoFrameOffsets(0), []);
  assert.deepEqual(videoFrameOffsets(Number.NaN), []);
});

test("a retried attempt's video is discarded; only the final attempt's is sent", async () => {
  const peeps = await fakePeeps();
  try {
    const recorder: Recorder = { starts: [], stops: 0 };
    const dir = usePlan(peeps.url, [run("r-1", "Checkout › flaky")], { recordVideoRunIds: ["r-1"], ffmpeg: true });
    setVideoToolsForTests({ durationMs: async () => 1_000, frame: async (_v, _m, out) => writeFileSync(out, "JPG!") });
    let n = 0;
    setBrowser(device(recorder, { stopRecordingScreen: async () => Buffer.from(`MP4-${++n}`).toString("base64") }));
    const reporter = new PeepsAppiumReporter({});
    const t = mochaTest(["Checkout", "flaky"]);
    reporter.emit("suite:start", { title: "Checkout", file: SPEC });
    reporter.emit("test:start", { title: "flaky", file: SPEC });
    await peepsBeforeTest({}, { test: t });
    await peepsAfterTest({}, { test: t }, { passed: false, error: new Error("flake") });
    reporter.emit("test:retry", { title: "flaky", file: SPEC, error: { message: "flake" } });
    reporter.emit("test:start", { title: "flaky", file: SPEC });
    await peepsBeforeTest({}, { test: t });
    await peepsAfterTest({}, { test: t }, { passed: true });
    reporter.emit("test:pass", { title: "flaky", file: SPEC });
    reporter.emit("runner:end", {});
    await synchronised(reporter);
    assert.equal(recorder.starts.length, 2);
    assert.deepEqual(readdirSync(path.join(dir, "evidence", "upload")), ["r-1-evidence-video.mp4"]);
    assert.equal(readFileSync(path.join(dir, "evidence", "upload", "r-1-evidence-video.mp4"), "utf8"), "MP4-2");
    const ends = peeps.events.get("r-1")!.filter((e) => e.type === "test_end");
    assert.equal("attachments" in ends[0]!, false);
    assert.deepEqual((ends[1]!.attachments as Array<{ name: string }>).map((a) => a.name), ["video.mp4"]);
  } finally {
    setVideoToolsForTests(null);
    setBrowser(undefined);
    peeps.close();
  }
});

test("recording starts with the test's first beforeEach, so a failed one is on video and sent with the setup failure", async () => {
  const peeps = await fakePeeps();
  try {
    const recorder: Recorder = { starts: [], stops: 0 };
    usePlan(peeps.url, [run("r-1", "Checkout › pays")], { recordVideoRunIds: ["r-1"], ffmpeg: false });
    setBrowser(device(recorder));
    const reporter = new PeepsAppiumReporter({});
    const t = mochaTest(["Checkout", "pays"]);
    const error = { name: "Error", message: "app did not launch" };
    reporter.emit("suite:start", { title: "Checkout", file: SPEC });
    const hook = { title: '"before each" hook for "pays"' };
    await peepsBeforeHook({}, { test: hook, currentTest: t });
    // A second beforeEach of the same test does not restart it.
    await peepsBeforeHook({}, { test: hook, currentTest: t });
    // Other hooks never start one.
    await peepsBeforeHook({}, { test: { title: '"before all" hook' }, currentTest: t });
    assert.equal(recorder.starts.length, 1);
    await peepsAfterHook({}, { test: { title: '"before each" hook for "pays"' }, currentTest: t }, { passed: false, error });
    reporter.emit("hook:end", { title: '"before each" hook for "pays"', parent: "Checkout", file: SPEC, error });
    reporter.emit("runner:end", {});
    await synchronised(reporter);
    const end = endOf(peeps.events, "r-1")!;
    assert.deepEqual((end.attachments as Array<{ name: string }>).map((a) => a.name), ["screenshot.png", "page-source.xml", "video.mp4"]);
    assert.equal(recorder.stops, 1);
  } finally {
    setBrowser(undefined);
    peeps.close();
  }
});

test("a browser without a recorder (not a device) is left alone", async () => {
  const peeps = await fakePeeps();
  try {
    usePlan(peeps.url, [run("r-1", "Checkout › pays")], { recordVideoRunIds: ["r-1"], ffmpeg: true });
    const recorder: Recorder = { starts: [], stops: 0 };
    const { startRecordingScreen: _s, stopRecordingScreen: _t, ...web } = device(recorder);
    setBrowser({ ...web, isMobile: false });
    const reporter = new PeepsAppiumReporter({});
    await runOne(reporter, ["Checkout", "pays"], "pass");
    reporter.emit("runner:end", {});
    await synchronised(reporter);
    assert.equal("attachments" in endOf(peeps.events, "r-1")!, false);
    assert.equal("attachmentsOmitted" in endOf(peeps.events, "r-1")!, false);
  } finally {
    setBrowser(undefined);
    peeps.close();
  }
});

test("uploads: a video may be larger than other evidence", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "peeps-upload-"));
  const big = 30 * 1024 * 1024;
  writeFileSync(path.join(dir, "r-1-evidence-video.mp4"), Buffer.alloc(big));
  writeFileSync(path.join(dir, "r-1-evidence-screenshot.png"), Buffer.alloc(big));
  writeFileSync(path.join(dir, "r-1-evidence-huge-video.mp4"), Buffer.alloc(MAX_VIDEO_BYTES + 1));
  const posted: string[] = [];
  const peeps = { postBytes: async (p: string) => void posted.push(p) } as unknown as PeepsClient;
  const files = readdirSync(dir).map((name) => ({ abs: path.join(dir, name), name }));
  assert.equal(await uploadEvidence(peeps, "b-1", files), 1);
  assert.deepEqual(posted, [`/api/v1/ci/batches/b-1/artifacts?path=${encodeURIComponent("data/r-1-evidence-video.mp4")}`]);
});

test("real ffmpeg: frames are JPEGs cut from the recording", { skip: !HAS_FFMPEG }, async () => {
  const peeps = await fakePeeps();
  try {
    const scratch = mkdtempSync(path.join(tmpdir(), "peeps-real-video-"));
    const mp4 = path.join(scratch, "in.mp4");
    execFileSync("ffmpeg", ["-v", "error", "-f", "lavfi", "-i", "testsrc=size=320x240:rate=10:duration=3", "-pix_fmt", "yuv420p", mp4]);
    const recorder: Recorder = { starts: [], stops: 0 };
    const dir = usePlan(peeps.url, [run("r-1", "Checkout › pays")], { recordVideoRunIds: ["r-1"], ffmpeg: true });
    setBrowser(device(recorder, { video: readFileSync(mp4) }));
    const reporter = new PeepsAppiumReporter({});
    await runOne(reporter, ["Checkout", "pays"], "fail");
    reporter.emit("runner:end", {});
    await synchronised(reporter);
    const frames = readdirSync(path.join(dir, "evidence", "upload")).filter((n) => n.includes("video-frame-"));
    assert.deepEqual(frames.sort(), [
      "r-1-evidence-video-frame-0000000.jpg",
      "r-1-evidence-video-frame-0001000.jpg",
      "r-1-evidence-video-frame-0002000.jpg",
      "r-1-evidence-video-frame-0002800.jpg",
    ]);
    for (const name of frames) {
      const bytes = readFileSync(path.join(dir, "evidence", "upload", name));
      assert.equal(bytes[0], 0xff);
      assert.equal(bytes[1], 0xd8);
      assert.ok(statSync(path.join(dir, "evidence", "upload", name)).size > 100);
    }
  } finally {
    setBrowser(undefined);
    peeps.close();
  }
});

test("the batches Peeps asked to record name their runs; an older Peeps names none", () => {
  const batches = [
    { recordVideo: true, runs: [run("r-1", "A › one"), run("r-2", "A › two")] },
    { recordVideo: false, runs: [run("r-3", "B › three")] },
    { runs: [run("r-4", "C › four")] },
  ];
  assert.deepEqual(recordVideoRunIdsOf(batches), ["r-1", "r-2"]);
  assert.deepEqual(recordVideoRunIdsOf([{ runs: [run("r-5", "D › five")] }]), []);
});

test("a run with video asked for tells its workers which runs, and whether ffmpeg is here", async () => {
  const peeps = await fakePeeps();
  process.env.PEEPS_API_KEY = "test-key";
  const exitCode = process.exitCode;
  try {
    const root = mkdtempSync(path.join(tmpdir(), "peeps-video-run-"));
    const config = path.join(root, "wdio.conf.mjs");
    writeFileSync(config, "export const config = { capabilities: [{}] };\n");
    const env = readRunnerEnv({ GITHUB_WORKSPACE: root, GITHUB_SHA: "0".repeat(40), PEEPS_API_URL: peeps.url });
    const plans: AppiumPlanFile[] = [];
    const runner = async (_wrapper: string, extra: Record<string, string>) => {
      plans.push(JSON.parse(readFileSync(extra.PEEPS_PLAN_FILE!, "utf8")) as AppiumPlanFile);
      return 0;
    };
    const runs = [run("r-1", "A › one")];
    await executeAppiumAndReport(env, new PeepsClient(env), {
      configPath: config,
      runs,
      batches: [{ batchId: "b-1", batchNumber: 1 }],
      recordVideoRunIds: ["r-1"],
      ffmpegCheck: async () => true,
      runner,
    });
    await executeAppiumAndReport(env, new PeepsClient(env), {
      configPath: config,
      runs,
      batches: [{ batchId: "b-1", batchNumber: 1 }],
      ffmpegCheck: async () => assert.fail("not checked when nothing records"),
      runner,
    });
    assert.deepEqual(plans[0]!.recordVideoRunIds, ["r-1"]);
    assert.equal(plans[0]!.ffmpeg, true);
    assert.equal("recordVideoRunIds" in plans[1]!, false);
    assert.equal("ffmpeg" in plans[1]!, false);
  } finally {
    process.exitCode = exitCode;
    peeps.close();
  }
});

test("ffmpeg is found only when both ffmpeg and ffprobe run", async () => {
  assert.equal(await ffmpegAvailable(), HAS_FFMPEG);
  assert.equal(await ffmpegAvailable("/nonexistent/bin"), false);
});
