import { describe, expect, it } from "vitest";
import { _renderSidecarSweepResultForTests as renderSidecarSweepResult } from "../../src/cli.js";
import type { LeakedSidecarTree, SidecarSweepResult } from "../../src/sidecars/reap.js";

type WorktreeTree = Extract<LeakedSidecarTree, { kind: "worktree-tree" }>;
type OrphanDaemonTree = Extract<LeakedSidecarTree, { kind: "orphan-daemon" }>;

function tree(overrides: Partial<WorktreeTree> & { rootPid: number }): WorktreeTree {
  return {
    kind: "worktree-tree",
    pgid: overrides.rootPid,
    ageSeconds: 120,
    worktreePath: "/tmp/spur-worktrees/api/api-1",
    args: "node dev-server.js",
    sidecarName: "dev",
    tree: [overrides.rootPid],
    treeRssKb: 4096,
    reapable: true,
    ...overrides,
  };
}

function orphanDaemonTree(
  overrides: Partial<OrphanDaemonTree> & { rootPid: number },
): OrphanDaemonTree {
  return {
    kind: "orphan-daemon",
    pgid: overrides.rootPid,
    ageSeconds: 120,
    worktreePath: "/tmp/gone-checkout",
    args: "node /tmp/gone-checkout/v2/dist/cli.js --config /tmp/config.yaml daemon start",
    tree: [overrides.rootPid],
    treeRssKb: 4096,
    reapable: false,
    configPath: "/tmp/config.yaml",
    cliEntryPath: "/tmp/gone-checkout/v2/dist/cli.js",
    port: null,
    liveness: "unknown",
    ...overrides,
  };
}

describe("renderSidecarSweepResult", () => {
  it("reports unsupported when the process table is unreadable", () => {
    const result: SidecarSweepResult = { supported: false, leaked: [], reaped: [] };
    expect(renderSidecarSweepResult(result)).toContain("unreadable");
  });

  it("reports no leaks found", () => {
    const result: SidecarSweepResult = { supported: true, leaked: [], reaped: [] };
    expect(renderSidecarSweepResult(result)).toContain("No leaked sidecar process trees found.");
  });

  it("marks a fully killed tree as reaped", () => {
    const result: SidecarSweepResult = {
      supported: true,
      leaked: [tree({ rootPid: 500 })],
      reaped: [{ sessionName: "leaked:500", panePid: 500, survivors: [] }],
    };
    const output = renderSidecarSweepResult(result);
    expect(output).toContain("[reaped]");
    expect(output).not.toContain("survivors");
  });

  it("marks a tree with survivors after the confirmation window as partial, not reaped", () => {
    const result: SidecarSweepResult = {
      supported: true,
      leaked: [tree({ rootPid: 500 })],
      reaped: [{ sessionName: "leaked:500", panePid: 500, survivors: [501, 502] }],
    };
    const output = renderSidecarSweepResult(result);
    expect(output).toContain("[partial]");
    expect(output).not.toContain("[reaped]");
    expect(output).toContain("survivors 501,502");
  });

  it("marks an untouched reapable tree as reapable, and a non-reapable one as report-only", () => {
    const result: SidecarSweepResult = {
      supported: true,
      leaked: [
        tree({ rootPid: 500, reapable: true }),
        tree({ rootPid: 600, reapable: false, sidecarName: null }),
      ],
      reaped: [],
    };
    const output = renderSidecarSweepResult(result);
    expect(output).toContain("[reapable] pid 500");
    expect(output).toContain("[report-only] pid 600");
  });

  it("AC11: marks an orphan-daemon row report-only, shows its configPath, and warns to verify before killing", () => {
    const result: SidecarSweepResult = {
      supported: true,
      leaked: [
        orphanDaemonTree({
          rootPid: 700,
          configPath: "/tmp/spur-isolated-daemon.abc/config.yaml",
          cliEntryPath: "/tmp/gone-checkout/v2/dist/cli.js",
        }),
      ],
      reaped: [],
    };
    const output = renderSidecarSweepResult(result);
    expect(output).toContain("[report-only] pid 700");
    expect(output).toContain("daemon /tmp/spur-isolated-daemon.abc/config.yaml");
    expect(output).toContain("verify it is genuinely dead before killing");
  });

  it("859/AC13: a serving orphan-daemon row never says genuinely dead / before killing, and names daemon stop", () => {
    const result: SidecarSweepResult = {
      supported: true,
      leaked: [
        orphanDaemonTree({
          rootPid: 701,
          configPath: "/tmp/spur-isolated-daemon.def/config.yaml",
          cliEntryPath: "/tmp/gone-checkout/v2/dist/cli.js",
          port: 4355,
          liveness: "serving",
        }),
      ],
      reaped: [],
    };
    const output = renderSidecarSweepResult(result);
    expect(output).not.toContain("genuinely dead");
    expect(output).not.toContain("before killing");
    expect(output).toContain("serving on 4355");
    expect(output).toContain("daemon stop");
    expect(output).toContain("/tmp/spur-isolated-daemon.def/config.yaml");
  });
});
