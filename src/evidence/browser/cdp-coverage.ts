/**
 * Browser coverage over raw CDP (spike 3): a second connection to the browser, never
 * Playwright's `page.coverage`, which resets this one's counters on every take and ends
 * coverage for both when it stops. Every target is auto-attached recursively (popups,
 * cross-site frames, workers, service workers), deduped by `targetId`, and set up
 * pipelined: every command and the resume are sent at once, since awaiting each reply
 * timed popups out. JS and CSS deltas are taken before each test action (`takeAll`) and
 * at the attempt's end (`finish`), and unioned. `rules.ts` reads the result.
 */
import type { AttemptCoverage, RanFunction } from "./rules";

export interface CdpConnection {
  send(method: string, params?: object, sessionId?: string): Promise<unknown>;
  onEvent(handler: (method: string, params: unknown, sessionId?: string) => void): void;
  /** Called once if the connection closes, for any reason. */
  onClose?(handler: () => void): void;
}

const COVERED = new Set(["page", "iframe", "worker", "service_worker", "shared_worker"]);
const DOCUMENTS = new Set(["page", "iframe"]);
const ASSET_TYPES = new Set(["Script", "Stylesheet"]);

interface Target {
  sessionId: string;
  type: string;
  /** A target whose coverage counts: a page, frame or worker, attached once. */
  covered: boolean;
  /** Its browser context's CDP id, when the target names one. */
  context?: string;
  /**
   * Our coverage provably started before the app ran here. The only proof is the hold: the
   * target attached waiting for the debugger (`waitingForDebugger`), and its starts (JS, and
   * CSS for a document) succeeded. Chrome holds a target until every client that asked
   * resumes it, and ours resumes only after the starts. The proof is the attach flag and the
   * starts, never the resume reply, which reads OK whether or not anything was held.
   * A target that attached already running is never proven: its history and URL can't show
   * code run without a commit (`setContent`, `document.write`) or behind a replace to
   * about:blank. Unproven is late, and absence from coverage data proves nothing either.
   */
  proven: boolean;
  /** It attached waiting for the debugger: held until we resume it. */
  held: boolean;
  /**
   * A popup that can reach its opener may run in its opener's V8 isolate, whose coverage
   * counts our start here resets: what the opener ran before is then lost, unseen. Unknown
   * counts as shared.
   */
  sharesIsolate: boolean;
  /**
   * The V8 isolates it ran in this attempt. Two targets in one isolate share its coverage
   * counts: one's start or take resets what the other ran (unrelated same-site pages at the
   * renderer limit, a popup with its opener). Read at setup, after each main-frame
   * navigation (a process swap moves it), and at the final take. Unreadable counts as shared.
   */
  isolates: Set<string>;
  isolateUnknown: boolean;
  /** The baseline take found an app script that ran before our start: late, whatever else says. */
  ranBefore: boolean;
  /** For diagnosis: which target, and where it was at attach. */
  targetId: string;
  url: string;
  profiler: boolean;
  css: boolean;
  detached: boolean;
  finalTaken: boolean;
}

interface Sheet {
  url: string;
  text: string | null;
}

interface Attempt {
  ran: Map<string, Map<string, RanFunction>>;
  used: Map<string, Array<{ start: number; end: number }>>;
  assets: Set<string>;
  covered: Set<string>;
  errors: string[];
  navigations: number;
}

type CoverageResult = { result: Array<{ url: string; functions: Array<{ functionName: string; ranges: Array<{ startOffset: number; endOffset: number; count: number }> }> }> };
type CssResult = { coverage?: Array<{ styleSheetId: string; startOffset: number; endOffset: number; used: boolean }> };

export interface CdpCoverageOptions {
  browser: string;
  /** Keep each sheet's text, for reading which rules ran (tests and diagnosis only). */
  sheetText?: boolean;
}

export class CdpCoverage {
  private readonly targets = new Map<string, Target>();
  private readonly seen = new Set<string>();
  private readonly sheets = new Map<string, Sheet>();
  private readonly documents = new Set<string>();
  private attempt: Attempt = CdpCoverage.empty();
  /** The connection closed: nothing the browser runs from now on is seen, so no attempt is ever whole again. */
  private dead = false;
  /** Setup replies still to come: a target runs before them is a target lost. */
  private readonly setups = new Set<Promise<unknown>>();

