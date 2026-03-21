import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["test/smoke/**/*.smoke.test.ts"],
    testTimeout: 300_000,
    hookTimeout: 90_000,
    fileParallelism: false,
    pool: "forks",
  },
});
