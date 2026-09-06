import { describe, expect, it } from "vitest";
import { _renderSidecarStopMessageForTests as renderSidecarStopMessage } from "../../src/cli.js";
import type { SidecarStopView } from "../../src/types.js";

function stopView(sidecarStop: SidecarStopView["sidecarStop"]): SidecarStopView {
  return {
    id: "api-1",
    project: "api",
    agent: "claude",
    prompt: "hello",
    branch: "api-1",
    worktree: true,
    worktreePath: "/tmp/spur-worktrees/api/api-1",
    tmuxSession: "api-1",
    launchCommand: "",
    status: "running",
    state: "waiting",
    runtimeAlive: true,
    workspaceExists: true,
    createdAt: "2026-04-15T00:00:00.000Z",
    updatedAt: "2026-04-15T00:00:00.000Z",
    lastActivityAt: "2026-04-15T00:00:00.000Z",
    artifacts: [],
    services: [],
    sidecars: [],
    sidecarStop,
  } as unknown as SidecarStopView;
}

describe("renderSidecarStopMessage", () => {
  it("never claims a stop when nothing was reaped", () => {
    const message = renderSidecarStopMessage("dev", stopView({ outcome: "nothing-to-stop" }));
    expect(message).toContain("was not running; nothing to stop");
    expect(message).not.toContain("Stopped sidecar");
  });

  it("reports a clean reap", () => {
    const message = renderSidecarStopMessage("dev", stopView({ outcome: "reaped" }));
    expect(message).toBe("Stopped sidecar dev for api-1.");
  });

  it("reports survivor pids for a partial reap", () => {
    const message = renderSidecarStopMessage(
      "dev",
      stopView({ outcome: "partial", survivors: [501, 502] }),
    );
    expect(message).toContain("but 2 process(es) survived: 501,502");
    expect(message).toContain("spur sidecar sweep");
  });
});
