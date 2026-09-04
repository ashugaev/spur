// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@/lib/spur-daemon", () => ({
  SpurDaemonError: class SpurDaemonError extends Error {
    readonly status: number;

    constructor(message: string, status: number) {
      super(message);
      this.name = "SpurDaemonError";
      this.status = status;
    }
  },
  isSpurDaemonError: (error: unknown) =>
    error instanceof Error &&
    error.name === "SpurDaemonError" &&
    typeof (error as { status?: unknown }).status === "number",
  spurRequestJson: vi.fn(),
  spurRequest: vi.fn(),
  spurJsonInit: vi.fn((method: string, body?: unknown) => ({
    method,
    headers: { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  })),
}));

vi.mock("@/lib/voice", () => ({
  readVoiceStatus: vi.fn(),
  transcribeAudio: vi.fn(),
}));

vi.mock("node:fs/promises", () => ({
  readFile: vi.fn(),
  statfs: vi.fn(),
}));

// Prevent GitHub/GitLab status routes from shelling out to auth CLIs.
vi.mock("node:child_process", () => ({
  execFileSync: vi.fn(() => ""),
  execFile: vi.fn(
    (
      _cmd: string,
      _args: string[],
      _opts:
        | { timeout?: number; maxBuffer?: number }
        | ((error: Error | null, stdout: string, stderr: string) => void),
      cb?: (error: Error | null, stdout: string, stderr: string) => void,
    ) => {
      const callback = typeof _opts === "function" ? _opts : cb;
      callback?.(null, "", "");
    },
  ),
}));

import { SpurDaemonError, spurRequest, spurRequestJson } from "@/lib/spur-daemon";
import { readVoiceStatus, transcribeAudio } from "@/lib/voice";
import { readFile, statfs } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { resetGitHubApiStateForTests } from "@/lib/github-api";
import { resetGitHubStatusForTests } from "@/lib/github-status";
import { resetGitLabApiStateForTests } from "@/lib/gitlab-api";
import { resetGitLabStatusForTests } from "@/lib/gitlab-status";
import { resetResourceMonitoringForTests } from "@/lib/resource-monitoring";
import { GET as getGitHubStatus } from "@/app/api/github-status/route";
import { GET as getGitLabStatus } from "@/app/api/gitlab-status/route";
import { GET as listSessions } from "@/app/api/sessions/route";
import { GET as getSession } from "@/app/api/sessions/[id]/route";
import { GET as getSessionTodo } from "@/app/api/sessions/[id]/todo/route";
import { GET as getArtifact } from "@/app/api/sessions/[id]/artifacts/[...artifactId]/route";
import { POST as updateTags } from "@/app/api/sessions/[id]/tags/route";
import { POST as spawnSession } from "@/app/api/spawn/route";
import { POST as diagnoseUpdate } from "@/app/api/diagnose-update/route";
import { GET as runtimeVoiceStatus } from "@/app/api/runtime/voice/route";
import { GET as runtimeResources } from "@/app/api/runtime/resources/route";
import { POST as transcribeVoice } from "@/app/api/runtime/voice/transcribe/route";
import { POST as sendMessage } from "@/app/api/sessions/[id]/send/route";
import { POST as removeQueuedMessage } from "@/app/api/sessions/[id]/queue/remove/route";
import { POST as flushQueuedMessage } from "@/app/api/sessions/[id]/queue/flush/route";
import { POST as answerQuestion } from "@/app/api/sessions/[id]/answer/route";
import { POST as markOpened } from "@/app/api/sessions/[id]/opened/route";
import { POST as pauseSession } from "@/app/api/sessions/[id]/pause/route";
import { POST as completeSession } from "@/app/api/sessions/[id]/complete/route";
import { POST as killSession } from "@/app/api/sessions/[id]/kill/route";
import { POST as restoreSession } from "@/app/api/sessions/[id]/restore/route";
import { POST as reopenSession } from "@/app/api/sessions/[id]/reopen/route";
import { POST as respawnSession } from "@/app/api/sessions/[id]/respawn/route";
import { POST as handoffSession } from "@/app/api/sessions/[id]/handoff/route";
import { POST as startSidecar } from "@/app/api/sessions/[id]/sidecars/[name]/start/route";
import { POST as stopSidecar } from "@/app/api/sessions/[id]/sidecars/[name]/stop/route";
import { GET as getSessionLogs } from "@/app/api/sessions/[id]/logs/route";
import { GET as getPrStatus } from "@/app/api/pr-status/route";
import { POST as postPrStatusBatch } from "@/app/api/pr-status/batch/route";
import { POST as mergePr } from "@/app/api/pr-status/merge/route";
import { POST as runPreflight } from "@/app/api/preflight/route";
import { GET as getSessionConversation } from "@/app/api/sessions/[id]/conversation/route";
import { DELETE as deleteProject, PATCH as updateProject } from "@/app/api/projects/[id]/route";
import { POST as createProject } from "@/app/api/projects/route";
import { POST as switchAuth } from "@/app/api/sessions/[id]/switch-auth/route";
import { GET as listClaudeAccounts } from "@/app/api/claude-accounts/route";
import { GET as getSpawnDefaults } from "@/app/api/projects/[id]/spawn-defaults/route";
import { POST as postAutoUpdate } from "@/app/api/runtime/auto-update/route";

const mockedSpurRequestJson = vi.mocked(spurRequestJson);
const mockedSpurRequest = vi.mocked(spurRequest);
const mockedReadVoiceStatus = vi.mocked(readVoiceStatus);
const mockedTranscribeAudio = vi.mocked(transcribeAudio);
const mockedReadFile = vi.mocked(readFile);
const mockedStatfs = vi.mocked(statfs);
const platformDescriptor = Object.getOwnPropertyDescriptor(process, "platform");

function sessionFixture(overrides: Record<string, unknown> = {}) {
  return {
    id: "api-a1",
    project: "api",
    agent: "claude",
    prompt: "Fix auth",
    branch: "feat/auth",
    worktree: true,
    tmuxSession: "api-a1",
    status: "running",
    state: "working",
    createdAt: "2026-04-02T10:00:00.000Z",
    updatedAt: "2026-04-02T10:00:00.000Z",
    lastActivityAt: "2026-04-02T10:00:00.000Z",
    runtimeAlive: true,
    workspaceExists: true,
    worktreePath: "/tmp/api-a1",
    services: [],
    artifacts: [],
    ...overrides,
  };
}

function ghOk(body: unknown = { login: "spur" }) {
  return {
    ok: true,
    status: 200,
    headers: new Headers(),
    json: async () => body,
    text: async () => JSON.stringify(body),
  };
}

function ghErr(status: number, body: unknown = {}) {
  return {
    ok: false,
    status,
    headers: new Headers(),
    json: async () => body,
    text: async () => JSON.stringify(body),
  };
}

