import { describe, expect, it } from "vitest";
import { collapseDeskRows, toDashboardSession, type SpurSessionView } from "@/lib/types";

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
  it("keeps one row per deskKey with anchor id === deskKey", () => {
    const root = baseView("root-a", { prompt: "parent" });
    const child = baseView("child-a", {
      deskId: "root-a",
      agent: "codex",
      prompt: "child",
    });
    const rows = collapseDeskRows(
      [root, child].map((s) => toDashboardSession(s, s.project)),
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].session.id).toBe("root-a");
    expect(rows[0].deskMemberCount).toBe(2);
  });

  it("uses worst attention lane across members", () => {
    const root = baseView("root-b", { state: "working", prompt: "ok" });
    const child = baseView("child-b", {
      deskId: "root-b",
      state: "needs_input",
      prompt: "blocked",
    });
    const rows = collapseDeskRows(
      [root, child].map((s) => toDashboardSession(s, s.project)),
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].lane).toBe("respond");
  });
});
