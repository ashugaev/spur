import { describe, expect, it } from "vitest";
import {
  _renderSidecarStopMessageForTests as renderSidecarStopMessage,
  _sidecarStopExitCodeForTests as sidecarStopExitCode,
} from "../../src/cli.js";
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
  } satisfies SidecarStopView;
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

  // D1: a zero-survivor partial means the port itself could not be
  // confirmed clear, never "0 process(es) survived: " — name the
  // unverifiable port instead of the empty survivor list.
  it("names the unverified port for a zero-survivor partial reap", () => {
    const message = renderSidecarStopMessage(
      "dev",
      stopView({ outcome: "partial", survivors: [], unverifiedPorts: [4355] }),
    );
    expect(message).not.toContain("0 process(es) survived");
    expect(message).toContain("port(s) 4355 could not be confirmed clear");
    expect(message).toContain("spur sidecar sweep");
  });

  // ND-2: unverifiedPorts has two producers — a probe that could not run,
  // and a port excluded as ambiguous against a non-terminal sibling — the
  // message must not blame the second on a missing OS tool (6444eaf9 fixed
  // that exact misattribution for the first producer one commit earlier).
  it("never blames a missing OS tool for an unverified port", () => {
    const message = renderSidecarStopMessage(
      "dev",
      stopView({ outcome: "partial", survivors: [], unverifiedPorts: [4355] }),
    );
    expect(message).not.toContain("lsof");
    expect(message).not.toContain("ss unavailable");
    expect(message).toBe(
      "Stopped sidecar dev for api-1, but port(s) 4355 could not be confirmed clear. Report them: spur sidecar sweep",
    );
  });
});

describe("sidecarStopExitCode", () => {
  it("exits nonzero on a partial reap", () => {
    expect(sidecarStopExitCode(stopView({ outcome: "partial", survivors: [501] }))).toBe(1);
  });

  it("exits zero (unset) on a clean reap or nothing-to-stop", () => {
    expect(sidecarStopExitCode(stopView({ outcome: "reaped" }))).toBeUndefined();
    expect(sidecarStopExitCode(stopView({ outcome: "nothing-to-stop" }))).toBeUndefined();
  });
});
