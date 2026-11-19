import { expect, type APIRequestContext } from "@playwright/test";

/** A request to an origin the environment does not allow. */
export async function unlisted(request: APIRequestContext): Promise<void> {
  await request.get("https://elsewhere.example.com/value");
}

/** A redirect to another origin, which must not be followed. */
export async function redirectOut(request: APIRequestContext): Promise<void> {
  const res = await request.get("/redirect-out");
  expect(res.status()).toBe(200);
}

/** A write the plan does not allow. */
export async function unlistedWrite(request: APIRequestContext): Promise<void> {
  await request.post("/orders", { data: { sku: "x" } });
}
