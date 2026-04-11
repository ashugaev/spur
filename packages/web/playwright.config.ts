import { defineConfig, devices } from "playwright/test";
import { execSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join, basename } from "node:path";

/**
 * Resolve the base URL for Playwright tests:
 *  1. $PLAYWRIGHT_BASE_URL — explicit override
 *  2. isolated-ui sidecar — when $SPUR_SESSION_TOOL_DIR is set and
 *     isolated-env.sh exists, find the next dev process for this session
 *  3. http://localhost:5555 — production / main branch fallback
 */
function resolveBaseUrl(): string {
  if (process.env.PLAYWRIGHT_BASE_URL) return process.env.PLAYWRIGHT_BASE_URL;

  const toolDir = process.env.SPUR_SESSION_TOOL_DIR;
  if (toolDir && existsSync(join(toolDir, "isolated-env.sh"))) {
    // Extract session id from tool dir, e.g. "spur-0190"
    const sessionId = basename(toolDir);
    try {
      const out = execSync("ps -eo args", { encoding: "utf8", stdio: "pipe" });
      for (const line of out.split("\n")) {
        // Match: node .../worktrees/sp/<sessionId>/packages/web/.../next dev -p <port>
        if (!line.includes(`/${sessionId}/packages/web`)) continue;
        const m = line.match(/next dev -p (\d+)/);
        if (m) return `http://127.0.0.1:${m[1]}`;
      }
    } catch {
      // fall through
    }
  }

  return "http://localhost:5555";
}

const baseURL = resolveBaseUrl();

export default defineConfig({
  testDir: "./tests",
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: 1,
  workers: 1,
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
