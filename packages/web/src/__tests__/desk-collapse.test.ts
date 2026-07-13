import { describe, expect, it } from "vitest";
import { collapseDeskRows, toDashboardSession, type SpurSessionView } from "@/lib/types.js";

function baseView(id: string, overrides: Partial<SpurSessionView> = {}): SpurSessionView {
  return {
    id,
    project: "p",
    agent: "claude",
    prompt: "task",
    branch: "main",
    worktree: true,
    tmuxSession: id,
    status: "running",
    state: "working",
    createdAt: "2026-01-02T10:00:00.000Z",
    updatedAt: "2026-01-02T10:00:00.000Z",
    lastActivityAt: "2026-01-02T10:00:00.000Z",
    runtimeAlive: true,
    workspaceExists: true,
    worktreePath: `/tmp/${id}`,
    ...overrides,
  };
}

describe("collapseDeskRows", () => {
  it("anchors the collapsed row to the last-active member", () => {
    const root = baseView("root-a", {
      prompt: "parent",
      lastActivityAt: "2026-01-02T11:00:00.000Z",
    });
    const child = baseView("child-a", {
      deskId: "root-a",
      agent: "codex",
      prompt: "child",
    });
    const rows = collapseDeskRows([root, child].map((s) => toDashboardSession(s, s.project)));
    expect(rows).toHaveLength(1);
    expect(rows[0].session.id).toBe("root-a");
    expect(rows[0].deskMemberCount).toBe(2);
  });

  it("collapsed desk anchors to the freshest active subagent", () => {
    const root = baseView("root-desk", { prompt: "parent" });
    const reviewer = baseView("child-review", {
      deskId: "root-desk",
      agent: "claude",
      prompt: "review",
      lastActivityAt: "2026-01-02T12:00:00.000Z",
    });
    const tester = baseView("child-test", {
      deskId: "root-desk",
      agent: "codex",
      prompt: "test",
    });

    const rows = collapseDeskRows(
      [root, reviewer, tester].map((s) => toDashboardSession(s, s.project)),
    );

    expect(rows).toHaveLength(1);
    expect(rows[0].session.id).toBe("child-review");
    expect(rows[0].deskMemberCount).toBe(3);
  });

  it("uses worst attention lane across members", () => {
    const root = baseView("root-b", { state: "working", prompt: "ok" });
    const child = baseView("child-b", {
      deskId: "root-b",
      state: "needs_input",
      prompt: "blocked",
    });
    const rows = collapseDeskRows([root, child].map((s) => toDashboardSession(s, s.project)));
    expect(rows).toHaveLength(1);
    expect(rows[0].lane).toBe("respond");
  });

  it("uses error lane when any member has error evidence", () => {
    const root = baseView("root-error", { state: "needs_input", prompt: "blocked" });
    const child = baseView("child-error", {
      deskId: "root-error",
      status: "stopped",
      state: "error",
      runtimeAlive: false,
      error: "agent exited 1",
      prompt: "failed",
    });
    const rows = collapseDeskRows([root, child].map((s) => toDashboardSession(s, s.project)));
    expect(rows).toHaveLength(1);
    expect(rows[0].lane).toBe("error");
  });

  it("sorts rows by lastActivityAt descending across desks", () => {
    const older = baseView("a-older", { lastActivityAt: "2026-01-01T00:00:00.000Z" });
    const newer = baseView("z-newer", { lastActivityAt: "2026-01-05T00:00:00.000Z" });
    const middle = baseView("m-mid", { lastActivityAt: "2026-01-03T00:00:00.000Z" });
    const rows = collapseDeskRows(
      [older, newer, middle].map((s) => toDashboardSession(s, s.project)),
    );
    expect(rows.map((r) => r.session.id)).toEqual(["z-newer", "m-mid", "a-older"]);
  });

  it("breaks ties on equal lastActivityAt using session id ascending", () => {
    const ts = "2026-01-04T12:00:00.000Z";
    const b = baseView("b-id", { lastActivityAt: ts });
    const a = baseView("a-id", { lastActivityAt: ts });
    const c = baseView("c-id", { lastActivityAt: ts });
    const rows = collapseDeskRows([b, a, c].map((s) => toDashboardSession(s, s.project)));
    expect(rows.map((r) => r.session.id)).toEqual(["a-id", "b-id", "c-id"]);
  });

  it("anchors to the active child when the root is completed", () => {
    const root = baseView("root-done", { prompt: "parent", status: "completed" });
    const child = baseView("child-done-active", {
      deskId: "root-done",
      status: "running",
      prompt: "child",
    });
    const rows = collapseDeskRows([root, child].map((s) => toDashboardSession(s, s.project)));
    expect(rows).toHaveLength(1);
    expect(rows[0].session.id).toBe("child-done-active");
    expect(rows[0].deskMemberCount).toBe(1);
  });

  it("anchors to the freshest active member among root and two children", () => {
    const root = baseView("root-fresh", {
      prompt: "parent",
      lastActivityAt: "2026-01-02T10:00:00.000Z",
    });
    const stale = baseView("child-stale", {
      deskId: "root-fresh",
      prompt: "stale",
      lastActivityAt: "2026-01-02T10:30:00.000Z",
    });
    const fresh = baseView("child-fresh", {
      deskId: "root-fresh",
      prompt: "fresh",
      lastActivityAt: "2026-01-02T11:30:00.000Z",
    });
    const rows = collapseDeskRows(
      [root, stale, fresh].map((s) => toDashboardSession(s, s.project)),
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].session.id).toBe("child-fresh");
    expect(rows[0].deskMemberCount).toBe(3);
  });

  it("falls back to the root when all members are terminal", () => {
    const root = baseView("root-term", { prompt: "parent", status: "completed" });
    const child = baseView("child-term", {
      deskId: "root-term",
      status: "killed",
      runtimeAlive: false,
      prompt: "child",
    });
    const rows = collapseDeskRows([root, child].map((s) => toDashboardSession(s, s.project)));
    expect(rows).toHaveLength(1);
    expect(rows[0].session.id).toBe("root-term");
    expect(rows[0].deskMemberCount).toBe(0);
  });

  it("counts only active members when the desk has a mix of active and terminal sessions", () => {
    const root = baseView("root-mixed", { prompt: "parent", status: "running" });
    const activeChild = baseView("child-mixed-active", {
      deskId: "root-mixed",
      status: "running",
      prompt: "active",
    });
    const completedChild = baseView("child-mixed-completed", {
      deskId: "root-mixed",
      status: "completed",
      runtimeAlive: false,
      prompt: "done",
    });
    const killedChild = baseView("child-mixed-killed", {
      deskId: "root-mixed",
      status: "killed",
      runtimeAlive: false,
      prompt: "killed",
    });
    const rows = collapseDeskRows(
      [root, activeChild, completedChild, killedChild].map((s) =>
        toDashboardSession(s, s.project),
      ),
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].deskMemberCount).toBe(2);
  });
});
