import { describe, expect, it } from "vitest";
import { _renderSidecarSweepResultForTests as renderSidecarSweepResult } from "../../src/cli.js";
import type { LeakedSidecarTree, SidecarSweepResult } from "../../src/sidecars/reap.js";

function tree(overrides: Partial<LeakedSidecarTree> & { rootPid: number }): LeakedSidecarTree {
  return {
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
});
