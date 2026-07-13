import { defineConfig, devices } from "playwright/test";
import { resolvePlaywrightBaseUrl } from "./src/lib/playwright-base-url.ts";

const baseURL = resolvePlaywrightBaseUrl();
const ciTimeoutMs = process.env.CI ? 90_000 : 30_000;

export default defineConfig({
  testDir: "./tests",
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: 1,
  workers: 1,
  timeout: ciTimeoutMs,
  reporter: "line",
  use: {
    baseURL,
    trace: "on-first-retry",
    navigationTimeout: ciTimeoutMs,
  },
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
    },
  ],
});
