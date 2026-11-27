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
  readClaudeJsonlStateMock,
  TEST_DATA_DIR,
  sessionServiceInternals,
  sessionMetadataModule,
  logSpurEventMock,
  enrichedIds as harnessEnrichedIds,
  probeWorkspaceMock,
} from "../helpers/session-service-harness.js";
import { appendFileSync, readFileSync, readdirSync, rmSync } from "node:fs";
import type * as Fs from "node:fs";
import { join, sep } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SessionTransitions } from "../../src/session-transitions.js";
import type * as Metadata from "../../src/metadata.js";
import type * as Config from "../../src/config.js";
import type { SessionService } from "../../src/session-service.js";
import type {
  AppConfig,
  SessionRecord,
  SessionState,
  SessionTransitionsQuery,
} from "../../src/types.js";

let metadata: typeof Metadata;
let service: SessionService;
let config: AppConfig;
const task = { label: "task", url: "https://example.com/task/1" };
// Captured before the harness installs fake timers, which also fake hrtime.
const realClock = process.hrtime.bigint;

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof Fs>();
  return { ...actual, appendFileSync: vi.fn(actual.appendFileSync) };
});

function failJournalAppends(dataDir = TEST_DATA_DIR): () => void {
  const append = vi.mocked(appendFileSync);
  const original = append.getMockImplementation();
  if (!original) throw new Error("Missing append implementation");
  append.mockImplementation((path, data, options) => {
    if (
      String(path).startsWith(join(dataDir, "session-transitions") + sep) &&
      String(path).endsWith(".jsonl")
    ) {
      throw new Error("journal append unavailable");
    }
    original(path, data, options);
  });
  return () => {
    append.mockImplementation(original);
  };
}

function evidence(state: "working" | "waiting", reset?: string, limited = reset !== undefined) {
  mockClaudeSessionStatus(state, state === "working" ? "running" : "idle");
  readClaudeJsonlStateMock.mockResolvedValue({
    state,
    reader: { filePath: "test.jsonl", lastOffset: 0, lastMtimeMs: Date.now(), tailRecords: [] },
    rateLimit: {
      limited,
      reason: "test provider limit",
      ...(reset ? { resetAtMs: Date.parse(reset) } : {}),
    },
  });
}
function record(overrides: Partial<SessionRecord> = {}) {
  return runningSession({ worktree: false, slots: { links: [task] }, ...overrides });
}
const poll = (query: SessionTransitionsQuery = {}) => service.listSessionTransitions(query);
const binding = () =>
  (
    service as unknown as {
      transitionsBinding: { store: { observedState(id: string): SessionState | undefined } };
    }
  ).transitionsBinding;
const enrichedIds = () => harnessEnrichedIds(service);

beforeEach(async () => {
  await resetSessionServiceHarness(() => []);
  const { parseConfigText } = await vi.importActual<typeof Config>("../../src/config.js");
  const { tags: _tags, ...rawConfig } = baseConfig();
  config = parseConfigText("/tmp/spur.yaml", JSON.stringify(rawConfig));
  const module = await loadSessionServiceModule();
  metadata = sessionMetadataModule();
  readSessionMock.mockImplementation(metadata.readSession);
  writeSessionMock.mockImplementation(metadata.writeSession);
  listSessionsMock.mockImplementation(metadata.listSessions);
  service = new module.SessionService("/tmp/spur.yaml", undefined, { deferBackgroundLoops: true });
  evidence("working");
});
afterEach(async () => {
  vi.mocked(appendFileSync).mockRestore();
  await disposeSessionServiceHarness();
});

