import { describe, expect, it, vi } from "vitest";
import {
  createSourceWorkbench,
  projectSourceSession,
  sourceSessionById,
} from "../../src/server.js";
import { SessionLifecycleError } from "../../src/session-lifecycle.js";
import { SessionResourceNotFoundError } from "../../src/session-service.js";
import type { SourceSpawnSessionRequest, SourceWorkbench } from "../../src/event-sources/types.js";
import type { ProjectListEntry, SessionView } from "../../src/types.js";

function session(overrides: Partial<SessionView> = {}): SessionView {
  return {
    id: "demo-1",
    project: "demo",
    agent: "codex",
    prompt: "task",
    branch: "feature/test",
    worktree: false,
    worktreePath: "/fixture",
    tmuxSession: "demo-1",
    launchCommand: "codex",
    status: "running",
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
    lastActivityAt: "2026-01-02T00:00:00Z",
    lifecycle: { instanceId: "test", revision: 0, operation: null },
    state: "needs_input",
    runtimeAlive: true,
    workspaceExists: true,
    artifacts: [],
    services: [],
    sidecars: [],
    ...overrides,
  };
}

function harness(current = session()) {
  const projects: ProjectListEntry[] = [
    { id: "demo", name: "Demo", configured: true, prefix: "demo", path: "/fixture" },
  ];
  const service = {
    listProjects: vi.fn(() => projects),
    launchOptions: vi.fn(async () => ({
      project: "demo",
      agent: "codex" as const,
      model: null,
      mode: null,
      modes: [],
    })),
    list: vi.fn(async () => [current]),
    get: vi.fn(async () => current),
    restore: vi.fn(async () => session()),
  };
  return { service, projects, workbench: createSourceWorkbench(service) };
}

describe("source workbench projection", () => {
  it("projects structured fields without exposing prompts or paths", () => {
    expect(
      projectSourceSession(
        session({ mode: "manager", model: "auto", slots: { title: "Checkout", links: [] } }),
      ),
    ).toEqual({
      id: "demo-1",
      project: "demo",
      agent: "codex",
      state: "needs_input",
      status: "running",
      lastActivityAt: "2026-01-02T00:00:00Z",
      runtimeAlive: true,
      canContinue: true,
      restorable: false,
      mode: "manager",
      model: "auto",
      title: "Checkout",
    });
  });

  it("pending lifecycle blocks both new actions without changing legacy inactive", () => {
    const pending = session({
      lifecycle: {
        instanceId: "test",
        revision: 1,
        operation: {
          operationId: "op",
          action: "restore",
          phase: "pending",
          targetIds: ["demo-1"],
          outcomes: [],
        },
      },
    });
    expect(projectSourceSession(pending)).toMatchObject({ canContinue: false, restorable: false });
    expect(projectSourceSession(pending)).not.toHaveProperty("inactive");
    expect(
      projectSourceSession(session({ state: "stopped", status: "stopped", runtimeAlive: false })),
    ).toMatchObject({ inactive: true, canContinue: false, restorable: true });
  });

  it.each([
    { status: "completed", state: "stopped" },
    { status: "killed", state: "killed" },
    { status: "running", state: "error" },
    { status: "stopped", state: "stopped", workspaceExists: false },
  ] as const)("does not restore ineligible sessions %o", (overrides) => {
    expect(projectSourceSession(session(overrides)).restorable).toBe(false);
  });

  it("keeps core send eligibility for a live server error wedge", () => {
    expect(
      projectSourceSession(
        session({ state: "error", status: "running", error: "server_error: overloaded" }),
      ),
    ).toMatchObject({ canContinue: true });
  });

  it("prefers the PR binding and otherwise accepts a safe slot URL", () => {
    const slots = { links: [{ label: "pr", url: "https://example.org/slot" }] };
    expect(
      projectSourceSession(
        session({ slots, pr: { number: 1, repo: "owner/repo", url: "https://example.org/bound" } }),
      ).prUrl,
    ).toBe("https://example.org/bound");
    expect(projectSourceSession(session({ slots })).prUrl).toBe("https://example.org/slot");
  });

  it.each([
    "javascript:alert(1)",
    "file:///fixture",
    "https://user:secret@example.org/pr",
    "not a URL",
  ])("rejects unsafe PR URL %s", (url) => {
    expect(
      projectSourceSession(session({ slots: { links: [{ label: "pr", url }] } })),
    ).not.toHaveProperty("prUrl");
  });
});

