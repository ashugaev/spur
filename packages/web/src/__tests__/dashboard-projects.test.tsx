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
import { writeSpawnDraft } from "@/lib/spawn-draft";

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
  return screen.getByRole("button", { name: /Project filter:/ });
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
    fireEvent.click(screen.getByRole("menuitem", { name: "+ New project" }));
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

  it("creates a project without a path, posting only displayName and prefix", async () => {
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
        const parsed = JSON.parse(String(init.body)) as unknown;
        projectCalls.push({ body: parsed });
        const entry = {
          id: "demo",
          name: "Demo",
          configured: false,
          prefix: "demo",
          path: "/data/projects/demo",
        };
        return new Response(JSON.stringify({ id: "demo", entry, projects: [entry] }), {
          status: 201,
        });
      }
      if (url === "/api/spawn") {
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
            worktreePath: "/data/projects/demo",
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
    fireEvent.click(screen.getByRole("menuitem", { name: "+ New project" }));
    fireEvent.change(screen.getByLabelText("Display name"), { target: { value: "Demo" } });
    fireEvent.change(screen.getByLabelText("Session prefix"), { target: { value: "demo" } });
    fireEvent.click(screen.getByRole("button", { name: "Create", exact: true }));

    await waitFor(() => {
      expect(projectCalls).toHaveLength(1);
    });
    expect(projectCalls[0]?.body).toEqual({ displayName: "Demo", prefix: "demo" });
    expect(screen.queryByText("Path is required")).toBeNull();
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
    fireEvent.click(screen.getByRole("menuitem", { name: /New project/ }));

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
    fireEvent.click(screen.getByRole("menuitem", { name: "Edit Stub" }));
    expect(screen.getByRole("dialog", { name: "Project settings" })).toBeInTheDocument();
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

  it("marks the selected project in the project menu", async () => {
    vi.spyOn(global, "fetch").mockImplementation(async (input) => {
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
              { id: "web", name: "Web", configured: true, prefix: "web", path: "/repo/web" },
            ],
            sessions: [],
          }),
          { status: 200 },
        );
      }
      throw new Error(`Unexpected fetch: ${url}`);
    });
    window.history.replaceState(null, "", "/?project=api");

    render(<Dashboard />);

    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Project filter: API" })).toBeInTheDocument();
    });

    openProjectMenu();
    expect(screen.getByRole("menu")).toBeInTheDocument();
    expect(screen.getByRole("menuitemradio", { name: "API" })).toHaveAttribute(
      "aria-checked",
      "true",
    );
    expect(screen.getByRole("menuitemradio", { name: "Web" })).toHaveAttribute(
      "aria-checked",
      "false",
    );
  });

  it("confirms project deletion in app instead of using window confirm", async () => {
    let deleteInit: RequestInit | undefined;
    let deleted = false;
    const confirmSpy = vi.spyOn(window, "confirm").mockImplementation(() => {
      throw new Error("native confirm should not open");
    });
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
            projects: deleted
              ? []
              : [
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
      if (url === "/api/projects/stub" && init?.method === "DELETE") {
        deleteInit = init;
        deleted = true;
        return new Response(JSON.stringify({ removedKind: "unconfigured", projects: [] }));
      }
      throw new Error(`Unexpected fetch: ${url}`);
    });

    render(<Dashboard />);

    await waitFor(() => {
      expect(projectFilterButton()).toBeInTheDocument();
    });

    openProjectMenu();
    fireEvent.click(screen.getByRole("menuitem", { name: "Edit Stub" }));
    fireEvent.click(screen.getByRole("button", { name: "Delete" }));

    expect(deleteInit).toBeUndefined();
    expect(confirmSpy).not.toHaveBeenCalled();
    expect(screen.getByText("Delete Stub?")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Cancel Delete" }));
    expect(screen.queryByText("Delete Stub?")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Delete" }));
    fireEvent.click(screen.getByRole("button", { name: "Confirm Delete" }));

    await waitFor(() => {
      expect(deleteInit).toBeDefined();
    });
    expect(deleteInit?.method).toBe("DELETE");
    expect(confirmSpy).not.toHaveBeenCalled();
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

  it("spawns with the project-resolved model and workspace mode when the user touches neither control", async () => {
    let spawnInit: RequestInit | undefined;
    let spawnDefaultsRequests = 0;
    vi.spyOn(global, "fetch").mockImplementation(async (input, init) => {
      const url = typeof input === "string" ? input : input.url;
      if (url.startsWith("/api/projects/api/spawn-defaults")) spawnDefaultsRequests += 1;
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
            ],
            sessions: [],
          }),
          { status: 200 },
        );
      }
      if (url.startsWith("/api/models")) {
        return new Response(
          JSON.stringify({
            models: [
              { id: "sonnet", label: "Sonnet" },
              { id: "opus", label: "Opus" },
            ],
          }),
        );
      }
      if (url.startsWith("/api/projects/api/spawn-defaults")) {
        return new Response(JSON.stringify({ model: "sonnet", worktree: false }));
      }
      if (url === "/api/spawn") {
        spawnInit = init;
        return new Response(
          JSON.stringify({
            id: "api-a1",
            project: "api",
            agent: "claude",
            model: "sonnet",
            prompt: "Do the thing",
            branch: "api-a1",
            worktree: false,
            tmuxSession: "api-a1",
            status: "spawning",
            state: "working",
            createdAt: "2026-04-02T10:00:00.000Z",
            updatedAt: "2026-04-02T10:00:00.000Z",
            lastActivityAt: "2026-04-02T10:00:00.000Z",
            runtimeAlive: true,
            workspaceExists: true,
            worktreePath: "/repo/api",
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

    fireEvent.click(screen.getAllByRole("button", { name: "Spawn Session" })[0]);
    const dialog = screen.getByRole("dialog");
    fireEvent.change(within(dialog).getByLabelText("Prompt..."), {
      target: { value: "Do the thing" },
    });

    const submitButton = () => {
      const button = dialog.querySelector('button[class*="min-w-32"]');
      if (!(button instanceof HTMLButtonElement)) {
        throw new Error("spawn submit button not found");
      }
      return button;
    };
    await waitFor(() => {
      expect(submitButton()).not.toBeDisabled();
    });
    fireEvent.click(submitButton());

    await waitFor(() => {
      expect(spawnInit).toBeDefined();
    });
    const body = JSON.parse(spawnInit?.body as string) as {
      model?: string;
      overrides?: { worktree: boolean };
    };
    expect(body.model).toBe("sonnet");
    expect(body.overrides).toEqual({ worktree: false });
    // Dashboard fetches this once and passes it into ModelSelect; ModelSelect
    // must not also fetch its own copy for the same project+agent.
    expect(spawnDefaultsRequests).toBe(1);
  });

  it("blocks submit and surfaces an error instead of silently guessing worktree when spawn-defaults fails", async () => {
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
              { id: "api", name: "API", configured: true, prefix: "api", path: "/repo/api" },
            ],
            sessions: [],
          }),
          { status: 200 },
        );
      }
      if (url.startsWith("/api/models")) {
        return new Response(JSON.stringify({ models: [{ id: "sonnet", label: "Sonnet" }] }));
      }
      if (url.startsWith("/api/projects/api/spawn-defaults")) {
        return new Response(JSON.stringify({ error: "daemon unreachable" }), { status: 502 });
      }
      if (url === "/api/spawn") {
        spawnInit = init;
        return new Response(
          JSON.stringify({
            id: "api-a1",
            project: "api",
            agent: "claude",
            model: "sonnet",
            prompt: "Do the thing",
            branch: "api-a1",
            worktree: false,
            tmuxSession: "api-a1",
            status: "spawning",
            state: "working",
            createdAt: "2026-04-02T10:00:00.000Z",
            updatedAt: "2026-04-02T10:00:00.000Z",
            lastActivityAt: "2026-04-02T10:00:00.000Z",
            runtimeAlive: true,
            workspaceExists: true,
            worktreePath: "/repo/api",
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

    fireEvent.click(screen.getAllByRole("button", { name: "Spawn Session" })[0]);
    const dialog = screen.getByRole("dialog");
    fireEvent.change(within(dialog).getByLabelText("Prompt..."), {
      target: { value: "Do the thing" },
    });

    const submitButton = () => {
      const button = dialog.querySelector('button[class*="min-w-32"]');
      if (!(button instanceof HTMLButtonElement)) {
        throw new Error("spawn submit button not found");
      }
      return button;
    };

    // The model resolves fine; the workspace default request fails. Submit
    // must stay disabled — never fall through to sending the "worktree"
    // fallback state as if it were the project's real configured default.
    await waitFor(() => {
      expect(within(dialog).getByRole("button", { name: "Spawn model" })).toHaveTextContent(
        "Sonnet",
      );
    });
    expect(submitButton()).toBeDisabled();
    expect(within(dialog).getByText(/daemon unreachable/)).toBeInTheDocument();

    // Only a manual pick unblocks it, and only the user's own explicit
    // choice is what gets sent — never a guess.
    fireEvent.change(within(dialog).getByRole("combobox", { name: "workspace mode" }), {
      target: { value: "shared" },
    });
    await waitFor(() => {
      expect(submitButton()).not.toBeDisabled();
    });
    fireEvent.click(submitButton());

    await waitFor(() => {
      expect(spawnInit).toBeDefined();
    });
    const body = JSON.parse(spawnInit?.body as string) as { overrides?: { worktree: boolean } };
    expect(body.overrides).toEqual({ worktree: false });
  });

  it("unblocks submit when the user confirms the already-selected workspace mode after a spawn-defaults failure", async () => {
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
              { id: "api", name: "API", configured: true, prefix: "api", path: "/repo/api" },
            ],
            sessions: [],
          }),
          { status: 200 },
        );
      }
      if (url.startsWith("/api/models")) {
        return new Response(JSON.stringify({ models: [{ id: "sonnet", label: "Sonnet" }] }));
      }
      if (url.startsWith("/api/projects/api/spawn-defaults")) {
        return new Response(JSON.stringify({ error: "daemon unreachable" }), { status: 502 });
      }
      if (url === "/api/spawn") {
        spawnInit = init;
        return new Response(
          JSON.stringify({
            id: "api-a1",
            project: "api",
            agent: "claude",
            model: "sonnet",
            prompt: "Do the thing",
            branch: "api-a1",
            worktree: true,
            tmuxSession: "api-a1",
            status: "spawning",
            state: "working",
            createdAt: "2026-04-02T10:00:00.000Z",
            updatedAt: "2026-04-02T10:00:00.000Z",
            lastActivityAt: "2026-04-02T10:00:00.000Z",
            runtimeAlive: true,
            workspaceExists: true,
            worktreePath: "/repo/api",
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

    fireEvent.click(screen.getAllByRole("button", { name: "Spawn Session" })[0]);
    const dialog = screen.getByRole("dialog");
    fireEvent.change(within(dialog).getByLabelText("Prompt..."), {
      target: { value: "Do the thing" },
    });

    const submitButton = () => {
      const button = dialog.querySelector('button[class*="min-w-32"]');
      if (!(button instanceof HTMLButtonElement)) {
        throw new Error("spawn submit button not found");
      }
      return button;
    };

    await waitFor(() => {
      expect(within(dialog).getByRole("button", { name: "Spawn model" })).toHaveTextContent(
        "Sonnet",
      );
    });
    expect(submitButton()).toBeDisabled();

    // The select already shows "Worktree" (the initial state), so re-picking
    // it from the select itself fires no native change event — a real
    // <select> does not notify on a same-value re-selection, in any
    // browser. The error banner's explicit "Use worktree" action is a real
    // <button>, so it always fires a click regardless of input modality and
    // regardless of whether the confirmed value matches what's shown.
    const workspaceModeSelect = within(dialog).getByRole("combobox", { name: "workspace mode" });
    expect(workspaceModeSelect).toHaveValue("worktree");
    fireEvent.click(within(dialog).getByRole("button", { name: "Use worktree" }));

    await waitFor(() => {
      expect(submitButton()).not.toBeDisabled();
    });
    fireEvent.click(submitButton());

    await waitFor(() => {
      expect(spawnInit).toBeDefined();
    });
    const body = JSON.parse(spawnInit?.body as string) as { overrides?: { worktree: boolean } };
    expect(body.overrides).toEqual({ worktree: true });
  });

  it("still applies the project's real workspace default after a mousedown-then-dismiss that picks nothing", async () => {
    // B1 regression: opening the workspace-mode select and dismissing it
    // without picking anything is a look-only interaction. It must not be
    // mistaken for a manual override — the project's real (slow-to-arrive)
    // default must still land once the spawn-defaults request settles.
    let resolveSpawnDefaults: ((response: Response) => void) | undefined;
    const pendingSpawnDefaults = new Promise<Response>((resolve) => {
      resolveSpawnDefaults = resolve;
    });
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
              { id: "api", name: "API", configured: true, prefix: "api", path: "/repo/api" },
            ],
            sessions: [],
          }),
          { status: 200 },
        );
      }
      if (url.startsWith("/api/models")) {
        return new Response(JSON.stringify({ models: [{ id: "sonnet", label: "Sonnet" }] }));
      }
      if (url.startsWith("/api/projects/api/spawn-defaults")) return pendingSpawnDefaults;
      if (url === "/api/spawn") {
        spawnInit = init;
        return new Response(
          JSON.stringify({
            id: "api-a1",
            project: "api",
            agent: "claude",
            model: "sonnet",
            prompt: "Do the thing",
            branch: "api-a1",
            worktree: false,
            tmuxSession: "api-a1",
            status: "spawning",
            state: "working",
            createdAt: "2026-04-02T10:00:00.000Z",
            updatedAt: "2026-04-02T10:00:00.000Z",
            lastActivityAt: "2026-04-02T10:00:00.000Z",
            runtimeAlive: true,
            workspaceExists: true,
            worktreePath: "/repo/api",
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

    fireEvent.click(screen.getAllByRole("button", { name: "Spawn Session" })[0]);
    const dialog = screen.getByRole("dialog");
    fireEvent.change(within(dialog).getByLabelText("Prompt..."), {
      target: { value: "Do the thing" },
    });

    // Open the native select (mousedown) and dismiss it without choosing an
    // option — a look-only pass, no confirmation. (Not simulated via an
    // Escape keydown: that bubbles to the modal's own window-level Escape
    // handler in jsdom, closing the whole modal — a real native <select>
    // popup's dismissal is opaque to the page and never does that.)
    const workspaceModeSelect = within(dialog).getByRole("combobox", { name: "workspace mode" });
    expect(workspaceModeSelect).toHaveValue("worktree");
    fireEvent.mouseDown(workspaceModeSelect);
    fireEvent.blur(workspaceModeSelect);

    resolveSpawnDefaults?.(
      new Response(JSON.stringify({ model: null, worktree: false }), { status: 200 }),
    );

    await waitFor(() => {
      expect(workspaceModeSelect).toHaveValue("shared");
    });

    const submitButton = () => {
      const button = dialog.querySelector('button[class*="min-w-32"]');
      if (!(button instanceof HTMLButtonElement)) {
        throw new Error("spawn submit button not found");
      }
      return button;
    };
    await waitFor(() => {
      expect(submitButton()).not.toBeDisabled();
    });
    fireEvent.click(submitButton());

    await waitFor(() => {
      expect(spawnInit).toBeDefined();
    });
    const body = JSON.parse(spawnInit?.body as string) as { overrides?: { worktree: boolean } };
    expect(body.overrides).toEqual({ worktree: false });
  });

  it("confirms the workspace mode via the banner's 'Use shared' action", async () => {
    // jsdom does not synthesize a click from a keydown, so this only
    // exercises a real click (as the case above does for "Use worktree");
    // it is not keyboard-modality coverage.
    vi.spyOn(global, "fetch").mockImplementation(async (input) => {
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
            ],
            sessions: [],
          }),
          { status: 200 },
        );
      }
      if (url.startsWith("/api/models")) {
        return new Response(JSON.stringify({ models: [{ id: "sonnet", label: "Sonnet" }] }));
      }
      if (url.startsWith("/api/projects/api/spawn-defaults")) {
        return new Response(JSON.stringify({ error: "daemon unreachable" }), { status: 502 });
      }
      throw new Error(`Unexpected fetch: ${url}`);
    });

    render(<Dashboard />);

    await waitFor(() => {
      expect(projectFilterButton()).toBeInTheDocument();
    });

    fireEvent.click(screen.getAllByRole("button", { name: "Spawn Session" })[0]);
    const dialog = screen.getByRole("dialog");

    const submitButton = () => {
      const button = dialog.querySelector('button[class*="min-w-32"]');
      if (!(button instanceof HTMLButtonElement)) {
        throw new Error("spawn submit button not found");
      }
      return button;
    };
    await waitFor(() => {
      expect(within(dialog).getByText(/daemon unreachable/)).toBeInTheDocument();
    });
    expect(submitButton()).toBeDisabled();

    const useSharedButton = within(dialog).getByRole("button", { name: "Use shared" });
    fireEvent.click(useSharedButton);

    await waitFor(() => {
      expect(within(dialog).getByRole("combobox", { name: "workspace mode" })).toHaveValue(
        "shared",
      );
      expect(submitButton()).not.toBeDisabled();
    });
  });

  it("re-derives the workspace mode from the newly selected project after a project switch, even with an explicitly-confirmed stored draft", async () => {
    // This targets the in-modal switch path specifically: even a draft
    // that recorded a genuine explicit confirmation (workspaceModeAuto:
    // false) was confirmed against whatever project it was saved for, not
    // against every project. Switching the "Spawn project" picker to a
    // different project must re-enter auto mode and re-resolve to the
    // newly selected project's own configured default.
    writeSpawnDraft({
      prompt: "",
      agent: "claude",
      model: null,
      branch: "",
      branchIsExplicit: false,
      workspaceMode: "worktree",
      workspaceModeAuto: false,
      defaultBranch: "",
      planMode: false,
      selfDestruct: false,
      selfDestructConditions: "",
      steps: [],
      trackerUrl: null,
      sessionMode: null,
    });
    window.localStorage.setItem("spur:last-spawn-project", "api");

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
              { id: "api", name: "API", configured: true, prefix: "api", path: "/repo/api" },
              { id: "web", name: "Web", configured: true, prefix: "web", path: "/repo/web" },
            ],
            sessions: [],
          }),
          { status: 200 },
        );
      }
      if (url.startsWith("/api/models")) {
        return new Response(JSON.stringify({ models: [{ id: "sonnet", label: "Sonnet" }] }));
      }
      if (url.startsWith("/api/projects/api/spawn-defaults")) {
        return new Response(JSON.stringify({ model: null, worktree: true }));
      }
      if (url.startsWith("/api/projects/web/spawn-defaults")) {
        return new Response(JSON.stringify({ model: null, worktree: false }));
      }
      if (url === "/api/spawn") {
        spawnInit = init;
        return new Response(
          JSON.stringify({
            id: "web-a1",
            project: "web",
            agent: "claude",
            model: "sonnet",
            prompt: "Do the thing",
            branch: "web-a1",
            worktree: false,
            tmuxSession: "web-a1",
            status: "spawning",
            state: "working",
            createdAt: "2026-04-02T10:00:00.000Z",
            updatedAt: "2026-04-02T10:00:00.000Z",
            lastActivityAt: "2026-04-02T10:00:00.000Z",
            runtimeAlive: true,
            workspaceExists: true,
            worktreePath: "/repo/web",
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

    fireEvent.click(screen.getAllByRole("button", { name: "Spawn Session" })[0]);
    const dialog = screen.getByRole("dialog");
    fireEvent.change(within(dialog).getByLabelText("Prompt..."), {
      target: { value: "Do the thing" },
    });

    const workspaceModeSelect = within(dialog).getByRole("combobox", { name: "workspace mode" });
    // The restored draft (workspaceMode: "worktree") agrees with the
    // initial project's ("api") own resolved default, so this alone doesn't
    // distinguish the bug.
    await waitFor(() => {
      expect(workspaceModeSelect).toHaveValue("worktree");
    });

    fireEvent.change(within(dialog).getByRole("combobox", { name: "Spawn project" }), {
      target: { value: "web" },
    });

    // "web" is configured shared. The shown mode must follow it, not the
    // stale draft/previous-project value.
    await waitFor(() => {
      expect(workspaceModeSelect).toHaveValue("shared");
    });

    const submitButton = () => {
      const button = dialog.querySelector('button[class*="min-w-32"]');
      if (!(button instanceof HTMLButtonElement)) {
        throw new Error("spawn submit button not found");
      }
      return button;
    };
    await waitFor(() => {
      expect(submitButton()).not.toBeDisabled();
    });
    fireEvent.click(submitButton());

    await waitFor(() => {
      expect(spawnInit).toBeDefined();
    });
    const body = JSON.parse(spawnInit?.body as string) as { overrides?: { worktree: boolean } };
    expect(body.overrides).toEqual({ worktree: false });
  });

  it("re-derives the workspace mode from the dashboard-filter-resolved project on open, even with a stored draft", async () => {
    // B1 regression, dashboard-filter entry point: resolvePreferredSpawnProjectId
    // gives the project FILTER precedence over the last-spawn-project storage
    // key, so the project resolved on open is not necessarily the one the
    // draft's workspaceMode was last auto-derived for. Opening the modal
    // (never touching the in-modal project picker) must still show and send
    // the filter-resolved project's own configured default, not the stale
    // draft value.
    writeSpawnDraft({
      prompt: "",
      agent: "claude",
      model: null,
      branch: "",
      branchIsExplicit: false,
      workspaceMode: "worktree",
      workspaceModeAuto: true,
      defaultBranch: "",
      planMode: false,
      selfDestruct: false,
      selfDestructConditions: "",
      steps: [],
      trackerUrl: null,
      sessionMode: null,
    });
    window.localStorage.setItem("spur:last-spawn-project", "api");
    window.history.replaceState(null, "", "/?project=web");

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
              { id: "api", name: "API", configured: true, prefix: "api", path: "/repo/api" },
              { id: "web", name: "Web", configured: true, prefix: "web", path: "/repo/web" },
            ],
            sessions: [],
          }),
          { status: 200 },
        );
      }
      if (url.startsWith("/api/models")) {
        return new Response(JSON.stringify({ models: [{ id: "sonnet", label: "Sonnet" }] }));
      }
      if (url.startsWith("/api/projects/api/spawn-defaults")) {
        return new Response(JSON.stringify({ model: null, worktree: true }));
      }
      if (url.startsWith("/api/projects/web/spawn-defaults")) {
        return new Response(JSON.stringify({ model: null, worktree: false }));
      }
      if (url === "/api/spawn") {
        spawnInit = init;
        return new Response(
          JSON.stringify({
            id: "web-a1",
            project: "web",
            agent: "claude",
            model: "sonnet",
            prompt: "Do the thing",
            branch: "web-a1",
            worktree: false,
            tmuxSession: "web-a1",
            status: "spawning",
            state: "working",
            createdAt: "2026-04-02T10:00:00.000Z",
            updatedAt: "2026-04-02T10:00:00.000Z",
            lastActivityAt: "2026-04-02T10:00:00.000Z",
            runtimeAlive: true,
            workspaceExists: true,
            worktreePath: "/repo/web",
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

    fireEvent.click(screen.getAllByRole("button", { name: "Spawn Session" })[0]);
    const dialog = screen.getByRole("dialog");
    fireEvent.change(within(dialog).getByLabelText("Prompt..."), {
      target: { value: "Do the thing" },
    });

    expect(within(dialog).getByRole("combobox", { name: "Spawn project" })).toHaveValue("web");

    const workspaceModeSelect = within(dialog).getByRole("combobox", { name: "workspace mode" });
    await waitFor(() => {
      expect(workspaceModeSelect).toHaveValue("shared");
    });

    const submitButton = () => {
      const button = dialog.querySelector('button[class*="min-w-32"]');
      if (!(button instanceof HTMLButtonElement)) {
        throw new Error("spawn submit button not found");
      }
      return button;
    };
    await waitFor(() => {
      expect(submitButton()).not.toBeDisabled();
    });
    fireEvent.click(submitButton());

    await waitFor(() => {
      expect(spawnInit).toBeDefined();
    });
    const body = JSON.parse(spawnInit?.body as string) as { overrides?: { worktree: boolean } };
    expect(body.overrides).toEqual({ worktree: false });
  });

  it("keeps the user's explicitly confirmed workspace mode across a close and reopen of the same project", async () => {
    // The whole point of persisting workspaceModeAuto is to distinguish a
    // real user confirmation from an auto-derived value: an explicit pick
    // must survive a close/reopen even when it disagrees with the
    // project's own resolved default, whereas the tests above prove an
    // auto-derived value never survives a project change.
    vi.spyOn(global, "fetch").mockImplementation(async (input) => {
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
            ],
            sessions: [],
          }),
          { status: 200 },
        );
      }
      if (url.startsWith("/api/models")) {
        return new Response(JSON.stringify({ models: [{ id: "sonnet", label: "Sonnet" }] }));
      }
      if (url.startsWith("/api/projects/api/spawn-defaults")) {
        return new Response(JSON.stringify({ model: null, worktree: true }));
      }
      throw new Error(`Unexpected fetch: ${url}`);
    });

    render(<Dashboard />);

    await waitFor(() => {
      expect(projectFilterButton()).toBeInTheDocument();
    });

    fireEvent.click(screen.getAllByRole("button", { name: "Spawn Session" })[0]);
    let dialog = screen.getByRole("dialog");
    const workspaceModeSelect = () =>
      within(dialog).getByRole("combobox", { name: "workspace mode" });
    await waitFor(() => {
      expect(workspaceModeSelect()).toHaveValue("worktree");
    });

    // The user explicitly overrides the project's real ("worktree") default.
    fireEvent.change(workspaceModeSelect(), { target: { value: "shared" } });
    expect(workspaceModeSelect()).toHaveValue("shared");

    fireEvent.click(within(dialog).getByRole("button", { name: "Close" }));
    fireEvent.click(screen.getAllByRole("button", { name: "Spawn Session" })[0]);
    dialog = screen.getByRole("dialog");

    // The explicit choice survives — it is not overwritten back to the
    // project's auto-derived "worktree" default once spawn-defaults settles.
    expect(workspaceModeSelect()).toHaveValue("shared");
    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Spawn model" })).toHaveTextContent("Sonnet");
    });
    expect(workspaceModeSelect()).toHaveValue("shared");
  });
});
