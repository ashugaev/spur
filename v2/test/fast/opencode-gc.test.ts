import { mkdir, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  collectOpenCodeGcPlan,
  parseGitConfigWorktree,
  planOpenCodeGc,
  readSnapshotLeaves,
  resolveCanonicalPaths,
  type OpenCodeGcPlanInput,
  type OpenCodeGcSkipReason,
  type OpenCodeStoreSession,
} from "../../src/opencode-gc.js";
import type { SessionRecord, SessionStatus } from "../../src/types.js";
import { createTempDir } from "../helpers/common.js";

const NOW = new Date("2026-09-10T00:00:00.000Z");
const OLD = NOW.getTime() - 60 * 86_400_000;
const STORE_ID = "ses_fc843fe5dffegfDFNqCKw6TP4W";

function record(overrides: Partial<SessionRecord> & { id: string }): SessionRecord {
  return {
    project: "sp",
    workspaceId: overrides.id,
    agent: "opencode",
    prompt: "ship it",
    branch: overrides.id,
    worktree: true,
    worktreePath: `/worktrees/sp/${overrides.id}`,
    tmuxSession: overrides.id,
    launchCommand: "opencode",
    status: "completed",
    createdAt: "2026-08-01T00:00:00.000Z",
    updatedAt: "2026-08-01T00:00:00.000Z",
    ...overrides,
  };
}

function storeSession(overrides: Partial<OpenCodeStoreSession> = {}): OpenCodeStoreSession {
  return { id: STORE_ID, directory: "/worktrees/sp/spur-d704", updated: OLD, ...overrides };
}

/**
 * Identity canonicalization for the fixtures that are not about symlinks: a
 * path maps to itself, an unknown path maps to null (unresolvable).
 */
function identityCanon(paths: string[]): Map<string, string | null> {
  return new Map(paths.map((path) => [path, path]));
}

function plan(
  overrides: Partial<OpenCodeGcPlanInput> & { sessions: readonly OpenCodeStoreSession[] },
) {
  const records = overrides.records ?? [];
  const sessions = overrides.sessions;
  return planOpenCodeGc({
    storeRoot: "/store",
    snapshotLeaves: [],
    log: null,
    now: NOW,
    olderThanDays: 14,
    statuses: ["completed", "killed"],
    limit: 20,
    logMaxBytes: 1024,
    logTailBytes: 128,
    listLimit: 100_000,
    dbPath: "/store/opencode.db",
    dbSizeBytes: 1000,
    freeBytes: 10_000,
    ...overrides,
    sessions,
    records,
    canonicalPaths:
      overrides.canonicalPaths ??
      identityCanon([
        ...sessions.map((entry) => entry.directory),
        ...records.map((entry) => entry.worktreePath),
      ]),
    listedCount: overrides.listedCount ?? sessions.length,
  });
}

function skipReasonOf(
  result: ReturnType<typeof plan>,
  id = STORE_ID,
): OpenCodeGcSkipReason | undefined {
  return result.skipped.find((entry) => entry.id === id)?.reason;
}

