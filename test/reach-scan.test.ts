/**
 * The scanner, pure: a tree as a map, the changes as hunks, the reach as the answer.
 * Every doubt must read global; a bounded answer must name exactly the surfaces.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { scan, type ScanInput } from "../src/reach/scan";
import type { FileChange, Reach } from "../src/reach/types";
import { parseSource } from "../src/reach/parse";

/** The change of one line, in the new tree's coordinates. */
function lineChange(file: string, line: number, added = "x", removed = "y"): FileChange {
  return { path: file, status: "modified", binary: false, hunks: [{ newStart: line, newCount: 1, removed: [removed], added: [added] }] };
}

/** The line of `needle` in the file: the tests read as what they change. */
function lineOf(tree: Record<string, string>, file: string, needle: string): number {
  const at = tree[file]!.split("\n").findIndex((text) => text.includes(needle));
  assert.ok(at >= 0, `${needle} not in ${file}`);
  return at + 1;
}

function editAt(tree: Record<string, string>, file: string, needle: string): FileChange {
  const line = lineOf(tree, file, needle);
  const text = tree[file]!.split("\n")[line - 1]!;
  return lineChange(file, line, text, text);
}

function run(tree: Record<string, string>, changes: FileChange[], extra: Partial<ScanInput> = {}): Reach {
  return scan({
    files: Object.keys(tree),
    read: (file) => {
      const text = tree[file];
      if (text === undefined) throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
      return text;
    },
    changes,
    rootDir: "e2e",
    specFiles: [],
    base: "b".repeat(40),
    ...extra,
  });
}

function bounded(reach: Reach, surfaces: string[]) {
  assert.equal(reach.global, false, `read global: ${reach.why}`);
  assert.deepEqual(reach.surfaces, [...surfaces].sort());
}

function global(reach: Reach, why?: string) {
  assert.equal(reach.global, true, `read bounded: ${reach.surfaces.join(", ")}`);
  assert.deepEqual(reach.surfaces, []);
  if (why) assert.equal(reach.why, why);
}

const NEXT = { "next.config.js": "module.exports = {};\n", "package.json": '{"dependencies":{"next":"16"}}\n' };

// ---------------------------------------------------------------------------
// The text pass
// ---------------------------------------------------------------------------

for (const file of ["app/layout.tsx", "src/app/layout.tsx", "package.json", "package-lock.json", "yarn.lock", "pnpm-lock.yaml", "next.config.js", "next.config.ts", "playwright.config.ts", "middleware.ts", "src/middleware.ts", "proxy.ts", "src/proxy.ts", "tsconfig.json", "pages/_app.tsx"]) {
  test(`${file} changed answers global without parsing anything`, () => {
    let parsed = 0;
    const reach = run({ ...NEXT, [file]: "export default 1;\n", "app/page.tsx": "export default function P() {}\n" }, [lineChange(file, 1)], {
      parse: (name, text) => {
        parsed++;
        return parseSource(name, text);
      },
    });
    global(reach, "global_file");
    assert.equal(parsed, 0);
    assert.deepEqual(reach.reasons, [{ surface: null, file }]);
  });
}

test("a file the root layout imports reads global from its closure alone", () => {
  let parsed = 0;
  const tree = {
    ...NEXT,
    "app/layout.tsx": 'import { Shell } from "../components/shell";\nexport default function L() { return Shell; }\n',
    "components/shell.tsx": "export function Shell() {}\n",
  };
  const reach = run(tree, [lineChange("components/shell.tsx", 1)], {
    parse: (name, text) => {
      parsed++;
      return parseSource(name, text);
    },
  });
  global(reach, "global_file");
  assert.equal(parsed, 0);
});

test("only the closure is parsed", () => {
  const parsed: string[] = [];
  const tree = {
    ...NEXT,
    "app/a/page.tsx": 'import { x } from "../../lib/x";\nexport default function P() { return x(); }\n',
    "app/b/page.tsx": "export default function P() {}\n",
    "lib/x.ts": "export function x() {}\n",
    "lib/unrelated.ts": "export const y = 1;\n",
  };
  const reach = run(tree, [lineChange("lib/x.ts", 1)], {
    parse: (name, text) => {
      parsed.push(name);
      return parseSource(name, text);
    },
  });
  bounded(reach, ["/a"]);
  assert.deepEqual(parsed.sort(), ["app/a/page.tsx", "lib/x.ts"]);
});

test("more than 300 changed files is global, and past the deadline is global", () => {
  const many = Array.from({ length: 301 }, (_, i) => lineChange(`lib/f${i}.ts`, 1));
  const reach = run({ ...NEXT }, many);
  global(reach, "too_many_files");
  assert.equal(reach.changedFiles.length, 301);
  let now = 0;
  const late = run(
    { ...NEXT, "app/a/page.tsx": 'import { x } from "../../lib/x";\nexport default function P() { return x(); }\n', "lib/x.ts": "export function x() {}\n" },
    [lineChange("lib/x.ts", 1)],
    { now: () => (now += 60_000), deadlineMs: 90_000 },
  );
  global(late, "timeout");
});

test("more tracked files than the limit is global", () => {
  global(run({ ...NEXT }, [lineChange("lib/x.ts", 1)], { files: Array.from({ length: 50_001 }, (_, i) => `f${i}.ts`) }), "too_many_tracked_files");
});

