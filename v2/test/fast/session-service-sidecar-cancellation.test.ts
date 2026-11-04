import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { readSession, writeSession } from "../../src/metadata.js";
import { SessionService } from "../../src/session-service.js";
import {
  createRestoreOperation,
  type RestoreOperationContext,
} from "../../src/session-lifecycle.js";
import { BUILTIN_SIDECARS } from "../../src/sidecars/builtins.js";
import {
  createTmuxSidecarSession,
  getSidecarTmuxPresence,
  getTmuxPanePresence,
} from "../../src/runtime-tmux.js";
import type * as runtimeTmuxModule from "../../src/runtime-tmux.js";
import { isHostPortFree } from "../../src/port-probe.js";
import type * as portProbeModule from "../../src/port-probe.js";
import type { ProjectConfig, SessionRecord, SidecarConfig } from "../../src/types.js";

vi.mock("../../src/runtime-tmux.js", async (importOriginal) => ({
  ...(await importOriginal<typeof runtimeTmuxModule>()),
  createTmuxSidecarSession: vi.fn(async () => {}),
  getSidecarTmuxPresence: vi.fn(async () => ({ present: false })),
  getTmuxPanePid: vi.fn(async () => null),
  getTmuxPanePresence: vi.fn(async () => ({ dead: false })),
  sidecarTmuxAlive: vi.fn(async () => false),
  tmuxPaneDead: vi.fn(async () => false),
}));

vi.mock("../../src/port-probe.js", async (importOriginal) => ({
  ...(await importOriginal<typeof portProbeModule>()),
  isHostPortFree: vi.fn(async () => true),
}));

interface StartArgs {
  session: SessionRecord;
  project: ProjectConfig;
  sidecarName: string;
  sidecar: SidecarConfig;
  sidecarDepth: number;
  operation?: RestoreOperationContext;
  onStarted?: () => void;
}

interface SidecarHarness {
  finishStaleWake(
    session: SessionRecord,
    project: ProjectConfig,
    operation?: RestoreOperationContext,
  ): Promise<SessionRecord>;
  clearSidecarLaunch(ownerId: string, sidecarName: string, launchId: string): void;
  stopSidecarLocked(sessionId: string, sidecarName: string): Promise<unknown>;
  withSidecarPortLock<T>(task: () => Promise<T>, operation?: RestoreOperationContext): Promise<T>;
  startSidecarInternal(args: StartArgs): Promise<SessionRecord>;
  startSidecarInternalLocked(args: StartArgs): Promise<SessionRecord>;
  startMcpSidecars(
    session: SessionRecord,
    project: ProjectConfig,
    operation?: RestoreOperationContext,
  ): Promise<unknown>;
}

const directories: string[] = [];
const operations: Array<ReturnType<typeof createRestoreOperation>> = [];

function operation(signal?: AbortSignal): ReturnType<typeof createRestoreOperation> {
  const context = createRestoreOperation(signal);
  operations.push(context);
  return context;
}

