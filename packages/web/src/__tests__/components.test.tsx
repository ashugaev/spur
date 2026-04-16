import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { renderToString } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { Dashboard } from "@/components/Dashboard";
import { StatusBar } from "@/components/StatusBar";
import manifest from "@/app/manifest";
import { generateMetadata } from "@/app/layout";

vi.mock("next/font/google", () => ({
  JetBrains_Mono: () => ({ variable: "--font-jetbrains-mono" }),
}));

vi.mock("@/components/DirectTerminal", () => ({
  DirectTerminal: ({
    label,
    onClose,
    sessionId,
  }: {
    label?: string;
    onClose?: () => void;
    sessionId: string;
  }) => (
    <div>
      <div>{`Direct terminal ${label ?? sessionId}`}</div>
      <button onClick={onClose} type="button">
        Close terminal
      </button>
    </div>
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

const SPAWN_PROMPT_PLACEHOLDER = "Prompt for the new session...";

describe("Dashboard", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    window.localStorage.clear();
    window.history.replaceState(null, "", "/");
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
      expect(screen.getByRole("heading", { name: "All Projects" })).toBeInTheDocument();
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

  it("loads the initial project filter from query params before the first fetch", async () => {
    window.history.replaceState(null, "", "/?project=api");
    const fetchMock = vi.spyOn(global, "fetch").mockImplementation(async (input) => {
      const url = typeof input === "string" ? input : input.url;
      if (url === "/api/runtime/resources")
        return new Response(JSON.stringify({ available: false }));
      if (url === "/api/runtime/voice") {
        return new Response(JSON.stringify({ available: false, modelPath: "", language: "" }));
      }
      if (url === "/api/sessions?project=api") {
        return new Response(JSON.stringify(sessionsPayload()), { status: 200 });
      }
      throw new Error(`Unexpected fetch: ${url}`);
    });

    render(<Dashboard />);

    await waitFor(() => {
      expect(screen.getByRole("heading", { name: "API" })).toBeInTheDocument();
    });

    expect(fetchMock).toHaveBeenCalledWith("/api/sessions?project=api", { cache: "no-store" });
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
      if (url === "/api/sessions?project=api") {
        return new Response(JSON.stringify(sessionsPayload()), { status: 200 });
      }
      throw new Error(`Unexpected fetch: ${url}`);
    });

    render(<Dashboard />);

    const sessionLink = await screen.findByRole("link", { name: "Fix auth" });
    expect(sessionLink).toHaveAttribute("href", "/sessions/api-a1?project=api");
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

    const filterSelect = screen.getByRole("combobox");
    expect(within(filterSelect).getByRole("option", { name: "spur-local" })).toBeInTheDocument();
    expect(within(filterSelect).getByRole("option", { name: "Spur Core" })).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Spawn Session" }));
    const spawnSelects = screen.getAllByRole("combobox");
    const spawnProjectSelect = spawnSelects[1];
    expect(
      within(spawnProjectSelect).getByRole("option", { name: "spur-local" }),
    ).toBeInTheDocument();
    expect(
      within(spawnProjectSelect).getByRole("option", { name: "Spur Core" }),
    ).toBeInTheDocument();
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
    fireEvent.change(screen.getAllByRole("combobox")[1], {
      target: { value: "api" },
    });

    const spawnButton = screen.getByRole("button", { name: "Spawn" });
    expect(spawnButton).toBeEnabled();
    expect(screen.getByPlaceholderText(SPAWN_PROMPT_PLACEHOLDER)).toBeInTheDocument();
    expect(screen.getByText("CMD + ⏎")).toBeInTheDocument();
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

  it.each([
    {
      label: "Ctrl+Enter",
      prompt: "Ship hotkey",
      keydown: { key: "Enter", ctrlKey: true },
    },
    {
      label: "Cmd+Enter",
      prompt: "Ship cmd hotkey",
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
        if (url === "/api/sessions?project=api")
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
      fireEvent.change(screen.getAllByRole("combobox")[1], { target: { value: "api" } });
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
    fireEvent.change(screen.getAllByRole("combobox")[1], { target: { value: "api" } });
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

    fireEvent.change(screen.getByRole("combobox"), { target: { value: "sp" } });
    fireEvent.click(screen.getByRole("button", { name: "Spawn Session" }));

    const spawnProjectSelect = screen.getAllByRole("combobox")[1] as HTMLSelectElement;
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

    fireEvent.change(screen.getByRole("combobox"), { target: { value: "sp" } });
    fireEvent.click(screen.getByRole("button", { name: "Spawn Session" }));

    const spawnProjectSelect = screen.getAllByRole("combobox")[1] as HTMLSelectElement;
    fireEvent.change(spawnProjectSelect, { target: { value: "api" } });

    expect((screen.getAllByRole("combobox")[1] as HTMLSelectElement).value).toBe("api");
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
    expect(screen.getByRole("heading", { name: "All Projects" })).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Spawn Session" }));
    let spawnProjectSelect = screen.getAllByRole("combobox")[1] as HTMLSelectElement;
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
    spawnProjectSelect = screen.getAllByRole("combobox")[1] as HTMLSelectElement;
    expect(spawnProjectSelect.value).toBe("api");
  });

  it("persists selected spawn project on change and successful spawn", async () => {
    const sessionsData = {
      projects: [
        { id: "api", name: "API" },
        { id: "sp", name: "Spur Core" },
      ],
      sessions: [sessionsPayload().sessions[0]],
    };
    vi.spyOn(global, "fetch").mockImplementation(async (input, init) => {
      const url = typeof input === "string" ? input : input.url;
      if (url === "/api/runtime/resources")
        return new Response(JSON.stringify({ available: false }));
      if (url === "/api/runtime/voice")
        return new Response(JSON.stringify({ available: false, modelPath: "", language: "" }));
      if (url === "/api/spawn") return new Response("ok", { status: 200 });
      if (url === "/api/sessions?project=sp")
        return new Response(JSON.stringify({ ...sessionsData, sessions: [] }), { status: 200 });
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
    const spawnProjectSelect = screen.getAllByRole("combobox")[1];
    fireEvent.change(spawnProjectSelect, { target: { value: "sp" } });
    expect(window.localStorage.getItem("spur:last-spawn-project")).toBe("sp");

    fireEvent.change(screen.getByPlaceholderText(SPAWN_PROMPT_PLACEHOLDER), {
      target: { value: "Ship it" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Spawn" }));

    await waitFor(() => {
      expect(window.localStorage.getItem("spur:last-spawn-project")).toBe("sp");
      expect(screen.queryByPlaceholderText(SPAWN_PROMPT_PLACEHOLDER)).not.toBeInTheDocument();
    });
  });

  it("exposes install metadata for PWA installability", async () => {
    const metadata = await generateMetadata();
    const appManifest = manifest();

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
      background_color: "#0D0D0E",
      theme_color: "#0D0D0E",
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
});

describe("StatusBar", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("renders build version without hydration mismatch", () => {
    const html = renderToString(<StatusBar sessions={[]} />);
    expect(html).toContain("dev");
  });

  it("renders resource metrics when runtime resources are available", async () => {
    vi.spyOn(global, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({
          available: true,
          daemonAlive: true,
          cpuPercent: 12,
          memoryPercent: 34,
          diskPercent: 56,
        }),
      ),
    );

    render(<StatusBar sessions={[]} />);

    await waitFor(() => {
      expect(
        screen.getByRole("button", { name: "Show aggregated healthy status" }),
      ).toBeInTheDocument();
    });

    fireEvent.click(screen.getByRole("button", { name: "Show aggregated healthy status" }));

    expect(
      screen.getByRole("button", { name: "Show aggregated healthy status" }),
    ).toHaveTextContent("healthy");
    expect(screen.getByText("System")).toBeInTheDocument();
    expect(screen.getByLabelText("Daemon online healthy")).toBeInTheDocument();
    expect(screen.getByLabelText("CPU 12% healthy")).toBeInTheDocument();
    expect(screen.getByLabelText("RAM 34% healthy")).toBeInTheDocument();
    expect(screen.getByLabelText("HDD 56% healthy")).toBeInTheDocument();
  });

  it("hides resource metrics when runtime resources are unavailable", async () => {
    vi.spyOn(global, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ available: false, daemonAlive: true })),
    );

    render(<StatusBar sessions={[]} />);

    await waitFor(() => {
      expect(screen.queryByText(/CPU \d+%/)).not.toBeInTheDocument();
      expect(screen.queryByText(/RAM \d+%/)).not.toBeInTheDocument();
      expect(screen.queryByText(/DISK \d+%/)).not.toBeInTheDocument();
    });

    fireEvent.click(screen.getByRole("button", { name: "Show aggregated unavailable status" }));

    expect(
      screen.getByRole("button", { name: "Show aggregated unavailable status" }),
    ).toHaveTextContent("unavailable");
    expect(screen.getByLabelText("Daemon online healthy")).toBeInTheDocument();
    expect(screen.getByLabelText("CPU unavailable unavailable")).toBeInTheDocument();
    expect(screen.getByLabelText("RAM unavailable unavailable")).toBeInTheDocument();
    expect(screen.getByLabelText("HDD unavailable unavailable")).toBeInTheDocument();
  });

  it("shows warning and error states in the online tooltip", async () => {
    vi.spyOn(global, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({
          available: true,
          daemonAlive: true,
          cpuPercent: 88,
          memoryPercent: 86,
          diskPercent: 91,
        }),
      ),
    );

    render(<StatusBar sessions={[]} />);

    await waitFor(() => {
      expect(
        screen.getByRole("button", { name: "Show aggregated critical status" }),
      ).toHaveAttribute("aria-expanded", "false");
    });

    fireEvent.click(screen.getByRole("button", { name: "Show aggregated critical status" }));

    expect(
      screen.getByRole("button", { name: "Show aggregated critical status" }),
    ).toHaveTextContent("critical");
    expect(screen.getAllByText("critical")).toHaveLength(2);
    expect(screen.getByLabelText("CPU 88% warning")).toBeInTheDocument();
    expect(screen.getByLabelText("RAM 86% warning")).toBeInTheDocument();
    expect(screen.getByLabelText("HDD 91% critical")).toBeInTheDocument();
  });

  it("shows warning status when cpu or memory crosses the attention threshold", async () => {
    vi.spyOn(global, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({
          available: true,
          daemonAlive: true,
          cpuPercent: 88,
          memoryPercent: 34,
          diskPercent: 56,
        }),
      ),
    );

    render(<StatusBar sessions={[]} />);

    const onlineButton = await screen.findByRole("button", {
      name: "Show aggregated warning status",
    });
    expect(onlineButton).toHaveTextContent("warning");

    fireEvent.click(onlineButton);
    expect(screen.getAllByText("warning")).toHaveLength(2);
    expect(screen.getByLabelText("CPU 88% warning")).toBeInTheDocument();
    expect(screen.getByLabelText("HDD 56% healthy")).toBeInTheDocument();
  });

  it("closes the online tooltip when clicking inside popup content", async () => {
    vi.spyOn(global, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({
          available: true,
          daemonAlive: true,
          cpuPercent: 12,
          memoryPercent: 34,
          diskPercent: 56,
        }),
      ),
    );

    render(<StatusBar sessions={[]} />);

    const onlineButton = await screen.findByRole("button", {
      name: "Show aggregated healthy status",
    });
    fireEvent.click(onlineButton);
    expect(screen.getByText("System")).toBeInTheDocument();

    fireEvent.click(screen.getByText("System"));
    expect(screen.queryByText("System")).not.toBeInTheDocument();
  });

  it("opens on hover and closes on mouse leave", async () => {
    vi.spyOn(global, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({
          available: true,
          daemonAlive: true,
          cpuPercent: 12,
          memoryPercent: 34,
          diskPercent: 56,
        }),
      ),
    );

    render(<StatusBar sessions={[]} />);

    const onlineButton = await screen.findByRole("button", {
      name: "Show aggregated healthy status",
    });
    fireEvent.mouseEnter(onlineButton);
    expect(screen.getByText("System")).toBeInTheDocument();

    fireEvent.mouseLeave(onlineButton);
    expect(screen.queryByText("System")).not.toBeInTheDocument();
  });

  it("closes the online tooltip on blur after opening", async () => {
    vi.spyOn(global, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({
          available: true,
          daemonAlive: true,
          cpuPercent: 12,
          memoryPercent: 34,
          diskPercent: 56,
        }),
      ),
    );

    render(<StatusBar sessions={[]} />);

    const onlineButton = await screen.findByRole("button", {
      name: "Show aggregated healthy status",
    });
    fireEvent.click(onlineButton);
    expect(screen.getByText("System")).toBeInTheDocument();

    fireEvent.blur(onlineButton, { relatedTarget: null });
    expect(screen.queryByText("System")).not.toBeInTheDocument();
  });

  it("shows critical status when the daemon is offline", async () => {
    vi.spyOn(global, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ available: false, daemonAlive: false })),
    );

    render(<StatusBar sessions={[]} />);

    const onlineButton = await screen.findByRole("button", {
      name: "Show aggregated critical status",
    });
    expect(onlineButton).toHaveTextContent("critical");

    fireEvent.click(onlineButton);
    expect(screen.getByLabelText("Daemon offline critical")).toBeInTheDocument();
    expect(screen.getByLabelText("CPU unavailable unavailable")).toBeInTheDocument();
  });
});
