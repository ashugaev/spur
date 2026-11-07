import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { EventBus } from "../../src/event-bus.js";
import { AutoPingService } from "../../src/auto-ping.js";
import { resetEventLogCollapse } from "../../src/event-log.js";
import {
  readPendingSpawnWork,
  writePendingSpawnWork,
  recordWorkItemLifecycle,
  readWorkItemLifecycles,
  readPendingSendBatches,
  readSession,
  writeSession,
} from "../../src/metadata.js";
import { SessionAdmissionDeniedError } from "../../src/session-service.js";
import { startConfiguredTriggers } from "../../src/triggers.js";

const dirs: string[] = [];
afterEach(() => {
  resetEventLogCollapse();
  vi.useRealTimers();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function fixture(blocks = [{ prompt: "review" }]) {
  vi.useFakeTimers();
  const dataDir = mkdtempSync(join(tmpdir(), "spur-spawn-queue-"));
  dirs.push(dataDir);
  const bus = new EventBus();
  const config = {
    dataDir,
    projects: {
      test: {
        sources: { tick: { type: "cron" } },
        triggers: { review: { source: "tick", event: "cron:tick", spawn: { blocks } } },
      },
    },
  };
  const spawn = vi.fn().mockResolvedValue({ id: "test-1", status: "running" });
  const birth = vi.fn();
  const get = vi.fn().mockResolvedValue({ id: "test-1", status: "running", workspaceExists: true });
  const deps = {
    config: config as never,
    bus,
    sessionService: { spawn, get, getTriggerBirth: birth } as never,
    autoPing: { setConfiguredRouteAuthorities: vi.fn() } as never,
    logger: { warn: vi.fn() },
  };
  const emit = () =>
    bus.emit({
      projectId: "test",
      sourceId: "tick",
      name: "cron:tick",
      occurrenceId: "tick-1",
      data: {},
    });
  return { dataDir, config, spawn, get, birth, deps, emit };
}

function workItemFixture(blocks = [{ prompt: "anchor" }, { prompt: "sibling" }]) {
  const f = fixture(blocks);
  f.config.projects.test.triggers.review.event = "github:work_item.new";
  const data = {
    externalId: "repo#queued",
    url: "https://example.com/pr/2",
    number: 2,
    title: "queued",
    repo: "repo",
  };
  const emit = () =>
    f.deps.bus.emit({
      projectId: "test",
      sourceId: "tick",
      name: "github:work_item.new",
      occurrenceId: "queued-work-item",
      data,
    });
  const members = () =>
    readWorkItemLifecycles(f.dataDir, "test", "tick").get(data.externalId)?.members ?? [];
  return { ...f, emit, members };
}

describe("work-item foreground spawn", () => {
  it("keeps admitted foreground completion semantics", async () => {
    const f = workItemFixture([{ prompt: "foreground" }]);
    let complete!: () => void;
    f.spawn.mockImplementation(
      () =>
        new Promise((resolve) => {
          complete = () => resolve({ id: "test-foreground", status: "running", state: "working" });
        }),
    );
    const controller = startConfiguredTriggers(f.deps);
    try {
      f.emit();
      await vi.advanceTimersByTimeAsync(0);
      expect(f.members()[0]).not.toHaveProperty("sessionId");
      complete();
      await vi.advanceTimersByTimeAsync(0);
      expect(f.members()[0]).toMatchObject({
        state: "running",
        sessionId: "test-foreground",
        attempts: 1,
      });
    } finally {
      complete();
      await controller.stop();
    }
  });
});

describe("durable spawn admission", () => {
  it("keeps equal-payload occurrences and routes distinct across disk reload", async () => {
    const f = fixture();
    Object.assign(f.config.projects.test.triggers, {
      second: structuredClone(f.config.projects.test.triggers.review),
    });
    f.spawn.mockRejectedValue(new SessionAdmissionDeniedError("cap", "cap"));
    let controller = startConfiguredTriggers(f.deps);
    const emit = (occurrenceId: string) =>
      f.deps.bus.emit({
        projectId: "test",
        sourceId: "tick",
        name: "cron:tick",
        occurrenceId,
        data: { title: "same payload" },
      });
    emit("first");
    emit("second");
    emit("first");
    await vi.advanceTimersByTimeAsync(0);
    const pending = [...readPendingSpawnWork(f.dataDir).values()];
    expect(pending).toHaveLength(4);
    expect(
      new Set(pending.flatMap((work) => work.blocks.map((block) => block.birthKey))).size,
    ).toBe(4);
    expect(f.spawn).toHaveBeenCalledTimes(4);
    await controller.stop();
    const births = new Map<string, string>();
    f.spawn.mockImplementation(async (_request, options) => {
      const sessionId = `test-${births.size + 1}`;
      births.set(options.triggerBirthKey, sessionId);
      return { id: sessionId, status: "running" };
    });
    controller = startConfiguredTriggers(f.deps);
    try {
      await vi.advanceTimersByTimeAsync(15_000);
      expect(births.size).toBe(4);
      expect(new Set(births.values()).size).toBe(4);
      expect(f.spawn).toHaveBeenCalledTimes(8);
      expect(readPendingSpawnWork(f.dataDir).size).toBe(0);
    } finally {
      await controller.stop();
    }
  });

  it("suppresses distinct occurrences for a work item owned by one pending spawn claim", async () => {
    const f = fixture();
    f.config.projects.test.triggers.review.event = "github:work_item.new";
    const data = {
      externalId: "repo#1",
      url: "https://example.com/pr/1",
      number: 1,
      title: "task",
      repo: "repo",
    };
    f.spawn.mockRejectedValue(new Error("spawn failed"));
    const controller = startConfiguredTriggers(f.deps);
    const emit = (occurrenceId: string) =>
      f.deps.bus.emit({
        projectId: "test",
        sourceId: "tick",
        name: "github:work_item.new",
        occurrenceId,
        data,
      });
    try {
      emit("first");
      emit("second");
      await vi.advanceTimersByTimeAsync(0);
      expect(readPendingSpawnWork(f.dataDir).size).toBe(0);
      expect(f.spawn).toHaveBeenCalledTimes(1);
      expect(readWorkItemLifecycles(f.dataDir, "test", "tick").get(data.externalId)).toMatchObject({
        state: "failed",
        members: [expect.objectContaining({ attempts: 1, deferrals: 0 })],
      });
      f.spawn.mockResolvedValue({ id: "test-owner", status: "running" });
      await vi.advanceTimersByTimeAsync(15_000);
      expect(f.spawn).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(45 * 60_000 - 15_000);
      expect(f.spawn).toHaveBeenCalledTimes(1);
      emit("eligible-current-return");
      await vi.advanceTimersByTimeAsync(0);
      expect(f.spawn).toHaveBeenCalledTimes(2);
      expect(readWorkItemLifecycles(f.dataDir, "test", "tick").get(data.externalId)).toMatchObject({
        state: "running",
        sessionId: "test-owner",
      });
      expect(readPendingSpawnWork(f.dataDir).size).toBe(0);
    } finally {
      await controller.stop();
    }
  });

  it("drains eligible SEND beside denied SPAWN and fences the replaced scheduler", async () => {
    const f = fixture();
    Object.assign(f.config.projects.test.sources, { monitor: { type: "service" } });
    Object.assign(f.config.projects.test.triggers, {
      notify: { source: "monitor", event: "service:problem", send: { interrupt: false } },
    });
    f.get.mockResolvedValue({
      id: "test-existing",
      status: "running",
      state: "waiting",
      lastActivityAt: "2000-01-01T00:00:00.000Z",
      workspaceExists: true,
    });
    f.spawn.mockRejectedValue(new SessionAdmissionDeniedError("cap", "cap"));
    const deliver = vi.fn().mockResolvedValue(undefined);
    const autoPing = new AutoPingService(f.dataDir);
    const deps = {
      ...f.deps,
      autoPing,
      sessionService: { spawn: f.spawn, get: f.get, getTriggerBirth: f.birth, deliver } as never,
    };
    const timers = vi.spyOn(globalThis, "setInterval");
    let controller = startConfiguredTriggers(deps);
    f.emit();
    f.deps.bus.emit({
      projectId: "test",
      sourceId: "monitor",
      name: "service:problem",
      occurrenceId: "send",
      data: { sessionId: "test-existing", serviceId: "monitor", ruleId: "health" },
    });
    await vi.advanceTimersByTimeAsync(35_000);
    expect(deliver).toHaveBeenCalledTimes(1);
    expect(readPendingSendBatches(f.dataDir).size).toBe(0);
    expect(readPendingSpawnWork(f.dataDir).size).toBe(1);
    const oldTick = timers.mock.calls.find(([, delay]) => delay === 5_000)?.[0];
    if (typeof oldTick !== "function") throw new Error("Missing shared scheduler");
    await controller.stop();
    controller = startConfiguredTriggers(deps);
    try {
      await vi.advanceTimersByTimeAsync(0);
      const pending = [...readPendingSpawnWork(f.dataDir).values()];
      const attempts = f.spawn.mock.calls.length;
      oldTick();
      await vi.advanceTimersByTimeAsync(0);
      expect([...readPendingSpawnWork(f.dataDir).values()]).toEqual(pending);
      expect(f.spawn).toHaveBeenCalledTimes(attempts);
      f.spawn.mockResolvedValue({ id: "test-new", status: "running" });
      await vi.advanceTimersByTimeAsync(80_000);
      expect(f.spawn).toHaveBeenCalledTimes(attempts + 1);
      expect(deliver).toHaveBeenCalledTimes(1);
      expect(readPendingSpawnWork(f.dataDir).size).toBe(0);
    } finally {
      await controller.stop();
      autoPing.dispose();
      timers.mockRestore();
    }
  });
  it("preserves original event data while a spawn waits for admission", async () => {
    const f = fixture([{ prompt: "{{title}}" }]);
    f.spawn.mockRejectedValue(new SessionAdmissionDeniedError("cap", "cap"));
    const controller = startConfiguredTriggers(f.deps);
    const data = { title: "original" };
    try {
      f.deps.bus.emit({
        projectId: "test",
        sourceId: "tick",
        name: "cron:tick",
        occurrenceId: "immutable",
        data,
      });
      data.title = "mutated";
      await vi.advanceTimersByTimeAsync(0);
      expect(f.spawn.mock.calls[0]?.[0]).toMatchObject({ prompt: "original" });
      f.spawn.mockResolvedValue({ id: "test-1", status: "running" });
      await vi.advanceTimersByTimeAsync(15_000);
      expect(f.spawn.mock.calls[1]?.[0]).toMatchObject({ prompt: "original" });
    } finally {
      await controller.stop();
    }
  });
  it("retains an unresolved receiptless accepted work-item journal across controller restarts", async () => {
    const f = fixture();
    f.config.projects.test.triggers.review.event = "github:work_item.new";
    const workId = JSON.stringify(["test", "tick", "review", "event"]);
    const data = {
      externalId: "repo#1",
      url: "https://example.com/pr/1",
      number: 1,
      title: "task",
      repo: "repo",
    };
    const createdAt = new Date().toISOString();
    recordWorkItemLifecycle(f.dataDir, "test", "tick", {
      ...data,
      autoComplete: false,
      createdAt,
      state: "pending",
      spawnWorkId: workId,
    });
    writePendingSpawnWork(f.dataDir, {
      workId,
      revision: 1,
      projectId: "test",
      triggerId: "review",
      sourceId: "tick",
      eventName: "github:work_item.new",
      occurrenceId: "event",
      routeFingerprint: JSON.stringify({
        projectId: "test",
        sourceId: "tick",
        sourceType: "cron",
        triggerId: "review",
        trigger: f.config.projects.test.triggers.review,
      }),
      eventData: data,
      createdAt,
      nextBlockIndex: 1,
      lastSessionId: "test-1",
      failures: [],
      admissionDenials: 0,
      notBeforeAt: 0,
      blocks: [{ birthKey: `${workId}:0`, state: "succeeded", sessionId: "test-1" }],
    });
    const request = {
      project: "test",
      prompt: "review",
      slots: { links: [{ label: "pr", url: data.url }] },
    };
    writeSession(f.dataDir, {
      id: "test-1",
      project: "test",
      agent: "claude",
      prompt: "review",
      branch: "main",
      worktree: false,
      worktreePath: f.dataDir,
      tmuxSession: "test-1",
      launchCommand: "",
      status: "spawning",
      createdAt,
      updatedAt: createdAt,
      triggerBirthKey: `${workId}:0`,
      triggerBirthRequest: request,
    });
    f.birth.mockImplementation(() => readSession(f.dataDir, "test-1") ?? undefined);
    f.get.mockResolvedValue({
      id: "test-1",
      status: "spawning",
      state: "error",
      workspaceExists: true,
    });
    const initialJournal = readPendingSpawnWork(f.dataDir).get(workId);
    if (!initialJournal) throw new Error("Missing original accepted journal");
    const { revision: originalRevision, ...originalJournal } = initialJournal;
    expect(readSession(f.dataDir, "test-1")).toMatchObject({
      status: "spawning",
      launchCommand: "",
      triggerBirthKey: `${workId}:0`,
      triggerBirthRequest: request,
    });
    const expectRetainedBirth = () => {
      const journal = readPendingSpawnWork(f.dataDir).get(workId);
      if (!journal) throw new Error("Unresolved accepted journal was retired");
      const { revision, ...retained } = journal;
      expect(retained).toEqual(originalJournal);
      expect(revision).toBeGreaterThanOrEqual(originalRevision);
      expect(readPendingSpawnWork(f.dataDir).size).toBe(1);
      const lifecycle = readWorkItemLifecycles(f.dataDir, "test", "tick").get(data.externalId);
      expect(lifecycle).toMatchObject({
        state: "pending",
        spawnWorkId: workId,
        members: [
          expect.objectContaining({
            state: "spawning",
            sessionId: "test-1",
            claimedAt: createdAt,
            attempts: 0,
            deferrals: 0,
          }),
        ],
      });
      expect(lifecycle?.members[0]).not.toHaveProperty("startedAt");
      const accepted = readSession(f.dataDir, "test-1");
      expect(accepted).toMatchObject({
        id: "test-1",
        status: "spawning",
        launchCommand: "",
        triggerBirthKey: `${workId}:0`,
        triggerBirthRequest: request,
        triggerOrigin: {
          triggerId: "review",
          sourceId: "tick",
          externalId: data.externalId,
          blockIndex: 0,
        },
      });
      for (const field of ["spawnIntent", "spawnReceipt", "agentSessionId", "agentLaunchId"])
        expect(accepted).not.toHaveProperty(field);
      expect(f.spawn).not.toHaveBeenCalled();
      return { accepted, members: lifecycle?.members };
    };
    const emit = () =>
      f.deps.bus.emit({
        projectId: "test",
        sourceId: "tick",
        name: "github:work_item.new",
        occurrenceId: "current-return",
        data,
      });
    let controller = startConfiguredTriggers(f.deps);
    try {
      await vi.advanceTimersByTimeAsync(0);
      expect(f.spawn).not.toHaveBeenCalled();
      expect(readPendingSpawnWork(f.dataDir).size).toBe(1);
      await vi.advanceTimersByTimeAsync(45 * 60_000);
      emit();
      await vi.advanceTimersByTimeAsync(0);
      const retained = expectRetainedBirth();
      await controller.stop();
      controller = startConfiguredTriggers(f.deps);
      await vi.advanceTimersByTimeAsync(45 * 60_000);
      emit();
      await vi.advanceTimersByTimeAsync(0);
      expect(expectRetainedBirth()).toEqual(retained);
    } finally {
      await controller.stop();
    }
  });
  it("keeps a cap-denied first desk block ahead of its siblings", async () => {
    const f = fixture([{ prompt: "anchor" }, { prompt: "sibling" }]);
    Object.assign(f.config.projects.test.triggers.review, { spawnDeskGroup: true });
    f.spawn.mockRejectedValue(new SessionAdmissionDeniedError("cap", "cap"));
    const controller = startConfiguredTriggers(f.deps);
    try {
      f.emit();
      await vi.advanceTimersByTimeAsync(30_000);
      expect(f.spawn.mock.calls.every(([request]) => request.prompt === "anchor")).toBe(true);
      expect([...readPendingSpawnWork(f.dataDir).values()][0]?.nextBlockIndex).toBe(0);
    } finally {
      await controller.stop();
    }
  });

  it("stops an old controller before its in-flight birth can start the next block", async () => {
    const f = fixture([{ prompt: "first" }, { prompt: "second" }]);
    let finish!: (session: { id: string; status: string }) => void;
    f.spawn.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const controller = startConfiguredTriggers(f.deps);
    f.emit();
    await vi.advanceTimersByTimeAsync(0);
    const stopping = controller.stop();
    finish({ id: "test-1", status: "running" });
    await stopping;
    expect(f.spawn).toHaveBeenCalledTimes(1);
    expect([...readPendingSpawnWork(f.dataDir).values()][0]?.nextBlockIndex).toBe(0);
    // The service owns adoption across the uncheckpointed birth window.
    const accepted = new Map([
      [f.spawn.mock.calls[0]?.[1].triggerBirthKey, { id: "test-1", status: "running" }],
    ]);
    let births = 1;
    f.spawn.mockImplementation(async (_request, options) => {
      const existing = accepted.get(options.triggerBirthKey);
      if (existing) return existing;
      births += 1;
      return { id: "test-2", status: "running" };
    });
    const replacement = startConfiguredTriggers(f.deps);
    try {
      await vi.advanceTimersByTimeAsync(0);
      expect(births).toBe(2);
      expect(readPendingSpawnWork(f.dataDir).size).toBe(0);
    } finally {
      await replacement.stop();
    }
  });
  it.each(["cap", "memory_guard"] as const)(
    "retries %s without another event, beyond delivery failure budget",
    async (reason) => {
      const f = fixture();
      f.spawn.mockRejectedValue(new SessionAdmissionDeniedError("held", reason));
      const controller = startConfiguredTriggers(f.deps);
      try {
        f.emit();
        f.emit();
        await vi.advanceTimersByTimeAsync(3_000_000);
        expect(readPendingSpawnWork(f.dataDir).size).toBe(1);
        expect(f.spawn.mock.calls.length).toBeGreaterThan(8);
        f.spawn.mockResolvedValue({ id: "test-1", status: "running" });
        await vi.advanceTimersByTimeAsync(650_000);
        expect(readPendingSpawnWork(f.dataDir).size).toBe(0);
        expect(f.spawn.mock.results.filter((result) => result.type === "return")).not.toHaveLength(
          0,
        );
        const attempts = f.spawn.mock.calls.length;
        await vi.advanceTimersByTimeAsync(650_000);
        expect(f.spawn).toHaveBeenCalledTimes(attempts);
      } finally {
        await controller.stop();
      }
    },
  );

  it("reloads disk pending tail and preserves successful desk anchor", async () => {
    const f = fixture([{ prompt: "anchor" }, { prompt: "sibling" }]);
    Object.assign(f.config.projects.test.triggers.review, { spawnDeskGroup: true });
    f.spawn
      .mockResolvedValueOnce({ id: "test-1", status: "running" })
      .mockRejectedValue(new SessionAdmissionDeniedError("cap", "cap"));
    let controller = startConfiguredTriggers(f.deps);
    f.emit();
    await vi.advanceTimersByTimeAsync(0);
    const pending = [...readPendingSpawnWork(f.dataDir).values()][0];
    if (!pending) throw new Error("Missing pending spawn");
    expect(pending.nextBlockIndex).toBe(1);
    expect(pending.anchorSessionId).toBe("test-1");
    expect(
      JSON.parse(readFileSync(join(f.dataDir, "pending-spawn-work.json"), "utf8")),
    ).toHaveLength(1);
    await controller.stop();
    f.spawn.mockResolvedValue({ id: "test-2", status: "running" });
    controller = startConfiguredTriggers(f.deps);
    try {
      await vi.advanceTimersByTimeAsync(15_000);
      expect(f.spawn).toHaveBeenCalledTimes(3);
      expect(f.spawn.mock.calls[2]?.[0]).toMatchObject({
        prompt: "sibling",
        reuseWorkspaceSessionId: "test-1",
      });
      expect(f.spawn.mock.calls[2]?.[1]).toEqual({ triggerBirthKey: pending.blocks[1]?.birthKey });
      expect(readPendingSpawnWork(f.dataDir).size).toBe(0);
    } finally {
      await controller.stop();
    }
  });

  it("adopts a retained birth after failure instead of queueing another birth", async () => {
    const f = fixture();
    f.spawn.mockRejectedValue(new Error("post-birth checkpoint failed"));
    f.birth.mockReturnValue({ id: "test-1", status: "stopped" });
    f.get.mockResolvedValue({ id: "test-1", status: "stopped" });
    const controller = startConfiguredTriggers(f.deps);
    try {
      f.emit();
      await vi.advanceTimersByTimeAsync(100_000);
      expect(f.spawn).toHaveBeenCalledTimes(1);
      expect(readPendingSpawnWork(f.dataDir).size).toBe(0);
    } finally {
      await controller.stop();
    }
  });

  it("does not retry permanent errors or malformed disk work", async () => {
    const f = fixture();
    writeFileSync(
      join(f.dataDir, "pending-spawn-work.json"),
      JSON.stringify([{ workId: "untrusted" }]),
    );
    f.spawn.mockRejectedValue(new Error("invalid model"));
    const controller = startConfiguredTriggers(f.deps);
    try {
      f.emit();
      await vi.advanceTimersByTimeAsync(1_000_000);
      expect(f.spawn).toHaveBeenCalledTimes(1);
      expect(readPendingSpawnWork(f.dataDir).size).toBe(0);
    } finally {
      await controller.stop();
    }
  });

  it.each(["trigger", "source", "removed"])(
    "drops %s route changes and fences conditional disk checkpoints",
    async (change) => {
      const f = fixture();
      f.spawn.mockRejectedValue(new SessionAdmissionDeniedError("cap", "cap"));
      let controller = startConfiguredTriggers(f.deps);
      f.emit();
      await vi.advanceTimersByTimeAsync(0);
      await controller.stop();
      const work = [...readPendingSpawnWork(f.dataDir).values()][0];
      if (!work) throw new Error("Missing pending spawn");
      expect(
        writePendingSpawnWork(
          f.dataDir,
          { ...work, revision: work.revision + 1 },
          work.revision + 7,
        ),
      ).toBe(false);
      if (change === "trigger")
        f.config.projects.test.triggers.review.spawn.blocks = [{ prompt: "changed" }];
      else if (change === "source") f.config.projects.test.sources.tick.type = "webhook";
      else
        delete (f.config.projects.test.triggers as Partial<typeof f.config.projects.test.triggers>)
          .review;
      controller = startConfiguredTriggers(f.deps);
      try {
        await vi.advanceTimersByTimeAsync(15_000);
        expect(f.spawn).toHaveBeenCalledTimes(1);
        expect(readPendingSpawnWork(f.dataDir).size).toBe(0);
      } finally {
        await controller.stop();
      }
    },
  );
});
