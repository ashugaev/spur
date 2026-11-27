import {
  resetSessionServiceHarness,
  disposeSessionServiceHarness,
  loadSessionServiceModule,
  readSessionMock,
  writeSessionMock,
  listSessionsMock,
  runningSession,
  baseConfig,
  mockClaudeSessionStatus,
  TEST_DATA_DIR,
  sessionServiceInternals,
  sessionMetadataModule,
  probeWorkspaceMock,
  logSpurEventMock,
  enrichedIds as harnessEnrichedIds,
} from "../helpers/session-service-harness.js";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type * as Metadata from "../../src/metadata.js";
import type * as Config from "../../src/config.js";
import type * as WorkspaceStore from "../../src/workspace-store.js";
import type { SessionService } from "../../src/session-service.js";
import type { AppConfig, SessionRecord, SessionView } from "../../src/types.js";

let metadata: typeof Metadata;
let workspaceStore: typeof WorkspaceStore;
let service: SessionService;
let config: AppConfig;
let serviceModule: Awaited<ReturnType<typeof loadSessionServiceModule>>;
let accounts: { id: string; configDir: string; createdAt: string; authenticated: boolean }[] = [];
// Captured before the harness installs fake timers, which also fake hrtime.
const realClock = process.hrtime.bigint;

function record(overrides: Partial<SessionRecord> = {}) {
  return runningSession({ worktree: false, ...overrides });
}
function stopped(id: string, overrides: Partial<SessionRecord> = {}) {
  return record({ id, status: "stopped", stopReason: "manual_pause", ...overrides });
}
const enrichedIds = (onEnrich?: () => void) => harnessEnrichedIds(service, onEnrich);
function writeFleet(stoppedCount: number, runningCount: number) {
  const runningIds: string[] = [];
  for (let index = 0; index < stoppedCount; index += 1)
    metadata.writeSession(TEST_DATA_DIR, stopped(`idle-${index}`));
  for (let index = 0; index < runningCount; index += 1) {
    runningIds.push(`run-${index}`);
    metadata.writeSession(TEST_DATA_DIR, record({ id: `run-${index}` }));
  }
  return runningIds;
}
async function newService() {
  service = new serviceModule.SessionService("/tmp/spur.yaml", undefined, {
    deferBackgroundLoops: true,
  });
  return service;
}

beforeEach(async () => {
  accounts = [];
  await resetSessionServiceHarness(() => accounts);
  const { parseConfigText } = await vi.importActual<typeof Config>("../../src/config.js");
  workspaceStore = await vi.importActual<typeof WorkspaceStore>("../../src/workspace-store.js");
  const { tags: _tags, ...rawConfig } = baseConfig();
  config = parseConfigText("/tmp/spur.yaml", JSON.stringify(rawConfig));
  serviceModule = await loadSessionServiceModule();
  metadata = sessionMetadataModule();
  readSessionMock.mockImplementation(metadata.readSession);
  writeSessionMock.mockImplementation(metadata.writeSession);
  listSessionsMock.mockImplementation(metadata.listSessions);
  await newService();
  mockClaudeSessionStatus("working", "running");
});
afterEach(async () => {
  await disposeSessionServiceHarness();
});

