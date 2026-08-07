import { describe, expect, it } from "vitest";
import { formatBytes, renderSessionGcResult } from "../../src/cli.js";
import type { GcGroupReport, GcReport } from "../../src/session-gc.js";

function group(overrides: Partial<GcGroupReport> = {}): GcGroupReport {
  return {
    key: "api-1",
    project: "api",
    sessionIds: ["api-1"],
    workspaceIds: ["api-1"],
    worktreePath: "/data/worktrees/api/api-1",
    ageDays: 84,
    newestUpdatedAt: "2026-05-09T00:00:00.000Z",
    sizeBytes: 2_147_483_648,
    action: "reclaim",
    blockReasons: [],
    restoreLossSessionIds: [],
    removed: false,
    archived: false,
    ...overrides,
  };
}

function report(overrides: Partial<GcReport> = {}): GcReport {
  return {
    dryRun: true,
    olderThanDays: 30,
    statuses: ["completed", "killed", "stopped"],
    limit: 100,
    scanned: { sessions: 2131, groups: 938 },
    groups: [group()],
    totals: {
      groups: 1,
      records: 1,
      worktreesRemoved: 0,
      recordsArchived: 0,
      freedBytes: 2_147_483_648,
      errors: 0,
    },
    ...overrides,
  };
}

describe("formatBytes", () => {
  it("renders a dash for an unmeasured size", () => {
    expect(formatBytes(null)).toBe("-");
  });

  it("renders exact bytes below 1 KB and scaled units above it", () => {
    expect(formatBytes(0)).toBe("0 B");
    expect(formatBytes(512)).toBe("512 B");
    expect(formatBytes(1024)).toBe("1.0 KB");
    expect(formatBytes(2_147_483_648)).toBe("2.0 GB");
  });
});

describe("renderSessionGcResult", () => {
  it("shows scan counts, per-group age and size, and the dry-run notice", () => {
    const rendered = renderSessionGcResult(report());

    expect(rendered).toContain("Scanned 2131 record(s) in 938 group(s)");
    expect(rendered).toContain("older than 30d");
    expect(rendered).toContain("completed,killed,stopped");
    expect(rendered).toContain("reclaim");
    expect(rendered).toContain("84d");
    expect(rendered).toContain("2.0 GB");
    expect(rendered).toContain("/data/worktrees/api/api-1");
    expect(rendered).toContain("Dry run — nothing removed. Re-run with --execute to apply.");
  });

  it("shows the block reason instead of the path for a blocked group", () => {
    const rendered = renderSessionGcResult(
      report({
        groups: [
          group({ action: "blocked", blockReasons: ["uncommitted_changes"], sizeBytes: null }),
        ],
      }),
    );

    expect(rendered).toContain("blocked");
    expect(rendered).toContain("uncommitted_changes");
    expect(rendered).not.toContain("/data/worktrees/api/api-1");
  });

  it("reports the freed total and drops the dry-run notice after an execute run", () => {
    const rendered = renderSessionGcResult(
      report({
        dryRun: false,
        groups: [group({ removed: true, archived: true })],
        totals: {
          groups: 1,
          records: 1,
          worktreesRemoved: 1,
          recordsArchived: 1,
          freedBytes: 2_147_483_648,
          errors: 0,
        },
      }),
    );

    expect(rendered).toContain(
      "1 worktree(s) removed, 1 record(s) archived, 2.0 GB freed, 0 error(s).",
    );
    expect(rendered).not.toContain("Dry run");
  });

  it("warns that collected stopped sessions lose their restore path", () => {
    const rendered = renderSessionGcResult(
      report({ groups: [group({ restoreLossSessionIds: ["api-1"] })] }),
    );

    expect(rendered).toContain("1 stopped session(s) lose `spur restore` once collected: api-1");
  });

  it("says nothing to collect when no group is planned", () => {
    const rendered = renderSessionGcResult(report({ groups: [] }));

    expect(rendered).toContain("Nothing to collect.");
  });

  it("surfaces a group error in place of its path", () => {
    const rendered = renderSessionGcResult(
      report({ groups: [group({ error: "git worktree remove failed" })] }),
    );

    expect(rendered).toContain("error: git worktree remove failed");
  });
});
