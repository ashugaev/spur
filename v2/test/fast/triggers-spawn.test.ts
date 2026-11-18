import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { EventBus } from "../../src/event-bus.js";
import { AutoPingService } from "../../src/auto-ping.js";
import {
  readPendingSpawnWork,
  writePendingSpawnWork,
  recordWorkItemLifecycle,
  readWorkItemLifecycles,
  readPendingSendBatches,
} from "../../src/metadata.js";
import { SessionAdmissionDeniedError } from "../../src/session-service.js";
import { startConfiguredTriggers } from "../../src/triggers.js";
import { loadConfig } from "../../src/config.js";
import { projectTaskStatus } from "../../src/task-status.js";
import type { SessionRecord } from "../../src/types.js";

const dirs: string[] = [];
afterEach(() => {
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

describe("parsed autoClose policy", () => {
  it.each([
    {
      key: "autoComplete",
      configured: true,
      retained: true,
      age: 300000,
      native: "waiting",
      sessionStatus: "running",
      lifecycleState: "running",
      closes: 1,
    },
    {
      key: "autoClose",
      configured: true,
      retained: true,
      age: 300000,
      native: "waiting",
      sessionStatus: "running",
      lifecycleState: "running",
      closes: 1,
    },
    {
      key: "autoClose",
      configured: true,
      retained: true,
      age: 299999,
      native: "waiting",
      sessionStatus: "running",
      lifecycleState: "running",
      closes: 0,
    },
    {
      key: "autoComplete",
      configured: false,
      retained: true,
      age: 300000,
      native: "waiting",
      sessionStatus: "running",
      lifecycleState: "running",
      closes: 0,
    },
    {
      key: "autoClose",
      configured: false,
      retained: true,
      age: 300000,
      native: "waiting",
      sessionStatus: "running",
      lifecycleState: "running",
      closes: 0,
    },
    {
      key: "autoClose",
      configured: undefined,
      retained: true,
      age: 300000,
      native: "waiting",
      sessionStatus: "running",
      lifecycleState: "running",
      closes: 0,
    },
    {
      key: "autoClose",
      configured: true,
      retained: false,
      age: 300000,
      native: "waiting",
      sessionStatus: "running",
      lifecycleState: "running",
      closes: 0,
    },
    {
      key: "autoClose",
      configured: true,
      retained: true,
      age: 300000,
      native: "working",
      sessionStatus: "running",
      lifecycleState: "running",
      closes: 0,
    },
    {
      key: "autoClose",
      configured: true,
      retained: true,
      age: 300000,
      native: "needs_input",
      sessionStatus: "running",
      lifecycleState: "running",
      closes: 0,
    },
    {
      key: "autoClose",
      configured: true,
      retained: true,
      age: 300000,
      native: "rate_limited",
      sessionStatus: "running",
      lifecycleState: "running",
      closes: 0,
    },
    {
      key: "autoClose",
      configured: true,
      retained: true,
      age: 300000,
      native: "waiting",
      sessionStatus: "stopped",
      lifecycleState: "running",
      closes: 0,
    },
    {
      key: "autoClose",
      configured: true,
      retained: true,
      age: 300000,
      native: "waiting",
      sessionStatus: "running",
      lifecycleState: "pending",
      closes: 0,
    },
  ] as const)(
    "applies loaded $key=$configured retained=$retained age=$age native=$native session=$sessionStatus lifecycle=$lifecycleState",
    async ({ key, configured, retained, age, native, sessionStatus, lifecycleState, closes }) => {
      const f = fixture();
      const path = join(f.dataDir, "config.yaml");
      writeFileSync(
        path,
        `dataDir: ${JSON.stringify(f.dataDir)}
projects:
  test:
    path: ${JSON.stringify(f.dataDir)}
    sources:
      issues:
        type: github
        query: "is:issue is:open"
    triggers:
      pickup:
        source: issues
        event: github:work_item.new
        spawn:
          prompt: "Handle {{url}}"
${configured === undefined ? "" : `          ${key}: ${configured}`}
`,
      );
      const config = loadConfig(path);
      recordWorkItemLifecycle(f.dataDir, "test", "issues", {
        externalId: "repo#1",
        url: "https://example.com/1",
        number: 1,
        title: "Task",
        repo: "repo",
        createdAt: new Date(Date.now() - age).toISOString(),
        autoClose: retained,
        ...(lifecycleState === "running"
          ? { state: "running", sessionId: "test-1" }
          : { state: "pending", spawnWorkId: "owned" }),
      });
      let status: SessionRecord["status"] = sessionStatus;
      const complete = vi.fn(async () => {
        status = "completed";
      });
      const get = vi.fn(async () => ({
        id: "test-1",
        status,
        state: projectTaskStatus(
          {
            status,
            agentLaunchId: "launch",
            taskStatusRevision: 0,
            taskStatus: {
              state: "completed",
              revision: 0,
              agentLaunchId: "launch",
              updatedAt: new Date().toISOString(),
            },
          },
          native,
          native,
          true,
          true,
        ),
        runtimeAlive: true,
        workspaceExists: true,
      }));
      const controller = startConfiguredTriggers({
        config,
        bus: f.deps.bus,
        sessionService: { get, complete } as never,
        autoPing: f.deps.autoPing,
        logger: { warn: vi.fn() },
      });
      try {
        await vi.advanceTimersByTimeAsync(0);
        expect(complete).toHaveBeenCalledTimes(closes);
        expect(readWorkItemLifecycles(f.dataDir, "test", "issues").get("repo#1")?.autoClose).toBe(
          retained,
        );
        if (closes) {
          expect(complete).toHaveBeenCalledWith("test-1", { prAction: "leave_open" });
          controller.nudgeSession("test-1");
          await vi.advanceTimersByTimeAsync(60_000);
          expect(complete).toHaveBeenCalledTimes(1);
          expect(readWorkItemLifecycles(f.dataDir, "test", "issues").get("repo#1")?.state).toBe(
            "completed",
          );
        }
      } finally {
        await controller.stop();
      }
    },
  );
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
    f.spawn.mockRejectedValue(new SessionAdmissionDeniedError("cap", "cap"));
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
      const pending = [...readPendingSpawnWork(f.dataDir).values()];
      expect(pending).toHaveLength(1);
      expect(f.spawn).toHaveBeenCalledTimes(1);
      expect(readWorkItemLifecycles(f.dataDir, "test", "tick").get(data.externalId)).toMatchObject({
        state: "pending",
        spawnWorkId: pending[0]?.workId,
      });
      f.spawn.mockResolvedValue({ id: "test-owner", status: "running" });
      await vi.advanceTimersByTimeAsync(15_000);
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
  it("repairs an owned work-item claim after final birth checkpoint survives a crash", async () => {
    const f = fixture();
    f.config.projects.test.triggers.review.event = "github:work_item.new";
    const workId = "completed-work";
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
      autoClose: false,
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
    const controller = startConfiguredTriggers(f.deps);
    try {
      await vi.advanceTimersByTimeAsync(0);
      expect(f.spawn).not.toHaveBeenCalled();
      expect(readWorkItemLifecycles(f.dataDir, "test", "tick").get(data.externalId)).toMatchObject({
        state: "running",
        sessionId: "test-1",
      });
      expect(readPendingSpawnWork(f.dataDir).size).toBe(0);
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
