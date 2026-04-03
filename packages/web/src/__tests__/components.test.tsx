import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { Dashboard } from "@/components/Dashboard";

vi.mock("next/navigation", () => ({
  useSearchParams: () => new URLSearchParams(""),
}));

vi.mock("@/components/DirectTerminal", () => ({
  DirectTerminal: ({ label, sessionId }: { label?: string; sessionId: string }) => (
    <div>{`Direct terminal ${label ?? sessionId}`}</div>
  ),
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
      expect(screen.getByRole("heading", { name: "Fleet Overview" })).toBeInTheDocument();
      expect(screen.getByRole("link", { name: "Fix auth" })).toBeInTheDocument();
      expect(
        screen.getByRole("button", { name: "Open web terminal for api-a1" }),
      ).toBeInTheDocument();
    });
  });

  it("renders compact cards with a direct terminal action", async () => {
    vi.spyOn(global, "fetch").mockImplementation(async (input) => {
      const url = typeof input === "string" ? input : input.url;

      if (url === "/api/sessions") {
        return new Response(JSON.stringify(sessionsPayload()), { status: 200 });
      }

      throw new Error(`Unexpected fetch: ${url}`);
    });

    render(<Dashboard />);

    await waitFor(() => {
      expect(
        screen.getByRole("button", { name: "Open web terminal for api-a1" }),
      ).toBeInTheDocument();
    });

    expect(screen.queryByText("Send message")).not.toBeInTheDocument();
    expect(screen.queryByPlaceholderText("Message to the running agent")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Pause" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Complete" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Kill" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Details" })).not.toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Fix auth" })).toHaveAttribute(
      "href",
      "/sessions/api-a1?project=api",
    );

    fireEvent.click(screen.getByRole("button", { name: "Open web terminal for api-a1" }));

    await waitFor(() => {
      expect(screen.getByRole("dialog", { name: "Terminal api-a1" })).toBeInTheDocument();
      expect(screen.getByText("Direct terminal api-a1")).toBeInTheDocument();
    });
  });

  it("keeps discovered projects in the filter but only configured projects in spawn", async () => {
    vi.spyOn(global, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({
          projects: [{ id: "sp", name: "Spur Core" }],
          sessions: [
            {
              ...sessionsPayload().sessions[0],
              id: "spur-local-1",
              project: "spur-local",
              tmuxSession: "spur-local-1",
            },
          ],
        }),
      ),
    );

    render(<Dashboard />);

    await waitFor(() => {
      expect(
        screen.getByRole("button", { name: "Open web terminal for spur-local-1" }),
      ).toBeInTheDocument();
    });

    const filterSelect = screen.getByRole("combobox");
    expect(within(filterSelect).getByRole("option", { name: "spur-local" })).toBeInTheDocument();
    expect(within(filterSelect).getByRole("option", { name: "Spur Core" })).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Spawn_New_Session" }));
    const spawnSelects = screen.getAllByRole("combobox");
    const spawnProjectSelect = spawnSelects[1];
    expect(
      within(spawnProjectSelect).queryByRole("option", { name: "spur-local" }),
    ).not.toBeInTheDocument();
    expect(
      within(spawnProjectSelect).getByRole("option", { name: "Spur Core" }),
    ).toBeInTheDocument();
  });
});
