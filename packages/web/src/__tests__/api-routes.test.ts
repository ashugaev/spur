// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@/lib/spur-daemon", () => ({
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

// Prevent pr-status from shelling out to `gh auth token`
vi.mock("node:child_process", () => ({ execSync: vi.fn(() => "") }));

import { spurRequest, spurRequestJson } from "@/lib/spur-daemon";
import { readVoiceStatus, transcribeAudio } from "@/lib/voice";
import { readFile, statfs } from "node:fs/promises";
import { resetResourceMonitoringForTests } from "@/lib/resource-monitoring";
import { GET as listSessions } from "@/app/api/sessions/route";
import { GET as getSession } from "@/app/api/sessions/[id]/route";
import { POST as spawnSession } from "@/app/api/spawn/route";
import { GET as runtimeTerminalConfig } from "@/app/api/runtime/terminal/route";
import { GET as runtimeVoiceStatus } from "@/app/api/runtime/voice/route";
import { GET as runtimeResources } from "@/app/api/runtime/resources/route";
import { POST as transcribeVoice } from "@/app/api/runtime/voice/transcribe/route";
import { POST as sendMessage } from "@/app/api/sessions/[id]/send/route";
import { POST as pauseSession } from "@/app/api/sessions/[id]/pause/route";
import { POST as completeSession } from "@/app/api/sessions/[id]/complete/route";
import { POST as killSession } from "@/app/api/sessions/[id]/kill/route";
import { POST as restoreSession } from "@/app/api/sessions/[id]/restore/route";
import { POST as respawnSession } from "@/app/api/sessions/[id]/respawn/route";
import { POST as startSidecar } from "@/app/api/sessions/[id]/sidecars/[name]/start/route";
import { POST as stopSidecar } from "@/app/api/sessions/[id]/sidecars/[name]/stop/route";
import { GET as getSessionLogs } from "@/app/api/sessions/[id]/logs/route";
import { GET as getSessionArtifact } from "@/app/api/sessions/[id]/artifacts/[artifactId]/route";
import { GET as getPrStatus } from "@/app/api/pr-status/route";
import { POST as runPreflight } from "@/app/api/preflight/route";

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

