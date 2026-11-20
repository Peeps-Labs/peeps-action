import { expect, type APIRequestContext } from "@playwright/test";

enum Answer {
  Wrong = 41,
  Right = 42,
}

const enum Path {
  Value = "/value",
}

export async function journey(request: APIRequestContext): Promise<void> {
  const res = await request.get(Path.Value);
  const body: { value: Answer } = await res.json();
  expect(body.value).toBe(Answer.Right); // line 15
}