  constructor(
    private readonly cdp: CdpConnection,
    private readonly options: CdpCoverageOptions,
  ) {
    cdp.onClose?.(() => (this.dead = true));
    cdp.onEvent((method, params, sessionId) => {
      try {
        this.onEvent(method, params as Record<string, unknown>, sessionId);
      } catch (error) {
        this.attempt.errors.push(`${method}: ${String(error)}`);
      }
    });
  }

  private static empty(): Attempt {
    return { ran: new Map(), used: new Map(), assets: new Set(), covered: new Set(), errors: [], navigations: 0 };
  }

  /** How many live pages of a browser context it has attached to. */
  pages(context: string): number {
    return [...this.targets.values()].filter((t) => t.covered && !t.detached && t.type === "page" && t.context === context).length;
  }

  /** Once every setup reply so far is in (tests: run a page only after its coverage started). */
  async settled(): Promise<void> {
    while (this.setups.size > 0) await Promise.allSettled([...this.setups]);
  }

  /** Attach to every target the browser has or opens. */
  async attach(): Promise<void> {
    await this.cdp.send("Target.setAutoAttach", { autoAttach: true, waitForDebuggerOnStart: true, flatten: true });
  }

  /**
   * Start an attempt: what ran before it is taken and dropped, and so is a target that
   * can't answer (a closed context's service worker can stay attached, and silent).
   */
  async begin(): Promise<void> {
    if (this.dead) return;
    for (const [sessionId, target] of this.targets) if (target.detached) this.targets.delete(sessionId);
    await Promise.all([...this.targets].map(([sessionId, target]) => this.take(target).catch(() => this.targets.delete(sessionId))));
    this.attempt = CdpCoverage.empty();
    this.documents.clear();
    // Its starts done, our coverage was on before this attempt's code ran. A target whose
    // starts are still pending must still earn its own proof.
    for (const target of this.targets.values()) {
      target.finalTaken = false;
      if (target.profiler && (!DOCUMENTS.has(target.type) || target.css)) target.proven = true;
      target.ranBefore = false;
      target.isolates.clear();
      target.isolateUnknown = false;
    }
  }

  /** A delta from every live target: before each test action, so a navigation it starts loses nothing. */
  async takeAll(): Promise<void> {
    await Promise.all([...this.targets.values()].filter((t) => !t.detached).map((t) => this.take(t).catch(() => {})));
  }

  /**
   * The attempt's last deltas, and what it covered. Two scopes, kept apart:
   * - Completeness covers every target that contributed to the attempt, whatever its
   *   context. Each must be wholly seen: every domain it measures (JS, and CSS for a
   *   document) set up, and either taken successfully now or already taken finally. A
   *   target that isn't, live or gone, counts as `lost`, and the attempt reads partial.
   * - Finality is per context: only the closing context's targets (one with no context id,
   *   only at the last close) are taken finally, so a later close still checks the rest.
   */
  async finish(scope?: { context: string | null; last: boolean }): Promise<AttemptCoverage> {
    if (this.dead) return { browser: this.options.browser, scripts: [], sheets: [], assets: [], covered: [], lost: 0, errors: [], navigations: 0, refused: "collector_disconnected" };
    const inScope = (t: Target) => !scope || (t.context === undefined ? scope.last : t.context === scope.context);
    const ready = (t: Target) => t.profiler && (!DOCUMENTS.has(t.type) || t.css);
    const seen = new Set<Target>();
    // At once, as `begin` does: a dead target costs its own reply timeout, not one per target.
    await Promise.all(
      [...this.targets.values()]
        .filter((target) => !target.detached && target.profiler)
        .map((target) =>
          this.take(target).then(
            () => {
              if (!ready(target)) return;
              seen.add(target);
              if (inScope(target)) target.finalTaken = true;
            },
            () => {
              // Recorded in the attempt's errors.
            },
          ),
        ),
    );
    await Promise.all([...this.targets.values()].filter((t) => t.covered && !t.detached).map((t) => this.readIsolate(t)));
    const covered = [...this.targets.values()].filter((t) => t.covered);
    const sharing = covered.filter(
      (t) => t.sharesIsolate || t.isolateUnknown || covered.some((u) => u !== t && [...t.isolates].some((id) => u.isolates.has(id))),
    );
    const lost = [...this.targets.values()].filter((t) => t.covered && !t.finalTaken && !seen.has(t));
    const late = [...this.targets.values()].filter((t) => t.covered && (!t.proven || t.ranBefore));
    const a = this.attempt;
    return {
      browser: this.options.browser,
      scripts: [...a.ran].map(([url, functions]) => ({ url, functions: [...functions.values()] })),
      sheets: [...a.used].map(([key, used]) => {
        const sheet = this.sheets.get(key)!;
        return { url: sheet.url, used, ...(this.options.sheetText ? { text: sheet.text ?? "" } : {}) };
      }),
      assets: [...a.assets],
      covered: [...a.covered, ...[...this.sheets.values()].map((s) => s.url).filter((url) => url !== "")],
      lost: lost.length,
      late: late.length,
      sharedIsolate: sharing.length,
      lateDetail: late.map((t) => ({ type: t.type, held: t.held, ranBefore: t.ranBefore })),
      lostDetail: lost.map((t) => ({ type: t.type, targetId: t.targetId, url: t.url, context: t.context ?? null, inScope: inScope(t), profiler: t.profiler, css: t.css, detached: t.detached })),
      errors: a.errors,
      navigations: a.navigations,
    };
  }