function fixture(): {
  service: SidecarHarness;
  session: SessionRecord;
  project: ProjectConfig;
  dataDir: string;
} {
  const dataDir = mkdtempSync(join(tmpdir(), "spur-sidecar-cancel-"));
  directories.push(dataDir);
  const session: SessionRecord = {
    id: "sidecar-owner",
    project: "test",
    agent: "claude",
    prompt: "test",
    branch: "test",
    worktree: true,
    worktreePath: dataDir,
    tmuxSession: "owner",
    launchCommand: "claude",
    status: "stopped",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  const project: ProjectConfig = {
    path: dataDir,
    defaultBranch: "main",
    sessionPrefix: "test",
    worktree: true,
    restoreAfterReboot: false,
    symlinks: [],
    sidecars: {},
    sources: {},
    backlog: {},
    triggers: {},
  };
  const service = Object.create(SessionService.prototype) as SidecarHarness;
  Object.assign(service, {
    config: { dataDir, projects: {} },
    registryPaths: [],
    sidecarPortLock: Promise.resolve(),
    pruneLegacySidecarLinks: (record: SessionRecord) => record,
    invalidateSidecarEndpoint: vi.fn(),
    allowSidecarEndpoint: vi.fn(),
    clearSidecarProcEntry: vi.fn(),
    clearSidecarStartConflict: vi.fn(),
    sidecarStartConflictGate: vi.fn(async () => null),
    refuseOverlappingCrossWorkspaceSidecar: vi.fn(async () => {}),
    sessionAgentConfig: () => ({}),
    prepareSessionTools: () => dataDir,
    logEvent: vi.fn(),
    ensureSidecarReservation: async (record: SessionRecord, name: string) => {
      const updated = {
        ...record,
        sidecarPorts: { ...record.sidecarPorts, [name]: { PORT: 43210 } },
      };
      writeSession(dataDir, updated);
      return updated;
    },
  });
  writeSession(dataDir, session);
  return { service, session, project, dataDir };
}

afterEach(() => {
  for (const context of operations.splice(0)) context.dispose();
  for (const path of directories.splice(0)) rmSync(path, { recursive: true, force: true });
  delete BUILTIN_SIDECARS["cancel-readiness"];
  vi.restoreAllMocks();
  vi.useRealTimers();
  vi.mocked(isHostPortFree).mockReset().mockResolvedValue(true);
  vi.mocked(getSidecarTmuxPresence)
    .mockReset()
    .mockResolvedValue({ present: false, unresponsive: false });
  vi.mocked(getTmuxPanePresence)
    .mockReset()
    .mockResolvedValue({ dead: false, unresponsive: false });
  vi.mocked(createTmuxSidecarSession).mockReset().mockResolvedValue(undefined);
});

describe("restore-owned sidecar cancellation", () => {
  it.each([false, true])(
    "preserves cached stale-wake metadata when replay cancellation is %s",
    async (cancelAfterReplay) => {
      const { service, session, project, dataDir } = fixture();
      writeSession(dataDir, {
        ...session,
        status: "running",
        stopReason: "stale_timeout",
        staleSidecars: ["proxy"],
      });
      const cached = readSession(dataDir, session.id);
      if (!cached) throw new Error("Expected cached session");
      Object.freeze(cached);
      const controller = new AbortController();
      const replay = vi.fn(async () => {
        if (cancelAfterReplay) controller.abort();
        return cached;
      });
      Object.assign(service, { startSidecarWithDependencies: replay });

      const waking = service.finishStaleWake(cached, project, operation(controller.signal));
      if (cancelAfterReplay) {
        await expect(waking).rejects.toThrow("cancelled");
      } else {
        const awake = await waking;
        expect(awake).not.toBe(cached);
        expect(awake).not.toHaveProperty("stopReason");
        expect(awake).not.toHaveProperty("staleSidecars");
      }
      expect(replay).toHaveBeenCalledTimes(1);
      expect(readSession(dataDir, session.id)).toBe(cached);
      expect(cached.stopReason).toBe("stale_timeout");
      expect(cached.staleSidecars).toEqual(["proxy"]);
    },
  );

  it.each([{ unresponsive: true }, { unresponsive: false, diagnostic: "pane probe failed" }])(
    "preserves an interrupted launch when tmux is present but its pane probe is unknown: %j",
    async (unknown) => {
      const { service, session, project, dataDir } = fixture();
      const interrupted = { ...session, sidecarLaunches: { mcp: "interrupted" } };
      const sidecar: SidecarConfig = {
        command: "configured-service",
        autoStart: true,
        mcp: { server: "test", portId: "http", path: "/mcp" },
      };
      project.sidecars = { mcp: sidecar };
      writeSession(dataDir, interrupted);
      vi.mocked(getSidecarTmuxPresence).mockResolvedValue({ present: true, unresponsive: false });
      vi.mocked(getTmuxPanePresence).mockResolvedValue({ dead: false, ...unknown });
      await expect(
        service.startSidecarInternalLocked({
          session: interrupted,
          project,
          sidecarName: "mcp",
          sidecar,
          sidecarDepth: 0,
          operation: operation(),
        }),
      ).rejects.toThrow("pane state is unreadable");
      await expect(service.startMcpSidecars(interrupted, project, operation())).rejects.toThrow(
        "pane state is unreadable",
      );
      expect(createTmuxSidecarSession).not.toHaveBeenCalled();
      expect(readSession(dataDir, session.id)?.sidecarLaunches).toEqual(
        interrupted.sidecarLaunches,
      );
      expect(readSession(dataDir, session.id)?.sidecarProcs).toBeUndefined();
    },
  );

  it.each([{ unresponsive: true }, { unresponsive: false, diagnostic: "tmux probe failed" }])(
    "preserves an interrupted launch without a process identity when its probe is unknown: %j",
    async (unknown) => {
      const { service, session, project, dataDir } = fixture();
      const interrupted = { ...session, sidecarLaunches: { mcp: "interrupted" } };
      project.sidecars = {
        mcp: {
          command: "configured-service",
          autoStart: true,
          mcp: { server: "test", portId: "http", path: "/mcp" },
        },
      };
      writeSession(dataDir, interrupted);
      vi.mocked(getSidecarTmuxPresence).mockResolvedValue({ present: false, ...unknown });
      await expect(
        service.startSidecarInternalLocked({
          session: interrupted,
          project,
          sidecarName: "mcp",
          sidecar: { command: "configured-service", autoStart: true },
          sidecarDepth: 0,
          operation: operation(),
        }),
      ).rejects.toThrow("tmux state is unreadable");
      await expect(service.startMcpSidecars(interrupted, project, operation())).rejects.toThrow(
        "tmux state is unreadable",
      );
      expect(createTmuxSidecarSession).not.toHaveBeenCalled();
      expect(readSession(dataDir, session.id)?.sidecarLaunches).toEqual(
        interrupted.sidecarLaunches,
      );
      expect(readSession(dataDir, session.id)?.sidecarProcs).toBeUndefined();
    },
  );

  it("persists incomplete launches and refuses a live default shell through MCP startup", async () => {
    const { service, session, project, dataDir } = fixture();
    const sidecar: SidecarConfig = {
      command: "configured-service",
      autoStart: true,
      mcp: { server: "test", portId: "http", path: "/mcp" },
      ports: { http: { env: "PORT", start: 43210, end: 43210 } },
    };
    project.sidecars = { mcp: sidecar };
    const controller = new AbortController();
    vi.mocked(createTmuxSidecarSession).mockImplementationOnce(async (input) => {
      input.onCreated?.();
      vi.mocked(getSidecarTmuxPresence).mockResolvedValue({ present: true, unresponsive: false });
      controller.abort();
      input.operation?.assertActive();
    });
    await expect(
      service.startMcpSidecars(session, project, operation(controller.signal)),
    ).rejects.toThrow("cancelled");
    const interrupted = readSession(dataDir, session.id);
    expect(interrupted?.sidecarLaunches?.["mcp"]).toEqual(expect.any(String));
    await expect(service.startMcpSidecars(session, project, operation())).rejects.toThrow(
      "incomplete launch",
    );
    expect(createTmuxSidecarSession).toHaveBeenCalledTimes(1);
    expect(readSession(dataDir, session.id)?.sidecarLaunches).toEqual(interrupted?.sidecarLaunches);
    // Confirmed absence permits a real configured launch, including after
    // the persisted record has been read again by a new caller.
    vi.mocked(getSidecarTmuxPresence).mockResolvedValue({ present: false, unresponsive: false });
    const configured = vi.fn();
    vi.mocked(createTmuxSidecarSession).mockImplementationOnce(async (input) => {
      configured(input.command);
    });
    await service.startMcpSidecars(
      readSession(dataDir, session.id) ?? session,
      project,
      operation(),
    );
    expect(configured).toHaveBeenCalledWith("configured-service");
    expect(readSession(dataDir, session.id)?.sidecarLaunches).toBeUndefined();
  });

  it("preserves another launch marker and process identity when stale cleanup arrives", async () => {
    const { service, session, dataDir } = fixture();
    const newer = {
      ...session,
      sidecarLaunches: { mcp: "new-generation", other: "other-generation" },
      sidecarProcs: { mcp: { pid: 42, pgid: 42, starttime: 123 } },
    };
    writeSession(dataDir, newer);
    service.clearSidecarLaunch(session.id, "mcp", "old-generation");
    expect(readSession(dataDir, session.id)?.sidecarLaunches).toEqual(newer.sidecarLaunches);
    expect(readSession(dataDir, session.id)?.sidecarProcs).toEqual(newer.sidecarProcs);
  });

  it("clears its incomplete marker after explicit stop confirms absence and permits retry", async () => {
    const { service, session, project, dataDir } = fixture();
    const sidecar: SidecarConfig = {
      command: "configured-service",
      autoStart: true,
      mcp: { server: "test", portId: "http", path: "/mcp" },
    };
    project.sidecars = { mcp: sidecar };
    Object.assign(service, {
      resolveProjectForSession: () => project,
      sidecarOwnerIdForName: () => session.id,
      suppressedSidecarHeals: new Map(),
      healTaskSkipNames: new Map(),
      excludeAmbiguousCrossWorkspacePorts: async () => ({ ports: [], ambiguousPorts: [] }),
      enrich: async (record: SessionRecord) => record,
    });
    writeSession(dataDir, {
      ...session,
      sidecarNames: ["mcp"],
      sidecarLaunches: { mcp: "interrupted" },
    });
    await service.stopSidecarLocked(session.id, "mcp");
    expect(readSession(dataDir, session.id)?.sidecarLaunches).toBeUndefined();
    const configured = vi.fn();
    vi.mocked(createTmuxSidecarSession).mockImplementationOnce(async (input) => {
      configured(input.command);
    });
    await service.startMcpSidecars(
      readSession(dataDir, session.id) ?? session,
      project,
      operation(),
    );
    expect(configured).toHaveBeenCalledWith("configured-service");
  });

  it("does not clear or reap a newer launch after its own acknowledged launch completes late", async () => {
    const { service, session, project, dataDir } = fixture();
    const newer = {
      ...session,
      sidecarLaunches: { mcp: "new-generation" },
      sidecarProcs: { mcp: { pid: 42, pgid: 42, starttime: 123 } },
    };
    vi.mocked(createTmuxSidecarSession).mockImplementationOnce(async () => {
      writeSession(dataDir, newer);
    });
    const reap = vi.fn();
    Object.assign(service, { reapSidecarByName: reap });
    await expect(
      service.startSidecarInternalLocked({
        session,
        project,
        sidecarName: "mcp",
        sidecar: { command: "configured-service", autoStart: true },
        sidecarDepth: 0,
        operation: operation(),
      }),
    ).rejects.toThrow("ownership changed");
    expect(readSession(dataDir, session.id)?.sidecarLaunches).toEqual(newer.sidecarLaunches);
    expect(readSession(dataDir, session.id)?.sidecarProcs).toEqual(newer.sidecarProcs);
    expect(reap).not.toHaveBeenCalled();
  });

  it("revokes a global-port-lock waiter without letting its successor overtake the holder", async () => {
    const { service } = fixture();
    let release!: () => void;
    const holder = service.withSidecarPortLock(
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
    );
    await Promise.resolve();
    const controller = new AbortController();
    const cancelledTask = vi.fn(async () => {});
    const waiter = service.withSidecarPortLock(cancelledTask, operation(controller.signal));
    const rejected = expect(waiter).rejects.toThrow("cancelled");
    controller.abort();
    await rejected;
    const successorTask = vi.fn(async () => {});
    const successor = service.withSidecarPortLock(successorTask);
    await Promise.resolve();
    expect(successorTask).not.toHaveBeenCalled();
    release();
    await Promise.all([holder, successor]);
    expect(cancelledTask).not.toHaveBeenCalled();
    expect(successorTask).toHaveBeenCalledOnce();
  });

  it.each(["disconnect", "deadline"])(
    "drains a %s launch and admits a successor while preserving uncertain reservation evidence",
    async (cancellation) => {
      const { service, session, project, dataDir } = fixture();
      if (cancellation === "deadline") vi.useFakeTimers();
      const controller = new AbortController();
      const context = operation(controller.signal);
      const terminated = vi.fn();
      let entered!: () => void;
      const started = new Promise<void>((resolve) => {
        entered = resolve;
      });
      let lateCreated: (() => void) | undefined;
      vi.mocked(createTmuxSidecarSession).mockImplementationOnce(async (input) => {
        lateCreated = input.onCreated;
        entered();
        await new Promise<void>((_resolve, reject) => {
          input.operation?.signal.addEventListener(
            "abort",
            () => {
              terminated();
              reject(input.operation?.signal.reason);
            },
            { once: true },
          );
        });
      });
      const sidecar = { command: "serve", autoStart: true };
      const onStarted = vi.fn();
      const pending = service.startSidecarInternalLocked({
        session,
        project,
        sidecarName: "mcp",
        sidecar,
        sidecarDepth: 0,
        operation: context,
        onStarted,
      });
      const rejected = expect(pending).rejects.toThrow(
        cancellation === "deadline" ? "timed out" : "cancelled",
      );
      await started;
      if (cancellation === "deadline") await vi.advanceTimersByTimeAsync(20 * 60_000);
      else controller.abort();
      await rejected;
      vi.useRealTimers();
      expect(terminated).toHaveBeenCalledOnce();
      expect(readSession(dataDir, session.id)?.sidecarPorts).toEqual({ mcp: { PORT: 43210 } });
      const successor = {
        ...session,
        sidecarProcs: { mcp: { pid: 42, pgid: 42, starttime: 123 } },
      };
      writeSession(dataDir, successor);
      const otherSession = { ...session, id: "other-session" };
      writeSession(dataDir, otherSession);
      const otherStart = await service.startSidecarInternalLocked({
        session: otherSession,
        project,
        sidecarName: "other",
        sidecar,
        sidecarDepth: 0,
        operation: operation(),
      });
      expect(otherStart.id).toBe(otherSession.id);
      expect(createTmuxSidecarSession).toHaveBeenCalledTimes(2);
      lateCreated?.();
      await Promise.resolve();
      expect(readSession(dataDir, session.id)?.sidecarProcs).toEqual(successor.sidecarProcs);
      expect(onStarted).not.toHaveBeenCalled();
    },
  );

  it("cancels a reservation probe without allowing its late result to reserve or launch", async () => {
    const { service, session, project, dataDir } = fixture();
    Reflect.deleteProperty(service, "ensureSidecarReservation");
    let entered!: () => void;
    const probing = new Promise<void>((resolve) => {
      entered = resolve;
    });
    let release!: (free: boolean) => void;
    vi.mocked(isHostPortFree).mockImplementationOnce(async () => {
      entered();
      return new Promise<boolean>((resolve) => {
        release = resolve;
      });
    });
    const controller = new AbortController();
    const sidecar: SidecarConfig = {
      command: "serve",
      autoStart: true,
      ports: { http: { env: "PORT", start: 43210, end: 43210 } },
    };
    const pending = service.startSidecarInternalLocked({
      session,
      project,
      sidecarName: "mcp",
      sidecar,
      sidecarDepth: 0,
      operation: operation(controller.signal),
    });
    const rejected = expect(pending).rejects.toThrow("cancelled");
    await probing;
    controller.abort();
    await rejected;
    await service.withSidecarPortLock(async () => {});
    release(true);
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(readSession(dataDir, session.id)?.sidecarPorts).toBeUndefined();
    expect(createTmuxSidecarSession).not.toHaveBeenCalled();
  });

  it("abandons a never-returning read-only readiness probe and never starts the next MCP sidecar", async () => {
    const { service, session, project } = fixture();
    const sidecar: SidecarConfig = {
      command: "serve",
      autoStart: true,
      mcp: { server: "test", portId: "http", path: "/mcp" },
      ports: { http: { env: "PORT", start: 43210, end: 43210 } },
    };
    project.sidecars = { "cancel-readiness": sidecar, next: sidecar };
    let entered!: () => void;
    const ready = new Promise<void>((resolve) => {
      entered = resolve;
    });
    BUILTIN_SIDECARS["cancel-readiness"] = {
      config: sidecar,
      readiness: () => {
        entered();
        return new Promise<boolean>(() => {});
      },
    };
    const internal = vi
      .spyOn(service, "startSidecarInternal")
      .mockResolvedValue({ ...session, sidecarPorts: { "cancel-readiness": { PORT: 43210 } } });
    const controller = new AbortController();
    const pending = service.startMcpSidecars(session, project, operation(controller.signal));
    const rejected = expect(pending).rejects.toThrow("cancelled");
    await ready;
    controller.abort();
    await rejected;
    expect(internal).toHaveBeenCalledTimes(1);
  });
});
