import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionRecord } from "../../src/types.js";

const ghMock = vi.fn();
const listSessionsMock = vi.fn();
const readReviewSourceSnapshotsMock = vi.fn();
const writeReviewSourceSnapshotMock = vi.fn();
const deleteReviewSourceSnapshotMock = vi.fn();
const readWorkItemRegistryMock = vi.fn();
const recordWorkItemMock = vi.fn();

vi.mock("../../src/gh.js", () => ({
  gh: ghMock,
}));
vi.mock("../../src/metadata.js", () => ({
  deleteReviewSourceSnapshot: deleteReviewSourceSnapshotMock,
  listSessions: listSessionsMock,
  readReviewSourceSnapshots: readReviewSourceSnapshotsMock,
  readWorkItemRegistry: readWorkItemRegistryMock,
  recordWorkItem: recordWorkItemMock,
  writeReviewSourceSnapshot: writeReviewSourceSnapshotMock,
}));
vi.mock("../../src/workspace.js", () => ({
  readCurrentBranch: vi.fn(),
}));
vi.mock("node:fs", () => ({
  existsSync: vi.fn(() => true),
}));

const { githubSourceModule } = await import("../../src/event-sources/github.js");

function makeSession(overrides: Partial<SessionRecord> = {}): SessionRecord {
  return {
    id: "api-a1b2",
    project: "api",
    agent: "claude",
    prompt: "fix the bug",
    branch: "feature/native-pr-binding",
    pr: {
      number: 42,
      repo: "acme/api",
      url: "https://github.com/acme/api/pull/42",
    },
    worktree: true,
    worktreePath: "/tmp/spur-worktrees/api-a1b2",
    tmuxSession: "api-a1b2",
    launchCommand: "claude",
    status: "running",
    createdAt: "2026-04-26T09:00:00.000Z",
    updatedAt: "2026-04-26T09:00:00.000Z",
    ...overrides,
  };
}

describe("github source", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    readWorkItemRegistryMock.mockReturnValue(new Set());
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("keeps the existing snapshot when gh pr view fails transiently", async () => {
    const existingSnapshot = new Map([
      [
        "ci_failed",
        {
          key: "ci_failed",
          kind: "ci_failed" as const,
          text: "CI is failing: runtime suite.",
        },
      ],
    ]);
    readReviewSourceSnapshotsMock.mockReturnValue(new Map([["api-a1b2", existingSnapshot]]));
    listSessionsMock.mockReturnValue([makeSession()]);
    ghMock.mockRejectedValueOnce(new Error("gh offline"));
    const logger = { info: vi.fn(), warn: vi.fn() };

    const handle = await githubSourceModule.start({
      sourceId: "pr-watch",
      projectId: "api",
      dataDir: "/tmp/spur-data",
      config: { type: "github", intervalMs: 60_000, runOnStart: false },
      emit: vi.fn(),
      signal: new AbortController().signal,
      logger,
    });

    expect(deleteReviewSourceSnapshotMock).not.toHaveBeenCalled();
    expect(writeReviewSourceSnapshotMock).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining("failed to poll api-a1b2: gh offline"),
    );

    handle.stop();
  });

  it("emits github:work_item.new for unseen query results", async () => {
    readReviewSourceSnapshotsMock.mockReturnValue(new Map());
    listSessionsMock.mockReturnValue([]);
    ghMock.mockResolvedValueOnce(
      JSON.stringify([
        {
          number: 7,
          title: "Work item",
          url: "https://github.com/acme/api/pull/7",
          repository: { nameWithOwner: "acme/api" },
        },
      ]),
    );
    const emit = vi.fn();

    const handle = await githubSourceModule.start({
      sourceId: "pr-watch",
      projectId: "api",
      dataDir: "/tmp/spur-data",
      config: {
        type: "github",
        intervalMs: 60_000,
        runOnStart: false,
        query: "is:pr is:open label:spur",
      },
      emit,
      signal: new AbortController().signal,
      logger: { info: vi.fn(), warn: vi.fn() },
    });

    expect(recordWorkItemMock).toHaveBeenCalledWith(
      "/tmp/spur-data",
      "api",
      "pr-watch",
      "acme/api#7",
    );
    expect(emit).toHaveBeenCalledWith("github:work_item.new", {
      externalId: "acme/api#7",
      url: "https://github.com/acme/api/pull/7",
      number: 7,
      title: "Work item",
      repo: "acme/api",
    });

    handle.stop();
  });
});
