import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ServiceSourceState } from "../../src/types.js";

const mocks = vi.hoisted(() => ({
  captureTmuxPane: vi.fn(),
  logSpurEvent: vi.fn(),
  readServiceSourceState: vi.fn(),
  sidecarTmuxAlive: vi.fn(),
  writeServiceSourceState: vi.fn(),
}));

vi.mock("../../src/event-log.js", () => ({
  logSpurEvent: mocks.logSpurEvent,
}));

vi.mock("../../src/metadata.js", () => ({
  readServiceSourceState: mocks.readServiceSourceState,
  writeServiceSourceState: mocks.writeServiceSourceState,
}));

vi.mock("../../src/runtime-tmux.js", () => ({
  captureTmuxPane: mocks.captureTmuxPane,
  sidecarTmuxAlive: mocks.sidecarTmuxAlive,
  sidecarTmuxSession: (sessionId: string, sidecarName: string) => `${sessionId}--${sidecarName}`,
}));

function makeService() {
  return {
    config: {
      dataDir: "/tmp/spur-data",
      projects: {
        api: {
          sources: {
            "ui-watch": {
              type: "service",
              runOnStart: false,
              service: "isolated-ui",
              targetKind: "sidecar",
              intervalMs: 2_000,
              tailLines: 40,
              rules: {
                typescript: {
                  match: "TS[0-9]+",
                  cooldownMs: 60_000,
                },
              },
            },
          },
        },
      },
    },
    get: vi.fn().mockResolvedValue({
      id: "api-1",
      project: "api",
      status: "running",
    }),
  };
}

describe("reportSidecarLogFailure", () => {
  beforeEach(() => {
    mocks.captureTmuxPane.mockReset();
    mocks.logSpurEvent.mockReset();
    mocks.readServiceSourceState.mockReset();
    mocks.sidecarTmuxAlive.mockReset();
    mocks.writeServiceSourceState.mockReset();
  });

  it("emits the configured service trigger event for matching sidecar output", async () => {
    const { reportSidecarLogFailure } = await import("../../src/sidecar-log-report.js");
    const service = makeService();
    const bus = { emit: vi.fn() };
    let state: ServiceSourceState | null = null;
    mocks.readServiceSourceState.mockImplementation(() => state);
    mocks.writeServiceSourceState.mockImplementation((...args: unknown[]) => {
      state = args[4] as ServiceSourceState;
    });
    mocks.sidecarTmuxAlive.mockResolvedValue(true);
    mocks.captureTmuxPane.mockResolvedValue("ERROR in ./src/App.tsx\nTS2339: Property args");

    await expect(
      reportSidecarLogFailure({
        service: service as never,
        bus: bus as never,
        sessionId: "api-1",
        sidecarName: "isolated-ui",
      }),
    ).resolves.toEqual({
      ok: true,
      matchedRules: [{ sourceId: "ui-watch", ruleId: "typescript" }],
    });
    expect(bus.emit).toHaveBeenCalledWith({
      name: "service:typescript",
      projectId: "api",
      sourceId: "ui-watch",
      data: {
        sessionId: "api-1",
        serviceId: "isolated-ui",
        runtimeKind: "sidecar",
        ruleId: "typescript",
      },
    });
  });

  it("rejects when no configured regex matches current sidecar output", async () => {
    const { reportSidecarLogFailure } = await import("../../src/sidecar-log-report.js");
    const service = makeService();
    mocks.readServiceSourceState.mockReturnValue(null);
    mocks.sidecarTmuxAlive.mockResolvedValue(true);
    mocks.captureTmuxPane.mockResolvedValue("compiled successfully");

    await expect(
      reportSidecarLogFailure({
        service: service as never,
        bus: { emit: vi.fn() } as never,
        sessionId: "api-1",
        sidecarName: "isolated-ui",
      }),
    ).rejects.toThrow("No configured sidecar log rule matched recent output for isolated-ui");
  });
});