// ---------------------------------------------------------------------------
// Next.js
// ---------------------------------------------------------------------------

test("a hunk in a dynamic page is its matcher; a route group adds nothing", () => {
  const tree = {
    ...NEXT,
    "app/orders/[id]/page.tsx": "export default function P() { return 1; }\n",
    "app/(dashboard)/[orgSlug]/test-cases/page.tsx": "export default function P() { return 1; }\n",
    "app/docs/[...rest]/page.tsx": "export default function P() { return 1; }\n",
    "app/help/[[...rest]]/page.tsx": "export default function P() { return 1; }\n",
    "src/app/nested/page.tsx": "export default function P() { return 1; }\n",
    "pages/about.tsx": "export default function P() { return 1; }\n",
    "pages/blog/[slug].tsx": "export default function P() { return 1; }\n",
    "pages/index.tsx": "export default function P() { return 1; }\n",
    "pages/api/ping.ts": "export default function h() {}\n",
    "app/api/orders/route.ts": "export async function GET() {}\n",
  };
  const cases: Array<[string, string]> = [
    ["app/orders/[id]/page.tsx", "/orders/:id"],
    ["app/(dashboard)/[orgSlug]/test-cases/page.tsx", "/:orgSlug/test-cases"],
    ["app/docs/[...rest]/page.tsx", "/docs/*"],
    ["app/help/[[...rest]]/page.tsx", "/help/**"],
    ["src/app/nested/page.tsx", "/nested"],
    ["pages/about.tsx", "/about"],
    ["pages/blog/[slug].tsx", "/blog/:slug"],
    ["pages/index.tsx", "/"],
    ["pages/api/ping.ts", "/api/ping"],
    ["app/api/orders/route.ts", "/api/orders"],
  ];
  for (const [file, surface] of cases) bounded(run(tree, [lineChange(file, 1)]), [surface]);
});

test("a nested layout, loading or error file meets what's beneath it", () => {
  const tree = {
    ...NEXT,
    "app/settings/layout.tsx": "export default function L() {}\n",
    "app/settings/loading.tsx": "export default function L() {}\n",
    "app/settings/error.tsx": "export default function L() {}\n",
  };
  for (const file of Object.keys(tree).filter((f) => f.startsWith("app/"))) bounded(run(tree, [lineChange(file, 1)]), ["/settings/**"]);
});

test("a component imported by two pages reaches both; a page importing a page reaches both", () => {
  const tree = {
    ...NEXT,
    "components/card.tsx": "export function Card() { return 1; }\nexport function Other() { return 2; }\n",
    "app/a/page.tsx": 'import { Card } from "../../components/card";\nexport default function P() { return <Card />; }\n',
    "app/b/page.tsx": 'import { Card } from "../../components/card";\nexport default function P() { return <Card />; }\n',
    "app/c/page.tsx": 'import B from "../b/page";\nexport default function P() { return <B />; }\n',
    "app/d/page.tsx": 'import { Other } from "../../components/card";\nexport default function P() { return <Other />; }\n',
  };
  bounded(run(tree, [lineChange("components/card.tsx", 1)]), ["/a", "/b", "/c"]);
  bounded(run(tree, [lineChange("app/b/page.tsx", 2)]), ["/b", "/c"]);
});

test("a route's file not known to Next's conventions has no entry", () => {
  const tree = { ...NEXT, "app/sitemap.ts": "export default function s() {}\n", "app/(.)photo/page.tsx": "export default function p() {}\n" };
  global(run(tree, [lineChange("app/sitemap.ts", 1)]), "no_entry");
  global(run(tree, [lineChange("app/(.)photo/page.tsx", 1)]), "no_entry");
});

test("app/ without Next isn't a Next app: a plain file in it has no entry", () => {
  const tree = { "package.json": "{}\n", "app/page.js": "module.exports = function p() {};\n" };
  global(run(tree, [lineChange("app/page.js", 1)]), "no_entry");
});

test("a config that moves routes can't be placed", () => {
  for (const word of ["basePath", "rewrites", "i18n"]) {
    const tree = { "package.json": '{"dependencies":{"next":"16"}}\n', "next.config.js": `module.exports = { ${word}: 1 };\n`, "app/a/page.tsx": "export default function P() {}\n" };
    global(run(tree, [lineChange("app/a/page.tsx", 1)]), "next_config_routing");
  }
});

test("a deleted page is its route; a deleted plain file is global; a renamed page is both routes", () => {
  const tree = { ...NEXT, "app/new/page.tsx": "export default function P() {}\n" };
  bounded(run(tree, [{ path: "app/old/page.tsx", status: "deleted", binary: false, hunks: [{ newStart: 0, newCount: 0, removed: ["x"], added: [] }] }]), ["/old"]);
  global(run(tree, [{ path: "lib/gone.ts", status: "deleted", binary: false, hunks: [{ newStart: 0, newCount: 0, removed: ["x"], added: [] }] }]), "deleted_file");
  bounded(run(tree, [{ path: "app/new/page.tsx", oldPath: "app/old/page.tsx", status: "renamed", binary: false, hunks: [] }]), ["/new", "/old"]);
});

