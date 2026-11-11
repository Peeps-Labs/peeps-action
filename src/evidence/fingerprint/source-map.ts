/**
 * Source maps, read: version 3 `mappings` decoded to absolute segments, and an index
 * map (`sections`) kept per section, since a stylesheet's sections are each one module's
 * CSS (spike 2, rule 4). Pure.
 */

/** [generated column, source, source line, source column, name?], all absolute. */
export type Segment = [number, number, number, number] | [number, number, number, number, number];

export interface BasicMap {
  sources: string[];
  names: string[];
  mappings: string;
}

export interface Section {
  offset: { line: number; column: number };
  map: BasicMap;
}

const B64 = new Map([..."ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/"].map((char, i) => [char, i]));

/** Each generated line's segments. A segment of one field maps to nothing and is dropped. */
export function decodeMappings(mappings: string): Segment[][] {
  const lines: Segment[][] = [];
  const state = [0, 0, 0, 0, 0];
  for (const line of mappings.split(";")) {
    const segments: Segment[] = [];
    state[0] = 0;
    for (const text of line.split(",")) {
      if (text === "") continue;
      const fields = decodeVlqs(text);
      for (let i = 0; i < fields.length && i < 5; i++) state[i]! += fields[i]!;
      if (fields.length >= 4) segments.push(fields.length >= 5 ? [state[0]!, state[1]!, state[2]!, state[3]!, state[4]!] : [state[0]!, state[1]!, state[2]!, state[3]!]);
    }
    lines.push(segments);
  }
  return lines;
}

function decodeVlqs(text: string): number[] {
  const out: number[] = [];
  let value = 0;
  let shift = 0;
  for (const char of text) {
    const digit = B64.get(char);
    if (digit === undefined) throw new Error("A source map with a character outside base64");
    value += (digit & 31) * 2 ** shift;
    if (digit & 32) {
      shift += 5;
      continue;
    }
    out.push(value % 2 === 1 ? -Math.floor(value / 2) : value / 2);
    value = 0;
    shift = 0;
  }
  return out;
}

/** The map as sections: a plain map is one section at the start. Null when it isn't a map. */
export function parseSourceMap(text: string): Section[] | null {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    return null;
  }
  const basic = (value: unknown): BasicMap | null => {
    const map = value as Partial<BasicMap> | null;
    if (!map || !Array.isArray(map.sources) || typeof map.mappings !== "string") return null;
    return { sources: map.sources.map((s) => (typeof s === "string" ? s : "")), names: Array.isArray(map.names) ? map.names : [], mappings: map.mappings };
  };
  const sections = (json as { sections?: unknown }).sections;
  if (Array.isArray(sections)) {
    const out: Section[] = [];
    for (const section of sections as Array<{ offset?: { line?: unknown; column?: unknown }; map?: unknown }>) {
      const map = basic(section.map);
      const { line, column } = section.offset ?? {};
      if (!map || typeof line !== "number" || typeof column !== "number") return null;
      out.push({ offset: { line, column }, map });
    }
    return out;
  }
  const map = basic(json);
  return map ? [{ offset: { line: 0, column: 0 }, map }] : null;
}
