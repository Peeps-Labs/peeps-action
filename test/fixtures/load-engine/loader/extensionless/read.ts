import type { APIRequestContext } from "@playwright/test";

export async function readValue(request: APIRequestContext): Promise<number> {
  const res = await request.get("/value");
  return ((await res.json()) as { value: number }).value;
}
