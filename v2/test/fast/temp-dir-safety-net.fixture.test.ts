// Fixture for temp-dir-safety-net.test.ts, spawned in its own isolated
// vitest process via vitest.fixture.config.ts. vitest.fast.config.ts excludes
// *.fixture.test.ts, so this file never runs as part of a normal
// `pnpm --dir v2 test`. Deliberately allocates a tracked temp dir and
// registers NO teardown of its own (no afterEach/afterAll) — the only thing
// that can remove it is the setupFiles net (test/setup/temp-dirs.ts); the
// outer test spawns this file alone to observe that cleanup actually
// happened.
import { existsSync, writeFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { createTempDir } from "../helpers/common.js";

describe("temp-dir-safety-net fixture", () => {
  it("allocates a tracked dir with no in-file teardown", async () => {
    const dir = await createTempDir("spur-safetynet-");
    const createdOk = existsSync(dir);
    const markerPath = process.env.SAFETY_NET_MARKER_FILE;
    if (markerPath) {
      writeFileSync(markerPath, JSON.stringify({ dir, createdOk }));
    }
    expect(createdOk).toBe(true);
  });
});
