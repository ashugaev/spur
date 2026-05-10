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
    label,
    onClose,
    sessionId,
    title,
  }: {
    label?: string;
    onClose?: () => void;
    sessionId: string;
    title?: string;
  }) => (
    <div>
      <div>{`Direct terminal ${label ?? sessionId}`}</div>
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
      expect(screen.getByText("Direct terminal title API • claude")).toBeInTheDocument();
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

  it("restores terminal from query params for attachable sessions", async () => {
    window.history.replaceState(null, "", "/?terminal=api-a1");
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

    await waitFor(() => {
      expect(screen.getByRole("dialog", { name: "Terminal api-a1" })).toBeInTheDocument();
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
            projects: [{ id: "api", name: "API" }],
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
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/sessions",
      expect.objectContaining({ cache: "no-store" }),
    );
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
              { id: "api", name: "API" },
              { id: "web", name: "Web" },
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

  it("shows a reset-filters empty state when stat filters hide all sessions", async () => {
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
            projects: [{ id: "api", name: "API" }],
            sessions: [sessionsPayload().sessions[0]],
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

    fireEvent.click(screen.getByRole("button", { name: "Needs Input: 0" }));

    expect(
      screen.getByText("No sessions match the current filters.", { exact: false }),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Reset Filters" })).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Reset Filters" }));

    await waitFor(() => {
      expect(screen.getByRole("link", { name: "Fix auth" })).toBeInTheDocument();
    });
  });

  it("hides completed sessions by default and toggles them into view", async () => {
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
            projects: [{ id: "api", name: "API" }],
            sessions: [
              sessionsPayload().sessions[0],
              {
                ...sessionsPayload().sessions[0],
                id: "api-done-1",
                prompt: "Ship auth",
                status: "completed",
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
      expect(screen.getByRole("link", { name: "Fix auth" })).toBeInTheDocument();
    });

    expect(screen.queryByRole("link", { name: "Ship auth" })).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /Completed/i }));

    await waitFor(() => {
      expect(screen.getByRole("link", { name: "Ship auth" })).toBeInTheDocument();
    });
    expect(screen.queryByRole("link", { name: "Fix auth" })).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /Completed/i }));

    await waitFor(() => {
      expect(screen.getByRole("link", { name: "Fix auth" })).toBeInTheDocument();
    });
    expect(screen.queryByRole("link", { name: "Ship auth" })).not.toBeInTheDocument();
  });

  it("shows stopped sessions in a dedicated Stopped category", async () => {
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
            projects: [{ id: "api", name: "API" }],
            sessions: [
              {
                ...sessionsPayload().sessions[0],
                id: "api-stopped-1",
                prompt: "Manual stop",
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
      expect(screen.getAllByText("Stopped")[0]).toBeInTheDocument();
      expect(screen.getByRole("link", { name: "Manual stop" })).toBeInTheDocument();
    });
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
            projects: [{ id: "api", name: "API" }],
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
            projects: [{ id: "api", name: "API" }],
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

  it("routes crashed non-terminal sessions into Stopped instead of Needs Input", async () => {
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
            projects: [{ id: "api", name: "API" }],
            sessions: [
              {
                ...sessionsPayload().sessions[0],
                id: "api-crashed-1",
                prompt: "Crashed run",
                status: "running",
                state: "working",
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
      expect(within(header).getByRole("button", { name: /Needs Input/i })).toHaveTextContent("0");
      expect(screen.getByRole("link", { name: "Crashed run" })).toBeInTheDocument();
    });
  });

  it("keeps completed-only dashboards neutral until Completed is selected", async () => {
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
            projects: [{ id: "api", name: "API" }],
            sessions: [
              {
                ...sessionsPayload().sessions[0],
                id: "api-done-only",
                prompt: "Already finished",
                status: "completed",
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
      expect(screen.getByText("No current sessions are visible.")).toBeInTheDocument();
    });
    expect(screen.queryByText(/Toggle Completed/i)).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /Completed/i }));

    await waitFor(() => {
      expect(screen.getByRole("link", { name: "Already finished" })).toBeInTheDocument();
    });
  });

  it("colors Completed stats only when the completed filter is active with results", async () => {
    vi.spyOn(global, "fetch").mockImplementation(async (input) => {
      const url = typeof input === "string" ? input : input.url;
      if (url === "/api/runtime/resources")
        return new Response(JSON.stringify({ available: false }));
      if (url === "/api/runtime/voice")
        return new Response(JSON.stringify({ available: false, modelPath: "", language: "" }));
      if (url === "/api/sessions") {
        return new Response(
          JSON.stringify({
            projects: [{ id: "api", name: "API" }],
            sessions: [
              sessionsPayload().sessions[0],
              {
                ...sessionsPayload().sessions[0],
                id: "api-done-2",
                prompt: "Ship stats",
                status: "completed",
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
      expect(screen.getByRole("button", { name: /Completed/i })).toHaveTextContent("1");
    });

    const completedButton = screen.getByRole("button", { name: /Completed/i });
    expect(within(completedButton).getByText("1").getAttribute("style")).toBeFalsy();

    fireEvent.click(completedButton);

    await waitFor(() => {
      expect(
        within(screen.getByRole("button", { name: /Completed/i }))
          .getByText("1")
          .getAttribute("style"),
      ).toContain("var(--color-status-ready)");
    });

    fireEvent.click(screen.getByRole("button", { name: /Completed/i }));

    await waitFor(() => {
      expect(
        within(screen.getByRole("button", { name: /Completed/i }))
          .getByText("1")
          .getAttribute("style"),
      ).toBeFalsy();
    });
  });

  it("keeps Completed stats neutral when active but empty", async () => {
    vi.spyOn(global, "fetch").mockImplementation(async (input) => {
      const url = typeof input === "string" ? input : input.url;
      if (url === "/api/runtime/resources")
        return new Response(JSON.stringify({ available: false }));
      if (url === "/api/runtime/voice")
        return new Response(JSON.stringify({ available: false, modelPath: "", language: "" }));
      if (url === "/api/sessions") {
        return new Response(
          JSON.stringify({
            projects: [{ id: "api", name: "API" }],
            sessions: [sessionsPayload().sessions[0]],
          }),
          { status: 200 },
        );
      }
      throw new Error(`Unexpected fetch: ${url}`);
    });

    render(<Dashboard />);

    const completedButton = await screen.findByRole("button", { name: /Completed/i });
    fireEvent.click(completedButton);

    await waitFor(() => {
      expect(
        within(screen.getByRole("button", { name: /Completed/i }))
          .getByText("0")
          .getAttribute("style"),
      ).toBeFalsy();
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
            projects: [{ id: "api", name: "API" }],
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
            sessions: [{ ...sessionsPayload().sessions[0], runtimeAlive: false }],
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

  it("shows all projects (configured and discovered) in both filter and spawn", async () => {
    const sessionsData = {
      projects: [{ id: "sp", name: "Spur Core" }],
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
    expect(within(filterSelect).getByRole("option", { name: "spur-local" })).toBeInTheDocument();
    expect(within(filterSelect).getByRole("option", { name: "Spur Core" })).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Spawn Session" }));
    const spawnProjectSelect = screen.getByRole("combobox", { name: "Spawn project" });
    expect(
      within(spawnProjectSelect).getByRole("option", { name: "spur-local" }),
    ).toBeInTheDocument();
    expect(
      within(spawnProjectSelect).getByRole("option", { name: "Spur Core" }),
    ).toBeInTheDocument();
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

  it("shows an add-image picker inside the spawn prompt and accepts files from it", async () => {
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
    expect(screen.getByRole("button", { name: "Add image" })).toBeInTheDocument();

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
    fireEvent.click(screen.getByRole("menuitem", { name: /\/compact/i }));

    expect(screen.getByPlaceholderText(SPAWN_PROMPT_PLACEHOLDER)).toHaveValue("/compact");
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
        { id: "api", name: "API" },
        { id: "sp", name: "Spur Core" },
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
        { id: "api", name: "API" },
        { id: "sp", name: "Spur Core" },
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
        { id: "api", name: "API" },
        { id: "sp", name: "Spur Core" },
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
        { id: "api", name: "API" },
        { id: "sp", name: "Spur Core" },
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
    fireEvent.click(screen.getByRole("checkbox"));
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
    expect(screen.getByRole("checkbox")).not.toBeChecked();
    expect(screen.queryByLabelText("step 1")).not.toBeInTheDocument();
  });

  it("keeps a matching project filter and URL unchanged while showing the new placeholder", async () => {
    window.history.replaceState(null, "", "/?project=api");
    const sessionsData = {
      projects: [
        { id: "api", name: "API" },
        { id: "sp", name: "Spur Core" },
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
        { id: "api", name: "API" },
        { id: "sp", name: "Spur Core" },
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

  it("uses the decoded session id as the session page title", async () => {
    const metadata = await generateSessionMetadata({
      params: Promise.resolve({ id: "feature%2Ftest-123" }),
    });

    expect(metadata.title).toBe("feature/test-123");
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
          JSON.stringify(github ?? { ok: true, requestedAt: "2026-04-28T10:00:00.000Z" }),
        );
      }
      if (url === "/api/gitlab-status") {
        return new Response(
          JSON.stringify(gitlab ?? { ok: true, requestedAt: "2026-04-28T10:00:00.000Z" }),
        );
      }
      throw new Error(`Unexpected fetch: ${url}`);
    });
  }

  it("renders build version without hydration mismatch", () => {
    const html = renderToString(<StatusBar />);
    expect(html).toContain("dev");
  });

  it("renders resource metrics when runtime resources are available", async () => {
    mockStatusBarFetch({
      resources: {
        available: true,
        daemonAlive: true,
        cpuPercent: 12,
        memoryPercent: 34,
        diskPercent: 56,
      },
    });

    render(<StatusBar />);

    await waitFor(() => {
      expect(
        screen.getByRole("button", { name: "Show aggregated system status" }),
      ).toHaveTextContent("Healthy");
    });

    fireEvent.click(screen.getByRole("button", { name: "Show aggregated system status" }));

    expect(screen.getByText("System")).toBeInTheDocument();
    expect(screen.getByLabelText("Daemon online healthy")).toBeInTheDocument();
    expect(screen.getByLabelText("CPU 12% healthy")).toBeInTheDocument();
    expect(screen.getByLabelText("RAM 34% healthy")).toBeInTheDocument();
    expect(screen.getByLabelText("HDD 56% healthy")).toBeInTheDocument();
  });

  it("hides resource metrics when runtime resources are unavailable", async () => {
    mockStatusBarFetch({
      resources: { available: false, daemonAlive: true },
    });

    render(<StatusBar />);

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
        daemonAlive: true,
        cpuPercent: 88,
        memoryPercent: 86,
        diskPercent: 91,
      },
    });

    render(<StatusBar />);

    await waitFor(() => {
      expect(
        screen.getByRole("button", { name: "Show aggregated system status" }),
      ).toHaveTextContent("Critical");
    });

    fireEvent.click(screen.getByRole("button", { name: "Show aggregated system status" }));

    expect(screen.getAllByText("Critical")).toHaveLength(2);
    expect(screen.getByLabelText("CPU 88% warning")).toBeInTheDocument();
    expect(screen.getByLabelText("RAM 86% warning")).toBeInTheDocument();
    expect(screen.getByLabelText("HDD 91% critical")).toBeInTheDocument();
  });

  it("syncs warning status text in the footer and closes the tooltip when its content is clicked", async () => {
    mockStatusBarFetch({
      resources: {
        available: true,
        daemonAlive: true,
        cpuPercent: 86,
        memoryPercent: 48,
        diskPercent: 41,
      },
    });

    render(<StatusBar />);

    await waitFor(() => {
      expect(
        screen.getByRole("button", { name: "Show aggregated system status" }),
      ).toHaveTextContent("Warning");
    });

    fireEvent.click(screen.getByRole("button", { name: "Show aggregated system status" }));

    const tooltipHeader = screen.getByText("System").closest("div");
    expect(tooltipHeader).not.toBeNull();
    expect(within(tooltipHeader!).getByText("Warning")).toBeInTheDocument();

    fireEvent.click(tooltipHeader!);

    expect(screen.queryByText("System")).not.toBeInTheDocument();
  });

  it("shows a healthy GitHub footer tooltip with the last request timestamp", async () => {
    mockStatusBarFetch({
      resources: { available: false, daemonAlive: true },
      github: { ok: true, requestedAt: "2026-04-28T10:00:00.000Z" },
    });

    render(<StatusBar />);

    const githubStatus = await screen.findByLabelText("GitHub connection healthy");
    fireEvent.mouseEnter(githubStatus);

    expect(screen.getByText("GitHub")).toBeInTheDocument();
    expect(screen.getAllByText("Healthy")).toHaveLength(2);
    expect(screen.getByText(/Last request:/)).toBeInTheDocument();
  });

  it("shows a healthy GitLab footer tooltip with the last request timestamp", async () => {
    mockStatusBarFetch({
      resources: { available: false, daemonAlive: true },
      gitlab: { ok: true, requestedAt: "2026-04-28T10:00:00.000Z" },
    });

    render(<StatusBar />);

    const gitlabStatus = await screen.findByLabelText("GitLab connection healthy");
    fireEvent.mouseEnter(gitlabStatus);

    expect(screen.getByText("GitLab")).toBeInTheDocument();
    expect(screen.getByText(/Last request:/)).toBeInTheDocument();
  });

  it("keeps the healthy GitHub tooltip open when the icon is clicked and closes it on the next click", async () => {
    mockStatusBarFetch({
      resources: { available: false, daemonAlive: true },
      github: { ok: true, requestedAt: "2026-04-28T10:00:00.000Z" },
    });

    render(<StatusBar />);

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
      resources: { available: false, daemonAlive: true },
    });

    render(<StatusBar />);

    const githubStatus = await screen.findByLabelText("GitHub connection healthy");
    const gitlabStatus = await screen.findByLabelText("GitLab connection healthy");
    expect(githubStatus).not.toHaveTextContent(/healthy|warning|critical|checking|error/i);
    expect(gitlabStatus).not.toHaveTextContent(/healthy|warning|critical|checking|error/i);
  });

  it("shows the temporary checking state inside the GitHub tooltip before the request resolves", async () => {
    vi.spyOn(global, "fetch").mockImplementation(async (input) => {
      const url = typeof input === "string" ? input : input.url;
      if (url === "/api/runtime/resources") {
        return new Response(JSON.stringify({ available: false, daemonAlive: true }));
      }
      if (url === "/api/github-status") {
        return new Promise<Response>(() => {});
      }
      if (url === "/api/gitlab-status") {
        return new Response(JSON.stringify({ ok: true, requestedAt: "2026-04-28T10:00:00.000Z" }));
      }
      throw new Error(`Unexpected fetch: ${url}`);
    });

    render(<StatusBar />);

    const githubStatus = screen.getByLabelText("GitHub connection checking");
    fireEvent.mouseEnter(githubStatus);
    expect(screen.getByText("Checking")).toBeInTheDocument();
  });

  it("shows the GitHub error text in the tooltip when the health check fails", async () => {
    mockStatusBarFetch({
      resources: { available: false, daemonAlive: true },
      github: { ok: false, error: "GitHub API 503", requestedAt: "2026-04-28T10:00:00.000Z" },
    });

    render(<StatusBar />);

    const githubStatus = await screen.findByLabelText("GitHub connection error");
    fireEvent.click(githubStatus);
    expect(screen.getByText("GitHub API 503")).toBeInTheDocument();
  });

  it("shows a synthesized GitHub error in the tooltip when the endpoint returns a non-200 response", async () => {
    vi.spyOn(global, "fetch").mockImplementation(async (input) => {
      const url = typeof input === "string" ? input : input.url;
      if (url === "/api/runtime/resources") {
        return new Response(JSON.stringify({ available: false, daemonAlive: true }));
      }
      if (url === "/api/github-status") {
        return new Response(JSON.stringify({ error: "upstream unavailable" }), { status: 503 });
      }
      if (url === "/api/gitlab-status") {
        return new Response(JSON.stringify({ ok: true, requestedAt: "2026-04-28T10:00:00.000Z" }));
      }
      throw new Error(`Unexpected fetch: ${url}`);
    });

    render(<StatusBar />);

    const githubStatus = await screen.findByLabelText("GitHub connection error");
    fireEvent.click(githubStatus);
    expect(screen.getByText("GitHub status unavailable (503)")).toBeInTheDocument();
  });
});