test("a renamed or patch-less file is its whole module", () => {
  const tree = {
    ...NEXT,
    "lib/x.ts": "export function a() {}\nexport function b() {}\n",
    "app/a/page.tsx": 'import { a } from "../../lib/x";\nexport default function P() { return a(); }\n',
    "app/b/page.tsx": 'import { b } from "../../lib/x";\nexport default function P() { return b(); }\n',
  };
  bounded(run(tree, [{ path: "lib/x.ts", oldPath: "lib/y.ts", status: "renamed", binary: false, hunks: [] }]), ["/a", "/b"]);
  bounded(run(tree, [{ path: "lib/x.ts", status: "modified", binary: false, hunks: [] }]), ["/a", "/b"]);
});

test("a stylesheet is placed by what imports it; an image nothing names is global", () => {
  const tree = {
    ...NEXT,
    "app/a/page.tsx": 'import "./a.css";\nexport default function P() {}\n',
    "app/a/a.css": "body {}\n",
    "public/logo.png": "",
  };
  bounded(run(tree, [lineChange("app/a/a.css", 1)]), ["/a"]);
  global(run(tree, [{ path: "public/logo.png", status: "modified", binary: true, hunks: [] }]), "unplaced_file");
});

test("a side-effect import makes every symbol of the importer depend on it", () => {
  const tree = {
    ...NEXT,
    "lib/setup.ts": "export const unused = 1;\n",
    "components/c.tsx": 'import "../lib/setup";\nexport function C() {}\n',
    "app/a/page.tsx": 'import { C } from "../../components/c";\nexport default function P() { return C(); }\n',
  };
  bounded(run(tree, [lineChange("lib/setup.ts", 1)]), ["/a"]);
});

test("docs change nothing", () => {
  bounded(run({ ...NEXT, "README.md": "# x\n", "docs/a.txt": "x\n" }, [lineChange("README.md", 1), lineChange("docs/a.txt", 1)]), []);
});

// ---------------------------------------------------------------------------
// Symbols, not files
// ---------------------------------------------------------------------------

const SYMBOLS = {
  ...NEXT,
  "lib/a.ts": [
    'import type { T } from "./types";',
    'import { helper } from "./helper";',
    "// a comment",
    "export function used() { return helper(); }",
    "export function other(x: T) { return x; }",
    "export type Local = string;",
    "/** A doc block",
    " * on two lines */",
    "export const value = 1;",
    "",
  ].join("\n"),
  "lib/helper.ts": "export function helper() {}\n",
  "lib/types.ts": "export type T = string;\n",
  "app/a/page.tsx": 'import { used } from "../../lib/a";\nexport default function P() { return used(); }\n',
  "app/b/page.tsx": 'import { other } from "../../lib/a";\nexport default function P() { return other("x"); }\n',
  "app/c/page.tsx": 'import { value } from "../../lib/a";\nexport default function P() { return value; }\n',
};

test("a hunk in a symbol reaches that symbol's users, not the file's", () => {
  bounded(run(SYMBOLS, [editAt(SYMBOLS, "lib/a.ts", "function used")]), ["/a"]);
  bounded(run(SYMBOLS, [editAt(SYMBOLS, "lib/a.ts", "function other")]), ["/b"]);
});

test("a type-only import is no edge", () => {
  bounded(run(SYMBOLS, [lineChange("lib/types.ts", 1)]), []);
});

test("a type-only import doesn't tie a file to the root layout", () => {
  const tree = {
    ...NEXT,
    "app/layout.tsx": 'import type { T } from "../lib/shared";\nexport default function L(x: T) { return x; }\n',
    "lib/shared.ts": "export type T = string;\nexport function used() {}\n",
    "app/a/page.tsx": 'import { used } from "../../lib/shared";\nexport default function P() { return used(); }\n',
  };
  bounded(run(tree, [lineChange("lib/shared.ts", 2)]), ["/a"]);
});

test("a runtime import line marks every symbol using what it imports", () => {
  bounded(run(SYMBOLS, [editAt(SYMBOLS, "lib/a.ts", 'from "./helper"')]), ["/a"]);
});

test("a type-only import line, a type declaration and a comment pick nothing", () => {
  bounded(run(SYMBOLS, [editAt(SYMBOLS, "lib/a.ts", "import type")]), []);
  bounded(run(SYMBOLS, [editAt(SYMBOLS, "lib/a.ts", "export type Local")]), []);
  bounded(run(SYMBOLS, [editAt(SYMBOLS, "lib/a.ts", "// a comment")]), []);
  bounded(run(SYMBOLS, [editAt(SYMBOLS, "lib/a.ts", "/** A doc block")]), []);
  bounded(run(SYMBOLS, [editAt(SYMBOLS, "lib/a.ts", " * on two lines")]), []);
});

test("a comment inside a function picks nothing; removing one too; removing code doesn't", () => {
  const tree = { ...NEXT, "lib/x.ts": "export function x() {\n  // why\n  return 1;\n}\n", "app/a/page.tsx": 'import { x } from "../../lib/x";\nexport default function P() { return x(); }\n' };
  bounded(run(tree, [lineChange("lib/x.ts", 2, "  // why", "  // old")]), []);
  bounded(run(tree, [{ path: "lib/x.ts", status: "modified", binary: false, hunks: [{ newStart: 2, newCount: 0, removed: ["  // gone"], added: [] }] }]), []);
  bounded(run(tree, [{ path: "lib/x.ts", status: "modified", binary: false, hunks: [{ newStart: 2, newCount: 0, removed: ["  doSomething();"], added: [] }] }]), ["/a"]);
});