  /** Which isolate the target runs in now, added to those it ran in. Unreadable is unknown, so shared. */
  private readIsolate(target: Target): Promise<void> {
    const read = this.cdp.send("Runtime.getIsolateId", {}, target.sessionId).then(
      (answer) => {
        const id = (answer as { id?: unknown } | null)?.id;
        if (typeof id === "string" && id !== "") target.isolates.add(id);
        else if (!target.detached) target.isolateUnknown = true;
      },
      () => {
        if (!target.detached) target.isolateUnknown = true;
      },
    );
    this.setups.add(read);
    void read.finally(() => this.setups.delete(read));
    return read;
  }

  /** A take's functions that ran, into the attempt. */
  private record(result: CoverageResult["result"]): void {
    for (const script of result) {
      if (script.url) this.attempt.covered.add(script.url);
      const ran = script.functions.filter((fn) => (fn.ranges[0]?.count ?? 0) > 0);
      if (ran.length === 0) continue;
      let functions = this.attempt.ran.get(script.url);
      if (!functions) this.attempt.ran.set(script.url, (functions = new Map()));
      for (const fn of ran) {
        const { startOffset: start, endOffset: end } = fn.ranges[0]!;
        functions.set(`${start}:${end}`, { name: fn.functionName, start, end });
      }
    }
  }

  private async take(target: Target): Promise<void> {
    const send = (method: string) => this.cdp.send(method, {}, target.sessionId);
    if (target.profiler) {
      try {
        this.record(((await send("Profiler.takePreciseCoverage")) as Partial<CoverageResult> | null)?.result ?? []);
      } catch (error) {
        if (!target.detached) this.attempt.errors.push(`take js: ${String(error)}`);
        throw error;
      }
    }
    if (target.css) {
      try {
        const { coverage = [] } = (await send("CSS.takeCoverageDelta")) as CssResult;
        for (const rule of coverage) {
          const key = `${target.sessionId}:${rule.styleSheetId}`;
          if (!rule.used || !this.sheets.has(key)) continue;
          let used = this.attempt.used.get(key);
          if (!used) this.attempt.used.set(key, (used = []));
          used.push({ start: rule.startOffset, end: rule.endOffset });
        }
      } catch (error) {
        if (!target.detached) this.attempt.errors.push(`take css: ${String(error)}`);
        throw error;
      }
    }
  }

  private onEvent(method: string, params: Record<string, unknown>, sessionId?: string): void {
    if (method === "Target.attachedToTarget") return this.onAttached(params as never);
    if (method === "Target.detachedFromTarget") {
      const target = this.targets.get(params.sessionId as string);
      if (target) target.detached = true;
      return;
    }
    if (!sessionId || !this.targets.has(sessionId)) return;
    if (method === "CSS.styleSheetAdded") {
      const header = params.header as { styleSheetId: string; sourceURL?: string };
      const sheet: Sheet = { url: header.sourceURL ?? "", text: null };
      this.sheets.set(`${sessionId}:${header.styleSheetId}`, sheet);
      if (this.options.sheetText) {
        this.cdp
          .send("CSS.getStyleSheetText", { styleSheetId: header.styleSheetId }, sessionId)
          .then((answer) => (sheet.text = (answer as { text?: string }).text ?? null))
          .catch(() => {});
      }
    } else if (method === "Page.frameNavigated") {
      const frame = params.frame as { id: string; url: string; parentId?: string };
      const navigated = this.targets.get(sessionId);
      if (navigated?.covered && !frame.parentId) void this.readIsolate(navigated);
      if (frame.url === "about:blank") return;
      const key = `${sessionId}:${frame.id}`;
      if (this.documents.has(key)) this.attempt.navigations++;
      this.documents.add(key);
    } else if (method === "Network.responseReceived") {
      const { type, response } = params as { type?: string; response?: { url?: string } };
      if (type && ASSET_TYPES.has(type) && response?.url && /^https?:/.test(response.url)) this.attempt.assets.add(response.url);
    }
  }

