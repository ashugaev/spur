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
import { createTmuxSidecarSession } from "../../src/runtime-tmux.js";
import type * as runtimeTmuxModule from "../../src/runtime-tmux.js";
import { isHostPortFree } from "../../src/port-probe.js";
import type * as portProbeModule from "../../src/port-probe.js";
import type { ProjectConfig, SessionRecord, SidecarConfig } from "../../src/types.js";

vi.mock("../../src/runtime-tmux.js", async (importOriginal) => ({
  ...(await importOriginal<typeof runtimeTmuxModule>()),
  createTmuxSidecarSession: vi.fn(async () => {}),
  getSidecarTmuxPresence: vi.fn(async () => ({ present: false })),
  getTmuxPanePid: vi.fn(async () => null),
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
    config: { dataDir },
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
  vi.mocked(createTmuxSidecarSession).mockReset().mockResolvedValue(undefined);
});

describe("restore-owned sidecar cancellation", () => {
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
