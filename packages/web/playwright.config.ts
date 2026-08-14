import { defineConfig, devices } from "playwright/test";
import { resolvePlaywrightBaseUrl } from "./src/lib/playwright-base-url.ts";

const baseURL = resolvePlaywrightBaseUrl();

export default defineConfig({
  testDir: "./tests",
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: 1,
  workers: 1,
  // Self-hosted CI runners are shared; a cold `next start` render can exceed the
  // 30s default under load. 60s headroom keeps render-heavy specs from flaking.
  timeout: 60_000,
  reporter: "line",
  use: {
    baseURL,
    trace: "on-first-retry",
  },
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
    },
  ],
});
