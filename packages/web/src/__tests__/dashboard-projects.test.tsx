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

function projectFilterButton() {
  return screen.getByRole("button", { name: "Project filter" });
}

function openProjectMenu() {
  fireEvent.click(projectFilterButton());
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

  it("auto-spawns a bootstrap session after creating a project", async () => {
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
        return new Response(JSON.stringify({ projects: [], sessions: [] }), { status: 200 });
      }
      if (url === "/api/projects" && init?.method === "POST") {
        const entry = {
          id: "demo",
          name: "Demo",
          configured: false,
          prefix: "demo",
          path: "/tmp/demo",
        };
        return new Response(JSON.stringify({ id: "demo", entry, projects: [entry] }), {
          status: 201,
        });
      }
      if (url === "/api/spawn") {
        spawnInit = init;
        return new Response(
          JSON.stringify({
            id: "demo-bootstrap-1",
            project: "demo",
            agent: "claude",
            prompt: "",
            branch: "demo-bootstrap-1",
            worktree: false,
            tmuxSession: "demo-bootstrap-1",
            status: "spawning",
            state: "working",
            createdAt: "2026-04-02T10:00:00.000Z",
            updatedAt: "2026-04-02T10:00:00.000Z",
            lastActivityAt: "2026-04-02T10:00:00.000Z",
            runtimeAlive: true,
            workspaceExists: true,
            worktreePath: "/tmp/demo",
            services: [],
          }),
          { status: 201 },
        );
      }
      throw new Error(`Unexpected fetch: ${url}`);
    });

    render(<Dashboard />);

    await waitFor(() => {
      expect(projectFilterButton()).toBeInTheDocument();
    });

    openProjectMenu();
    fireEvent.click(screen.getByRole("button", { name: "+ New project" }));
    fireEvent.change(screen.getByLabelText("Display name"), { target: { value: "Demo" } });
    fireEvent.change(screen.getByLabelText("Session prefix"), { target: { value: "demo" } });
    fireEvent.change(screen.getByLabelText("Project path"), { target: { value: "/tmp/demo" } });
    fireEvent.click(screen.getByRole("button", { name: "Create", exact: true }));

    await waitFor(() => {
      expect(spawnInit).toBeDefined();
    });

    expect(spawnInit?.method).toBe("POST");
    expect(JSON.parse(spawnInit?.body as string)).toEqual({
      projectId: "demo",
      prompt: "",
      bootstrap: true,
    });
  });

  it("shows a create-folder alert when the daemon reports a missing path and re-posts with createMissing", async () => {
    const projectCalls: Array<{ body: unknown }> = [];
    vi.spyOn(global, "fetch").mockImplementation(async (input, init) => {
      const url = typeof input === "string" ? input : input.url;
      if (url === "/api/runtime/resources") {
        return new Response(JSON.stringify({ available: false }));
      }
      if (url === "/api/runtime/voice") {
        return new Response(JSON.stringify({ available: false, language: "" }));
      }
      if (url === "/api/sessions") {
        return new Response(JSON.stringify({ projects: [], sessions: [] }), { status: 200 });
      }
      if (url === "/api/projects" && init?.method === "POST") {
        const parsed = JSON.parse(String(init.body)) as { createMissing?: boolean };
        projectCalls.push({ body: parsed });
        if (parsed.createMissing === true) {
          return new Response(
            JSON.stringify({
              id: "demo-app",
              entry: {
                id: "demo-app",
                name: "Demo App",
                configured: false,
                prefix: "demo",
                path: "/tmp/demo-app",
              },
              projects: [],
            }),
            { status: 201 },
          );
        }
        return new Response(JSON.stringify({ error: "path does not exist: /tmp/demo-app" }), {
          status: 400,
        });
      }
      if (url === "/api/spawn") {
        return new Response(
          JSON.stringify({
            id: "demo-bootstrap-1",
            project: "demo-app",
            agent: "claude",
            prompt: "",
            branch: "demo-bootstrap-1",
            worktree: false,
            tmuxSession: "demo-bootstrap-1",
            status: "spawning",
            state: "working",
            createdAt: "2026-04-02T10:00:00.000Z",
            updatedAt: "2026-04-02T10:00:00.000Z",
            lastActivityAt: "2026-04-02T10:00:00.000Z",
            runtimeAlive: true,
            workspaceExists: true,
            worktreePath: "/tmp/demo-app",
            services: [],
          }),
          { status: 201 },
        );
      }
      throw new Error(`Unexpected fetch: ${url}`);
    });

    render(<Dashboard />);

    await waitFor(() => {
      expect(projectFilterButton()).toBeInTheDocument();
    });

    openProjectMenu();
    fireEvent.click(screen.getByRole("button", { name: /New project/ }));

    fireEvent.change(screen.getByLabelText("Project display name"), {
      target: { value: "Demo App" },
    });
    fireEvent.change(screen.getByLabelText("Project session prefix"), {
      target: { value: "demo" },
    });
    fireEvent.change(screen.getByLabelText("Project path"), {
      target: { value: "/tmp/demo-app" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Create" }));

    await waitFor(() => {
      expect(screen.getByText(/Folder doesn't exist\. Create it\?/)).toBeInTheDocument();
    });
    expect(projectCalls).toHaveLength(1);
    expect(projectCalls[0]?.body).toEqual({
      displayName: "Demo App",
      prefix: "demo",
      path: "/tmp/demo-app",
    });
    expect(screen.queryByText(/path does not exist/)).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: /Create folder & continue/ }));

    await waitFor(() => {
      expect(projectCalls).toHaveLength(2);
    });
    expect(projectCalls[1]?.body).toEqual({
      displayName: "Demo App",
      prefix: "demo",
      path: "/tmp/demo-app",
      createMissing: true,
    });
  });

  it("edits an unconfigured project from the project menu", async () => {
    let updateInit: RequestInit | undefined;
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
              { id: "api", name: "API", configured: true, prefix: "api", path: "/repo/api" },
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
      if (url === "/api/projects/stub" && init?.method === "PATCH") {
        updateInit = init;
        return new Response(
          JSON.stringify({
            id: "stub",
            entry: {
              id: "stub",
              name: "Stub Two",
              configured: false,
              prefix: "stub2",
              path: "/tmp/stub-two",
            },
            projects: [
              { id: "api", name: "API", configured: true, prefix: "api", path: "/repo/api" },
              {
                id: "stub",
                name: "Stub Two",
                configured: false,
                prefix: "stub2",
                path: "/tmp/stub-two",
              },
            ],
          }),
        );
      }
      throw new Error(`Unexpected fetch: ${url}`);
    });

    render(<Dashboard />);

    await waitFor(() => {
      expect(projectFilterButton()).toBeInTheDocument();
    });

    openProjectMenu();
    fireEvent.click(screen.getByRole("button", { name: "Edit Stub" }));
    fireEvent.change(screen.getByLabelText("Edit project display name"), {
      target: { value: "Stub Two" },
    });
    fireEvent.change(screen.getByLabelText("Edit project session prefix"), {
      target: { value: "stub2" },
    });
    fireEvent.change(screen.getByLabelText("Edit project path"), {
      target: { value: "/tmp/stub-two" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => {
      expect(updateInit).toBeDefined();
    });
    expect(updateInit?.method).toBe("PATCH");
    expect(updateInit?.body).toBe(
      JSON.stringify({
        displayName: "Stub Two",
        prefix: "stub2",
        path: "/tmp/stub-two",
      }),
    );
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

    openProjectMenu();
    expect(screen.queryByRole("button", { name: "ghost-id" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Delete ghost-id" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Configure ghost-id" })).toBeNull();
    fireEvent.click(projectFilterButton());

    fireEvent.click(screen.getByRole("button", { name: "Spawn Session" }));
    const spawnProjectSelect = screen.getByRole("combobox", { name: "Spawn project" });
    expect(within(spawnProjectSelect).queryByRole("option", { name: "ghost-id" })).toBeNull();
  });
});
