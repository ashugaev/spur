import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["test/fast/**/*.test.ts"],
    // A few tests exec the real CLI, which auto-starts a daemon and retries for
    // ~40s (DAEMON_START_ATTEMPTS 160 × 250ms) before throwing when none can
    // start. Under a busy CI runner (no pre-existing daemon at the test config)
    // that 40s subprocess exceeds a 30s budget and the test times out
    // non-deterministically. Give the suite headroom past that bound.
    testTimeout: 60_000,
    hookTimeout: 60_000,
    pool: "forks",
  },
});