test("removing a statement between declarations marks the whole file: it could have been an import with an effect", () => {
  const tree = {
    ...NEXT,
    "lib/x.ts": "export function a() {}\n\nexport function b() {}\n",
    "app/a/page.tsx": 'import { a } from "../../lib/x";\nexport default function P() { return a(); }\n',
    "app/b/page.tsx": 'import { b } from "../../lib/x";\nexport default function P() { return b(); }\n',
  };
  bounded(run(tree, [{ path: "lib/x.ts", status: "modified", binary: false, hunks: [{ newStart: 2, newCount: 0, removed: ['import "./effect";'], added: [] }] }]), ["/a", "/b"]);
});

test("a top-level statement that isn't a route is an effect nobody can place", () => {
  const tree = { ...NEXT, "lib/x.ts": "export function x() {}\nregister(x);\nfunction register(f) {}\n", "app/a/page.tsx": 'import { x } from "../../lib/x";\nexport default function P() { return x(); }\n' };
  global(run(tree, [lineChange("lib/x.ts", 2)]), "module_effect");
  global(run(tree, [lineChange("lib/x.ts", 1)]), "module_effect");
});

test("re-exports carry the edge, by name and by star; a hunk on the re-export line marks its users", () => {
  const tree = {
    ...NEXT,
    "lib/real.ts": "export function a() {}\nexport function b() {}\n",
    "lib/named.ts": 'export { a as renamed } from "./real";\n',
    "lib/star.ts": 'export * from "./real";\n',
    "app/a/page.tsx": 'import { renamed } from "../../lib/named";\nexport default function P() { return renamed(); }\n',
    "app/b/page.tsx": 'import { b } from "../../lib/star";\nexport default function P() { return b(); }\n',
  };
  bounded(run(tree, [lineChange("lib/real.ts", 1)]), ["/a"]);
  bounded(run(tree, [lineChange("lib/real.ts", 2)]), ["/b"]);
  bounded(run(tree, [lineChange("lib/named.ts", 1)]), ["/a"]);
  bounded(run(tree, [lineChange("lib/star.ts", 1)]), ["/b"]);
});

test("a namespace import narrows by the member read, and reaches everything when it can't", () => {
  const tree = {
    ...NEXT,
    "lib/x.ts": "export function a() {}\nexport function b() {}\n",
    "app/a/page.tsx": 'import * as x from "../../lib/x";\nexport default function P() { return x.a(); }\n',
    "app/b/page.tsx": 'import * as x from "../../lib/x";\nexport default function P() { return Object.keys(x); }\n',
  };
  bounded(run(tree, [lineChange("lib/x.ts", 1)]), ["/a", "/b"]);
  bounded(run(tree, [lineChange("lib/x.ts", 2)]), ["/b"]);
});

test("a dynamic import and next/dynamic are edges", () => {
  const tree = {
    ...NEXT,
    "lib/x.ts": "export default function x() {}\n",
    "app/a/page.tsx": 'import dynamic from "next/dynamic";\nconst X = dynamic(() => import("../../lib/x"));\nexport default function P() { return <X />; }\n',
  };
  bounded(run(tree, [lineChange("lib/x.ts", 1)]), ["/a"]);
});

test("tsconfig paths are followed, through extends and baseUrl", () => {
  const tree = {
    ...NEXT,
    "tsconfig.base.json": '{ // comment\n "compilerOptions": { "baseUrl": ".", "paths": { "~/*": ["./src/*"] } } }\n',
    "tsconfig.json": '{ "extends": "./tsconfig.base.json", }\n',
    "src/lib/x.ts": "export function x() {}\n",
    "src/app/a/page.tsx": 'import { x } from "~/lib/x";\nexport default function P() { return x(); }\n',
  };
  bounded(run(tree, [lineChange("src/lib/x.ts", 1)]), ["/a"]);
});

test("an ESM .js naming a TypeScript source resolves", () => {
  const tree = { ...NEXT, "lib/x.ts": "export function x() {}\n", "app/a/page.tsx": 'import { x } from "../../lib/x.js";\nexport default function P() { return x(); }\n' };
  bounded(run(tree, [lineChange("lib/x.ts", 1)]), ["/a"]);
});

test("a workspace package imported by name can't be followed", () => {
  const tree = {
    ...NEXT,
    "packages/ui/package.json": '{"name":"@acme/ui"}\n',
    "packages/ui/src/button.tsx": "export function B() {}\n",
    "packages/ui/src/index.ts": 'export { B } from "./button";\n',
    "apps/web/next.config.js": "module.exports = {};\n",
    "apps/web/app/a/page.tsx": 'import { B } from "@acme/ui";\nimport { rel } from "../../../../packages/ui/src/button";\nexport default function P() { return B(rel); }\n',
  };
  global(run(tree, [lineChange("packages/ui/src/button.tsx", 1)]), "workspace_package");
});

