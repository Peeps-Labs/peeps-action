/**
 * A test's footprint, the decisions: what counts as the application's, what leaves
 * the job, and which recordings the customer's own policy keeps. Pure: `trace-file.ts`
 * reads the trace. Paths leave with no host and no query, and with what could be
 * private folded to `:id`. Anything less than a whole reading is `complete: false`,
 * which Peeps reads as unknown: that test always runs.
 */
export interface Footprint {
  paths: string[];
  complete: boolean;
}

export interface FootprintOrigins {
  /** The suite's own: `BASE_URL` and the project's `use.baseURL`. */
  baseUrls: string[];
  /** The project's further application origins, from Peeps. */
  origins: string[];
}

/** A `test_end` carries at most this many: a request over 1 MB is refused. */
export const MAX_FOOTPRINT_PATHS = 300;
const MAX_PATH_LENGTH = 512;
/** Room for the envelope, under the route's 1,000,000 bytes. */
const MAX_REQUEST_BYTES = 900_000;
const MAX_REQUEST_EVENTS = 500;

const STATIC_MIME = /^(?:image\/|font\/|text\/css$|application\/javascript$|text\/javascript$)/;
/** A type alone doesn't prove a file: `/api/avatar` serving an image is an endpoint. */
const STATIC_FILE = /\.(?:png|jpe?g|gif|webp|avif|svg|ico|bmp|woff2?|ttf|otf|eot|css|[cm]?js|map)$/i;
const STATIC_PREFIX = "/_next/static/";
/** A Pages Router client navigation fetches this, not the page's own path. */
const NEXT_DATA = /^\/_next\/data\/[^/]+\/(.*)\.json$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const OPAQUE = /^(?=.*\d)[A-Za-z0-9_-]{20,}$/;
const JWT = /^[\w-]+\.[\w-]+\.[\w-]+$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const IP = /^(?:\d+\.\d+\.\d+\.\d+|\[.*\])$/;
const LOOPBACK = new Set(["localhost", "127.0.0.1", "[::1]"]);

/**
 * Which hosts are the application's, or null with no base URL to say. A host counts
 * when it shares its last two labels with a base URL: the action can't ship a public
 * suffix list, so `app.vercel.app` keeps `api.vercel.app` too, which only widens.
 */
export function hostsFor({ baseUrls, origins }: FootprintOrigins): ((host: string) => boolean) | null {
  const exact = new Set<string>();
  const parents = new Set<string>();
  let local = false;
  let anyBase = false;
  for (const url of baseUrls) {
    const host = hostnameOf(url);
    if (!host) continue;
    anyBase = true;
    if (LOOPBACK.has(host) || !host.includes(".")) local = true;
    else if (IP.test(host)) exact.add(host);
    else parents.add(host.split(".").slice(-2).join("."));
  }
  if (!anyBase) return null;
  for (const url of origins) {
    const host = hostnameOf(url);
    if (host) exact.add(host);
  }
  return (host) =>
    exact.has(host) ||
    (local && (LOOPBACK.has(host) || !host.includes("."))) ||
    (!IP.test(host) && parents.has(host.split(".").slice(-2).join(".")));
}

function hostnameOf(url: string): string | null {
  try {
    return new URL(url).hostname || null;
  } catch {
    return null;
  }
}

/** Whether a path segment could be somebody's: an id, a token, an address, a number. Folding too much only meets more. */
function isPrivate(raw: string): boolean {
  let segment = raw;
  try {
    segment = decodeURIComponent(raw);
  } catch {
    return true;
  }
  if (DATE.test(segment)) return false;
  if (segment.includes("@") || UUID.test(segment) || /\d{6,}/.test(segment) || OPAQUE.test(segment)) return true;
  // A phone or card number, however it's written.
  if (/^[+\d().\s_-]+$/.test(segment) && segment.replace(/\D/g, "").length >= 7) return true;
  // Base64's padding.
  if (/^[A-Za-z0-9+/_-]+={1,2}$/.test(segment)) return true;
  if (JWT.test(segment) && (segment.startsWith("eyJ") || segment.length >= 32)) return true;
  if (/^[0-9a-f]{8,}$/i.test(segment) && /\d/.test(segment)) return true;
  // A short token mixes cases and digits, and a long one mixes cases; a route's name doesn't.
  const mixed = /[a-z]/.test(segment) && /[A-Z]/.test(segment);
  if (mixed && /^[\w-]{8,}$/.test(segment) && /\d/.test(segment)) return true;
  return mixed && /^[A-Za-z]{16,}$/.test(segment);
}

/** The path with its opaque segments folded. A folded segment meets any route's segment (`match.ts`). */
export function foldPath(path: string): string {
  return path
    .split("/")
    .map((whole) => {
      // A `;parameter` isn't the path, and is where a session id goes.
      const segment = whole.split(";")[0]!;
      return segment !== "" && isPrivate(segment) ? ":id" : segment;
    })
    .join("/");
}

/**
 * Events as requests the events route takes: it refuses over 1 MB or 500 events, and
 * attempts of the largest footprint would pass that in one flush.
 */
export function eventBatches<T>(events: T[]): T[][] {
  const batches: T[][] = [];
  let current: T[] = [];
  let bytes = 0;
  for (const event of events) {
    const size = Buffer.byteLength(JSON.stringify(event)) + 1;
    if (current.length > 0 && (bytes + size > MAX_REQUEST_BYTES || current.length === MAX_REQUEST_EVENTS)) {
      batches.push(current);
      current = [];
      bytes = 0;
    }
    current.push(event);
    bytes += size;
  }
  if (current.length > 0) batches.push(current);
  return batches;
}

