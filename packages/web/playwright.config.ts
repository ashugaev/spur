import { defineConfig, devices } from "playwright/test";
import { resolvePlaywrightBaseUrl } from "./src/lib/playwright-base-url.ts";
import { createIsolatedWebTestTarget } from "./tests/harness/daemon-target.js";

// An external target is one this run must not own: PLAYWRIGHT_BASE_URL set by
// hand, or an isolated-ui sidecar inside a Spur session. Anything else starts
// Next here, against the isolated unbound daemon target — so baseURL and the
// child's -p come from the same allocation, in the same process.
const externalTarget = Boolean(
  process.env.PLAYWRIGHT_BASE_URL || process.env.SPUR_SESSION || process.env.SPUR_SESSION_TOOL_DIR,
);
const target = externalTarget ? null : createIsolatedWebTestTarget();
const baseURL = target ? `http://127.0.0.1:${target.uiPort}` : resolvePlaywrightBaseUrl();

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
  ...(target ? { globalTeardown: "./tests/harness/global-teardown.ts" } : {}),
  ...(target
    ? {
        webServer: {
          command: `pnpm exec next start -p ${target.uiPort}`,
          url: baseURL,
          reuseExistingServer: false,
          // The deleted CI `wait-on` step allowed 30s; a cold `next start` on a
          // contended self-hosted runner needs more than Playwright's 60s default.
          timeout: 120_000,
          env: target.env,
        },
      }
    : {}),
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
