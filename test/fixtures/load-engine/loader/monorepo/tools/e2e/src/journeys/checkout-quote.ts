import { expect, type APIRequestContext } from "@playwright/test";
import { EXPECTED_QUOTE } from "@shop/api-client";
import { readQuote } from "../support/read";

export async function quoteCheckout(request: APIRequestContext): Promise<void> {
  const quote = await readQuote(request);
  expect(quote).toBe(EXPECTED_QUOTE); // line 7
}
