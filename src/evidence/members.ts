/**
 * A job's evidence, joined: the reporter's record of each attempt (its run, retry, pass,
 * requested paths) with the worker's coverage of it, as the codec's members and universe.
 * Only what was collected is claimed measured, so Peeps selects everything for the rest;
 * an attempt missing a collector's answer reads partial for that collector's kinds. Pure.
 */
import { browserCollector } from "./browser/collector";
import { builtFileOf } from "./browser/rules";
import type { AttemptFile } from "./browser/worker";
import type { Layer } from "./codec";
import type { Fingerprint } from "./fingerprint/rules";
import type { TableEvidence } from "./pg/collector";
import type { AttemptEvidence, EvidenceKind } from "./port";
import type { MemberEvidence } from "./recording";
import type { ServerFootprint } from "./server/rules";

/** What the reporter writes for each attempt of a planned test. */
export interface AttemptRecord {
  /** Playwright's `TestCase.id`, as the worker's `test.info().testId`. */
  testId: string;
  runId: string;
  retry: number;
  passed: boolean;
  /** The HAR footprint, when the reporter recorded one. */
  har: { paths: string[]; complete: boolean } | null;
  /** The test's file, absolute: which invocation of a server recording should have run it. */
  file?: string;
}

/** What the worker writes when a test opens a browser context: that context owes a final record. */
export interface ContextMarker {
  testId: string;
  retry: number;
  contextId: string;
}

/** Server evidence (PQA-3201 PR 3): the ambient invocation's footprint, and each test's spec invocation's. */
export interface ServerEvidence {
  ambient: ServerFootprint;
  /** By Playwright's `TestCase.id`: every test of a spec file holds that file's invocation's footprint. */
  byTest: ReadonlyMap<string, ServerFootprint>;
}

export interface JobEvidence {
  layers: Layer[];
  measured: EvidenceKind[];
  /** Plaintext `file:` keys of every source in a script any attempt loaded. */
  loadedFiles: string[];
  /** What every test shares: the app's code with no test running (`fn:` and `file:` keys), and the job's database tables when its log proved them. The browser has none. */
  ambient: string[];
  members: MemberEvidence[];
  /** The one browser build every attempt ran in, or null when there were several or none. */
  browser: { name: string; version: string } | null;
}