  private onAttached({ sessionId, targetInfo, waitingForDebugger }: { sessionId: string; targetInfo: { targetId: string; type: string; url?: string; browserContextId?: string; openerId?: string; canAccessOpener?: boolean }; waitingForDebugger: boolean }): void {
    const duplicate = this.seen.has(targetInfo.targetId);
    this.seen.add(targetInfo.targetId);
    const target: Target = {
      sessionId,
      type: targetInfo.type,
      targetId: targetInfo.targetId,
      url: targetInfo.url ?? "",
      covered: !duplicate && COVERED.has(targetInfo.type),
      ...(targetInfo.browserContextId ? { context: targetInfo.browserContextId } : {}),
      profiler: false,
      css: false,
      detached: false,
      finalTaken: false,
      proven: false,
      held: waitingForDebugger === true,
      sharesIsolate: typeof targetInfo.openerId === "string" && targetInfo.canAccessOpener !== false,
      isolates: new Set(),
      isolateUnknown: false,
      ranBefore: false,
    };
    if (!duplicate) this.targets.set(sessionId, target);
    const send = (method: string, params: object = {}) => this.cdp.send(method, params, sessionId);
    // Each failure is an error as soon as it happens, not once every reply is in.
    const started = () => target.profiler && (!DOCUMENTS.has(target.type) || target.css);
    const job = (method: string, params: object = {}) => {
      const reply = send(method, params).then(
        () => {
          if (method === "Profiler.startPreciseCoverage") target.profiler = true;
          if (method === "CSS.startRuleUsageTracking") target.css = true;
          // Held, and our starts are in: nothing ran before them.
          if (target.held && started()) target.proven = true;
        },
        (error: unknown) => {
          if (!target.detached) this.attempt.errors.push(`setup ${method}: ${String(error)}`);
        },
      );
      this.setups.add(reply);
      void reply.finally(() => this.setups.delete(reply));
    };
    // Sent together, resume last, no reply awaited: CDP runs one session's commands in order.
    if (!duplicate && COVERED.has(target.type)) {
      job("Profiler.enable");
      job("Profiler.startPreciseCoverage", { callCount: true, detailed: true });
      if (DOCUMENTS.has(target.type)) {
        job("DOM.enable");
        job("CSS.enable");
        job("CSS.startRuleUsageTracking");
        job("Page.enable");
      }
      // Not every target speaks Network; what it misses only weakens the asset check.
      send("Network.enable").catch(() => {});
    }
    job("Target.setAutoAttach", { autoAttach: true, waitForDebuggerOnStart: true, flatten: true });
    if (waitingForDebugger) job("Runtime.runIfWaitingForDebugger");
    if (!duplicate && COVERED.has(target.type)) void this.readIsolate(target);
    if (!duplicate && COVERED.has(target.type)) {
      // An extra late signal, never a proof: an app script whose top level reads 0 here ran
      // before our start. Its absence proves nothing; V8 drops what it no longer holds.
      const baseline = send("Profiler.takePreciseCoverage").then(
        (answer) => {
          const result = (answer as Partial<CoverageResult> | null)?.result ?? [];
          if (result.some((script) => script.url !== "" && !script.url.startsWith("__playwright") && script.functions.some((fn) => fn.ranges[0]?.startOffset === 0 && fn.ranges[0].count === 0)))
            target.ranBefore = true;
          this.record(result);
        },
        () => {
          // No signal either way: the proof above decides.
        },
      );
      this.setups.add(baseline);
      void baseline.finally(() => this.setups.delete(baseline));
    }
  }
}
