import { test } from "@playwright/test";

import { soughtRobotIsCharging } from "./robots";

test("the sought robot is charging", async ({ request }) => {
  await soughtRobotIsCharging(request);
});
