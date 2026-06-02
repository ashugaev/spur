import { describe, expect, it } from "vitest";
import { syncTmuxEnvironment } from "../helpers/runtime.js";

// Regression guard for issue #350: syncTmuxEnvironment writes `set-environment -g`,
// which must never reach the host's default tmux socket. With no isolated socket
// established (no SPUR_TMUX_SOCKET_NAME, no prior context) it must throw instead of
// silently poisoning the default server.
describe("syncTmuxEnvironment isolation guard", () => {
  it("throws instead of writing set-environment -g to the default tmux socket", async () => {
    await expect(
      syncTmuxEnvironment({
        HOME: "/tmp/should-not-reach-default-socket",
        SPUR_FAKE_GH_STATE_FILE: "/tmp/should-not-reach-default-socket/gh-state.json",
      }),
    ).rejects.toThrow(/isolated tmux socket/);
  });
});
