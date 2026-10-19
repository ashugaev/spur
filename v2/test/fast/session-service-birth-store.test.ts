import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { EventBus } from "../../src/event-bus.js";
import {
  listSessions,
  readPendingSpawnWork,
  readSession,
  writeSession,
} from "../../src/metadata.js";
import { SessionAdmissionDeniedError, SessionService } from "../../src/session-service.js";
import { startConfiguredTriggers } from "../../src/triggers.js";
import type { SessionRecord, SessionView, SpawnSessionRequest } from "../../src/types.js";

const directories: string[] = [];
const services: SessionService[] = [];
afterEach(() => {
  for (const service of services.splice(0)) service.dispose();
  vi.restoreAllMocks();
  vi.useRealTimers();
  for (const dir of directories.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "spur-birth-store-"));
  directories.push(dir);
  const dataDir = join(dir, "data");
  const configPath = join(dir, "spur.yaml");
  writeFileSync(
    configPath,
    JSON.stringify({
      dataDir,
      worktreeDir: join(dir, "worktrees"),
      projects: { test: { path: dir } },
    }),
  );
  const fresh = () => {
    const service = new SessionService(configPath, undefined, { deferBackgroundLoops: true });
    services.push(service);
    return service;
  };
  const record = (
    status: SessionRecord["status"],
    request: SpawnSessionRequest,
    key = "birth:0",
  ): SessionRecord => ({
    id: "test-birth",
    project: "test",
    agent: "claude",
    prompt: request.prompt ?? "",
    branch: "main",
    worktree: false,
    worktreePath: dir,
    tmuxSession: "test-birth",
    launchCommand: "claude",
    status,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    triggerBirthKey: key,
    triggerBirthRequest: request,
  });
  return { dir, dataDir, fresh, record };
}

describe("durable trigger birth store", () => {
  it.each(["running", "stopped", "completed", "errored"] as const)(
    "adopts the persisted %s birth through a fresh service without another launch",
    async (status) => {
      const f = fixture();
      const request: SpawnSessionRequest = {
        project: "test",
        prompt: "review",
        steps: ["verify"],
        overrides: { worktree: false },
        slots: { links: [{ label: "pr", url: "https://example.com/pr/1" }] },
        allowedTriggers: [],
      };
      writeSession(f.dataDir, f.record(status, request));
      expect(readSession(f.dataDir, "test-birth")).toMatchObject({
        triggerBirthKey: "birth:0",
        triggerBirthRequest: request,
      });
      expect(listSessions(f.dataDir)[0]).toMatchObject({
        triggerBirthKey: "birth:0",
        triggerBirthRequest: request,
      });
      const service = f.fresh();
      const launch = vi
        .spyOn(
          service as unknown as { spawnOnce(request: SpawnSessionRequest): Promise<SessionView> },
          "spawnOnce",
        )
        .mockRejectedValue(new Error("Unexpected second launch"));
      vi.spyOn(service, "get").mockResolvedValue({ id: "test-birth", status } as SessionView);
      expect(service.getTriggerBirth("test", "birth:0", request)?.id).toBe("test-birth");
      await expect(service.spawn(request, { triggerBirthKey: "birth:0" })).resolves.toMatchObject({
        id: "test-birth",
        status,
      });
      expect(launch).not.toHaveBeenCalled();
      expect(() =>
        service.getTriggerBirth("test", "birth:0", { ...request, overrides: { worktree: true } }),
      ).toThrow("different spawn request");
      expect(() => service.getTriggerBirth("other", "birth:0", request)).toThrow(
        "different project",
      );
      const rewritten = readSession(f.dataDir, "test-birth");
      if (!rewritten) throw new Error("Missing persisted birth");
      writeSession(f.dataDir, { ...rewritten, updatedAt: new Date().toISOString() });
      expect(f.fresh().getTriggerBirth("test", "birth:0", request)?.id).toBe("test-birth");
    },
  );

  it("reloads a pending queue after an accepted birth before its checkpoint without relaunching", async () => {
    const f = fixture();
    const service = f.fresh();
    const bus = new EventBus();
    const config = {
      dataDir: f.dataDir,
      projects: {
        test: {
          sources: { tick: { type: "cron" } },
          triggers: {
            review: {
              source: "tick",
              event: "cron:tick",
              spawn: { blocks: [{ prompt: "review", overrides: { worktree: false } }] },
            },
          },
        },
      },
    };
    const autoPing = { setConfiguredRouteAuthorities: vi.fn() } as never;
    const denied = vi
      .spyOn(service, "spawn")
      .mockRejectedValue(new SessionAdmissionDeniedError("cap", "cap"));
    let controller = startConfiguredTriggers({
      config: config as never,
      bus,
      sessionService: service,
      autoPing,
    });
    bus.emit({
      projectId: "test",
      sourceId: "tick",
      name: "cron:tick",
      occurrenceId: "crash",
      data: {},
    });
    await vi.waitFor(() => expect(denied).toHaveBeenCalledOnce());
    await controller.stop();
    const request = denied.mock.calls[0]?.[0];
    const key = denied.mock.calls[0]?.[1]?.triggerBirthKey;
    if (!request || !key) throw new Error("Missing queued birth identity");
    const pending = [...readPendingSpawnWork(f.dataDir).values()][0];
    if (!pending) throw new Error("Missing queue checkpoint");
    writeSession(f.dataDir, f.record("stopped", request, key));
    const raw: unknown = JSON.parse(
      readFileSync(join(f.dataDir, "sessions", "test", "test-birth.json"), "utf8"),
    );
    expect(raw).toMatchObject({ triggerBirthKey: key, triggerBirthRequest: request });
    denied.mockRestore();
    service.dispose();
    const restored = f.fresh();
    const launch = vi
      .spyOn(
        restored as unknown as { spawnOnce(request: SpawnSessionRequest): Promise<SessionView> },
        "spawnOnce",
      )
      .mockRejectedValue(new Error("Unexpected second launch"));
    vi.spyOn(restored, "get").mockResolvedValue({
      id: "test-birth",
      status: "stopped",
    } as SessionView);
    vi.useFakeTimers();
    vi.setSystemTime(pending.notBeforeAt + 1);
    controller = startConfiguredTriggers({
      config: config as never,
      bus,
      sessionService: restored,
      autoPing,
    });
    try {
      await vi.advanceTimersByTimeAsync(0);
      expect(readPendingSpawnWork(f.dataDir).size).toBe(0);
      expect(launch).not.toHaveBeenCalled();
      expect(listSessions(f.dataDir)).toHaveLength(1);
    } finally {
      await controller.stop();
    }
  });

  it.each([
    { triggerBirthKey: "key" },
    { triggerBirthRequest: { project: "test" } },
    { triggerBirthKey: "", triggerBirthRequest: { project: "test" } },
    { triggerBirthKey: "key", triggerBirthRequest: [] },
    { triggerBirthKey: "key", triggerBirthRequest: { project: "other" } },
    { triggerBirthKey: "key", triggerBirthRequest: { project: "test", prompt: 42 } },
  ])("drops an unpaired or malformed birth fingerprint: %j", (invalid) => {
    const f = fixture();
    writeSession(f.dataDir, {
      ...f.record("stopped", { project: "test" }),
      triggerBirthKey: undefined,
      triggerBirthRequest: undefined,
      ...invalid,
    } as unknown as SessionRecord);
    expect(readSession(f.dataDir, "test-birth")).not.toHaveProperty("triggerBirthKey");
    expect(readSession(f.dataDir, "test-birth")).not.toHaveProperty("triggerBirthRequest");
  });
});