test("a Next app in a package of a monorepo has its own root", () => {
  const tree = {
    "package.json": "{}\n",
    "apps/web/next.config.js": "module.exports = {};\n",
    "apps/web/app/a/page.tsx": "export default function P() {}\n",
    "apps/web/src/app/b/page.tsx": "export default function P() {}\n",
  };
  bounded(run(tree, [lineChange("apps/web/app/a/page.tsx", 1)]), ["/a"]);
  bounded(run(tree, [lineChange("apps/web/src/app/b/page.tsx", 1)]), ["/b"]);
});

// ---------------------------------------------------------------------------
// tRPC
// ---------------------------------------------------------------------------

const TRPC = {
  ...NEXT,
  "server/trpc.ts": "export const createTRPCRouter = (x) => x;\nexport const publicProcedure = { query: (f) => f, mutation: (f) => f };\n",
  "server/routers/runs.ts": [
    'import { createTRPCRouter, publicProcedure } from "../trpc";',
    'import { listRuns } from "../services/runs";',
    "export const runsRouter = createTRPCRouter({",
    "  list: publicProcedure.query(() => listRuns()),",
    "  get: publicProcedure.query(() => 2),",
    "  rename: publicProcedure.mutation(() => {",
    "    return 3;",
    "  }),",
    "});",
    "",
  ].join("\n"),
  "server/routers/cases.ts": [
    'import { createTRPCRouter, publicProcedure } from "../trpc";',
    "export const casesRouter = createTRPCRouter({",
    "  list: publicProcedure.query(() => 1),",
    "});",
    "",
  ].join("\n"),
  "server/services/runs.ts": "export function listRuns() { return []; }\nexport function unused() {}\n",
  "server/root.ts": [
    'import { createTRPCRouter } from "./trpc";',
    'import { runsRouter } from "./routers/runs";',
    'import { casesRouter } from "./routers/cases";',
    "export const appRouter = createTRPCRouter({ runs: runsRouter, cases: casesRouter });",
    "export type AppRouter = typeof appRouter;",
    "",
  ].join("\n"),
  "app/api/trpc/[trpc]/route.ts": [
    'import { fetchRequestHandler } from "@trpc/server/adapters/fetch";',
    'import { appRouter } from "../../../../server/root";',
    'const handler = (req) => fetchRequestHandler({ endpoint: "/api/trpc", req, router: appRouter });',
    "export { handler as GET, handler as POST };",
    "",
  ].join("\n"),
  "trpc/react.tsx": 'import type { AppRouter } from "../server/root";\nexport const api = {} as AppRouter;\n',
  "app/runs/page.tsx": 'import { api } from "../../trpc/react";\nexport default function P() { return api.runs.list.useQuery(); }\n',
  "trpc/server.ts": [
    'import { appRouter } from "../server/root";',
    "const caller = appRouter.createCaller({});",
    "export const api = caller;",
    "",
  ].join("\n"),
  "app/server-page/page.tsx": 'import { api } from "../../trpc/server";\nexport default async function P() { return api.runs.get(); }\n',
};

test("a hunk in a procedure is that procedure alone", () => {
  bounded(run(TRPC, [editAt(TRPC, "server/routers/runs.ts", "list: publicProcedure")]), ["/api/trpc/runs.list"]);
  bounded(run(TRPC, [editAt(TRPC, "server/routers/runs.ts", "return 3;")]), ["/api/trpc/runs.rename"]);
  bounded(run(TRPC, [editAt(TRPC, "server/routers/cases.ts", "list: publicProcedure")]), ["/api/trpc/cases.list"]);
});

test("a service called by one procedure is that procedure", () => {
  bounded(run(TRPC, [editAt(TRPC, "server/services/runs.ts", "function listRuns")]), ["/api/trpc/runs.list"]);
});

test("a server component calling through createCaller is reached; the client's useQuery isn't", () => {
  bounded(run(TRPC, [editAt(TRPC, "server/routers/runs.ts", "get: publicProcedure")]), ["/api/trpc/runs.get", "/server-page"]);
});

test("a local createCaller in a handler is reached", () => {
  const tree = {
    ...TRPC,
    "app/api/hook/route.ts": 'import { appRouter } from "../../../server/root";\nexport async function POST() {\n  const caller = appRouter.createCaller({});\n  return caller.runs.get();\n}\n',
  };
  bounded(run(tree, [editAt(tree, "server/routers/runs.ts", "get: publicProcedure")]), ["/api/hook", "/api/trpc/runs.get", "/server-page"]);
});

test("a change to the router itself reaches its handler and everything through it", () => {
  const reach = run(TRPC, [editAt(TRPC, "server/root.ts", "export const appRouter")]);
  assert.equal(reach.global, false, String(reach.why));
  assert.ok(reach.surfaces.includes("/api/trpc/:trpc"), reach.surfaces.join());
});

test("a handler with no endpoint outside a route file can't say where it serves", () => {
  const tree = {
    "package.json": "{}\n",
    "server/routers.ts": 'export const appRouter = createTRPCRouter({\n  x: publicProcedure.query(() => 1),\n});\n',
    "server/main.js": 'const { appRouter } = require("./routers");\nexport const h = createExpressMiddleware({ router: appRouter });\n',
  };
  global(run(tree, [lineChange("server/routers.ts", 2)]), "unknown_route");
});

test("a router no handler serves has no entry", () => {
  const tree = { ...TRPC, "server/routers/orphan.ts": 'import { createTRPCRouter, publicProcedure } from "../trpc";\nexport const orphan = createTRPCRouter({ x: publicProcedure.query(() => 1) });\n' };
  global(run(tree, [lineChange("server/routers/orphan.ts", 2)]), "no_entry");
});

