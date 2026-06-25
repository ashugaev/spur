import {
  act,
  fireEvent,
  render as rtlRender,
  screen,
  waitFor,
  within,
  type RenderOptions,
} from "@testing-library/react";
import { renderToString } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { type ReactElement, type ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { Dashboard } from "@/components/Dashboard";
import { StatusBar } from "@/components/StatusBar";
import manifest from "@/app/manifest";
import { metadata } from "@/app/layout";
import { generateMetadata as generateSessionMetadata } from "@/app/sessions/[id]/page";
import { spurRequestJson } from "@/lib/spur-daemon";

vi.mock("@/lib/spur-daemon", () => ({
  spurRequestJson: vi.fn(),
}));

const mockedSpurRequestJson = vi.mocked(spurRequestJson);

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
  DirectTerminal: ({
    onClose,
    sessionId,
    title,
  }: {
    onClose?: () => void;
    sessionId: string;
    title?: string;
  }) => (
    <div>
      <div>{`Direct terminal ${sessionId}`}</div>
      {title ? <div>{`Direct terminal title ${title}`}</div> : null}
      <button onClick={onClose} type="button">
        Close terminal
      </button>
    </div>
  ),
}));

class MockMediaRecorder {
  mimeType = "audio/webm";
  state = "inactive";
  private listeners = new Map<string, Array<(event?: unknown) => void>>();

  addEventListener(type: string, listener: (event?: unknown) => void) {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
  }

  start() {
    this.state = "recording";
  }

  stop() {
    this.state = "inactive";
    this.emit(
      "dataavailable",
      new Blob(["voice-audio"], {
        type: this.mimeType,
      }),
    );
    this.emit("stop");
  }

  private emit(type: string, data?: Blob) {
    for (const listener of this.listeners.get(type) ?? []) {
      listener(data ? { data } : undefined);
    }
  }
}

function sessionsPayload() {
  return {
    projects: [{ id: "api", name: "API", configured: true, prefix: "api", path: "/repo/api" }],
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

const SPAWN_PROMPT_PLACEHOLDER = "Prompt for the new session...";
const SPAWN_PROMPT_VOICE_PLACEHOLDER = "Prompt for the new session... Voice ⌘ + .";
const MOBILE_COLLAPSED_CATEGORIES_STORAGE_KEY = "spur:mobile-collapsed-categories";

function setMobileViewport(matches: boolean) {
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    writable: true,
    value: (query: string): MediaQueryList => ({
      matches,
      media: query,
      onchange: null,
      addListener: () => undefined,
      removeListener: () => undefined,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
      dispatchEvent: () => false,
    }),
  });
}

function getAttentionZoneToggle(label: string): HTMLElement {
  const banner = screen.getByRole("banner");
  const toggle = screen
    .getAllByRole("button", { name: new RegExp(label, "i") })
    .find((candidate) => !banner.contains(candidate));
  if (!toggle) {
    throw new Error(`Missing attention zone toggle for ${label}`);
  }
  return toggle;
}

