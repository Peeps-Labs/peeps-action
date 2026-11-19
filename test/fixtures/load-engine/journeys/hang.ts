import type { APIRequestContext } from "@playwright/test";

/** Sends once, then never yields again: a hung executor. */
export async function busyLoop(request: APIRequestContext): Promise<void> {
  await request.get("/value");
  for (;;) {
    // spin
  }
}