test("a router spreading another can't name its procedures", () => {
  const tree = {
    ...TRPC,
    "server/root.ts": [
      'import { createTRPCRouter } from "./trpc";',
      'import { runsRouter } from "./routers/runs";',
      "export const appRouter = createTRPCRouter({ ...runsRouter });",
      "",
    ].join("\n"),
  };
  // The spread reaches the handler as a reference, so the walk still has an entry: the whole API.
  const reach = run(tree, [editAt(tree, "server/routers/runs.ts", "get: publicProcedure")]);
  if (!reach.global) assert.ok(reach.surfaces.includes("/api/trpc/:trpc"), reach.surfaces.join());
});

// ---------------------------------------------------------------------------
// Bridges
// ---------------------------------------------------------------------------

const TASKS = {
  ...NEXT,
  "trigger/send.ts": 'import { task } from "@trigger.dev/sdk";\nexport const send = task({\n  id: "send-email",\n  run: async () => 1,\n});\n',
  "trigger/ids.ts": 'export const NIGHTLY_ID = "nightly-job";\n',
  "trigger/nightly.ts": 'import { task } from "@trigger.dev/sdk";\nimport { NIGHTLY_ID } from "./ids";\nexport const nightly = task({ id: NIGHTLY_ID, run: async () => 1 });\n',
  "app/api/send/route.ts": 'import { tasks } from "@trigger.dev/sdk";\nexport async function POST() { return tasks.trigger("send-email", {}); }\n',
  "app/api/nightly/route.ts": 'import { tasks } from "@trigger.dev/sdk";\nimport { NIGHTLY_ID } from "../../../trigger/ids";\nexport async function POST() { return tasks.trigger(NIGHTLY_ID, {}); }\n',
  "trigger/orphan.ts": 'import { task } from "@trigger.dev/sdk";\nexport const orphan = task({ id: "nobody-calls-me", run: async () => 1 });\n',
};

test("a Trigger task is reached by its id, literal or a constant", () => {
  bounded(run(TASKS, [editAt(TASKS, "trigger/send.ts", "run: async")]), ["/api/send"]);
  bounded(run(TASKS, [editAt(TASKS, "trigger/nightly.ts", "export const nightly")]), ["/api/nightly"]);
});

test("a task nobody dispatches has no entry", () => {
  global(run(TASKS, [lineChange("trigger/orphan.ts", 2)]), "no_entry");
});

test('fetch("/api/orders") bridges a route to its caller', () => {
  const tree = {
    ...NEXT,
    "app/api/orders/route.ts": "export async function GET() {}\n",
    "app/api/orders/[id]/route.ts": "export async function GET() {}\n",
    "lib/client.ts": 'export function load() { return fetch("/api/orders"); }\nexport function one(id) { return fetch(`/api/orders/${id}`); }\n',
    "app/a/page.tsx": 'import { load } from "../../lib/client";\nexport default function P() { return load(); }\n',
    "app/b/page.tsx": 'import { one } from "../../lib/client";\nexport default function P() { return one(1); }\n',
  };
  bounded(run(tree, [lineChange("app/api/orders/route.ts", 1)]), ["/a", "/api/orders"]);
  bounded(run(tree, [lineChange("app/api/orders/[id]/route.ts", 1)]), ["/api/orders/:id", "/b"]);
});

test("instrumentation is a composition root: reaching it is global", () => {
  const tree = {
    ...NEXT,
    "lib/container.ts": "export function getContainer() {}\n",
    "instrumentation.ts": 'import { getContainer } from "./lib/container";\nexport function register() { getContainer(); }\n',
    "app/a/page.tsx": 'import { getContainer } from "../../lib/container";\nexport default function P() { return getContainer(); }\n',
  };
  global(run(tree, [lineChange("lib/container.ts", 1)]), "global_file");
});

// ---------------------------------------------------------------------------
// Express
// ---------------------------------------------------------------------------

const EXPRESS_APP = {
  "package.json": '{"dependencies":{"express":"5"}}\n',
  "app/server.js": [
    'const express = require("express");',
    'const cart = require("./cart");',
    'const { orders } = require("./orders");',
    'const handlers = require("./handlers");',
    "const app = express();",
    'app.get("/catalog", (req, res) => {',
    "  res.send(1);",
    "});",
    'app.get("/about", handlers.about);',
    'app.get("/users/:id", handlers.user);',
    'app.post("/api/cart/add", handlers.addToCart);',
    'app.use("/cart", cart);',
    'app.use("/orders", orders);',
    "app.listen(3000);",
    "",
  ].join("\n"),
  "app/cart.js": [
    'const express = require("express");',
    "const router = express.Router();",
    'router.get("/", (req, res) => res.send(1));',
    'router.post("/items", (req, res) => res.send(2));',
    "module.exports = router;",
    "",
  ].join("\n"),
  "app/orders.js": [
    'const { Router } = require("express");',
    "const orders = Router();",
    'orders.get("/:id", (req, res) => res.send(1));',
    "module.exports = { orders };",
    "",
  ].join("\n"),
  "app/handlers.js": [
    "exports.about = function about(req, res) { res.send(1); };",
    "exports.user = function user(req, res) { res.send(2); };",
    "function addToCart(req, res) { res.send(3); }",
    "exports.addToCart = addToCart;",
    "",
  ].join("\n"),
};

