import { expect, type APIRequestContext } from "@playwright/test";

/**
 * Vendored from the bench's robots challenge (`/c/api/robots`): the fleet list holds the
 * sought robot, charging. The paginated variant returns the first page in an envelope, so
 * this check fails there, the same way in a Playwright run and in the engine's Checking.
 */
export async function soughtRobotIsCharging(request: APIRequestContext): Promise<void> {
  const res = await request.get("/c/api/robots");
  expect(res.ok()).toBe(true);
  const robots = (await res.json()) as unknown;
  expect(robots).toEqual(expect.arrayContaining([expect.objectContaining({ id: "RR-C30-0011", status: "charging" })]));
}
