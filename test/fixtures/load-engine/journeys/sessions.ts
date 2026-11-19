import { expect, type APIRequestContext } from "@playwright/test";

/** Reads the session cookie the sink set on this user's first turn. */
export async function cookie(request: APIRequestContext): Promise<void> {
  const res = await request.get("/cookie");
  expect(res.status()).toBe(200);
  await res.json();
}
