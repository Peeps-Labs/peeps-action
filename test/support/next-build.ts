/**
 * A small Next build, written the way Turbopack lays one out: module factories in
 * chunks, a source map per chunk named by its `sourceMappingURL`, CSS index maps with a
 * section per module, manifests and `.nft.json` traces. Every token of a module's own
 * code maps to that module's source; the chunk's wrappers map to nothing.
 */
const B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

function vlq(value: number): string {
  let v = value < 0 ? (-value << 1) | 1 : value << 1;
  let out = "";
  do {
    let digit = v & 31;
    v >>>= 5;
    if (v > 0) digit |= 32;
    out += B64[digit];
  } while (v > 0);
  return out;
}

/** Segments per generated line, absolute: [column, source, line, column]. */
export function encodeMappings(lines: Array<Array<[number, number, number, number]>>): string {
  let source = 0;
  let srcLine = 0;
  let srcCol = 0;
  return lines
    .map((segments) => {
      let col = 0;
      return segments
        .map(([c, s, l, sc]) => {
          const out = vlq(c - col) + vlq(s - source) + vlq(l - srcLine) + vlq(sc - srcCol);
          col = c;
          source = s;
          srcLine = l;
          srcCol = sc;
          return out;
        })
        .join(",");
    })
    .join(";");
}

export interface Module {
  /** As the map names it, e.g. `turbopack:///[project]/src/app/page.tsx`. */
  source: string;
  code: string;
  /** The factory's key in the chunk, when it isn't the source. */
  id?: string;
}

/** A chunk of module factories and its map. */
export function chunk(modules: Module[], mapName: string, prologue = "(globalThis.TURBOPACK = globalThis.TURBOPACK || []).push([document.currentScript, {"): { code: string; map: string } {
  const lines: string[] = [prologue];
  const mappings: Array<Array<[number, number, number, number]>> = [[]];
  modules.forEach((module, index) => {
    lines.push(`${JSON.stringify(module.id ?? module.source)}: ((__turbopack_context__) => {`);
    mappings.push([]);
    module.code.split("\n").forEach((line, srcLine) => {
      lines.push(line);
      const segments: Array<[number, number, number, number]> = [];
      for (const match of line.matchAll(/\S+/g)) segments.push([match.index!, index, srcLine, match.index!]);
      mappings.push(segments);
    });
    lines.push("}),");
    mappings.push([]);
  });
  lines.push("}]);");
  mappings.push([]);
  lines.push(`//# sourceMappingURL=${mapName}`);
  const map = { version: 3, sources: modules.map((m) => m.source), sourcesContent: modules.map((m) => m.code), names: [], mappings: encodeMappings(mappings) };
  return { code: lines.join("\n"), map: JSON.stringify(map) };
}

/** A stylesheet with an index map: one section per module's rules. */
export function stylesheet(sections: Array<{ source: string; css: string }>, mapName: string): { code: string; map: string } {
  const lines: string[] = [];
  const out: Array<{ offset: { line: number; column: number }; map: object }> = [];
  for (const section of sections) {
    out.push({ offset: { line: lines.length, column: 0 }, map: { version: 3, sources: [section.source], names: [], mappings: "AAAA" } });
    lines.push(...section.css.split("\n"));
  }
  lines.push(`/*# sourceMappingURL=${mapName} */`);
  return { code: lines.join("\n"), map: JSON.stringify({ version: 3, sections: out }) };
}

export interface BuildSource {
  buildId: string;
  /** A suffix for every hashed chunk name: a rebuild renames chunks. */
  hash: string;
  loginOnSuccess: string;
  ssoHeading: string;
  ssoStatic: boolean;
  badgeColor: string;
  badgeSpike: boolean;
  /** The client chunk's modules in another order, as a regrouped build has them. */
  reordered: boolean;
}

export const BASE: BuildSource = {
  buildId: "build-one",
  hash: "a1b2c3d4",
  loginOnSuccess: "sessionStorage.setItem('token', response.token);",
  ssoHeading: "",
  ssoStatic: false,
  badgeColor: "#15803d",
  badgeSpike: false,
  reordered: false,
};

const P = "turbopack:///[project]/";

