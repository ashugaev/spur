import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  ReviewEventData,
  ReviewSignal,
  ReviewSnapshot,
  SessionRecord,
} from "../../src/types.js";
import type { ReviewProvider } from "../../src/review-providers/types.js";

const listSessionsMock = vi.fn();
const readReviewSourceSnapshotsMock = vi.fn();
const writeReviewSourceSnapshotMock = vi.fn();
const deleteReviewSourceSnapshotMock = vi.fn();
const collectSignalsMock = vi.fn();
const logSpurEventMock = vi.fn();

vi.mock("../../src/event-log.js", () => ({
  logSpurEvent: logSpurEventMock,
}));

vi.mock("../../src/metadata.js", () => ({
  listSessions: listSessionsMock,
  readReviewSourceSnapshots: readReviewSourceSnapshotsMock,
  writeReviewSourceSnapshot: writeReviewSourceSnapshotMock,
  deleteReviewSourceSnapshot: deleteReviewSourceSnapshotMock,
}));

vi.mock("node:fs", () => ({
  existsSync: vi.fn(() => true),
}));

const stubProvider: ReviewProvider = {
  id: "gitlab",
  displayName: "GitLab",
  requestLabel: "merge request",
  requestLabelPlural: "merge requests",
  instructionsLine: "Review the latest GitLab updates on the active merge request and act on them.",
  commandLine:
    "Use `glab mr view --comments` and `glab ci status`, then fix, push, and reply if needed.",
  async findReviewUrlByBranch() {
    return null;
  },
  collectSignals: collectSignalsMock,
};

vi.mock("../../src/review-providers/index.js", () => ({
  reviewProvider: () => stubProvider,
}));

const { createReviewSourceModule } = await import("../../src/event-sources/review-source.js");

function makeSession(overrides: Partial<SessionRecord> = {}): SessionRecord {
  return {
    id: "api-1",
    project: "api",
    workspaceId: "api-1",
    agent: "claude",
    prompt: "fix the bug",
    branch: "feature/mr-binding",
    worktree: true,
    worktreePath: "/tmp/spur-worktrees/api-1",
    tmuxSession: "api-1",
    launchCommand: "claude",
    status: "running",
    createdAt: "2026-04-26T09:00:00.000Z",
    updatedAt: "2026-04-26T09:00:00.000Z",
    ...overrides,
  };
}

// Builds the on-disk/in-memory envelope shape `readReviewSourceSnapshotsMock`
// now returns per session.
function storedSnapshot(signals: ReviewSignal[], prNumber: number | null = 42): ReviewSnapshot {
  return { prNumber, signals: new Map(signals.map((signal) => [signal.key, signal])) };
}

function collected(
  prNumber: number,
  signals: ReviewSignal[],
): { data: ReviewEventData; snapshot: Map<string, ReviewSignal> } {
  return {
    data: { sessionId: "api-1", prNumber, prTitle: "Tighten coverage", signals: [] },
    snapshot: new Map(signals.map((signal) => [signal.key, signal])),
  };
}

const flushPollCycle = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

