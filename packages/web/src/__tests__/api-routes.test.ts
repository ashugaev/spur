import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@/lib/spur-daemon", () => ({
  spurRequestJson: vi.fn(),
  spurJsonInit: vi.fn((method: string, body?: unknown) => ({
    method,
    headers: { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  })),
}));

vi.mock("@/lib/spur-projects", () => ({
  readSpurProjectOptions: vi.fn(() => [{ id: "sp", name: "Spur Core" }]),
}));

import { spurRequestJson } from "@/lib/spur-daemon";
import { readSpurProjectOptions } from "@/lib/spur-projects";
import { GET as listSessions } from "@/app/api/sessions/route";
import { POST as spawnSession } from "@/app/api/spawn/route";
import { GET as runtimeTerminalConfig } from "@/app/api/runtime/terminal/route";
import { POST as sendMessage } from "@/app/api/sessions/[id]/send/route";
import { POST as pauseSession } from "@/app/api/sessions/[id]/pause/route";
import { POST as completeSession } from "@/app/api/sessions/[id]/complete/route";
import { POST as killSession } from "@/app/api/sessions/[id]/kill/route";
import { POST as restoreSession } from "@/app/api/sessions/[id]/restore/route";

const mockedSpurRequestJson = vi.mocked(spurRequestJson);
const mockedReadSpurProjectOptions = vi.mocked(readSpurProjectOptions);

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
    ...overrides,
  };
}

describe("Spur web API routes", () => {
  beforeEach(() => {
    mockedSpurRequestJson.mockReset();
    mockedReadSpurProjectOptions.mockReset();
    mockedReadSpurProjectOptions.mockReturnValue([{ id: "sp", name: "Spur Core" }]);
    delete process.env["DIRECT_TERMINAL_PORT"];
  });

  it("GET /api/sessions filters by project", async () => {
    mockedSpurRequestJson.mockResolvedValue([
      sessionFixture(),
      sessionFixture({
        id: "web-b2",
        project: "web",
        agent: "codex",
        prompt: "Polish UI",
        branch: "feat/ui",
        tmuxSession: "web-b2",
        status: "paused",
        state: "waiting",
        worktreePath: "/tmp/web-b2",
      }),
    ]);

    const response = await listSessions(
      new NextRequest("http://localhost:3000/api/sessions?project=api"),
    );
    const payload = (await response.json()) as { sessions: Array<{ id: string; project: string }> };

    expect(response.status).toBe(200);
    expect(payload.sessions).toHaveLength(1);
    expect(payload.sessions[0]).toMatchObject({ id: "api-a1", project: "api" });
  });

  it("GET /api/sessions returns only configured spawn project options", async () => {
    mockedSpurRequestJson.mockResolvedValue([
      sessionFixture(),
      sessionFixture({
        id: "ops-a1",
        project: "ops",
        tmuxSession: "ops-a1",
        worktreePath: "/tmp/ops-a1",
      }),
    ]);

    const response = await listSessions(new NextRequest("http://localhost:3000/api/sessions"));
    const payload = (await response.json()) as {
      projects: Array<{ id: string; name: string }>;
    };

    expect(response.status).toBe(200);
    expect(payload.projects).toEqual([{ id: "sp", name: "Spur Core" }]);
  });

  it("POST /api/spawn validates body and proxies to Spur", async () => {
    mockedSpurRequestJson.mockResolvedValue(sessionFixture());

    const response = await spawnSession(
      new NextRequest("http://localhost:3000/api/spawn", {
        method: "POST",
        body: JSON.stringify({ projectId: "api", prompt: "Fix auth", agent: "claude" }),
      }),
    );

    expect(response.status).toBe(201);
    expect(mockedSpurRequestJson).toHaveBeenCalledWith(
      "/sessions",
      expect.objectContaining({ method: "POST" }),
    );
  });

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

  it("GET /api/runtime/terminal returns the direct terminal port", async () => {
    process.env["DIRECT_TERMINAL_PORT"] = "14999";

    const response = await runtimeTerminalConfig();
    const payload = (await response.json()) as { directTerminalPort: string };

    expect(response.status).toBe(200);
    expect(payload).toEqual({ directTerminalPort: "14999" });
  });
});
