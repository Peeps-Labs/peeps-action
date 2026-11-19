import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: ".",
  testMatch: "*.spec.ts",
  retries: 0,
  workers: 1,
  use: { baseURL: process.env.BASE_URL },
});
