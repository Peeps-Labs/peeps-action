import { tmpdir } from "node:os";
import path from "node:path";

import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: ".",
  testMatch: "*.spec.ts",
  retries: 0,
  workers: 1,
  // Nothing lands in the repository.
  outputDir: path.join(tmpdir(), "peeps-load-v2-results"),
  use: { baseURL: process.env.BASE_URL },
});
