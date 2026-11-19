import { expect, type APIRequestContext } from "@playwright/test";

/** One read, held open as long as the sink holds responses. */
export async function readValue(request: APIRequestContext): Promise<void> {
  const res = await request.get("/value");
  expect(res.status()).toBe(200);
}

/** Five reads in a row. */
export async function readFive(request: APIRequestContext): Promise<void> {
  for (let i = 0; i < 5; i++) {
    const res = await request.get(`/value?n=${i}`);
    expect(res.status()).toBe(200);
  }
}

/** Five reads at once: the per-user concurrency must still be one at the sink. */
export async function readFiveAtOnce(request: APIRequestContext): Promise<void> {
  const all = await Promise.all([0, 1, 2, 3, 4].map((i) => request.get(`/value?n=${i}`)));
  for (const res of all) expect(res.status()).toBe(200);
}

/** Never sends: a start the sink sees only as an executor event. */
export async function noSend(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 10));
}

/** A request the sink holds for 5 s. */
export async function slow(request: APIRequestContext): Promise<void> {
  await request.get("/value?hold=5000");
}
