// File-scoped safety net: whatever createTempDir() handed out and the test
// file itself never cleaned up gets swept here, once, after the file's own
// hooks have run (setupFiles hooks register first, so under vitest's default
// stack ordering they run LAST).
import { afterAll } from "vitest";
import { cleanupTrackedTempDirs } from "../helpers/common.js";

// The fake claude writes its session registration under CLAUDE_CONFIG_DIR, and
// plan builders resolve the same dir. An ambient value from a developer or CI
// shell would send those writes into a live agent home.
delete process.env["CLAUDE_CONFIG_DIR"];

afterAll(async () => {
  await cleanupTrackedTempDirs();
});