describe("session transitions service", () => {
  it.each(["get", "list", "dashboard"] as const)(
    "retains a transient limit reversal admitted by ordinary %s before append recovery",
    async (read) => {
      metadata.writeSession(TEST_DATA_DIR, record());
      await service.get("api-1");
      const cursor = (await poll()).nextCursor;
      const readCurrent = () =>
        read === "get"
          ? service.get("api-1")
          : read === "list"
            ? service
                .list({ includeCompleted: true })
                .then((views) => views.find((view) => view.id === "api-1"))
            : sessionServiceInternals(service).enrichDashboard(record());
      const restore = failJournalAppends();
      evidence("working", "2026-03-18T11:00:00.000Z");
      const enteredAt = new Date().toISOString();
      expect(await readCurrent()).toMatchObject({ state: "rate_limited" });
      vi.setSystemTime(new Date(Date.now() + 1000));
      evidence("working");
      const exitedAt = new Date().toISOString();
      expect(await readCurrent()).toMatchObject({ state: "working" });
      expect(metadata.readSession(TEST_DATA_DIR, "api-1")).not.toHaveProperty("rateLimitedAt");
      expect(metadata.readSession(TEST_DATA_DIR, "api-1")).not.toHaveProperty("rateLimitResetAt");
      await expect(poll({ since: cursor })).rejects.toThrow("journal append unavailable");
      restore();
      const page = await poll({ since: cursor });
      expect(page.entries).toEqual([
        expect.objectContaining({
          kind: "state",
          from: "working",
          to: "rate_limited",
          at: enteredAt,
          rateLimitResetAt: "2026-03-18T11:00:00.000Z",
          links: [task],
        }),
        expect.objectContaining({
          kind: "state",
          from: "rate_limited",
          to: "working",
          at: exitedAt,
          links: [task],
        }),
      ]);
      expect(page.entries[1]).not.toHaveProperty("rateLimitResetAt");
      expect(await poll({ since: page.nextCursor })).toEqual({
        entries: [],
        nextCursor: page.nextCursor,
        hasMore: false,
      });
    },
  );

  it("drains an admitted backlog without runtime, account or session reads", async () => {
    metadata.writeSession(TEST_DATA_DIR, record());
    const cursor = (await poll()).nextCursor;
    const restore = failJournalAppends();
    evidence("working", "2026-03-18T11:00:00.000Z");
    await service.get("api-1");
    const runtime = vi.spyOn(sessionServiceInternals(service), "readRuntimeSnapshot");
    const accounts = vi.spyOn(
      service as unknown as { computeClaudeAccountsView(): unknown },
      "computeClaudeAccountsView",
    );
    listSessionsMock.mockClear();
    readSessionMock.mockClear();
    await expect(poll({ since: cursor })).rejects.toThrow("journal append unavailable");
    expect(runtime).not.toHaveBeenCalled();
    expect(accounts).not.toHaveBeenCalled();
    expect(listSessionsMock).not.toHaveBeenCalled();
    expect(readSessionMock).not.toHaveBeenCalled();
    restore();
    expect((await poll({ since: cursor })).entries).toContainEqual(
      expect.objectContaining({ to: "rate_limited" }),
    );
  });

  it("retains stopped-to-running status reversal from ordinary reconciliation before append recovery", async () => {
    metadata.writeSession(TEST_DATA_DIR, record());
    const cursor = (await poll()).nextCursor;
    const restore = failJournalAppends();
    const snapshots = vi.spyOn(sessionServiceInternals(service), "readRuntimeSnapshot");
    snapshots.mockResolvedValue({
      runtimeAlive: false,
      paneUsable: false,
      processAlive: false,
      probeUnresponsive: false,
    });
    expect(await service.get("api-1")).toMatchObject({ status: "stopped" });
    snapshots.mockResolvedValue({
      runtimeAlive: true,
      paneUsable: true,
      processAlive: true,
      probeUnresponsive: false,
    });
    expect(await service.get("api-1")).toMatchObject({ status: "running" });
    restore();
    const page = await poll({ since: cursor });
    expect(
      page.entries
        .filter((entry) => entry.kind === "status")
        .map((entry) => [entry.from, entry.to]),
    ).toEqual([
      ["running", "stopped"],
      ["stopped", "running"],
    ]);
  });

  it("keeps an older queued status edge ahead of a state edge from a later ordinary read", async () => {
    metadata.writeSession(TEST_DATA_DIR, record());
    metadata.writeSession(TEST_DATA_DIR, record({ id: "other" }));
    await service.get("api-1");
    const cursor = (await poll()).nextCursor;
    const restore = failJournalAppends();
    expect(() =>
      metadata.writeSession(
        TEST_DATA_DIR,
        record({ id: "other", status: "stopped", stopReason: "manual_pause" }),
      ),
    ).toThrow("journal append unavailable");
    evidence("working", "2026-03-18T11:00:00.000Z");
    expect(await service.get("api-1")).toMatchObject({ state: "rate_limited" });
    await expect(poll({ since: cursor })).rejects.toThrow("journal append unavailable");
    restore();
    const recovered = (await poll({ since: cursor })).entries;
    const otherAt = recovered.findIndex(
      (entry) => entry.sessionId === "other" && entry.kind === "status" && entry.to === "stopped",
    );
    const limitedAt = recovered.findIndex(
      (entry) => entry.sessionId === "api-1" && entry.to === "rate_limited",
    );
    expect(otherAt).toBeGreaterThanOrEqual(0);
    expect(limitedAt).toBeGreaterThan(otherAt);
  });

  it.each(["same", "different", "disposed"] as const)(
    "keeps pending observations scoped to the original binding on %s lifecycle change",
    async (change) => {
      metadata.writeSession(TEST_DATA_DIR, record());
      const cursor = (await poll()).nextCursor;
      const originalBinding = (service as unknown as { transitionsBinding: object })
        .transitionsBinding;
      const restore = failJournalAppends();
      evidence("working", "2026-03-18T11:00:00.000Z");
      await service.get("api-1");
      evidence("working");
      await service.get("api-1");
      if (change === "same") {
        service.applyConfig(config, []);
        expect((service as unknown as { transitionsBinding: object }).transitionsBinding).toBe(
          originalBinding,
        );
        restore();
        expect((await poll({ since: cursor })).entries.map((entry) => entry.to)).toEqual([
          "rate_limited",
          "working",
        ]);
      } else if (change === "different") {
        const nextDir = join(TEST_DATA_DIR, "new-binding");
        metadata.writeSession(
          nextDir,
          record({ slots: { links: [{ label: "task", url: "https://example.com/new-binding" }] } }),
        );
        service.applyConfig({ ...config, dataDir: nextDir }, []);
        restore();
        const page = await poll();
        expect(page.entries.some((entry) => entry.to === "rate_limited")).toBe(false);
        expect(
          page.entries.every((entry) => entry.links[0]?.url === "https://example.com/new-binding"),
        ).toBe(true);
        expect(page.nextCursor.split(".")[0]).not.toBe(cursor.split(".")[0]);
      } else {
        service.dispose();
        restore();
        const module = await loadSessionServiceModule();
        service = new module.SessionService("/tmp/spur.yaml", undefined, {
          deferBackgroundLoops: true,
        });
        expect((await poll({ since: cursor })).entries).toEqual([]);
      }
    },
  );

  it("runs no session enrichment across transitions polls", async () => {
    for (const id of ["run-1", "run-2", "run-3"])
      metadata.writeSession(TEST_DATA_DIR, record({ id }));
    for (const id of ["stop-1", "stop-2", "stop-3"])
      metadata.writeSession(TEST_DATA_DIR, record({ id, status: "stopped" }));
    metadata.writeSession(TEST_DATA_DIR, record({ id: "done", status: "completed" }));
    metadata.writeSession(TEST_DATA_DIR, record({ id: "gone", status: "killed" }));
    const enrich = enrichedIds();
    listSessionsMock.mockClear();
    let cursor: string | undefined;
    for (let run = 0; run < 5; run += 1) {
      const page = await poll(cursor ? { since: cursor } : {});
      cursor = page.nextCursor;
    }
    expect(enrich.ids).toEqual([]);
    expect(listSessionsMock).not.toHaveBeenCalled();
  });

  it("publishes killed and completed state edges from the record write without enrichment", async () => {
    metadata.writeSession(TEST_DATA_DIR, record({ id: "gone" }));
    metadata.writeSession(TEST_DATA_DIR, record({ id: "done" }));
    const cursor = (await poll()).nextCursor;
    const enrich = enrichedIds();
    metadata.writeSession(TEST_DATA_DIR, record({ id: "gone", status: "killed" }));
    metadata.writeSession(TEST_DATA_DIR, record({ id: "done", status: "completed" }));
    const page = await poll({ since: cursor, kinds: ["state"] });
    expect(page.entries.map((entry) => [entry.sessionId, entry.to])).toEqual([
      ["gone", "killed"],
      ["done", "stopped"],
    ]);
    expect(enrich.ids).toEqual([]);
  });

  it("publishes state edges for records that ended while the daemon was down on boot", async () => {
    metadata.writeSession(TEST_DATA_DIR, record());
    await service.get("api-1");
    const cursor = (await poll()).nextCursor;
    service.dispose();
    metadata.writeSession(TEST_DATA_DIR, record({ status: "killed" }));
    const module = await loadSessionServiceModule();
    service = new module.SessionService("/tmp/spur.yaml", undefined, {
      deferBackgroundLoops: true,
    });
    const enrich = enrichedIds();
    const page = await poll({ since: cursor });
    expect(page.entries.map((entry) => [entry.kind, entry.from, entry.to])).toEqual([
      ["status", "running", "killed"],
      ["state", "working", "killed"],
    ]);
    expect(enrich.ids).toEqual([]);
  });

  it("derives hook state with the classifier rule for errored, stale-parked and paused records", async () => {
    const enrich = enrichedIds();
    const cases = [
      ["err", { status: "errored", error: "provider failed" }, "error"],
      ["parked", { status: "stopped", stopReason: "stale_timeout" }, "stale"],
      ["paused", { status: "stopped", stopReason: "manual_pause" }, "stopped"],
    ] as const;
    for (const [id, overrides, state] of cases) {
      metadata.writeSession(TEST_DATA_DIR, record({ id, ...overrides }));
      expect(binding().store.observedState(id)).toBe(state);
    }
    expect(enrich.ids).toEqual([]);
    const entries = (await poll({ kinds: ["state"] })).entries.length;
    for (const [id] of cases) await service.get(id);
    expect((await poll({ kinds: ["state"], limit: 1000 })).entries).toHaveLength(entries);
  });

  it("keeps a transitions poll under 2 s with 500 records and 50 live, including the first poll after restart", async () => {
    for (let index = 0; index < 450; index += 1)
      metadata.writeSession(
        TEST_DATA_DIR,
        record({ id: `done-${index}`, status: index % 3 === 0 ? "killed" : "completed" }),
      );
    for (let index = 0; index < 50; index += 1)
      metadata.writeSession(TEST_DATA_DIR, record({ id: `live-${index}` }));
    const timed = async () => {
      const startedAt = realClock();
      await poll({ limit: 1 });
      return Number(realClock() - startedAt) / 1e6;
    };
    let enrich = enrichedIds();
    listSessionsMock.mockClear();
    const samples = [await timed(), await timed(), await timed()].sort((a, b) => a - b);
    const median = samples[1] as number;
    expect(enrich.ids).toEqual([]);
    expect(listSessionsMock).not.toHaveBeenCalled();
    enrich.restore();
    service.dispose();
    const module = await loadSessionServiceModule();
    service = new module.SessionService("/tmp/spur.yaml", undefined, {
      deferBackgroundLoops: true,
    });
    enrich = enrichedIds();
    listSessionsMock.mockClear();
    const afterRestart = await timed();
    console.info(
      `transitions poll median ${median.toFixed(1)} ms, first after restart ${afterRestart.toFixed(1)} ms`,
    );
    expect(enrich.ids).toEqual([]);
    expect(listSessionsMock).not.toHaveBeenCalled();
    expect(median).toBeLessThan(2000);
    expect(afterRestart).toBeLessThan(2000);
  }, 120_000);

  it("fires a killed state subscription and logs the transition from an out-of-band record write", async () => {
    metadata.writeSession(TEST_DATA_DIR, record());
    metadata.writeSession(TEST_DATA_DIR, record({ id: "subscriber" }));
    await service.get("api-1");
    const subscriber = await service.get("subscriber");
    const sent = vi.spyOn(service, "send").mockResolvedValue(subscriber);
    service.subscribeToSessionStates("subscriber", {
      targetSessionId: "api-1",
      states: ["killed"],
    });
    const enrich = enrichedIds();
    metadata.writeSession(TEST_DATA_DIR, record({ status: "killed" }));
    await vi.waitFor(() =>
      expect(sent).toHaveBeenCalledWith(
        "subscriber",
        expect.objectContaining({ message: expect.stringContaining("api-1") }),
      ),
    );
    expect(
      logSpurEventMock.mock.calls.filter(
        ([, entry]) =>
          entry.event === "session.state.transition" &&
          entry.sessionId === "api-1" &&
          entry.details.toState === "killed",
      ),
    ).toHaveLength(1);
    expect(enrich.ids).toEqual([]);
  });

  it("observes a structured reset on the first read and projects identical GET/full-list/dashboard markers", async () => {
    metadata.writeSession(TEST_DATA_DIR, record());
    const reset = "2026-03-18T11:00:00.000Z";
    evidence("working", reset);
    await service.get("api-1");
    const page = await poll();
    expect(page.entries.find((entry) => entry.kind === "state")).toMatchObject({
      to: "rate_limited",
      rateLimitResetAt: reset,
      links: [task],
    });
    expect(await service.get("api-1")).toMatchObject({
      state: "rate_limited",
      rateLimitResetAt: reset,
    });
    expect((await service.list({ includeCompleted: true }))[0]).toMatchObject({
      rateLimitResetAt: reset,
    });
    const dashboard = await sessionServiceInternals(service).enrichDashboard(
      metadata.readSession(TEST_DATA_DIR, "api-1")!,
    );
    expect(dashboard).toMatchObject({ rateLimitResetAt: reset });
    expect((await poll({ since: page.nextCursor })).entries).toEqual([]);
  });

  it("retains unknown-to-known same-state refinements and clears an obsolete reset on renewed unknown evidence", async () => {
    metadata.writeSession(TEST_DATA_DIR, record());
    evidence("working", undefined, true);
    await service.get("api-1");
    let page = await poll();
    expect(page.entries.find((entry) => entry.to === "rate_limited")).not.toHaveProperty(
      "rateLimitResetAt",
    );
    evidence("working", "2026-03-18T10:06:00.000Z");
    await service.get("api-1");
    page = await poll({ since: page.nextCursor });
    expect(page.entries).toHaveLength(1);
    expect(page.entries[0]).toMatchObject({
      from: "rate_limited",
      to: "rate_limited",
      rateLimitResetAt: "2026-03-18T10:06:00.000Z",
    });
    evidence("working", undefined, true);
    await service.get("api-1");
    expect((await poll({ since: page.nextCursor })).entries).toEqual([]);
    vi.setSystemTime(new Date("2026-03-18T10:06:01.000Z"));
    await service.get("api-1");
    const expired = await poll({ since: page.nextCursor });
    expect(expired.entries[0]).toMatchObject({ from: "rate_limited", to: "rate_limited" });
    expect(expired.entries[0]).not.toHaveProperty("rateLimitResetAt");
    expect(metadata.readSession(TEST_DATA_DIR, "api-1")).not.toHaveProperty("rateLimitResetAt");
  });

  it("retains rapid rate-limit relapse without advancing the four-second clock, including pagination and restart", async () => {
    metadata.writeSession(TEST_DATA_DIR, record());
    evidence("working", "2026-03-18T11:00:00.000Z");
    await service.get("api-1");
    const first = await poll();
    evidence("working");
    await service.get("api-1");
    const exited = await poll({ since: first.nextCursor });
    expect(exited.entries[0]).toMatchObject({ from: "rate_limited", to: "working" });
    expect(metadata.readSession(TEST_DATA_DIR, "api-1")).not.toHaveProperty("rateLimitedAt");
    expect(metadata.readSession(TEST_DATA_DIR, "api-1")).not.toHaveProperty("rateLimitResetAt");
    evidence("working", "2026-03-18T12:00:00.000Z");
    await service.get("api-1");
    const relapse = await poll({ since: exited.nextCursor });
    expect(relapse.entries[0]).toMatchObject({
      from: "working",
      to: "rate_limited",
      rateLimitResetAt: "2026-03-18T12:00:00.000Z",
    });
    service.dispose();
    const module = await loadSessionServiceModule();
    service = new module.SessionService("/tmp/spur.yaml", undefined, {
      deferBackgroundLoops: true,
    });
    const pages = await poll({ kinds: ["state"], limit: 1 });
    expect(pages.entries[0]?.to).toBe("rate_limited");
    const next = await poll({ kinds: ["state"], limit: 1, since: pages.nextCursor });
    expect(next.entries[0]?.to).toBe("working");
    const last = await poll({ kinds: ["state"], since: next.nextCursor });
    expect(last.entries.map((entry) => entry.to)).toEqual(["rate_limited"]);
    expect((await poll({ since: relapse.nextCursor })).entries).toEqual([]);
  });

  it("preserves shared working/waiting chatter hold but exits attention immediately", () => {
    const internals = service as unknown as {
      stabilizeState(id: string, state: SessionState): SessionState;
    };
    expect(internals.stabilizeState("chatter", "working")).toBe("working");
    expect(internals.stabilizeState("chatter", "waiting")).toBe("working");
    for (const state of ["rate_limited", "stale", "error", "needs_input"] as const) {
      expect(internals.stabilizeState(state, state)).toBe(state);
      expect(internals.stabilizeState(state, "working")).toBe("working");
    }
  });

  it("publishes completion before a later cleanup failure and retains historical links after source deletion", async () => {
    metadata.writeSession(TEST_DATA_DIR, record());
    await service.get("api-1");
    await poll();
    const internals = service as unknown as {
      cleanupTerminalTelegram(record: SessionRecord): Promise<void>;
    };
    vi.spyOn(internals, "cleanupTerminalTelegram").mockRejectedValueOnce(
      new Error("cleanup failed"),
    );
    await expect(
      service.complete("api-1", { skipPrCheck: true, skipRuntimeTeardown: true }),
    ).rejects.toThrow("cleanup failed");
    expect(metadata.readSession(TEST_DATA_DIR, "api-1")?.status).toBe("completed");
    rmSync(join(TEST_DATA_DIR, "sessions", "api", "api-1.json"));
    const page = await poll({ links: [task] });
    expect(
      page.entries.find((entry) => entry.kind === "status" && entry.to === "completed"),
    ).toMatchObject({ links: [task] });
  });

  it("captures authoritative killed, errored, parked and resumed statuses without diagnostic producers", async () => {
    const initial = record();
    metadata.writeSession(TEST_DATA_DIR, initial);
    for (const update of [
      { status: "errored", error: "provider failed" },
      { status: "stopped", stopReason: "stale_timeout" },
      { status: "running" },
      { status: "killed" },
    ] as const)
      metadata.writeSession(TEST_DATA_DIR, { ...initial, ...update });
    const page = await poll();
    expect(
      page.entries.filter((entry) => entry.kind === "status").map((entry) => entry.to),
    ).toEqual(["running", "errored", "stopped", "running", "killed"]);
    expect(page.entries.find((entry) => entry.to === "stopped")).toMatchObject({
      stopReason: "stale_timeout",
    });
  });

  it("snapshots S5 shared-workspace links and keeps captured terminal links after owner edits", async () => {
    const owner = record({ id: "owner", workspaceId: "owner" });
    const { slots: _slots, ...member } = record({ id: "member", workspaceId: "owner" });
    metadata.writeSession(TEST_DATA_DIR, owner);
    metadata.writeSession(TEST_DATA_DIR, member);
    const first = await poll({ links: [task] });
    expect(
      first.entries.filter((entry) => entry.kind === "status").map((entry) => entry.sessionId),
    ).toEqual(["owner", "member"]);
    metadata.writeSession(TEST_DATA_DIR, {
      ...member,
      status: "completed",
      terminalSlotsCaptured: true,
      slots: { links: [task] },
    });
    metadata.writeSession(TEST_DATA_DIR, {
      ...owner,
      slots: { links: [{ label: "task", url: "https://example.com/task/changed" }] },
    });
    const page = await poll({ since: first.nextCursor, links: [task] });
    expect(page.entries.find((entry) => entry.to === "completed")).toMatchObject({
      sessionId: "member",
      links: [task],
    });
    expect((await service.get("member")).slots?.links).toEqual([task]);
  });

  it("keeps the required edge after a detector or marker failure in an ordinary read", async () => {
    metadata.writeSession(TEST_DATA_DIR, record());
    await service.get("api-1");
    const cursor = (await poll()).nextCursor;
    evidence("working", "2026-03-18T11:00:00.000Z");
    writeSessionMock.mockImplementationOnce(() => {
      throw new Error("marker failed");
    });
    await expect(service.get("api-1")).rejects.toThrow("marker failed");
    expect(await service.get("api-1")).toMatchObject({ state: "rate_limited" });
    expect(
      (await poll({ since: cursor, kinds: ["state"] })).entries.map((entry) => entry.to),
    ).toEqual(["rate_limited"]);
  });

  it("commits a status edge and fires its subscription when a journal append fails", async () => {
    metadata.writeSession(TEST_DATA_DIR, record());
    metadata.writeSession(TEST_DATA_DIR, record({ id: "subscriber" }));
    await service.get("api-1");
    const cursor = (await poll()).nextCursor;
    const subscriber = await service.get("subscriber");
    const sent = vi.spyOn(service, "send").mockResolvedValue(subscriber);
    service.subscribeToSessionStates("subscriber", {
      targetSessionId: "api-1",
      states: ["killed"],
    });
    const restore = failJournalAppends();
    expect(() => metadata.writeSession(TEST_DATA_DIR, record({ status: "killed" }))).toThrow(
      "journal append unavailable",
    );
    expect(metadata.readSession(TEST_DATA_DIR, "api-1")?.status).toBe("killed");
    await vi.waitFor(() => expect(sent).toHaveBeenCalledTimes(1));
    expect(sent).toHaveBeenCalledWith(
      "subscriber",
      expect.objectContaining({ message: expect.stringContaining("api-1") }),
    );
    expect(
      logSpurEventMock.mock.calls.filter(
        ([, entry]) =>
          entry.event === "session.state.transition" &&
          entry.sessionId === "api-1" &&
          entry.details.toState === "killed",
      ),
    ).toHaveLength(1);
    restore();
    expect((await poll({ since: cursor })).entries.map((entry) => [entry.kind, entry.to])).toEqual([
      ["status", "killed"],
      ["state", "killed"],
    ]);
  });

  it("rebinds dataDir before recovery writes, preserves stream identity on same-dir reload and unregisters on dispose", async () => {
    metadata.writeSession(TEST_DATA_DIR, record());
    const first = await poll();
    const journalDir = join(TEST_DATA_DIR, "session-transitions");
    const before = readdirSync(journalDir).map((file) => [
      file,
      readFileSync(join(journalDir, file), "utf8"),
    ]);
    const secondDir = join(TEST_DATA_DIR, "second");
    const otherLink = { label: "task", url: "https://example.com/task/2" };
    metadata.writeSession(secondDir, record({ slots: { links: [otherLink] } }));
    const nextConfig = { ...config, dataDir: secondDir };
    service.applyConfig(nextConfig, []);
    const second = await poll();
    expect(second.nextCursor.split(".")[0]).not.toBe(first.nextCursor.split(".")[0]);
    expect(second.entries.every((entry) => entry.links[0]?.url === otherLink.url)).toBe(true);
    expect(
      readdirSync(journalDir).map((file) => [file, readFileSync(join(journalDir, file), "utf8")]),
    ).toEqual(before);
    service.applyConfig(nextConfig, []);
    expect((await poll()).nextCursor).toBe(second.nextCursor);
    metadata.writeSession(secondDir, record({ status: "killed", slots: { links: [otherLink] } }));
    expect(
      (await poll({ since: second.nextCursor })).entries.filter((entry) => entry.kind === "status"),
    ).toHaveLength(1);
    service.dispose();
    const checkpoint = readFileSync(
      join(secondDir, "session-transitions", "checkpoint.json"),
      "utf8",
    );
    metadata.writeSession(secondDir, record());
    expect(readFileSync(join(secondDir, "session-transitions", "checkpoint.json"), "utf8")).toBe(
      checkpoint,
    );
  });

  it.each([
    ["get", "append", "journal append unavailable"],
    ["get", "checkpoint", "journal checkpoint failed"],
    ["list", "append", "journal append unavailable"],
    ["list", "checkpoint", "journal checkpoint failed"],
    ["dashboard", "append", "journal append unavailable"],
    ["dashboard", "checkpoint", "journal checkpoint failed"],
  ] as const)(
    "keeps %s and subscriptions available on %s journal failure while polls fail and retry",
    async (read, failure, expected) => {
      metadata.writeSession(TEST_DATA_DIR, record());
      metadata.writeSession(TEST_DATA_DIR, record({ id: "subscriber" }));
      await service.get("api-1");
      const cursor = (await poll()).nextCursor;
      const subscriber = await service.get("subscriber");
      const sent = vi.spyOn(service, "send").mockResolvedValue(subscriber);
      service.subscribeToSessionStates("subscriber", {
        targetSessionId: "api-1",
        states: ["rate_limited"],
      });
      let restore: () => void;
      if (failure === "append") restore = failJournalAppends();
      else {
        const store = (
          service as unknown as { transitionsBinding: { store: { saveCheckpoint(): void } } }
        ).transitionsBinding.store;
        const fault = vi.spyOn(store, "saveCheckpoint").mockImplementation(() => {
          throw new Error(expected);
        });
        restore = () => fault.mockRestore();
      }
      evidence("working", "2026-03-18T11:00:00.000Z");
      const view =
        read === "get"
          ? await service.get("api-1")
          : read === "list"
            ? (await service.list({ includeCompleted: true })).find((entry) => entry.id === "api-1")
            : await sessionServiceInternals(service).enrichDashboard(record());
      expect(view).toMatchObject({
        state: "rate_limited",
        rateLimitResetAt: "2026-03-18T11:00:00.000Z",
      });
      for (let tick = 0; tick < 10; tick += 1) await Promise.resolve();
      expect(sent).toHaveBeenCalledWith(
        "subscriber",
        expect.objectContaining({ message: expect.stringContaining("api-1") }),
      );
      await expect(poll({ since: cursor })).rejects.toThrow(expected);
      restore();
      const recovered = await poll({ since: cursor });
      expect(recovered.entries.filter((entry) => entry.sessionId === "api-1")).toEqual([
        expect.objectContaining({ kind: "state", from: "working", to: "rate_limited" }),
      ]);
      expect(sent).toHaveBeenCalledTimes(1);
    },
  );

  it("keeps ordinary runtime reconciliation available when its status journal append fails", async () => {
    metadata.writeSession(TEST_DATA_DIR, record());
    await poll();
    const store = (
      service as unknown as {
        transitionsBinding: {
          store: {
            observeStatus(record: SessionRecord, links: unknown[]): void;
          };
        };
      }
    ).transitionsBinding.store;
    vi.spyOn(store, "observeStatus").mockImplementation(() => {
      throw new Error("status append failed");
    });
    vi.spyOn(sessionServiceInternals(service), "readRuntimeSnapshot").mockResolvedValue({
      runtimeAlive: false,
      paneUsable: false,
      processAlive: false,
      probeUnresponsive: false,
    });
    expect(await service.get("api-1")).toMatchObject({ status: "stopped", state: "stopped" });
  });

  it("does not swallow an ordinary session marker persistence failure", async () => {
    metadata.writeSession(TEST_DATA_DIR, record());
    await poll();
    evidence("working", "2026-03-18T11:00:00.000Z");
    writeSessionMock.mockImplementationOnce(() => {
      throw new Error("session write failed");
    });
    await expect(service.get("api-1")).rejects.toThrow("session write failed");
  });

  it("keeps subscriber-triggered native send actions strict outside the read observation boundary", async () => {
    metadata.writeSession(TEST_DATA_DIR, record());
    metadata.writeSession(TEST_DATA_DIR, record({ id: "subscriber", status: "stopped" }));
    await service.get("api-1");
    service.subscribeToSessionStates("subscriber", {
      targetSessionId: "api-1",
      states: ["rate_limited"],
    });
    const store = (
      service as unknown as {
        transitionsBinding: {
          store: {
            observeStatus(record: SessionRecord, links: { label: string; url: string }[]): void;
          };
        };
      }
    ).transitionsBinding.store;
    const observe = store.observeStatus.bind(store);
    let failedWrites = 0;
    vi.spyOn(store, "observeStatus").mockImplementation((record, links) => {
      if (record.id === "subscriber" && record.status === "running") {
        failedWrites += 1;
        throw new Error("action journal unavailable");
      }
      observe(record, links);
    });
    const nativeSend = service.send.bind(service);
    const dispatched: ReturnType<typeof nativeSend>[] = [];
    vi.spyOn(service, "send").mockImplementation((...args) => {
      const pending = nativeSend(...args);
      dispatched.push(pending);
      return pending;
    });
    evidence("working", "2026-03-18T11:00:00.000Z");
    expect(await service.get("api-1")).toMatchObject({ state: "rate_limited" });
    expect(dispatched).toHaveLength(1);
    const [pending] = dispatched;
    if (!pending) throw new Error("Missing subscriber send");
    const outcome = await pending.then(
      () => "resolved",
      (error: unknown) => (error instanceof Error ? error.message : String(error)),
    );
    expect(failedWrites).toBeGreaterThan(0);
    const subscriber = metadata.readSession(TEST_DATA_DIR, "subscriber");
    expect(subscriber?.status).toBe("running");
    if (!subscriber) throw new Error("Missing subscriber");
    metadata.writeSession(TEST_DATA_DIR, { ...subscriber, status: "stopped" });
    await expect(nativeSend("subscriber", { message: "direct strict control" })).rejects.toThrow(
      "action journal unavailable",
    );
    expect(outcome).toBe("action journal unavailable");
  });

  it("accepts an empty but healthy runtime snapshot as an authoritative stopped state", async () => {
    metadata.writeSession(TEST_DATA_DIR, record());
    vi.spyOn(sessionServiceInternals(service), "readRuntimeSnapshot").mockResolvedValue({
      runtimeAlive: false,
      paneUsable: false,
      processAlive: false,
      probeUnresponsive: false,
    });
    await service.get("api-1");
    expect((await poll()).entries).toContainEqual(
      expect.objectContaining({ kind: "status", to: "stopped" }),
    );
  });

  it("logs and dispatches one state transition when a stopped record with stale rate-limit markers is enriched", async () => {
    metadata.writeSession(TEST_DATA_DIR, record());
    metadata.writeSession(TEST_DATA_DIR, record({ id: "subscriber" }));
    await service.get("api-1");
    const subscriber = await service.get("subscriber");
    const sent = vi.spyOn(service, "send").mockResolvedValue(subscriber);
    service.subscribeToSessionStates("subscriber", {
      targetSessionId: "api-1",
      states: ["stopped"],
    });
    const transitions = () =>
      logSpurEventMock.mock.calls.filter(
        ([, entry]) => entry.event === "session.state.transition" && entry.sessionId === "api-1",
      );
    metadata.writeSession(
      TEST_DATA_DIR,
      record({
        status: "stopped",
        rateLimitedAt: "2026-03-18T09:00:00.000Z",
        rateLimitResetAt: "2026-03-18T09:30:00.000Z",
      }),
    );
    await vi.waitFor(() => expect(sent).toHaveBeenCalledTimes(1));
    vi.spyOn(sessionServiceInternals(service), "readRuntimeSnapshot").mockResolvedValue({
      runtimeAlive: false,
      paneUsable: false,
      processAlive: false,
      probeUnresponsive: false,
    });
    await service.get("api-1");
    expect(metadata.readSession(TEST_DATA_DIR, "api-1")).not.toHaveProperty("rateLimitedAt");
    await vi.waitFor(() => expect(transitions()).toHaveLength(1));
    for (let tick = 0; tick < 10; tick += 1) await Promise.resolve();
    expect(sent).toHaveBeenCalledTimes(1);
    expect(transitions()).toHaveLength(1);
    expect(transitions()[0]?.[1].details).toMatchObject({
      fromState: "working",
      toState: "stopped",
    });
    const history = (
      service as unknown as { stateHistory: Map<string, { state: SessionState }[]> }
    ).stateHistory.get("api-1");
    expect(history?.map((entry) => entry.state)).toEqual(["working", "stopped"]);
  });

  it("publishes a running session's state edge from the background tick with no reads", async () => {
    metadata.writeSession(TEST_DATA_DIR, record());
    const reads = [
      vi.spyOn(service, "list"),
      vi.spyOn(service, "get"),
      vi.spyOn(service, "listSessionTransitions"),
    ];
    sessionServiceInternals(service).startDashboardCacheLoop();
    await vi.advanceTimersByTimeAsync(2000);
    await service.settleBackgroundSpawns();
    expect(binding().store.observedState("api-1")).toBe("working");
    evidence("working", "2026-03-18T11:00:00.000Z");
    await vi.advanceTimersByTimeAsync(2000);
    await service.settleBackgroundSpawns();
    expect(binding().store.observedState("api-1")).toBe("rate_limited");
    for (const read of reads) expect(read).not.toHaveBeenCalled();
  });

  const journalLines = () => {
    const dir = join(TEST_DATA_DIR, "session-transitions");
    return readdirSync(dir)
      .filter((file) => file.endsWith(".jsonl"))
      .reduce((total, file) => total + readFileSync(join(dir, file), "utf8").split("\n").length, 0);
  };
  const restart = async () => {
    service.dispose();
    const module = await loadSessionServiceModule();
    service = new module.SessionService("/tmp/spur.yaml", undefined, {
      deferBackgroundLoops: true,
    });
  };

  it("appends no transitions entry on a restart with unchanged records", async () => {
    const statuses = ["running", "stopped", "completed", "killed"] as const;
    for (const status of statuses)
      metadata.writeSession(TEST_DATA_DIR, record({ id: `s-${status}`, status }));
    for (const status of statuses) await service.get(`s-${status}`);
    const before = journalLines();
    await restart();
    for (const status of statuses) await service.get(`s-${status}`);
    await service.list({ includeCompleted: true });
    await sessionServiceInternals(service).runDashboardCacheTick();
    expect(journalLines()).toBe(before);
  });

  it("yields exactly one terminal edge for a session killed before restart", async () => {
    metadata.writeSession(TEST_DATA_DIR, record());
    await service.get("api-1");
    metadata.writeSession(TEST_DATA_DIR, record({ status: "killed" }));
    const cursor = (await poll()).nextCursor;
    await restart();
    await service.get("api-1");
    await service.list({ includeCompleted: true });
    await sessionServiceInternals(service).runDashboardCacheTick();
    const all = (await poll({ limit: 1000 })).entries.filter(
      (entry) => entry.sessionId === "api-1",
    );
    expect(all.filter((entry) => entry.kind === "status" && entry.to === "killed")).toHaveLength(1);
    expect(all.filter((entry) => entry.kind === "state" && entry.to === "killed")).toHaveLength(1);
    expect((await poll({ since: cursor })).entries).toEqual([]);
  });

  it("keeps an observed error on a metadata-only write of a killed record with an unchanged diagnostic", async () => {
    metadata.writeSession(TEST_DATA_DIR, record({ status: "killed", retainInList: true }));
    metadata.writeSession(TEST_DATA_DIR, record({ id: "subscriber" }));
    probeWorkspaceMock.mockReturnValue({
      exists: false,
      missing: false,
      diagnostic: "workspace stat failed: EACCES",
    });
    await service.list({ includeCompleted: true });
    expect(binding().store.observedState("api-1")).toBe("error");
    const subscriber = await service.get("subscriber");
    const sent = vi.spyOn(service, "send").mockResolvedValue(subscriber);
    service.subscribeToSessionStates("subscriber", {
      targetSessionId: "api-1",
      states: ["killed"],
    });
    const before = journalLines();
    metadata.writeSession(
      TEST_DATA_DIR,
      record({ status: "killed", retainInList: true, updatedAt: "2026-03-18T10:04:00.000Z" }),
    );
    for (let tick = 0; tick < 20; tick += 1) await Promise.resolve();
    expect(journalLines()).toBe(before);
    expect(binding().store.observedState("api-1")).toBe("error");
    expect(sent).not.toHaveBeenCalled();
  });

  it("repairs a state left behind a committed status at boot", async () => {
    metadata.writeSession(TEST_DATA_DIR, record());
    await service.get("api-1");
    const cursor = (await poll()).nextCursor;
    vi.spyOn(
      binding().store as unknown as { observeState(): void },
      "observeState",
    ).mockImplementationOnce(() => {
      throw new Error("state append lost");
    });
    expect(() => metadata.writeSession(TEST_DATA_DIR, record({ status: "killed" }))).toThrow(
      "state append lost",
    );
    expect(binding().store.observedState("api-1")).toBe("working");
    await restart();
    expect(
      (await poll({ since: cursor, kinds: ["state"] })).entries.map((entry) => entry.to),
    ).toEqual(["killed"]);
  });

  it("replays no state edge on restart for a completed record with a persistent workspace stat failure", async () => {
    metadata.writeSession(TEST_DATA_DIR, record({ status: "completed" }));
    probeWorkspaceMock.mockReturnValue({
      exists: false,
      missing: false,
      diagnostic: "workspace stat failed: EACCES",
    });
    await service.list({ includeCompleted: true });
    expect(binding().store.observedState("api-1")).toBe("error");
    const before = journalLines();
    const cursor = (await poll()).nextCursor;
    await restart();
    expect(journalLines()).toBe(before);
    expect((await poll({ since: cursor })).entries).toEqual([]);
    await sessionServiceInternals(service).repairBootKeptErrors();
    await service.list({ includeCompleted: true });
    expect((await poll({ since: cursor })).entries).toEqual([]);
  });

  it("publishes the recovery edge when a pause clears a stored error under a new diagnostic", async () => {
    metadata.writeSession(
      TEST_DATA_DIR,
      record({ status: "stopped", stopReason: "manual_pause", error: "agent failed" }),
    );
    expect(binding().store.observedState("api-1")).toBe("error");
    const cursor = (await poll()).nextCursor;
    probeWorkspaceMock.mockReturnValue({
      exists: false,
      missing: false,
      diagnostic: "workspace stat failed: EACCES",
    });
    await service.pause("api-1");
    expect(
      (await poll({ since: cursor, kinds: ["state"] })).entries.map((entry) => entry.to),
    ).toContain("stopped");
  });

  it("does not repair an old store's record after the data directory is rebound", async () => {
    const diagnostic = { exists: false, missing: false, diagnostic: "workspace stat failed" };
    metadata.writeSession(TEST_DATA_DIR, record({ status: "killed", retainInList: true }));
    probeWorkspaceMock.mockReturnValue(diagnostic);
    await service.list({ includeCompleted: true });
    metadata.writeSession(TEST_DATA_DIR, record({ status: "killed" }));
    probeWorkspaceMock.mockReturnValue({ exists: true, missing: false });
    await restart();
    const nextDir = join(TEST_DATA_DIR, "next");
    metadata.writeSession(nextDir, record({ status: "stopped", stopReason: "manual_pause" }));
    const internals = service as unknown as {
      enrichWithClassified(record: SessionRecord, ...rest: unknown[]): Promise<unknown>;
    };
    const original = internals.enrichWithClassified.bind(internals);
    let release: () => void = () => {};
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    vi.spyOn(internals, "enrichWithClassified").mockImplementation(async (...args) => {
      await held;
      return original(args[0], ...args.slice(1));
    });
    const repair = sessionServiceInternals(service).repairBootKeptErrors();
    service.applyConfig({ ...config, dataDir: nextDir }, []);
    release();
    await repair;
    expect(binding().store.observedState("api-1")).toBe("stopped");
    expect((await poll({ kinds: ["state"] })).entries.map((entry) => entry.to)).toEqual([
      "stopped",
    ]);
  });

  it("runs the boot repair for the new store after a data-directory rebind", async () => {
    const nextDir = join(TEST_DATA_DIR, "next");
    const killed = record({ status: "killed" });
    metadata.writeSession(nextDir, killed);
    // The new store's checkpoint holds `error` for an ended row with no diagnostic.
    const prior = new SessionTransitions(nextDir);
    prior.observeStatus(killed, []);
    prior.observeState(killed, "error", []);
    (service as unknown as { backgroundLoopsStarted: boolean }).backgroundLoopsStarted = true;
    service.applyConfig({ ...config, dataDir: nextDir }, []);
    expect(binding().store.observedState("api-1")).toBe("error");
    await service.settleBackgroundSpawns();
    expect(binding().store.observedState("api-1")).toBe("killed");
  });

  it("keeps a boot repair running across a same-directory reload", async () => {
    metadata.writeSession(TEST_DATA_DIR, record({ status: "killed" }));
    probeWorkspaceMock.mockReturnValue({
      exists: false,
      missing: false,
      diagnostic: "workspace stat failed",
    });
    await service.get("api-1");
    await restart();
    probeWorkspaceMock.mockReturnValue({ exists: true, missing: false });
    const cursor = (await poll()).nextCursor;
    const internals = service as unknown as {
      sidecarViews(...args: unknown[]): Promise<unknown>;
    };
    const original = internals.sidecarViews.bind(internals);
    let release: () => void = () => {};
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    vi.spyOn(internals, "sidecarViews").mockImplementationOnce(async (...args) => {
      await held;
      return original(...args);
    });
    const repair = sessionServiceInternals(service).repairBootKeptErrors();
    await vi.waitFor(() => expect(internals.sidecarViews).toHaveBeenCalled());
    service.applyConfig(config, []);
    release();
    await repair;
    expect(
      (await poll({ since: cursor, kinds: ["state"] })).entries.map((entry) => entry.to),
    ).toEqual(["killed"]);
  });

  it("drops a repair when the state went error, killed, error again while it waited", async () => {
    metadata.writeSession(TEST_DATA_DIR, record({ status: "killed" }));
    const diagnostic = { exists: false, missing: false, diagnostic: "workspace stat failed" };
    probeWorkspaceMock.mockReturnValue(diagnostic);
    await service.get("api-1");
    expect(binding().store.observedState("api-1")).toBe("error");
    await restart();
    const cursor = (await poll()).nextCursor;
    probeWorkspaceMock.mockReturnValue({ exists: true, missing: false });
    const internals = service as unknown as {
      sidecarViews(...args: unknown[]): Promise<unknown>;
    };
    const original = internals.sidecarViews.bind(internals);
    let release: () => void = () => {};
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    vi.spyOn(internals, "sidecarViews").mockImplementationOnce(async (...args) => {
      await held;
      return original(...args);
    });
    const repair = sessionServiceInternals(service).repairBootKeptErrors();
    await vi.waitFor(() => expect(internals.sidecarViews).toHaveBeenCalled());
    await service.get("api-1");
    expect(binding().store.observedState("api-1")).toBe("killed");
    probeWorkspaceMock.mockReturnValue(diagnostic);
    await service.get("api-1");
    expect(binding().store.observedState("api-1")).toBe("error");
    release();
    await repair;
    expect(binding().store.observedState("api-1")).toBe("error");
    expect(
      (await poll({ since: cursor, kinds: ["state"] })).entries.map((entry) => entry.to),
    ).toEqual(["killed", "error"]);
  });

  it("drops a repair whose observed error was already replaced by a list", async () => {
    metadata.writeSession(TEST_DATA_DIR, record({ status: "completed" }));
    probeWorkspaceMock.mockReturnValue({
      exists: false,
      missing: false,
      diagnostic: "workspace stat failed",
    });
    await service.list({ includeCompleted: true });
    expect(binding().store.observedState("api-1")).toBe("error");
    await restart();
    const cursor = (await poll()).nextCursor;
    const internals = service as unknown as {
      sidecarViews(...args: unknown[]): Promise<unknown>;
    };
    const original = internals.sidecarViews.bind(internals);
    let release: () => void = () => {};
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    vi.spyOn(internals, "sidecarViews").mockImplementationOnce(async (...args) => {
      await held;
      return original(...args);
    });
    const repair = sessionServiceInternals(service).repairBootKeptErrors();
    await vi.waitFor(() => expect(internals.sidecarViews).toHaveBeenCalled());
    probeWorkspaceMock.mockReturnValue({ exists: true, missing: false });
    await service.list({ includeCompleted: true });
    expect(binding().store.observedState("api-1")).toBe("stopped");
    release();
    await repair;
    expect(binding().store.observedState("api-1")).toBe("stopped");
    expect(
      (await poll({ since: cursor, kinds: ["state"] })).entries.map((entry) => entry.to),
    ).toEqual(["stopped"]);
  });

  it("repairs a boot-kept error on a killed record once the diagnostic is gone", async () => {
    metadata.writeSession(TEST_DATA_DIR, record({ status: "killed", retainInList: true }));
    probeWorkspaceMock.mockReturnValue({
      exists: false,
      missing: false,
      diagnostic: "workspace stat failed: EACCES",
    });
    await service.list({ includeCompleted: true });
    expect(binding().store.observedState("api-1")).toBe("error");
    // Hidden ended row: no list or sweep revisits it.
    metadata.writeSession(TEST_DATA_DIR, record({ status: "killed" }));
    probeWorkspaceMock.mockReturnValue({ exists: true, missing: false });
    const cursor = (await poll()).nextCursor;
    await restart();
    expect(binding().store.observedState("api-1")).toBe("error");
    await sessionServiceInternals(service).repairBootKeptErrors();
    expect(binding().store.observedState("api-1")).toBe("killed");
    expect(
      (await poll({ since: cursor, kinds: ["state"] })).entries.map((entry) => entry.to),
    ).toEqual(["killed"]);
  });

  it("classifies the latest record when a queued snapshot predates a kill", async () => {
    metadata.writeSession(TEST_DATA_DIR, record({ status: "stopped", stopReason: "manual_pause" }));
    await service.get("api-1");
    const cursor = (await poll()).nextCursor;
    // The list snapshots its records, then waits on the accounts read before its
    // jobs run; the kill lands in that gap.
    const internals = service as unknown as {
      computeClaudeAccountsView(): Promise<unknown>;
    };
    const original = internals.computeClaudeAccountsView.bind(internals);
    let release: () => void = () => {};
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    vi.spyOn(internals, "computeClaudeAccountsView").mockImplementationOnce(async () => {
      await held;
      return original();
    });
    const listing = service.list({ includeCompleted: true });
    await vi.waitFor(() => expect(internals.computeClaudeAccountsView).toHaveBeenCalled());
    metadata.writeSession(TEST_DATA_DIR, record({ status: "killed", retainInList: true }));
    release();
    await listing;
    expect(
      (await poll({ since: cursor, kinds: ["state"] })).entries.map((entry) => entry.to),
    ).toEqual(["killed"]);
  });

  it("leaves the status epoch alone on a field-only write right after boot", async () => {
    metadata.writeSession(TEST_DATA_DIR, record());
    await restart();
    const epochs = (service as unknown as { statusEpochs: Map<string, number> }).statusEpochs;
    const before = epochs.get("api-1") ?? 0;
    metadata.writeSession(
      TEST_DATA_DIR,
      record({ updatedAt: "2026-03-18T10:04:00.000Z", agentSessionId: "a-1" }),
    );
    expect(epochs.get("api-1") ?? 0).toBe(before);
  });

  it("prunes seeded last written statuses of removed sessions", async () => {
    metadata.writeSession(TEST_DATA_DIR, record());
    metadata.writeSession(TEST_DATA_DIR, record({ id: "gone", status: "completed" }));
    await restart();
    const internals = service as unknown as {
      lastWrittenStatuses: Map<string, string>;
      pruneFullViewCache(listedIds: ReadonlySet<string>): void;
    };
    expect([...internals.lastWrittenStatuses.keys()].sort()).toEqual(["api-1", "gone"]);
    internals.pruneFullViewCache(new Set(["api-1"]));
    expect([...internals.lastWrittenStatuses.keys()]).toEqual(["api-1"]);
  });

  it("counts a status change after a failed journal append", async () => {
    metadata.writeSession(TEST_DATA_DIR, record());
    const epochs = (service as unknown as { statusEpochs: Map<string, number> }).statusEpochs;
    const before = epochs.get("api-1") ?? 0;
    const restore = failJournalAppends();
    expect(() =>
      metadata.writeSession(
        TEST_DATA_DIR,
        record({ status: "stopped", stopReason: "manual_pause" }),
      ),
    ).toThrow("journal append unavailable");
    restore();
    metadata.writeSession(TEST_DATA_DIR, record());
    expect(epochs.get("api-1")).toBe(before + 2);
  });

  it("publishes no stale state when a pause and resume overlap a rate-limit clear classification", async () => {
    metadata.writeSession(
      TEST_DATA_DIR,
      record({
        rateLimitedAt: "2026-03-18T10:00:00.000Z",
        rateLimitResetAt: "2026-03-18T11:00:00.000Z",
      }),
    );
    const cursor = (await poll()).nextCursor;
    const internals = service as unknown as {
      classifySessionRecord(...args: unknown[]): Promise<unknown>;
    };
    const original = internals.classifySessionRecord.bind(internals);
    let release: () => void = () => {};
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    vi.spyOn(internals, "classifySessionRecord").mockImplementationOnce(async (...args) => {
      const result = await original(...args);
      await held;
      return result;
    });
    const clearing = service.clearRateLimit("api-1", true, "cli");
    await vi.waitFor(() => expect(internals.classifySessionRecord).toHaveBeenCalled());
    metadata.writeSession(TEST_DATA_DIR, record({ status: "stopped", stopReason: "manual_pause" }));
    metadata.writeSession(TEST_DATA_DIR, record());
    release();
    await clearing;
    expect(
      (await poll({ since: cursor, kinds: ["state"] })).entries.map((entry) => entry.to),
    ).toEqual(["stopped"]);
  });

  it("keeps the killed state edge when a rate-limit clear classification outlives a kill", async () => {
    metadata.writeSession(
      TEST_DATA_DIR,
      record({
        rateLimitedAt: "2026-03-18T10:00:00.000Z",
        rateLimitResetAt: "2026-03-18T11:00:00.000Z",
      }),
    );
    const cursor = (await poll()).nextCursor;
    const internals = service as unknown as {
      classifySessionRecord(...args: unknown[]): Promise<unknown>;
    };
    const original = internals.classifySessionRecord.bind(internals);
    let release: () => void = () => {};
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    vi.spyOn(internals, "classifySessionRecord").mockImplementationOnce(async (...args) => {
      const result = await original(...args);
      await held;
      return result;
    });
    const clearing = service.clearRateLimit("api-1", true, "cli");
    await vi.waitFor(() => expect(internals.classifySessionRecord).toHaveBeenCalled());
    metadata.writeSession(TEST_DATA_DIR, record({ status: "killed" }));
    release();
    await clearing;
    expect(
      logSpurEventMock.mock.calls.some(
        ([, entry]) => entry.event === "session.rate_limit.cleared" && entry.sessionId === "api-1",
      ),
    ).toBe(true);
    expect(binding().store.observedState("api-1")).toBe("killed");
    expect(
      (await poll({ since: cursor, kinds: ["state"] })).entries.map((entry) => entry.to),
    ).toEqual(["killed"]);
  });

  it("publishes no stale state when a pause and resume leave the status unchanged during a read", async () => {
    metadata.writeSession(TEST_DATA_DIR, record());
    await service.get("api-1");
    const cursor = (await poll()).nextCursor;
    const internals = service as unknown as {
      sidecarViews(...args: unknown[]): Promise<unknown>;
    };
    const original = internals.sidecarViews.bind(internals);
    let release: () => void = () => {};
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    vi.spyOn(internals, "sidecarViews").mockImplementationOnce(async (...args) => {
      await held;
      return original(...args);
    });
    const stale = service.get("api-1").catch(() => undefined);
    await vi.waitFor(() => expect(internals.sidecarViews).toHaveBeenCalled());
    metadata.writeSession(TEST_DATA_DIR, record({ status: "stopped", stopReason: "manual_pause" }));
    metadata.writeSession(TEST_DATA_DIR, record());
    evidence("working", "2026-03-18T11:00:00.000Z");
    await service.get("api-1");
    expect(binding().store.observedState("api-1")).toBe("rate_limited");
    release();
    await stale;
    expect(binding().store.observedState("api-1")).toBe("rate_limited");
    expect(
      (await poll({ since: cursor, kinds: ["state"] })).entries.map((entry) => entry.to).at(-1),
    ).toBe("rate_limited");
  });

  it("publishes no stale stopped state when a completed row is reopened during a dashboard build", async () => {
    metadata.writeSession(TEST_DATA_DIR, record({ status: "completed" }));
    await service.get("api-1");
    expect(binding().store.observedState("api-1")).toBe("stopped");
    const cursor = (await poll()).nextCursor;
    const internals = service as unknown as {
      sidecarViews(...args: unknown[]): Promise<unknown>;
    };
    const original = internals.sidecarViews.bind(internals);
    let release: () => void = () => {};
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    vi.spyOn(internals, "sidecarViews").mockImplementationOnce(async (...args) => {
      await held;
      return original(...args);
    });
    const pending = sessionServiceInternals(service)
      .enrichDashboard(record({ status: "completed" }))
      .catch(() => undefined);
    await vi.waitFor(() => expect(internals.sidecarViews).toHaveBeenCalled());
    metadata.writeSession(TEST_DATA_DIR, record());
    await service.get("api-1");
    expect(binding().store.observedState("api-1")).toBe("working");
    release();
    await pending;
    expect(binding().store.observedState("api-1")).toBe("working");
    expect(
      (await poll({ since: cursor, kinds: ["state"] })).entries.map((entry) => entry.to),
    ).toEqual(["working"]);
  });

  it("keeps the killed state edge when a dashboard build that started before the kill resumes after it", async () => {
    metadata.writeSession(TEST_DATA_DIR, record());
    await service.get("api-1");
    const cursor = (await poll()).nextCursor;
    const internals = service as unknown as {
      sidecarViews(...args: unknown[]): Promise<unknown>;
    };
    const original = internals.sidecarViews.bind(internals);
    let release: () => void = () => {};
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    vi.spyOn(internals, "sidecarViews").mockImplementationOnce(async (...args) => {
      await held;
      return original(...args);
    });
    const pending = sessionServiceInternals(service)
      .enrichDashboard(record())
      .catch(() => undefined);
    await vi.waitFor(() => expect(internals.sidecarViews).toHaveBeenCalled());
    metadata.writeSession(TEST_DATA_DIR, record({ status: "killed" }));
    release();
    await pending;
    expect(binding().store.observedState("api-1")).toBe("killed");
    const states = (await poll({ since: cursor, kinds: ["state"] })).entries.map(
      (entry) => entry.to,
    );
    expect(states).toEqual(["killed"]);
  });

  it("keeps the killed state edge when a read that started before the kill resumes after it", async () => {
    metadata.writeSession(TEST_DATA_DIR, record());
    await service.get("api-1");
    const cursor = (await poll()).nextCursor;
    const internals = service as unknown as {
      sidecarViews(...args: unknown[]): Promise<unknown>;
    };
    const original = internals.sidecarViews.bind(internals);
    let release: () => void = () => {};
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    vi.spyOn(internals, "sidecarViews").mockImplementationOnce(async (...args) => {
      await held;
      return original(...args);
    });
    evidence("waiting");
    const pending = service.get("api-1").catch(() => undefined);
    await vi.waitFor(() => expect(internals.sidecarViews).toHaveBeenCalled());
    metadata.writeSession(TEST_DATA_DIR, record({ status: "killed" }));
    release();
    await pending;
    expect(binding().store.observedState("api-1")).toBe("killed");
    const states = (await poll({ since: cursor, kinds: ["state"] })).entries.map(
      (entry) => entry.to,
    );
    expect(states.at(-1)).toBe("killed");
  });
});