describe("Spur web API routes", () => {
  beforeEach(() => {
    mockedSpurRequestJson.mockReset();
    mockedSpurRequest.mockReset();
    mockedReadVoiceStatus.mockReset();
    mockedTranscribeAudio.mockReset();
    mockedReadFile.mockReset();
    mockedStatfs.mockReset();
    resetGitHubApiStateForTests();
    resetGitHubStatusForTests();
    resetGitLabApiStateForTests();
    resetGitLabStatusForTests();
    resetResourceMonitoringForTests();
    if (platformDescriptor) Object.defineProperty(process, "platform", platformDescriptor);
  });

  // ── GET /api/sessions ──────────────────────────────────────────────────

  it("GET /api/sessions returns all sessions when no project filter", async () => {
    mockedSpurRequestJson
      .mockResolvedValueOnce([
        sessionFixture(),
        sessionFixture({
          id: "done-1",
          status: "completed",
          state: "stopped",
          runtimeAlive: false,
          tmuxSession: null,
          worktreePath: "/tmp/done-1",
        }),
      ])
      .mockResolvedValueOnce([
        { id: "api", name: "API" },
        { id: "web", name: "Web" },
      ])
      .mockResolvedValueOnce([
        {
          provider: "jira",
          projectId: "api",
          backlogId: "features",
          externalId: "10001",
          key: "WEB-17",
          title: "Fix checkout",
          url: "https://jira.example.com/browse/WEB-17",
          fetchedAt: "2026-06-16T12:00:00.000Z",
          position: 0,
        },
      ]);

    const response = await listSessions(new NextRequest("http://localhost:3000/api/sessions"));
    const payload = (await response.json()) as {
      sessions: unknown[];
      backlog: unknown[];
      daemonAlive: boolean;
    };

    expect(response.status).toBe(200);
    expect(payload.sessions).toHaveLength(2);
    expect(payload.backlog).toHaveLength(1);
    expect(payload.daemonAlive).toBe(true);
    expect(mockedSpurRequestJson).toHaveBeenNthCalledWith(3, "/backlog/available");
    expect(mockedSpurRequestJson).toHaveBeenNthCalledWith(
      1,
      "/sessions?includeCompleted=1&view=dashboard",
    );
    expect(payload.sessions[1]).toMatchObject({ id: "done-1", status: "completed" });
  });

  it("GET /api/sessions returns only configured spawn project options", async () => {
    mockedSpurRequestJson
      .mockResolvedValueOnce([
        sessionFixture(),
        sessionFixture({
          id: "ops-a1",
          project: "ops",
          tmuxSession: "ops-a1",
          worktreePath: "/tmp/ops-a1",
        }),
      ])
      .mockResolvedValueOnce([{ id: "sp", name: "Spur Core" }])
      .mockResolvedValueOnce([]);

    const response = await listSessions(new NextRequest("http://localhost:3000/api/sessions"));
    const payload = (await response.json()) as { projects: Array<{ id: string; name: string }> };

    expect(response.status).toBe(200);
    expect(payload.projects).toEqual([{ id: "sp", name: "Spur Core" }]);
  });

  it("GET /api/sessions returns 502 when daemon fails", async () => {
    mockedSpurRequestJson.mockRejectedValue(new Error("Connection refused"));

    const response = await listSessions(new NextRequest("http://localhost:3000/api/sessions"));
    const payload = (await response.json()) as { error: string };

    expect(response.status).toBe(502);
    expect(payload.error).toBe("Connection refused");
  });

  it("GET /api/sessions preserves daemon validation status", async () => {
    mockedSpurRequestJson.mockRejectedValue(new SpurDaemonError("bad request", 400));

    const response = await listSessions(new NextRequest("http://localhost:3000/api/sessions"));
    const payload = (await response.json()) as { error: string };

    expect(response.status).toBe(400);
    expect(payload.error).toBe("bad request");
  });

  // ── GET /api/sessions/:id ──────────────────────────────────────────────

  it("GET /api/sessions/:id URL-encodes the session id", async () => {
    mockedSpurRequest.mockResolvedValue(
      new Response(JSON.stringify(sessionFixture({ id: "my/session 1" })), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );

    await getSession(new Request("http://localhost:3000/api/sessions/my%2Fsession%201"), {
      params: Promise.resolve({ id: "my/session 1" }),
    });

    expect(mockedSpurRequest).toHaveBeenCalledWith("/sessions/my%2Fsession%201");
  });

  it("GET /api/sessions/:id/todo preserves typed daemon errors", async () => {
    const payload = {
      code: "todo_ledger_corrupt",
      sessionId: "my/session 1",
      error: "Ledger truncated",
      line: 2,
    };
    mockedSpurRequest.mockResolvedValue(
      new Response(JSON.stringify(payload), {
        status: 500,
        headers: { "content-type": "application/json" },
      }),
    );
    const response = await getSessionTodo(new Request("http://localhost"), {
      params: Promise.resolve({ id: "my/session 1" }),
    });
    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toEqual(payload);
    expect(mockedSpurRequest).toHaveBeenCalledWith("/sessions/my%2Fsession%201/todo");
  });

  it("GET /api/sessions/:id/todo rejects malformed successful daemon payloads", async () => {
    mockedSpurRequest.mockResolvedValue(
      new Response(JSON.stringify({ status: "resolved", items: [] }), { status: 200 }),
    );

    const response = await getSessionTodo(new Request("http://localhost"), {
      params: Promise.resolve({ id: "api-1" }),
    });

    expect(response.status).toBe(502);
    await expect(response.json()).resolves.toEqual({
      error: "Invalid ToDo response from Spur daemon",
    });
  });

  // ── GET /api/sessions/:id/artifacts/:artifactId ────────────────────────

  it("GET /api/sessions/:id/artifacts/:artifactId keeps the daemon sandbox on html artifacts", async () => {
    mockedSpurRequest.mockResolvedValue(
      new Response("<h1>Report</h1>", {
        status: 200,
        headers: {
          "content-type": "text/html; charset=utf-8",
          "content-disposition": 'inline; filename="report.html"',
          "content-security-policy": "sandbox allow-scripts",
        },
      }),
    );

    const response = await getArtifact(
      new Request("http://localhost:3000/api/sessions/api-a1/artifacts/report.html"),
      { params: Promise.resolve({ id: "api-a1", artifactId: ["report.html"] }) },
    );

    expect(mockedSpurRequest).toHaveBeenCalledWith("/sessions/api-a1/artifacts/report.html");
    expect(response.headers.get("content-type")).toBe("text/html; charset=utf-8");
    expect(response.headers.get("content-disposition")).toBe('inline; filename="report.html"');
    expect(response.headers.get("content-security-policy")).toBe("sandbox allow-scripts");
  });

  it("GET /api/sessions/:id/artifacts/:artifactId sandboxes html a daemon served without a CSP", async () => {
    mockedSpurRequest.mockResolvedValue(
      new Response("<h1>Report</h1>", {
        status: 200,
        headers: { "content-type": "text/html; charset=utf-8" },
      }),
    );

    const response = await getArtifact(
      new Request("http://localhost:3000/api/sessions/api-a1/artifacts/report.html"),
      { params: Promise.resolve({ id: "api-a1", artifactId: ["report.html"] }) },
    );

    expect(response.headers.get("content-security-policy")).toBe(
      "sandbox allow-scripts allow-forms allow-popups allow-modals",
    );
  });

  it("GET /api/sessions/:id/artifacts/:artifactId leaves non-html artifacts unsandboxed", async () => {
    mockedSpurRequest.mockResolvedValue(
      new Response("png-bytes", {
        status: 200,
        headers: { "content-type": "image/png" },
      }),
    );

    const response = await getArtifact(
      new Request("http://localhost:3000/api/sessions/api-a1/artifacts/shot.png"),
      { params: Promise.resolve({ id: "api-a1", artifactId: ["shot.png"] }) },
    );

    expect(response.headers.get("content-security-policy")).toBeNull();
  });

  it("GET /api/sessions/:id/artifacts/:path forwards nested segments to the daemon", async () => {
    mockedSpurRequest.mockResolvedValue(
      new Response("# Spec", {
        status: 200,
        headers: { "content-type": "text/markdown; charset=utf-8" },
      }),
    );

    const response = await getArtifact(
      new Request("http://localhost:3000/api/sessions/api-a1/artifacts/design/design-spec.md"),
      { params: Promise.resolve({ id: "api-a1", artifactId: ["design", "design-spec.md"] }) },
    );

    expect(mockedSpurRequest).toHaveBeenCalledWith(
      "/sessions/api-a1/artifacts/design/design-spec.md",
    );
    expect(response.status).toBe(200);
  });

  // ── POST /api/spawn ────────────────────────────────────────────────────

  it("POST /api/spawn returns 400 when projectId is missing", async () => {
    const response = await spawnSession(
      new NextRequest("http://localhost:3000/api/spawn", {
        method: "POST",
        body: JSON.stringify({ prompt: "Do something" }),
      }),
    );

    expect(response.status).toBe(400);
    expect(mockedSpurRequestJson).not.toHaveBeenCalled();
  });

  it("POST /api/spawn returns 400 when projectId is blank", async () => {
    const response = await spawnSession(
      new NextRequest("http://localhost:3000/api/spawn", {
        method: "POST",
        body: JSON.stringify({ projectId: "   " }),
      }),
    );

    expect(response.status).toBe(400);
  });

  it("POST /api/spawn forwards optional fields: branch, planMode, steps, overrides, selfDestruct, mode", async () => {
    mockedSpurRequestJson.mockResolvedValue(sessionFixture());

    const response = await spawnSession(
      new NextRequest("http://localhost:3000/api/spawn", {
        method: "POST",
        body: JSON.stringify({
          projectId: "api",
          prompt: "Do work",
          agent: "cursor",
          branch: "feat/new",
          planMode: true,
          steps: ["step 1", "  ", "step 2"],
          overrides: { worktree: true },
          selfDestruct: { enabled: true, conditions: "daemon trims this" },
          mode: "manager",
        }),
      }),
    );

    expect(response.status).toBe(201);
    expect(mockedSpurRequestJson).toHaveBeenCalledWith(
      "/sessions/background",
      expect.objectContaining({ method: "POST" }),
    );
    const body = JSON.parse(String(mockedSpurRequestJson.mock.calls[0]?.[1]?.body));
    expect(body).toEqual({
      project: "api",
      prompt: "Do work",
      agent: "cursor",
      branch: "feat/new",
      planMode: true,
      selfDestruct: { enabled: true, conditions: "daemon trims this" },
      steps: ["step 1", "step 2"],
      overrides: { worktree: true },
      mode: "manager",
    });
  });

  it("POST /api/spawn omits mode when absent or blank", async () => {
    mockedSpurRequestJson.mockResolvedValue(sessionFixture());

    const response = await spawnSession(
      new NextRequest("http://localhost:3000/api/spawn", {
        method: "POST",
        body: JSON.stringify({ projectId: "api", prompt: "Do work", agent: "claude", mode: "  " }),
      }),
    );

    expect(response.status).toBe(201);
    const body = JSON.parse(String(mockedSpurRequestJson.mock.calls[0]?.[1]?.body));
    expect(body).not.toHaveProperty("mode");
  });

  it("POST /api/spawn forwards reuseWorkspaceSessionId with overrides", async () => {
    mockedSpurRequestJson.mockResolvedValue(sessionFixture());

    const response = await spawnSession(
      new NextRequest("http://localhost:3000/api/spawn", {
        method: "POST",
        body: JSON.stringify({
          projectId: "api",
          prompt: "Pair task",
          agent: "claude",
          reuseWorkspaceSessionId: " sess-a ",
          overrides: { worktree: true },
        }),
      }),
    );

    expect(response.status).toBe(201);
    expect(mockedSpurRequestJson).toHaveBeenCalledTimes(1);
    expect(mockedSpurRequestJson.mock.calls[0][0]).toBe("/sessions/background");
    const [, init] = mockedSpurRequestJson.mock.calls[0] as unknown as [string, { body?: string }];
    expect(JSON.parse(init.body ?? "{}")).toEqual({
      project: "api",
      prompt: "Pair task",
      agent: "claude",
      overrides: { worktree: true },
      reuseWorkspaceSessionId: "sess-a",
    });
  });

  it("POST /api/spawn filters out blank steps", async () => {
    mockedSpurRequestJson.mockResolvedValue(sessionFixture());

    await spawnSession(
      new NextRequest("http://localhost:3000/api/spawn", {
        method: "POST",
        body: JSON.stringify({ projectId: "api", steps: ["  ", "", "   "] }),
      }),
    );

    const body = JSON.parse(
      (mockedSpurRequestJson.mock.calls[0][1] as { body: string }).body,
    ) as Record<string, unknown>;
    expect(body).not.toHaveProperty("steps");
  });

  it("POST /api/spawn omits empty overrides object", async () => {
    mockedSpurRequestJson.mockResolvedValue(sessionFixture());

    await spawnSession(
      new NextRequest("http://localhost:3000/api/spawn", {
        method: "POST",
        body: JSON.stringify({ projectId: "api", overrides: {} }),
      }),
    );

    const body = JSON.parse(
      (mockedSpurRequestJson.mock.calls[0][1] as { body: string }).body,
    ) as Record<string, unknown>;
    expect(body).not.toHaveProperty("overrides");
  });

  it("POST /api/spawn preserves daemon validation status", async () => {
    mockedSpurRequestJson.mockRejectedValue(new SpurDaemonError("branch name is invalid", 400));

    const response = await spawnSession(
      new NextRequest("http://localhost:3000/api/spawn", {
        method: "POST",
        body: JSON.stringify({ projectId: "api", branch: "!!bad" }),
      }),
    );
    const payload = (await response.json()) as { error: string };

    expect(response.status).toBe(400);
    expect(payload.error).toBe("branch name is invalid");
  });

  // ── POST /api/diagnose-update ────────────────────────────────────────────

  it("POST /api/diagnose-update returns 400 when target is missing", async () => {
    const response = await diagnoseUpdate(
      new NextRequest("http://localhost:3000/api/diagnose-update", {
        method: "POST",
        body: JSON.stringify({}),
      }),
    );

    expect(response.status).toBe(400);
    expect(mockedSpurRequestJson).not.toHaveBeenCalled();
  });

  it("POST /api/diagnose-update returns 400 when target is blank", async () => {
    const response = await diagnoseUpdate(
      new NextRequest("http://localhost:3000/api/diagnose-update", {
        method: "POST",
        body: JSON.stringify({ target: "   " }),
      }),
    );

    expect(response.status).toBe(400);
    expect(mockedSpurRequestJson).not.toHaveBeenCalled();
  });

  it("POST /api/diagnose-update forwards prompt to /shepherd/spawn", async () => {
    mockedSpurRequestJson.mockResolvedValue({
      disposition: "reused",
      session: sessionFixture({ project: "spur-shepherd" }),
    });

    const response = await diagnoseUpdate(
      new NextRequest("http://localhost:3000/api/diagnose-update", {
        method: "POST",
        body: JSON.stringify({ target: "1.5.0" }),
      }),
    );

    expect(response.status).toBe(201);
    expect(mockedSpurRequestJson).toHaveBeenCalledWith(
      "/shepherd/spawn",
      expect.objectContaining({ method: "POST" }),
    );
    const body = JSON.parse(
      (mockedSpurRequestJson.mock.calls[0][1] as { body: string }).body,
    ) as Record<string, unknown>;
    expect(body.project).toBeUndefined();
    expect(body.agent).toBeUndefined();
    expect(body.prompt).toContain("1.5.0");
    expect(body.prompt).toContain("~/.spur/logs/install-and-restart.log");
    expect(body.reportDisposition).toBe(true);
  });

  it("POST /api/diagnose-update rejects an invalid daemon success body", async () => {
    mockedSpurRequestJson.mockResolvedValue({ id: "legacy-session-shape" });

    const response = await diagnoseUpdate(
      new NextRequest("http://localhost:3000/api/diagnose-update", {
        method: "POST",
        body: JSON.stringify({ target: "1.5.0" }),
      }),
    );
    const payload = (await response.json()) as { error: string };

    expect(response.status).toBe(502);
    expect(payload.error).toContain("invalid diagnostic-session response");
  });

  it("POST /api/diagnose-update preserves daemon error status", async () => {
    mockedSpurRequestJson.mockRejectedValue(new SpurDaemonError("daemon unavailable", 503));

    const response = await diagnoseUpdate(
      new NextRequest("http://localhost:3000/api/diagnose-update", {
        method: "POST",
        body: JSON.stringify({ target: "1.5.0" }),
      }),
    );
    const payload = (await response.json()) as { error: string };

    expect(response.status).toBe(503);
    expect(payload.error).toBe("daemon unavailable");
  });

  // ── POST /api/sessions/:id/send ────────────────────────────────────────

  it("POST /api/sessions/:id/send rejects empty messages", async () => {
    const response = await sendMessage(
      new NextRequest("http://localhost:3000/api/sessions/api-a1/send", {
        method: "POST",
        body: JSON.stringify({ message: "   " }),
      }),
      { params: Promise.resolve({ id: "api-a1" }) },
    );

    expect(response.status).toBe(400);
    expect(mockedSpurRequest).not.toHaveBeenCalled();
  });

  it("POST /api/sessions/:id/send rejects body with no message and no attachments", async () => {
    const response = await sendMessage(
      new NextRequest("http://localhost:3000/api/sessions/api-a1/send", {
        method: "POST",
        body: JSON.stringify({}),
      }),
      { params: Promise.resolve({ id: "api-a1" }) },
    );

    expect(response.status).toBe(400);
  });

  it("POST /api/sessions/:id/send accepts attachments with empty message", async () => {
    mockedSpurRequest.mockResolvedValue(
      new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    const attachments = [{ name: "img.png", data: "base64data" }];

    const response = await sendMessage(
      new NextRequest("http://localhost:3000/api/sessions/api-a1/send", {
        method: "POST",
        body: JSON.stringify({ message: "", attachments }),
      }),
      { params: Promise.resolve({ id: "api-a1" }) },
    );

    expect(response.status).toBe(200);
    expect(mockedSpurRequest).toHaveBeenCalledWith(
      "/sessions/api-a1/send",
      expect.objectContaining({
        body: JSON.stringify({ message: "", attachments }),
      }),
    );
  });

  it("send forwards a 409 rate-limited body and status verbatim", async () => {
    const conflict = { error: "Session api-a1 is rate limited" };
    mockedSpurRequest.mockResolvedValue(
      new Response(JSON.stringify(conflict), {
        status: 409,
        headers: { "content-type": "application/json" },
      }),
    );

    const response = await sendMessage(
      new NextRequest("http://localhost:3000/api/sessions/api-a1/send", {
        method: "POST",
        body: JSON.stringify({ message: "hello" }),
      }),
      { params: Promise.resolve({ id: "api-a1" }) },
    );

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual(conflict);
    expect(mockedSpurRequest).toHaveBeenCalledWith(
      "/sessions/api-a1/send",
      expect.objectContaining({ method: "POST" }),
    );
  });

  // ── POST /api/sessions/:id/queue/remove, .../queue/flush ────────────────

  it("POST /api/sessions/:id/queue/remove rejects an empty message", async () => {
    const response = await removeQueuedMessage(
      new NextRequest("http://localhost:3000/api/sessions/api-a1/queue/remove", {
        method: "POST",
        body: JSON.stringify({ message: "   " }),
      }),
      { params: Promise.resolve({ id: "api-a1" }) },
    );

    expect(response.status).toBe(400);
    expect(mockedSpurRequest).not.toHaveBeenCalled();
  });

  it("POST /api/sessions/:id/queue/flush rejects a missing message", async () => {
    const response = await flushQueuedMessage(
      new NextRequest("http://localhost:3000/api/sessions/api-a1/queue/flush", {
        method: "POST",
        body: JSON.stringify({}),
      }),
      { params: Promise.resolve({ id: "api-a1" }) },
    );

    expect(response.status).toBe(400);
    expect(mockedSpurRequest).not.toHaveBeenCalled();
  });

  it("queue/remove forwards a 404 (not queued) body and status verbatim", async () => {
    const notFound = { error: "Message not found in queue for api-a1" };
    mockedSpurRequest.mockResolvedValue(
      new Response(JSON.stringify(notFound), {
        status: 404,
        headers: { "content-type": "application/json" },
      }),
    );

    const response = await removeQueuedMessage(
      new NextRequest("http://localhost:3000/api/sessions/api-a1/queue/remove", {
        method: "POST",
        body: JSON.stringify({ message: "gone" }),
      }),
      { params: Promise.resolve({ id: "api-a1" }) },
    );

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toEqual(notFound);
    expect(mockedSpurRequest).toHaveBeenCalledWith(
      "/sessions/api-a1/queue/remove",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ message: "gone" }),
      }),
    );
  });

  it("queue/flush forwards a 409 (delivery in flight) body and status verbatim", async () => {
    const conflict = { error: "Delivery already in flight for api-a1" };
    mockedSpurRequest.mockResolvedValue(
      new Response(JSON.stringify(conflict), {
        status: 409,
        headers: { "content-type": "application/json" },
      }),
    );

    const response = await flushQueuedMessage(
      new NextRequest("http://localhost:3000/api/sessions/api-a1/queue/flush", {
        method: "POST",
        body: JSON.stringify({ message: "first" }),
      }),
      { params: Promise.resolve({ id: "api-a1" }) },
    );

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual(conflict);
    expect(mockedSpurRequest).toHaveBeenCalledWith(
      "/sessions/api-a1/queue/flush",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ message: "first" }),
      }),
    );
  });

  // ── POST /api/sessions/:id/answer ──────────────────────────────────────

  it("POST /api/sessions/:id/answer rejects a non-integer optionIndex", async () => {
    const response = await answerQuestion(
      new NextRequest("http://localhost:3000/api/sessions/api-a1/answer", {
        method: "POST",
        body: JSON.stringify({ optionIndex: 1.5 }),
      }),
      { params: Promise.resolve({ id: "api-a1" }) },
    );

    expect(response.status).toBe(400);
    expect(mockedSpurRequest).not.toHaveBeenCalled();
  });

  it("POST /api/sessions/:id/answer rejects a negative optionIndex", async () => {
    const response = await answerQuestion(
      new NextRequest("http://localhost:3000/api/sessions/api-a1/answer", {
        method: "POST",
        body: JSON.stringify({ optionIndex: -1 }),
      }),
      { params: Promise.resolve({ id: "api-a1" }) },
    );

    expect(response.status).toBe(400);
    expect(mockedSpurRequest).not.toHaveBeenCalled();
  });

  it("POST /api/sessions/:id/answer rejects a missing optionIndex", async () => {
    const response = await answerQuestion(
      new NextRequest("http://localhost:3000/api/sessions/api-a1/answer", {
        method: "POST",
        body: JSON.stringify({}),
      }),
      { params: Promise.resolve({ id: "api-a1" }) },
    );

    expect(response.status).toBe(400);
    expect(mockedSpurRequest).not.toHaveBeenCalled();
  });

  it("POST /api/sessions/:id/answer proxies a valid optionIndex to the daemon", async () => {
    mockedSpurRequest.mockResolvedValue(
      new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );

    const response = await answerQuestion(
      new NextRequest("http://localhost:3000/api/sessions/api-a1/answer", {
        method: "POST",
        body: JSON.stringify({ optionIndex: 2 }),
      }),
      { params: Promise.resolve({ id: "api-a1" }) },
    );

    expect(response.status).toBe(200);
    expect(mockedSpurRequest).toHaveBeenCalledWith(
      "/sessions/api-a1/answer",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ optionIndex: 2 }),
      }),
    );
  });

  it("answer forwards a non-2xx status and body verbatim", async () => {
    const conflict = { error: "Session is not running: api-a1" };
    mockedSpurRequest.mockResolvedValue(
      new Response(JSON.stringify(conflict), {
        status: 500,
        headers: { "content-type": "application/json" },
      }),
    );

    const response = await answerQuestion(
      new NextRequest("http://localhost:3000/api/sessions/api-a1/answer", {
        method: "POST",
        body: JSON.stringify({ optionIndex: 0 }),
      }),
      { params: Promise.resolve({ id: "api-a1" }) },
    );

    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toEqual(conflict);
  });

  // ── POST /api/sessions/:id/tags ────────────────────────────────────────

  it("POST /api/sessions/:id/tags proxies tag changes to the daemon slots endpoint", async () => {
    mockedSpurRequest.mockResolvedValue(
      new Response(JSON.stringify(sessionFixture()), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );

    const response = await updateTags(
      new NextRequest("http://localhost:3000/api/sessions/api-a1/tags", {
        method: "POST",
        body: JSON.stringify({ add: ["bug"], remove: ["docs"] }),
      }),
      { params: Promise.resolve({ id: "api-a1" }) },
    );

    expect(response.status).toBe(200);
    expect(mockedSpurRequest).toHaveBeenCalledWith(
      "/sessions/api-a1/slots",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ tags: ["bug"], untags: ["docs"] }),
      }),
    );
  });

  it("POST /api/sessions/:id/tags rejects an empty change set", async () => {
    const response = await updateTags(
      new NextRequest("http://localhost:3000/api/sessions/api-a1/tags", {
        method: "POST",
        body: JSON.stringify({}),
      }),
      { params: Promise.resolve({ id: "api-a1" }) },
    );

    expect(response.status).toBe(400);
  });

  // ── Lifecycle actions ──────────────────────────────────────────────────

  it("POST lifecycle actions proxy to Spur daemon", async () => {
    mockedSpurRequestJson.mockResolvedValue({ ok: true });
    mockedSpurRequest.mockImplementation(async () => {
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });

    const routes = [
      [markOpened, "opened"],
      [pauseSession, "pause"],
      [completeSession, "complete"],
      [killSession, "kill"],
      [restoreSession, "restore"],
      [reopenSession, "reopen"],
    ] as const;

    for (const [route, action] of routes) {
      const response = await route(
        new NextRequest(`http://localhost:3000/api/sessions/api-a1/${action}`, { method: "POST" }),
        { params: Promise.resolve({ id: "api-a1" }) },
      );
      expect(response.status).toBe(200);
    }

    expect(mockedSpurRequestJson).toHaveBeenCalledWith(
      "/sessions/api-a1/opened",
      expect.objectContaining({ method: "POST" }),
    );
    expect(mockedSpurRequestJson).toHaveBeenCalledWith(
      "/sessions/api-a1/pause",
      expect.objectContaining({ method: "POST" }),
    );
    expect(mockedSpurRequest).toHaveBeenCalledWith(
      "/sessions/api-a1/complete",
      expect.objectContaining({ method: "POST", body: JSON.stringify({}) }),
    );
    expect(mockedSpurRequest).toHaveBeenCalledWith(
      "/sessions/api-a1/kill",
      expect.objectContaining({ method: "POST", body: JSON.stringify({}) }),
    );
    expect(mockedSpurRequest).toHaveBeenCalledWith(
      "/sessions/api-a1/restore",
      expect.objectContaining({ method: "POST" }),
    );
    expect(mockedSpurRequest).toHaveBeenCalledWith(
      "/sessions/api-a1/reopen",
      expect.objectContaining({ method: "POST" }),
    );
  });

  it("reopen forwards a 409 not-reopenable conflict body and status verbatim", async () => {
    const conflict = { error: "Session api-a1 is running, not completed — use restore or respawn" };
    mockedSpurRequest.mockResolvedValue(
      new Response(JSON.stringify(conflict), {
        status: 409,
        headers: { "content-type": "application/json" },
      }),
    );

    const response = await reopenSession(
      new NextRequest("http://localhost:3000/api/sessions/api-a1/reopen", { method: "POST" }),
      { params: Promise.resolve({ id: "api-a1" }) },
    );

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual(conflict);
    expect(mockedSpurRequest).toHaveBeenCalledWith(
      "/sessions/api-a1/reopen",
      expect.objectContaining({ method: "POST" }),
    );
  });

  it("restore forwards a 409 not-restorable conflict body and status verbatim", async () => {
    const conflict = {
      code: "session_not_restorable",
      sessionId: "api-a1",
      reason: "Session api-a1 is not restorable",
      availableActions: ["force_kill", "respawn"],
    };
    mockedSpurRequest.mockResolvedValue(
      new Response(JSON.stringify(conflict), {
        status: 409,
        headers: { "content-type": "application/json" },
      }),
    );

    const response = await restoreSession(
      new NextRequest("http://localhost:3000/api/sessions/api-a1/restore", { method: "POST" }),
      { params: Promise.resolve({ id: "api-a1" }) },
    );

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual(conflict);
    expect(mockedSpurRequest).toHaveBeenCalledWith(
      "/sessions/api-a1/restore",
      expect.objectContaining({ method: "POST" }),
    );
  });

  it("POST /api/spawn forwards slots.links to /sessions/background", async () => {
    mockedSpurRequestJson.mockResolvedValue(sessionFixture());

    await spawnSession(
      new NextRequest("http://localhost:3000/api/spawn", {
        method: "POST",
        body: JSON.stringify({
          projectId: "api",
          prompt: "Work on WEB-17",
          slots: { links: [{ label: "tracker", url: "https://jira.example.com/browse/WEB-17" }] },
        }),
      }),
    );

    const body = JSON.parse(
      (mockedSpurRequestJson.mock.calls[0][1] as { body: string }).body,
    ) as Record<string, unknown>;
    expect(body.slots).toEqual({
      links: [{ label: "tracker", url: "https://jira.example.com/browse/WEB-17" }],
    });
  });

  it("POST /api/spawn omits slots when not provided", async () => {
    mockedSpurRequestJson.mockResolvedValue(sessionFixture());

    await spawnSession(
      new NextRequest("http://localhost:3000/api/spawn", {
        method: "POST",
        body: JSON.stringify({ projectId: "api", prompt: "hi" }),
      }),
    );

    const body = JSON.parse(
      (mockedSpurRequestJson.mock.calls[0][1] as { body: string }).body,
    ) as Record<string, unknown>;
    expect(body).not.toHaveProperty("slots");
  });

  it("complete and kill forward PR actions and preserve daemon conflicts", async () => {
    const conflict = {
      code: "open_pr_action_required",
      sessionId: "api-a1",
      pr: {
        number: 42,
        title: "Fix checkout",
        url: "https://github.com/acme/api/pull/42",
      },
    };
    mockedSpurRequest.mockImplementation(async () => {
      return new Response(JSON.stringify(conflict), {
        status: 409,
        headers: { "content-type": "application/json" },
      });
    });

    const completeResponse = await completeSession(
      new NextRequest("http://localhost:3000/api/sessions/api-a1/complete", {
        method: "POST",
        body: JSON.stringify({ prAction: "leave_open" }),
      }),
      { params: Promise.resolve({ id: "api-a1" }) },
    );
    const killResponse = await killSession(
      new NextRequest("http://localhost:3000/api/sessions/api-a1/kill", {
        method: "POST",
        body: JSON.stringify({ force: true, prAction: "close" }),
      }),
      { params: Promise.resolve({ id: "api-a1" }) },
    );

    expect(completeResponse.status).toBe(409);
    await expect(completeResponse.json()).resolves.toEqual(conflict);
    expect(killResponse.status).toBe(409);
    await expect(killResponse.json()).resolves.toEqual(conflict);
    expect(mockedSpurRequest).toHaveBeenCalledWith(
      "/sessions/api-a1/complete",
      expect.objectContaining({
        body: JSON.stringify({ prAction: "leave_open" }),
      }),
    );
    expect(mockedSpurRequest).toHaveBeenCalledWith(
      "/sessions/api-a1/kill",
      expect.objectContaining({
        body: JSON.stringify({ force: true, prAction: "close" }),
      }),
    );
  });

  it("POST /api/sessions/:id/complete forwards desk scope to daemon", async () => {
    mockedSpurRequest.mockResolvedValue(
      new Response(JSON.stringify({ completedIds: ["api-a1"] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );

    const response = await completeSession(
      new NextRequest("http://localhost:3000/api/sessions/api-a1/complete", {
        method: "POST",
        body: JSON.stringify({ scope: "desk" }),
      }),
      { params: Promise.resolve({ id: "api-a1" }) },
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ completedIds: ["api-a1"] });
    expect(mockedSpurRequest).toHaveBeenCalledWith(
      "/sessions/api-a1/complete",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ scope: "desk" }),
      }),
    );
  });

  it("POST /api/sessions/:id/complete drops a ToDo override reason the daemon no longer takes", async () => {
    mockedSpurRequest.mockResolvedValue(
      new Response(JSON.stringify(sessionFixture()), { status: 200 }),
    );
    await completeSession(
      new NextRequest("http://localhost/api/sessions/api-a1/complete", {
        method: "POST",
        body: JSON.stringify({ todoOverrideReason: "Operator accepted risk" }),
      }),
      { params: Promise.resolve({ id: "api-a1" }) },
    );
    expect(mockedSpurRequest).toHaveBeenCalledWith(
      "/sessions/api-a1/complete",
      expect.objectContaining({ body: JSON.stringify({}) }),
    );
  });

  it("POST /api/sessions/:id/complete rejects invalid scope before proxying", async () => {
    const response = await completeSession(
      new NextRequest("http://localhost:3000/api/sessions/api-a1/complete", {
        method: "POST",
        body: JSON.stringify({ scope: "project" }),
      }),
      { params: Promise.resolve({ id: "api-a1" }) },
    );

    expect(response.status).toBe(400);
    expect(mockedSpurRequestJson).not.toHaveBeenCalled();
  });

  // ── POST /api/sessions/:id/respawn ─────────────────────────────────────

  it("POST /api/sessions/:id/respawn forwards terminateSessionId to daemon", async () => {
    mockedSpurRequestJson.mockResolvedValue(sessionFixture({ id: "api-b2" }));

    const response = await respawnSession(
      new Request("http://localhost:3000/api/sessions/api-source/respawn", {
        method: "POST",
        body: JSON.stringify({ terminateSessionId: " api-caller " }),
      }),
      { params: Promise.resolve({ id: "api-source" }) },
    );

    expect(response.status).toBe(200);
    expect(JSON.parse((mockedSpurRequestJson.mock.calls[0]?.[1] as { body: string }).body)).toEqual(
      { terminateSessionId: "api-caller" },
    );
  });

  it("POST /api/sessions/:id/respawn drops invalid agent values", async () => {
    mockedSpurRequestJson.mockResolvedValue(sessionFixture({ id: "api-b2" }));

    await respawnSession(
      new Request("http://localhost:3000/api/sessions/api-a1/respawn", {
        method: "POST",
        body: JSON.stringify({
          prompt: "Retry",
          agent: "not-an-agent",
        }),
      }),
      { params: Promise.resolve({ id: "api-a1" }) },
    );

    const body = JSON.parse(
      (mockedSpurRequestJson.mock.calls[0]?.[1] as { body: string }).body,
    ) as Record<string, unknown>;
    expect("agent" in body).toBe(false);
    expect(body.prompt).toBe("Retry");
  });

  // ── POST /api/sessions/:id/handoff ─────────────────────────────────────

  it("POST /api/sessions/:id/handoff forwards agent, model, and notes", async () => {
    mockedSpurRequestJson.mockResolvedValue(sessionFixture({ id: "api-b3", agent: "cursor" }));

    const response = await handoffSession(
      new Request("http://localhost:3000/api/sessions/api-source/handoff", {
        method: "POST",
        body: JSON.stringify({
          agent: "cursor",
          model: "codex-model-id",
          notes: "Continue UI polish",
        }),
      }),
      { params: Promise.resolve({ id: "api-source" }) },
    );

    expect(response.status).toBe(200);
    expect(mockedSpurRequestJson).toHaveBeenCalledWith(
      "/sessions/api-source/handoff",
      expect.objectContaining({ method: "POST" }),
    );
    expect(JSON.parse((mockedSpurRequestJson.mock.calls[0]?.[1] as { body: string }).body)).toEqual(
      {
        agent: "cursor",
        model: "codex-model-id",
        notes: "Continue UI polish",
      },
    );
  });

  it("POST /api/sessions/:id/handoff requires agent", async () => {
    const response = await handoffSession(
      new Request("http://localhost:3000/api/sessions/api-source/handoff", {
        method: "POST",
        body: JSON.stringify({ notes: "missing agent" }),
      }),
      { params: Promise.resolve({ id: "api-source" }) },
    );

    expect(response.status).toBe(400);
    expect(mockedSpurRequestJson).not.toHaveBeenCalled();
  });

  it("POST /api/sessions/:id/handoff returns 502 on daemon error", async () => {
    mockedSpurRequestJson.mockRejectedValue(new Error("daemon unavailable"));

    const response = await handoffSession(
      new Request("http://localhost:3000/api/sessions/api-source/handoff", {
        method: "POST",
        body: JSON.stringify({ agent: "cursor" }),
      }),
      { params: Promise.resolve({ id: "api-source" }) },
    );

    expect(response.status).toBe(502);
  });

  // ── POST /api/sessions/:id/sidecars/:name/{start,stop} ────────────────

  it("POST /api/sessions/:id/sidecars/:name/start proxies to daemon", async () => {
    mockedSpurRequest.mockResolvedValue(
      new Response(JSON.stringify(sessionFixture()), { status: 200 }),
    );

    const response = await startSidecar(
      new Request("http://localhost:3000/api/sessions/api-a1/sidecars/dev/start", {
        method: "POST",
      }),
      { params: Promise.resolve({ id: "api-a1", name: "dev" }) },
    );

    expect(response.status).toBe(200);
    expect(mockedSpurRequest).toHaveBeenCalledWith(
      "/sessions/api-a1/sidecars/dev/start",
      expect.objectContaining({ method: "POST" }),
    );
  });

  it("POST /api/sessions/:id/sidecars/:name/start forwards clearPort and status", async () => {
    mockedSpurRequest.mockResolvedValue(
      new Response(
        JSON.stringify({
          code: "sidecar_port_busy",
          sidecarName: "dev",
          candidates: [
            {
              portId: "http",
              env: "SPUR_RESERVED_PORT_DEV",
              port: 3000,
            },
          ],
        }),
        { status: 409 },
      ),
    );

    const response = await startSidecar(
      new Request("http://localhost:3000/api/sessions/api-a1/sidecars/dev/start", {
        method: "POST",
        body: JSON.stringify({ clearPort: 3000 }),
      }),
      { params: Promise.resolve({ id: "api-a1", name: "dev" }) },
    );

    expect(response.status).toBe(409);
    expect(mockedSpurRequest).toHaveBeenCalledWith(
      "/sessions/api-a1/sidecars/dev/start",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ clearPort: 3000 }),
      }),
    );
  });

  it("POST /api/sessions/:id/sidecars/:name/stop proxies to daemon", async () => {
    mockedSpurRequestJson.mockResolvedValue(sessionFixture());

    const response = await stopSidecar(
      new Request("http://localhost:3000/api/sessions/api-a1/sidecars/dev/stop", {
        method: "POST",
      }),
      { params: Promise.resolve({ id: "api-a1", name: "dev" }) },
    );

    expect(response.status).toBe(200);
    expect(mockedSpurRequestJson).toHaveBeenCalledWith(
      "/sessions/api-a1/sidecars/dev/stop",
      expect.objectContaining({ method: "POST" }),
    );
  });

  it("POST /api/sessions/:id/sidecars/:name/start URL-encodes ids", async () => {
    mockedSpurRequest.mockResolvedValue(
      new Response(JSON.stringify(sessionFixture({ id: "api/a 1" })), { status: 200 }),
    );

    await startSidecar(
      new Request("http://localhost:3000/api/sessions/api%2Fa%201/sidecars/dev%2Fui/start", {
        method: "POST",
      }),
      { params: Promise.resolve({ id: "api/a 1", name: "dev/ui" }) },
    );

    expect(mockedSpurRequest).toHaveBeenCalledWith(
      "/sessions/api%2Fa%201/sidecars/dev%2Fui/start",
      expect.objectContaining({ method: "POST" }),
    );
  });

  it("POST /api/sessions/:id/sidecars/:name/stop returns 502 on daemon error", async () => {
    mockedSpurRequestJson.mockRejectedValue(new Error("Cannot stop sidecar"));

    const response = await stopSidecar(
      new Request("http://localhost:3000/api/sessions/api-a1/sidecars/dev/stop", {
        method: "POST",
      }),
      { params: Promise.resolve({ id: "api-a1", name: "dev" }) },
    );

    expect(response.status).toBe(502);
  });

  // ── GET /api/sessions/:id/logs ─────────────────────────────────────────

  it("GET /api/sessions/:id/logs returns logs from daemon", async () => {
    const logs = [{ line: "Starting..." }, { line: "Done" }];
    mockedSpurRequest.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => logs,
      text: async () => JSON.stringify(logs),
    } as unknown as Response);

    const response = await getSessionLogs(
      new Request("http://localhost:3000/api/sessions/api-a1/logs"),
      { params: Promise.resolve({ id: "api-a1" }) },
    );
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(payload).toEqual(logs);
    expect(mockedSpurRequest).toHaveBeenCalledWith("/sessions/api-a1/logs");
  });

  it("GET /api/sessions/:id/logs passes non-ok daemon status through", async () => {
    mockedSpurRequest.mockResolvedValue({
      ok: false,
      status: 404,
      text: async () => "not found",
    } as unknown as Response);

    const response = await getSessionLogs(
      new Request("http://localhost:3000/api/sessions/bad/logs"),
      { params: Promise.resolve({ id: "bad" }) },
    );

    expect(response.status).toBe(404);
  });

  it("GET /api/sessions/:id/logs returns 502 on network error", async () => {
    mockedSpurRequest.mockRejectedValue(new Error("Network timeout"));

    const response = await getSessionLogs(
      new Request("http://localhost:3000/api/sessions/api-a1/logs"),
      { params: Promise.resolve({ id: "api-a1" }) },
    );
    const payload = (await response.json()) as { error: string };

    expect(response.status).toBe(502);
    expect(payload.error).toBe("Network timeout");
  });

  // ── POST /api/preflight ────────────────────────────────────────────────

  it("POST /api/preflight returns suggested branch", async () => {
    mockedSpurRequestJson.mockResolvedValue({ branch: "feature/my-fix" });

    const response = await runPreflight(
      new NextRequest("http://localhost:3000/api/preflight", {
        method: "POST",
        body: JSON.stringify({ projectId: "api", prompt: "Fix the bug" }),
      }),
    );
    const payload = (await response.json()) as { branch: string };

    expect(response.status).toBe(200);
    expect(payload.branch).toBe("feature/my-fix");
    expect(mockedSpurRequestJson).toHaveBeenCalledWith(
      "/projects/api/preflight",
      expect.objectContaining({
        body: JSON.stringify({ project: "api", prompt: "Fix the bug" }),
      }),
    );
  });

  it("POST /api/preflight returns 400 when projectId missing", async () => {
    const response = await runPreflight(
      new NextRequest("http://localhost:3000/api/preflight", {
        method: "POST",
        body: JSON.stringify({ prompt: "Fix it" }),
      }),
    );

    expect(response.status).toBe(400);
    expect(mockedSpurRequestJson).not.toHaveBeenCalled();
  });

  it("POST /api/preflight returns 400 when prompt is missing", async () => {
    const response = await runPreflight(
      new NextRequest("http://localhost:3000/api/preflight", {
        method: "POST",
        body: JSON.stringify({ projectId: "api" }),
      }),
    );

    expect(response.status).toBe(400);
  });

  it("POST /api/preflight returns 400 when prompt is blank", async () => {
    const response = await runPreflight(
      new NextRequest("http://localhost:3000/api/preflight", {
        method: "POST",
        body: JSON.stringify({ projectId: "api", prompt: "   " }),
      }),
    );

    expect(response.status).toBe(400);
  });

  it("POST /api/preflight forwards agent and overrides when provided", async () => {
    mockedSpurRequestJson.mockResolvedValue({ branch: null });

    await runPreflight(
      new NextRequest("http://localhost:3000/api/preflight", {
        method: "POST",
        body: JSON.stringify({
          projectId: "api",
          prompt: "Do work",
          agent: "cursor",
          overrides: { worktree: true },
        }),
      }),
    );

    const body = JSON.parse(
      (mockedSpurRequestJson.mock.calls[0][1] as { body: string }).body,
    ) as Record<string, unknown>;
    expect(body).toMatchObject({ agent: "cursor", overrides: { worktree: true } });
  });

  it("POST /api/preflight returns 502 on daemon error", async () => {
    mockedSpurRequestJson.mockRejectedValue(new Error("Preflight failed"));

    const response = await runPreflight(
      new NextRequest("http://localhost:3000/api/preflight", {
        method: "POST",
        body: JSON.stringify({ projectId: "api", prompt: "Fix it" }),
      }),
    );

    expect(response.status).toBe(502);
  });

  it("POST /api/preflight treats rejected branch suggestions as no suggestion", async () => {
    mockedSpurRequestJson.mockRejectedValue(
      new Error('preflight branch "bad-name" must match ^feature/[a-z]+(-[a-z]+){0,3}$'),
    );

    const response = await runPreflight(
      new NextRequest("http://localhost:3000/api/preflight", {
        method: "POST",
        body: JSON.stringify({ projectId: "api", prompt: "Fix it" }),
      }),
    );
    const payload = (await response.json()) as { branch: string | null };

    expect(response.status).toBe(200);
    expect(payload.branch).toBeNull();
  });

  // ── GET /api/runtime/voice ─────────────────────────────────────────────

  it("GET /api/runtime/voice returns availability from server-side voice checks", async () => {
    mockedReadVoiceStatus.mockResolvedValue({
      available: true,
      provider: "whisper_cpp",
      model: "base",
      modelPath: "/models/ggml-base.en.bin",
      language: "auto",
    });

    const response = await runtimeVoiceStatus();
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(payload).toEqual({
      available: true,
      provider: "whisper_cpp",
      model: "base",
      modelPath: "/models/ggml-base.en.bin",
      language: "auto",
    });
  });

  it("GET /api/runtime/voice returns unavailable when voice is not configured", async () => {
    mockedReadVoiceStatus.mockResolvedValue({ available: false });

    const response = await runtimeVoiceStatus();
    const payload = (await response.json()) as { available: boolean };

    expect(response.status).toBe(200);
    expect(payload.available).toBe(false);
  });

  // ── POST /api/runtime/voice/transcribe ─────────────────────────────────

  it("POST /api/runtime/voice/transcribe validates audio and returns transcription", async () => {
    mockedTranscribeAudio.mockResolvedValue({
      text: "Fix the flaky test",
      provider: "whisper_cpp",
      model: "base",
      language: "auto",
      modelPath: "/models/ggml-base.en.bin",
    });

    const formData = new FormData();
    formData.append("audio", new File(["audio-bytes"], "voice.webm", { type: "audio/webm" }));

    const response = await transcribeVoice(
      new Request("http://localhost:3000/api/runtime/voice/transcribe", {
        method: "POST",
        body: formData,
      }),
    );
    const payload = (await response.json()) as {
      text: string;
      provider: string;
      model: string;
      language: string;
      modelPath?: string;
    };

    expect(response.status).toBe(200);
    expect(payload).toEqual({
      text: "Fix the flaky test",
      provider: "whisper_cpp",
      model: "base",
      language: "auto",
      modelPath: "/models/ggml-base.en.bin",
    });
    expect(mockedTranscribeAudio).toHaveBeenCalledWith(expect.any(Buffer), "voice.webm");
  });

  it("GET /api/runtime/resources returns metrics on linux after the first CPU baseline request", async () => {
    Object.defineProperty(process, "platform", { value: "linux" });
    let cpuReads = 0;
    mockedReadFile.mockImplementation(async (path: string) => {
      if (path === "/proc/stat") {
        cpuReads += 1;
        return cpuReads === 1
          ? "cpu  100 0 100 800 0 0 0 0 0 0\n"
          : "cpu  200 0 200 1200 0 0 0 0 0 0\n";
      }
      if (path === "/proc/meminfo") {
        return "MemTotal:       1000 kB\nMemAvailable:    250 kB\n";
      }
      throw new Error(`Unexpected path: ${path}`);
    });
    mockedStatfs.mockResolvedValue({
      blocks: 1000,
      bavail: 250,
    } as Awaited<ReturnType<typeof statfs>>);

    const firstResponse = await runtimeResources();
    expect(firstResponse.status).toBe(200);
    expect(await firstResponse.json()).toEqual({ available: false });

    const secondResponse = await runtimeResources();
    const secondPayload = (await secondResponse.json()) as {
      available: boolean;
      cpuPercent?: number;
      memoryPercent?: number;
      diskPercent?: number;
    };

    expect(secondResponse.status).toBe(200);
    expect(secondPayload).toEqual({
      available: true,
      cpuPercent: 33,
      memoryPercent: 75,
      diskPercent: 75,
    });
    expect(cpuReads).toBe(2);
    expect(mockedSpurRequestJson).not.toHaveBeenCalledWith("/projects");
  });

  it("GET /api/runtime/resources returns available:false on unsupported platforms and read errors", async () => {
    Object.defineProperty(process, "platform", { value: "darwin" });
    const unsupported = await runtimeResources();
    expect(unsupported.status).toBe(200);
    expect(await unsupported.json()).toEqual({ available: false });

    Object.defineProperty(process, "platform", { value: "linux" });
    mockedReadFile.mockRejectedValue(new Error("read failed"));
    const errored = await runtimeResources();
    expect(errored.status).toBe(200);
    expect(await errored.json()).toEqual({ available: false });
    expect(mockedSpurRequestJson).not.toHaveBeenCalledWith("/projects");
  });

  it("POST /api/runtime/voice/transcribe returns 400 when audio field is absent", async () => {
    const response = await transcribeVoice(
      new Request("http://localhost:3000/api/runtime/voice/transcribe", {
        method: "POST",
        body: new FormData(),
      }),
    );

    expect(response.status).toBe(400);
    expect(mockedTranscribeAudio).not.toHaveBeenCalled();
  });

  it("POST /api/runtime/voice/transcribe returns 400 when audio is a string not a file", async () => {
    const formData = new FormData();
    formData.append("audio", "not-a-file");

    const response = await transcribeVoice(
      new Request("http://localhost:3000/api/runtime/voice/transcribe", {
        method: "POST",
        body: formData,
      }),
    );

    expect(response.status).toBe(400);
  });

  it("POST /api/runtime/voice/transcribe returns 502 on transcription error", async () => {
    mockedTranscribeAudio.mockRejectedValue(new Error("Whisper failed"));

    const formData = new FormData();
    formData.append("audio", new File(["bytes"], "rec.webm", { type: "audio/webm" }));

    const response = await transcribeVoice(
      new Request("http://localhost:3000/api/runtime/voice/transcribe", {
        method: "POST",
        body: formData,
      }),
    );

    expect(response.status).toBe(502);
  });

  // ── GET /api/sessions/:id/conversation ────────────────────────────────

  it("GET /api/sessions/:id/conversation returns conversation payload from daemon", async () => {
    const conversation = { messages: [{ role: "user", content: "hi" }] };
    mockedSpurRequest.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => conversation,
      text: async () => JSON.stringify(conversation),
    } as unknown as Response);

    const response = await getSessionConversation(
      new NextRequest("http://localhost:3000/api/sessions/api-a1/conversation"),
      { params: Promise.resolve({ id: "api-a1" }) },
    );
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(payload).toEqual(conversation);
    expect(mockedSpurRequest).toHaveBeenCalledWith("/sessions/api-a1/conversation");
  });

  it("GET /api/sessions/:id/conversation forwards the from query param", async () => {
    const conversation = { messages: [], entries: [], startIndex: 120, totalEntries: 500 };
    mockedSpurRequest.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => conversation,
      text: async () => JSON.stringify(conversation),
    } as unknown as Response);

    await getSessionConversation(
      new NextRequest("http://localhost:3000/api/sessions/api-a1/conversation?from=120"),
      { params: Promise.resolve({ id: "api-a1" }) },
    );

    expect(mockedSpurRequest).toHaveBeenCalledWith("/sessions/api-a1/conversation?from=120");
  });

  it("GET /api/sessions/:id/conversation omits the from param when absent", async () => {
    mockedSpurRequest.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({}),
      text: async () => "{}",
    } as unknown as Response);

    await getSessionConversation(
      new NextRequest("http://localhost:3000/api/sessions/api-a1/conversation"),
      { params: Promise.resolve({ id: "api-a1" }) },
    );

    expect(mockedSpurRequest).toHaveBeenCalledWith("/sessions/api-a1/conversation");
  });

  it("GET /api/sessions/:id/conversation passes non-ok daemon status through", async () => {
    mockedSpurRequest.mockResolvedValue({
      ok: false,
      status: 404,
      text: async () => "not found",
    } as unknown as Response);

    const response = await getSessionConversation(
      new NextRequest("http://localhost:3000/api/sessions/missing/conversation"),
      { params: Promise.resolve({ id: "missing" }) },
    );

    expect(response.status).toBe(404);
  });

  it("GET /api/sessions/:id/conversation returns 502 on network error", async () => {
    mockedSpurRequest.mockRejectedValue(new Error("daemon down"));

    const response = await getSessionConversation(
      new NextRequest("http://localhost:3000/api/sessions/api-a1/conversation"),
      { params: Promise.resolve({ id: "api-a1" }) },
    );
    const payload = (await response.json()) as { error: string };

    expect(response.status).toBe(502);
    expect(payload.error).toBe("daemon down");
  });

  // ── DELETE /api/projects/:id ──────────────────────────────────────────

  it("DELETE /api/projects/:id proxies to daemon", async () => {
    mockedSpurRequest.mockResolvedValue({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ deleted: true }),
    } as unknown as Response);

    const response = await deleteProject(
      new Request("http://localhost:3000/api/projects/proj-1", { method: "DELETE" }),
      { params: Promise.resolve({ id: "proj-1" }) },
    );

    expect(response.status).toBe(200);
    expect(mockedSpurRequest).toHaveBeenCalledWith("/projects/proj-1", { method: "DELETE" });
  });

  it("DELETE /api/projects/:id surfaces upstream errors", async () => {
    mockedSpurRequest.mockResolvedValue({
      ok: false,
      status: 404,
      text: async () => JSON.stringify({ error: "not found" }),
    } as unknown as Response);

    const response = await deleteProject(
      new Request("http://localhost:3000/api/projects/missing", { method: "DELETE" }),
      { params: Promise.resolve({ id: "missing" }) },
    );
    const payload = (await response.json()) as { error: string };

    expect(response.status).toBe(404);
    expect(payload.error).toBe("not found");
  });

  it("DELETE /api/projects/:id returns 502 when a successful daemon response is invalid JSON", async () => {
    mockedSpurRequest.mockResolvedValue({
      ok: true,
      status: 200,
      text: async () => "deleted",
    } as unknown as Response);

    const response = await deleteProject(
      new Request("http://localhost:3000/api/projects/proj-1", { method: "DELETE" }),
      { params: Promise.resolve({ id: "proj-1" }) },
    );
    const payload = (await response.json()) as { error: string };

    expect(response.status).toBe(502);
    expect(payload.error).toBe("Spur daemon returned invalid JSON");
  });

  it("PATCH /api/projects/:id proxies to daemon", async () => {
    mockedSpurRequest.mockResolvedValue({
      ok: true,
      status: 200,
      text: async () =>
        JSON.stringify({
          id: "stub",
          entry: { id: "stub", name: "Stub Two" },
          projects: [],
        }),
    } as unknown as Response);

    const response = await updateProject(
      new Request("http://localhost:3000/api/projects/stub", {
        method: "PATCH",
        body: JSON.stringify({ displayName: "Stub Two", prefix: "stub2", path: "/tmp/stub" }),
      }),
      { params: Promise.resolve({ id: "stub" }) },
    );

    expect(response.status).toBe(200);
    expect(mockedSpurRequest).toHaveBeenCalledWith(
      "/projects/stub",
      expect.objectContaining({ method: "PATCH" }),
    );
  });

  it("PATCH /api/projects/:id returns 502 when a successful daemon response is invalid JSON", async () => {
    mockedSpurRequest.mockResolvedValue({
      ok: true,
      status: 200,
      text: async () => "updated",
    } as unknown as Response);

    const response = await updateProject(
      new Request("http://localhost:3000/api/projects/stub", {
        method: "PATCH",
        body: JSON.stringify({ displayName: "Stub Two", prefix: "stub2", path: "/tmp/stub" }),
      }),
      { params: Promise.resolve({ id: "stub" }) },
    );
    const payload = (await response.json()) as { error: string };

    expect(response.status).toBe(502);
    expect(payload.error).toBe("Spur daemon returned invalid JSON");
  });

  // ── POST /api/projects ────────────────────────────────────────────────

  it("POST /api/projects returns 201 on a valid body", async () => {
    mockedSpurRequest.mockResolvedValue({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ id: "proj-1" }),
    } as unknown as Response);

    const response = await createProject(
      new NextRequest("http://localhost:3000/api/projects", {
        method: "POST",
        body: JSON.stringify({ id: "proj-1", root: "/tmp/proj-1" }),
      }),
    );

    expect(response.status).toBe(201);
  });

  it("POST /api/projects returns 400 on invalid JSON", async () => {
    const response = await createProject(
      new NextRequest("http://localhost:3000/api/projects", {
        method: "POST",
        body: "not-json",
      }),
    );
    const payload = (await response.json()) as { error: string };

    expect(response.status).toBe(400);
    expect(payload.error).toBe("Invalid JSON body");
  });

  it("POST /api/projects returns 502 on daemon error", async () => {
    mockedSpurRequest.mockRejectedValue(new Error("boom"));

    const response = await createProject(
      new NextRequest("http://localhost:3000/api/projects", {
        method: "POST",
        body: JSON.stringify({ id: "proj-1", root: "/tmp/proj-1" }),
      }),
    );
    const payload = (await response.json()) as { error: string };

    expect(response.status).toBe(502);
    expect(payload.error).toBe("boom");
  });

  // ── GET /api/pr-status ─────────────────────────────────────────────────

  describe("GET /api/github-status", () => {
    const fetchMock = vi.fn();

    beforeEach(() => {
      resetGitHubStatusForTests();
      vi.stubGlobal("fetch", fetchMock);
      fetchMock.mockReset();
      process.env["GITHUB_TOKEN"] = "test-token";
    });

    afterEach(() => {
      vi.unstubAllGlobals();
      delete process.env["GITHUB_TOKEN"];
    });

    it("returns a healthy payload with the request timestamp", async () => {
      fetchMock.mockResolvedValue(ghOk());

      const response = await getGitHubStatus(
        new NextRequest("http://localhost:3000/api/github-status"),
      );
      const payload = (await response.json()) as {
        ok: boolean;
        requestedAt: string;
        configured: boolean;
      };

      expect(response.status).toBe(200);
      expect(payload.ok).toBe(true);
      expect(payload.configured).toBe(true);
      expect(payload.requestedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
      expect(fetchMock).toHaveBeenCalledWith(
        "https://api.github.com/user",
        expect.objectContaining({ method: "GET", cache: "no-store" }),
      );
    });

    it("returns an error payload when GitHub responds with an error", async () => {
      fetchMock.mockResolvedValue(ghErr(503));

      const response = await getGitHubStatus(
        new NextRequest("http://localhost:3000/api/github-status"),
      );
      const payload = (await response.json()) as {
        ok: boolean;
        error: string;
        requestedAt: string;
        configured: boolean;
      };

      expect(response.status).toBe(200);
      expect(payload.ok).toBe(false);
      expect(payload.configured).toBe(true);
      expect(payload.error).toBe("GitHub API 503");
      expect(payload.requestedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    });

    it("does not convert a normal GitHub error into a rate-limit error when headers are present", async () => {
      fetchMock.mockResolvedValueOnce({
        ok: false,
        status: 503,
        headers: new Headers({
          "x-ratelimit-reset": String(Math.floor((Date.now() + 30_000) / 1000)),
          "x-ratelimit-remaining": "4999",
        }),
        json: async () => ({ message: "upstream unavailable" }),
        text: async () => JSON.stringify({ message: "upstream unavailable" }),
      });

      const response = await getGitHubStatus(
        new NextRequest("http://localhost:3000/api/github-status"),
      );
      const payload = (await response.json()) as {
        ok: boolean;
        error: string;
        configured: boolean;
      };

      expect(response.status).toBe(200);
      expect(payload.ok).toBe(false);
      expect(payload.configured).toBe(true);
      expect(payload.error).toBe("upstream unavailable");
    });

    it("returns an auth error payload when no GitHub token is available", async () => {
      delete process.env["GITHUB_TOKEN"];

      const response = await getGitHubStatus(
        new NextRequest("http://localhost:3000/api/github-status"),
      );
      const payload = (await response.json()) as {
        ok: boolean;
        error: string;
        requestedAt: null;
        configured: boolean;
      };

      expect(response.status).toBe(200);
      expect(payload.ok).toBe(false);
      expect(payload.configured).toBe(false);
      expect(payload.error).toBe("GitHub auth unavailable");
      expect(payload.requestedAt).toBeNull();
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it("returns a network error payload when the request throws", async () => {
      fetchMock.mockRejectedValue(new Error("ECONNREFUSED"));

      const response = await getGitHubStatus(
        new NextRequest("http://localhost:3000/api/github-status"),
      );
      const payload = (await response.json()) as {
        ok: boolean;
        error: string;
        configured: boolean;
      };

      expect(response.status).toBe(200);
      expect(payload.ok).toBe(false);
      expect(payload.configured).toBe(true);
      expect(payload.error).toBe("ECONNREFUSED");
    });

    it("returns cached results for repeated requests", async () => {
      fetchMock.mockResolvedValue(ghOk());

      await getGitHubStatus(new NextRequest("http://localhost:3000/api/github-status"));
      const response = await getGitHubStatus(
        new NextRequest("http://localhost:3000/api/github-status"),
      );
      const payload = (await response.json()) as { ok: boolean; configured: boolean };

      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(payload.ok).toBe(true);
      expect(payload.configured).toBe(true);
    });
  });

  describe("GET /api/gitlab-status", () => {
    const fetchMock = vi.fn();

    beforeEach(() => {
      resetGitLabStatusForTests();
      vi.stubGlobal("fetch", fetchMock);
      fetchMock.mockReset();
      process.env["GITLAB_TOKEN"] = "test-token";
      delete process.env["GLAB_TOKEN"];
    });

    afterEach(() => {
      vi.unstubAllGlobals();
      delete process.env["GITLAB_TOKEN"];
      delete process.env["GLAB_TOKEN"];
    });

    it("returns a healthy payload with the request timestamp", async () => {
      fetchMock.mockResolvedValue(ghOk());

      const response = await getGitLabStatus(
        new NextRequest("http://localhost:3000/api/gitlab-status"),
      );
      const payload = (await response.json()) as {
        ok: boolean;
        requestedAt: string;
        configured: boolean;
      };

      expect(response.status).toBe(200);
      expect(payload.ok).toBe(true);
      expect(payload.configured).toBe(true);
      expect(payload.requestedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
      expect(fetchMock).toHaveBeenCalledWith(
        "https://gitlab.com/api/v4/user",
        expect.objectContaining({ method: "GET", cache: "no-store" }),
      );
    });

    it("returns an error payload when GitLab responds with an error", async () => {
      fetchMock.mockResolvedValue(ghErr(503));

      const response = await getGitLabStatus(
        new NextRequest("http://localhost:3000/api/gitlab-status"),
      );
      const payload = (await response.json()) as {
        ok: boolean;
        error: string;
        requestedAt: string;
        configured: boolean;
      };

      expect(response.status).toBe(200);
      expect(payload.ok).toBe(false);
      expect(payload.configured).toBe(true);
      expect(payload.error).toBe("GitLab API 503");
      expect(payload.requestedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    });

    it("returns an auth error payload when no GitLab token is available", async () => {
      delete process.env["GITLAB_TOKEN"];
      delete process.env["GLAB_TOKEN"];

      const response = await getGitLabStatus(
        new NextRequest("http://localhost:3000/api/gitlab-status"),
      );
      const payload = (await response.json()) as {
        ok: boolean;
        error: string;
        requestedAt: null;
        configured: boolean;
      };

      expect(response.status).toBe(200);
      expect(payload.ok).toBe(false);
      expect(payload.configured).toBe(false);
      expect(payload.error).toBe("GitLab auth unavailable");
      expect(payload.requestedAt).toBeNull();
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it("returns a network error payload when the request throws", async () => {
      fetchMock.mockRejectedValue(new Error("ECONNREFUSED"));

      const response = await getGitLabStatus(
        new NextRequest("http://localhost:3000/api/gitlab-status"),
      );
      const payload = (await response.json()) as {
        ok: boolean;
        error: string;
        configured: boolean;
      };

      expect(response.status).toBe(200);
      expect(payload.ok).toBe(false);
      expect(payload.configured).toBe(true);
      expect(payload.error).toBe("ECONNREFUSED");
    });

    it("returns cached results for repeated requests", async () => {
      fetchMock.mockResolvedValue(ghOk());

      await getGitLabStatus(new NextRequest("http://localhost:3000/api/gitlab-status"));
      const response = await getGitLabStatus(
        new NextRequest("http://localhost:3000/api/gitlab-status"),
      );
      const payload = (await response.json()) as { ok: boolean; configured: boolean };

      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(payload.ok).toBe(true);
      expect(payload.configured).toBe(true);
    });

    it("uses glab config get fallback when env tokens are unset", async () => {
      delete process.env["GITLAB_TOKEN"];
      delete process.env["GLAB_TOKEN"];
      resetGitLabApiStateForTests();
      vi.mocked(execFileSync).mockImplementationOnce(((cmd: string, args: readonly string[]) => {
        expect(cmd).toBe("glab");
        expect(args).toEqual(["config", "get", "--host", "gitlab.com", "token"]);
        return "glpat-test\n";
      }) as unknown as typeof execFileSync);
      fetchMock.mockResolvedValue(ghOk());

      const response = await getGitLabStatus(
        new NextRequest("http://localhost:3000/api/gitlab-status"),
      );
      const payload = (await response.json()) as { ok: boolean; configured: boolean };

      expect(payload.ok).toBe(true);
      expect(payload.configured).toBe(true);
      expect(fetchMock).toHaveBeenCalledTimes(1);
      const [, init] = fetchMock.mock.calls[0] as [string, { headers: Record<string, string> }];
      expect(init.headers["private-token"]).toBe("glpat-test");
    });

    it("treats empty glab output as missing token", async () => {
      delete process.env["GITLAB_TOKEN"];
      delete process.env["GLAB_TOKEN"];
      resetGitLabApiStateForTests();
      vi.mocked(execFileSync).mockImplementationOnce((() => "") as unknown as typeof execFileSync);

      const response = await getGitLabStatus(
        new NextRequest("http://localhost:3000/api/gitlab-status"),
      );
      const payload = (await response.json()) as {
        ok: boolean;
        error: string;
        requestedAt: null;
        configured: boolean;
      };

      expect(payload.ok).toBe(false);
      expect(payload.configured).toBe(false);
      expect(payload.error).toBe("GitLab auth unavailable");
      expect(payload.requestedAt).toBeNull();
      expect(fetchMock).not.toHaveBeenCalled();
    });
  });

  describe("GET /api/pr-status", () => {
    const fetchMock = vi.fn();

    // Use a counter to generate unique PR numbers, avoiding module-level cache hits
    let prCounter = 1000;
    function nextPrUrl() {
      return `https://github.com/owner/repo/pull/${prCounter++}`;
    }

    beforeEach(() => {
      vi.stubGlobal("fetch", fetchMock);
      fetchMock.mockReset();
      process.env["GITHUB_TOKEN"] = "test-token";
      const reset = (globalThis as Record<string, unknown>)["__spurResetPrStatusCache"];
      if (typeof reset === "function") (reset as () => void)();
    });

    afterEach(() => {
      vi.unstubAllGlobals();
      delete process.env["GITHUB_TOKEN"];
      delete process.env["GITLAB_TOKEN"];
    });

    function makePrGql(overrides: Record<string, unknown> = {}) {
      return {
        data: {
          repository: {
            pullRequest: {
              state: "OPEN",
              isDraft: false,
              merged: false,
              mergeable: null,
              mergeStateStatus: null,
              reviewDecision: null,
              reviewThreads: { nodes: [] },
              commits: { nodes: [{ commit: { statusCheckRollup: null } }] },
              ...overrides,
            },
          },
        },
      };
    }

    it("returns 400 when url param is missing", async () => {
      const response = await getPrStatus(new NextRequest("http://localhost:3000/api/pr-status"));
      expect(response.status).toBe(400);
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it("returns 400 for a non-review URL", async () => {
      const response = await getPrStatus(
        new NextRequest(
          "http://localhost:3000/api/pr-status?url=https://gitlab.com/foo/bar/issues/1",
        ),
      );
      expect(response.status).toBe(400);
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it("returns GitLab MR status when given a GitLab merge request URL", async () => {
      process.env["GITLAB_TOKEN"] = "gitlab-token";
      fetchMock
        .mockResolvedValueOnce(
          ghOk({
            state: "opened",
            draft: false,
            merged_at: null,
          }),
        )
        .mockResolvedValueOnce(
          ghOk([
            { notes: [{ resolvable: true, resolved: false }] },
            { notes: [{ resolvable: true, resolved: true }] },
          ]),
        )
        .mockResolvedValueOnce(ghOk([{ status: "running" }]));

      const response = await getPrStatus(
        new NextRequest(
          "http://localhost:3000/api/pr-status?url=https://gitlab.com/acme/api/-/merge_requests/42",
        ),
      );
      const payload = (await response.json()) as {
        state: string;
        ciStatus: string | null;
        totalThreads: number;
        unresolvedThreads: number;
      };

      expect(response.status).toBe(200);
      expect(payload).toMatchObject({
        state: "open",
        ciStatus: "pending",
        totalThreads: 2,
        unresolvedThreads: 1,
        stale: false,
      });
      expect(typeof payload.fetchedAt).toBe("number");
    });

    it("returns closed state for a closed draft GitLab MR (closed outranks draft)", async () => {
      process.env["GITLAB_TOKEN"] = "gitlab-token";
      fetchMock
        .mockResolvedValueOnce(
          ghOk({
            state: "closed",
            draft: true,
            merged_at: null,
          }),
        )
        .mockResolvedValueOnce(ghOk([]))
        .mockResolvedValueOnce(ghOk([]));

      const response = await getPrStatus(
        new NextRequest(
          "http://localhost:3000/api/pr-status?url=https://gitlab.com/acme/api/-/merge_requests/43",
        ),
      );
      const payload = (await response.json()) as { state: string };

      expect(response.status).toBe(200);
      expect(payload.state).toBe("closed");
    });

    it("returns merged state for a merged draft GitLab MR (merged outranks draft and closed)", async () => {
      process.env["GITLAB_TOKEN"] = "gitlab-token";
      fetchMock
        .mockResolvedValueOnce(
          ghOk({
            state: "closed",
            draft: true,
            merged_at: "2026-01-01T00:00:00Z",
          }),
        )
        .mockResolvedValueOnce(ghOk([]))
        .mockResolvedValueOnce(ghOk([]));

      const response = await getPrStatus(
        new NextRequest(
          "http://localhost:3000/api/pr-status?url=https://gitlab.com/acme/api/-/merge_requests/44",
        ),
      );
      const payload = (await response.json()) as { state: string };

      expect(response.status).toBe(200);
      expect(payload.state).toBe("merged");
    });

    it("returns draft state for an open draft GitLab MR", async () => {
      process.env["GITLAB_TOKEN"] = "gitlab-token";
      fetchMock
        .mockResolvedValueOnce(
          ghOk({
            state: "opened",
            draft: true,
            merged_at: null,
          }),
        )
        .mockResolvedValueOnce(ghOk([]))
        .mockResolvedValueOnce(ghOk([]));

      const response = await getPrStatus(
        new NextRequest(
          "http://localhost:3000/api/pr-status?url=https://gitlab.com/acme/api/-/merge_requests/45",
        ),
      );
      const payload = (await response.json()) as { state: string };

      expect(response.status).toBe(200);
      expect(payload.state).toBe("draft");
    });

    it("returns 400 for a GitHub URL without a PR number", async () => {
      const response = await getPrStatus(
        new NextRequest("http://localhost:3000/api/pr-status?url=https://github.com/owner/repo"),
      );
      expect(response.status).toBe(400);
    });

    it("returns open state for an open non-draft PR", async () => {
      fetchMock.mockResolvedValue(ghOk(makePrGql()));

      const response = await getPrStatus(
        new NextRequest(`http://localhost:3000/api/pr-status?url=${nextPrUrl()}`),
      );
      const payload = (await response.json()) as { state: string; ciStatus: null };

      expect(response.status).toBe(200);
      expect(payload.state).toBe("open");
      expect(payload.ciStatus).toBeNull();
      expect(payload.canMerge).toBe(false);
    });

    it("returns draft state for a draft PR", async () => {
      fetchMock.mockResolvedValue(ghOk(makePrGql({ isDraft: true })));

      const response = await getPrStatus(
        new NextRequest(`http://localhost:3000/api/pr-status?url=${nextPrUrl()}`),
      );
      const payload = (await response.json()) as { state: string };

      expect(payload.state).toBe("draft");
    });

    it("returns merged state for a merged PR", async () => {
      fetchMock.mockResolvedValue(ghOk(makePrGql({ merged: true })));

      const response = await getPrStatus(
        new NextRequest(`http://localhost:3000/api/pr-status?url=${nextPrUrl()}`),
      );
      const payload = (await response.json()) as { state: string };

      expect(payload.state).toBe("merged");
    });

    it("returns closed state for a closed PR", async () => {
      fetchMock.mockResolvedValue(ghOk(makePrGql({ state: "CLOSED" })));

      const response = await getPrStatus(
        new NextRequest(`http://localhost:3000/api/pr-status?url=${nextPrUrl()}`),
      );
      const payload = (await response.json()) as { state: string };

      expect(payload.state).toBe("closed");
    });

    it("returns closed state for a closed draft PR (closed outranks draft)", async () => {
      fetchMock.mockResolvedValue(ghOk(makePrGql({ state: "CLOSED", isDraft: true })));

      const response = await getPrStatus(
        new NextRequest(`http://localhost:3000/api/pr-status?url=${nextPrUrl()}`),
      );
      const payload = (await response.json()) as { state: string };

      expect(payload.state).toBe("closed");
    });

    it("returns merged state for a merged draft PR (merged outranks draft and closed)", async () => {
      fetchMock.mockResolvedValue(
        ghOk(makePrGql({ state: "CLOSED", merged: true, isDraft: true })),
      );

      const response = await getPrStatus(
        new NextRequest(`http://localhost:3000/api/pr-status?url=${nextPrUrl()}`),
      );
      const payload = (await response.json()) as { state: string };

      expect(payload.state).toBe("merged");
    });

    it("returns approved reviewDecision from GitHub without inferring it", async () => {
      fetchMock.mockResolvedValue(ghOk(makePrGql({ reviewDecision: "APPROVED" })));

      const response = await getPrStatus(
        new NextRequest(`http://localhost:3000/api/pr-status?url=${nextPrUrl()}`),
      );
      const payload = (await response.json()) as { reviewDecision: string | null };

      expect(payload.reviewDecision).toBe("approved");
    });

    it("does not infer approval from resolved review threads", async () => {
      fetchMock.mockResolvedValue(
        ghOk(
          makePrGql({
            reviewDecision: null,
            reviewThreads: {
              nodes: [{ isResolved: true }, { isResolved: true }],
            },
          }),
        ),
      );

      const response = await getPrStatus(
        new NextRequest(`http://localhost:3000/api/pr-status?url=${nextPrUrl()}`),
      );
      const payload = (await response.json()) as {
        reviewDecision: string | null;
        unresolvedThreads: number;
      };

      expect(payload.reviewDecision).toBeNull();
      expect(payload.unresolvedThreads).toBe(0);
    });

    it("returns CI success status", async () => {
      fetchMock.mockResolvedValue(
        ghOk(
          makePrGql({
            commits: { nodes: [{ commit: { statusCheckRollup: { state: "SUCCESS" } } }] },
          }),
        ),
      );

      const response = await getPrStatus(
        new NextRequest(`http://localhost:3000/api/pr-status?url=${nextPrUrl()}`),
      );
      const payload = (await response.json()) as { ciStatus: string };

      expect(payload.ciStatus).toBe("success");
    });

    it("returns canMerge when GitHub reports a clean mergeable PR", async () => {
      fetchMock.mockResolvedValue(
        ghOk(
          makePrGql({
            mergeable: "MERGEABLE",
            mergeStateStatus: "CLEAN",
          }),
        ),
      );

      const response = await getPrStatus(
        new NextRequest(`http://localhost:3000/api/pr-status?url=${nextPrUrl()}`),
      );
      const payload = (await response.json()) as { canMerge: boolean; mergeConflict: boolean };

      expect(payload.canMerge).toBe(true);
      expect(payload.mergeConflict).toBe(false);
    });

    it("returns canMerge false for a dirty PR", async () => {
      fetchMock.mockResolvedValue(
        ghOk(
          makePrGql({
            mergeable: "CONFLICTING",
            mergeStateStatus: "DIRTY",
          }),
        ),
      );

      const response = await getPrStatus(
        new NextRequest(`http://localhost:3000/api/pr-status?url=${nextPrUrl()}`),
      );
      const payload = (await response.json()) as { canMerge: boolean; mergeConflict: boolean };

      expect(payload.canMerge).toBe(false);
      expect(payload.mergeConflict).toBe(true);
    });

    it("reports mergeConflict for a CANNOT_BE_MERGED PR", async () => {
      fetchMock.mockResolvedValue(
        ghOk(
          makePrGql({
            mergeable: "UNKNOWN",
            mergeStateStatus: "CANNOT_BE_MERGED",
          }),
        ),
      );

      const response = await getPrStatus(
        new NextRequest(`http://localhost:3000/api/pr-status?url=${nextPrUrl()}`),
      );
      const payload = (await response.json()) as { mergeConflict: boolean };

      expect(payload.mergeConflict).toBe(true);
    });

    it("returns CI failure for FAILURE rollup", async () => {
      fetchMock.mockResolvedValue(
        ghOk(
          makePrGql({
            commits: { nodes: [{ commit: { statusCheckRollup: { state: "FAILURE" } } }] },
          }),
        ),
      );

      const response = await getPrStatus(
        new NextRequest(`http://localhost:3000/api/pr-status?url=${nextPrUrl()}`),
      );
      const payload = (await response.json()) as { ciStatus: string };

      expect(payload.ciStatus).toBe("failure");
    });

    it("maps ERROR rollup state to CI failure", async () => {
      fetchMock.mockResolvedValue(
        ghOk(
          makePrGql({
            commits: { nodes: [{ commit: { statusCheckRollup: { state: "ERROR" } } }] },
          }),
        ),
      );

      const response = await getPrStatus(
        new NextRequest(`http://localhost:3000/api/pr-status?url=${nextPrUrl()}`),
      );
      const payload = (await response.json()) as { ciStatus: string };

      expect(payload.ciStatus).toBe("failure");
    });

    it("returns CI pending status", async () => {
      fetchMock.mockResolvedValue(
        ghOk(
          makePrGql({
            commits: { nodes: [{ commit: { statusCheckRollup: { state: "PENDING" } } }] },
          }),
        ),
      );

      const response = await getPrStatus(
        new NextRequest(`http://localhost:3000/api/pr-status?url=${nextPrUrl()}`),
      );
      const payload = (await response.json()) as { ciStatus: string };

      expect(payload.ciStatus).toBe("pending");
    });

    it("counts total and unresolved review threads", async () => {
      fetchMock.mockResolvedValue(
        ghOk(
          makePrGql({
            reviewThreads: {
              nodes: [{ isResolved: true }, { isResolved: false }, { isResolved: false }],
            },
          }),
        ),
      );

      const response = await getPrStatus(
        new NextRequest(`http://localhost:3000/api/pr-status?url=${nextPrUrl()}`),
      );
      const payload = (await response.json()) as {
        totalThreads: number;
        unresolvedThreads: number;
      };

      expect(payload.totalThreads).toBe(3);
      expect(payload.unresolvedThreads).toBe(2);
    });

    it("returns an empty payload when PR is not found in GraphQL response", async () => {
      fetchMock.mockResolvedValue(ghOk({ data: { repository: { pullRequest: null } } }));

      const response = await getPrStatus(
        new NextRequest(`http://localhost:3000/api/pr-status?url=${nextPrUrl()}`),
      );
      const payload = (await response.json()) as {
        state: null;
        ciStatus: null;
        totalThreads: number;
        unresolvedThreads: number;
        error?: string;
      };

      expect(response.status).toBe(200);
      expect(payload).toMatchObject({
        state: null,
        ciStatus: null,
        totalThreads: 0,
        unresolvedThreads: 0,
      });
      expect(payload.error).toBeUndefined();
    });

    it("returns an error payload when GitHub API responds with a server error", async () => {
      fetchMock.mockResolvedValue(ghErr(503));

      const response = await getPrStatus(
        new NextRequest(`http://localhost:3000/api/pr-status?url=${nextPrUrl()}`),
      );
      const payload = (await response.json()) as { state: null; error: string };

      expect(response.status).toBe(200);
      expect(payload.state).toBeNull();
      expect(payload.error).toBe("GitHub API 503");
    });

    it("does not arm rate limiting for non-rate-limited GitHub errors with rate-limit headers", async () => {
      fetchMock.mockResolvedValueOnce({
        ok: false,
        status: 503,
        headers: new Headers({
          "x-ratelimit-reset": String(Math.floor((Date.now() + 30_000) / 1000)),
          "x-ratelimit-remaining": "4999",
        }),
        json: async () => ({ message: "upstream unavailable" }),
        text: async () => JSON.stringify({ message: "upstream unavailable" }),
      });
      fetchMock.mockResolvedValueOnce(ghOk(makePrGql()));

      const first = await getPrStatus(
        new NextRequest(`http://localhost:3000/api/pr-status?url=${nextPrUrl()}`),
      );
      const second = await getPrStatus(
        new NextRequest(`http://localhost:3000/api/pr-status?url=${nextPrUrl()}`),
      );
      const payload1 = (await first.json()) as { error: string };
      const payload2 = (await second.json()) as { state: string };

      expect(payload1.error).toBe("GitHub API 503");
      expect(payload2.state).toBe("open");
      expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    it("returns an error payload on network-level error", async () => {
      fetchMock.mockRejectedValue(new Error("ECONNREFUSED"));

      const response = await getPrStatus(
        new NextRequest(`http://localhost:3000/api/pr-status?url=${nextPrUrl()}`),
      );
      const payload = (await response.json()) as { state: null; error: string };

      expect(response.status).toBe(200);
      expect(payload.state).toBeNull();
      expect(payload.error).toBe("ECONNREFUSED");
    });

    it("returns cached response on second identical request", async () => {
      fetchMock.mockResolvedValue(ghOk(makePrGql()));

      const url = nextPrUrl();
      await getPrStatus(new NextRequest(`http://localhost:3000/api/pr-status?url=${url}`));
      const response2 = await getPrStatus(
        new NextRequest(`http://localhost:3000/api/pr-status?url=${url}`),
      );

      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(response2.status).toBe(200);
    });

    it("preserves upstream error details from cache on repeated requests", async () => {
      fetchMock.mockResolvedValue(ghErr(503));

      const url = nextPrUrl();
      const response1 = await getPrStatus(
        new NextRequest(`http://localhost:3000/api/pr-status?url=${url}`),
      );
      const response2 = await getPrStatus(
        new NextRequest(`http://localhost:3000/api/pr-status?url=${url}`),
      );
      const payload1 = (await response1.json()) as { error: string };
      const payload2 = (await response2.json()) as { error: string };

      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(response1.status).toBe(200);
      expect(response2.status).toBe(200);
      expect(payload1.error).toBe("GitHub API 503");
      expect(payload2.error).toBe("GitHub API 503");
    });

    it("returns GraphQL errors as a soft error payload", async () => {
      fetchMock.mockResolvedValue(
        ghOk({
          data: { repository: { pullRequest: null } },
          errors: [{ message: "Resource not accessible by integration" }],
        }),
      );

      const response = await getPrStatus(
        new NextRequest(`http://localhost:3000/api/pr-status?url=${nextPrUrl()}`),
      );
      const payload = (await response.json()) as { state: null; error: string };

      expect(response.status).toBe(200);
      expect(payload.state).toBeNull();
      expect(payload.error).toBe("Resource not accessible by integration");
    });

    it("fresh successful response includes stale:false and a recent fetchedAt", async () => {
      fetchMock.mockResolvedValue(ghOk(makePrGql()));
      const before = Date.now();

      const response = await getPrStatus(
        new NextRequest(`http://localhost:3000/api/pr-status?url=${nextPrUrl()}`),
      );
      const payload = (await response.json()) as {
        state: string;
        stale: boolean;
        fetchedAt: number;
      };

      expect(payload.state).toBe("open");
      expect(payload.stale).toBe(false);
      expect(typeof payload.fetchedAt).toBe("number");
      expect(payload.fetchedAt).toBeGreaterThanOrEqual(before);
    });

    it("after a successful fetch, a subsequent error returns the prior snapshot with stale:true", async () => {
      const doReset = (globalThis as Record<string, unknown>)["__spurResetPrStatusCache"];
      if (typeof doReset === "function") (doReset as () => void)();

      const url = nextPrUrl();

      // 1) Success populates lastGoodCache and short-TTL cache.
      fetchMock.mockResolvedValueOnce(
        ghOk(
          makePrGql({
            commits: { nodes: [{ commit: { statusCheckRollup: { state: "SUCCESS" } } }] },
          }),
        ),
      );
      const okResp = await getPrStatus(
        new NextRequest(`http://localhost:3000/api/pr-status?url=${url}`),
      );
      const okPayload = (await okResp.json()) as { fetchedAt: number; ciStatus: string };
      expect(okPayload.ciStatus).toBe("success");

      // 2) Clear the short-TTL response cache only by reaching into lastGoodCache via a
      // fresh module reset of `cache` is not exposed. Instead, we trigger a network
      // re-fetch by invalidating the short-TTL entry. The cleanest way without new
      // exports: monkey-patch Date.now to advance past CACHE_TTL_MS.
      const realNow = Date.now;
      try {
        Date.now = () => realNow() + 200_000;
        fetchMock.mockResolvedValueOnce(ghErr(503));
        const errResp = await getPrStatus(
          new NextRequest(`http://localhost:3000/api/pr-status?url=${url}`),
        );
        const errPayload = (await errResp.json()) as {
          state: string;
          ciStatus: string;
          stale: boolean;
          fetchedAt: number;
          error: string;
        };
        expect(errResp.status).toBe(200);
        expect(errPayload.stale).toBe(true);
        expect(errPayload.state).toBe("open");
        expect(errPayload.ciStatus).toBe("success");
        expect(errPayload.error).toBe("GitHub API 503");
        expect(errPayload.fetchedAt).toBe(okPayload.fetchedAt);
      } finally {
        Date.now = realNow;
      }
    });

    it("with no prior success, an error returns EMPTY_PR_STATUS with error and stale:false", async () => {
      const doReset = (globalThis as Record<string, unknown>)["__spurResetPrStatusCache"];
      if (typeof doReset === "function") (doReset as () => void)();

      fetchMock.mockResolvedValueOnce(ghErr(503));
      const response = await getPrStatus(
        new NextRequest(`http://localhost:3000/api/pr-status?url=${nextPrUrl()}`),
      );
      const payload = (await response.json()) as {
        state: null;
        error: string;
        stale: boolean;
        fetchedAt?: number;
      };

      expect(payload.state).toBeNull();
      expect(payload.error).toBe("GitHub API 503");
      expect(payload.stale).toBe(false);
      expect(payload.fetchedAt).toBeUndefined();
    });

    it("returns a soft error while rate-limit window is active", async () => {
      const resetAt = Math.floor((Date.now() + 30_000) / 1000);
      fetchMock.mockResolvedValueOnce({
        ok: false,
        status: 403,
        headers: new Headers({
          "x-ratelimit-reset": String(resetAt),
          "x-ratelimit-remaining": "0",
        }),
        json: async () => ({ message: "rate limited" }),
        text: async () => JSON.stringify({ message: "rate limited" }),
      });

      // First call: triggers the 403 → sets rateLimitResetAt
      await getPrStatus(new NextRequest(`http://localhost:3000/api/pr-status?url=${nextPrUrl()}`));

      // Second call (different URL): should be blocked by in-memory rate limit
      const response = await getPrStatus(
        new NextRequest(`http://localhost:3000/api/pr-status?url=${nextPrUrl()}`),
      );
      const payload = (await response.json()) as { state: null; error: string };

      expect(response.status).toBe(200);
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(payload.state).toBeNull();
      expect(payload.error).toContain("GitHub rate limit");
    });

    it("arms the rate-limit window from a GraphQL rate-limit error", async () => {
      fetchMock.mockResolvedValueOnce(
        ghOk({
          data: { repository: { pullRequest: null } },
          errors: [{ message: "API rate limit exceeded for user" }],
        }),
      );

      const first = await getPrStatus(
        new NextRequest(`http://localhost:3000/api/pr-status?url=${nextPrUrl()}`),
      );
      const firstPayload = (await first.json()) as { state: null; error: string };
      expect(first.status).toBe(200);
      expect(firstPayload.error).toContain("API rate limit exceeded for user");

      const response = await getPrStatus(
        new NextRequest(`http://localhost:3000/api/pr-status?url=${nextPrUrl()}`),
      );
      const payload = (await response.json()) as { state: null; error: string };

      expect(response.status).toBe(200);
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(payload.error).toContain("GitHub rate limit");
    });

    it("arms the rate-limit window from a structured RATE_LIMITED error type using the header's reset time", async () => {
      const resetAt = Math.floor((Date.now() + 30_000) / 1000);
      fetchMock.mockResolvedValueOnce({
        ok: true,
        status: 200,
        headers: new Headers({ "x-ratelimit-reset": String(resetAt) }),
        json: async () => ({
          data: { repository: { pullRequest: null } },
          errors: [{ type: "RATE_LIMITED", message: "You have exceeded a quota" }],
        }),
        text: async () => "",
      });

      await getPrStatus(new NextRequest(`http://localhost:3000/api/pr-status?url=${nextPrUrl()}`));
      const response = await getPrStatus(
        new NextRequest(`http://localhost:3000/api/pr-status?url=${nextPrUrl()}`),
      );
      const payload = (await response.json()) as { error: string };

      expect(response.status).toBe(200);
      expect(fetchMock).toHaveBeenCalledTimes(1);
      const match = payload.error.match(/retry in (\d+)s/);
      expect(match).not.toBeNull();
      const waitSeconds = Number(match?.[1]);
      expect(waitSeconds).toBeLessThanOrEqual(30);
    });

    it("does not arm the rate-limit window for a non-rate-limit GraphQL error", async () => {
      fetchMock.mockResolvedValueOnce(
        ghOk({
          data: { repository: { pullRequest: null } },
          errors: [{ type: "NOT_FOUND", message: "Could not resolve to a Repository" }],
        }),
      );
      fetchMock.mockResolvedValueOnce(ghOk(makePrGql()));

      const first = await getPrStatus(
        new NextRequest(`http://localhost:3000/api/pr-status?url=${nextPrUrl()}`),
      );
      const second = await getPrStatus(
        new NextRequest(`http://localhost:3000/api/pr-status?url=${nextPrUrl()}`),
      );
      const payload1 = (await first.json()) as { error: string };
      const payload2 = (await second.json()) as { state: string };

      expect(payload1.error).toBe("Could not resolve to a Repository");
      expect(payload2.state).toBe("open");
      expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    it("keeps resolved PR data when GraphQL also reports a rate-limit error", async () => {
      fetchMock.mockResolvedValueOnce(
        ghOk({
          ...makePrGql({
            commits: { nodes: [{ commit: { statusCheckRollup: { state: "SUCCESS" } } }] },
          }),
          errors: [{ type: "RATE_LIMITED", message: "API rate limit exceeded" }],
        }),
      );

      const response = await getPrStatus(
        new NextRequest(`http://localhost:3000/api/pr-status?url=${nextPrUrl()}`),
      );
      const payload = (await response.json()) as {
        state: string;
        ciStatus: string;
        error: string;
      };

      expect(response.status).toBe(200);
      expect(payload.state).toBe("open");
      expect(payload.ciStatus).toBe("success");
      expect(payload.error).toContain("API rate limit exceeded");

      // The window must also be armed on the data-bearing path: a subsequent
      // request for a different PR should short-circuit without hitting the network.
      const second = await getPrStatus(
        new NextRequest(`http://localhost:3000/api/pr-status?url=${nextPrUrl()}`),
      );
      const secondPayload = (await second.json()) as { error: string };

      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(secondPayload.error).toContain("GitHub rate limit");
    });

    it("arms the rate-limit window and does not record a fake empty PR status for a message-less rate-limit error", async () => {
      fetchMock.mockResolvedValueOnce(
        ghOk({
          data: { repository: { pullRequest: null } },
          errors: [{ type: "RATE_LIMITED" }],
        }),
      );

      const first = await getPrStatus(
        new NextRequest(`http://localhost:3000/api/pr-status?url=${nextPrUrl()}`),
      );
      const firstPayload = (await first.json()) as {
        state: null;
        error?: string;
        fetchedAt?: number;
      };
      expect(firstPayload.state).toBeNull();
      expect(firstPayload.error).toBe("GitHub GraphQL error");
      expect(firstPayload.fetchedAt).toBeUndefined();

      const second = await getPrStatus(
        new NextRequest(`http://localhost:3000/api/pr-status?url=${nextPrUrl()}`),
      );
      const secondPayload = (await second.json()) as { error: string };

      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(secondPayload.error).toContain("GitHub rate limit");
    });

    it("joins every GraphQL error message into the payload error", async () => {
      fetchMock.mockResolvedValue(
        ghOk({
          data: { repository: { pullRequest: null } },
          errors: [{ message: "first failure" }, { message: "second failure" }],
        }),
      );

      const response = await getPrStatus(
        new NextRequest(`http://localhost:3000/api/pr-status?url=${nextPrUrl()}`),
      );
      const payload = (await response.json()) as { error: string };

      expect(response.status).toBe(200);
      expect(payload.error).toContain("first failure");
      expect(payload.error).toContain("second failure");
    });

    it("caches a PR-present-with-error payload at the shorter error TTL, not the full success TTL", async () => {
      fetchMock.mockResolvedValue(
        ghOk({
          ...makePrGql(),
          errors: [{ type: "NOT_FOUND", message: "partial data error" }],
        }),
      );

      const url = nextPrUrl();
      const first = await getPrStatus(
        new NextRequest(`http://localhost:3000/api/pr-status?url=${url}`),
      );
      const firstPayload = (await first.json()) as { error: string };
      expect(firstPayload.error).toBe("partial data error");
      expect(fetchMock).toHaveBeenCalledTimes(1);

      const realNow = Date.now;
      try {
        Date.now = () => realNow() + 70_000;
        await getPrStatus(new NextRequest(`http://localhost:3000/api/pr-status?url=${url}`));
        expect(fetchMock).toHaveBeenCalledTimes(2);
      } finally {
        Date.now = realNow;
      }
    });
  });

  describe("POST /api/pr-status/batch", () => {
    const fetchMock = vi.fn();

    // Use a counter to generate unique PR numbers, avoiding module-level cache hits
    let prCounter = 9000;
    function nextPrUrl() {
      return `https://github.com/owner/repo/pull/${prCounter++}`;
    }

    function postBatch(urls: unknown) {
      return postPrStatusBatch(
        new NextRequest("http://localhost:3000/api/pr-status/batch", {
          method: "POST",
          body: JSON.stringify({ urls }),
        }),
      );
    }

    function makePrNode(overrides: Record<string, unknown> = {}) {
      return {
        state: "OPEN",
        isDraft: false,
        merged: false,
        mergeable: "MERGEABLE",
        mergeStateStatus: "CLEAN",
        reviewDecision: null,
        reviewThreads: { nodes: [] },
        commits: { nodes: [{ commit: { statusCheckRollup: null } }] },
        ...overrides,
      };
    }

    function aliasedGql(nodesByAlias: Record<string, unknown>) {
      const data: Record<string, unknown> = {};
      for (const [alias, node] of Object.entries(nodesByAlias)) {
        data[alias] = { pullRequest: node };
      }
      return { data };
    }

    beforeEach(() => {
      vi.stubGlobal("fetch", fetchMock);
      fetchMock.mockReset();
      process.env["GITHUB_TOKEN"] = "test-token";
      resetGitHubApiStateForTests();
      const reset = (globalThis as Record<string, unknown>)["__spurResetPrStatusCache"];
      if (typeof reset === "function") (reset as () => void)();
    });

    afterEach(() => {
      vi.unstubAllGlobals();
      delete process.env["GITHUB_TOKEN"];
    });

    it("returns 400 when urls is not an array", async () => {
      const response = await postBatch("not-an-array");
      expect(response.status).toBe(400);
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it("returns 400 for more than 100 urls", async () => {
      const urls = Array.from({ length: 101 }, () => nextPrUrl());
      const response = await postBatch(urls);
      expect(response.status).toBe(400);
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it("omits an invalid URL from results without a 400", async () => {
      const validUrl = nextPrUrl();
      fetchMock.mockResolvedValueOnce(ghOk(aliasedGql({ pr0: makePrNode() })));

      const response = await postBatch([validUrl, "https://example.com/not-a-pr"]);
      const payload = (await response.json()) as { results: Record<string, unknown> };

      expect(response.status).toBe(200);
      expect(Object.keys(payload.results)).toEqual([validUrl]);
    });

    it("issues zero fetch when every URL is already cached", async () => {
      const url = nextPrUrl();
      fetchMock.mockResolvedValueOnce(ghOk(aliasedGql({ pr0: makePrNode() })));
      await postBatch([url]); // warms the cache
      fetchMock.mockReset();

      const response = await postBatch([url]);
      const payload = (await response.json()) as {
        results: Record<string, { state: string | null }>;
      };

      expect(fetchMock).not.toHaveBeenCalled();
      expect(payload.results[url]?.state).toBe("open");
    });

    it("issues exactly one fetch with one alias per uncached PR on a partial cache miss", async () => {
      const cachedUrl = nextPrUrl();
      const missUrl = nextPrUrl();
      fetchMock.mockResolvedValueOnce(ghOk(aliasedGql({ pr0: makePrNode() })));
      await postBatch([cachedUrl]); // warms cachedUrl
      fetchMock.mockReset();

      fetchMock.mockResolvedValueOnce(
        ghOk(aliasedGql({ pr0: makePrNode({ state: "MERGED", merged: true }) })),
      );

      const response = await postBatch([cachedUrl, missUrl]);
      const payload = (await response.json()) as {
        results: Record<string, { state: string | null }>;
      };

      expect(fetchMock).toHaveBeenCalledTimes(1);
      const [, init] = fetchMock.mock.calls[0] as [string, { body: string }];
      const body = JSON.parse(init.body) as { query: string };
      expect(body.query.match(/pr\d+: repository/g)).toHaveLength(1);
      expect(payload.results[cachedUrl]?.state).toBe("open");
      expect(payload.results[missUrl]?.state).toBe("merged");
    });

    it("returns a stale last-good snapshot with the rate-limit error per miss, issuing zero fetch", async () => {
      vi.useFakeTimers();
      try {
        const readyUrl = nextPrUrl();
        fetchMock.mockResolvedValueOnce(ghOk(aliasedGql({ pr0: makePrNode() })));
        await postBatch([readyUrl]); // warms last-good + the short-lived response cache

        vi.advanceTimersByTime(130_000); // expire the short-lived cache; last-good persists

        const tripUrl = nextPrUrl();
        const resetAt = Math.floor((Date.now() + 30_000) / 1000);
        fetchMock.mockResolvedValueOnce({
          ok: false,
          status: 403,
          headers: new Headers({
            "x-ratelimit-reset": String(resetAt),
            "x-ratelimit-remaining": "0",
          }),
          json: async () => ({ message: "rate limited" }),
          text: async () => JSON.stringify({ message: "rate limited" }),
        });
        await postBatch([tripUrl]); // trips the shared rate-limit window

        fetchMock.mockClear();
        const response = await postBatch([readyUrl]);
        const payload = (await response.json()) as {
          results: Record<string, { state: string | null; stale?: boolean; error?: string }>;
        };

        expect(fetchMock).not.toHaveBeenCalled();
        expect(payload.results[readyUrl]?.stale).toBe(true);
        expect(payload.results[readyUrl]?.state).toBe("open");
        expect(payload.results[readyUrl]?.error).toContain("GitHub rate limit");
      } finally {
        vi.useRealTimers();
      }
    });

    it("resolves the successful alias and records the GraphQL error for the failed one on a partial error", async () => {
      const okUrl = nextPrUrl();
      const failUrl = nextPrUrl();
      fetchMock.mockResolvedValueOnce(
        ghOk({
          data: { pr0: { pullRequest: makePrNode() }, pr1: { pullRequest: null } },
          errors: [{ message: "Could not resolve to a PullRequest", path: ["pr1", "pullRequest"] }],
        }),
      );

      const response = await postBatch([okUrl, failUrl]);
      const payload = (await response.json()) as {
        results: Record<string, { state: string | null; error?: string }>;
      };

      expect(response.status).toBe(200);
      expect(payload.results[okUrl]?.state).toBe("open");
      expect(payload.results[okUrl]?.error).toBeUndefined();
      expect(payload.results[failUrl]?.state).toBeNull();
      expect(payload.results[failUrl]?.error).toContain("Could not resolve to a PullRequest");
    });

    it("attaches a matching GraphQL error to a resolved node instead of dropping it", async () => {
      const url = nextPrUrl();
      fetchMock.mockResolvedValueOnce(
        ghOk({
          data: { pr0: { pullRequest: makePrNode() } },
          errors: [{ message: "partial data error", path: ["pr0", "pullRequest", "commits"] }],
        }),
      );

      const response = await postBatch([url]);
      const payload = (await response.json()) as {
        results: Record<string, { state: string | null; error?: string }>;
      };

      expect(response.status).toBe(200);
      expect(payload.results[url]?.state).toBe("open");
      expect(payload.results[url]?.error).toBe("partial data error");
    });

    it("maps a GraphQL error to only its own alias, leaving an unrelated null node genuinely absent", async () => {
      const errorUrl = nextPrUrl();
      const absentUrl = nextPrUrl();
      fetchMock.mockResolvedValueOnce(
        ghOk({
          data: { pr0: { pullRequest: null }, pr1: { pullRequest: null } },
          errors: [{ message: "Could not resolve to a PullRequest", path: ["pr0", "pullRequest"] }],
        }),
      );

      const response = await postBatch([errorUrl, absentUrl]);
      const payload = (await response.json()) as {
        results: Record<string, { state: string | null; error?: string }>;
      };

      expect(response.status).toBe(200);
      // pr0 (errorUrl) carries the GraphQL error.
      expect(payload.results[errorUrl]?.state).toBeNull();
      expect(payload.results[errorUrl]?.error).toContain("Could not resolve to a PullRequest");
      // pr1 (absentUrl) has no matching error entry — it's genuinely absent,
      // not tainted by pr0's unrelated error message.
      expect(payload.results[absentUrl]?.state).toBeNull();
      expect(payload.results[absentUrl]?.error).toBeUndefined();
    });

    it("records a per-miss error and returns 200 for a non-rate-limit GitHub API failure", async () => {
      const url = nextPrUrl();
      fetchMock.mockResolvedValueOnce(ghErr(500, { message: "Internal Server Error" }));

      const response = await postBatch([url]);
      const payload = (await response.json()) as {
        results: Record<string, { state: string | null; error?: string }>;
      };

      expect(response.status).toBe(200);
      expect(payload.results[url]?.state).toBeNull();
      expect(payload.results[url]?.error).toContain("GitHub API 500");
    });

    it("records a per-miss error and returns 200 when the GitHub fetch throws", async () => {
      const url = nextPrUrl();
      fetchMock.mockRejectedValueOnce(new Error("network unreachable"));

      const response = await postBatch([url]);
      const payload = (await response.json()) as {
        results: Record<string, { state: string | null; error?: string }>;
      };

      expect(response.status).toBe(200);
      expect(payload.results[url]?.state).toBeNull();
      expect(payload.results[url]?.error).toContain("network unreachable");
    });
  });

  describe("POST /api/pr-status/merge", () => {
    beforeEach(() => {
      vi.stubGlobal("fetch", vi.fn());
      delete process.env["GITHUB_TOKEN"];
    });

    afterEach(() => {
      vi.unstubAllGlobals();
    });

    it("returns 400 when url is missing", async () => {
      const response = await mergePr(
        new NextRequest("http://localhost:3000/api/pr-status/merge", {
          method: "POST",
          body: JSON.stringify({}),
        }),
      );
      expect(response.status).toBe(400);
    });

    it("merges a PR with squash and returns ok", async () => {
      const fetchMock = vi.fn().mockResolvedValue(
        ghOk({
          merged: true,
          sha: "abc123",
        }),
      );
      vi.stubGlobal("fetch", fetchMock);

      const response = await mergePr(
        new NextRequest("http://localhost:3000/api/pr-status/merge", {
          method: "POST",
          body: JSON.stringify({ url: "https://github.com/owner/repo/pull/42" }),
        }),
      );
      const payload = (await response.json()) as { ok: boolean; sha: string };

      expect(response.status).toBe(200);
      expect(payload.ok).toBe(true);
      expect(payload.sha).toBe("abc123");
      expect(fetchMock).toHaveBeenCalledWith(
        "https://api.github.com/repos/owner/repo/pulls/42/merge",
        expect.objectContaining({
          method: "PUT",
          body: JSON.stringify({ merge_method: "squash" }),
        }),
      );
    });

    it("surfaces GitHub merge errors", async () => {
      vi.stubGlobal("fetch", vi.fn().mockResolvedValue(ghErr(405, { message: "Not mergeable" })));

      const response = await mergePr(
        new NextRequest("http://localhost:3000/api/pr-status/merge", {
          method: "POST",
          body: JSON.stringify({ url: "https://github.com/owner/repo/pull/42" }),
        }),
      );
      const payload = (await response.json()) as { error: string };

      expect(response.status).toBe(405);
      expect(payload.error).toBe("Not mergeable");
    });
  });

  // ── Claude account rotation ────────────────────────────────────────────

  describe("Claude account rotation", () => {
    it("POST /api/sessions/:id/switch-auth forwards accountId to the daemon", async () => {
      mockedSpurRequestJson.mockResolvedValue(
        sessionFixture({ id: "api-a1", activeClaudeAccountId: "acc-2" }),
      );

      const response = await switchAuth(
        new Request("http://localhost:3000/api/sessions/api-a1/switch-auth", {
          method: "POST",
          body: JSON.stringify({ accountId: "  acc-2  " }),
        }),
        { params: Promise.resolve({ id: "api-a1" }) },
      );

      expect(response.status).toBe(200);
      expect(mockedSpurRequestJson).toHaveBeenCalledWith(
        "/sessions/api-a1/switch-auth",
        expect.objectContaining({ method: "POST" }),
      );
      const body = JSON.parse((mockedSpurRequestJson.mock.calls[0]?.[1] as { body: string }).body);
      expect(body).toEqual({ accountId: "acc-2" });
    });

    it("POST /api/sessions/:id/switch-auth forwards force when true", async () => {
      mockedSpurRequestJson.mockResolvedValue(sessionFixture());

      await switchAuth(
        new Request("http://localhost:3000/api/sessions/api-a1/switch-auth", {
          method: "POST",
          body: JSON.stringify({ accountId: "acc-2", force: true }),
        }),
        { params: Promise.resolve({ id: "api-a1" }) },
      );

      const body = JSON.parse((mockedSpurRequestJson.mock.calls[0]?.[1] as { body: string }).body);
      expect(body).toEqual({ accountId: "acc-2", force: true });
    });

    it("POST /api/sessions/:id/switch-auth rejects a blank accountId", async () => {
      const response = await switchAuth(
        new Request("http://localhost:3000/api/sessions/api-a1/switch-auth", {
          method: "POST",
          body: JSON.stringify({ accountId: "   " }),
        }),
        { params: Promise.resolve({ id: "api-a1" }) },
      );

      expect(response.status).toBe(400);
      expect(mockedSpurRequestJson).not.toHaveBeenCalled();
    });

    it("GET /api/claude-accounts maps the daemon accounts shape", async () => {
      const accounts = [
        { id: "acc-1", label: "Work", authenticated: true, lastUsedAt: "2026-07-01T00:00:00.000Z" },
        { id: "acc-2", authenticated: false },
      ];
      mockedSpurRequestJson.mockResolvedValue({ accounts });

      const response = await listClaudeAccounts();
      const payload = (await response.json()) as { accounts: unknown[] };

      expect(response.status).toBe(200);
      expect(mockedSpurRequestJson).toHaveBeenCalledWith("/claude-accounts");
      expect(payload.accounts).toEqual(accounts);
    });

    it("GET /api/claude-accounts returns 502 when the daemon fails", async () => {
      mockedSpurRequestJson.mockRejectedValue(new Error("daemon down"));

      const response = await listClaudeAccounts();
      const payload = (await response.json()) as { error: string };

      expect(response.status).toBe(502);
      expect(payload.error).toBe("daemon down");
    });

    // ── GET /api/projects/:id/spawn-defaults ──────────────────────────────

    it("GET /api/projects/:id/spawn-defaults forwards the agent to the daemon", async () => {
      mockedSpurRequestJson.mockResolvedValue({ model: "sonnet", worktree: false });

      const response = await getSpawnDefaults(
        new NextRequest("http://localhost:3000/api/projects/api/spawn-defaults?agent=claude"),
        { params: Promise.resolve({ id: "api" }) },
      );
      const payload = (await response.json()) as { model: string | null; worktree: boolean };

      expect(response.status).toBe(200);
      expect(mockedSpurRequestJson).toHaveBeenCalledWith(
        "/projects/api/spawn-defaults?agent=claude",
        { timeoutMs: 8_000 },
      );
      expect(payload).toEqual({ model: "sonnet", worktree: false });
    });

    it("GET /api/projects/:id/spawn-defaults rejects an unsupported agent without calling the daemon", async () => {
      const response = await getSpawnDefaults(
        new NextRequest("http://localhost:3000/api/projects/api/spawn-defaults?agent=nope"),
        { params: Promise.resolve({ id: "api" }) },
      );

      expect(response.status).toBe(400);
      expect(mockedSpurRequestJson).not.toHaveBeenCalled();
    });

    it("GET /api/projects/:id/spawn-defaults surfaces the daemon's error status", async () => {
      mockedSpurRequestJson.mockRejectedValue(new SpurDaemonError("Unknown project: api", 404));

      const response = await getSpawnDefaults(
        new NextRequest("http://localhost:3000/api/projects/api/spawn-defaults?agent=claude"),
        { params: Promise.resolve({ id: "api" }) },
      );
      const payload = (await response.json()) as { error: string };

      expect(response.status).toBe(404);
      expect(payload.error).toBe("Unknown project: api");
    });
  });

  // ── POST /api/runtime/auto-update ─────────────────────────────────────

  describe("POST /api/runtime/auto-update", () => {
    it("forwards enabled to the daemon", async () => {
      mockedSpurRequest.mockResolvedValue(
        new Response(JSON.stringify({ autoUpdate: true }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      );

      const response = await postAutoUpdate(
        new NextRequest("http://localhost:3000/api/runtime/auto-update", {
          method: "POST",
          body: JSON.stringify({ enabled: true }),
        }),
      );

      expect(response.status).toBe(200);
      expect(mockedSpurRequest).toHaveBeenCalledWith(
        "/deploy/auto-update",
        expect.objectContaining({
          method: "POST",
          body: JSON.stringify({ enabled: true }),
        }),
      );
      await expect(response.json()).resolves.toEqual({ autoUpdate: true });
    });

    it("passes a 409 body and status through verbatim", async () => {
      const conflict = { error: "config changed on disk" };
      mockedSpurRequest.mockResolvedValue(
        new Response(JSON.stringify(conflict), {
          status: 409,
          headers: { "content-type": "application/json" },
        }),
      );

      const response = await postAutoUpdate(
        new NextRequest("http://localhost:3000/api/runtime/auto-update", {
          method: "POST",
          body: JSON.stringify({ enabled: false }),
        }),
      );

      expect(response.status).toBe(409);
      await expect(response.json()).resolves.toEqual(conflict);
    });

    it("returns 400 on a malformed body", async () => {
      const response = await postAutoUpdate(
        new NextRequest("http://localhost:3000/api/runtime/auto-update", {
          method: "POST",
          body: "not json",
        }),
      );

      expect(response.status).toBe(400);
      expect(mockedSpurRequest).not.toHaveBeenCalled();
    });
  });
});
