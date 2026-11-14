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
  probeWorkspaceMock,
} from "../helpers/session-service-harness.js";
import { readFileSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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
  await disposeSessionServiceHarness();
});

describe("session transitions service", () => {
  it("observes a structured reset on the first poll and projects identical GET/full-list/dashboard markers", async () => {
    metadata.writeSession(TEST_DATA_DIR, record());
    const reset = "2026-03-18T11:00:00.000Z";
    evidence("working", reset);
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
    let page = await poll();
    expect(page.entries.find((entry) => entry.to === "rate_limited")).not.toHaveProperty(
      "rateLimitResetAt",
    );
    evidence("working", "2026-03-18T10:06:00.000Z");
    page = await poll({ since: page.nextCursor });
    expect(page.entries).toHaveLength(1);
    expect(page.entries[0]).toMatchObject({
      from: "rate_limited",
      to: "rate_limited",
      rateLimitResetAt: "2026-03-18T10:06:00.000Z",
    });
    evidence("working", undefined, true);
    expect((await poll({ since: page.nextCursor })).entries).toEqual([]);
    vi.setSystemTime(new Date("2026-03-18T10:06:01.000Z"));
    const expired = await poll({ since: page.nextCursor });
    expect(expired.entries[0]).toMatchObject({ from: "rate_limited", to: "rate_limited" });
    expect(expired.entries[0]).not.toHaveProperty("rateLimitResetAt");
    expect(metadata.readSession(TEST_DATA_DIR, "api-1")).not.toHaveProperty("rateLimitResetAt");
  });

  it("retains rapid rate-limit relapse without advancing the four-second clock, including pagination and restart", async () => {
    metadata.writeSession(TEST_DATA_DIR, record());
    evidence("working", "2026-03-18T11:00:00.000Z");
    const first = await poll();
    evidence("working");
    const exited = await poll({ since: first.nextCursor });
    expect(exited.entries[0]).toMatchObject({ from: "rate_limited", to: "working" });
    expect(metadata.readSession(TEST_DATA_DIR, "api-1")).not.toHaveProperty("rateLimitedAt");
    expect(metadata.readSession(TEST_DATA_DIR, "api-1")).not.toHaveProperty("rateLimitResetAt");
    evidence("working", "2026-03-18T12:00:00.000Z");
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

  it("fails strict polls on a thrown detector or marker write and retries without losing the required edge", async () => {
    metadata.writeSession(TEST_DATA_DIR, record());
    const cursor = (await poll()).nextCursor;
    vi.spyOn(sessionServiceInternals(service), "readRuntimeSnapshot").mockRejectedValueOnce(
      new Error("probe failed"),
    );
    await expect(poll({ since: cursor })).rejects.toThrow("probe failed");
    evidence("working", "2026-03-18T11:00:00.000Z");
    writeSessionMock.mockImplementationOnce(() => {
      throw new Error("marker failed");
    });
    await expect(poll({ since: cursor })).rejects.toThrow("marker failed");
    expect((await poll({ since: cursor })).entries).toHaveLength(1);
  });

  it("reconciles a committed status after journal failure before acknowledging a successful poll", async () => {
    metadata.writeSession(TEST_DATA_DIR, record());
    const cursor = (await poll()).nextCursor;
    const binding = (
      service as unknown as {
        transitionsBinding: {
          store: { observeStatus(record: SessionRecord, links: unknown[]): void };
        };
      }
    ).transitionsBinding;
    vi.spyOn(binding.store, "observeStatus").mockImplementationOnce(() => {
      throw new Error("journal failed");
    });
    expect(() => metadata.writeSession(TEST_DATA_DIR, record({ status: "killed" }))).toThrow(
      "journal failed",
    );
    expect(metadata.readSession(TEST_DATA_DIR, "api-1")?.status).toBe("killed");
    expect(
      (await poll({ since: cursor })).entries.find((entry) => entry.kind === "status"),
    ).toMatchObject({ to: "killed" });
  });

  it("fails a poll on journal state append failure and retries with the persisted reset intact", async () => {
    metadata.writeSession(TEST_DATA_DIR, record());
    const cursor = (await poll()).nextCursor;
    const binding = (
      service as unknown as {
        transitionsBinding: {
          store: {
            observeState(record: SessionRecord, state: SessionState, links: unknown[]): void;
          };
        };
      }
    ).transitionsBinding;
    vi.spyOn(binding.store, "observeState").mockImplementationOnce(() => {
      throw new Error("append failed");
    });
    evidence("working", "2026-03-18T11:00:00.000Z");
    await expect(poll({ since: cursor })).rejects.toThrow("append failed");
    expect((await poll({ since: cursor })).entries).toEqual([
      expect.objectContaining({
        kind: "state",
        to: "rate_limited",
        rateLimitResetAt: "2026-03-18T11:00:00.000Z",
      }),
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

  it("rejects a strict refresh held across dataDir reload without publishing old snapshots to the new stream", async () => {
    metadata.writeSession(TEST_DATA_DIR, record());
    const internals = sessionServiceInternals(service);
    let release: (() => void) | undefined;
    const waiting = new Promise<void>((resolve) => {
      release = resolve;
    });
    const original = internals.readRuntimeSnapshot.bind(internals);
    vi.spyOn(internals, "readRuntimeSnapshot").mockImplementationOnce(async (record) => {
      await waiting;
      return original(record);
    });
    const pending = poll();
    const nextDir = join(TEST_DATA_DIR, "next");
    service.applyConfig({ ...config, dataDir: nextDir }, []);
    release?.();
    await expect(pending).rejects.toThrow("data directory changed");
    expect((await poll()).entries).toEqual([]);
    expect(metadata.listSessions(nextDir)).toEqual([]);
  });

  it.each([
    ["get", "append"],
    ["get", "checkpoint"],
    ["list", "append"],
    ["list", "checkpoint"],
    ["dashboard", "append"],
    ["dashboard", "checkpoint"],
  ] as const)(
    "keeps %s and subscriptions available on %s journal failure while strict polls fail and retry",
    async (read, failure) => {
      metadata.writeSession(TEST_DATA_DIR, record());
      metadata.writeSession(TEST_DATA_DIR, record({ id: "subscriber" }));
      const cursor = (await poll()).nextCursor;
      const subscriber = await service.get("subscriber");
      const sent = vi.spyOn(service, "send").mockResolvedValue(subscriber);
      service.subscribeToSessionStates("subscriber", {
        targetSessionId: "api-1",
        states: ["rate_limited"],
      });
      const store = (
        service as unknown as {
          transitionsBinding: {
            store: {
              observeState(record: SessionRecord, state: SessionState, links: unknown[]): void;
              saveCheckpoint(): void;
            };
          };
        }
      ).transitionsBinding.store;
      const fault =
        failure === "append" ? vi.spyOn(store, "observeState") : vi.spyOn(store, "saveCheckpoint");
      fault.mockImplementation(() => {
        throw new Error(`journal ${failure} failed`);
      });
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
      await expect(poll({ since: cursor })).rejects.toThrow(`journal ${failure} failed`);
      fault.mockRestore();
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

  it.each(["runtime", "workspace"] as const)(
    "rejects structured %s diagnostics in strict polls before retaining a false error",
    async (probe) => {
      metadata.writeSession(TEST_DATA_DIR, record());
      const cursor = (await poll()).nextCursor;
      const checkpointPath = join(TEST_DATA_DIR, "session-transitions", "checkpoint.json");
      const before = readFileSync(checkpointPath, "utf8");
      const runtime = vi.spyOn(sessionServiceInternals(service), "readRuntimeSnapshot");
      if (probe === "runtime")
        runtime.mockResolvedValue({
          runtimeAlive: false,
          paneUsable: false,
          processAlive: false,
          probeUnresponsive: true,
          diagnostic: "probe timed out",
        });
      else
        probeWorkspaceMock.mockReturnValue({
          exists: false,
          missing: false,
          diagnostic: "probe timed out",
        });
      await expect(poll({ since: cursor })).rejects.toThrow("probe timed out");
      expect(metadata.readSession(TEST_DATA_DIR, "api-1")).not.toHaveProperty("error");
      expect(readFileSync(checkpointPath, "utf8")).toBe(before);
      expect(await service.get("api-1")).toMatchObject({ state: "error" });
      runtime.mockRestore();
      probeWorkspaceMock.mockReturnValue({ exists: true, missing: false });
      expect((await poll({ since: cursor })).hasMore).toBe(false);
    },
  );

  it("accepts an empty but healthy runtime snapshot as an authoritative stopped state", async () => {
    metadata.writeSession(TEST_DATA_DIR, record());
    vi.spyOn(sessionServiceInternals(service), "readRuntimeSnapshot").mockResolvedValue({
      runtimeAlive: false,
      paneUsable: false,
      processAlive: false,
      probeUnresponsive: false,
    });
    expect((await poll()).entries).toContainEqual(
      expect.objectContaining({ kind: "status", to: "stopped" }),
    );
  });

  it.each(["structured", "thrown"] as const)(
    "rejects a %s confirmation runtime probe failure without advancing strict observations",
    async (failure) => {
      metadata.writeSession(TEST_DATA_DIR, record());
      const cursor = (await poll()).nextCursor;
      const checkpointPath = join(TEST_DATA_DIR, "session-transitions", "checkpoint.json");
      const before = readFileSync(checkpointPath, "utf8");
      const snapshots = vi.spyOn(sessionServiceInternals(service), "readRuntimeSnapshot");
      const dead = {
        runtimeAlive: false,
        paneUsable: false,
        processAlive: false,
        probeUnresponsive: false,
      };
      const failConfirmation = () => {
        snapshots.mockReset().mockResolvedValueOnce(dead);
        if (failure === "thrown")
          snapshots.mockRejectedValue(new Error("confirmation probe timed out"));
        else
          snapshots.mockResolvedValue({
            ...dead,
            probeUnresponsive: true,
            diagnostic: "confirmation probe timed out",
          });
      };
      failConfirmation();
      await expect(poll({ since: cursor })).rejects.toThrow("confirmation probe timed out");
      expect(metadata.readSession(TEST_DATA_DIR, "api-1")).not.toHaveProperty("error");
      expect(metadata.readSession(TEST_DATA_DIR, "api-1")?.status).toBe("running");
      expect(readFileSync(checkpointPath, "utf8")).toBe(before);
      failConfirmation();
      expect(await service.get("api-1")).toMatchObject({ state: "error" });
      expect(metadata.readSession(TEST_DATA_DIR, "api-1")?.error).toContain(
        "confirmation probe timed out",
      );
      snapshots.mockRestore();
      expect((await poll({ since: cursor })).hasMore).toBe(false);
    },
  );
});
