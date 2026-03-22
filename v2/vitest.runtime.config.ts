import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["test/runtime/**/*.runtime.test.ts"],
    testTimeout: 120_000,
    hookTimeout: 60_000,
    fileParallelism: false,
    pool: "forks",
  },
});
