import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { Dashboard } from "@/components/Dashboard";

vi.mock("next/navigation", () => ({
  useSearchParams: () => new URLSearchParams(""),
}));

function sessionsPayload() {
  return {
    projects: [{ id: "api", name: "API" }],
    sessions: [
      {
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
      },
    ],
  };
}

describe("Dashboard", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("renders Spur dashboard sessions from API", async () => {
    vi.spyOn(global, "fetch").mockResolvedValue(new Response(JSON.stringify(sessionsPayload())));

    render(<Dashboard />);

    await waitFor(() => {
      expect(screen.getByRole("heading", { name: "All projects" })).toBeInTheDocument();
      expect(screen.getByText("Fix auth")).toBeInTheDocument();
      expect(screen.getByText("api-a1")).toBeInTheDocument();
    });
  });

  it("renders compact cards with a direct terminal action", async () => {
    const fetchMock = vi.spyOn(global, "fetch").mockImplementation(async (input, init) => {
      const url = typeof input === "string" ? input : input.url;

      if (url === "/api/sessions/api-a1/attach") {
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      }

      if (url === "/api/sessions") {
        return new Response(JSON.stringify(sessionsPayload()), { status: 200 });
      }

      throw new Error(`Unexpected fetch: ${url} (${JSON.stringify(init)})`);
    });

    render(<Dashboard />);

    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Open terminal" })).toBeInTheDocument();
    });

    expect(screen.queryByText("Send message")).not.toBeInTheDocument();
    expect(screen.queryByPlaceholderText("Message to the running agent")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Pause" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Complete" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Kill" })).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Open terminal" }));

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith("/api/sessions/api-a1/attach", { method: "POST" });
    });
  });
});