/** The `.next` directory's files for one build of the fixture app. */
export function nextBuild(src: BuildSource): Map<string, string> {
  const files = new Map<string, string>();
  const login = `function LoginForm() {
  function onSuccess(response) {
    ${src.loginOnSuccess}
  }
  return onSuccess;
}
__turbopack_context__.s({ LoginForm });`;
  const badge = `const styles = __turbopack_context__.i(7);
__turbopack_context__.s({ default: () => Badge });
function Badge({ variant }) {
  return \`\${styles.badge} \${styles[variant]}${src.badgeSpike ? " ${styles.spike}" : ""}\`;
}`;
  const badgeClasses = `__turbopack_context__.v({ badge: "Badge-module__badge", ok: "Badge-module__ok"${src.badgeSpike ? ', spike: "Badge-module__spike"' : ""} });`;
  const util = `const formatDate = function formatDate(date) { return date.toISOString(); };`;
  const sso = `function SSOPage() {
  return render(${JSON.stringify(src.ssoHeading)}, ${JSON.stringify(src.buildId)});
}`;
  const modules = (layer: string) => [
    { source: `${P}src/app/login/LoginForm.tsx`, code: login },
    { source: `${P}src/components/common/Badge.tsx`, code: badge },
    { source: `${P}src/components/common/Badge.module.css`, id: `[project]/src/components/common/Badge.module.css [${layer}] (css module)`, code: badgeClasses },
  ];
  const clientModules = modules("client");
  const client = chunk(src.reordered ? clientModules.reverse() : clientModules, `${src.hash}c1.js.map`);
  files.set(`static/chunks/${src.hash}c1.js`, client.code);
  files.set(`static/chunks/${src.hash}c1.js.map`, client.map);
  // A module moved between chunks keeps its entity: the util lives in its own chunk.
  const utilChunk = chunk([{ source: `${P}src/lib/date.ts`, code: util }], `${src.hash}c2.js.map`);
  files.set(`static/chunks/${src.hash}c2.js`, utilChunk.code);
  files.set(`static/chunks/${src.hash}c2.js.map`, utilChunk.map);
  const ssr = chunk(modules("ssr"), `${src.hash}s1.js.map`);
  files.set(`server/chunks/ssr/${src.hash}s1.js`, ssr.code);
  files.set(`server/chunks/ssr/${src.hash}s1.js.map`, ssr.map);
  const page = chunk([{ source: `${P}src/app/sso/page.tsx`, code: sso }], "page.js.map");
  files.set("server/app/sso/page.js", page.code);
  files.set("server/app/sso/page.js.map", page.map);
  const css = stylesheet(
    [
      { source: `${P}src/app/globals.css`, css: "body {\n  margin: 0;\n}" },
      { source: `${P}src/components/common/Badge.module.css`, css: `.Badge-module__badge {\n  color: ${src.badgeColor};\n}${src.badgeSpike ? "\n.Badge-module__spike {\n  outline: 1px solid currentColor;\n}" : ""}` },
    ],
    `${src.hash}c3.css.map`,
  );
  files.set(`static/chunks/${src.hash}c3.css`, css.code);
  files.set(`static/chunks/${src.hash}c3.css.map`, css.map);
  if (src.ssoStatic) {
    files.set("server/app/sso.html", `<html><h1>${src.ssoHeading}</h1><script src="/_next/static/chunks/${src.hash}c1.js"></script></html>`);
    files.set("server/app/sso.rsc", `0:["${src.buildId}",[["${src.ssoHeading}"]]]`);
  }
  files.set("BUILD_ID", src.buildId);
  files.set("server/app-paths-manifest.json", JSON.stringify({ "/sso/page": "app/sso/page.js" }));
  files.set("prerender-manifest.json", JSON.stringify({ version: 4, routes: src.ssoStatic ? { "/sso": { htmlSize: src.ssoHeading.length } } : {}, preview: { previewModeId: `${src.buildId}-id`, previewModeSigningKey: `${src.buildId}-sign` } }));
  files.set("routes-manifest.json", JSON.stringify({ version: 3, basePath: "", rewrites: { beforeFiles: [], afterFiles: [], fallback: [] } }));
  files.set("server/app/sso/page.js.nft.json", JSON.stringify({ version: 1, files: ["../../chunks/ssr/" + `${src.hash}s1.js`, "../../../../node_modules/next/dist/server/runtime.js"] }));
  files.set("server/app/sso/page_client-reference-manifest.js", `globalThis.__RSC_MANIFEST["/sso/page"] = {"clientModules":{"x":{"chunks":["/_next/static/chunks/${src.hash}c1.js"]}}};`);
  return files;
}
