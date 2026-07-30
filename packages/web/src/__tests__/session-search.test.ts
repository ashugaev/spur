import { describe, expect, it } from "vitest";
import { sessionMatchesQuery, toDashboardSession, type SpurSessionView } from "@/lib/types.js";

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

describe("sessionMatchesQuery", () => {
  it("matches by PR link URL", () => {
    const view = baseView("s-pr", {
      slots: { links: [{ label: "PR", url: "https://github.com/org/repo/pull/1234" }] },
    });
    const session = toDashboardSession(view, view.project);
    expect(sessionMatchesQuery(session, "github.com/org/repo")).toBe(true);
  });

  it("matches by PR id substring in the URL", () => {
    const view = baseView("s-pr-id", {
      slots: { links: [{ label: "PR", url: "https://github.com/org/repo/pull/1234" }] },
    });
    const session = toDashboardSession(view, view.project);
    expect(sessionMatchesQuery(session, "1234")).toBe(true);
  });

  it("matches by Jira/tracker link URL", () => {
    const view = baseView("s-jira", {
      slots: { links: [{ label: "Jira", url: "https://acme.atlassian.net/browse/ABC-42" }] },
    });
    const session = toDashboardSession(view, view.project);
    expect(sessionMatchesQuery(session, "abc-42")).toBe(true);
  });

  it("matches by link label", () => {
    const view = baseView("s-label", {
      slots: { links: [{ label: "Design doc", url: "https://example.com/doc" }] },
    });
    const session = toDashboardSession(view, view.project);
    expect(sessionMatchesQuery(session, "design doc")).toBe(true);
  });

  it("matches by originalTaskPrompt (description)", () => {
    const view = baseView("s-desc", {
      originalTaskPrompt: "Investigate the flaky checkout test",
    });
    const session = toDashboardSession(view, view.project);
    expect(sessionMatchesQuery(session, "flaky checkout")).toBe(true);
  });

  it("does not crash when originalTaskPrompt is null", () => {
    const view = baseView("s-null-desc");
    const session = toDashboardSession(view, view.project);
    expect(session.originalTaskPrompt).toBeNull();
    expect(() => sessionMatchesQuery(session, "anything")).not.toThrow();
    expect(sessionMatchesQuery(session, "anything")).toBe(false);
  });

  it("matches by tag", () => {
    const view = baseView("s-tag", {
      slots: { tags: ["bug", "review"] },
    });
    const session = toDashboardSession(view, view.project);
    expect(sessionMatchesQuery(session, "review")).toBe(true);
  });

  it("matches case-insensitively when the caller passes a mixed-case query", () => {
    const view = baseView("s-mixed", {
      slots: { links: [{ label: "PR", url: "https://github.com/org/repo/pull/1234" }] },
    });
    const session = toDashboardSession(view, view.project);
    expect(sessionMatchesQuery(session, "GitHub.com/ORG")).toBe(true);
  });

  it("matches everything on an empty query, mirroring current dashboard behavior", () => {
    const view = baseView("s-empty");
    const session = toDashboardSession(view, view.project);
    expect(sessionMatchesQuery(session, "")).toBe(true);
  });

  it("returns false when no field matches", () => {
    const view = baseView("s-no-match", {
      slots: { links: [{ label: "PR", url: "https://github.com/org/repo/pull/1" }] },
      originalTaskPrompt: "unrelated description",
    });
    const session = toDashboardSession(view, view.project);
    expect(sessionMatchesQuery(session, "nonexistent-term")).toBe(false);
  });
});
