// Proves the setupFiles-registered net (test/setup/temp-dirs.ts) actually
// removes a dir that its own creating test file never cleaned up — the
// exact scenario the net exists for (see the spec's comment-seen.test.ts
// history: a file with zero teardown of its own). Runs the fixture file in
// its own isolated vitest process rather than asserting in-process, because
// a single vitest file's own hooks (even none at all) always finish before
// the setupFiles-registered afterAll runs (vitest's default "stack" hook
// ordering) — there is no in-file position from which to observe the net's
// effect. The child spawn uses vitest.fixture.config.ts, not
// vitest.fast.config.ts directly, because the main fast config excludes
// *.fixture.test.ts (so it doesn't also execute inline during a normal
// suite run) and vitest's `exclude` applies even to an explicitly named
// file — there is no config-level way to exclude-except-when-targeted.
// vitest.fixture.config.ts reads its setupFiles off vitest.fast.config.ts's
// own resolved config object rather than duplicating the path, so removing
// `setupFiles` from vitest.fast.config.ts still shows up here. Mutation
// check: remove it there and this test fails (the fixture's dir survives).
import { execFile } from "node:child_process";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);

describe("temp-dir safety net (setupFiles wiring)", () => {
  it("removes a dir a test file never cleaned up itself", async () => {
    const vitestBin = join(process.cwd(), "node_modules", ".bin", "vitest");
    const markerDir = await mkdtemp(join(tmpdir(), "spur-safety-net-marker-"));
    const markerPath = join(markerDir, "marker.json");

    try {
      await execFileAsync(
        vitestBin,
        [
          "run",
          "--config",
          "vitest.fixture.config.ts",
          "test/fast/temp-dir-safety-net.fixture.test.ts",
        ],
        {
          cwd: process.cwd(),
          env: { ...process.env, SAFETY_NET_MARKER_FILE: markerPath },
        },
      );

      const marker = JSON.parse(readFileSync(markerPath, "utf-8")) as {
        dir: string;
        createdOk: boolean;
      };

      // sanity: the fixture actually created a real dir (not a vacuous pass).
      expect(marker.createdOk).toBe(true);
      expect(typeof marker.dir).toBe("string");
      expect(marker.dir.length).toBeGreaterThan(0);

      // the fixture registered no teardown of its own — only the net could
      // have removed this.
      expect(existsSync(marker.dir)).toBe(false);
    } finally {
      rmSync(markerDir, { recursive: true, force: true });
    }
  }, 60_000);
});
