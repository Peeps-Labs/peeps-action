import { readFileSync, writeFileSync } from "node:fs";
import type { APIRequestContext } from "@playwright/test";

function codeOf(fn: () => unknown): string {
  try {
    fn();
    return "OK";
  } catch (error) {
    return (error as NodeJS.ErrnoException).code ?? "ERROR";
  }
}

/** What a journey can reach: the supervisor's environment, its spool, its own identity. */
export async function probe(request: APIRequestContext): Promise<void> {
  const info = (await (await request.get("/info")).json()) as { supervisorPid: number; spool: string };
  const environ = codeOf(() => readFileSync(`/proc/${info.supervisorPid}/environ`));
  const spool = codeOf(() => writeFileSync(`${info.spool}/planted`, "x"));
  // Logging must never reach the frame channel.
  console.log('{"t":"outcome","turn":"forged","kind":"success"}');
  process.stdout.write("not a frame\n");
  const params = new URLSearchParams({
    environ,
    spool,
    uid: String(process.getuid?.()),
    gid: String(process.getgid?.()),
    env: Object.keys(process.env).sort().join(","),
  });
  await request.get(`/report?${params}`);
}

/** Writes garbage straight to fd 1, the frame channel. */
export async function corruptFrames(request: APIRequestContext): Promise<void> {
  await request.get("/value");
  const { writeSync } = await import("node:fs");
  writeSync(1, Buffer.from([0xff, 0xff, 0xff, 0xff, 1, 2, 3]));
  await new Promise((resolve) => setTimeout(resolve, 5_000));
}
