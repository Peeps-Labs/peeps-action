/**
 * Runs the committed `dist/load.js` (and through it `dist/load-executor.js`) in its own
 * process, so a test can stop, freeze or kill it like a job. Usage:
 *
 *   node --import tsx test/support/run-engine.ts <config.json>
 *
 * The config names the plan input, engine options, the fake port's script and two files: an
 * events file (one JSON line per engine event, plus the port's renewals and markers) and a
 * result file written at the end.
 */
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

import { FakeControlPort, type PortScript } from "./fake-control-port";

interface Config {
  planInput: unknown;
  options: Record<string, unknown>;
  port?: PortScript;
  eventsFile: string;
  resultFile: string;
  /** Call handle.stop() this many ms after start. */
  stopAfterMs?: number;
  stopMode?: "graceful" | "now";
}

const config = JSON.parse(readFileSync(process.argv[2]!, "utf8")) as Config;
// eslint-disable-next-line @typescript-eslint/no-require-imports
const engine = require(path.resolve(__dirname, "../../dist/load.js")) as typeof import("../../src/load/engine");
const port = new FakeControlPort(config.port);
const write = (event: unknown) => appendFileSync(config.eventsFile, JSON.stringify(event) + "\n");

const handle = engine.startEngine(config.planInput, port, {
  executorPath: path.resolve(__dirname, "../../dist/load-executor.js"),
  ...(config.options as unknown as import("../../src/load/supervisor").EngineOptions),
  observer: (event) => write({ ...event, at: Date.now() }),
});
write({ type: "harness", pid: process.pid, at: Date.now() });
// A test stops the run at a moment it chooses: SIGUSR1 is Stop, SIGUSR2 is Stop now.
process.on("SIGUSR1", () => handle.stop("graceful"));
process.on("SIGUSR2", () => handle.stop("now"));
if (config.stopAfterMs !== undefined) setTimeout(() => handle.stop(config.stopMode ?? "graceful"), config.stopAfterMs);

handle.done.then((result) => {
  writeFileSync(
    config.resultFile,
    JSON.stringify({ result, renewals: port.renewals, markers: port.markers, intervals: port.intervals, cohorts: port.cohorts, final: port.final !== null }),
  );
  process.exit(0);
});
