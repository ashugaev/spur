import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { EventBus } from "../../src/event-bus.js";
import * as hostMemory from "../../src/host-memory.js";
import {
  listSessions,
  readPendingSpawnWork,
  readSession,
  writeSession,
} from "../../src/metadata.js";
import {
  IdempotencyKeyConflictError,
  InvalidIdempotencyKeyError,
  SessionAdmissionDeniedError,
  SessionService,
} from "../../src/session-service.js";
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
  // Pin the host sensors; admission must not depend on runner memory pressure.
  vi.spyOn(hostMemory, "readHostMemory").mockReturnValue({
    totalBytes: 64_000_000_000,
    availableBytes: 32_000_000_000,
    swapTotalBytes: 8_000_000_000,
    swapFreeBytes: 8_000_000_000,
  });
  vi.spyOn(hostMemory, "readCgroupMemorySnapshot").mockReturnValue(null);
  vi.spyOn(hostMemory, "readCgroupPressure").mockReturnValue(null);
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

describe("api idempotency key", () => {
  const request: SpawnSessionRequest = {
    project: "test",
    prompt: "ship it",
    overrides: { worktree: false },
  };
  type Internals = {
    spawnOnce(request: SpawnSessionRequest): Promise<SessionView>;
    acceptBackgroundSpawn(
      request: SpawnSessionRequest,
      options: { triggerBirthKey: string; triggerBirthRequest: SpawnSessionRequest },
    ): Promise<{ session: SessionView }>;
  };
  const internals = (service: SessionService) => service as unknown as Internals;
  const view = (status: SessionView["status"] = "running") =>
    ({ id: "test-birth", status }) as SessionView;

  it("repeat spawn returns the first session with replayed", async () => {
    const f = fixture();
    const service = f.fresh();
    const launch = vi.spyOn(internals(service), "spawnOnce").mockImplementation(async (fp) => {
      writeSession(f.dataDir, f.record("running", fp, "api:k"));
      return view();
    });
    vi.spyOn(service, "get").mockResolvedValue(view());
    const first = await service.spawnFromRequest({ ...request, idempotencyKey: "k" }, "foreground");
    const second = await service.spawnFromRequest(
      { ...request, idempotencyKey: "k" },
      "foreground",
    );
    expect(launch).toHaveBeenCalledOnce();
    expect(first).not.toHaveProperty("replayed");
    expect(second).toMatchObject({ id: "test-birth", replayed: true });
    expect(listSessions(f.dataDir)).toHaveLength(1);
    expect(launch.mock.calls[0]?.[0]).not.toHaveProperty("idempotencyKey");
  });

  it("concurrent calls coalesce on one launch", async () => {
    const f = fixture();
    const service = f.fresh();
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const launch = vi.spyOn(internals(service), "spawnOnce").mockImplementation(async () => {
      await gate;
      return view();
    });
    const accept = vi.spyOn(internals(service), "acceptBackgroundSpawn");
    const body = { ...request, idempotencyKey: "k" };
    const calls = Promise.all([
      service.spawnFromRequest(body, "foreground"),
      service.spawnFromRequest(body, "background"),
    ]);
    release();
    const results = await calls;
    expect(launch).toHaveBeenCalledOnce();
    expect(accept).not.toHaveBeenCalled();
    expect(results.filter((result) => result.replayed === true)).toHaveLength(1);
  });

  it("background spawn dedups and stores attachment sha256", async () => {
    const f = fixture();
    const service = f.fresh();
    const accept = vi
      .spyOn(internals(service), "acceptBackgroundSpawn")
      .mockImplementation(async (_request, options) => {
        writeSession(f.dataDir, f.record("spawning", options.triggerBirthRequest, "api:k"));
        return { session: view("spawning") };
      });
    vi.spyOn(service, "get").mockResolvedValue(view("spawning"));
    const body = {
      ...request,
      attachments: [{ name: "a.png", data: "QUJD" }],
      idempotencyKey: "k",
    };
    await service.spawnFromRequest(body, "background");
    const [sent, options] = accept.mock.calls[0] ?? [];
    const digest = createHash("sha256").update("QUJD").digest("hex");
    expect(options).toMatchObject({
      triggerBirthKey: "api:k",
      triggerBirthRequest: { attachments: [{ name: "a.png", data: `sha256:${digest}` }] },
    });
    expect(sent).not.toHaveProperty("idempotencyKey");
    expect(options?.triggerBirthRequest).not.toHaveProperty("idempotencyKey");
    expect(JSON.stringify(readSession(f.dataDir, "test-birth"))).not.toContain("QUJD");
    await expect(service.spawnFromRequest(body, "background")).resolves.toMatchObject({
      replayed: true,
    });
    expect(accept).toHaveBeenCalledOnce();
    await expect(
      service.spawnFromRequest(
        { ...body, attachments: [{ name: "a.png", data: "REVG" }] },
        "background",
      ),
    ).rejects.toBeInstanceOf(IdempotencyKeyConflictError);
  });

  it("different request or project conflicts without spawning", async () => {
    const f = fixture();
    const service = f.fresh();
    const launch = vi.spyOn(internals(service), "spawnOnce");
    const accept = vi.spyOn(internals(service), "acceptBackgroundSpawn");
    writeSession(f.dataDir, f.record("running", request, "api:k"));
    const conflict = await service
      .spawnFromRequest({ ...request, prompt: "other", idempotencyKey: "k" }, "foreground")
      .catch((error: unknown) => error);
    expect(conflict).toBeInstanceOf(IdempotencyKeyConflictError);
    expect((conflict as IdempotencyKeyConflictError).payload).toMatchObject({
      code: "idempotency_key_conflict",
      sessionId: "test-birth",
    });
    await expect(
      service.spawnFromRequest({ ...request, project: "other", idempotencyKey: "k" }, "background"),
    ).rejects.toBeInstanceOf(IdempotencyKeyConflictError);
    expect(launch).not.toHaveBeenCalled();
    expect(accept).not.toHaveBeenCalled();
    expect(listSessions(f.dataDir)).toHaveLength(1);
  });

  it("a mismatched call made while the first is pending is answered after it", async () => {
    const f = fixture();
    const service = f.fresh();
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const launch = vi.spyOn(internals(service), "spawnOnce").mockImplementation(async (fp) => {
      await gate;
      writeSession(f.dataDir, f.record("running", fp, "api:k"));
      return view();
    });
    const first = service.spawnFromRequest({ ...request, idempotencyKey: "k" }, "foreground");
    const second = service
      .spawnFromRequest({ ...request, prompt: "other", idempotencyKey: "k" }, "foreground")
      .catch((error: unknown) => error);
    release();
    await first;
    const conflict = await second;
    expect(conflict).toBeInstanceOf(IdempotencyKeyConflictError);
    expect((conflict as IdempotencyKeyConflictError).payload.sessionId).toBe("test-birth");
    expect(launch).toHaveBeenCalledOnce();
    expect(listSessions(f.dataDir)).toHaveLength(1);
  });

  it.each(["fails", "succeeds"] as const)(
    "a same-key retry during a pending launch joins it and sees the launch %s",
    async (outcome) => {
      const f = fixture();
      const service = f.fresh();
      let settle: () => void = () => {};
      const gate = new Promise<void>((resolve) => {
        settle = resolve;
      });
      const launch = vi.spyOn(internals(service), "spawnOnce").mockImplementation(async (fp) => {
        // The keyed placeholder is on disk before the launch settles.
        writeSession(f.dataDir, f.record("spawning", fp, "api:k"));
        await gate;
        if (outcome === "fails") throw new Error("launch failed");
        return view("running");
      });
      vi.spyOn(service, "get").mockResolvedValue(view("spawning"));
      const body = { ...request, idempotencyKey: "k" };
      const first = service.spawnFromRequest(body, "foreground").catch((error: unknown) => error);
      await vi.waitFor(() => expect(launch).toHaveBeenCalledOnce());
      const retry = service.spawnFromRequest(body, "foreground").catch((error: unknown) => error);
      settle();
      const [firstResult, retryResult] = await Promise.all([first, retry]);
      expect(launch).toHaveBeenCalledOnce();
      if (outcome === "fails") {
        expect(firstResult).toMatchObject({ message: "launch failed" });
        expect(retryResult).toMatchObject({ message: "launch failed" });
      } else {
        expect(retryResult).toMatchObject({ status: "running", replayed: true });
      }
    },
  );

  it("a mismatched call waiting on a first call that leaves no record runs its own launch", async () => {
    const f = fixture();
    const service = f.fresh();
    let fail: () => void = () => {};
    const gate = new Promise<void>((_resolve, reject) => {
      fail = () => reject(new Error("boom"));
    });
    const launch = vi
      .spyOn(internals(service), "spawnOnce")
      .mockImplementationOnce(async () => {
        await gate;
        return view();
      })
      .mockImplementationOnce(async (fp) => {
        writeSession(f.dataDir, f.record("running", fp, "api:k"));
        return view();
      });
    const first = service
      .spawnFromRequest({ ...request, idempotencyKey: "k" }, "foreground")
      .catch((error: unknown) => error);
    const second = service.spawnFromRequest(
      { ...request, prompt: "other", idempotencyKey: "k" },
      "foreground",
    );
    fail();
    expect(await first).toMatchObject({ message: "boom" });
    const result = await second;
    expect(launch).toHaveBeenCalledTimes(2);
    expect(result).toMatchObject({ id: "test-birth" });
    expect(result).not.toHaveProperty("replayed");
    expect(listSessions(f.dataDir)).toHaveLength(1);
  });

  it("errored birth keeps answering the key", async () => {
    const f = fixture();
    const service = f.fresh();
    const launch = vi.spyOn(internals(service), "spawnOnce");
    writeSession(f.dataDir, f.record("errored", request, "api:k"));
    vi.spyOn(service, "get").mockResolvedValue(view("errored"));
    await expect(
      service.spawnFromRequest({ ...request, idempotencyKey: "k" }, "foreground"),
    ).resolves.toMatchObject({ status: "errored", replayed: true });
    expect(launch).not.toHaveBeenCalled();
  });

  it.each(["", "x".repeat(129), "a\nb", 7])("rejects invalid idempotency key %j", async (bad) => {
    const f = fixture();
    const service = f.fresh();
    const launch = vi.spyOn(internals(service), "spawnOnce");
    await expect(
      service.spawnFromRequest(
        { ...request, idempotencyKey: bad as unknown as string },
        "foreground",
      ),
    ).rejects.toBeInstanceOf(InvalidIdempotencyKeyError);
    expect(launch).not.toHaveBeenCalled();
  });
});

