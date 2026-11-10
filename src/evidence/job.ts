/**
 * Before the announce, when Peeps asked for a fingerprint: fingerprint the app's Next
 * build, upload it, and hand the announce its receipt to cite. Anything that doesn't
 * hold (no build, a checkout that isn't the job's commit, a pull request job off
 * GitHub's merge, a refused upload) is no impact, said once, and today's run.
 */
import { existsSync, realpathSync } from "node:fs";
import path from "node:path";
import type { Repository } from "../reach/checkout";
import type { Collect } from "../reach/preflight";
import { ACTION_VERSION } from "../version";
import { RECORDING_CODEC_VERSION } from "./codec";
import { runBundled } from "../reach/process";
import type { Fingerprint } from "./fingerprint/rules";
import { fromWire, type WireFingerprint } from "./fingerprint/wire";
import { ROUTE_ENCODER_VERSION } from "./hash";
import { fingerprintRecording } from "./recording";
import { uploadFingerprint, type EvidenceTransport, type Receipt } from "./upload";

/** What records a fingerprint: a change to any of it reads every recording unbound. */
export const TOOLCHAIN = `peeps-action@${ACTION_VERSION}/codec${RECORDING_CODEC_VERSION}/routes${ROUTE_ENCODER_VERSION}`;

export interface PreparedProject {
  projectId: string;
  collect: Collect;
  receipt: Receipt;
}

export interface PreparedImpact {
  /** The head build's plaintext fingerprint: the tests' coverage is read against it. */
  fingerprint: Fingerprint;
  /** Each project whose fingerprint Peeps took, with its receipt for the announce. */
  projects: PreparedProject[];
}

export interface PrepareInput {
  /** The directory holding the app's `.next`. */
  appDir: string;
  sha: string;
  eventName: string | null;
  /** Descriptive only: which leg of a matrix this job is. */
  leg: string;
  /** Every project Peeps asked to record, each with its key. */
  collect: Collect[];
  repository: Repository;
  transport: EvidenceTransport;
  /** The build's plaintext fingerprint, or null; by default from the scanner's process. */
  fingerprint?: (nextDir: string, sourcePrefix: string) => Promise<Fingerprint | null>;
}

/** Umami's took 15–18 s in spike 2. */
const FINGERPRINT_BUDGET_MS = 90_000;

/** In the scanner's own process, as the reach is: the parser stays out of this one, and a crash is no answer. */
async function scannerFingerprint(nextDir: string, sourcePrefix: string): Promise<Fingerprint | null> {
  const answer = await runBundled<WireFingerprint>(path.join(__dirname, "reach.js"), { kind: "fingerprint", root: nextDir, nextDir, sourcePrefix }, FINGERPRINT_BUDGET_MS);
  return answer && answer !== "timeout" ? fromWire(answer) : null;
}

const say = (line: string) => console.log(`[peeps] ${line}`);

/** One fingerprint of the build, hashed and uploaded once per project under that project's key. */
export async function prepareImpact(input: PrepareInput, log: (line: string) => void = say): Promise<PreparedImpact | null> {
  const asked = input.collect.filter((c) => c.fingerprint);
  if (asked.length === 0) return null;
  const nextDir = path.join(input.appDir, ".next");
  if (!existsSync(path.join(nextDir, "BUILD_ID"))) {
    log("not recording what this job's tests ran: no Next build in the working directory to fingerprint");
    return null;
  }
  let base: string;
  let sourcePrefix: string;
  try {
    const { git } = input.repository;
    if ((await git("rev-parse", "HEAD")).trim() !== input.sha) throw new Error("not the job's commit");
    const root = realpathSync((await git("rev-parse", "--show-toplevel")).trim());
    sourcePrefix = path.relative(root, realpathSync(input.appDir)).split(path.sep).join("/");
    if (input.eventName === "pull_request") {
      // GitHub's merge commit: its first parent is what the pull request is based on.
      await git("rev-parse", "--verify", "--quiet", "HEAD^2");
      base = (await git("rev-parse", "--verify", "--quiet", "HEAD^1")).trim();
    } else {
      // A push records at its own commit: it has no base to send.
      base = "";
    }
  } catch {
    log("not recording what this job's tests ran: the checkout isn't the job's commit, or a pull request's isn't GitHub's merge");
    return null;
  }
  let fingerprint: Fingerprint | null;
  try {
    fingerprint = await (input.fingerprint ?? scannerFingerprint)(nextDir, sourcePrefix);
    if (!fingerprint) throw new Error("no answer in time");
  } catch (error) {
    log(`not recording what this job's tests ran: the build couldn't be fingerprinted (${String(error).slice(0, 300)})`);
    return null;
  }
  const projects: PreparedProject[] = [];
  for (const collect of asked) {
    const blob = fingerprintRecording(fingerprint, collect.key);
    const receipt = await uploadFingerprint(input.transport, { blob, projectId: collect.projectId, base, leg: input.leg, keyVersion: collect.keyVersion, binding: TOOLCHAIN }, log);
    if (receipt) projects.push({ projectId: collect.projectId, collect, receipt });
  }
  return projects.length > 0 ? { fingerprint, projects } : null;
}
