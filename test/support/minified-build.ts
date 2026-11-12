/**
 * Minified server chunks, the way a production Turbopack build writes them: an array of
 * `id, factory` pairs, every local renamed by the minifier, and a map whose segments name
 * the original identifier where the minifier renamed one. Turbopack's own bindings (an
 * import's namespace, say) have no original name: they map to their source position only.
 * A chunk's minifier names locals by the chunk, so the same module gets other names in a
 * chunk beside other modules (PQA-3494).
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

type Segment = [number, number, number, number] | [number, number, number, number, number];

function encode(lines: Segment[][]): string {
  const state = [0, 0, 0, 0, 0];
  return lines
    .map((segments) => {
      state[0] = 0;
      return segments
        .map((segment) => {
          let out = "";
          segment.forEach((value, i) => {
            out += vlq(value - state[i]!);
            state[i] = value;
          });
          return out;
        })
        .join(",");
    })
    .join(";");
}

/** A minifier's rename: to a name the map keeps the original of, or (`named: false`) one it doesn't. */
export type Rename = string | { to: string; named: false };

export interface ServerModule {
  id: number;
  /** As the map names it, e.g. `turbopack:///[project]/lib/variant.ts`. */
  source: string;
  /** The module's original code; each line becomes one generated line. */
  code: string;
}

/** A string, an identifier written `built@original` (the map names `original`), an identifier, or any other character. */
const TOKEN = /"(?:[^"\\]|\\.)*"|[A-Za-z_$][\w$]*@[A-Za-z_$][\w$]*|[A-Za-z_$][\w$]*|\S/g;

/** One server chunk and its map, `renames` applied to every identifier not after a `.`. */
export function serverChunk(modules: ServerModule[], renames: Record<string, Rename>, mapName: string): { code: string; map: string } {
  const lines: string[] = ["module.exports=["];
  const mappings: Segment[][] = [[]];
  const names: string[] = [];
  const sources = [...new Set(modules.map((m) => m.source))];
  modules.forEach((module) => {
    // The factory's wrapper is scaffolding: it maps to nothing.
    lines.push(`${module.id},e=>{`);
    mappings.push([]);
    module.code.split("\n").forEach((line, srcLine) => {
      // A line starting `!` is generated glue: written as it is, mapped to nothing.
      if (line.startsWith("!")) {
        lines.push(line.slice(1));
        mappings.push([]);
        return;
      }
      let out = "";
      const segments: Segment[] = [];
      let last = 0;
      for (const match of line.matchAll(TOKEN)) {
        out += line.slice(last, match.index!);
        last = match.index! + match[0].length;
        const source = sources.indexOf(module.source);
        const named = /^([A-Za-z_$][\w$]*)@([A-Za-z_$][\w$]*)$/.exec(match[0]);
        if (named) {
          if (!names.includes(named[2]!)) names.push(named[2]!);
          segments.push([out.length, source, srcLine, match.index!, names.indexOf(named[2]!)]);
          out += named[1];
          continue;
        }
        const rename = /^[A-Za-z_$]/.test(match[0]) && line[match.index! - 1] !== "." ? renames[match[0]] : undefined;
        if (rename === undefined) {
          segments.push([out.length, source, srcLine, match.index!]);
          out += match[0];
        } else if (typeof rename === "string") {
          if (!names.includes(match[0])) names.push(match[0]);
          segments.push([out.length, source, srcLine, match.index!, names.indexOf(match[0])]);
          out += rename;
        } else {
          segments.push([out.length, source, srcLine, match.index!]);
          out += rename.to;
        }
      }
      lines.push(out + line.slice(last));
      mappings.push(segments);
    });
    lines.push("},");
    mappings.push([]);
  });
  lines.push("];");
  mappings.push([]);
  lines.push(`//# sourceMappingURL=${mapName}`);
  return { code: lines.join("\n"), map: JSON.stringify({ version: 3, sources, names, mappings: encode(mappings) }) };
}

/** A `.next` of server chunks: chunk file name → its modules and the renames its minifier chose. */
export function serverBuild(
  chunks: Record<string, { modules: ServerModule[]; renames: Record<string, Rename> }>,
  /** Turbopack's route entries: the built file (`server/app/api/a/route.js`) → the module it instantiates. */
  entries: Record<string, number> = {},
): Map<string, string> {
  const files = new Map<string, string>();
  for (const [file, id] of Object.entries(entries)) {
    files.set(file, `var R=require("../../chunks/[turbopack]_runtime.js")("${file}")\nR.c("server/chunks/a.js")\nR.m(${id})\nmodule.exports=R.m(${id}).exports\n`);
  }
  for (const [name, { modules, renames }] of Object.entries(chunks)) {
    const built = serverChunk(modules, renames, `${name}.map`);
    files.set(`server/chunks/${name}`, built.code);
    files.set(`server/chunks/${name}.map`, built.map);
  }
  return files;
}
