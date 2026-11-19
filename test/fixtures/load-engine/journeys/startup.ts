import { appendFileSync } from "node:fs";
import type { APIRequestContext } from "@playwright/test";

// Loading this module is customer code running: it leaves a mark the test can look for.
if (process.env.LOAD_MARKER) appendFileSync(process.env.LOAD_MARKER, "loaded\n");

export async function readValue(request: APIRequestContext): Promise<void> {
  await request.get("/value");
}
