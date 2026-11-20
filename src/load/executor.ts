/**
 * The load executor (`dist/load-executor.js`, e4 plan v3 §2.1). Inside the jail, init starts
 * it as the runner's uid with frames in on fd 0 and out on fd 3. It is the only process that
 * loads customer code, and it is trusted for nothing: every count, time and limit is the
 * gate's.
 *
 *   init     resolve the customer's Playwright (1.46 or later), install the loader, load the
 *            journey, answer `loaded` (or `fatal`);
 *   turn     run one turn for a slot (`session.ts`); a slot that is still busy is `fatal`;
 *   cancel   end that turn now; a turn already ended is left alone;
 *   stop     cancel everything and exit.
 *
 * `outcome` is sent once per turn, and only after the turn's context is disposed: it
 * acknowledges the cleanup, whichever way the turn ended. Console output goes to stderr; fd 3
 * carries frames only.
 */
import { accessSync, constants as fsConstants, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import net from "node:net";
import path from "node:path";

import { sharedClocks } from "./clocks";
import { decode, encode, LineSplitter, MAX_LOCATION, MAX_MESSAGE, type CtlFrame, type FatalCode } from "./jail/ctl";
import { loadJourney, originalLocation, resolveTsFile } from "./loader";
import { Sessions, type Journey, type PlaywrightRequest } from "./session";

export const PLAYWRIGHT_FLOOR = [1, 46] as const;

const out = new net.Socket({ fd: 3, readable: false, writable: true });
out.on("error", () => process.exit(74));
const send = (frame: CtlFrame) => out.write(encode(frame));

// The frame channel is fd 3 alone: everything the journey prints goes to stderr.
const toStderr = process.stderr.write.bind(process.stderr) as typeof process.stdout.write;
process.stdout.write = toStderr;
for (const level of ["log", "info", "debug", "trace", "dir", "table", "warn", "error"] as const) {
  // eslint-disable-next-line no-console
  console[level] = (...args: unknown[]) => {
    toStderr(args.map((a) => (typeof a === "string" ? a : safeInspect(a))).join(" ") + "\n");
  };
}

function safeInspect(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

// A request the journey did not await, and that then fails, is the journey's own loose end: it
// is reported, and it ends no other user's turn. Node's default would end the whole executor.
process.on("unhandledRejection", (reason) => {
  toStderr(`load: a journey left a rejected promise unhandled: ${reason instanceof Error ? (reason.stack ?? reason.message) : safeInspect(reason)}\n`);
});

const root = process.cwd();
let sessions: Sessions | null = null;
let journey: Journey | null = null;
let stopping = false;
const pending = new Set<Promise<void>>();

function failureOf(error: unknown): { message: string; location?: string } {
  const e = error instanceof Error ? error : new Error(String(error));
  const location = originalLocation(e.stack, root);
  return { message: `${e.name === "Error" ? "" : `${e.name}: `}${e.message}`.slice(0, MAX_MESSAGE), ...(location ? { location: location.slice(0, MAX_LOCATION) } : {}) };
}

function fatal(code: FatalCode, error: unknown): void {
  send({ type: "fatal", code, ...failureOf(error) });
}

/** The customer's Playwright package, from the working directory or the journey's folder; not loaded yet. */
function findPlaywright(dirs: string[]): { version: string; load: () => PlaywrightRequest | undefined } | null {
  for (const dir of dirs) {
    const req = createRequire(path.join(dir, "noop.js"));
    for (const name of ["@playwright/test", "playwright-core", "playwright"]) {
      let pkg: string;
      try {
        pkg = req.resolve(`${name}/package.json`);
      } catch {
        continue;
      }
      const version = String((JSON.parse(readFileSync(pkg, "utf8")) as { version?: unknown }).version ?? "?");
      return { version, load: () => (req(name) as { request?: PlaywrightRequest }).request };
    }
  }
  return null;
}

function atLeastFloor(version: string): boolean {
  const m = /^(\d+)\.(\d+)\./.exec(version);
  if (!m) return false;
  const [major, minor] = [Number(m[1]), Number(m[2])];
  return major > PLAYWRIGHT_FLOOR[0] || (major === PLAYWRIGHT_FLOOR[0] && minor >= PLAYWRIGHT_FLOOR[1]);
}

function onInit(frame: Extract<CtlFrame, { type: "init" }>): void {
  if (sessions) return protocol("init twice");
  const file = resolveTsFile(path.resolve(root, frame.journey.module));
  try {
    if (!file) throw new Error(`the journey module ${frame.journey.module} was not found`);
    accessSync(file, fsConstants.R_OK);
  } catch (error) {
    return fatal("unreadable", error);
  }
  const found = findPlaywright([root, path.dirname(file)]);
  if (!found) return fatal("playwright", new Error("Playwright was not found from the working directory or the journey's folder"));
  if (!atLeastFloor(found.version)) return fatal("playwright", new Error(`Playwright ${found.version} is below ${PLAYWRIGHT_FLOOR.join(".")}, the oldest a load journey runs on`));
  let request: PlaywrightRequest | undefined;
  try {
    request = found.load();
  } catch (error) {
    return fatal("playwright", error);
  }
  if (typeof request?.newContext !== "function") return fatal("playwright", new Error(`Playwright ${found.version} has no request API`));
  try {
    journey = loadJourney(root, frame.journey.module, frame.journey.export) as Journey;
  } catch (error) {
    return fatal("journey", error);
  }
  sessions = new Sessions({
    playwright: request,
    baseURL: frame.baseURL,
    proxy: frame.proxy,
    parallel: frame.parallel,
    renewEveryMs: frame.renewEveryMs,
    now: () => sharedClocks().monoMs,
  });
  send({ type: "loaded", playwright: found.version.slice(0, 64) });
}

function onTurn(frame: Extract<CtlFrame, { type: "turn" }>): void {
  if (!sessions || !journey) return protocol("turn before loaded");
  if (stopping) return;
  if (sessions.busy(frame.slot)) return protocol(`slot ${frame.slot} is busy`);
  const work = sessions
    .run(frame, journey)
    .then((result) => {
      const extra = result.kind === "failure" ? failureOf(result.error) : {};
      send({ type: "outcome", turn: frame.turn, kind: result.kind, ...extra });
    })
    // What the journey threw could not be read (no prototype, a getter that throws): the turn still gets its outcome.
    .catch(() => void send({ type: "outcome", turn: frame.turn, kind: "failure", message: "the journey threw a value that could not be read" }))
    .finally(() => pending.delete(work));
  pending.add(work);
}

function protocol(why: string): void {
  send({ type: "fatal", code: "protocol", message: why.slice(0, MAX_MESSAGE) });
  out.end(() => process.exit(76));
}

async function stop(code: number): Promise<never> {
  stopping = true;
  sessions?.cancelAll();
  await Promise.allSettled([...pending]);
  await new Promise<void>((resolve) => out.end(resolve));
  process.exit(code);
}

function onFrame(frame: CtlFrame): void {
  switch (frame.type) {
    case "init":
      return onInit(frame);
    case "turn":
      return onTurn(frame);
    case "cancel":
      sessions?.cancel(frame.turn);
      return;
    case "stop":
      void stop(0);
      return;
    default:
      return protocol(`unexpected frame ${frame.type}`);
  }
}

const lines = new LineSplitter();
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk: string) => {
  const got = lines.push(chunk);
  if (got === null) return protocol("a frame longer than the limit");
  for (const line of got) {
    const frame = decode(line);
    if (!frame) return protocol("a line that is not a frame");
    onFrame(frame);
  }
});
// The supervisor is gone: nothing may run without it.
process.stdin.on("end", () => void stop(74));
process.stdin.on("error", () => void stop(74));
