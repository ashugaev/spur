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
      reaped: [{ sessionName: "leaked:500", panePid: 500, survivors: [], blindKill: false }],
    };
    const output = renderSidecarSweepResult(result);
    expect(output).toContain("[reaped]");
    expect(output).not.toContain("survivors");
  });

  it("marks a tree with survivors after the confirmation window as partial, not reaped", () => {
    const result: SidecarSweepResult = {
      supported: true,
      leaked: [tree({ rootPid: 500 })],
      reaped: [
        { sessionName: "leaked:500", panePid: 500, survivors: [501, 502], blindKill: false },
      ],
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

  // AC-f: the tree pid list and a total would-free RSS line.
  it("shows the tree pid list per line and a trailing total would-free RSS line", () => {
    const result: SidecarSweepResult = {
      supported: true,
      leaked: [
        tree({ rootPid: 500, tree: [500, 501, 502], treeRssKb: 4096 }),
        tree({ rootPid: 600, tree: [600], treeRssKb: 2048 }),
      ],
      reaped: [],
    };
    const output = renderSidecarSweepResult(result);
    const lines = output.split("\n");
    expect(lines[0]).toContain("tree [500,501,502]");
    expect(lines[1]).toContain("tree [600]");
    expect(lines.at(-1)).toContain("Total would-free: 6.0 MB");
  });

  it("AC11: marks an orphan-daemon row report-only, shows its configPath, and warns to verify before killing", () => {
    const result: SidecarSweepResult = {
      supported: true,
      leaked: [
        orphanDaemonTree({
          rootPid: 700,
          configPath: "/tmp/spur-isolated-daemon.abc/config.yaml",
          cliEntryPath: "/tmp/gone-checkout/v2/dist/cli.js",
          liveness: "not-serving",
        }),
      ],
      reaped: [],
    };
    const output = renderSidecarSweepResult(result);
    expect(output).toContain("[report-only] pid 700");
    expect(output).toContain("daemon /tmp/spur-isolated-daemon.abc/config.yaml");
    expect(output).toContain("verify it is genuinely dead before killing");
  });

  // N3 residual: a port probe that never ran ("unknown") is not proof of
  // death — it must never share the "genuinely dead"/"before killing"
  // phrasing with a probe that ran and found nothing (host-install.ts's
  // doctor check already makes this split; the sweep renderer must match).
  it("859/AC13: an orphan-daemon row with unresolved liveness never says genuinely dead, and flags itself as unconfirmed", () => {
    const result: SidecarSweepResult = {
      supported: true,
      leaked: [
        orphanDaemonTree({
          rootPid: 702,
          configPath: "/tmp/spur-isolated-daemon.ghi/config.yaml",
          cliEntryPath: "/tmp/gone-checkout/v2/dist/cli.js",
          liveness: "unknown",
        }),
      ],
      reaped: [],
    };
    const output = renderSidecarSweepResult(result);
    expect(output).not.toContain("genuinely dead");
    expect(output).toContain("liveness unknown");
    expect(output).toContain("verify manually before killing");
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