describe("createReviewSourceModule (generic review source)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("writes the envelope once per poll so the in-memory and on-disk copies cannot desync", async () => {
    readReviewSourceSnapshotsMock.mockReturnValue(new Map());
    listSessionsMock.mockReturnValue([makeSession()]);
    collectSignalsMock.mockResolvedValueOnce(
      collected(42, [{ key: "changes_requested", kind: "changes_requested", text: "Unresolved." }]),
    );
    const module = createReviewSourceModule("gitlab");

    const handle = await module.start({
      sourceId: "mr-watch",
      projectId: "api",
      dataDir: "/tmp/spur-data",
      config: { type: "gitlab", intervalMs: 60_000, runOnStart: false, emitExisting: false },
      emit: vi.fn(),
      signal: new AbortController().signal,
      logger: { info: vi.fn(), warn: vi.fn() },
      resolveWebBaseUrl: () => Promise.resolve("http://127.0.0.1:5555"),
    });

    const call = writeReviewSourceSnapshotMock.mock.calls[0];
    expect(call?.[1]).toBe("gitlab");
    const written = call?.[5] as ReviewSnapshot;
    expect(written.prNumber).toBe(42);
    expect(written.signals.has("changes_requested")).toBe(true);
    handle.stop();
  });

  it("still polls a stale-parked session", async () => {
    readReviewSourceSnapshotsMock.mockReturnValue(new Map());
    listSessionsMock.mockReturnValue([
      makeSession({ status: "stopped", stopReason: "stale_timeout" }),
    ]);
    collectSignalsMock.mockResolvedValueOnce(collected(42, []));
    const module = createReviewSourceModule("gitlab");

    const handle = await module.start({
      sourceId: "mr-watch",
      projectId: "api",
      dataDir: "/tmp/spur-data",
      config: { type: "gitlab", intervalMs: 60_000, runOnStart: false, emitExisting: false },
      emit: vi.fn(),
      signal: new AbortController().signal,
      logger: { info: vi.fn(), warn: vi.fn() },
      resolveWebBaseUrl: () => Promise.resolve("http://127.0.0.1:5555"),
    });

    expect(collectSignalsMock).toHaveBeenCalled();
    handle.stop();
  });

  it("does not poll a killed session", async () => {
    readReviewSourceSnapshotsMock.mockReturnValue(new Map());
    listSessionsMock.mockReturnValue([makeSession({ status: "killed" })]);
    const module = createReviewSourceModule("gitlab");

    const handle = await module.start({
      sourceId: "mr-watch",
      projectId: "api",
      dataDir: "/tmp/spur-data",
      config: { type: "gitlab", intervalMs: 60_000, runOnStart: false, emitExisting: false },
      emit: vi.fn(),
      signal: new AbortController().signal,
      logger: { info: vi.fn(), warn: vi.fn() },
      resolveWebBaseUrl: () => Promise.resolve("http://127.0.0.1:5555"),
    });

    expect(collectSignalsMock).not.toHaveBeenCalled();
    handle.stop();
  });

  it("resets the diff when the collected PR number changes, without replaying identical text", async () => {
    // The MR is resolved from the branch (review-providers/gitlab.ts), so a stale
    // baseline recorded against a prior MR number must never suppress an
    // identical-text signal collected from a different MR — same defect A2 fixes
    // for GitHub, ported here since the reader/writer is shared.
    readReviewSourceSnapshotsMock.mockReturnValue(
      new Map([
        [
          "api-1",
          storedSnapshot(
            [{ key: "changes_requested", kind: "changes_requested", text: "Unresolved." }],
            42,
          ),
        ],
      ]),
    );
    listSessionsMock.mockReturnValue([makeSession()]);
    collectSignalsMock.mockResolvedValueOnce(
      collected(99, [{ key: "changes_requested", kind: "changes_requested", text: "Unresolved." }]),
    );
    const emit = vi.fn();
    const module = createReviewSourceModule("gitlab");

    const handle = await module.start({
      sourceId: "mr-watch",
      projectId: "api",
      dataDir: "/tmp/spur-data",
      config: { type: "gitlab", intervalMs: 60_000, runOnStart: false, emitExisting: false },
      emit,
      signal: new AbortController().signal,
      logger: { info: vi.fn(), warn: vi.fn() },
      resolveWebBaseUrl: () => Promise.resolve("http://127.0.0.1:5555"),
    });

    // First observation of #99: emitInitial is false (runOnStart:false), so nothing
    // replays even though the text is byte-identical to #42's stored signal.
    expect(emit).not.toHaveBeenCalled();
    const written = writeReviewSourceSnapshotMock.mock.calls[0]?.[5] as ReviewSnapshot;
    expect(written.prNumber).toBe(99);
    expect(written.signals.has("changes_requested")).toBe(true);
    handle.stop();
  });

  it("emits when the PR number matches the stored baseline and the text changed", async () => {
    readReviewSourceSnapshotsMock.mockReturnValue(
      new Map([
        [
          "api-1",
          storedSnapshot(
            [{ key: "changes_requested", kind: "changes_requested", text: "Unresolved." }],
            42,
          ),
        ],
      ]),
    );
    listSessionsMock.mockReturnValue([makeSession()]);
    collectSignalsMock.mockResolvedValueOnce(
      collected(42, [
        {
          key: "changes_requested",
          kind: "changes_requested",
          text: "Still unresolved (updated).",
        },
      ]),
    );
    const emit = vi.fn();
    const module = createReviewSourceModule("gitlab");

    const handle = await module.start({
      sourceId: "mr-watch",
      projectId: "api",
      dataDir: "/tmp/spur-data",
      config: { type: "gitlab", intervalMs: 60_000, runOnStart: false, emitExisting: false },
      emit,
      signal: new AbortController().signal,
      logger: { info: vi.fn(), warn: vi.fn() },
      resolveWebBaseUrl: () => Promise.resolve("http://127.0.0.1:5555"),
    });

    expect(emit).toHaveBeenCalledWith(
      "gitlab:changes_requested",
      expect.objectContaining({
        signals: [expect.objectContaining({ key: "changes_requested" })],
      }),
    );
    handle.stop();
  });

  it("deletes the snapshot when the session's MR no longer resolves", async () => {
    readReviewSourceSnapshotsMock.mockReturnValue(
      new Map([
        ["api-1", storedSnapshot([{ key: "ci_failed", kind: "ci_failed", text: "CI red." }])],
      ]),
    );
    listSessionsMock.mockReturnValue([makeSession()]);
    collectSignalsMock.mockResolvedValueOnce(null);

    const module = createReviewSourceModule("gitlab");
    const handle = await module.start({
      sourceId: "mr-watch",
      projectId: "api",
      dataDir: "/tmp/spur-data",
      config: { type: "gitlab", intervalMs: 60_000, runOnStart: false, emitExisting: false },
      emit: vi.fn(),
      signal: new AbortController().signal,
      logger: { info: vi.fn(), warn: vi.fn() },
      resolveWebBaseUrl: () => Promise.resolve("http://127.0.0.1:5555"),
    });

    expect(deleteReviewSourceSnapshotMock).toHaveBeenCalledWith(
      "/tmp/spur-data",
      "gitlab",
      "api",
      "mr-watch",
      "api-1",
    );
    expect(writeReviewSourceSnapshotMock).not.toHaveBeenCalled();
    handle.stop();
  });

  it("replays already-true state on runOnStart despite a PR-number reset", async () => {
    readReviewSourceSnapshotsMock.mockReturnValue(
      new Map([
        [
          "api-1",
          storedSnapshot(
            [{ key: "changes_requested", kind: "changes_requested", text: "Unresolved." }],
            42,
          ),
        ],
      ]),
    );
    listSessionsMock.mockReturnValue([makeSession()]);
    collectSignalsMock.mockResolvedValueOnce(
      collected(99, [{ key: "changes_requested", kind: "changes_requested", text: "Unresolved." }]),
    );
    const emit = vi.fn();
    const module = createReviewSourceModule("gitlab");

    const handle = await module.start({
      sourceId: "mr-watch",
      projectId: "api",
      dataDir: "/tmp/spur-data",
      config: { type: "gitlab", intervalMs: 3_600_000, runOnStart: true, emitExisting: false },
      emit,
      signal: new AbortController().signal,
      logger: { info: vi.fn(), warn: vi.fn() },
      resolveWebBaseUrl: () => Promise.resolve("http://127.0.0.1:5555"),
    });

    handle.runOnStart?.();
    await flushPollCycle();

    expect(emit).toHaveBeenCalledWith(
      "gitlab:changes_requested",
      expect.objectContaining({
        signals: [expect.objectContaining({ key: "changes_requested" })],
      }),
    );
    handle.stop();
  });
});

