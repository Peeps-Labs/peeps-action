/**
 * Next.js conventions: which files are entries, and the route matcher of each. A
 * segment `[id]` is `:id`, `[...rest]` is `*`, `[[...rest]]` is `**`, and a route
 * group or a parallel slot adds nothing. A convention this doesn't know is no entry.
 */
import path from "node:path/posix";
import type { ConventionFactory } from "../convention";

const PAGE = /^page\.[cm]?[jt]sx?$/;
const ROUTE = /^route\.[cm]?[jt]sx?$/;
const BENEATH = /^(?:layout|template|loading|error|not-found|default|global-error)\.[cm]?[jt]sx?$/;
const SOURCE = /\.[cm]?[jt]sx?$/;
const CONFIG = /^next\.config\.[cm]?[jt]s$/;
const ROOT_LAYOUT = /^(?:src\/)?app\/layout\.[cm]?[jt]sx?$|^(?:src\/)?pages\/_(?:app|document)\.[cm]?[jt]sx?$/;
const ROOT_FILE = /^(?:src\/)?(?:middleware|proxy)\.[cm]?[jt]s$/;
const INSTRUMENTATION = /^(?:src\/)?instrumentation(?:-client)?\.[cm]?[jt]sx?$/;

/** Where Next is configured, or a dependency: and whether a route's URL is no longer its file's. */
function rootsOf(files: string[], read: (file: string) => string): { roots: string[]; moved: boolean } {
  const roots = new Set<string>();
  let moved = false;
  for (const file of files) {
    const base = path.basename(file);
    const dir = path.dirname(file) === "." ? "" : path.dirname(file);
    if (CONFIG.test(base)) {
      roots.add(dir);
      try {
        if (/\b(?:basePath|rewrites|i18n|pageExtensions)\b/.test(read(file))) moved = true;
      } catch {
        moved = true;
      }
    } else if (base === "package.json") {
      try {
        const { dependencies, devDependencies } = JSON.parse(read(file)) as { dependencies?: Record<string, unknown>; devDependencies?: Record<string, unknown> };
        if (dependencies?.next !== undefined || devDependencies?.next !== undefined) roots.add(dir);
      } catch {
        // An unreadable package.json names no framework.
      }
    }
  }
  return { roots: [...roots], moved };
}

/** The path below a Next root, for each root holding this file. */
function belowRoots(file: string, roots: string[]): string[] {
  return roots.filter((root) => root === "" || file.startsWith(`${root}/`)).map((root) => (root === "" ? file : file.slice(root.length + 1)));
}

export const next: ConventionFactory = ({ files, read }) => {
  const { roots, moved } = rootsOf(files, read);
  return {
    refusal: () => (moved ? "next_config_routing" : null),
    isGlobalFile: (file) => CONFIG.test(path.basename(file)) || belowRoots(file, roots).some((rest) => ROOT_LAYOUT.test(rest) || ROOT_FILE.test(rest)),
    isGlobalSymbol: (file) => belowRoots(file, roots).some((rest) => INSTRUMENTATION.test(rest)),
    fileSurface: (file) => nextEntry(file, roots),
    ownsFile: (file) =>
      belowRoots(file, roots).some((rest) => /^(?:src\/)?(?:app|pages)\//.test(rest)) ||
      roots.some((root) => root !== "" && file.startsWith(`${root}/`) && !/(?:^|\/)(?:README|CHANGELOG|LICENSE)[^/]*$/i.test(file)),
  };
};

/** The surface of an entry file, or null when it isn't one. */
export function nextEntry(file: string, roots: string[]): string | null {
  for (const root of roots) {
    const prefix = root === "" ? "" : `${root}/`;
    if (!file.startsWith(prefix)) continue;
    const rest = file.slice(prefix.length);
    for (const dir of ["app/", "src/app/"]) {
      if (rest.startsWith(dir)) {
        const surface = appEntry(rest.slice(dir.length));
        if (surface) return surface;
      }
    }
    for (const dir of ["pages/", "src/pages/"]) {
      if (rest.startsWith(dir)) {
        const surface = pagesEntry(rest.slice(dir.length));
        if (surface) return surface;
      }
    }
  }
  return null;
}

function appEntry(rest: string): string | null {
  const parts = rest.split("/");
  const name = parts.pop()!;
  const segments = routeSegments(parts);
  if (segments === null) return null;
  if (PAGE.test(name) || ROUTE.test(name)) return join(segments);
  if (BENEATH.test(name)) return join([...segments, "**"]);
  return null;
}

function pagesEntry(rest: string): string | null {
  if (!SOURCE.test(rest)) return null;
  const parts = rest.replace(SOURCE, "").split("/");
  if (parts[parts.length - 1] === "index") parts.pop();
  if (parts[0]?.startsWith("_")) return null;
  const segments = routeSegments(parts);
  return segments === null ? null : join(segments);
}

function routeSegments(parts: string[]): string[] | null {
  const out: string[] = [];
  for (const part of parts) {
    if (part.startsWith("@")) continue;
    // An intercepting route, `(.)photo`, shows another route's page: not read here.
    if (/^\(\.+\)/.test(part)) return null;
    if (part.startsWith("(") && part.endsWith(")")) continue;
    if (part.startsWith("_")) return null;
    const optional = /^\[\[\.\.\.(.+)\]\]$/.exec(part);
    if (optional) { out.push("**"); continue; }
    const catchAll = /^\[\.\.\.(.+)\]$/.exec(part);
    if (catchAll) { out.push("*"); continue; }
    const param = /^\[(.+)\]$/.exec(part);
    out.push(param ? `:${param[1]}` : part);
  }
  return out;
}

function join(segments: string[]): string {
  return `/${segments.join("/")}`;
}
