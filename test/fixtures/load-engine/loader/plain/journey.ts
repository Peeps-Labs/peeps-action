import { expect, type APIRequestContext } from "@playwright/test";

interface Body {
  value: number;
}

export async function journey(request: APIRequestContext): Promise<void> {
  const res = await request.get("/value");
  const body = (await res.json()) as Body;
  expect(body.value).toBe(42); // line 10: the assertion the test expects to fail here
}
