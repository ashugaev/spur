import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ServiceSourceState } from "../../src/types.js";

const mocks = vi.hoisted(() => ({
  captureTmuxPane: vi.fn(),
  deleteServiceSourceState: vi.fn(),
  listSessions: vi.fn(),
  readServiceSourceState: vi.fn(),
  sidecarTmuxAlive: vi.fn(),
  writeServiceSourceState: vi.fn(),
}));

vi.mock("../../src/metadata.js", () => ({
  deleteServiceSourceState: mocks.deleteServiceSourceState,
  listSessions: mocks.listSessions,
  readServiceSourceState: mocks.readServiceSourceState,
  writeServiceSourceState: mocks.writeServiceSourceState,
}));

vi.mock("../../src/runtime-tmux.js", () => ({
  captureTmuxPane: mocks.captureTmuxPane,
  sidecarTmuxAlive: mocks.sidecarTmuxAlive,
  sidecarTmuxSession: (sessionId: string, sidecarName: string) => `${sessionId}--${sidecarName}`,
}));

const config = {
  type: "service" as const,
  runOnStart: false,
  service: "isolated-ui",
  targetKind: "sidecar" as const,
  intervalMs: 1_000,
  tailLines: 20,
  rules: {
    typescript: {
      match: "TS[0-9]+",
      cooldownMs: 60_000,
    },
  },
};

describe("service sidecar source", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    mocks.captureTmuxPane.mockReset();
    mocks.deleteServiceSourceState.mockReset();
    mocks.listSessions.mockReset();
    mocks.readServiceSourceState.mockReset();
    mocks.sidecarTmuxAlive.mockReset();
    mocks.writeServiceSourceState.mockReset();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("baselines existing sidecar output, then emits matching appended lines", async () => {
    const { serviceSourceModule } = await import("../../src/event-sources/service.js");
    let state: ServiceSourceState | null = null;
    const emit = vi.fn();
    const abortController = new AbortController();
    mocks.listSessions.mockReturnValue([
      {
        id: "api-1",
        project: "api",
        status: "running",
      },
    ]);
    mocks.sidecarTmuxAlive.mockResolvedValue(true);
    mocks.readServiceSourceState.mockImplementation(() => state);
    mocks.writeServiceSourceState.mockImplementation((...args: unknown[]) => {
      state = args[4] as ServiceSourceState;
    });
    mocks.captureTmuxPane
      .mockResolvedValueOnce("compiled successfully")
      .mockResolvedValueOnce("compiled successfully\nTS2339: Property args does not exist");

    const handle = await serviceSourceModule.start({
      sourceId: "ui-watch",
      projectId: "api",
      dataDir: "/tmp/spur-data",
      config,
      emit,
      signal: abortController.signal,
      logger: {},
    });

    await vi.waitFor(() => {
      expect(mocks.writeServiceSourceState).toHaveBeenCalledTimes(1);
    });
    expect(emit).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1_000);

    await vi.waitFor(() => {
      expect(emit).toHaveBeenCalledWith("service:typescript", {
        sessionId: "api-1",
        serviceId: "isolated-ui",
        runtimeKind: "sidecar",
        ruleId: "typescript",
      });
    });
    handle.stop();
  });
});