test("Express: a hunk in a literal route is its path", () => {
  bounded(run(EXPRESS_APP, [editAt(EXPRESS_APP, "app/server.js", "res.send(1);")]), ["/catalog"]);
});

test("Express: a handler in another file reaches its routes, narrowed by the member read", () => {
  bounded(run(EXPRESS_APP, [editAt(EXPRESS_APP, "app/handlers.js", "exports.about")]), ["/about"]);
  bounded(run(EXPRESS_APP, [editAt(EXPRESS_APP, "app/handlers.js", "exports.user")]), ["/users/:id"]);
  bounded(run(EXPRESS_APP, [editAt(EXPRESS_APP, "app/handlers.js", "function addToCart")]), ["/api/cart/add"]);
});

test("Express: a router mounted by a literal joins the paths", () => {
  bounded(run(EXPRESS_APP, [editAt(EXPRESS_APP, "app/cart.js", 'router.get("/"')]), ["/cart"]);
  bounded(run(EXPRESS_APP, [editAt(EXPRESS_APP, "app/cart.js", 'router.post("/items"')]), ["/cart/items"]);
  bounded(run(EXPRESS_APP, [editAt(EXPRESS_APP, "app/orders.js", 'orders.get("/:id"')]), ["/orders/:id"]);
});

test("Express: an inline require mount and an ESM router", () => {
  const tree = {
    "package.json": "{}\n",
    "server.mjs": 'import express from "express";\nimport cart from "./cart.mjs";\nconst app = express();\napp.use("/cart", cart);\napp.use("/inline", (await import("./other.mjs")).default);\n',
    "cart.mjs": 'import express from "express";\nconst router = express.Router();\nrouter.get("/x", () => 1);\nexport default router;\n',
    "other.mjs": "export default function other() {}\n",
  };
  bounded(run(tree, [lineChange("cart.mjs", 3)]), ["/cart/x"]);
  const req = {
    "package.json": "{}\n",
    "server.js": 'const express = require("express");\nconst app = express();\napp.use("/cart", require("./cart"));\n',
    "cart.js": 'const router = require("express").Router();\nrouter.get("/y", () => 1);\nmodule.exports = router;\n',
  };
  bounded(run(req, [lineChange("cart.js", 2)]), ["/cart/y"]);
});

test("Express: a router mounted by a variable is global", () => {
  const tree = {
    ...EXPRESS_APP,
    "app/server.js": EXPRESS_APP["app/server.js"].replace('app.use("/cart", cart);', 'const prefix = process.env.PREFIX;\napp.use(prefix, cart);'),
  };
  global(run(tree, [editAt(tree, "app/cart.js", 'router.get("/"')]), "unknown_route");
});

test("Express: a route with a computed path is global", () => {
  const tree = { "package.json": "{}\n", "s.js": 'const app = require("express")();\nfunction h() {}\napp.get(process.env.P, h);\n' };
  global(run(tree, [lineChange("s.js", 2)]), "unknown_route");
});

test("Express: middleware for everything is global; for a path, that path and beneath", () => {
  const tree = {
    "package.json": "{}\n",
    "s.js": 'const app = require("express")();\nfunction audit() {}\nfunction limit() {}\napp.use(audit);\napp.use("/api", limit);\n',
  };
  global(run(tree, [lineChange("s.js", 2)]), "global_surface");
  bounded(run(tree, [lineChange("s.js", 3)]), ["/api/**"]);
});

test("Express: app.get with one argument reads a setting, and isn't a route", () => {
  const tree = { "package.json": "{}\n", "s.js": 'const app = require("express")();\nfunction h() {}\napp.get("views");\nexport { h };\n' };
  global(run(tree, [lineChange("s.js", 3)]), "module_effect");
});

test("Express: a change to the app's construction reaches everything", () => {
  global(run(EXPRESS_APP, [editAt(EXPRESS_APP, "app/server.js", "const app = express()")]));
});

test("a server routing by hand in http.createServer has no entry", () => {
  const tree = {
    "package.json": "{}\n",
    "app/server.js": [
      'const http = require("http");',
      "function cart(req, res) { res.end(1); }",
      "const server = http.createServer((req, res) => {",
      '  if (req.url === "/cart") return cart(req, res);',
      "});",
      "server.listen(3000);",
      "",
    ].join("\n"),
  };
  global(run(tree, [editAt(tree, "app/server.js", "function cart")]));
});

// ---------------------------------------------------------------------------
// What can't be read
// ---------------------------------------------------------------------------

test("an unparseable file in the closure is global", () => {
  const tree = { ...NEXT, "app/a/page.tsx": "export default function P( {{{\n" };
  global(run(tree, [lineChange("app/a/page.tsx", 1)]), "unparsed_file");
});

test("an annotated async arrow in a ternary parses: one file like it must not make every change around it global", () => {
  const tree = {
    ...NEXT,
    "lib/x.ts": "export function x() { return 1; }\n",
    "app/a/route.ts": 'import { x } from "../../lib/x";\nconst r = 1 ? async (p: string): Promise<number | null> => {\n  return x();\n} : null;\nexport async function GET() { return r; }\n',
  };
  bounded(run(tree, [lineChange("lib/x.ts", 1)]), ["/a"]);
});