describe("Dashboard", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    mockedSpurRequestJson.mockReset();
    window.localStorage.clear();
    window.history.replaceState(null, "", "/");
    setMobileViewport(false);
    vi.stubGlobal("MediaRecorder", MockMediaRecorder as unknown as typeof MediaRecorder);
    Object.defineProperty(navigator, "mediaDevices", {
      configurable: true,
      value: {
        getUserMedia: vi.fn().mockResolvedValue({
          getTracks: () => [{ stop: vi.fn() }],
        }),
      },
    });
  });

  it("renders Spur dashboard sessions from API", async () => {
    vi.spyOn(global, "fetch").mockImplementation(async (input) => {
      const url = typeof input === "string" ? input : input.url;
      if (url === "/api/runtime/resources")
        return new Response(JSON.stringify({ available: false }));
      if (url === "/api/runtime/voice")
        return new Response(JSON.stringify({ available: false, language: "" }));
      return new Response(JSON.stringify(sessionsPayload()));
    });

    render(<Dashboard />);

    await waitFor(() => {
      expect(screen.getByLabelText("Project filter")).toBeInTheDocument();
      expect(screen.getByRole("link", { name: "Fix auth" })).toBeInTheDocument();
      expect(
        screen.getByRole("button", { name: "Open web terminal for api-a1" }),
      ).toBeInTheDocument();
    });
  });

  it("renders backlog above sessions and takes an item through the web proxy", async () => {
    const backlogItem = {
      provider: "jira",
      projectId: "api",
      sourceId: "jira-backlog",
      externalId: "10001",
      key: "WEB-17",
      title: "Fix checkout",
      url: "https://jira.example.com/browse/WEB-17",
      fetchedAt: "2026-06-16T12:00:00.000Z",
    };
    const spawnedSession = {
      ...sessionsPayload().sessions[0],
      id: "api-backlog-1",
      prompt: "Work on Jira WEB-17: Fix checkout",
      slots: {
        links: [{ label: "tracker", url: "https://jira.example.com/browse/WEB-17" }],
      },
    };
    const fetchMock = vi.spyOn(global, "fetch").mockImplementation(async (input, init) => {
      const url = typeof input === "string" ? input : input.url;
      if (url === "/api/runtime/resources")
        return new Response(JSON.stringify({ available: false }));
      if (url === "/api/runtime/voice")
        return new Response(JSON.stringify({ available: false, language: "" }));
      if (url === "/api/backlog/take") {
        expect(init?.method).toBe("POST");
        return new Response(JSON.stringify({ item: backlogItem, session: spawnedSession }), {
          status: 201,
        });
      }
      return new Response(JSON.stringify({ ...sessionsPayload(), backlog: [backlogItem] }));
    });

    render(<Dashboard />);

    await waitFor(() => {
      expect(screen.getByRole("heading", { name: "Backlog" })).toBeInTheDocument();
      expect(screen.getByRole("link", { name: /WEB-17/ })).toBeInTheDocument();
    });
    const backlogLink = screen.getByRole("link", { name: /WEB-17/ });
    expect(backlogLink).toHaveAttribute("href", "https://jira.example.com/browse/WEB-17");
    expect(backlogLink).toHaveAttribute("target", "_blank");

    fireEvent.click(screen.getByRole("button", { name: "Take" }));

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        "/api/backlog/take",
        expect.objectContaining({
          method: "POST",
          body: JSON.stringify({
            projectId: "api",
            sourceId: "jira-backlog",
            externalId: "10001",
          }),
        }),
      );
    });
  });

  it("disables every backlog take button while one take is pending", async () => {
    const backlogItems = [
      {
        provider: "jira",
        projectId: "api",
        sourceId: "jira-backlog",
        externalId: "10001",
        key: "WEB-17",
        title: "Fix checkout",
        url: "https://jira.example.com/browse/WEB-17",
        fetchedAt: "2026-06-16T12:00:00.000Z",
      },
      {
        provider: "jira",
        projectId: "api",
        sourceId: "jira-backlog",
        externalId: "10002",
        key: "WEB-18",
        title: "Fix cart",
        url: "https://jira.example.com/browse/WEB-18",
        fetchedAt: "2026-06-16T12:00:00.000Z",
      },
    ];
    let resolveTake: ((response: Response) => void) | null = null;
    vi.spyOn(global, "fetch").mockImplementation(async (input) => {
      const url = typeof input === "string" ? input : input.url;
      if (url === "/api/runtime/resources")
        return new Response(JSON.stringify({ available: false }));
      if (url === "/api/runtime/voice")
        return new Response(JSON.stringify({ available: false, language: "" }));
      if (url === "/api/backlog/take") {
        return new Promise<Response>((resolve) => {
          resolveTake = resolve;
        });
      }
      return new Response(JSON.stringify({ ...sessionsPayload(), backlog: backlogItems }));
    });

    render(<Dashboard />);

    await waitFor(() => {
      expect(screen.getByRole("link", { name: /WEB-17/ })).toBeInTheDocument();
      expect(screen.getByRole("link", { name: /WEB-18/ })).toBeInTheDocument();
    });

    fireEvent.click(screen.getAllByRole("button", { name: "Take" })[0]);

    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Taking..." })).toBeDisabled();
      expect(screen.getByRole("button", { name: "Take" })).toBeDisabled();
    });

    resolveTake?.(
      new Response(
        JSON.stringify({ item: backlogItems[0], session: sessionsPayload().sessions[0] }),
        {
          status: 201,
        },
      ),
    );
  });

  it("renders compact cards with a direct terminal action and keeps it in query params", async () => {
    vi.spyOn(global, "fetch").mockImplementation(async (input) => {
      const url = typeof input === "string" ? input : input.url;

      if (url === "/api/runtime/resources")
        return new Response(JSON.stringify({ available: false }));
      if (url === "/api/runtime/voice")
        return new Response(JSON.stringify({ available: false, language: "" }));
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
      "/sessions/api-a1",
    );

    fireEvent.click(screen.getByRole("button", { name: "Open web terminal for api-a1" }));

    await waitFor(() => {
      expect(screen.getByRole("dialog", { name: "Terminal api-a1" })).toBeInTheDocument();
      expect(screen.getByText("Direct terminal api-a1")).toBeInTheDocument();
      expect(screen.getByText("Direct terminal title Fix auth")).toBeInTheDocument();
    });

    expect(window.location.search).toContain("terminal=api-a1");

    fireEvent.click(screen.getByRole("button", { name: "Close terminal" }));

    await waitFor(() => {
      expect(screen.queryByRole("dialog", { name: "Terminal api-a1" })).not.toBeInTheDocument();
    });
    expect(window.location.search).not.toContain("terminal=");

    act(() => {
      window.history.back();
      window.dispatchEvent(new PopStateEvent("popstate"));
    });

    await waitFor(() => {
      expect(screen.getByRole("dialog", { name: "Terminal api-a1" })).toBeInTheDocument();
    });

    act(() => {
      window.history.forward();
      window.dispatchEvent(new PopStateEvent("popstate"));
    });

    await waitFor(() => {
      expect(screen.queryByRole("dialog", { name: "Terminal api-a1" })).not.toBeInTheDocument();
    });
  });

  it("uses session title in the terminal header when available", async () => {
    vi.spyOn(global, "fetch").mockImplementation(async (input) => {
      const url = typeof input === "string" ? input : input.url;
      if (url === "/api/runtime/resources") {
        return new Response(JSON.stringify({ available: false }));
      }
      if (url === "/api/runtime/voice") {
        return new Response(JSON.stringify({ available: false, modelPath: "", language: "" }));
      }
      if (url === "/api/sessions") {
        return new Response(
          JSON.stringify({
            projects: [
              { id: "api", name: "API", configured: true, prefix: "api", path: "/repo/api" },
            ],
            sessions: [
              {
                ...sessionsPayload().sessions[0],
                slots: { title: "Fix auth header", links: [] },
              },
            ],
          }),
          { status: 200 },
        );
      }
      throw new Error(`Unexpected fetch: ${url}`);
    });

    render(<Dashboard />);

    await waitFor(() => {
      expect(
        screen.getByRole("button", { name: "Open web terminal for api-a1" }),
      ).toBeInTheDocument();
    });

    fireEvent.click(screen.getByRole("button", { name: "Open web terminal for api-a1" }));

    await waitFor(() => {
      expect(screen.getByText("Direct terminal title Fix auth header")).toBeInTheDocument();
    });
  });

  it("loads the initial project filter from query params before the first fetch", async () => {
    window.history.replaceState(null, "", "/?project=api");
    const fetchMock = vi.spyOn(global, "fetch").mockImplementation(async (input) => {
      const url = typeof input === "string" ? input : input.url;
      if (url === "/api/runtime/resources")
        return new Response(JSON.stringify({ available: false }));
      if (url === "/api/runtime/voice") {
        return new Response(JSON.stringify({ available: false, modelPath: "", language: "" }));
      }
      if (url === "/api/sessions") {
        return new Response(JSON.stringify(sessionsPayload()), { status: 200 });
      }
      throw new Error(`Unexpected fetch: ${url}`);
    });

    render(<Dashboard />);

    await waitFor(() => {
      expect(screen.getByRole("combobox", { name: "Project filter" })).toHaveValue("api");
    });

    expect(screen.getByTestId("project-filter-chevron")).toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledWith("/api/sessions", expect.any(Object));
  });

  it("preserves the explicit project filter in session links", async () => {
    window.history.replaceState(null, "", "/?project=api");
    vi.spyOn(global, "fetch").mockImplementation(async (input) => {
      const url = typeof input === "string" ? input : input.url;
      if (url === "/api/runtime/resources")
        return new Response(JSON.stringify({ available: false }));
      if (url === "/api/runtime/voice") {
        return new Response(JSON.stringify({ available: false, modelPath: "", language: "" }));
      }
      if (url === "/api/sessions") {
        return new Response(JSON.stringify(sessionsPayload()), { status: 200 });
      }
      throw new Error(`Unexpected fetch: ${url}`);
    });

    render(<Dashboard />);

    const sessionLink = await screen.findByRole("link", { name: "Fix auth" });
    expect(sessionLink).toHaveAttribute("href", "/sessions/api-a1?project=api");
  });

  it("switches project filters without refetching sessions", async () => {
    const fetchMock = vi.spyOn(global, "fetch").mockImplementation(async (input) => {
      const url = typeof input === "string" ? input : input.url;
      if (url === "/api/runtime/resources")
        return new Response(JSON.stringify({ available: false }));
      if (url === "/api/runtime/voice")
        return new Response(JSON.stringify({ available: false, modelPath: "", language: "" }));
      if (url === "/api/sessions") {
        return new Response(
          JSON.stringify({
            projects: [
              { id: "api", name: "API", configured: true, prefix: "api", path: "/repo/api" },
              { id: "web", name: "Web", configured: true, prefix: "web", path: "/repo/web" },
            ],
            sessions: [
              sessionsPayload().sessions[0],
              {
                ...sessionsPayload().sessions[0],
                id: "web-a1",
                project: "web",
                prompt: "Ship web",
                tmuxSession: "web-a1",
                worktreePath: "/tmp/web-a1",
              },
            ],
          }),
          { status: 200 },
        );
      }
      throw new Error(`Unexpected fetch: ${url}`);
    });

    render(<Dashboard />);

    await waitFor(() => {
      expect(screen.getByRole("link", { name: "Fix auth" })).toBeInTheDocument();
    });

    fireEvent.change(screen.getByRole("combobox", { name: "Project filter" }), {
      target: { value: "web" },
    });

    await waitFor(() => {
      expect(screen.getByRole("link", { name: "Ship web" })).toBeInTheDocument();
    });

    const sessionFetchCalls = fetchMock.mock.calls.filter(
      ([input]) => (typeof input === "string" ? input : input.url) === "/api/sessions",
    );
    expect(sessionFetchCalls).toHaveLength(1);
  });

  it("collapses the Stopped category by default on mobile until expanded", async () => {
    setMobileViewport(true);
    vi.spyOn(global, "fetch").mockImplementation(async (input) => {
      const url = typeof input === "string" ? input : input.url;
      if (url === "/api/runtime/resources")
        return new Response(JSON.stringify({ available: false }));
      if (url === "/api/runtime/voice") {
        return new Response(JSON.stringify({ available: false, modelPath: "", language: "" }));
      }
      if (url === "/api/sessions") {
        return new Response(
          JSON.stringify({
            projects: [
              { id: "api", name: "API", configured: true, prefix: "api", path: "/repo/api" },
            ],
            sessions: [
              {
                ...sessionsPayload().sessions[0],
                id: "api-mobile-stopped-1",
                prompt: "Collapsed mobile stop",
                status: "stopped",
                state: "stopped",
                runtimeAlive: false,
                tmuxSession: null,
              },
            ],
          }),
          { status: 200 },
        );
      }
      throw new Error(`Unexpected fetch: ${url}`);
    });

    render(<Dashboard />);

    await waitFor(() => {
      const header = screen.getByRole("banner");
      expect(within(header).getByRole("button", { name: /Stopped/i })).toHaveTextContent("1");
      expect(screen.queryByRole("link", { name: "Collapsed mobile stop" })).not.toBeInTheDocument();
    });

    fireEvent.click(getAttentionZoneToggle("Stopped"));

    await waitFor(() => {
      expect(screen.getByRole("link", { name: "Collapsed mobile stop" })).toBeInTheDocument();
    });
  });

  it("keeps saved mobile collapse overrides when Stopped was explicitly expanded", async () => {
    setMobileViewport(true);
    window.localStorage.setItem(MOBILE_COLLAPSED_CATEGORIES_STORAGE_KEY, JSON.stringify([]));
    vi.spyOn(global, "fetch").mockImplementation(async (input) => {
      const url = typeof input === "string" ? input : input.url;
      if (url === "/api/runtime/resources")
        return new Response(JSON.stringify({ available: false }));
      if (url === "/api/runtime/voice") {
        return new Response(JSON.stringify({ available: false, modelPath: "", language: "" }));
      }
      if (url === "/api/sessions") {
        return new Response(
          JSON.stringify({
            projects: [
              { id: "api", name: "API", configured: true, prefix: "api", path: "/repo/api" },
            ],
            sessions: [
              {
                ...sessionsPayload().sessions[0],
                id: "api-mobile-stopped-2",
                prompt: "Saved expanded stop",
                status: "stopped",
                state: "stopped",
                runtimeAlive: false,
                tmuxSession: null,
              },
            ],
          }),
          { status: 200 },
        );
      }
      throw new Error(`Unexpected fetch: ${url}`);
    });

    render(<Dashboard />);

    await waitFor(() => {
      expect(screen.getByRole("link", { name: "Saved expanded stop" })).toBeInTheDocument();
    });
  });

  it("resets search and project filters from the empty state action", async () => {
    window.history.replaceState(null, "", "/?project=api");
    vi.spyOn(global, "fetch").mockImplementation(async (input) => {
      const url = typeof input === "string" ? input : input.url;
      if (url === "/api/runtime/resources")
        return new Response(JSON.stringify({ available: false }));
      if (url === "/api/runtime/voice") {
        return new Response(JSON.stringify({ available: false, modelPath: "", language: "" }));
      }
      if (url === "/api/sessions") {
        return new Response(
          JSON.stringify({
            projects: [
              { id: "api", name: "API", configured: true, prefix: "api", path: "/repo/api" },
            ],
            sessions: [
              {
                ...sessionsPayload().sessions[0],
                id: "web-a1",
                project: "web",
                prompt: "Ship web",
                tmuxSession: "web-a1",
                worktreePath: "/tmp/web-a1",
              },
            ],
          }),
        );
      }
      throw new Error(`Unexpected fetch: ${url}`);
    });

    render(<Dashboard />);

    await waitFor(() => {
      expect(
        screen.getByText("No sessions match the current filters in API.", { exact: false }),
      ).toBeInTheDocument();
    });

    const searchInput = screen.getByPlaceholderText("Filter sessions...");
    fireEvent.change(searchInput, { target: { value: "zzz" } });
    expect(searchInput).toHaveValue("zzz");

    fireEvent.click(screen.getByRole("button", { name: "Reset Filters" }));

    await waitFor(() => {
      expect(screen.getByRole("link", { name: "Ship web" })).toBeInTheDocument();
    });

    expect(searchInput).toHaveValue("");
    expect(window.location.search).toBe("");
  });

  it("does not open terminal from query params when session is not attachable", async () => {
    window.history.replaceState(null, "", "/?terminal=api-a1");
    vi.spyOn(global, "fetch").mockImplementation(async (input) => {
      const url = typeof input === "string" ? input : input.url;
      if (url === "/api/runtime/resources")
        return new Response(JSON.stringify({ available: false }));
      if (url === "/api/runtime/voice") {
        return new Response(JSON.stringify({ available: false, modelPath: "", language: "" }));
      }
      if (url === "/api/sessions") {
        return new Response(
          JSON.stringify({
            ...sessionsPayload(),
            sessions: [{ ...sessionsPayload().sessions[0], tmuxSession: null }],
          }),
          { status: 200 },
        );
      }
      throw new Error(`Unexpected fetch: ${url}`);
    });

    render(<Dashboard />);
    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Open web terminal for api-a1" })).toBeDisabled();
    });
    expect(screen.queryByRole("dialog", { name: "Terminal api-a1" })).not.toBeInTheDocument();
    await waitFor(() => {
      expect(window.location.search).not.toContain("terminal=");
    });
  });

  it("shows only daemon-configured projects in filter and spawn dropdowns", async () => {
    const sessionsData = {
      projects: [{ id: "sp", name: "Spur Core", configured: true, prefix: "sp", path: "/repo/sp" }],
      sessions: [
        {
          ...sessionsPayload().sessions[0],
          id: "spur-local-1",
          project: "spur-local",
          tmuxSession: "spur-local-1",
        },
      ],
    };
    vi.spyOn(global, "fetch").mockImplementation(async (input) => {
      const url = typeof input === "string" ? input : input.url;
      if (url === "/api/runtime/resources")
        return new Response(JSON.stringify({ available: false }));
      if (url === "/api/runtime/voice")
        return new Response(JSON.stringify({ available: false, language: "" }));
      return new Response(JSON.stringify(sessionsData));
    });

    render(<Dashboard />);

    await waitFor(() => {
      expect(
        screen.getByRole("button", { name: "Open web terminal for spur-local-1" }),
      ).toBeInTheDocument();
    });

    const filterSelect = screen.getByRole("combobox", { name: "Project filter" });
    expect(within(filterSelect).queryByRole("option", { name: "spur-local" })).toBeNull();
    expect(within(filterSelect).getByRole("option", { name: "Spur Core" })).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Spawn Session" }));
    const spawnProjectSelect = screen.getByRole("combobox", { name: "Spawn project" });
    expect(within(spawnProjectSelect).queryByRole("option", { name: "spur-local" })).toBeNull();
    expect(
      within(spawnProjectSelect).getByRole("option", { name: "Spur Core" }),
    ).toBeInTheDocument();
  });

  it("marks the built-in Shepherd project in project selectors", async () => {
    const sessionsData = {
      projects: [
        { id: "api", name: "API", configured: true, prefix: "api", path: "/repo/api" },
        {
          id: "spur-shepherd",
          name: "Shepherd",
          configured: true,
          prefix: "shp",
          path: "/tmp/spur-data/shepherd",
          kind: "shepherd",
        },
      ],
      sessions: sessionsPayload().sessions,
    };
    vi.spyOn(global, "fetch").mockImplementation(async (input) => {
      const url = typeof input === "string" ? input : input.url;
      if (url === "/api/runtime/resources")
        return new Response(JSON.stringify({ available: false }));
      if (url === "/api/runtime/voice")
        return new Response(JSON.stringify({ available: false, language: "" }));
      return new Response(JSON.stringify(sessionsData));
    });

    render(<Dashboard />);

    const filterSelect = screen.getByRole("combobox", { name: "Project filter" });
    await waitFor(() => {
      expect(
        within(filterSelect).getByRole("option", { name: "Shepherd (Built In)" }),
      ).toBeInTheDocument();
    });

    fireEvent.click(screen.getByRole("button", { name: "Spawn Session" }));
    expect(
      within(screen.getByRole("combobox", { name: "Spawn project" })).getByRole("option", {
        name: "Shepherd (Built In)",
      }),
    ).toBeInTheDocument();
  });

  it("opens the spawn modal with Shepherd selected from the split spawn control", async () => {
    const fetchMock = vi.spyOn(global, "fetch").mockImplementation(async (input) => {
      const url = typeof input === "string" ? input : input.url;
      if (url === "/api/runtime/resources")
        return new Response(JSON.stringify({ available: false }));
      if (url === "/api/runtime/voice")
        return new Response(JSON.stringify({ available: false, language: "" }));
      if (url === "/api/sessions") {
        return new Response(
          JSON.stringify({
            projects: [
              { id: "api", name: "API", configured: true, prefix: "api", path: "/repo/api" },
              {
                id: "spur-shepherd",
                name: "Shepherd",
                configured: true,
                prefix: "shp",
                path: "/tmp/spur-data/shepherd",
                kind: "shepherd",
              },
            ],
            sessions: [],
          }),
          { status: 200 },
        );
      }
      throw new Error(`Unexpected fetch: ${url}`);
    });

    render(<Dashboard />);

    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Spawn Shepherd" })).toBeInTheDocument();
    });

    fireEvent.click(screen.getByRole("button", { name: "Spawn Shepherd" }));

    const spawnProjectSelect = await screen.findByRole("combobox", { name: "Spawn project" });
    expect(spawnProjectSelect).toHaveValue("spur-shepherd");
    expect(screen.getByRole("combobox", { name: "Spawn agent" })).toHaveValue("claude");
    expect(fetchMock).not.toHaveBeenCalledWith("/api/shepherd/spawn", expect.anything());
  });

  it("lists cursor in spawn agent options and sends it on spawn", async () => {
    const fetchMock = vi.spyOn(global, "fetch").mockImplementation(async (input, init) => {
      const url = typeof input === "string" ? input : input.url;
      if (url === "/api/runtime/resources")
        return new Response(JSON.stringify({ available: false }));
      if (url === "/api/runtime/voice") {
        return new Response(JSON.stringify({ available: false, modelPath: "", language: "" }));
      }
      if (url === "/api/sessions") {
        return new Response(JSON.stringify(sessionsPayload()), { status: 200 });
      }
      if (url === "/api/spawn") {
        expect(init?.method).toBe("POST");
        expect(init?.body).toBe(JSON.stringify({ projectId: "api", prompt: "", agent: "cursor" }));
        return new Response(
          JSON.stringify({ ...sessionsPayload().sessions[0], id: "api-cursor-1", agent: "cursor" }),
          { status: 201 },
        );
      }
      throw new Error(`Unexpected fetch: ${url}`);
    });

    render(<Dashboard />);

    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Spawn Session" })).toBeInTheDocument();
    });

    fireEvent.click(screen.getByRole("button", { name: "Spawn Session" }));

    const agentSelect = screen.getByRole("combobox", { name: "Spawn agent" });
    expect(within(agentSelect).getByRole("option", { name: "cursor" })).toBeInTheDocument();
    fireEvent.change(agentSelect, { target: { value: "cursor" } });
    fireEvent.change(screen.getByRole("combobox", { name: "Spawn project" }), {
      target: { value: "api" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Spawn" }));

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        "/api/spawn",
        expect.objectContaining({
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ projectId: "api", prompt: "", agent: "cursor" }),
        }),
      );
    });
  });

  it("allows spawning from the dashboard without a prompt", async () => {
    const fetchMock = vi.spyOn(global, "fetch").mockImplementation(async (input, init) => {
      const url = typeof input === "string" ? input : input.url;
      if (url === "/api/runtime/resources")
        return new Response(JSON.stringify({ available: false }));
      if (url === "/api/runtime/voice") {
        return new Response(JSON.stringify({ available: false, modelPath: "", language: "" }));
      }
      if (url === "/api/sessions") {
        return new Response(JSON.stringify(sessionsPayload()), { status: 200 });
      }
      if (url === "/api/spawn") {
        expect(init?.method).toBe("POST");
        expect(init?.body).toBe(JSON.stringify({ projectId: "api", prompt: "", agent: "claude" }));
        return new Response(JSON.stringify(sessionsPayload().sessions[0]), { status: 201 });
      }
      throw new Error(`Unexpected fetch: ${url}`);
    });

    render(<Dashboard />);

    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Spawn Session" })).toBeInTheDocument();
    });

    fireEvent.click(screen.getByRole("button", { name: "Spawn Session" }));
    fireEvent.change(screen.getByRole("combobox", { name: "Spawn project" }), {
      target: { value: "api" },
    });

    const spawnButton = screen.getByRole("button", { name: "Spawn" });
    expect(spawnButton).toBeEnabled();
    expect(screen.getByPlaceholderText(SPAWN_PROMPT_PLACEHOLDER)).toBeInTheDocument();
    expect(screen.getByText("⌘ + ⏎")).toBeInTheDocument();
    expect(screen.queryByText("⌘/Ctrl+Enter")).not.toBeInTheDocument();

    fireEvent.click(spawnButton);

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        "/api/spawn",
        expect.objectContaining({
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ projectId: "api", prompt: "", agent: "claude" }),
        }),
      );
    });
  });

  it("sends self-destruct settings from the spawn modal and resets them after success", async () => {
    const fetchMock = vi.spyOn(global, "fetch").mockImplementation(async (input) => {
      const url = typeof input === "string" ? input : input.url;
      if (url === "/api/runtime/resources")
        return new Response(JSON.stringify({ available: false }));
      if (url === "/api/runtime/voice") {
        return new Response(JSON.stringify({ available: false, modelPath: "", language: "" }));
      }
      if (url === "/api/sessions") {
        return new Response(JSON.stringify(sessionsPayload()), { status: 200 });
      }
      if (url === "/api/spawn") {
        return new Response(JSON.stringify(sessionsPayload().sessions[0]), { status: 201 });
      }
      throw new Error(`Unexpected fetch: ${url}`);
    });

    render(<Dashboard />);

    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Spawn Session" })).toBeInTheDocument();
    });

    fireEvent.click(screen.getByRole("button", { name: "Spawn Session" }));
    fireEvent.change(screen.getByRole("combobox", { name: "Spawn project" }), {
      target: { value: "api" },
    });
    fireEvent.change(screen.getByPlaceholderText(SPAWN_PROMPT_PLACEHOLDER), {
      target: { value: "Ship it" },
    });
    fireEvent.click(screen.getByRole("checkbox", { name: "Self-destruct" }));
    fireEvent.change(screen.getByLabelText("Self-destruct conditions"), {
      target: { value: "  tests pass  " },
    });
    fireEvent.click(screen.getByRole("button", { name: "Spawn" }));

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        "/api/spawn",
        expect.objectContaining({
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            projectId: "api",
            prompt: "Ship it",
            agent: "claude",
            selfDestruct: {
              enabled: true,
              conditions: "tests pass",
            },
          }),
        }),
      );
    });

    fireEvent.click(screen.getByRole("button", { name: "Spawn Session" }));
    expect(screen.getByRole("checkbox", { name: "Self-destruct" })).not.toBeChecked();
    expect(screen.queryByLabelText("Self-destruct conditions")).not.toBeInTheDocument();
  });

  it("adds image attachments in the spawn prompt and includes them in the spawn payload", async () => {
    const fetchMock = vi.spyOn(global, "fetch").mockImplementation(async (input, init) => {
      const url = typeof input === "string" ? input : input.url;
      if (url === "/api/runtime/resources")
        return new Response(JSON.stringify({ available: false }));
      if (url === "/api/runtime/voice") {
        return new Response(JSON.stringify({ available: false, modelPath: "", language: "" }));
      }
      if (url === "/api/sessions") {
        return new Response(JSON.stringify(sessionsPayload()), { status: 200 });
      }
      if (url === "/api/spawn") {
        expect(init?.method).toBe("POST");
        const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
        expect(body).toMatchObject({
          projectId: "api",
          prompt: "Ship image flow",
          agent: "claude",
        });
        expect(body.attachments).toEqual([{ name: "spawn.png", data: expect.any(String) }]);
        return new Response(JSON.stringify(sessionsPayload().sessions[0]), { status: 201 });
      }
      throw new Error(`Unexpected fetch: ${url}`);
    });

    render(<Dashboard />);

    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Spawn Session" })).toBeInTheDocument();
    });

    fireEvent.click(screen.getByRole("button", { name: "Spawn Session" }));
    fireEvent.change(screen.getByRole("combobox", { name: "Spawn project" }), {
      target: { value: "api" },
    });
    const prompt = screen.getByPlaceholderText(SPAWN_PROMPT_PLACEHOLDER);
    fireEvent.change(prompt, { target: { value: "Ship image flow" } });
    fireEvent.paste(prompt, {
      clipboardData: {
        files: [new File(["png"], "spawn.png", { type: "image/png" })],
      },
    });

    await waitFor(() => {
      expect(screen.getByAltText("spawn.png")).toBeInTheDocument();
    });

    fireEvent.click(screen.getByRole("button", { name: "Spawn" }));

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        "/api/spawn",
        expect.objectContaining({
          method: "POST",
          headers: { "content-type": "application/json" },
        }),
      );
    });
  });

  it("shows an attach-file picker inside the spawn prompt and accepts files from it", async () => {
    vi.spyOn(global, "fetch").mockImplementation(async (input) => {
      const url = typeof input === "string" ? input : input.url;
      if (url === "/api/runtime/resources")
        return new Response(JSON.stringify({ available: false }));
      if (url === "/api/runtime/voice") {
        return new Response(JSON.stringify({ available: false, modelPath: "", language: "" }));
      }
      if (url === "/api/sessions") {
        return new Response(JSON.stringify(sessionsPayload()), { status: 200 });
      }
      throw new Error(`Unexpected fetch: ${url}`);
    });

    const { container } = render(<Dashboard />);

    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Spawn Session" })).toBeInTheDocument();
    });

    fireEvent.click(screen.getByRole("button", { name: "Spawn Session" }));
    expect(screen.getByRole("button", { name: "Attach file" })).toBeInTheDocument();

    const fileInput = container.querySelector('input[type="file"]');
    expect(fileInput).not.toBeNull();
    fireEvent.change(fileInput as HTMLInputElement, {
      target: { files: [new File(["png"], "picker.png", { type: "image/png" })] },
    });

    await waitFor(() => {
      expect(screen.getByAltText("picker.png")).toBeInTheDocument();
    });
  });

  it("restores a saved spawn prompt from history with its timestamp", async () => {
    window.localStorage.setItem(
      "spur:input-history:spawn-prompt",
      JSON.stringify([
        {
          value: "Re-run the flaky deploy",
          savedAt: "2026-04-17T12:34:56.000Z",
        },
      ]),
    );

    vi.spyOn(global, "fetch").mockImplementation(async (input) => {
      const url = typeof input === "string" ? input : input.url;
      if (url === "/api/runtime/resources")
        return new Response(JSON.stringify({ available: false }));
      if (url === "/api/runtime/voice")
        return new Response(JSON.stringify({ available: false, modelPath: "", language: "" }));
      if (url === "/api/sessions")
        return new Response(JSON.stringify(sessionsPayload()), { status: 200 });
      throw new Error(`Unexpected fetch: ${url}`);
    });

    render(<Dashboard />);

    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Spawn Session" })).toBeInTheDocument();
    });

    fireEvent.click(screen.getByRole("button", { name: "Spawn Session" }));
    expect(screen.queryByText(/^History$/)).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "History" }));

    expect(screen.getByText("2026-04-17 12:34 UTC")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /Re-run the flaky deploy/i }));

    expect(screen.getByDisplayValue("Re-run the flaky deploy")).toBeInTheDocument();
  });

  it("inserts a slash suggestion into the spawn prompt", async () => {
    vi.spyOn(global, "fetch").mockImplementation(async (input) => {
      const url = typeof input === "string" ? input : input.url;
      if (url === "/api/runtime/resources")
        return new Response(JSON.stringify({ available: false }));
      if (url === "/api/runtime/voice")
        return new Response(JSON.stringify({ available: false, modelPath: "", language: "" }));
      if (url === "/api/sessions")
        return new Response(JSON.stringify(sessionsPayload()), { status: 200 });
      if (url === "/api/projects/api/slash-commands?agent=claude") {
        return new Response(
          JSON.stringify({
            agent: "claude",
            commands: [
              {
                id: "cmd-compact",
                label: "/compact",
                insertText: "/compact",
                detail: "Compact the chat",
                source: "built-in",
                kind: "command",
              },
              {
                id: "cmd-review",
                label: "/review",
                insertText: "/review",
                detail: "Review the current diff",
                source: "project",
                kind: "command",
              },
            ],
            skills: [],
            agents: [],
          }),
          { status: 200 },
        );
      }
      throw new Error(`Unexpected fetch: ${url}`);
    });

    render(<Dashboard />);

    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Spawn Session" })).toBeInTheDocument();
    });

    fireEvent.click(screen.getByRole("button", { name: "Spawn Session" }));
    fireEvent.change(screen.getByRole("combobox", { name: "Spawn project" }), {
      target: { value: "api" },
    });
    const slashButton = screen.getByRole("button", { name: "Slash" });
    expect(slashButton).toHaveTextContent("/");
    fireEvent.click(slashButton);
    await waitFor(() => {
      expect(screen.getByRole("menuitem", { name: /\/compact/i })).toBeInTheDocument();
    });
    expect(screen.getAllByRole("menuitem").map((item) => item.textContent)).toEqual([
      "/compactCompact the chat",
      "/reviewReview the current diff",
    ]);
    expect(screen.queryByText("Favorites")).not.toBeInTheDocument();

    const reviewFavoriteButton = screen.getByRole("button", { name: "Add favorite /review" });
    expect(reviewFavoriteButton).toHaveClass("text-[var(--color-text-tertiary)]");
    fireEvent.click(reviewFavoriteButton);
    expect(screen.getByRole("button", { name: "Remove favorite /review" })).toHaveClass(
      "text-[var(--color-status-attention)]",
    );
    expect(screen.getByRole("button", { name: "Remove favorite /review" })).not.toHaveClass(
      "text-[var(--color-text-tertiary)]",
    );
    expect(screen.getAllByRole("menuitem").map((item) => item.textContent)).toEqual([
      "/reviewReview the current diff",
      "/compactCompact the chat",
    ]);
    expect(screen.getAllByText(/^(Favorites|Commands)$/).map((item) => item.textContent)).toEqual([
      "Favorites",
      "Commands",
    ]);
    expect(window.localStorage.getItem("spur:slash-suggestion-favorites")).toBe(
      JSON.stringify(["command:project:cmd-review"]),
    );

    fireEvent.click(screen.getByRole("menuitem", { name: /\/compact/i }));

    expect(screen.getByPlaceholderText(SPAWN_PROMPT_PLACEHOLDER)).toHaveValue("/compact");
  });

  it("clears the spawn prompt from the corner button", async () => {
    vi.spyOn(global, "fetch").mockImplementation(async (input) => {
      const url = typeof input === "string" ? input : input.url;
      if (url === "/api/runtime/resources")
        return new Response(JSON.stringify({ available: false }));
      if (url === "/api/runtime/voice")
        return new Response(JSON.stringify({ available: false, modelPath: "", language: "" }));
      if (url === "/api/sessions")
        return new Response(JSON.stringify(sessionsPayload()), { status: 200 });
      throw new Error(`Unexpected fetch: ${url}`);
    });

    render(<Dashboard />);

    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Spawn Session" })).toBeInTheDocument();
    });

    fireEvent.click(screen.getByRole("button", { name: "Spawn Session" }));
    fireEvent.change(screen.getByRole("combobox", { name: "Spawn project" }), {
      target: { value: "api" },
    });
    const prompt = screen.getByPlaceholderText(SPAWN_PROMPT_PLACEHOLDER);
    fireEvent.change(prompt, { target: { value: "Clear this prompt" } });
    fireEvent.click(screen.getByRole("button", { name: "Clear spawn prompt" }));

    expect(prompt).toHaveValue("");
    expect(prompt).toHaveFocus();
  });

  it.each([
    {
      label: "Cmd+Enter",
      prompt: "Ship hotkey",
      keydown: { key: "Enter", metaKey: true },
    },
  ])(
    "submits spawn when pressing $label in prompt textarea",
    async ({ keydown, prompt: value }) => {
      const fetchMock = vi.spyOn(global, "fetch").mockImplementation(async (input, init) => {
        const url = typeof input === "string" ? input : input.url;
        if (url === "/api/runtime/resources")
          return new Response(JSON.stringify({ available: false }));
        if (url === "/api/runtime/voice")
          return new Response(JSON.stringify({ available: false, modelPath: "", language: "" }));
        if (url === "/api/sessions")
          return new Response(JSON.stringify(sessionsPayload()), { status: 200 });
        if (url === "/api/spawn")
          return new Response(JSON.stringify(sessionsPayload().sessions[0]), { status: 201 });
        throw new Error(`Unexpected fetch: ${url} ${JSON.stringify(init)}`);
      });

      render(<Dashboard />);

      await waitFor(() => {
        expect(screen.getByRole("button", { name: "Spawn Session" })).toBeInTheDocument();
      });

      fireEvent.click(screen.getByRole("button", { name: "Spawn Session" }));
      fireEvent.change(screen.getByRole("combobox", { name: "Spawn project" }), {
        target: { value: "api" },
      });
      const prompt = screen.getByPlaceholderText(SPAWN_PROMPT_PLACEHOLDER);
      fireEvent.change(prompt, { target: { value } });
      fireEvent.keyDown(prompt, keydown);

      await waitFor(() => {
        expect(fetchMock).toHaveBeenCalledWith(
          "/api/spawn",
          expect.objectContaining({
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ projectId: "api", prompt: value, agent: "claude" }),
          }),
        );
        expect(screen.queryByPlaceholderText(SPAWN_PROMPT_PLACEHOLDER)).not.toBeInTheDocument();
      });
    },
  );

  it("toggles voice recording from the spawn prompt with Cmd+.", async () => {
    vi.spyOn(global, "fetch").mockImplementation(async (input, init) => {
      const url = typeof input === "string" ? input : input.url;
      if (url === "/api/runtime/resources")
        return new Response(JSON.stringify({ available: false }));
      if (url === "/api/runtime/voice") {
        return new Response(
          JSON.stringify({ available: true, modelPath: "/models/ggml-base.en.bin", language: "" }),
        );
      }
      if (url === "/api/runtime/voice/transcribe" && init?.method === "POST") {
        return new Response(JSON.stringify({ text: "Spawn voice transcript" }), { status: 200 });
      }
      if (url === "/api/sessions")
        return new Response(JSON.stringify(sessionsPayload()), { status: 200 });
      throw new Error(`Unexpected fetch: ${url} ${JSON.stringify(init)}`);
    });

    render(<Dashboard />);

    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Spawn Session" })).toBeInTheDocument();
    });

    fireEvent.click(screen.getByRole("button", { name: "Spawn Session" }));
    fireEvent.change(screen.getByRole("combobox", { name: "Spawn project" }), {
      target: { value: "api" },
    });

    const prompt = screen.getByPlaceholderText(SPAWN_PROMPT_VOICE_PLACEHOLDER);

    fireEvent.keyDown(prompt, { key: ".", metaKey: true });
    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Stop voice recording" })).toBeInTheDocument();
    });

    fireEvent.keyDown(prompt, { key: ".", metaKey: true });
    await waitFor(() => {
      expect(screen.getByDisplayValue("Spawn voice transcript")).toBeInTheDocument();
    });
  });

  it("does not submit spawn on plain Enter in prompt textarea", async () => {
    let spawnCalls = 0;
    vi.spyOn(global, "fetch").mockImplementation(async (input, init) => {
      const url = typeof input === "string" ? input : input.url;
      if (url === "/api/runtime/resources")
        return new Response(JSON.stringify({ available: false }));
      if (url === "/api/runtime/voice")
        return new Response(JSON.stringify({ available: false, modelPath: "", language: "" }));
      if (url === "/api/sessions")
        return new Response(JSON.stringify(sessionsPayload()), { status: 200 });
      if (url === "/api/spawn") {
        spawnCalls += 1;
        return new Response(JSON.stringify(sessionsPayload().sessions[0]), { status: 201 });
      }
      throw new Error(`Unexpected fetch: ${url} ${JSON.stringify(init)}`);
    });

    render(<Dashboard />);

    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Spawn Session" })).toBeInTheDocument();
    });

    fireEvent.click(screen.getByRole("button", { name: "Spawn Session" }));
    fireEvent.change(screen.getByRole("combobox", { name: "Spawn project" }), {
      target: { value: "api" },
    });
    const prompt = screen.getByPlaceholderText(SPAWN_PROMPT_PLACEHOLDER);
    fireEvent.change(prompt, { target: { value: "Do not submit" } });
    fireEvent.keyDown(prompt, { key: "Enter" });

    expect(spawnCalls).toBe(0);
  });

  it("defaults spawn project to the selected dashboard filter project", async () => {
    const sessionsData = {
      projects: [
        { id: "api", name: "API", configured: true, prefix: "api", path: "/repo/api" },
        { id: "sp", name: "Spur Core", configured: true, prefix: "sp", path: "/repo/sp" },
      ],
      sessions: [sessionsPayload().sessions[0]],
    };
    vi.spyOn(global, "fetch").mockImplementation(async (input) => {
      const url = typeof input === "string" ? input : input.url;
      if (url === "/api/runtime/resources")
        return new Response(JSON.stringify({ available: false }));
      if (url === "/api/runtime/voice")
        return new Response(JSON.stringify({ available: false, modelPath: "", language: "" }));
      return new Response(JSON.stringify(sessionsData));
    });

    render(<Dashboard />);

    await waitFor(() => {
      expect(
        screen.getByRole("button", { name: "Open web terminal for api-a1" }),
      ).toBeInTheDocument();
    });

    fireEvent.change(screen.getByRole("combobox", { name: "Project filter" }), {
      target: { value: "sp" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Spawn Session" }));

    const spawnProjectSelect = screen.getByRole("combobox", {
      name: "Spawn project",
    }) as HTMLSelectElement;
    expect(spawnProjectSelect.value).toBe("sp");
  });

  it("keeps a manual spawn project override while the modal is open", async () => {
    const sessionsData = {
      projects: [
        { id: "api", name: "API", configured: true, prefix: "api", path: "/repo/api" },
        { id: "sp", name: "Spur Core", configured: true, prefix: "sp", path: "/repo/sp" },
      ],
      sessions: [sessionsPayload().sessions[0]],
    };
    vi.spyOn(global, "fetch").mockImplementation(async (input) => {
      const url = typeof input === "string" ? input : input.url;
      if (url === "/api/runtime/resources")
        return new Response(JSON.stringify({ available: false }));
      if (url === "/api/runtime/voice")
        return new Response(JSON.stringify({ available: false, modelPath: "", language: "" }));
      return new Response(JSON.stringify(sessionsData));
    });

    render(<Dashboard />);

    await waitFor(() => {
      expect(
        screen.getByRole("button", { name: "Open web terminal for api-a1" }),
      ).toBeInTheDocument();
    });

    fireEvent.change(screen.getByRole("combobox", { name: "Project filter" }), {
      target: { value: "sp" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Spawn Session" }));

    const spawnProjectSelect = screen.getByRole("combobox", {
      name: "Spawn project",
    }) as HTMLSelectElement;
    fireEvent.change(spawnProjectSelect, { target: { value: "api" } });

    expect(
      (screen.getByRole("combobox", { name: "Spawn project" }) as HTMLSelectElement).value,
    ).toBe("api");
  });

  it("uses stored spawn project for all-projects filter and ignores stale values", async () => {
    const sessionsData = {
      projects: [
        { id: "api", name: "API", configured: true, prefix: "api", path: "/repo/api" },
        { id: "sp", name: "Spur Core", configured: true, prefix: "sp", path: "/repo/sp" },
      ],
      sessions: [sessionsPayload().sessions[0]],
    };
    vi.spyOn(global, "fetch").mockImplementation(async (input) => {
      const url = typeof input === "string" ? input : input.url;
      if (url === "/api/runtime/resources")
        return new Response(JSON.stringify({ available: false }));
      if (url === "/api/runtime/voice")
        return new Response(JSON.stringify({ available: false, modelPath: "", language: "" }));
      return new Response(JSON.stringify(sessionsData));
    });

    window.localStorage.setItem("spur:last-spawn-project", "sp");
    const { unmount } = render(<Dashboard />);

    await waitFor(() => {
      expect(
        screen.getByRole("button", { name: "Open web terminal for api-a1" }),
      ).toBeInTheDocument();
    });
    expect(screen.getByRole("combobox", { name: "Project filter" })).toHaveValue("");

    fireEvent.click(screen.getByRole("button", { name: "Spawn Session" }));
    let spawnProjectSelect = screen.getByRole("combobox", {
      name: "Spawn project",
    }) as HTMLSelectElement;
    expect(spawnProjectSelect.value).toBe("sp");

    unmount();
    window.localStorage.setItem("spur:last-spawn-project", "missing-project");
    render(<Dashboard />);
    await waitFor(() => {
      expect(
        screen.getByRole("button", { name: "Open web terminal for api-a1" }),
      ).toBeInTheDocument();
    });
    fireEvent.click(screen.getByRole("button", { name: "Spawn Session" }));
    spawnProjectSelect = screen.getByRole("combobox", {
      name: "Spawn project",
    }) as HTMLSelectElement;
    expect(spawnProjectSelect.value).toBe("api");
  });

  it("keeps All Projects selected after spawn, shows the placeholder, and remembers the last spawn project", async () => {
    const sessionsData = {
      projects: [
        { id: "api", name: "API", configured: true, prefix: "api", path: "/repo/api" },
        { id: "sp", name: "Spur Core", configured: true, prefix: "sp", path: "/repo/sp" },
      ],
      sessions: [sessionsPayload().sessions[0]],
    };
    const spawnedSession = {
      ...sessionsData.sessions[0],
      id: "sp-spawn-1",
      project: "sp",
      prompt: "Ship it",
      status: "spawning",
      state: "working",
      runtimeAlive: false,
      workspaceExists: false,
      tmuxSession: "sp-spawn-1",
      worktreePath: "/tmp/worktrees/sp-spawn-1",
    };

    vi.spyOn(global, "fetch").mockImplementation(async (input, init) => {
      const url = typeof input === "string" ? input : input.url;
      if (url === "/api/runtime/resources")
        return new Response(JSON.stringify({ available: false }));
      if (url === "/api/runtime/voice")
        return new Response(JSON.stringify({ available: false, modelPath: "", language: "" }));
      if (url === "/api/preflight")
        return new Response(JSON.stringify({ branch: null }), { status: 200 });
      if (url === "/api/spawn")
        return new Response(JSON.stringify(spawnedSession), { status: 201 });
      if (url === "/api/sessions")
        return new Response(JSON.stringify(sessionsData), { status: 200 });
      throw new Error(`Unexpected fetch: ${url} ${JSON.stringify(init)}`);
    });

    render(<Dashboard />);

    await waitFor(() => {
      expect(
        screen.getByRole("button", { name: "Open web terminal for api-a1" }),
      ).toBeInTheDocument();
    });

    fireEvent.click(screen.getByRole("button", { name: "Spawn Session" }));
    const spawnProjectSelect = screen.getByRole("combobox", { name: "Spawn project" });
    fireEvent.change(spawnProjectSelect, { target: { value: "sp" } });
    expect(window.localStorage.getItem("spur:last-spawn-project")).toBe("sp");
    fireEvent.change(screen.getByLabelText("branch name"), {
      target: { value: "feature/ship-it" },
    });
    fireEvent.click(screen.getByRole("checkbox", { name: "Plan" }));
    fireEvent.click(screen.getByRole("button", { name: "+ Step" }));
    fireEvent.change(screen.getByLabelText("step 1"), {
      target: { value: "Ship the fix" },
    });

    fireEvent.change(screen.getByPlaceholderText(SPAWN_PROMPT_PLACEHOLDER), {
      target: { value: "Ship it" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Spawn" }));

    await waitFor(() => {
      expect(window.localStorage.getItem("spur:last-spawn-project")).toBe("sp");
      expect(screen.queryByPlaceholderText(SPAWN_PROMPT_PLACEHOLDER)).not.toBeInTheDocument();
      expect(screen.getByRole("link", { name: "Ship it" })).toBeInTheDocument();
    });

    expect(screen.getByRole("combobox", { name: "Project filter" })).toHaveValue("");
    expect(window.location.search).toBe("");

    fireEvent.click(screen.getByRole("button", { name: "Spawn Session" }));

    expect(screen.getByRole("combobox", { name: "Spawn project" })).toHaveValue("sp");
    expect(screen.getByPlaceholderText(SPAWN_PROMPT_PLACEHOLDER)).toHaveValue("");
    expect(screen.getByLabelText("branch name")).toHaveValue("");
    expect(screen.getByRole("checkbox", { name: "Plan" })).not.toBeChecked();
    expect(screen.queryByLabelText("step 1")).not.toBeInTheDocument();
  });

  it("keeps a matching project filter and URL unchanged while showing the new placeholder", async () => {
    window.history.replaceState(null, "", "/?project=api");
    const sessionsData = {
      projects: [
        { id: "api", name: "API", configured: true, prefix: "api", path: "/repo/api" },
        { id: "sp", name: "Spur Core", configured: true, prefix: "sp", path: "/repo/sp" },
      ],
      sessions: [sessionsPayload().sessions[0]],
    };
    const spawned = {
      ...sessionsData.sessions[0],
      id: "api-spawn-1",
      prompt: "Spawn in matching filter",
      status: "spawning",
      state: "working",
      runtimeAlive: false,
      workspaceExists: false,
      tmuxSession: "api-spawn-1",
      worktreePath: "/tmp/worktrees/api-spawn-1",
    };
    vi.spyOn(global, "fetch").mockImplementation(async (input, init) => {
      const url = typeof input === "string" ? input : input.url;
      if (url === "/api/runtime/resources")
        return new Response(JSON.stringify({ available: false }));
      if (url === "/api/runtime/voice")
        return new Response(JSON.stringify({ available: false, modelPath: "", language: "" }));
      if (url === "/api/preflight")
        return new Response(JSON.stringify({ branch: null }), { status: 200 });
      if (url === "/api/spawn") {
        expect(init?.method).toBe("POST");
        return new Response(JSON.stringify(spawned), { status: 201 });
      }
      if (url === "/api/sessions") {
        return new Response(JSON.stringify(sessionsData), { status: 200 });
      }
      throw new Error(`Unexpected fetch: ${url} ${JSON.stringify(init)}`);
    });

    render(<Dashboard />);

    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Spawn Session" })).toBeInTheDocument();
    });

    fireEvent.click(screen.getByRole("button", { name: "Spawn Session" }));
    fireEvent.change(screen.getByPlaceholderText(SPAWN_PROMPT_PLACEHOLDER), {
      target: { value: "Spawn in matching filter" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Spawn" }));

    await waitFor(() => {
      expect(screen.queryByPlaceholderText(SPAWN_PROMPT_PLACEHOLDER)).not.toBeInTheDocument();
      expect(screen.getByRole("link", { name: "Spawn in matching filter" })).toBeInTheDocument();
    });

    expect(screen.getByRole("combobox", { name: "Project filter" })).toHaveValue("api");
    expect(window.location.search).toBe("?project=api");
  });

  it("keeps a mismatched project filter and URL unchanged without showing the new placeholder", async () => {
    window.history.replaceState(null, "", "/?project=api");
    const sessionsData = {
      projects: [
        { id: "api", name: "API", configured: true, prefix: "api", path: "/repo/api" },
        { id: "sp", name: "Spur Core", configured: true, prefix: "sp", path: "/repo/sp" },
      ],
      sessions: [sessionsPayload().sessions[0]],
    };
    const spawned = {
      ...sessionsData.sessions[0],
      id: "sp-spawn-hidden-1",
      project: "sp",
      prompt: "Spawn in another project",
      status: "spawning",
      state: "working",
      runtimeAlive: false,
      workspaceExists: false,
      tmuxSession: "sp-spawn-hidden-1",
      worktreePath: "/tmp/worktrees/sp-spawn-hidden-1",
    };

    vi.spyOn(global, "fetch").mockImplementation(async (input, init) => {
      const url = typeof input === "string" ? input : input.url;
      if (url === "/api/runtime/resources")
        return new Response(JSON.stringify({ available: false }));
      if (url === "/api/runtime/voice")
        return new Response(JSON.stringify({ available: false, modelPath: "", language: "" }));
      if (url === "/api/preflight")
        return new Response(JSON.stringify({ branch: null }), { status: 200 });
      if (url === "/api/spawn") {
        expect(init?.method).toBe("POST");
        return new Response(JSON.stringify(spawned), { status: 201 });
      }
      if (url === "/api/sessions") {
        return new Response(JSON.stringify(sessionsData), { status: 200 });
      }
      throw new Error(`Unexpected fetch: ${url} ${JSON.stringify(init)}`);
    });

    render(<Dashboard />);

    await waitFor(() => {
      expect(
        screen.getByRole("button", { name: "Open web terminal for api-a1" }),
      ).toBeInTheDocument();
    });

    fireEvent.click(screen.getByRole("button", { name: "Spawn Session" }));
    fireEvent.change(screen.getByRole("combobox", { name: "Spawn project" }), {
      target: { value: "sp" },
    });
    fireEvent.change(screen.getByPlaceholderText(SPAWN_PROMPT_PLACEHOLDER), {
      target: { value: "Spawn in another project" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Spawn" }));

    await waitFor(() => {
      expect(screen.queryByPlaceholderText(SPAWN_PROMPT_PLACEHOLDER)).not.toBeInTheDocument();
    });

    expect(
      screen.queryByRole("link", { name: "Spawn in another project" }),
    ).not.toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Fix auth" })).toBeInTheDocument();
    expect(screen.getByRole("combobox", { name: "Project filter" })).toHaveValue("api");
    expect(window.location.search).toBe("?project=api");
    expect(window.localStorage.getItem("spur:last-spawn-project")).toBe("sp");
  });

  it("keeps spawn modal open and preserves fields when spawn ack fails", async () => {
    vi.spyOn(global, "fetch").mockImplementation(async (input, init) => {
      const url = typeof input === "string" ? input : input.url;
      if (url === "/api/runtime/resources")
        return new Response(JSON.stringify({ available: false }));
      if (url === "/api/runtime/voice")
        return new Response(JSON.stringify({ available: false, modelPath: "", language: "" }));
      if (url === "/api/sessions")
        return new Response(JSON.stringify(sessionsPayload()), { status: 200 });
      if (url === "/api/spawn")
        return new Response(JSON.stringify({ error: "Daemon down" }), { status: 502 });
      throw new Error(`Unexpected fetch: ${url} ${JSON.stringify(init)}`);
    });

    render(<Dashboard />);

    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Spawn Session" })).toBeInTheDocument();
    });

    fireEvent.click(screen.getByRole("button", { name: "Spawn Session" }));
    fireEvent.change(screen.getAllByRole("combobox")[1], { target: { value: "api" } });
    fireEvent.change(screen.getByPlaceholderText(SPAWN_PROMPT_PLACEHOLDER), {
      target: { value: "Keep this prompt" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Spawn" }));

    await waitFor(() => {
      expect(screen.getByPlaceholderText(SPAWN_PROMPT_PLACEHOLDER)).toHaveValue("Keep this prompt");
      expect(screen.getByRole("heading", { name: "Spawn Session" })).toBeInTheDocument();
      expect(screen.getByText(/Daemon down/i)).toBeInTheDocument();
    });
  });

  it("ignores a second spawn click while the first request is still in flight", async () => {
    const spawned = {
      ...sessionsPayload().sessions[0],
      id: "api-spawn-guard-1",
      prompt: "Only one submit",
      status: "spawning",
      state: "working",
      runtimeAlive: false,
      workspaceExists: false,
      tmuxSession: "api-spawn-guard-1",
      worktreePath: "/tmp/worktrees/api-spawn-guard-1",
    };
    let spawnCalls = 0;
    let resolveSpawn: ((response: Response) => void) | undefined;
    const pendingSpawn = new Promise<Response>((resolve) => {
      resolveSpawn = resolve;
    });

    vi.spyOn(global, "fetch").mockImplementation(async (input, init) => {
      const url = typeof input === "string" ? input : input.url;
      if (url === "/api/runtime/resources")
        return new Response(JSON.stringify({ available: false }));
      if (url === "/api/runtime/voice")
        return new Response(JSON.stringify({ available: false, modelPath: "", language: "" }));
      if (url === "/api/sessions")
        return new Response(JSON.stringify(sessionsPayload()), { status: 200 });
      if (url === "/api/spawn") {
        spawnCalls += 1;
        return pendingSpawn;
      }
      throw new Error(`Unexpected fetch: ${url} ${JSON.stringify(init)}`);
    });

    render(<Dashboard />);

    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Spawn Session" })).toBeInTheDocument();
    });

    fireEvent.click(screen.getByRole("button", { name: "Spawn Session" }));
    fireEvent.change(screen.getAllByRole("combobox")[1], { target: { value: "api" } });
    fireEvent.change(screen.getByPlaceholderText(SPAWN_PROMPT_PLACEHOLDER), {
      target: { value: "Only one submit" },
    });

    const spawnButton = screen.getByRole("button", { name: "Spawn" });
    fireEvent.click(spawnButton);
    fireEvent.click(spawnButton);

    expect(spawnCalls).toBe(1);
    expect(spawnButton).toBeDisabled();

    resolveSpawn?.(new Response(JSON.stringify(spawned), { status: 201 }));

    await waitFor(() => {
      expect(screen.queryByPlaceholderText(SPAWN_PROMPT_PLACEHOLDER)).not.toBeInTheDocument();
      expect(screen.getByRole("link", { name: "Only one submit" })).toBeInTheDocument();
    });
  });

  it("exposes install metadata for PWA installability", async () => {
    const appManifest = manifest();

    expect(metadata.title).toBe("Spur");
    expect(metadata.manifest).toBe("/manifest.webmanifest");
    expect(metadata.applicationName).toBe("Spur");
    expect(metadata.appleWebApp).toMatchObject({
      capable: true,
      title: "Spur",
      statusBarStyle: "black-translucent",
    });
    expect(metadata.icons).toMatchObject({
      icon: [{ url: "/icon-192" }, { url: "/icon-512" }],
      apple: [{ url: "/apple-icon" }],
    });

    expect(appManifest).toMatchObject({
      name: "Spur",
      short_name: "Spur",
      start_url: "/",
      display: "standalone",
      background_color: "#0d0d0e",
      theme_color: "#0d0d0e",
    });
    expect(appManifest.icons).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ src: "/icon-192", sizes: "192x192" }),
        expect.objectContaining({ src: "/icon-512", sizes: "512x512" }),
        expect.objectContaining({
          src: "/icon-512",
          sizes: "512x512",
          purpose: "maskable",
        }),
      ]),
    );
  });

  it("uses the fetched task title as the session page title", async () => {
    mockedSpurRequestJson.mockResolvedValue({
      ...sessionsPayload().sessions[0],
      id: "feature/test-123",
      slots: { title: "Fix auth title", links: [] },
    });

    const metadata = await generateSessionMetadata({
      params: Promise.resolve({ id: "feature%2Ftest-123" }),
    });

    expect(mockedSpurRequestJson).toHaveBeenCalledWith("/sessions/feature%2Ftest-123");
    expect(metadata.title).toBe("Fix auth title");
  });

  it("falls back to the decoded session id when session metadata load fails", async () => {
    mockedSpurRequestJson.mockRejectedValue(new Error("daemon down"));

    const metadata = await generateSessionMetadata({
      params: Promise.resolve({ id: "feature%2Ftest-123" }),
    });

    expect(metadata.title).toBe("feature/test-123");
  });

  it("re-mount within staleTime serves cached sessions without a second fetch", async () => {
    let sessionFetches = 0;
    vi.spyOn(global, "fetch").mockImplementation(async (input) => {
      const url = typeof input === "string" ? input : input.url;
      if (url === "/api/runtime/resources") {
        return new Response(JSON.stringify({ available: false }));
      }
      if (url === "/api/runtime/voice") {
        return new Response(JSON.stringify({ available: false, language: "" }));
      }
      if (url === "/api/sessions") {
        sessionFetches += 1;
        return new Response(JSON.stringify(sessionsPayload()), { status: 200 });
      }
      throw new Error(`Unexpected fetch: ${url}`);
    });

    const client = new QueryClient({
      defaultOptions: {
        queries: { retry: false, refetchOnWindowFocus: false, staleTime: 5_000 },
      },
    });
    const Wrapper = ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={client}>{children}</QueryClientProvider>
    );

    const first = rtlRender(<Dashboard />, { wrapper: Wrapper });

    await waitFor(() => {
      expect(screen.getByRole("link", { name: "Fix auth" })).toBeInTheDocument();
    });
    expect(sessionFetches).toBe(1);

    first.unmount();

    rtlRender(<Dashboard />, { wrapper: Wrapper });

    await waitFor(() => {
      expect(screen.getByRole("link", { name: "Fix auth" })).toBeInTheDocument();
    });

    expect(sessionFetches).toBe(1);
  });

  it("opens the new-project modal from the gear menu and posts /api/projects", async () => {
    let createPosted = false;
    vi.spyOn(global, "fetch").mockImplementation(async (input, init) => {
      const url = typeof input === "string" ? input : input.url;
      if (url === "/api/runtime/resources")
        return new Response(JSON.stringify({ available: false }));
      if (url === "/api/runtime/voice")
        return new Response(JSON.stringify({ available: false, modelPath: "", language: "" }));
      if (url === "/api/sessions") {
        return new Response(JSON.stringify(sessionsPayload()), { status: 200 });
      }
      if (url === "/api/projects" && init?.method === "POST") {
        createPosted = true;
        expect(init?.body).toBe(
          JSON.stringify({ displayName: "Demo", prefix: "demo", path: "/repo/demo" }),
        );
        return new Response(
          JSON.stringify({
            id: "demo",
            entry: {
              id: "demo",
              name: "Demo",
              configured: false,
              prefix: "demo",
              path: "/repo/demo",
            },
            projects: [],
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
    fireEvent.click(screen.getByRole("button", { name: "+ New project" }));

    fireEvent.change(screen.getByLabelText("Project display name"), {
      target: { value: "Demo" },
    });
    fireEvent.change(screen.getByLabelText("Project session prefix"), {
      target: { value: "demo" },
    });
    fireEvent.change(screen.getByLabelText("Project path"), {
      target: { value: "/repo/demo" },
    });

    fireEvent.click(screen.getByRole("button", { name: "Create" }));

    await waitFor(() => {
      expect(createPosted).toBe(true);
    });
  });

  it("closes the new-project modal when Escape is pressed", async () => {
    vi.spyOn(global, "fetch").mockImplementation(async (input) => {
      const url = typeof input === "string" ? input : input.url;
      if (url === "/api/runtime/resources")
        return new Response(JSON.stringify({ available: false }));
      if (url === "/api/runtime/voice")
        return new Response(JSON.stringify({ available: false, modelPath: "", language: "" }));
      if (url === "/api/sessions") {
        return new Response(JSON.stringify(sessionsPayload()), { status: 200 });
      }
      throw new Error(`Unexpected fetch: ${url}`);
    });

    render(<Dashboard />);

    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Project actions" })).toBeInTheDocument();
    });

    fireEvent.click(screen.getByRole("button", { name: "Project actions" }));
    fireEvent.click(screen.getByRole("button", { name: "+ New project" }));

    expect(screen.getByLabelText("Project display name")).toBeInTheDocument();

    fireEvent.keyDown(window, { key: "Escape" });

    await waitFor(() => {
      expect(screen.queryByLabelText("Project display name")).toBeNull();
    });
  });

  it("shows a validation error when the prefix has invalid characters", async () => {
    vi.spyOn(global, "fetch").mockImplementation(async (input) => {
      const url = typeof input === "string" ? input : input.url;
      if (url === "/api/runtime/resources")
        return new Response(JSON.stringify({ available: false }));
      if (url === "/api/runtime/voice")
        return new Response(JSON.stringify({ available: false, modelPath: "", language: "" }));
      if (url === "/api/sessions") {
        return new Response(JSON.stringify(sessionsPayload()), { status: 200 });
      }
      throw new Error(`Unexpected fetch: ${url}`);
    });

    render(<Dashboard />);

    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Project actions" })).toBeInTheDocument();
    });

    fireEvent.click(screen.getByRole("button", { name: "Project actions" }));
    fireEvent.click(screen.getByRole("button", { name: "+ New project" }));

    fireEvent.change(screen.getByLabelText("Project display name"), {
      target: { value: "Demo" },
    });
    fireEvent.change(screen.getByLabelText("Project session prefix"), {
      target: { value: "bad prefix" },
    });
    fireEvent.change(screen.getByLabelText("Project path"), {
      target: { value: "/repo/demo" },
    });

    fireEvent.click(screen.getByRole("button", { name: "Create" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(/Prefix/);
  });

  it("flags unconfigured projects with an UNCONFIGURED badge and skips them in filter", async () => {
    vi.spyOn(global, "fetch").mockImplementation(async (input) => {
      const url = typeof input === "string" ? input : input.url;
      if (url === "/api/runtime/resources")
        return new Response(JSON.stringify({ available: false }));
      if (url === "/api/runtime/voice")
        return new Response(JSON.stringify({ available: false, modelPath: "", language: "" }));
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
      throw new Error(`Unexpected fetch: ${url}`);
    });

    render(<Dashboard />);

    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Project actions" })).toBeInTheDocument();
    });

    const filterSelect = screen.getByRole("combobox", { name: "Project filter" });
    expect(within(filterSelect).queryByRole("option", { name: "Stub" })).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Project actions" }));
    expect(screen.queryByRole("button", { name: /configure/i })).toBeNull();
    expect(screen.getByText(/unconfigured/i)).toBeInTheDocument();
  });
});

describe("StatusBar", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  function mockStatusBarFetch({
    resources,
    github,
    gitlab,
  }: {
    resources: Record<string, unknown>;
    github?: Record<string, unknown>;
    gitlab?: Record<string, unknown>;
  }) {
    vi.spyOn(global, "fetch").mockImplementation(async (input) => {
      const url = typeof input === "string" ? input : input.url;
      if (url === "/api/runtime/resources") {
        return new Response(JSON.stringify(resources));
      }
      if (url === "/api/github-status") {
        return new Response(
          JSON.stringify(
            github ?? { ok: true, requestedAt: "2026-04-28T10:00:00.000Z", configured: true },
          ),
        );
      }
      if (url === "/api/gitlab-status") {
        return new Response(
          JSON.stringify(
            gitlab ?? { ok: true, requestedAt: "2026-04-28T10:00:00.000Z", configured: true },
          ),
        );
      }
      throw new Error(`Unexpected fetch: ${url}`);
    });
  }

  function renderStatusBar() {
    const client = createTestQueryClient();
    client.setQueryData(["sessions"], { sessions: [], projects: [], daemonAlive: true });
    const Wrapper = ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={client}>{children}</QueryClientProvider>
    );
    return rtlRender(<StatusBar />, { wrapper: Wrapper });
  }

  function expectAggregatedStatusButtonHasIcon(): void {
    expect(
      screen.getByRole("button", { name: "Show aggregated system status" }).querySelector("svg"),
    ).not.toBeNull();
  }

  it("renders build version without hydration mismatch", () => {
    const client = createTestQueryClient();
    const html = renderToString(
      <QueryClientProvider client={client}>
        <StatusBar />
      </QueryClientProvider>,
    );
    expect(html).toContain("dev");
  });

  it("renders resource metrics when runtime resources are available", async () => {
    mockStatusBarFetch({
      resources: {
        available: true,
        cpuPercent: 12,
        memoryPercent: 34,
        diskPercent: 56,
      },
    });

    renderStatusBar();

    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Show aggregated system status" })).toHaveAttribute(
        "data-status",
        "ready",
      );
    });

    expectAggregatedStatusButtonHasIcon();

    fireEvent.click(screen.getByRole("button", { name: "Show aggregated system status" }));

    expect(screen.getByText("System")).toBeInTheDocument();
    expect(screen.getByText("Healthy")).toBeInTheDocument();
    expect(screen.getByLabelText("Daemon online healthy")).toBeInTheDocument();
    expect(screen.getByLabelText("CPU 12% healthy")).toBeInTheDocument();
    expect(screen.getByLabelText("RAM 34% healthy")).toBeInTheDocument();
    expect(screen.getByLabelText("HDD 56% healthy")).toBeInTheDocument();
  });

  it("hides resource metrics when runtime resources are unavailable", async () => {
    mockStatusBarFetch({
      resources: { available: false },
    });

    renderStatusBar();

    await waitFor(() => {
      expect(screen.queryByText(/CPU \d+%/)).not.toBeInTheDocument();
      expect(screen.queryByText(/RAM \d+%/)).not.toBeInTheDocument();
      expect(screen.queryByText(/DISK \d+%/)).not.toBeInTheDocument();
    });

    fireEvent.click(screen.getByRole("button", { name: "Show aggregated system status" }));

    expect(screen.getByLabelText("Daemon online healthy")).toBeInTheDocument();
    expect(screen.getByLabelText("CPU unavailable unavailable")).toBeInTheDocument();
    expect(screen.getByLabelText("RAM unavailable unavailable")).toBeInTheDocument();
    expect(screen.getByLabelText("HDD unavailable unavailable")).toBeInTheDocument();
  });

  it("shows warning and error states in the online tooltip", async () => {
    mockStatusBarFetch({
      resources: {
        available: true,
        cpuPercent: 88,
        memoryPercent: 86,
        diskPercent: 91,
      },
    });

    renderStatusBar();

    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Show aggregated system status" })).toHaveAttribute(
        "data-status",
        "error",
      );
    });

    expectAggregatedStatusButtonHasIcon();

    fireEvent.click(screen.getByRole("button", { name: "Show aggregated system status" }));

    expect(screen.getByText("Critical")).toBeInTheDocument();
    expect(screen.getByLabelText("CPU 88% warning")).toBeInTheDocument();
    expect(screen.getByLabelText("RAM 86% warning")).toBeInTheDocument();
    expect(screen.getByLabelText("HDD 91% critical")).toBeInTheDocument();
  });

  it("syncs warning status text in the footer and closes the tooltip when its content is clicked", async () => {
    mockStatusBarFetch({
      resources: {
        available: true,
        cpuPercent: 86,
        memoryPercent: 48,
        diskPercent: 41,
      },
    });

    renderStatusBar();

    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Show aggregated system status" })).toHaveAttribute(
        "data-status",
        "attention",
      );
    });

    expectAggregatedStatusButtonHasIcon();

    fireEvent.click(screen.getByRole("button", { name: "Show aggregated system status" }));

    const tooltipHeader = screen.getByText("System").closest("div");
    expect(tooltipHeader).not.toBeNull();
    expect(within(tooltipHeader!).getByText("Warning")).toBeInTheDocument();

    fireEvent.click(tooltipHeader!);

    expect(screen.queryByText("System")).not.toBeInTheDocument();
  });

  it("shows a healthy GitHub footer tooltip with the last request timestamp", async () => {
    mockStatusBarFetch({
      resources: { available: false },
      github: { ok: true, requestedAt: "2026-04-28T10:00:00.000Z", configured: true },
    });

    renderStatusBar();

    const githubStatus = await screen.findByLabelText("GitHub connection healthy");
    fireEvent.mouseEnter(githubStatus);

    expect(screen.getByText("GitHub")).toBeInTheDocument();
    expect(screen.getByText("Healthy")).toBeInTheDocument();
    expect(screen.getByText(/Last request:/)).toBeInTheDocument();
  });

  it("shows a healthy GitLab footer tooltip with the last request timestamp", async () => {
    mockStatusBarFetch({
      resources: { available: false },
      gitlab: { ok: true, requestedAt: "2026-04-28T10:00:00.000Z", configured: true },
    });

    renderStatusBar();

    const gitlabStatus = await screen.findByLabelText("GitLab connection healthy");
    fireEvent.mouseEnter(gitlabStatus);

    expect(screen.getByText("GitLab")).toBeInTheDocument();
    expect(screen.getByText(/Last request:/)).toBeInTheDocument();
  });

  it("keeps the healthy GitHub tooltip open when the icon is clicked and closes it on the next click", async () => {
    mockStatusBarFetch({
      resources: { available: false },
      github: { ok: true, requestedAt: "2026-04-28T10:00:00.000Z", configured: true },
    });

    renderStatusBar();

    const githubStatus = await screen.findByLabelText("GitHub connection healthy");
    fireEvent.click(githubStatus);
    fireEvent.mouseLeave(githubStatus);

    expect(screen.getByText("GitHub")).toBeInTheDocument();
    expect(screen.getByText(/Last request:/)).toBeInTheDocument();

    fireEvent.click(githubStatus);

    expect(screen.queryByText("GitHub")).not.toBeInTheDocument();
  });

  it("keeps provider statuses icon-only on the footer bar", async () => {
    mockStatusBarFetch({
      resources: { available: false },
    });

    renderStatusBar();

    const githubStatus = await screen.findByLabelText("GitHub connection healthy");
    const gitlabStatus = await screen.findByLabelText("GitLab connection healthy");
    expect(githubStatus).not.toHaveTextContent(/healthy|warning|critical|checking|error/i);
    expect(gitlabStatus).not.toHaveTextContent(/healthy|warning|critical|checking|error/i);
  });

  it("shows the temporary checking state inside the GitHub tooltip before the request resolves", async () => {
    vi.spyOn(global, "fetch").mockImplementation(async (input) => {
      const url = typeof input === "string" ? input : input.url;
      if (url === "/api/runtime/resources") {
        return new Response(JSON.stringify({ available: false }));
      }
      if (url === "/api/github-status") {
        return new Promise<Response>(() => {});
      }
      if (url === "/api/gitlab-status") {
        return new Response(
          JSON.stringify({
            ok: true,
            requestedAt: "2026-04-28T10:00:00.000Z",
            configured: true,
          }),
        );
      }
      throw new Error(`Unexpected fetch: ${url}`);
    });

    renderStatusBar();

    const githubStatus = screen.getByLabelText("GitHub connection checking");
    fireEvent.mouseEnter(githubStatus);
    expect(screen.getByText("Checking")).toBeInTheDocument();
  });

  it("shows the GitHub error text in the tooltip when the health check fails", async () => {
    mockStatusBarFetch({
      resources: { available: false },
      github: {
        ok: false,
        error: "GitHub API 503",
        requestedAt: "2026-04-28T10:00:00.000Z",
        configured: true,
      },
    });

    renderStatusBar();

    const githubStatus = await screen.findByLabelText("GitHub connection error");
    fireEvent.click(githubStatus);
    expect(screen.getByText("GitHub API 503")).toBeInTheDocument();
  });

  it("shows a synthesized GitHub error in the tooltip when the endpoint returns a non-200 response", async () => {
    vi.spyOn(global, "fetch").mockImplementation(async (input) => {
      const url = typeof input === "string" ? input : input.url;
      if (url === "/api/runtime/resources") {
        return new Response(JSON.stringify({ available: false }));
      }
      if (url === "/api/github-status") {
        return new Response(JSON.stringify({ error: "upstream unavailable" }), { status: 503 });
      }
      if (url === "/api/gitlab-status") {
        return new Response(
          JSON.stringify({
            ok: true,
            requestedAt: "2026-04-28T10:00:00.000Z",
            configured: true,
          }),
        );
      }
      throw new Error(`Unexpected fetch: ${url}`);
    });

    renderStatusBar();

    const githubStatus = await screen.findByLabelText("GitHub connection error");
    fireEvent.click(githubStatus);
    expect(screen.getByText("GitHub status unavailable (503)")).toBeInTheDocument();
  });

  it("dedupes resource fetches across instances mounted under a shared QueryClient", async () => {
    let resourceFetches = 0;
    vi.spyOn(global, "fetch").mockImplementation(async (input) => {
      const url = typeof input === "string" ? input : input.url;
      if (url === "/api/runtime/resources") {
        resourceFetches += 1;
        return new Response(JSON.stringify({ available: false }));
      }
      if (url === "/api/github-status") {
        return new Response(
          JSON.stringify({
            ok: true,
            requestedAt: "2026-04-28T10:00:00.000Z",
            configured: true,
          }),
        );
      }
      if (url === "/api/gitlab-status") {
        return new Response(
          JSON.stringify({
            ok: true,
            requestedAt: "2026-04-28T10:00:00.000Z",
            configured: true,
          }),
        );
      }
      throw new Error(`Unexpected fetch: ${url}`);
    });

    const client = new QueryClient({
      defaultOptions: {
        queries: { retry: false, refetchOnWindowFocus: false, staleTime: 15_000 },
      },
    });
    client.setQueryData(["sessions"], { sessions: [], projects: [], daemonAlive: true });
    const Wrapper = ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={client}>{children}</QueryClientProvider>
    );

    rtlRender(
      <>
        <StatusBar />
        <StatusBar />
      </>,
      { wrapper: Wrapper },
    );

    await waitFor(() => {
      expect(resourceFetches).toBeGreaterThan(0);
    });
    expect(resourceFetches).toBe(1);
  });

  it("shows daemon offline when the sessions query errors", async () => {
    mockStatusBarFetch({
      resources: { available: false },
    });

    const client = createTestQueryClient();
    await client
      .fetchQuery({
        queryKey: ["sessions"],
        queryFn: () => Promise.reject(new Error("daemon down")),
        retry: false,
      })
      .catch(() => {});
    const Wrapper = ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={client}>{children}</QueryClientProvider>
    );

    rtlRender(<StatusBar />, { wrapper: Wrapper });

    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Show aggregated system status" })).toHaveAttribute(
        "data-status",
        "error",
      );
    });

    fireEvent.click(screen.getByRole("button", { name: "Show aggregated system status" }));
    expect(screen.getByLabelText("Daemon offline critical")).toBeInTheDocument();
  });

  it("does not flash daemon offline before the first sessions response", () => {
    mockStatusBarFetch({
      resources: { available: false },
    });

    const client = createTestQueryClient();
    const Wrapper = ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={client}>{children}</QueryClientProvider>
    );

    rtlRender(<StatusBar />, { wrapper: Wrapper });

    expect(screen.getByRole("button", { name: "Show aggregated system status" })).toHaveAttribute(
      "data-status",
      "unknown",
    );
    expectAggregatedStatusButtonHasIcon();
  });

  function renderStatusBarWithSessionLinks(
    links: Array<{ label: string; url: string }>,
  ): ReturnType<typeof rtlRender> {
    const client = createTestQueryClient();
    client.setQueryData(["sessions"], {
      projects: [],
      sessions: [{ id: "s1", slots: { links } }],
      daemonAlive: true,
    });
    const Wrapper = ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={client}>{children}</QueryClientProvider>
    );
    return rtlRender(<StatusBar />, { wrapper: Wrapper });
  }

  it("hides both provider badges when neither configured nor referenced by sessions", async () => {
    mockStatusBarFetch({
      resources: { available: false },
      github: {
        ok: false,
        error: "GitHub auth unavailable",
        requestedAt: null,
        configured: false,
      },
      gitlab: {
        ok: false,
        error: "GitLab auth unavailable",
        requestedAt: null,
        configured: false,
      },
    });

    renderStatusBar();

    await waitFor(() => {
      expect(screen.queryByLabelText(/GitHub connection/)).not.toBeInTheDocument();
      expect(screen.queryByLabelText(/GitLab connection/)).not.toBeInTheDocument();
    });
  });

  it("shows the GitHub badge when unconfigured but a session links to a github.com PR", async () => {
    mockStatusBarFetch({
      resources: { available: false },
      github: {
        ok: false,
        error: "GitHub auth unavailable",
        requestedAt: null,
        configured: false,
      },
      gitlab: {
        ok: false,
        error: "GitLab auth unavailable",
        requestedAt: null,
        configured: false,
      },
    });

    renderStatusBarWithSessionLinks([
      { label: "github-pr", url: "https://github.com/acme/repo/pull/12" },
    ]);

    expect(await screen.findByLabelText("GitHub connection error")).toBeInTheDocument();
    expect(screen.queryByLabelText(/GitLab connection/)).not.toBeInTheDocument();
  });

  it("shows the GitHub badge in error state when configured and ok is false regardless of links", async () => {
    mockStatusBarFetch({
      resources: { available: false },
      github: {
        ok: false,
        error: "GitHub API 503",
        requestedAt: "2026-04-28T10:00:00.000Z",
        configured: true,
      },
      gitlab: {
        ok: false,
        error: "GitLab auth unavailable",
        requestedAt: null,
        configured: false,
      },
    });

    renderStatusBar();

    expect(await screen.findByLabelText("GitHub connection error")).toBeInTheDocument();
    expect(screen.queryByLabelText(/GitLab connection/)).not.toBeInTheDocument();
  });

  it("shows the GitHub badge in healthy state when configured and ok", async () => {
    mockStatusBarFetch({
      resources: { available: false },
      github: { ok: true, requestedAt: "2026-04-28T10:00:00.000Z", configured: true },
      gitlab: {
        ok: false,
        error: "GitLab auth unavailable",
        requestedAt: null,
        configured: false,
      },
    });

    renderStatusBar();

    expect(await screen.findByLabelText("GitHub connection healthy")).toBeInTheDocument();
    expect(screen.queryByLabelText(/GitLab connection/)).not.toBeInTheDocument();
  });

  it("renders both badges during initial loading even when sessions are unseeded", () => {
    vi.spyOn(global, "fetch").mockImplementation(async (input) => {
      const url = typeof input === "string" ? input : input.url;
      if (url === "/api/runtime/resources") {
        return new Response(JSON.stringify({ available: false }));
      }
      if (url === "/api/github-status" || url === "/api/gitlab-status") {
        return new Promise<Response>(() => {});
      }
      throw new Error(`Unexpected fetch: ${url}`);
    });

    const client = createTestQueryClient();
    const Wrapper = ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={client}>{children}</QueryClientProvider>
    );
    rtlRender(<StatusBar />, { wrapper: Wrapper });

    expect(screen.getByLabelText("GitHub connection checking")).toBeInTheDocument();
    expect(screen.getByLabelText("GitLab connection checking")).toBeInTheDocument();
  });

  it("shows the GitLab badge when unconfigured but a session links to a merge request", async () => {
    mockStatusBarFetch({
      resources: { available: false },
      github: {
        ok: false,
        error: "GitHub auth unavailable",
        requestedAt: null,
        configured: false,
      },
      gitlab: {
        ok: false,
        error: "GitLab auth unavailable",
        requestedAt: null,
        configured: false,
      },
    });

    renderStatusBarWithSessionLinks([
      { label: "gitlab-pr", url: "https://gitlab.com/acme/repo/-/merge_requests/5" },
    ]);

    expect(await screen.findByLabelText("GitLab connection error")).toBeInTheDocument();
    expect(screen.queryByLabelText(/GitHub connection/)).not.toBeInTheDocument();
  });
});
