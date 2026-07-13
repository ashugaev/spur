import { defineConfig, devices } from "playwright/test";
import { resolvePlaywrightBaseUrl } from "./src/lib/playwright-base-url.ts";

const baseURL = resolvePlaywrightBaseUrl();

export default defineConfig({
  testDir: "./tests",
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  // The single-worker suite runs on a shared self-hosted runner that can
  // saturate; under load a `page.goto` "load" wait occasionally exceeds the
  // default 30s test timeout and a non-deterministic ~1-3 specs time out. Give
  // navigations headroom and one extra retry so transient runner overload does
  // not red the gate. These bounds do not change test logic.
  timeout: 60_000,
  retries: 2,
  workers: 1,
  reporter: "line",
  use: {
    baseURL,
    trace: "on-first-retry",
    navigationTimeout: 45_000,
    actionTimeout: 15_000,
  },
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
    },
  ],
});
