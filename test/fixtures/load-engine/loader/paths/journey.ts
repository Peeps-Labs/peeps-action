import { expect, type APIRequestContext } from "@playwright/test";
import { EXPECTED } from "@lib/expected";

export async function journey(request: APIRequestContext): Promise<void> {
  const res = await request.get("/value");
  const body: { value: number } = await res.json();
  expect(body.value).toBe(EXPECTED); // line 7
}
