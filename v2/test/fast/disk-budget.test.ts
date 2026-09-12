import { describe, expect, it } from "vitest";
import { measureDiskBudget, type DiskBudgetDeps } from "../../src/disk-budget.js";

const BASE_OPTIONS = {
  dataDir: "/data/spur",
  worktreeDir: "/data/spur/worktrees",
  home: "/home/user",
  xdgDataHome: "/home/user/.local/share",
  worktreePaths: [],
};

function fakeDu(sizes: Record<string, number | null>): DiskBudgetDeps["du"] {
  return async (path: string) => sizes[path] ?? null;
}

describe("measureDiskBudget", () => {
  it("AC1: root sizes and the total match the measured du bytes", async () => {
    const sizes: Record<string, number> = {
      "/data/spur/session-artifacts": 100,
      "/data/spur/worktrees": 200,
      "/data/spur/session-tools": 50,
      "/home/user/.local/share/opencode": 25,
      "/home/user/.npm/_cacache": 10_000,
      "/home/user/.npm/_npx": 800,
      "/home/user/.cache/ms-playwright": 300,
      "/home/user/.cache/ms-playwright-mcp": 150,
    };
    const report = await measureDiskBudget({ du: fakeDu(sizes) }, BASE_OPTIONS);

    for (const [path, sizeBytes] of Object.entries(sizes)) {
      const row = report.roots.find((r) => r.path === path);
      expect(row?.sizeBytes).toBe(sizeBytes);
      expect(row?.status).toBe("measured");
    }
    const expectedTotal = Object.values(sizes).reduce((a, b) => a + b, 0);
    expect(report.totals.attributableBytes).toBe(expectedTotal);
  });

  it("AC2: the four Spur stores are reported and reclaimedByDiskGc: false", async () => {
    const report = await measureDiskBudget({ du: fakeDu({}) }, BASE_OPTIONS);
    const reportOnlyIds = ["session-artifacts", "worktrees", "session-tools", "opencode-store"];
    for (const id of reportOnlyIds) {
      const row = report.roots.find((r) => r.id === id);
      expect(row).toBeDefined();
      expect(row?.reclaimedByDiskGc).toBe(false);
    }
  });

  it("absent root reports status absent, not measured-with-0", async () => {
    const report = await measureDiskBudget({ du: fakeDu({}) }, BASE_OPTIONS);
    const cacache = report.roots.find((r) => r.id === "npm-cacache");
    expect(cacache).toEqual({
      id: "npm-cacache",
      path: "/home/user/.npm/_cacache",
      sizeBytes: null,
      status: "absent",
      reclaimedByDiskGc: false,
      reclaimedBy: "spur cache",
    });
  });

  it("AC14: an aborted root reports unmeasured, never zero", async () => {
    const controller = new AbortController();
    controller.abort();
    const du: DiskBudgetDeps["du"] = async (_path, signal) => {
      if (signal?.aborted) {
        throw new Error("aborted");
      }
      return 0;
    };
    const report = await measureDiskBudget({ du }, { ...BASE_OPTIONS, signal: controller.signal });

    for (const row of report.roots) {
      if (row.id === "worktree-build-caches") continue;
      expect(row.status).toBe("unmeasured");
      expect(row.sizeBytes).toBeNull();
    }
    expect(report.totals.attributableBytes).toBe(0);
  });

  it("AC17: every root names its reclaiming owner", async () => {
    const report = await measureDiskBudget({ du: fakeDu({}) }, BASE_OPTIONS);
    const cacache = report.roots.find((r) => r.id === "npm-cacache");
    expect(cacache?.reclaimedBy).toBe("spur cache");
    const opencode = report.roots.find((r) => r.id === "opencode-store");
    expect(opencode?.reclaimedBy).toBe("none");
    expect(opencode?.reclaimedByDiskGc).toBe(false);
    const profiles = report.roots.find((r) => r.id === "playwright-mcp-profiles");
    expect(profiles?.reclaimedBy).toBe("disk-gc");
    expect(profiles?.reclaimedByDiskGc).toBe(true);
  });

  it("worktree-build-caches aggregates bytes across the injected worktree list", async () => {
    const du: DiskBudgetDeps["du"] = async (path) => (path.endsWith("webpack") ? 400 : null);
    const report = await measureDiskBudget(
      { du },
      {
        ...BASE_OPTIONS,
        worktreePaths: ["/data/spur/worktrees/api/s1"],
        listBuildCacheDirs: async () => [{ path: "/data/spur/worktrees/api/s1/.cache/webpack" }],
      },
    );
    const row = report.roots.find((r) => r.id === "worktree-build-caches");
    expect(row?.sizeBytes).toBe(400);
    expect(row?.status).toBe("measured");
  });
});
