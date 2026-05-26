import {
  fireEvent,
  render as rtlRender,
  screen,
  waitFor,
  within,
  type RenderOptions,
} from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { type ReactElement, type ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { Dashboard } from "@/components/Dashboard";

function createTestQueryClient() {
  return new QueryClient({
    defaultOptions: {
      queries: { retry: false, refetchOnWindowFocus: false, staleTime: 0 },
    },
  });
}

function render(ui: ReactElement, options?: RenderOptions) {
  const client = createTestQueryClient();
  const Wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
  return rtlRender(ui, { wrapper: Wrapper, ...options });
}

vi.mock("next/font/google", () => ({
  JetBrains_Mono: () => ({ variable: "--font-jetbrains-mono" }),
}));

vi.mock("@/components/DirectTerminal", () => ({
  DirectTerminal: ({ sessionId }: { sessionId: string }) => (
    <div>{`Direct terminal ${sessionId}`}</div>
  ),
}));

function ghostSession() {
  return {
    id: "ghost-1",
    project: "ghost-id",
    agent: "claude",
    prompt: "Continuing work",
    branch: null,
    worktree: false,
    tmuxSession: "ghost-1",
    status: "running",
    state: "working",
    createdAt: "2026-04-02T10:00:00.000Z",
    updatedAt: "2026-04-02T10:00:00.000Z",
    lastActivityAt: "2026-04-02T10:00:00.000Z",
    runtimeAlive: true,
    workspaceExists: true,
    worktreePath: "/tmp/ghost-1",
    services: [],
  };
}

describe("Dashboard project create/delete", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    window.localStorage.clear();
    window.history.replaceState(null, "", "/");
  });

  it("clicking the Configure pill posts bootstrap=true to /api/spawn", async () => {
    let spawnInit: RequestInit | undefined;
    vi.spyOn(global, "fetch").mockImplementation(async (input, init) => {
      const url = typeof input === "string" ? input : input.url;
      if (url === "/api/runtime/resources") {
        return new Response(JSON.stringify({ available: false }));
      }
      if (url === "/api/runtime/voice") {
        return new Response(JSON.stringify({ available: false, language: "" }));
      }
      if (url === "/api/sessions") {
        return new Response(
          JSON.stringify({
            projects: [
              {
                id: "stub",
                name: "Stub",
                configured: false,
                prefix: "stub",
                path: "/tmp/stub",
              },
            ],
            sessions: [],
          }),
          { status: 200 },
        );
      }
      if (url === "/api/spawn") {
        spawnInit = init;
        return new Response(
          JSON.stringify({
            id: "stub-bootstrap-1",
            project: "stub",
            agent: "claude",
            prompt: "",
            branch: null,
            worktree: false,
            tmuxSession: "stub-bootstrap-1",
            status: "spawning",
            state: "working",
            createdAt: "2026-04-02T10:00:00.000Z",
            updatedAt: "2026-04-02T10:00:00.000Z",
            lastActivityAt: "2026-04-02T10:00:00.000Z",
            runtimeAlive: true,
            workspaceExists: true,
            worktreePath: "/tmp/stub",
            services: [],
          }),
          { status: 201 },
        );
      }
      throw new Error(`Unexpected fetch: ${url}`);
    });

    render(<Dashboard />);

    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Project actions" })).toBeInTheDocument();
    });

    fireEvent.click(screen.getByRole("button", { name: "Project actions" }));
    fireEvent.click(screen.getByRole("button", { name: "Configure Stub" }));

    await waitFor(() => {
      expect(spawnInit).toBeDefined();
    });

    expect(spawnInit?.method).toBe("POST");
    expect(JSON.parse(spawnInit?.body as string)).toEqual({
      projectId: "stub",
      prompt: "",
      bootstrap: true,
    });
  });

  it("orphan sessions for a deleted project do not resurrect it in dropdowns", async () => {
    vi.spyOn(global, "fetch").mockImplementation(async (input) => {
      const url = typeof input === "string" ? input : input.url;
      if (url === "/api/runtime/resources") {
        return new Response(JSON.stringify({ available: false }));
      }
      if (url === "/api/runtime/voice") {
        return new Response(JSON.stringify({ available: false, language: "" }));
      }
      if (url === "/api/sessions") {
        return new Response(JSON.stringify({ projects: [], sessions: [ghostSession()] }), {
          status: 200,
        });
      }
      throw new Error(`Unexpected fetch: ${url}`);
    });

    render(<Dashboard />);

    await waitFor(() => {
      expect(
        screen.getByRole("button", { name: "Open web terminal for ghost-1" }),
      ).toBeInTheDocument();
    });

    const filterSelect = screen.getByRole("combobox", { name: "Project filter" });
    expect(within(filterSelect).queryByRole("option", { name: "ghost-id" })).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Project actions" }));
    expect(screen.queryByRole("button", { name: "Delete ghost-id" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Configure ghost-id" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Project actions" }));

    fireEvent.click(screen.getByRole("button", { name: "Spawn Session" }));
    const spawnProjectSelect = screen.getByRole("combobox", { name: "Spawn project" });
    expect(within(spawnProjectSelect).queryByRole("option", { name: "ghost-id" })).toBeNull();
  });
});
