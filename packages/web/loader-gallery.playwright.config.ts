import { join } from "node:path";
import { defineConfig, devices } from "playwright/test";
import { resolvePlaywrightBaseUrl } from "./src/lib/playwright-base-url.ts";

if (process.env.SPUR_LOADER_CAPTURE !== "1") {
  throw new Error("Set SPUR_LOADER_CAPTURE=1 to run the loader gallery capture.");
}

const artifactsDir = process.env.SPUR_SESSION_ARTIFACTS_DIR;
if (!artifactsDir) {
  throw new Error("SPUR_SESSION_ARTIFACTS_DIR is required for loader gallery capture.");
}

export default defineConfig({
  testDir: "./tests",
  testMatch: "loader-gallery.capture.ts",
  fullyParallel: false,
  forbidOnly: true,
  retries: 0,
  workers: 1,
  timeout: 60_000,
  outputDir: join(artifactsDir, "loaders", "playwright"),
  reporter: "line",
  use: {
    ...devices["Desktop Chrome"],
    baseURL: resolvePlaywrightBaseUrl(),
    trace: "off",
  },
});
