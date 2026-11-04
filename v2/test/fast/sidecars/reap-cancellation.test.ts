import { afterEach, describe, expect, it, vi } from "vitest";
import { getTmuxPanePid, killTmuxSession } from "../../../src/runtime-tmux.js";
import { createRestoreOperation } from "../../../src/session-lifecycle.js";
import { confirmReaps, signalSidecarPane, type PendingReap } from "../../../src/sidecars/reap.js";

vi.mock("../../../src/runtime-tmux.js", () => ({
  getTmuxPanePid: vi.fn(),
  killTmuxSession: vi.fn(async () => {}),
}));

afterEach(() => vi.restoreAllMocks());

describe("restore-owned sidecar reap cancellation", () => {
  it("abandons a hung pane probe and never kills a successor after the late result", async () => {
    let release!: (pid: number | null) => void;
    vi.mocked(getTmuxPanePid).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    );
    const controller = new AbortController();
    const operation = createRestoreOperation(controller.signal);
    try {
      const pending = signalSidecarPane("sidecar", undefined, operation);
      const rejected = expect(pending).rejects.toThrow("cancelled");
      controller.abort();
      await rejected;
      release(null);
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(killTmuxSession).not.toHaveBeenCalled();
    } finally {
      operation.dispose();
    }
  });

  it("cancels the grace window without a late SIGKILL escalation", async () => {
    const kill = vi.spyOn(process, "kill").mockImplementation(() => true);
    const controller = new AbortController();
    const operation = createRestoreOperation(controller.signal);
    const pending: PendingReap = {
      sessionName: "sidecar",
      panePid: 12345,
      tree: [12345],
      ownedGroups: [],
      snapshot: { ok: true, byPid: new Map(), byPgid: new Map() },
      blindKill: false,
    };
    try {
      const confirmation = confirmReaps([pending], 10, operation);
      const rejected = expect(confirmation).rejects.toThrow("cancelled");
      controller.abort();
      await rejected;
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(kill).not.toHaveBeenCalled();
    } finally {
      operation.dispose();
    }
  });
});
