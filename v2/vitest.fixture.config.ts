import { defineConfig } from "vitest/config";
import fastConfig from "./vitest.fast.config.js";

// Dedicated invocation for *.fixture.test.ts files, which the main fast
// config excludes so they never run inline as part of the normal suite.
// setupFiles is read off vitest.fast.config.ts's own resolved config object
// (not a hand-copied path string), so a mutation removing setupFiles there
// shows up here too — the isolated spawn in temp-dir-safety-net.test.ts
// needs the SAME wiring it is proving, not a parallel copy of it.
export default defineConfig({
  test: {
    environment: "node",
    include: ["test/fast/**/*.fixture.test.ts"],
    testTimeout: 30_000,
    hookTimeout: 30_000,
    pool: "forks",
    setupFiles: fastConfig.test?.setupFiles ?? [],
  },
});
