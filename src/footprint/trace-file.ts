/**
 * Reading a trace from the disk, and removing Peeps' additional recording: the file
 * half of a footprint. Part of the reporter, which must stay dependency-free, and
 * synchronous in `onTestEnd` so the events keep their order.
 */
import { closeSync, fstatSync, openSync, readSync, rmdirSync, unlinkSync } from "node:fs";
import path from "node:path";
import { inflateRawSync } from "node:zlib";
import { footprintFromText, keepsTrace, type Footprint, type FootprintOrigins, type TraceText } from "./rules";

/** A trace with more than this in one entry is not read, and the test is unknown. */
const MAX_ENTRY_BYTES = 256 * 1024 * 1024;

/** The text of a zip's entries `wanted` names. Reads only those, from a file of any size. */
export function readZip(file: string, wanted: (name: string) => boolean): string[] {
  const fd = openSync(file, "r");
  try {
    const size = fstatSync(fd).size;
    const read = (position: number, length: number) => {
      const buffer = Buffer.alloc(length);
      readSync(fd, buffer, 0, length, position);
      return buffer;
    };
    // The end record sits within its 22 bytes and a comment of at most 64 KiB.
    const tailLength = Math.min(size, 22 + 0xffff);
    const tail = read(size - tailLength, tailLength);
    const end = tail.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
    if (end < 0) throw new Error("No zip end record");
    const count = tail.readUInt16LE(end + 10);
    const directorySize = tail.readUInt32LE(end + 12);
    const directoryOffset = tail.readUInt32LE(end + 16);
    // Zip64: more than a trace of ours would hold, and its fields aren't read here.
    if (count === 0xffff || directoryOffset === 0xffffffff) throw new Error("A zip64 trace");
    const directory = read(directoryOffset, directorySize);
    const out: string[] = [];
    for (let at = 0, n = 0; n < count; n++) {
      if (directory.readUInt32LE(at) !== 0x02014b50) throw new Error("A corrupt zip directory");
      const method = directory.readUInt16LE(at + 10);
      const compressed = directory.readUInt32LE(at + 20);
      const nameLength = directory.readUInt16LE(at + 28);
      const extraLength = directory.readUInt16LE(at + 30);
      const commentLength = directory.readUInt16LE(at + 32);
      const offset = directory.readUInt32LE(at + 42);
      const name = directory.toString("utf8", at + 46, at + 46 + nameLength);
      at += 46 + nameLength + extraLength + commentLength;
      if (!wanted(name)) continue;
      const header = read(offset, 30);
      const start = offset + 30 + header.readUInt16LE(26) + header.readUInt16LE(28);
      const bytes = read(start, compressed);
      if (method === 0) out.push(bytes.toString("utf8"));
      else if (method === 8) out.push(inflateRawSync(bytes, { maxOutputLength: MAX_ENTRY_BYTES }).toString("utf8"));
      else throw new Error(`A zip entry compressed with method ${method}`);
    }
    return out;
  } finally {
    closeSync(fd);
  }
}

function readTrace(file: string): TraceText | null {
  try {
    return {
      network: readZip(file, (name) => name.endsWith(".network")),
      // The runner's own `test.trace` has steps, not the browser's actions.
      actions: readZip(file, (name) => name.endsWith(".trace") && !name.endsWith("test.trace")),
    };
  } catch {
    return null;
  }
}

export function footprintFromTrace(traces: string[], origins: FootprintOrigins): Footprint {
  return footprintFromText(traces.map(readTrace), origins);
}

type TraceAttachment = { name: string; path?: string; contentType: string };

/**
 * This attempt's footprint, read before Peeps' additional recording is deleted. The
 * customer's report and upload stay what their own policy leaves: the HTML reporter
 * copies attachments at `onEnd`, so taking the trace off `attachments` here leaves no
 * dead link in it.
 */
export function takeFootprint(
  attempt: { attachments: TraceAttachment[]; status: string; retry: number; expectedStatus: string },
  use: { baseURL?: unknown; peepsCustomerTrace?: unknown },
  origins: string[],
  log: (message: string) => void = console.log,
): Footprint {
  const traces = attempt.attachments.filter((a) => a.name === "trace" && a.contentType === "application/zip" && a.path);
  const baseUrls = [process.env.BASE_URL, use.baseURL].filter((url): url is string => typeof url === "string" && url !== "");
  const footprint = footprintFromTrace(traces.map((a) => a.path!), { baseUrls, origins });
  const policy = typeof use.peepsCustomerTrace === "string" ? use.peepsCustomerTrace : undefined;
  if (!keepsTrace(policy, attempt)) {
    for (const trace of traces) {
      attempt.attachments.splice(attempt.attachments.indexOf(trace), 1);
      try {
        unlinkSync(trace.path!);
        // Empty now, as it would have been with no trace.
        rmdirSync(path.dirname(trace.path!));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOTEMPTY") log(`[peeps] could not remove a recorded trace: ${String(error)}`);
      }
    }
  }
  return footprint;
}