test("a file over 1 MB in the closure is global; a 90 KB router parses whole", () => {
  const big = `export const x = 1;\n${"// pad\n".repeat(160_000)}`;
  const tree = { ...NEXT, "lib/big.ts": big, "app/a/page.tsx": 'import { x } from "../../lib/big";\nexport default function P() { return x; }\n' };
  global(run(tree, [lineChange("lib/big.ts", 1)]), "unparsed_file");
  const padded = ["export const appRouter = createTRPCRouter({", ...Array.from({ length: 2400 }, (_, i) => `  p${i}: publicProcedure.query(() => ${i}),`), "});", ""].join("\n");
  assert.ok(padded.length > 90_000);
  const router = {
    ...NEXT,
    "server/root.ts": padded,
    "app/api/trpc/[trpc]/route.ts": 'import { appRouter } from "../../../../server/root";\nexport const GET = (req) => fetchRequestHandler({ req, router: appRouter });\n',
  };
  bounded(run(router, [editAt(router, "server/root.ts", "p2399:")]), ["/api/trpc/p2399"]);
});

test("a tracked file missing from the tree, in the closure, is global", () => {
  const reach = run({ ...NEXT, "app/a/page.tsx": "export default function P() {}\n" }, [lineChange("lib/x.ts", 1)], { files: [...Object.keys(NEXT), "app/a/page.tsx", "lib/x.ts"] });
  global(reach);
});

// ---------------------------------------------------------------------------
// The test root
// ---------------------------------------------------------------------------

const SUITE = {
  ...NEXT,
  "e2e/cart.spec.ts": 'import { CartPage } from "./pages/cart";\nimport data from "./data.json";\ntest("x", () => CartPage(data));\n',
  "e2e/pages/cart.ts": "export function CartPage() {}\n",
  "e2e/data.json": "{}\n",
  "e2e/stray.txt": "not named\n",
  "app/a/page.tsx": "export default function P() {}\n",
};
const SPECS = { specFiles: ["e2e/cart.spec.ts"] };

test("a spec, a page object and a fixture go in changedTestFiles and pick nothing themselves", () => {
  for (const file of ["e2e/cart.spec.ts", "e2e/pages/cart.ts", "e2e/data.json"]) {
    const reach = run(SUITE, [lineChange(file, 1)], SPECS);
    bounded(reach, []);
    assert.deepEqual(reach.changedTestFiles, [file]);
    assert.deepEqual(reach.changedFiles, [file]);
  }
});

test("a file under the test root no spec reaches is global", () => {
  global(run(SUITE, [lineChange("e2e/stray.txt", 1)], SPECS), "unplaced_test_file");
});

test("with the config at the repository root the same holds, and an app file a spec imports counts as both", () => {
  const tree = {
    ...NEXT,
    "tests/cart.spec.ts": 'import { CartPage } from "./pages/cart";\nimport { fmt } from "../lib/fmt";\ntest("x", () => CartPage(fmt));\n',
    "tests/pages/cart.ts": "export function CartPage() {}\n",
    "lib/fmt.ts": "export function fmt() {}\n",
    "app/a/page.tsx": 'import { fmt } from "../../lib/fmt";\nexport default function P() { return fmt(); }\n',
  };
  const input = { rootDir: ".", specFiles: ["tests/cart.spec.ts"] };
  const page = run(tree, [lineChange("tests/pages/cart.ts", 1)], input);
  bounded(page, []);
  assert.deepEqual(page.changedTestFiles, ["tests/pages/cart.ts"]);
  const both = run(tree, [lineChange("lib/fmt.ts", 1)], input);
  bounded(both, ["/a"]);
  assert.deepEqual(both.changedTestFiles, ["lib/fmt.ts"]);
});

test("a unit test beside the code changes no app surface", () => {
  const tree = { ...NEXT, "lib/x.ts": "export function x() {}\n", "lib/x.test.ts": 'import { x } from "./x";\ntest("x", () => x());\n', "app/a/page.tsx": 'import { x } from "../../lib/x";\nexport default function P() { return x(); }\n' };
  bounded(run(tree, [lineChange("lib/x.test.ts", 1)]), []);
  bounded(run(tree, [lineChange("lib/x.ts", 1)]), ["/a"]);
});

// ---------------------------------------------------------------------------
// What's sent
// ---------------------------------------------------------------------------

test("reasons name the changed file behind each surface, and nothing of the source goes out", () => {
  const reach = run(SYMBOLS, [editAt(SYMBOLS, "lib/a.ts", "function used")]);
  assert.deepEqual(reach.reasons, [{ surface: "/a", file: "lib/a.ts" }]);
  assert.equal(reach.base, "b".repeat(40));
  assert.ok(!JSON.stringify(reach).includes("helper()"));
});

test("too many surfaces is global", () => {
  const tree: Record<string, string> = { ...NEXT, "lib/x.ts": "export function x() {}\n" };
  for (let i = 0; i < 2001; i++) tree[`app/p${i}/page.tsx`] = 'import { x } from "../../lib/x";\nexport default function P() { return x(); }\n';
  global(run(tree, [lineChange("lib/x.ts", 1)]), "too_many_surfaces");
});