// Every AC2 fixture gives the SELECTABLE record `agentSessionId === <store
// session id>` so rule (a) matches and the session is genuinely selectable
// but for the guard under test. Without that the session is unselectable
// anyway and the case stays green under both the fixed and the reverted
// rule — a vacuous test.
describe("planOpenCodeGc never selects a live session's data (AC2)", () => {
  it("AC2.1 a live sibling sharing the directory blocks the selectable owner", () => {
    const directory = "/worktrees/sp/spur-d704";
    const result = plan({
      sessions: [storeSession({ directory })],
      records: [
        record({ id: "spur-d704", worktreePath: directory, agentSessionId: STORE_ID }),
        record({ id: "spur-66ff", worktreePath: directory, status: "stopped" }),
      ],
    });

    expect(result.sessions).toEqual([]);
    expect(skipReasonOf(result)).toBe("protected_live_record");
  });

  it("AC2.2 a running record reached only through a symlinked worktreePath still protects", async () => {
    const root = await createTempDir("opencode-gc-symlink");
    const real = join(root, "ao");
    const link = join(root, "spur");
    await mkdir(real);
    await symlink(real, link);

    const records = [
      record({ id: "spur-2c04", worktreePath: link, agentSessionId: STORE_ID }),
      record({ id: "spur-54da", worktreePath: link, status: "running" }),
    ];
    const canonicalPaths = await resolveCanonicalPaths([real, link]);
    const result = plan({
      sessions: [storeSession({ directory: real })],
      records,
      canonicalPaths,
    });

    expect(canonicalPaths.get(link)).toBe(real);
    expect(result.sessions).toEqual([]);
    expect(skipReasonOf(result)).toBe("protected_live_record");
  });

  it("AC2.3 directory co-location alone never authorizes a selection", () => {
    const directory = "/worktrees/sp/spur-0719";
    const result = plan({
      sessions: [storeSession({ directory })],
      records: [
        record({ id: "spur-0719", worktreePath: directory, status: "completed" }),
        record({ id: "spur-2062", worktreePath: directory, status: "killed" }),
      ],
    });

    expect(result.sessions).toEqual([]);
    expect(skipReasonOf(result)).toBe("no_record_match");
  });

  it("AC2.4 exactly completed and killed are selectable across all seven statuses", () => {
    const statuses: SessionStatus[] = [
      "spawning",
      "running",
      "stopped",
      "paused",
      "errored",
      "completed",
      "killed",
    ];
    const outcome = statuses.map((status) => {
      const result = plan({
        sessions: [storeSession({ directory: "/worktrees/sp/lonely" })],
        records: [
          record({
            id: "spur-solo",
            worktreePath: "/worktrees/sp/lonely",
            status,
            agentSessionId: STORE_ID,
          }),
        ],
      });
      return [status, result.sessions.length === 1 ? "selected" : skipReasonOf(result)];
    });

    expect(outcome).toEqual([
      ["spawning", "protected_live_record"],
      ["running", "protected_live_record"],
      ["stopped", "protected_live_record"],
      ["paused", "protected_live_record"],
      ["errored", "protected_live_record"],
      ["completed", "selected"],
      ["killed", "selected"],
    ]);
  });

  it("AC2.5 an unresolvable session directory fails closed", () => {
    const directory = "/worktrees/sp/deleted";
    const result = plan({
      sessions: [storeSession({ directory })],
      records: [record({ id: "spur-gone", worktreePath: directory, agentSessionId: STORE_ID })],
      // Both sides unresolvable: the record still protects on raw equality,
      // but it is completed, so the session survives to the directory gate.
      canonicalPaths: new Map([[directory, null]]),
    });

    expect(result.sessions).toEqual([]);
    expect(skipReasonOf(result)).toBe("directory_unresolvable");
  });

  it("selects a terminal-owned session once every guard clears", () => {
    const directory = "/worktrees/sp/spur-clean";
    const result = plan({
      sessions: [storeSession({ directory })],
      records: [record({ id: "spur-clean", worktreePath: directory, agentSessionId: STORE_ID })],
    });

    expect(result.sessions.map((entry) => entry.id)).toEqual([STORE_ID]);
    expect(result.sessions[0]?.recordIds).toEqual(["spur-clean"]);
    expect(result.sessions[0]?.canonicalDirectory).toBe(directory);
  });

  it("protects through the workspaceId union when the live sibling sits elsewhere", () => {
    const directory = "/worktrees/sp/desk";
    const result = plan({
      sessions: [storeSession({ directory })],
      records: [
        record({
          id: "spur-anchor",
          workspaceId: "desk-1",
          worktreePath: directory,
          agentSessionId: STORE_ID,
        }),
        record({
          id: "spur-sibling",
          workspaceId: "desk-1",
          worktreePath: "/worktrees/sp/other",
          status: "running",
        }),
      ],
    });

    expect(result.sessions).toEqual([]);
    expect(skipReasonOf(result)).toBe("protected_live_record");
  });

  it("skips a session younger than olderThanDays", () => {
    const directory = "/worktrees/sp/fresh";
    const result = plan({
      sessions: [storeSession({ directory, updated: NOW.getTime() - 86_400_000 })],
      records: [record({ id: "spur-fresh", worktreePath: directory, agentSessionId: STORE_ID })],
    });

    expect(result.sessions).toEqual([]);
    expect(skipReasonOf(result)).toBe("too_recent");
  });
});

describe("planOpenCodeGc enumeration and store guards", () => {
  it("AC4 plans nothing and reports store_unresolved when the store root is unknown", () => {
    const result = plan({ sessions: [storeSession()], storeRoot: null });

    expect(result.reason).toBe("store_unresolved");
    expect(result.sessions).toEqual([]);
    expect(result.snapshotLeaves).toEqual([]);
    expect(result.log).toBeNull();
  });

  it("aborts when the listed count reaches the -n limit", () => {
    const directory = "/worktrees/sp/spur-clean";
    const result = plan({
      sessions: [storeSession({ directory })],
      records: [record({ id: "spur-clean", worktreePath: directory, agentSessionId: STORE_ID })],
      listLimit: 1,
    });

    expect(result.reason).toBe("enumeration_truncated");
    expect(result.enumeration.truncated).toBe(true);
    expect(result.sessions).toEqual([]);
  });

  it("caps the selection at the sweep limit and records the remainder", () => {
    const sessions = [
      storeSession({ id: "ses_a", directory: "/w/a", updated: OLD }),
      storeSession({ id: "ses_b", directory: "/w/b", updated: OLD + 1000 }),
    ];
    const result = plan({
      sessions,
      records: [
        record({ id: "spur-a", worktreePath: "/w/a", agentSessionId: "ses_a" }),
        record({ id: "spur-b", worktreePath: "/w/b", agentSessionId: "ses_b" }),
      ],
      limit: 1,
    });

    expect(result.sessions.map((entry) => entry.id)).toEqual(["ses_a"]);
    expect(skipReasonOf(result, "ses_b")).toBe("over_limit");
  });
});

