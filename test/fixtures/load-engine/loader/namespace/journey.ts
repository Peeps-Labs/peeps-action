import type { APIRequestContext } from "@playwright/test";

export namespace Paths {
  export const value = "/value";
}

export async function journey(request: APIRequestContext): Promise<void> {
  await request.get(Paths.value);
}
