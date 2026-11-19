import { expect, type APIRequestContext } from "@playwright/test";

/** One send the sink answers with a network reset. The journey then fails. */
export async function reset(request: APIRequestContext): Promise<void> {
  await request.get("/reset");
}

/** One send the sink answers 401 with a Basic challenge. */
export async function basic(request: APIRequestContext): Promise<void> {
  const res = await request.get("/basic");
  expect(res.status()).toBe(200);
}

/** One send the sink answers 302. */
export async function redirect(request: APIRequestContext): Promise<void> {
  const res = await request.get("/redirect");
  expect(res.status()).toBe(200);
}

/** Retries asked for are refused before anything is sent. */
export async function retries(request: APIRequestContext): Promise<void> {
  await request.get("/value", { maxRetries: 3 });
}