describe("planOpenCodeGc vacuum interlocks", () => {
  it("blocks on a live opencode record and on insufficient free space", () => {
    const result = plan({
      sessions: [],
      records: [record({ id: "spur-live", agent: "opencode", status: "running" })],
      dbSizeBytes: 1000,
      freeBytes: 1500,
    });

    expect(result.vacuum.blockReasons).toEqual(["insufficient_free_space", "live_opencode_record"]);
    expect(result.vacuum.requiredBytes).toBe(2000);
  });

  it("clears when headroom is 2x the db and no opencode record is live", () => {
    const result = plan({
      sessions: [],
      records: [record({ id: "spur-done", agent: "opencode", status: "completed" })],
    });

    expect(result.vacuum.blockReasons).toEqual([]);
  });
});

describe("snapshot leaf selection (AC6)", () => {
  it("parses the worktree path out of a leaf git config", () => {
    const text =
      "[core]\n\trepositoryformatversion = 0\n\tbare = false\n\tworktree = /projects/x\n";

    expect(parseGitConfigWorktree(text)).toBe("/projects/x");
    expect(parseGitConfigWorktree("[remote]\n\tworktree = /nope\n")).toBeNull();
    expect(parseGitConfigWorktree("[core]\n\tbare = true\n")).toBeNull();
  });

  it("selects only the leaf whose recorded worktree is gone", async () => {
    const root = await createTempDir("opencode-gc-snapshot");
    const storeRoot = join(root, "store");
    const alive = join(root, "alive-worktree");
    await mkdir(alive, { recursive: true });
    const deadLeaf = join(storeRoot, "snapshot", "proj", "dead");
    const aliveLeaf = join(storeRoot, "snapshot", "proj", "alive");
    await mkdir(deadLeaf, { recursive: true });
    await mkdir(aliveLeaf, { recursive: true });
    await writeFile(join(deadLeaf, "config"), `[core]\n\tworktree = ${join(root, "gone")}\n`);
    await writeFile(join(aliveLeaf, "config"), `[core]\n\tworktree = ${alive}\n`);

    const leaves = await readSnapshotLeaves(storeRoot);
    const result = plan({ sessions: [], snapshotLeaves: leaves });

    expect(leaves).toHaveLength(2);
    expect(result.snapshotLeaves).toEqual([deadLeaf]);
  });

  it("never selects a leaf with no worktree line", async () => {
    const root = await createTempDir("opencode-gc-snapshot-bare");
    const leaf = join(root, "snapshot", "proj", "bare");
    await mkdir(leaf, { recursive: true });
    await writeFile(join(leaf, "config"), "[core]\n\tbare = true\n");

    const result = plan({ sessions: [], snapshotLeaves: await readSnapshotLeaves(root) });

    expect(result.snapshotLeaves).toEqual([]);
  });
});

describe("collectOpenCodeGcPlan", () => {
  const options = {
    now: NOW,
    olderThanDays: 14,
    statuses: ["completed", "killed"] as const,
    limit: 20,
    logMaxBytes: 1024,
    logTailBytes: 128,
  };

  function collectorDeps(overrides: Record<string, unknown> = {}) {
    return {
      resolveStore: async () => ({ storeRoot: "/store", dbPath: "/store/opencode.db" }),
      listStoreSessions: async () => "[]",
      listSpurRecords: () => [],
      readSnapshotLeaves: async () => [],
      statLog: async () => null,
      realpath: async (path: string) => path,
      freeBytes: async () => 10_000,
      statPathSize: async () => 1000,
      ...overrides,
    } as Parameters<typeof collectOpenCodeGcPlan>[0];
  }

  it("returns store_unresolved when `opencode db path` yields nothing", async () => {
    const result = await collectOpenCodeGcPlan(
      collectorDeps({ resolveStore: async () => null }),
      options,
    );

    expect(result.reason).toBe("store_unresolved");
    expect(result.storeRoot).toBeNull();
  });

  it("returns enumeration_failed on unparsable CLI output", async () => {
    const result = await collectOpenCodeGcPlan(
      collectorDeps({ listStoreSessions: async () => "not json" }),
      options,
    );

    expect(result.reason).toBe("enumeration_failed");
    expect(result.sessions).toEqual([]);
  });

  it("plans from the CLI listing with both sides canonicalized", async () => {
    const result = await collectOpenCodeGcPlan(
      collectorDeps({
        listStoreSessions: async () =>
          JSON.stringify([{ id: STORE_ID, directory: "/real/ao", updated: OLD, title: "t" }]),
        listSpurRecords: () => [
          record({ id: "spur-link", worktreePath: "/link/spur", agentSessionId: STORE_ID }),
        ],
        realpath: async (path: string) => (path === "/link/spur" ? "/real/ao" : path),
      }),
      options,
    );

    expect(result.reason).toBeNull();
    expect(result.sessions.map((entry) => entry.id)).toEqual([STORE_ID]);
    expect(result.enumeration.listedCount).toBe(1);
  });
});