describe("review source poll cycle failure", () => {
  const REAL_INTERVAL_MS = 20;
  const SLOW_INTERVAL_MS = 60_000;
  const logger = { info: vi.fn(), warn: vi.fn() };
  const unhandled = vi.fn();
  const uncaught = vi.fn();

  // listSessions is first called by poll(), so `healthyCalls` polls return [] before
  // `failures` consecutive throws.
  function scripted(healthyCalls: number, failures: number): () => number {
    let calls = 0;
    listSessionsMock.mockImplementation(() => {
      calls += 1;
      if (calls > healthyCalls && calls <= healthyCalls + failures) {
        throw new Error("EACCES: permission denied, scandir");
      }
      return [];
    });
    return () => calls;
  }

  async function waitForCalls(calls: () => number, target: number): Promise<void> {
    for (let waited = 0; calls() < target; waited += 10) {
      if (waited >= 4000) throw new Error(`timed out at ${calls()} of ${target} calls`);
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }

  function startSource(
    config: { intervalMs: number; runOnStart: boolean },
    deferInitialSync?: boolean,
  ) {
    return createReviewSourceModule("gitlab").start({
      sourceId: "mr-watch",
      projectId: "api",
      dataDir: "/tmp/spur-data",
      config: { type: "gitlab", emitExisting: false, ...config },
      emit: vi.fn(),
      signal: new AbortController().signal,
      logger,
      resolveWebBaseUrl: () => Promise.resolve("http://127.0.0.1:5555"),
      ...(deferInitialSync === undefined ? {} : { deferInitialSync }),
    });
  }

  function cycleWarns(): number {
    return logger.warn.mock.calls.filter(([line]) => String(line).includes("poll cycle failed"))
      .length;
  }

  function cycleEvents(): number {
    return logSpurEventMock.mock.calls.filter(
      ([, entry]) => entry.event === "source.poll_cycle.error",
    ).length;
  }

  beforeEach(() => {
    vi.clearAllMocks();
    readReviewSourceSnapshotsMock.mockReturnValue(new Map());
    process.on("unhandledRejection", unhandled);
    process.on("uncaughtException", uncaught);
  });

  afterEach(() => {
    listSessionsMock.mockReset();
    process.removeListener("unhandledRejection", unhandled);
    process.removeListener("uncaughtException", uncaught);
  });

  it("logs once per failed interval tick and polls again after recovery", async () => {
    // 1: awaited initial poll, 2-3: failing ticks, 4+: recovered.
    const calls = scripted(1, 2);
    const handle = await startSource({ intervalMs: REAL_INTERVAL_MS, runOnStart: false });
    await waitForCalls(calls, 4);
    handle.stop();
    await new Promise((resolve) => setTimeout(resolve, 5));

    expect(cycleWarns()).toBe(2);
    expect(cycleEvents()).toBe(2);
    expect(logSpurEventMock).toHaveBeenCalledWith(
      "/tmp/spur-data",
      expect.objectContaining({
        event: "source.poll_cycle.error",
        level: "error",
        projectId: "api",
        sourceId: "mr-watch",
      }),
    );
    expect(unhandled).not.toHaveBeenCalled();
    expect(uncaught).not.toHaveBeenCalled();
  });

  it("logs once when a deferred initial poll fails and start still resolves", async () => {
    scripted(0, 1);
    const handle = await startSource({ intervalMs: SLOW_INTERVAL_MS, runOnStart: false }, true);
    await flushPollCycle();
    await flushPollCycle();
    handle.stop();

    expect(cycleWarns()).toBe(1);
    expect(cycleEvents()).toBe(1);
    expect(unhandled).not.toHaveBeenCalled();
    expect(uncaught).not.toHaveBeenCalled();
  });

  it("logs once when a runOnStart poll fails", async () => {
    scripted(0, 1);
    const handle = await startSource({ intervalMs: SLOW_INTERVAL_MS, runOnStart: true });
    expect(cycleWarns()).toBe(0);
    handle.runOnStart?.();
    await flushPollCycle();
    await flushPollCycle();
    handle.stop();

    expect(cycleWarns()).toBe(1);
    expect(cycleEvents()).toBe(1);
    expect(unhandled).not.toHaveBeenCalled();
    expect(uncaught).not.toHaveBeenCalled();
  });

  it("still rejects start when the awaited initial poll fails", async () => {
    scripted(0, 1);
    await expect(
      startSource({ intervalMs: SLOW_INTERVAL_MS, runOnStart: false }, false),
    ).rejects.toThrow(/EACCES/);
    expect(cycleWarns()).toBe(0);
    expect(cycleEvents()).toBe(0);
  });
});