describe("source workbench adapter", () => {
  it("opts into completed rows only for the workbench list", async () => {
    const { service, workbench } = harness(
      session({ status: "completed", state: "stopped", runtimeAlive: false }),
    );
    expect(await workbench.listSessions()).toMatchObject([
      { status: "completed", restorable: false },
    ]);
    expect(service.list).toHaveBeenCalledWith({ view: "dashboard", includeCompleted: true });
  });

  it("forwards exact launch options and rejects removed/unconfigured/shepherd projects", async () => {
    const { service, projects, workbench } = harness();
    await workbench.launchOptions({ project: "demo", agent: "claude", mode: "manager" });
    expect(service.launchOptions).toHaveBeenCalledWith({
      project: "demo",
      agent: "claude",
      mode: "manager",
    });
    const project = projects[0];
    if (!project) throw new Error("Missing fixture project");
    project.configured = false;
    await expect(workbench.launchOptions({ project: "demo" })).rejects.toThrow(
      "no longer available",
    );
    project.configured = true;
    project.kind = "shepherd";
    await expect(workbench.launchOptions({ project: "demo" })).rejects.toThrow(
      "no longer available",
    );
  });

  it("gets exact ids and restores through core with no override arguments", async () => {
    const { service, workbench } = harness(
      session({ state: "stopped", status: "stopped", runtimeAlive: false }),
    );
    await workbench.getSession("demo-1");
    expect(service.get).toHaveBeenCalledWith("demo-1");
    expect(
      await workbench.restoreSession({ sessionId: "demo-1", expectedProject: "demo" }),
    ).toMatchObject({ id: "demo-1", canContinue: true });
    expect(service.restore.mock.calls).toEqual([["demo-1"]]);
  });

  it.each(["project", "id", "pending", "unavailable", "running"])(
    "refuses restore on %s drift",
    async (drift) => {
      const current = session({ state: "stopped", status: "stopped", runtimeAlive: false });
      const { service, projects, workbench } = harness(current);
      if (drift === "project") current.project = "other";
      if (drift === "id") current.id = "other-1";
      if (drift === "unavailable") projects.length = 0;
      if (drift === "running") current.state = "working";
      if (drift === "pending")
        current.lifecycle.operation = {
          operationId: "op",
          action: "restore",
          phase: "pending",
          targetIds: [current.id],
          outcomes: [],
        };
      await expect(
        workbench.restoreSession({ sessionId: "demo-1", expectedProject: "demo" }),
      ).rejects.toThrow();
      expect(service.restore).not.toHaveBeenCalled();
    },
  );

  it("rejects missing sessions without restoring", async () => {
    const { service, workbench } = harness();
    service.get.mockRejectedValueOnce(new Error("gone"));
    await expect(
      workbench.restoreSession({ sessionId: "demo-1", expectedProject: "demo" }),
    ).rejects.toThrow("gone");
    expect(service.restore).not.toHaveBeenCalled();
  });
});

function lifecycleError(code: "session_lifecycle_snapshot_changed" | "session_lifecycle_conflict") {
  return new SessionLifecycleError(code, 503, {
    code,
    lifecycle: { instanceId: "test", revision: 1, operation: null },
  });
}

describe("sourceSessionById", () => {
  const pendingRestore = {
    operationId: "op-1",
    action: "restore" as const,
    phase: "pending" as const,
    targetIds: ["demo-1"],
    outcomes: [],
  };

  it.each([
    ["running", session(), true],
    ["completed", session({ status: "completed" }), false],
    ["killed", session({ status: "killed" }), false],
    ["killed with retainInList", session({ status: "killed", retainInList: true }), true],
    [
      "killed with pending restore",
      session({
        status: "killed",
        lifecycle: { instanceId: "test", revision: 1, operation: pendingRestore },
      }),
      true,
    ],
  ])("%s -> listed %s", async (_name, view, listed) => {
    const service = { get: vi.fn(async () => view) };
    const item = await sourceSessionById(service, "demo-1");
    expect(item === null).toBe(!listed);
    if (item) expect(item.id).toBe("demo-1");
  });

  it("marks a retained killed session inactive", async () => {
    const service = {
      get: vi.fn(async () => session({ status: "killed", state: "killed", retainInList: true })),
    };
    expect(await sourceSessionById(service, "demo-1")).toMatchObject({ inactive: true });
  });

  it("returns null when the session is missing", async () => {
    const service = {
      get: vi.fn(async () => {
        throw new SessionResourceNotFoundError("gone");
      }),
    };
    expect(await sourceSessionById(service, "demo-1")).toBeNull();
  });

  it("retries once after a snapshot change", async () => {
    const get = vi
      .fn()
      .mockRejectedValueOnce(lifecycleError("session_lifecycle_snapshot_changed"))
      .mockResolvedValueOnce(session());
    expect(await sourceSessionById({ get }, "demo-1")).toMatchObject({ id: "demo-1" });
    expect(get).toHaveBeenCalledTimes(2);
  });

  it("returns null when the retry finds the session gone", async () => {
    const get = vi
      .fn()
      .mockRejectedValueOnce(lifecycleError("session_lifecycle_snapshot_changed"))
      .mockRejectedValueOnce(new SessionResourceNotFoundError("gone"));
    expect(await sourceSessionById({ get }, "demo-1")).toBeNull();
    expect(get).toHaveBeenCalledTimes(2);
  });

  it("rethrows a second snapshot change", async () => {
    const error = lifecycleError("session_lifecycle_snapshot_changed");
    const get = vi.fn().mockRejectedValue(error);
    await expect(sourceSessionById({ get }, "demo-1")).rejects.toBe(error);
    expect(get).toHaveBeenCalledTimes(2);
  });

  it("does not retry other lifecycle errors", async () => {
    const error = lifecycleError("session_lifecycle_conflict");
    const get = vi.fn().mockRejectedValue(error);
    await expect(sourceSessionById({ get }, "demo-1")).rejects.toBe(error);
    expect(get).toHaveBeenCalledTimes(1);
  });
});

// Compile-time capability boundaries: neither transport can bypass core admission.
function requestShapes(workbench: SourceWorkbench): void {
  void workbench.restoreSession({
    sessionId: "s",
    expectedProject: "p",
    // @ts-expect-error restore has no budget override
    overrideTokenBudget: true,
  });
  // @ts-expect-error restore has no force override
  void workbench.restoreSession({ sessionId: "s", expectedProject: "p", force: true });
  // @ts-expect-error source spawn cannot select arbitrary configuration
  const spawn: SourceSpawnSessionRequest = { project: "p", configPath: "other" };
  // @ts-expect-error source spawn cannot bootstrap arbitrary projects
  const bootstrap: SourceSpawnSessionRequest = { project: "p", bootstrap: {} };
  void spawn;
  void bootstrap;
}
void requestShapes;
