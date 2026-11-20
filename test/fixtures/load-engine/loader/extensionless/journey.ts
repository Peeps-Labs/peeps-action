import { expect, type APIRequestContext } from "@playwright/test";
import { expected } from "./helpers";
import { readValue } from "./read";

export async function journey(request: APIRequestContext): Promise<void> {
  const value = await readValue(request);
  expect(value).toBe(expected()); // line 7
}