describe("api idempotency key after a failed launch", () => {
  const request: SpawnSessionRequest = {
    project: "test",
    prompt: "ship it",
    overrides: { worktree: false },
  };

  it("keeps the key on a failed foreground launch and the retry replays it", async () => {
    const f = fixture();
    const service = f.fresh();
    vi.spyOn(
      service as unknown as { prepareSessionTools(): string },
      "prepareSessionTools",
    ).mockImplementation(() => {
      throw new Error("boom");
    });
    await expect(
      service.spawnFromRequest({ ...request, idempotencyKey: "k" }, "foreground"),
    ).rejects.toThrow("boom");
    const [created] = listSessions(f.dataDir);
    expect(created).toMatchObject({ status: "errored", triggerBirthKey: "api:k" });
    await expect(
      service.spawnFromRequest({ ...request, idempotencyKey: "k" }, "foreground"),
    ).resolves.toMatchObject({ id: created?.id, status: "errored", replayed: true });
    expect(listSessions(f.dataDir)).toHaveLength(1);
  });

  it("keeps the key on a failed background prepare and the retry replays it", async () => {
    const f = fixture();
    const service = f.fresh();
    vi.spyOn(service as unknown as { logUserInput(): void }, "logUserInput").mockImplementation(
      () => {
        throw new Error("boom");
      },
    );
    await expect(
      service.spawnFromRequest({ ...request, idempotencyKey: "k" }, "background"),
    ).rejects.toThrow("boom");
    const [created] = listSessions(f.dataDir);
    expect(created).toMatchObject({ status: "errored", triggerBirthKey: "api:k" });
    await expect(
      service.spawnFromRequest({ ...request, idempotencyKey: "k" }, "background"),
    ).resolves.toMatchObject({ id: created?.id, status: "errored", replayed: true });
    expect(listSessions(f.dataDir)).toHaveLength(1);
  });
});
