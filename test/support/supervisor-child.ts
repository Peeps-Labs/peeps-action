/**
 * A supervisor in its own process, for the signal trials (e4 plan v3 §3.3 F5b, F5c): the runner
 * signals this process, never the test's. The sink stays in the parent, so what reaches it after
 * a SIGKILL can be counted.
 *
 * Config in PEEPS_CHILD (JSON): the sink's port and CA, the checkout (made by the parent, which
 * removes it), `real` for the real jail, and the lease's ttl. It runs one 1 MiB POST journey with
 * `loadSignals()` installed (with `slowReporting`, evidence never gets through and only the reporting
 * deadline, a minute unless a hard cancel cuts it, ends the run), and writes one JSON line per fact on stdout: `{ jail }` (the fake
 * executor's pid or the real unit), `{ event }` (phase and terminate), `{ signal }` and
 * `{ result }`. A stdin line `block <ms>` blocks the event loop that long (handlers wait).
 */
import type { Upstream } from "../../src/load/gate/resolve";
import type { TestContext } from "node:test";
import { startJail } from "../../src/load/jail";
import { unitName } from "../../src/load/jail/spec";
import { loadSignals } from "../../src/load/signals";
import { FAST, rig, smallPlan } from "./run-supervisor";
import type { Sink } from "./load-sink";

interface ChildConfig {
  sinkPort: number;
  caPem: string;
  ws: string;
  real: boolean;
  ttlMs: number;
  slowReporting: boolean;
}

const config = JSON.parse(process.env.PEEPS_CHILD!) as ChildConfig;
const say = (fact: object) => process.stdout.write(`${JSON.stringify(fact)}\n`);

const signals = loadSignals();
for (const name of ["SIGINT", "SIGTERM"] as const) process.on(name, () => say({ signal: name }));

const uploadBytes = 1024 * 1024 - 4096;
let measuring = false;
let queued: Upstream | undefined;
let input = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk: string) => {
  input += chunk;
  for (let nl = input.indexOf("\n"); nl >= 0; nl = input.indexOf("\n")) {
    const [cmd, arg] = input.slice(0, nl).split(" ");
    input = input.slice(nl + 1);
    if (cmd === "block") {
      say({ blocking: Number(arg) });
      const end = Date.now() + Number(arg);
      while (Date.now() < end) {
        // The event loop is held: signals wait for their handlers.
      }
    }
  }
});

// Only the port and CA are read in this process; arrivals are counted in the parent's sink.
const sink: Sink = {
  port: config.sinkPort,
  caPem: config.caPem,
  arrivals: [],
  stats: { connections: 0, handshakes: 0, requestBytes: 0, socketErrors: [], stalled: 0, aborted: 0 },
  resumeStalled: () => undefined,
  close: async () => undefined,
};
const t = { after: () => undefined } as unknown as TestContext;

void (async () => {
  const r = await rig(t, {
    ws: config.ws,
    real: config.real,
    sink,
    signal: signals.signal,
    hardSignal: signals.hard,
    setup: { ttlMs: config.ttlMs },
    ...(config.slowReporting ? { script: { eventsBlocked: true } } : {}),
    dial: (inner) => async (...args) => {
      const upstream = await inner(...args);
      if (config.slowReporting && measuring && !queued) {
        queued = upstream;
        upstream.socket.cork();
        const timer = setInterval(() => {
          if (upstream.socket.writableLength >= uploadBytes) {
            clearInterval(timer);
            say({ queuedBytes: upstream.socket.writableLength });
          }
        }, 10);
        void upstream.closed.then(() => clearInterval(timer));
      }
      return upstream;
    },
    plan: smallPlan({ exportName: "bigPost", users: 1, durationMs: 60_000, perJourneyMax: 1, allowedRequests: [{ method: "POST", path: "/upload" }] }),
    seams: {
      constants: { ...FAST, ...(config.real ? { loadedMs: 120_000, checkingDeadlineMs: 60_000 } : {}), ...(config.slowReporting ? { reportingMs: 60_000 } : {}) },
      ...(config.real
        ? {
            launch: (spec, options, signal) => {
              say({ jail: { unit: unitName(spec.runId) } });
              return startJail(spec, options, signal);
            },
          }
        : {}),
    },
    observer: (e, x) => {
      if (e.type === "phase") {
        if (e.phase === "measurement") measuring = true;
        if (!config.real && e.phase === "checking") say({ jail: { pid: x.jails.made[0]?.child?.pid } });
        say({ event: { phase: e.phase } });
      }
      if (e.type === "terminate") {
        say({ event: { terminate: e.reason } });
        setImmediate(() => queued?.socket.uncork());
      }
    },
  });
  const res = await r.result;
  say({ result: { status: res.status, reason: res.reason, gateClosed: res.gateClosed, cleanup: res.cleanup } });
  signals.dispose();
  process.exit(0);
})();
