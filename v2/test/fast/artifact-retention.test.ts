import { describe, expect, it, vi } from "vitest";
import {
  type ArtifactRetentionPlan,
  executeArtifactRetention,
  planArtifactRetention,
} from "../../src/artifact-retention.js";
import type { SessionArtifact, SessionRecord } from "../../src/types.js";

const NOW = new Date("2026-09-04T00:00:00.000Z");

function session(overrides: Partial<SessionRecord> & { id: string }): SessionRecord {
  return {
    project: "api",
    workspaceId: overrides.id,
    agent: "claude",
    prompt: "ship it",
    branch: overrides.id,
    worktree: true,
    worktreePath: `/data/worktrees/api/${overrides.id}`,
    tmuxSession: overrides.id,
    launchCommand: "claude",
    status: "running",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

function artifact(overrides: Partial<SessionArtifact> & { id: string }): SessionArtifact {
  return {
    name: overrides.id,
    size: 1024,
    mimeType: "application/jsonl",
    kind: "file",
    origin: "automatic",
    createdAt: "2026-09-01T00:00:00.000Z",
    updatedAt: "2026-09-01T00:00:00.000Z",
    ...overrides,
  };
}

/** `count` agent-history automatics, oldest first, one minute apart. */
function historyFiles(
  count: number,
  size = 1024,
  startMs = Date.parse("2026-09-01T00:00:00.000Z"),
) {
  return Array.from({ length: count }, (_, index) =>
    artifact({
      id: `agent-history-s1-${String(index).padStart(4, "0")}.jsonl`,
      size,
      updatedAt: new Date(startMs + index * 60_000).toISOString(),
    }),
  );
}

function plan(
  sessions: SessionRecord[],
  listing: Record<string, { artifacts: SessionArtifact[]; truncated: boolean }>,
  overrides: Partial<{
    olderThanDays: number;
    maxBytesPerSession: number;
    maxFilesPerSession: number;
    limit: number;
    projectFilter: string;
    now: Date;
  }> = {},
): ArtifactRetentionPlan {
  return planArtifactRetention({
    sessions,
    now: overrides.now ?? NOW,
    olderThanDays: overrides.olderThanDays ?? 30,
    maxBytesPerSession: overrides.maxBytesPerSession ?? 2 * 1024 * 1024 * 1024,
    maxFilesPerSession: overrides.maxFilesPerSession ?? 500,
    limit: overrides.limit ?? 100,
    ...(overrides.projectFilter ? { projectFilter: overrides.projectFilter } : {}),
    listArtifacts: (anchorId) => listing[anchorId] ?? { artifacts: [], truncated: false },
  });
}

describe("planArtifactRetention", () => {
  it("only treats agent-history automatics as eligible", () => {
    const artifacts = [
      ...historyFiles(600),
      artifact({ id: "report.md", origin: "intentional" }),
      artifact({ id: "startup-attachment.png", origin: "intentional", addedByUser: true }),
      artifact({ id: "screenshot.png", origin: "automatic", addedByUser: true }),
      artifact({ id: "agent-history-s1-user.jsonl", origin: "automatic", addedByUser: true }),
    ];
    const result = plan([session({ id: "s1" })], {
      s1: { artifacts, truncated: false },
    });
    const anchor = result.anchors[0];
    expect(anchor?.totalFiles).toBe(604);
    expect(anchor?.automaticFiles).toBe(600);
    expect(anchor?.evict).toHaveLength(100);
    for (const candidate of anchor?.evict ?? []) {
      expect(candidate.artifactId.startsWith("agent-history-")).toBe(true);
    }
    const evicted = new Set(anchor?.evict.map((candidate) => candidate.artifactId));
    expect(evicted.has("report.md")).toBe(false);
    expect(evicted.has("startup-attachment.png")).toBe(false);
    expect(evicted.has("screenshot.png")).toBe(false);
    expect(evicted.has("agent-history-s1-user.jsonl")).toBe(false);
  });

  it("count cap evicts the oldest and keeps the newest", () => {
    const artifacts = historyFiles(600);
    const result = plan([session({ id: "s1" })], { s1: { artifacts, truncated: false } });
    const anchor = result.anchors[0];
    expect(anchor?.evict).toHaveLength(100);
    expect(anchor?.evict.every((candidate) => candidate.reason === "count_cap")).toBe(true);
    expect(anchor?.evict[0]?.artifactId).toBe(artifacts[0]?.id);
    expect(anchor?.evict[99]?.artifactId).toBe(artifacts[99]?.id);
    expect(anchor?.evictBytes).toBe(100 * 1024);
  });

  it("byte cap trims oldest-first until the anchor fits", () => {
    const artifacts = historyFiles(10, 1_000_000);
    const result = plan(
      [session({ id: "s1" })],
      { s1: { artifacts, truncated: false } },
      {
        maxBytesPerSession: 4_000_000,
        maxFilesPerSession: 500,
      },
    );
    const anchor = result.anchors[0];
    expect(anchor?.evict.map((candidate) => candidate.artifactId)).toEqual(
      artifacts.slice(0, 6).map((entry) => entry.id),
    );
    expect(anchor?.evict.every((candidate) => candidate.reason === "byte_cap")).toBe(true);
  });

  it("age prune applies only to a reclaim-safe anchor", () => {
    const artifacts = historyFiles(10, 1024, Date.parse("2026-01-01T00:00:00.000Z"));
    const listing = { s1: { artifacts, truncated: false } };

    const running = plan([session({ id: "s1", status: "running" })], listing);
    expect(running.anchors).toHaveLength(0);

    const errored = plan([session({ id: "s1", status: "errored" })], listing);
    expect(errored.anchors).toHaveLength(0);

    const completed = plan([session({ id: "s1", status: "completed" })], listing);
    expect(completed.anchors[0]?.evict).toHaveLength(10);
    expect(completed.anchors[0]?.evict.every((entry) => entry.reason === "age")).toBe(true);
  });

  it("a running anchor over the byte cap is still trimmed by bytes", () => {
    const artifacts = historyFiles(10, 1_000_000);
    const result = plan(
      [session({ id: "s1", status: "running" })],
      {
        s1: { artifacts, truncated: false },
      },
      { maxBytesPerSession: 4_000_000 },
    );
    expect(result.anchors[0]?.evict.length).toBe(6);
  });

  it("age needs every desk member reclaim-safe", () => {
    const artifacts = historyFiles(4, 1024, Date.parse("2026-01-01T00:00:00.000Z"));
    const listing = { desk: { artifacts, truncated: false } };
    const mixed = plan(
      [
        session({ id: "s1", workspaceId: "desk", status: "completed" }),
        session({ id: "s2", workspaceId: "desk", status: "running" }),
      ],
      listing,
    );
    expect(mixed.anchors).toHaveLength(0);

    const allSafe = plan(
      [
        session({ id: "s1", workspaceId: "desk", status: "completed" }),
        session({ id: "s2", workspaceId: "desk", status: "stopped" }),
      ],
      listing,
    );
    expect(allSafe.anchors[0]?.sessionIds).toEqual(["s1", "s2"]);
    expect(allSafe.anchors[0]?.evict).toHaveLength(4);
  });

  it("a truncated listing blocks the whole anchor", () => {
    const result = plan([session({ id: "s1", status: "completed" })], {
      s1: { artifacts: historyFiles(600), truncated: true },
    });
    const anchor = result.anchors[0];
    expect(anchor?.blockReasons).toEqual(["listing_truncated"]);
    expect(anchor?.evict).toEqual([]);
    expect(result.totals.evictFiles).toBe(0);
  });
});

describe("executeArtifactRetention", () => {
  it("dry run deletes nothing and still reports the bytes it would free", () => {
    const deleteArtifacts = vi.fn<(anchorId: string, ids: readonly string[]) => string[]>();
    const built = plan([session({ id: "s1" })], {
      s1: { artifacts: historyFiles(600), truncated: false },
    });
    const report = executeArtifactRetention(built, { deleteArtifacts }, { dryRun: true });
    expect(deleteArtifacts).not.toHaveBeenCalled();
    expect(report.dryRun).toBe(true);
    expect(report.totals.freedBytes).toBe(100 * 1024);
    expect(report.totals.errors).toBe(0);
  });

  it("execute deletes exactly the planned ids and never a blocked anchor", () => {
    const built = plan([session({ id: "s1" }), session({ id: "s2", status: "completed" })], {
      s1: { artifacts: historyFiles(600), truncated: false },
      s2: { artifacts: historyFiles(600), truncated: true },
    });
    const seen: { anchorId: string; ids: readonly string[] }[] = [];
    const report = executeArtifactRetention(
      built,
      {
        deleteArtifacts: (anchorId, ids) => {
          seen.push({ anchorId, ids });
          return [...ids];
        },
      },
      { dryRun: false },
    );
    expect(seen).toHaveLength(1);
    expect(seen[0]?.anchorId).toBe("s1");
    expect(seen[0]?.ids).toHaveLength(100);
    expect(report.totals.freedBytes).toBe(100 * 1024);
    expect(report.totals.errors).toBe(0);
  });

  it("counts a boundary-rejected id as an error, not as freed bytes", () => {
    const built = plan([session({ id: "s1" })], {
      s1: { artifacts: historyFiles(600), truncated: false },
    });
    const report = executeArtifactRetention(
      built,
      { deleteArtifacts: (_anchorId, ids) => [...ids].slice(0, 98) },
      { dryRun: false },
    );
    expect(report.totals.errors).toBe(2);
    expect(report.totals.freedBytes).toBe(98 * 1024);
  });
});
