import type { APIRequestContext } from "@playwright/test";
import { quotePath } from "@shop/api-client";

export async function readQuote(request: APIRequestContext): Promise<number> {
  const res = await request.get(quotePath());
  return ((await res.json()) as { value: number }).value;
}