describe("full-view list cache", () => {
  it("serves unchanged non-running rows from the full-view cache and enriches running rows per request", async () => {
    const runningIds = writeFleet(450, 50);
    const first = await service.list();
    expect(first).toHaveLength(500);
    const enrich = enrichedIds();
    const startedAt = realClock();
    const second = await service.list();
    console.info(
      `full list with 500 records, 50 running: ${(Number(realClock() - startedAt) / 1e6).toFixed(1)} ms`,
    );
    expect(second).toHaveLength(500);
    expect([...enrich.ids].sort()).toEqual([...runningIds].sort());
    expect(second.find((view) => view.id === "idle-7")).toMatchObject({
      status: "stopped",
      state: "stopped",
    });
  }, 120_000);

  it("re-enriches a cached row after its record write or a config reload", async () => {
    const runningIds = writeFleet(3, 2);
    await service.list();
    const enrich = enrichedIds();
    metadata.writeSession(
      TEST_DATA_DIR,
      stopped("idle-0", { updatedAt: "2026-03-18T10:04:00.000Z" }),
    );
    await service.list();
    expect([...enrich.ids].sort()).toEqual(["idle-0", ...runningIds].sort());
    enrich.ids.length = 0;
    service.applyConfig(config, []);
    await service.list();
    expect([...enrich.ids].sort()).toEqual(["idle-0", "idle-1", "idle-2", ...runningIds].sort());
  });

  it("does not serve a view whose enrichment began before a config reload", async () => {
    writeFleet(2, 0);
    const internals = service as unknown as {
      enrichWithClassified(record: SessionRecord, ...rest: unknown[]): Promise<unknown>;
    };
    const original = internals.enrichWithClassified.bind(internals);
    const spy = vi
      .spyOn(internals, "enrichWithClassified")
      .mockImplementation(async (record, ...rest) => {
        const result = await original(record, ...rest);
        if (record.id === "idle-0") service.applyConfig(config, []);
        return result;
      });
    await service.list();
    spy.mockRestore();
    const enrich = enrichedIds();
    await service.list();
    expect(enrich.ids).toContain("idle-0");
  });

  it("prunes cache entries of deleted sessions on the attention sweep", async () => {
    writeFleet(2, 0);
    const internals = sessionServiceInternals(service);
    await service.list();
    expect([...internals.fullViewCache.keys()].sort()).toEqual(["idle-0", "idle-1"]);
    rmSync(join(TEST_DATA_DIR, "sessions", "api", "idle-1.json"));
    await internals.pollAttentionStates(false);
    expect([...internals.fullViewCache.keys()]).toEqual(["idle-0"]);
  });

  it("awaits the startup warm before a full list", async () => {
    writeFleet(2, 1);
    const internals = sessionServiceInternals(service);
    let release: () => void = () => {};
    internals.fullViewCacheReady = new Promise<void>((resolve) => {
      release = resolve;
    });
    const enrich = enrichedIds();
    let settled = false;
    const pending = service.list().then((views) => {
      settled = true;
      return views;
    });
    for (let tick = 0; tick < 20; tick += 1) await Promise.resolve();
    expect(settled).toBe(false);
    expect(enrich.ids).toEqual([]);
    release();
    expect(await pending).toHaveLength(3);
    expect(enrich.ids.length).toBe(3);
  });

  it("keeps listed lastActivityAt monotonic per session across fresh and cached rows", async () => {
    metadata.writeSession(TEST_DATA_DIR, record({ id: "run" }));
    metadata.writeSession(TEST_DATA_DIR, stopped("idle"));
    const internals = sessionServiceInternals(service);
    const original = internals.readRuntimeSnapshot.bind(internals);
    const later = new Date("2026-03-18T10:30:00.000Z");
    let tmuxActivityAt: Date | null = later;
    vi.spyOn(internals, "readRuntimeSnapshot").mockImplementation(async (session, ...rest) => ({
      ...(await original(session, ...rest)),
      tmuxActivityAt,
    }));
    const activity = async (id: string) =>
      ((await service.list()) as SessionView[]).find((view) => view.id === id)?.lastActivityAt;
    expect(await activity("run")).toBe(later.toISOString());
    // The pane died: the fresh max falls back to the record's updatedAt.
    tmuxActivityAt = null;
    expect(await activity("run")).toBe(later.toISOString());
    // A cached row older than an earlier answer reports the earlier one.
    const idleBefore = await activity("idle");
    const raised = new Date(Date.parse(idleBefore ?? "") + 60_000).toISOString();
    internals.listedActivityHighWater.set("idle", raised);
    expect(await activity("idle")).toBe(raised);
  });

  it("keeps the activity floor when a same-directory reload overlaps a list", async () => {
    metadata.writeSession(TEST_DATA_DIR, record({ id: "run" }));
    const internals = sessionServiceInternals(service);
    const original = internals.readRuntimeSnapshot.bind(internals);
    const later = new Date("2026-03-18T10:30:00.000Z");
    let tmuxActivityAt: Date | null = later;
    vi.spyOn(internals, "readRuntimeSnapshot").mockImplementation(async (session, ...rest) => ({
      ...(await original(session, ...rest)),
      tmuxActivityAt,
    }));
    const activity = async () =>
      ((await service.list()) as SessionView[]).find((view) => view.id === "run")?.lastActivityAt;
    expect(await activity()).toBe(later.toISOString());
    tmuxActivityAt = null;
    const enrich = service as unknown as {
      enrichWithClassified(record: SessionRecord, ...rest: unknown[]): Promise<unknown>;
    };
    const enrichOriginal = enrich.enrichWithClassified.bind(enrich);
    vi.spyOn(enrich, "enrichWithClassified").mockImplementationOnce(async (record, ...rest) => {
      const result = await enrichOriginal(record, ...rest);
      service.applyConfig(config, []);
      return result;
    });
    expect(await activity()).toBe(later.toISOString());
  });

  it("serves a queue write made while the startup warm is still running", async () => {
    writeFleet(2, 0);
    await service.list();
    const internals = sessionServiceInternals(service);
    let release: () => void = () => {};
    internals.fullViewCacheReady = new Promise<void>((resolve) => {
      release = resolve;
    });
    const pending = service.list();
    for (let tick = 0; tick < 10; tick += 1) await Promise.resolve();
    metadata.writeSession(
      TEST_DATA_DIR,
      stopped("idle-0", { queuedMessages: { messages: ["ring"] } } as Partial<SessionRecord>),
    );
    release();
    const idle = ((await pending) as SessionView[]).find((view) => view.id === "idle-0");
    expect(idle?.queuedMessages?.messages).toEqual(["ring"]);
  });

  it("runs cache hits and lifecycle rebuilds through the shared gate", async () => {
    writeFleet(20, 0);
    await service.list();
    const internals = service as unknown as {
      requestScopedFields(...args: unknown[]): Promise<unknown>;
    };
    const original = internals.requestScopedFields.bind(internals);
    let active = 0;
    let peak = 0;
    vi.spyOn(internals, "requestScopedFields").mockImplementation(async (...args) => {
      active += 1;
      peak = Math.max(peak, active);
      await Promise.resolve();
      await Promise.resolve();
      try {
        return await original(...args);
      } finally {
        active -= 1;
      }
    });
    await service.list();
    expect(peak).toBeGreaterThan(1);
    expect(peak).toBeLessThanOrEqual(8);
  });

  it("stops queued cache-hit work when the request signal aborts", async () => {
    writeFleet(20, 0);
    await service.list();
    const internals = service as unknown as {
      requestScopedFields(...args: unknown[]): Promise<unknown>;
    };
    const original = internals.requestScopedFields.bind(internals);
    const controller = new AbortController();
    let calls = 0;
    vi.spyOn(internals, "requestScopedFields").mockImplementation(async (...args) => {
      calls += 1;
      controller.abort();
      return original(...args);
    });
    await expect(service.list({ signal: controller.signal })).rejects.toMatchObject({
      name: "AbortError",
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(calls).toBe(1);
  });

  it("rebuilds a completed row whose cache entry expired while it waited for a gate slot", async () => {
    writeFleet(0, 8);
    metadata.writeSession(
      TEST_DATA_DIR,
      record({ id: "zdone", status: "completed", retainInList: true }),
    );
    await service.list();
    const internals = service as unknown as {
      enrichWithClassified(record: SessionRecord, ...rest: unknown[]): Promise<unknown>;
    };
    const original = internals.enrichWithClassified.bind(internals);
    const seen: string[] = [];
    vi.spyOn(internals, "enrichWithClassified").mockImplementation(async (record, ...rest) => {
      seen.push(record.id);
      // Eight running rows hold every slot past the 5 s age limit.
      if (record.id.startsWith("run-")) {
        await new Promise((resolve) =>
          setTimeout(resolve, serviceModule.ATTENTION_POLL_INTERVAL_MS + 1),
        );
      }
      return original(record, ...rest);
    });
    const pending = service.list();
    await vi.advanceTimersByTimeAsync(serviceModule.ATTENTION_POLL_INTERVAL_MS + 1);
    await pending;
    expect(seen).toContain("zdone");
  });

  it("stops queued lifecycle rebuilds inside each callback when the request signal aborts", async () => {
    writeFleet(0, 12);
    const internals = service as unknown as {
      enrichWithClassified(record: SessionRecord, ...rest: unknown[]): Promise<unknown>;
    };
    const { lifecycle } = sessionServiceInternals(service);
    for (let index = 0; index < 12; index += 1)
      lifecycle.settle(
        lifecycle.begin("restore", [`run-${index}`]),
        true,
        () => "succeeded",
        () => true,
      );
    const original = internals.enrichWithClassified.bind(internals);
    const controller = new AbortController();
    let calls = 0;
    vi.spyOn(internals, "enrichWithClassified").mockImplementation(async (record, ...rest) => {
      calls += 1;
      if (calls > 12) controller.abort();
      const result = await original(record, ...rest);
      // First pass: move every row so finalization rebuilds all twelve.
      if (calls <= 12)
        metadata.writeSession(TEST_DATA_DIR, { ...record, updatedAt: "2026-03-18T10:04:00.000Z" });
      return result;
    });
    logSpurEventMock.mockClear();
    await expect(service.list({ signal: controller.signal })).rejects.toMatchObject({
      name: "AbortError",
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(calls).toBe(13);
    expect(
      logSpurEventMock.mock.calls.some(([, entry]) => entry.event === "session.list.enrich_failed"),
    ).toBe(false);
  });

  it("routes lifecycle rebuilds through the shared gate", async () => {
    writeFleet(0, 2);
    const internals = service as unknown as {
      enrichWithClassified(record: SessionRecord, ...rest: unknown[]): Promise<unknown>;
      fullListGate: { run(task: () => Promise<unknown>): Promise<unknown> };
    };
    // A nonzero lifecycle revision lets finalization rebuild a moved row.
    const { lifecycle } = sessionServiceInternals(service);
    for (const id of ["run-0", "run-1"])
      lifecycle.settle(
        lifecycle.begin("restore", [id]),
        true,
        () => "succeeded",
        () => true,
      );
    const original = internals.enrichWithClassified.bind(internals);
    let rewritten = false;
    vi.spyOn(internals, "enrichWithClassified").mockImplementation(async (record, ...rest) => {
      const result = await original(record, ...rest);
      if (!rewritten) {
        rewritten = true;
        metadata.writeSession(TEST_DATA_DIR, { ...record, updatedAt: "2026-03-18T10:04:00.000Z" });
      }
      return result;
    });
    const gate = vi.spyOn(internals.fullListGate, "run");
    await service.list();
    // Two row jobs plus the rebuild of the rewritten row.
    expect(gate.mock.calls.length).toBeGreaterThanOrEqual(3);
  });

  it("drops the listed lastActivityAt high-water mark when the data directory changes", async () => {
    metadata.writeSession(TEST_DATA_DIR, record({ id: "run" }));
    await service.list();
    const internals = sessionServiceInternals(service);
    internals.listedActivityHighWater.set("run", "2026-03-18T12:00:00.000Z");
    const nextDir = join(TEST_DATA_DIR, "next");
    metadata.writeSession(nextDir, record({ id: "run" }));
    service.applyConfig({ ...config, dataDir: nextDir }, []);
    const run = ((await service.list()) as SessionView[]).find((view) => view.id === "run");
    expect(Date.parse(run?.lastActivityAt ?? "")).toBeLessThan(
      Date.parse("2026-03-18T12:00:00.000Z"),
    );
  });

  it("keeps the boot error repair off the warm that every full list awaits", async () => {
    const hidden = record({ id: "hidden", status: "killed" });
    metadata.writeSession(TEST_DATA_DIR, hidden);
    const internals = sessionServiceInternals(service);
    // Observed `error` for an ended, unlisted row, as after a restart.
    const store = (service as unknown as { transitionsBinding: { store: object } })
      .transitionsBinding.store as { observedState(id: string): string | undefined };
    vi.spyOn(store, "observedState").mockImplementation((id) =>
      id === "hidden" ? "error" : undefined,
    );
    const enrich = enrichedIds();
    await internals.warmFullViewCache();
    expect(enrich.ids).toEqual([]);
    await internals.repairBootKeptErrors();
    expect(enrich.ids).toEqual(["hidden"]);
  });

  it("answers a full list while the boot error repair holds enrichments open", async () => {
    for (let index = 0; index < 9; index += 1)
      metadata.writeSession(TEST_DATA_DIR, record({ id: `hidden-${index}`, status: "killed" }));
    writeFleet(1, 0);
    const store = (service as unknown as { transitionsBinding: { store: object } })
      .transitionsBinding.store as { observedState(id: string): string | undefined };
    vi.spyOn(store, "observedState").mockImplementation((id) =>
      id.startsWith("hidden-") ? "error" : undefined,
    );
    const internals = service as unknown as {
      enrichWithClassified(record: SessionRecord, ...rest: unknown[]): Promise<unknown>;
    };
    const original = internals.enrichWithClassified.bind(internals);
    let release: () => void = () => {};
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    vi.spyOn(internals, "enrichWithClassified").mockImplementation(async (record, ...rest) => {
      if (record.id.startsWith("hidden-")) await held;
      return original(record, ...rest);
    });
    const repair = sessionServiceInternals(service).repairBootKeptErrors();
    expect((await service.list()).map((view) => view.id)).toEqual(["idle-0"]);
    release();
    await repair;
  });

  it("leaves no high-water entry from the old store when the data directory is rebound mid-list", async () => {
    metadata.writeSession(TEST_DATA_DIR, record({ id: "run" }));
    const nextDir = join(TEST_DATA_DIR, "next");
    metadata.writeSession(nextDir, record({ id: "run" }));
    const internals = service as unknown as {
      enrichWithClassified(record: SessionRecord, ...rest: unknown[]): Promise<unknown>;
    };
    const original = internals.enrichWithClassified.bind(internals);
    vi.spyOn(internals, "enrichWithClassified").mockImplementationOnce(async (record, ...rest) => {
      const result = await original(record, ...rest);
      service.applyConfig({ ...config, dataDir: nextDir }, []);
      return result;
    });
    await service.list();
    expect(sessionServiceInternals(service).listedActivityHighWater.has("run")).toBe(false);
  });

  it("keeps the startup warm from rejecting when the listing fails", async () => {
    listSessionsMock.mockImplementationOnce(() => {
      throw new Error("listing unavailable");
    });
    await expect(sessionServiceInternals(service).warmFullViewCache()).resolves.toBeUndefined();
    expect(
      logSpurEventMock.mock.calls.some(([, entry]) => entry.event === "session.list.warm_failed"),
    ).toBe(true);
  });

  it("stops queued full-list enrichments when the request signal aborts", async () => {
    for (let index = 0; index < 20; index += 1)
      metadata.writeSession(TEST_DATA_DIR, record({ id: `run-${index}` }));
    const controller = new AbortController();
    const enrich = enrichedIds(() => {
      if (enrich.ids.length === 1) controller.abort();
    });
    await expect(service.list({ signal: controller.signal })).rejects.toMatchObject({
      name: "AbortError",
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(enrich.ids).toHaveLength(1);
    expect(
      logSpurEventMock.mock.calls.some(([, entry]) => entry.event === "session.list.enrich_failed"),
    ).toBe(false);
  });

  it("answers the first full list after restart with running-row enrichments only", async () => {
    const runningIds = writeFleet(450, 50);
    await service.list();
    service.dispose();
    await newService();
    const internals = sessionServiceInternals(service);
    const warmStartedAt = realClock();
    await internals.warmFullViewCache();
    const warmMs = Number(realClock() - warmStartedAt) / 1e6;
    const enrich = enrichedIds();
    const startedAt = realClock();
    const views = await service.list();
    console.info(
      `restart: warm ${warmMs.toFixed(1)} ms, first full list ${(Number(realClock() - startedAt) / 1e6).toFixed(1)} ms`,
    );
    expect(views).toHaveLength(500);
    expect([...enrich.ids].sort()).toEqual([...runningIds].sort());
  }, 120_000);

  it("fills the full-view cache from the attention sweep", async () => {
    const runningIds = writeFleet(20, 3);
    await sessionServiceInternals(service).pollAttentionStates(false);
    const enrich = enrichedIds();
    const views = await service.list();
    expect(views).toHaveLength(23);
    expect([...enrich.ids].sort()).toEqual([...runningIds].sort());
  });

  it("recomputes pr, slots, desk members, accounts and workspace fields on a cached row without enrichment", async () => {
    probeWorkspaceMock.mockImplementation((path: string) => ({
      exists: existsSync(path),
      missing: !existsSync(path),
    }));
    accounts = [
      {
        id: "acct-1",
        configDir: join(TEST_DATA_DIR, "acct-1"),
        createdAt: "2026-03-01T00:00:00.000Z",
        authenticated: true,
      },
    ];
    service.applyConfig(
      { ...config, authRotation: { ...config.authRotation, switchAuth: true } },
      [],
    );
    const worktree = (id: string) => join(TEST_DATA_DIR, "worktrees", id);
    for (const id of ["owner", "sibling", "live"]) mkdirSync(worktree(id), { recursive: true });
    const base = { workspaceId: "owner" } as const;
    metadata.writeSession(
      TEST_DATA_DIR,
      record({
        ...base,
        id: "owner",
        status: "completed",
        terminalSlotsCaptured: true,
        worktreePath: worktree("owner"),
        retainInList: true,
      }),
    );
    const sibling = stopped("sibling", { ...base, worktreePath: worktree("sibling") });
    metadata.writeSession(TEST_DATA_DIR, sibling);
    metadata.writeSession(
      TEST_DATA_DIR,
      record({ ...base, id: "live", worktreePath: worktree("live") }),
    );
    const internals = sessionServiceInternals(service);
    await internals.runDashboardCacheTick();
    const first = ((await service.list()) as SessionView[]).find((view) => view.id === "sibling");
    expect(first).toMatchObject({ workspaceExists: true });
    expect(first?.claudeAccounts?.map((account) => account.id)).toEqual(["acct-1"]);

    const pr = { number: 7, repo: "acme/api", url: "https://github.com/acme/api/pull/7" };
    const link = { label: "pr", url: pr.url };
    workspaceStore.writeWorkspaceState(TEST_DATA_DIR, "owner", { pr, slots: { links: [link] } });
    accounts = [
      ...accounts,
      {
        id: "acct-2",
        configDir: join(TEST_DATA_DIR, "acct-2"),
        createdAt: "2026-03-02T00:00:00.000Z",
        authenticated: true,
      },
    ];
    const liveEntry = internals.dashboardCache.get("live");
    if (!liveEntry) throw new Error("Missing dashboard row for live sibling");
    internals.dashboardCache.set("live", { ...liveEntry, state: "needs_input" });
    rmSync(worktree("sibling"), { recursive: true, force: true });

    const enrich = enrichedIds();
    const second = ((await service.list()) as SessionView[]).find((view) => view.id === "sibling");
    expect(enrich.ids).not.toContain("sibling");
    expect(second?.pr).toEqual(pr);
    expect(second?.slots?.links).toContainEqual(link);
    expect(second?.claudeAccounts?.map((account) => account.id)).toEqual(["acct-1", "acct-2"]);
    expect(second?.deskGroupMembers?.find((member) => member.id === "live")?.state).toBe(
      "needs_input",
    );
    expect(second?.workspaceExists).toBe(false);
    expect(second).not.toHaveProperty("workspaceAccess");
  });

  it("serves a queue write on a cached completed row on the next list", async () => {
    metadata.writeSession(
      TEST_DATA_DIR,
      record({ id: "done", status: "completed", retainInList: true }),
    );
    metadata.writeSession(TEST_DATA_DIR, stopped("idle"));
    await service.list();
    const enrich = enrichedIds();
    metadata.writeSession(
      TEST_DATA_DIR,
      record({
        id: "done",
        status: "completed",
        retainInList: true,
        queuedMessages: { messages: ["ring"] },
      } as Partial<SessionRecord>),
    );
    const done = ((await service.list()) as SessionView[]).find((view) => view.id === "done");
    expect(done?.queuedMessages?.messages).toEqual(["ring"]);
    expect(done?.status).toBe("completed");
    expect(enrich.ids).toEqual(["done"]);
  });

  it("drops a running row whose enrichment throws and never serves or writes a cached entry for it", async () => {
    metadata.writeSession(TEST_DATA_DIR, record({ id: "run" }));
    metadata.writeSession(TEST_DATA_DIR, stopped("idle"));
    const listed = await service.list();
    expect(listed.map((view) => view.id).sort()).toEqual(["idle", "run"]);
    const internals = sessionServiceInternals(service);
    const runRecord = metadata.readSession(TEST_DATA_DIR, "run") as SessionRecord;
    internals.fullViewCache.set("run", { input: runRecord });
    const original = internals.enrichWithClassified.bind(internals);
    const seen: string[] = [];
    const spy = vi
      .spyOn(internals, "enrichWithClassified")
      .mockImplementation((record, ...rest) => {
        seen.push(record.id);
        if (record.id === "run" || record.id === "idle") throw new Error("probe exploded");
        return original(record, ...rest);
      });
    logSpurEventMock.mockClear();
    expect((await service.list()).map((view) => view.id)).toEqual(["idle"]);
    expect(seen).toContain("run");
    expect(
      logSpurEventMock.mock.calls.some(
        ([, entry]) => entry.event === "session.list.enrich_failed" && entry.sessionId === "run",
      ),
    ).toBe(true);

    metadata.writeSession(
      TEST_DATA_DIR,
      stopped("idle", { updatedAt: "2026-03-18T10:04:00.000Z" }),
    );
    const rewritten = metadata.readSession(TEST_DATA_DIR, "idle") as SessionRecord;
    expect((await service.list()).map((view) => view.id)).toEqual([]);
    expect(internals.fullViewCache.get("idle")?.input).not.toBe(rewritten);
    spy.mockRestore();
    const enrich = enrichedIds();
    expect((await service.list()).map((view) => view.id).sort()).toEqual(["idle", "run"]);
    expect(enrich.ids).toContain("idle");
  });

  it("reports a running row's probe failure as an error row", async () => {
    metadata.writeSession(TEST_DATA_DIR, record({ id: "run" }));
    metadata.writeSession(TEST_DATA_DIR, stopped("idle"));
    const internals = sessionServiceInternals(service);
    const original = internals.readRuntimeSnapshot.bind(internals);
    vi.spyOn(internals, "readRuntimeSnapshot").mockImplementation((session, ...rest) => {
      if (session.id === "run") return Promise.reject(new Error("tmux unavailable"));
      return original(session, ...rest);
    });
    const run = (await service.list()).find((view) => view.id === "run");
    expect(run).toMatchObject({ state: "error" });
    expect(run?.error).toMatch(/^Session status detection failed: /);
    expect(internals.fullViewCache.has("run")).toBe(false);
  });

  it("re-enriches a cached completed row once after the cache age limit and not before", async () => {
    metadata.writeSession(
      TEST_DATA_DIR,
      record({ id: "done", status: "completed", retainInList: true }),
    );
    await service.list();
    const enrich = enrichedIds();
    vi.advanceTimersByTime(serviceModule.ATTENTION_POLL_INTERVAL_MS - 1);
    await service.list();
    expect(enrich.ids).toEqual([]);
    vi.advanceTimersByTime(1);
    await service.list();
    await service.list();
    expect(enrich.ids).toEqual(["done"]);
  });
});
