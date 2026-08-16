// Fixture for tmux-exit-net.test.ts, spawned in its own isolated vitest
// process via vitest.fixture.config.ts (excluded from the normal fast suite,
// same idiom as temp-dir-safety-net.fixture.test.ts). Arms TWO real tmux
// sockets in sequence via setActiveTmuxSocketName, backing each with a real
// tmux server, then exits with no cleanup() call of its own. The only thing
// that can tear either server down is the module-level exit net registered
// inside setActiveTmuxSocketName (a Set, not a single-socket capture) — the
// outer test spawns this file alone to observe both servers actually die
// when the process exits normally without an explicit kill.
import { execFile } from "node:child_process";
import { writeFileSync } from "node:fs";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { setActiveTmuxSocketName } from "../helpers/runtime.js";

const execFileAsync = promisify(execFile);

describe("tmux-exit-net fixture", () => {
  it("arms two real tmux sockets in sequence and exits with no cleanup()", async () => {
    const socketA = `spur-fixture-a-${process.pid}`;
    const socketB = `spur-fixture-b-${process.pid}`;

    setActiveTmuxSocketName(socketA);
    await execFileAsync("tmux", [
      "-L",
      socketA,
      "new-session",
      "-d",
      "-s",
      "fixture",
      "-x",
      "1",
      "-y",
      "1",
      "sleep 3600",
    ]);

    setActiveTmuxSocketName(socketB);
    await execFileAsync("tmux", [
      "-L",
      socketB,
      "new-session",
      "-d",
      "-s",
      "fixture",
      "-x",
      "1",
      "-y",
      "1",
      "sleep 3600",
    ]);

    const markerPath = process.env["TMUX_EXIT_NET_MARKER_FILE"];
    if (markerPath) {
      writeFileSync(markerPath, JSON.stringify({ socketA, socketB }));
    }

    // Deliberately no cleanup()/kill-server call and no afterAll — the exit
    // net must be what kills these when this process exits.
    expect(socketA).not.toBe(socketB);
  });
});
