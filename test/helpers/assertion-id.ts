/**
 * A test-local assertion id (CW plan §4.6), for V2 only: the engine and Playwright must fail on
 * the same source line. The durable id belongs to EV-C, which can adopt or replace this one, so
 * it lives under test/, never src/ (`test/fixtures/load-customer/assertion-ids.json` opens with
 * `status: provisional`).
 *
 * `location` is the executor's `file:line`, repo-relative. The id is
 * `"as1_" + sha256hex("as1\n" + path + "\n" + line)`, first 32 hex characters.
 *
 * Two limits, each with a vector:
 *   (a) it names a source line, not an assertion: two `expect`s on one line, or one helper's
 *       `expect` reached from two call sites, share an id;
 *   (b) a column (`file:line:col`) is dropped before hashing, so a reformat that moves an
 *       `expect` sideways keeps its id.
 */
import { createHash } from "node:crypto";

export function assertionIdOf(location: string): string | null {
  const m = /^(.+?):(\d+)(?::\d+)?$/.exec(location);
  if (!m) return null;
  const file = m[1]!.replace(/\\/g, "/");
  const line = m[2]!;
  if (file.startsWith("/") || /^[A-Za-z]:/.test(file)) return null;
  if (file.split("/").some((part) => part === "" || part === "." || part === "..")) return null;
  if (!/^[1-9]\d*$/.test(line)) return null;
  return `as1_${createHash("sha256").update(`as1\n${file}\n${line}`).digest("hex").slice(0, 32)}`;
}
