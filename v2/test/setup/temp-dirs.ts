// File-scoped safety net: whatever createTempDir() handed out and the test
// file itself never cleaned up gets swept here, once, after the file's own
// hooks have run (setupFiles hooks register first, so under vitest's default
// stack ordering they run LAST).
import { afterAll } from "vitest";
import { cleanupTrackedTempDirs } from "../helpers/common.js";

afterAll(async () => {
  await cleanupTrackedTempDirs();
});
