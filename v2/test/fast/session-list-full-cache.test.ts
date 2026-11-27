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
    await service.settleBackgroundSpawns();
    expect(enrich.ids.length).toBeGreaterThan(0);
    expect(enrich.ids.length).toBeLessThanOrEqual(8);
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