export function membersOf(
  records: AttemptRecord[],
  coverage: AttemptFile[],
  fingerprint: Fingerprint,
  /** `tables`: the job's Postgres log, read only when Peeps asked and `PEEPS_PG_LOG` is set. */
  collected: { coverage: boolean; har: boolean; tables?: TableEvidence },
  contexts: ContextMarker[],
  /** Attempts with a context whose marker never landed: none is whole, whatever records did. */
  taints: Array<{ testId: string; retry: number }> = [],
  serverEvidence?: ServerEvidence,
): JobEvidence {
  // `code` measured covers every listed layer: with the browser listed (HAR) but its coverage
  // refused, server code would claim the browser's measured too. Then no server evidence.
  const server = serverEvidence && (collected.coverage || !collected.har) ? serverEvidence : undefined;
  const taintedAttempts = new Set(taints.map((t) => `${t.testId}\u0000${t.retry}`));
  const collector = browserCollector(fingerprint);
  const covered = new Map<string, AttemptFile[]>();
  for (const file of coverage) {
    const key = `${file.testId}\u0000${file.retry}`;
    covered.set(key, [...(covered.get(key) ?? []), file]);
  }
  const owed = new Map<string, Set<string>>();
  for (const marker of contexts) {
    const key = `${marker.testId}\u0000${marker.retry}`;
    owed.set(key, new Set([...(owed.get(key) ?? []), marker.contextId]));
  }
  const byRun = new Map<string, MemberEvidence>();
  for (const record of records) {
    let member = byRun.get(record.runId);
    if (!member) byRun.set(record.runId, (member = { run: record.runId, attempts: [], evidence: [] }));
    member.attempts.push({ retry: record.retry, passed: record.passed });
    if (collected.har) {
      // The browser's requests: a partial HAR never says anything of the server (PQA-3430).
      const missing: AttemptEvidence = { keys: [], paths: [], partial: ["route"], layers: ["browser"], reasons: ["har_missing"] };
      member.evidence.push(record.har ? { keys: [], paths: record.har.paths, partial: record.har.complete ? [] : ["route"], layers: ["browser"], reasons: record.har.complete ? [] : ["har_incomplete"] } : missing);
    }
    if (collected.coverage) {
      const files = covered.get(`${record.testId}\u0000${record.retry}`) ?? [];
      const arrived = new Set(files.map((file) => file.contextId));
      if (taintedAttempts.has(`${record.testId}\u0000${record.retry}`)) member.evidence.push({ keys: [], paths: [], partial: ["code", "css"], layers: ["browser"], reasons: ["marker_failed"] });
      if (files.length === 0) member.evidence.push({ keys: [], paths: [], partial: ["code", "css"], layers: ["browser"], reasons: ["coverage_missing"] });
      // A context the attempt opened whose final record never came: what ran there is unknown.
      else if ([...(owed.get(`${record.testId}\u0000${record.retry}`) ?? [])].some((id) => !arrived.has(id)))
        member.evidence.push({ keys: [], paths: [], partial: ["code", "css"], layers: ["browser"], reasons: ["context_unfinished"] });
      for (const file of files) member.evidence.push({ ...collector.collect(file.coverage), layers: ["browser"] });
    }
    if (server) {
      const own = server.byTest.get(record.testId);
      member.evidence.push(
        own
          ? { keys: own.keys, paths: [], partial: own.partial, layers: ["server"], reasons: own.reasons.map((r) => `server_${r}`) }
          : { keys: [], paths: [], partial: ["code"], layers: ["server"], reasons: ["server_missing"] },
      );
      // Unknown shared work is unknown for every test.
      if (server.ambient.partial.length > 0) member.evidence.push({ keys: [], paths: [], partial: ["code"], layers: ["server"], reasons: server.ambient.reasons.map((r) => `ambient_${r}`) });
    }
  }
  for (const member of byRun.values()) member.attempts.sort((a, b) => a.retry - b.retry);
  // Nothing says which test ran a statement: the log proves every test's tables, or none.
  const tables = collected.tables;
  const tablesWhole = tables !== undefined && tables.partial.length === 0;
  if (tables && !tablesWhole) for (const member of byRun.values()) member.evidence.push({ keys: [], paths: [], partial: ["table"], layers: ["database"], reasons: tables.reasons });

  const loaded = new Set<string>();
  const browsers = new Set<string>();
  if (collected.coverage) {
    for (const file of coverage) {
      browsers.add(JSON.stringify([file.browser.name, file.browser.version]));
      for (const url of file.coverage.covered) {
        const built = builtFileOf(url);
        const index = built === null ? undefined : fingerprint.scripts.get(built);
        for (const span of index?.spans ?? []) if (span.source !== null) loaded.add(`file:${span.source}`);
      }
    }
  }
  if (server) for (const footprint of [server.ambient, ...server.byTest.values()]) for (const file of footprint.loaded) if (file.startsWith("file:")) loaded.add(file);
  const [only] = browsers;
  const measured: EvidenceKind[] = [
    ...(collected.coverage || server ? (["code"] as const) : []),
    ...(collected.coverage ? (["css"] as const) : []),
    ...(collected.har ? (["route"] as const) : []),
    ...(tablesWhole ? (["table"] as const) : []),
  ];
  const browserLayer = collected.coverage || collected.har;
  return {
    layers: [...(browserLayer ? (["browser"] as const) : []), ...(server ? (["server"] as const) : []), ...(tablesWhole ? (["database"] as const) : [])],
    measured,
    loadedFiles: [...loaded].sort(),
    // Peeps takes code ids and tables here; a whole script's `out:` key stays in each member, whose invocation started the same app.
    ambient: [...(server ? server.ambient.keys.filter((key) => key.startsWith("fn:") || key.startsWith("file:")) : []), ...(tablesWhole ? tables.keys : [])],
    members: [...byRun.values()],
    browser: browsers.size === 1 && only ? (([name, version]) => ({ name, version }))(JSON.parse(only) as [string, string]) : null,
  };
}