/** A URL's paths: one, or one per procedure of a tRPC batch. */
export function requestPaths(url: string): string[] {
  const { pathname } = new URL(url);
  const path = pathname.length > 1 ? pathname.replace(/\/+$/, "") : pathname;
  const batch = /^(.*\/trpc)\/([^/]*,[^/]*)$/.exec(path);
  const paths = batch ? batch[2]!.split(",").map((procedure) => `${batch[1]}/${procedure}`) : [path];
  const data = NEXT_DATA.exec(path);
  if (data) paths.push(data[1] === "index" ? "/" : `/${data[1]}`);
  return paths.map(foldPath);
}

export interface SentFootprint extends Footprint {
  attempt: { retry: number };
  /** The further origins Peeps listed, that this attempt filtered with. Peeps reads a list that has since changed as unknown. */
  origins: string[];
}

/**
 * What a `test_end` sends. `attempt` lets Peeps see an attempt that never reached it.
 * `--repeat-each` repeats share one run and collide there, so a repeated test's
 * footprint is never whole, and nor is one of a spec that may make requests its trace
 * doesn't hold (`test-trace.ts`). Whole means: this attempt's trace, read in full, within
 * the limits, from a spec with no request known to be outside it. Not: every path the
 * test could take on another day, or what the server did behind them.
 */
export function sentFootprint(footprint: Footprint, origins: string[], attempt: { retry: number; repeatEachIndex: number; repeatEach: number; hiddenRequests: boolean }): SentFootprint {
  const repeated = attempt.repeatEachIndex > 0 || attempt.repeatEach > 1;
  return { ...footprint, complete: footprint.complete && !repeated && !attempt.hiddenRequests, attempt: { retry: attempt.retry }, origins };
}

/** What a trace holds, as text: its `.network` entries, and its browser `.trace` entries. */
export interface TraceText {
  network: string[];
  actions: string[];
}

/**
 * The HAR entries in `.network` hold the requests, and the actions' params the
 * navigations: the trace has no structured navigation event. Only a trace recorded
 * with snapshots has a non-empty `.network`. A null trace couldn't be read.
 */
export function footprintFromText(traces: Array<TraceText | null>, origins: FootprintOrigins): Footprint {
  const isApp = hostsFor(origins);
  if (!isApp) return { paths: [], complete: false };
  const paths = new Set<string>();
  let complete = true;
  let sawNetwork = false;
  const add = (url: string) => {
    // `page.goto("/cart")` is in the trace as written.
    const parsed = new URL(url, origins.baseUrls.find((base) => hostnameOf(base)));
    if ((parsed.protocol !== "http:" && parsed.protocol !== "https:") || !isApp(parsed.hostname)) return;
    for (const path of requestPaths(parsed.href)) {
      if (path.startsWith(STATIC_PREFIX)) continue;
      if (path.length > MAX_PATH_LENGTH) complete = false;
      else paths.add(path);
    }
  };
  for (const trace of traces) {
    if (!trace) {
      complete = false;
      continue;
    }
    try {
      for (const text of trace.network) {
        for (const line of text.split("\n")) {
          if (line === "") continue;
          const event = JSON.parse(line) as {
            type?: string;
            snapshot?: { request?: { url?: string }; response?: { content?: { mimeType?: string } } };
          };
          if (event.type !== "resource-snapshot" || !event.snapshot?.request?.url) continue;
          sawNetwork = true;
          const mime = event.snapshot.response?.content?.mimeType?.split(";")[0]?.trim() ?? "";
          if (!STATIC_MIME.test(mime) || !STATIC_FILE.test(new URL(event.snapshot.request.url, "http://x").pathname)) add(event.snapshot.request.url);
        }
      }
      for (const text of trace.actions) {
        for (const line of text.split("\n")) {
          if (!line.includes('"goto"')) continue;
          const event = JSON.parse(line) as { type?: string; method?: string; params?: { url?: string } };
          if (event.type === "before" && event.method === "goto" && event.params?.url) add(event.params.url);
        }
      }
    } catch {
      complete = false;
    }
  }
  const sorted = [...paths].sort();
  return {
    paths: sorted.slice(0, MAX_FOOTPRINT_PATHS),
    complete: complete && sawNetwork && sorted.length > 0 && sorted.length <= MAX_FOOTPRINT_PATHS,
  };
}

/**
 * Whether the customer's own policy would have kept this attempt's trace, from
 * Playwright's `_shouldCaptureTrace` and `_shouldAbandonTrace`. With no policy the
 * wrapper didn't apply, and a mode from a later Playwright was left alone: neither
 * recording is ours to delete.
 */
export function keepsTrace(
  policy: string | undefined,
  attempt: { status: string; retry: number; expectedStatus: string },
): boolean {
  const failed = attempt.status !== attempt.expectedStatus;
  switch (policy) {
    case "off":
      return false;
    case "retain-on-failure":
      return failed;
    case "on-first-retry":
    case "retry-with-trace":
      return attempt.retry === 1;
    case "on-all-retries":
      return attempt.retry > 0;
    case "retain-on-first-failure":
      return attempt.retry === 0 && failed;
    case "retain-on-failure-and-retries":
      return failed || attempt.retry > 0;
    default:
      return true;
  }
}
