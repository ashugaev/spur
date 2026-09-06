// Proves the set-based exit net in test/helpers/runtime.ts actually kills
// EVERY socket a run armed, not just the first — the bug the prior design
// had (a single `process.once("exit")` registered once, capturing only the
// first-registered socket by closure; every later context in the same file
// got no net at all). Runs the fixture in its own isolated vitest process
// (same idiom as temp-dir-safety-net.test.ts) because the fixture's own exit
// is the thing under test — there is no in-process position from which a
// single vitest file can observe its own exit-time cleanup.
//
// Mutation check M8: reverting setActiveTmuxSocketName to the single-socket
// capture (re-adding tmuxBootstrapCleanupRegistered + the
// `const socketName = activeTmuxSocketName` closure) leaves the SECOND
// socket alive after this test's fixture exits.
import { execFile } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { isTmuxAvailable } from "../helpers/runtime.js";

const execFileAsync = promisify(execFile);
const tmuxOk = await isTmuxAvailable();

async function tmuxHasSession(socketName: string): Promise<boolean> {
  try {
    await execFileAsync("tmux", ["-L", socketName, "has-session"]);
    return true;
  } catch {
    return false;
  }
}

describe.skipIf(!tmuxOk)("tmux exit net (abnormal-exit safety)", () => {
  it("kills both sockets a run armed once the process exits, not just the first", async () => {
    const vitestBin = join(process.cwd(), "node_modules", ".bin", "vitest");
    const markerDir = mkdtempSync(join(tmpdir(), "spur-tmux-exit-net-marker-"));
    const markerPath = join(markerDir, "marker.json");

    try {
      await execFileAsync(
        vitestBin,
        ["run", "--config", "vitest.fixture.config.ts", "test/fast/tmux-exit-net.fixture.test.ts"],
        {
          cwd: process.cwd(),
          env: { ...process.env, TMUX_EXIT_NET_MARKER_FILE: markerPath },
        },
      );

      const marker = JSON.parse(readFileSync(markerPath, "utf-8")) as {
        socketA: string;
        socketB: string;
      };

      expect(await tmuxHasSession(marker.socketA)).toBe(false);
      expect(await tmuxHasSession(marker.socketB)).toBe(false);
    } finally {
      rmSync(markerDir, { recursive: true, force: true });
    }
  }, 60_000);
});