describe("Spur web API routes", () => {
  beforeEach(() => {
    mockedSpurRequestJson.mockReset();
    mockedSpurRequest.mockReset();
    mockedReadVoiceStatus.mockReset();
    mockedTranscribeAudio.mockReset();
    mockedReadFile.mockReset();
    mockedStatfs.mockReset();
    resetResourceMonitoringForTests();
    if (platformDescriptor) Object.defineProperty(process, "platform", platformDescriptor);
    delete process.env["DIRECT_TERMINAL_PORT"];
    delete process.env["DIRECT_TERMINAL_BIND_PORT"];
    delete process.env["DIRECT_TERMINAL_PUBLIC_PORT"];
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
      ]);

    const response = await listSessions(new NextRequest("http://localhost:3000/api/sessions"));
    const payload = (await response.json()) as { sessions: unknown[] };

    expect(response.status).toBe(200);
    expect(payload.sessions).toHaveLength(2);
    expect(mockedSpurRequestJson).toHaveBeenNthCalledWith(1, "/sessions?includeCompleted=1");
    expect(payload.sessions[1]).toMatchObject({ id: "done-1", status: "completed" });
  });

  it("GET /api/sessions filters by project", async () => {
    mockedSpurRequestJson
      .mockResolvedValueOnce([
        sessionFixture(),
        sessionFixture({
          id: "web-b2",
          project: "web",
          tmuxSession: "web-b2",
          worktreePath: "/tmp/web-b2",
        }),
      ])
      .mockResolvedValueOnce([
        { id: "api", name: "API" },
        { id: "web", name: "Web" },
      ]);

    const response = await listSessions(
      new NextRequest("http://localhost:3000/api/sessions?project=api"),
    );
    const payload = (await response.json()) as { sessions: Array<{ id: string; project: string }> };

    expect(response.status).toBe(200);
    expect(payload.sessions).toHaveLength(1);
    expect(payload.sessions[0]).toMatchObject({ id: "api-a1", project: "api" });
    expect(mockedSpurRequestJson).toHaveBeenNthCalledWith(1, "/sessions?includeCompleted=1");
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
      .mockResolvedValueOnce([{ id: "sp", name: "Spur Core" }]);

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

  // ── GET /api/sessions/:id ──────────────────────────────────────────────

  it("GET /api/sessions/:id returns session by id", async () => {
    const session = sessionFixture({ id: "sid-1" });
    mockedSpurRequestJson.mockResolvedValue(session);

    const response = await getSession(new Request("http://localhost:3000/api/sessions/sid-1"), {
      params: Promise.resolve({ id: "sid-1" }),
    });
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(payload).toMatchObject({ id: "sid-1" });
    expect(mockedSpurRequestJson).toHaveBeenCalledWith("/sessions/sid-1");
  });

  it("GET /api/sessions/:id URL-encodes the session id", async () => {
    mockedSpurRequestJson.mockResolvedValue(sessionFixture({ id: "my/session 1" }));

    await getSession(new Request("http://localhost:3000/api/sessions/my%2Fsession%201"), {
      params: Promise.resolve({ id: "my/session 1" }),
    });

    expect(mockedSpurRequestJson).toHaveBeenCalledWith("/sessions/my%2Fsession%201");
  });

  it("GET /api/sessions/:id returns 502 when daemon fails", async () => {
    mockedSpurRequestJson.mockRejectedValue(new Error("Session not found"));

    const response = await getSession(new Request("http://localhost:3000/api/sessions/bad-id"), {
      params: Promise.resolve({ id: "bad-id" }),
    });
    const payload = (await response.json()) as { error: string };

    expect(response.status).toBe(502);
    expect(payload.error).toBe("Session not found");
  });

  it("GET /api/sessions/:id/artifacts/:artifactId proxies artifact content from the daemon", async () => {
    mockedSpurRequest.mockResolvedValue(
      new Response("artifact-bytes", {
        status: 200,
        headers: {
          "content-type": "image/png",
          "content-length": "13",
          "content-disposition": 'inline; filename="shot.png"',
        },
      }),
    );

    const response = await getSessionArtifact(
      new Request("http://localhost:3000/api/sessions/api-a1/artifacts/shot.png"),
      { params: Promise.resolve({ id: "api-a1", artifactId: "shot.png" }) },
    );

    expect(response.status).toBe(200);
    await expect(response.text()).resolves.toBe("artifact-bytes");
    expect(mockedSpurRequest).toHaveBeenCalledWith("/sessions/api-a1/artifacts/shot.png");
  });

  it("GET /api/sessions/:id/artifacts/:artifactId returns 502 on daemon error", async () => {
    mockedSpurRequest.mockRejectedValue(new Error("Artifact unavailable"));

    const response = await getSessionArtifact(
      new Request("http://localhost:3000/api/sessions/api-a1/artifacts/shot.png"),
      { params: Promise.resolve({ id: "api-a1", artifactId: "shot.png" }) },
    );
    const payload = (await response.json()) as { error: string };

    expect(response.status).toBe(502);
    expect(payload.error).toBe("Artifact unavailable");
  });

  // ── POST /api/spawn ────────────────────────────────────────────────────

  it("POST /api/spawn accepts a missing prompt and proxies an empty prompt to Spur", async () => {
    mockedSpurRequestJson.mockResolvedValue(sessionFixture());

    const response = await spawnSession(
      new NextRequest("http://localhost:3000/api/spawn", {
        method: "POST",
        body: JSON.stringify({ projectId: "api", agent: "claude" }),
      }),
    );

    expect(response.status).toBe(201);
    expect(mockedSpurRequestJson).toHaveBeenCalledWith(
      "/sessions/background",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ project: "api", prompt: "", agent: "claude" }),
      }),
    );
  });

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

  it("POST /api/spawn forwards optional fields: branch, planMode, steps, overrides", async () => {
    mockedSpurRequestJson.mockResolvedValue(sessionFixture());

    const response = await spawnSession(
      new NextRequest("http://localhost:3000/api/spawn", {
        method: "POST",
        body: JSON.stringify({
          projectId: "api",
          prompt: "Do work",
          agent: "codex",
          branch: "feat/new",
          planMode: true,
          steps: ["step 1", "  ", "step 2"],
          overrides: { worktree: true },
        }),
      }),
    );

    expect(response.status).toBe(201);
    expect(mockedSpurRequestJson).toHaveBeenCalledWith(
      "/sessions/background",
      expect.objectContaining({
        body: JSON.stringify({
          project: "api",
          prompt: "Do work",
          agent: "codex",
          branch: "feat/new",
          planMode: true,
          steps: ["step 1", "step 2"],
          overrides: { worktree: true },
        }),
      }),
    );
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

  it("POST /api/spawn returns 502 when daemon fails", async () => {
    mockedSpurRequestJson.mockRejectedValue(new Error("Daemon down"));

    const response = await spawnSession(
      new NextRequest("http://localhost:3000/api/spawn", {
        method: "POST",
        body: JSON.stringify({ projectId: "api" }),
      }),
    );

    expect(response.status).toBe(502);
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
    expect(mockedSpurRequestJson).not.toHaveBeenCalled();
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

  it("POST /api/sessions/:id/send forwards message to daemon", async () => {
    mockedSpurRequestJson.mockResolvedValue({ ok: true });

    const response = await sendMessage(
      new NextRequest("http://localhost:3000/api/sessions/api-a1/send", {
        method: "POST",
        body: JSON.stringify({ message: "Hello agent" }),
      }),
      { params: Promise.resolve({ id: "api-a1" }) },
    );

    expect(response.status).toBe(200);
    expect(mockedSpurRequestJson).toHaveBeenCalledWith(
      "/sessions/api-a1/send",
      expect.objectContaining({
        body: JSON.stringify({ message: "Hello agent", attachments: undefined }),
      }),
    );
  });

  it("POST /api/sessions/:id/send forwards direct-send options to daemon", async () => {
    mockedSpurRequestJson.mockResolvedValue({ ok: true });

    const response = await sendMessage(
      new NextRequest("http://localhost:3000/api/sessions/api-a1/send", {
        method: "POST",
        body: JSON.stringify({ message: "Hello now", queue: false, interrupt: true }),
      }),
      { params: Promise.resolve({ id: "api-a1" }) },
    );

    expect(response.status).toBe(200);
    expect(mockedSpurRequestJson).toHaveBeenCalledWith(
      "/sessions/api-a1/send",
      expect.objectContaining({
        body: JSON.stringify({
          message: "Hello now",
          attachments: undefined,
          queue: false,
          interrupt: true,
        }),
      }),
    );
  });

  it("POST /api/sessions/:id/send accepts attachments with empty message", async () => {
    mockedSpurRequestJson.mockResolvedValue({ ok: true });
    const attachments = [{ name: "img.png", data: "base64data" }];

    const response = await sendMessage(
      new NextRequest("http://localhost:3000/api/sessions/api-a1/send", {
        method: "POST",
        body: JSON.stringify({ message: "", attachments }),
      }),
      { params: Promise.resolve({ id: "api-a1" }) },
    );

    expect(response.status).toBe(200);
    expect(mockedSpurRequestJson).toHaveBeenCalledWith(
      "/sessions/api-a1/send",
      expect.objectContaining({
        body: JSON.stringify({ message: "", attachments }),
      }),
    );
  });

  it("POST /api/sessions/:id/send returns 502 on daemon error", async () => {
    mockedSpurRequestJson.mockRejectedValue(new Error("Session gone"));

    const response = await sendMessage(
      new NextRequest("http://localhost:3000/api/sessions/api-a1/send", {
        method: "POST",
        body: JSON.stringify({ message: "Hi" }),
      }),
      { params: Promise.resolve({ id: "api-a1" }) },
    );

    expect(response.status).toBe(502);
  });

  // ── Lifecycle actions ──────────────────────────────────────────────────

  it("POST lifecycle actions proxy to Spur daemon", async () => {
    mockedSpurRequestJson.mockResolvedValue({ ok: true });

    const routes = [
      [pauseSession, "pause"],
      [completeSession, "complete"],
      [killSession, "kill"],
      [restoreSession, "restore"],
    ] as const;

    for (const [route, action] of routes) {
      const response = await route(
        new NextRequest(`http://localhost:3000/api/sessions/api-a1/${action}`, { method: "POST" }),
        { params: Promise.resolve({ id: "api-a1" }) },
      );
      expect(response.status).toBe(200);
    }

    expect(mockedSpurRequestJson).toHaveBeenCalledWith(
      "/sessions/api-a1/pause",
      expect.objectContaining({ method: "POST" }),
    );
    expect(mockedSpurRequestJson).toHaveBeenCalledWith(
      "/sessions/api-a1/complete",
      expect.objectContaining({ method: "POST" }),
    );
    expect(mockedSpurRequestJson).toHaveBeenCalledWith(
      "/sessions/api-a1/kill",
      expect.objectContaining({ method: "POST" }),
    );
    expect(mockedSpurRequestJson).toHaveBeenCalledWith(
      "/sessions/api-a1/restore",
      expect.objectContaining({ method: "POST" }),
    );
  });

  it("POST lifecycle actions return 502 on daemon error", async () => {
    mockedSpurRequestJson.mockRejectedValue(new Error("Daemon error"));

    const response = await pauseSession(
      new NextRequest("http://localhost:3000/api/sessions/api-a1/pause", { method: "POST" }),
      { params: Promise.resolve({ id: "api-a1" }) },
    );

    expect(response.status).toBe(502);
  });

  // ── POST /api/sessions/:id/respawn ─────────────────────────────────────

  it("POST /api/sessions/:id/respawn proxies to daemon", async () => {
    mockedSpurRequestJson.mockResolvedValue({ ok: true });

    const response = await respawnSession(
      new Request("http://localhost:3000/api/sessions/api-a1/respawn", { method: "POST" }),
      { params: Promise.resolve({ id: "api-a1" }) },
    );

    expect(response.status).toBe(200);
    expect(mockedSpurRequestJson).toHaveBeenCalledWith(
      "/sessions/api-a1/respawn",
      expect.objectContaining({ method: "POST" }),
    );
  });

  it("POST /api/sessions/:id/respawn returns 502 on daemon error", async () => {
    mockedSpurRequestJson.mockRejectedValue(new Error("Cannot respawn"));

    const response = await respawnSession(
      new Request("http://localhost:3000/api/sessions/api-a1/respawn", { method: "POST" }),
      { params: Promise.resolve({ id: "api-a1" }) },
    );

    expect(response.status).toBe(502);
  });

  // ── POST /api/sessions/:id/sidecars/:name/{start,stop} ────────────────

  it("POST /api/sessions/:id/sidecars/:name/start proxies to daemon", async () => {
    mockedSpurRequestJson.mockResolvedValue(sessionFixture());

    const response = await startSidecar(
      new Request("http://localhost:3000/api/sessions/api-a1/sidecars/dev/start", {
        method: "POST",
      }),
      { params: Promise.resolve({ id: "api-a1", name: "dev" }) },
    );

    expect(response.status).toBe(200);
    expect(mockedSpurRequestJson).toHaveBeenCalledWith(
      "/sessions/api-a1/sidecars/dev/start",
      expect.objectContaining({ method: "POST" }),
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
    mockedSpurRequestJson.mockResolvedValue(sessionFixture({ id: "api/a 1" }));

    await startSidecar(
      new Request("http://localhost:3000/api/sessions/api%2Fa%201/sidecars/dev%2Fui/start", {
        method: "POST",
      }),
      { params: Promise.resolve({ id: "api/a 1", name: "dev/ui" }) },
    );

    expect(mockedSpurRequestJson).toHaveBeenCalledWith(
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
          agent: "codex",
          overrides: { worktree: true },
        }),
      }),
    );

    const body = JSON.parse(
      (mockedSpurRequestJson.mock.calls[0][1] as { body: string }).body,
    ) as Record<string, unknown>;
    expect(body).toMatchObject({ agent: "codex", overrides: { worktree: true } });
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

  // ── GET /api/runtime/terminal ──────────────────────────────────────────

  it("GET /api/runtime/terminal returns the direct terminal port", async () => {
    process.env["DIRECT_TERMINAL_PORT"] = "14999";

    const response = await runtimeTerminalConfig();
    const payload = (await response.json()) as { directTerminalPort: string };

    expect(response.status).toBe(200);
    expect(payload).toEqual({ directTerminalPort: "14999" });
  });

  it("GET /api/runtime/terminal prefers public terminal port when configured", async () => {
    process.env["DIRECT_TERMINAL_BIND_PORT"] = "14801";
    process.env["DIRECT_TERMINAL_PUBLIC_PORT"] = "443";

    const response = await runtimeTerminalConfig();
    const payload = (await response.json()) as { directTerminalPort: string };

    expect(response.status).toBe(200);
    expect(payload).toEqual({ directTerminalPort: "443" });
  });

  it("GET /api/runtime/terminal returns default port when no env vars are set", async () => {
    const response = await runtimeTerminalConfig();
    const payload = (await response.json()) as { directTerminalPort: string };

    expect(response.status).toBe(200);
    expect(payload).toEqual({ directTerminalPort: "14801" });
  });

  it("GET /api/runtime/terminal ignores non-numeric DIRECT_TERMINAL_PORT", async () => {
    process.env["DIRECT_TERMINAL_PORT"] = "not-a-port";

    const response = await runtimeTerminalConfig();
    const payload = (await response.json()) as { directTerminalPort: string };

    expect(response.status).toBe(200);
    expect(payload).toEqual({ directTerminalPort: "14801" });
  });

  it("GET /api/runtime/terminal ignores out-of-range port", async () => {
    process.env["DIRECT_TERMINAL_PORT"] = "99999";

    const response = await runtimeTerminalConfig();
    const payload = (await response.json()) as { directTerminalPort: string };

    expect(response.status).toBe(200);
    expect(payload).toEqual({ directTerminalPort: "14801" });
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
    mockedSpurRequestJson.mockResolvedValue([]);
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
    expect(await firstResponse.json()).toEqual({ available: false, daemonAlive: true });

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
      daemonAlive: true,
      cpuPercent: 33,
      memoryPercent: 75,
      diskPercent: 75,
    });
    expect(cpuReads).toBe(2);
  });

  it("GET /api/runtime/resources returns available:false on unsupported platforms and read errors", async () => {
    Object.defineProperty(process, "platform", { value: "darwin" });
    mockedSpurRequestJson.mockRejectedValue(new Error("daemon unavailable"));
    const unsupported = await runtimeResources();
    expect(unsupported.status).toBe(200);
    expect(await unsupported.json()).toEqual({ available: false, daemonAlive: false });

    Object.defineProperty(process, "platform", { value: "linux" });
    mockedReadFile.mockRejectedValue(new Error("read failed"));
    const errored = await runtimeResources();
    expect(errored.status).toBe(200);
    expect(await errored.json()).toEqual({ available: false, daemonAlive: false });
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

  // ── GET /api/pr-status ─────────────────────────────────────────────────

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
    });

    afterEach(() => {
      vi.unstubAllGlobals();
      delete process.env["GITHUB_TOKEN"];
    });

    function makePrGql(overrides: Record<string, unknown> = {}) {
      return {
        data: {
          repository: {
            pullRequest: {
              state: "OPEN",
              isDraft: false,
              merged: false,
              reviewThreads: { nodes: [] },
              commits: { nodes: [{ commit: { statusCheckRollup: null } }] },
              ...overrides,
            },
          },
        },
      };
    }

    function ghOk(body: unknown) {
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

    it("returns 400 when url param is missing", async () => {
      const response = await getPrStatus(new NextRequest("http://localhost:3000/api/pr-status"));
      expect(response.status).toBe(400);
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it("returns 400 for a non-GitHub URL", async () => {
      const response = await getPrStatus(
        new NextRequest(
          "http://localhost:3000/api/pr-status?url=https://gitlab.com/foo/bar/issues/1",
        ),
      );
      expect(response.status).toBe(400);
      expect(fetchMock).not.toHaveBeenCalled();
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
      expect(payload).toEqual({
        state: null,
        ciStatus: null,
        totalThreads: 0,
        unresolvedThreads: 0,
      });
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

    // Rate-limit tests must run last: they set module-level rateLimitResetAt
    it("returns a soft error while rate-limit window is active", async () => {
      const resetAt = Math.floor((Date.now() + 30_000) / 1000);
      fetchMock.mockResolvedValueOnce({
        ok: false,
        status: 403,
        headers: new Headers({ "x-ratelimit-reset": String(resetAt) }),
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
  });
});
