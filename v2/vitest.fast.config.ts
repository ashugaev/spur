import { configDefaults, defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["test/fast/**/*.test.ts"],
    // *.fixture.test.ts files are run only when spawned explicitly as their
    // own isolated vitest process (see temp-dir-safety-net.test.ts) — excluded
    // here so the normal fast run doesn't also execute them inline.
    exclude: [...configDefaults.exclude, "test/fast/**/*.fixture.test.ts"],
    testTimeout: 30_000,
    hookTimeout: 30_000,
    pool: "forks",
    setupFiles: ["./test/setup/temp-dirs.ts"],
  },
});
