import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { SessionDetail } from "@/components/SessionDetail";

const pushMock = vi.fn();
const replaceMock = vi.fn();
const backMock = vi.fn();

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: pushMock, replace: replaceMock, back: backMock }),
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

  protected emit(type: string, data?: Blob) {
    for (const listener of this.listeners.get(type) ?? []) {
      listener(data ? { data } : undefined);
    }
  }
}

class EmptyAudioMediaRecorder extends MockMediaRecorder {
  override stop() {
    this.state = "inactive";
    this.emit("stop");
  }
}

function sessionFixture() {
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
    queuedMessages: {
      messages: [],
      awaitingPrompt: false,
    },
    slots: {
      links: [],
    },
  };
}

function conversationFixture(
  overrides?: Partial<{
    messages: Array<{ role: "user" | "assistant"; text: string; timestampMs: number }>;
    durationMs: number;
    state: "working" | "waiting" | "needs_input" | "stopped" | "error" | "killed";
  }>,
) {
  return {
    messages: [
      { role: "user" as const, text: "Original prompt", timestampMs: 1 },
      { role: "assistant" as const, text: "First reply", timestampMs: 2 },
    ],
    durationMs: 60_000,
    state: "waiting" as const,
    ...overrides,
  };
}

describe("SessionDetail voice input", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    pushMock.mockReset();
    replaceMock.mockReset();
    backMock.mockReset();
    window.localStorage.clear();
    window.history.replaceState(null, "", "/sessions/api-a1");
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

  it("records audio, inserts transcribed text directly into textarea without sending", async () => {
    const fetchMock = vi.spyOn(global, "fetch").mockImplementation(async (input, init) => {
      const url = typeof input === "string" ? input : input.url;

      if (url === "/api/sessions/api-a1") {
        return new Response(JSON.stringify(sessionFixture()), { status: 200 });
      }

      if (url === "/api/runtime/voice") {
        return new Response(
          JSON.stringify({ available: true, modelPath: "/models/ggml-base.en.bin" }),
          { status: 200 },
        );
      }

      if (url === "/api/runtime/voice/transcribe" && init?.method === "POST") {
        return new Response(JSON.stringify({ text: "Fix the flaky tests before release" }), {
          status: 200,
        });
      }

      throw new Error(`Unexpected fetch: ${url}`);
    });

    render(<SessionDetail sessionId="api-a1" />);

    await waitFor(() => {
      expect(screen.getByPlaceholderText("Message to the running agent...")).toBeInTheDocument();
      expect(screen.getByRole("button", { name: "Start voice recording" })).toBeInTheDocument();
    });

    fireEvent.click(screen.getByRole("button", { name: "Start voice recording" }));

    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Stop voice recording" })).toBeInTheDocument();
    });

    fireEvent.click(screen.getByRole("button", { name: "Stop voice recording" }));

    await waitFor(() => {
      expect(screen.getByDisplayValue("Fix the flaky tests before release")).toBeInTheDocument();
    });

    expect(screen.queryByRole("dialog", { name: "Confirm voice input" })).not.toBeInTheDocument();

    expect(fetchMock).toHaveBeenCalledWith(
      "/api/runtime/voice/transcribe",
      expect.objectContaining({ method: "POST" }),
    );
    expect(fetchMock).not.toHaveBeenCalledWith("/api/sessions/api-a1/send", expect.anything());
  });

  it("shows an inline error when stopping recording yields no audio", async () => {
    vi.stubGlobal("MediaRecorder", EmptyAudioMediaRecorder as unknown as typeof MediaRecorder);
    const fetchMock = vi.spyOn(global, "fetch").mockImplementation(async (input) => {
      const url = typeof input === "string" ? input : input.url;

      if (url === "/api/sessions/api-a1") {
        return new Response(JSON.stringify(sessionFixture()), { status: 200 });
      }

      if (url === "/api/runtime/voice") {
        return new Response(
          JSON.stringify({ available: true, modelPath: "/models/ggml-base.en.bin" }),
          { status: 200 },
        );
      }

      throw new Error(`Unexpected fetch: ${url}`);
    });

    render(<SessionDetail sessionId="api-a1" />);

    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Start voice recording" })).toBeInTheDocument();
    });

    fireEvent.click(screen.getByRole("button", { name: "Start voice recording" }));
    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Stop voice recording" })).toBeInTheDocument();
    });

    fireEvent.click(screen.getByRole("button", { name: "Stop voice recording" }));

    await waitFor(() => {
      expect(
        screen.getByText(
          "Voice recording captured no audio. Check your microphone input and try again.",
        ),
      ).toBeInTheDocument();
    });

    expect(fetchMock).not.toHaveBeenCalledWith("/api/runtime/voice/transcribe", expect.anything());
  });

  it("shows the final transcribe retry error instead of a raw JSON blob", async () => {
    vi.spyOn(global, "fetch").mockImplementation(async (input, init) => {
      const url = typeof input === "string" ? input : input.url;

      if (url === "/api/sessions/api-a1") {
        return new Response(JSON.stringify(sessionFixture()), { status: 200 });
      }

      if (url === "/api/runtime/voice") {
        return new Response(
          JSON.stringify({ available: true, modelPath: "/models/ggml-base.en.bin" }),
          { status: 200 },
        );
      }

      if (url === "/api/runtime/voice/transcribe" && init?.method === "POST") {
        return new Response(JSON.stringify({ error: "Voice API unavailable" }), { status: 502 });
      }

      throw new Error(`Unexpected fetch: ${url}`);
    });

    render(<SessionDetail sessionId="api-a1" />);

    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Start voice recording" })).toBeInTheDocument();
    });

    fireEvent.click(screen.getByRole("button", { name: "Start voice recording" }));
    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Stop voice recording" })).toBeInTheDocument();
    });

    fireEvent.click(screen.getByRole("button", { name: "Stop voice recording" }));

    await waitFor(
      () => {
        expect(
          screen.getByText("Failed to transcribe audio after 3 attempts: Voice API unavailable"),
        ).toBeInTheDocument();
      },
      { timeout: 3_000 },
    );
    expect(screen.queryByText('{"error":"Voice API unavailable"}')).not.toBeInTheDocument();
  });

  it("retries transcription failures before succeeding", async () => {
    let transcribeCalls = 0;
    vi.spyOn(global, "fetch").mockImplementation(async (input, init) => {
      const url = typeof input === "string" ? input : input.url;

      if (url === "/api/sessions/api-a1") {
        return new Response(JSON.stringify(sessionFixture()), { status: 200 });
      }
      if (url === "/api/sessions/api-a1/conversation") {
        return new Response("not found", { status: 404 });
      }
      if (url === "/api/runtime/voice") {
        return new Response(
          JSON.stringify({ available: true, modelPath: "/models/ggml-base.en.bin" }),
          { status: 200 },
        );
      }
      if (url === "/api/runtime/voice/transcribe" && init?.method === "POST") {
        transcribeCalls += 1;
        if (transcribeCalls < 3) {
          return new Response(JSON.stringify({ error: "Voice API unavailable" }), { status: 502 });
        }
        return new Response(JSON.stringify({ text: "Recovered transcript" }), { status: 200 });
      }

      throw new Error(`Unexpected fetch: ${url}`);
    });

    render(<SessionDetail sessionId="api-a1" />);

    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Start voice recording" })).toBeInTheDocument();
    });

    fireEvent.click(screen.getByRole("button", { name: "Start voice recording" }));
    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Stop voice recording" })).toBeInTheDocument();
    });
    fireEvent.click(screen.getByRole("button", { name: "Stop voice recording" }));

    await waitFor(
      () => {
        expect(screen.getByDisplayValue("Recovered transcript")).toBeInTheDocument();
      },
      { timeout: 3_000 },
    );
    expect(transcribeCalls).toBe(3);
  });

  it("shows the final retry error after exhausting transcription attempts", async () => {
    vi.spyOn(global, "fetch").mockImplementation(async (input, init) => {
      const url = typeof input === "string" ? input : input.url;

      if (url === "/api/sessions/api-a1") {
        return new Response(JSON.stringify(sessionFixture()), { status: 200 });
      }
      if (url === "/api/sessions/api-a1/conversation") {
        return new Response("not found", { status: 404 });
      }
      if (url === "/api/runtime/voice") {
        return new Response(
          JSON.stringify({ available: true, modelPath: "/models/ggml-base.en.bin" }),
          { status: 200 },
        );
      }
      if (url === "/api/runtime/voice/transcribe" && init?.method === "POST") {
        return new Response(JSON.stringify({ error: "Voice API unavailable" }), { status: 503 });
      }

      throw new Error(`Unexpected fetch: ${url}`);
    });

    render(<SessionDetail sessionId="api-a1" />);

    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Start voice recording" })).toBeInTheDocument();
    });

    fireEvent.click(screen.getByRole("button", { name: "Start voice recording" }));
    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Stop voice recording" })).toBeInTheDocument();
    });
    fireEvent.click(screen.getByRole("button", { name: "Stop voice recording" }));

    await waitFor(
      () => {
        expect(
          screen.getByText("Failed to transcribe audio after 3 attempts: Voice API unavailable"),
        ).toBeInTheDocument();
      },
      { timeout: 3_000 },
    );
  });

  it("stores sent messages in history after a successful send", async () => {
    vi.spyOn(global, "fetch").mockImplementation(async (input, init) => {
      const url = typeof input === "string" ? input : input.url;

      if (url === "/api/sessions/api-a1") {
        return new Response(JSON.stringify(sessionFixture()), { status: 200 });
      }
      if (url === "/api/sessions/api-a1/conversation") {
        return new Response("not found", { status: 404 });
      }
      if (url === "/api/runtime/voice") {
        return new Response(JSON.stringify({ available: false, language: "" }), { status: 200 });
      }
      if (url === "/api/sessions/api-a1/send" && init?.method === "POST") {
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      }

      throw new Error(`Unexpected fetch: ${url}`);
    });

    render(<SessionDetail sessionId="api-a1" />);

    await waitFor(() => {
      expect(screen.getByPlaceholderText("Message to the running agent...")).toBeInTheDocument();
    });

    fireEvent.change(screen.getByPlaceholderText("Message to the running agent..."), {
      target: { value: "Save this follow-up" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Send now" }));

    await waitFor(() => {
      expect(window.localStorage.getItem("spur:input-history:session-message")).toContain(
        "Save this follow-up",
      );
    });
  });

  it("shows a permission error instead of the raw browser getUserMedia message", async () => {
    Object.defineProperty(window, "isSecureContext", {
      configurable: true,
      value: true,
    });
    Object.defineProperty(navigator, "mediaDevices", {
      configurable: true,
      value: {
        getUserMedia: vi.fn().mockRejectedValue(
          Object.assign(
            new Error(
              "The request is not allowed by the user agent or the platform in the current context, possibly because the user denied permission.",
            ),
            {
              name: "NotAllowedError",
            },
          ),
        ),
      },
    });
    vi.spyOn(global, "fetch").mockImplementation(async (input) => {
      const url = typeof input === "string" ? input : input.url;

      if (url === "/api/sessions/api-a1") {
        return new Response(JSON.stringify(sessionFixture()), { status: 200 });
      }

      if (url === "/api/runtime/voice") {
        return new Response(
          JSON.stringify({ available: true, modelPath: "/models/ggml-base.en.bin" }),
          { status: 200 },
        );
      }

      throw new Error(`Unexpected fetch: ${url}`);
    });

    render(<SessionDetail sessionId="api-a1" />);

    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Start voice recording" })).toBeInTheDocument();
    });

    fireEvent.click(screen.getByRole("button", { name: "Start voice recording" }));

    await waitFor(() => {
      expect(
        screen.getByText(
          "Microphone access is blocked. Allow microphone permission in your browser and try again.",
        ),
      ).toBeInTheDocument();
    });
    expect(screen.getByRole("button", { name: "Start voice recording" })).toBeInTheDocument();
  });

  it("keeps the back link on the default dashboard route when no project query is present", async () => {
    vi.spyOn(global, "fetch").mockImplementation(async (input) => {
      const url = typeof input === "string" ? input : input.url;
      if (url === "/api/sessions/api-a1") {
        return new Response(JSON.stringify(sessionFixture()), { status: 200 });
      }
      if (url === "/api/runtime/voice") {
        return new Response(JSON.stringify({ available: false, modelPath: "" }), { status: 200 });
      }
      throw new Error(`Unexpected fetch: ${url}`);
    });

    render(<SessionDetail sessionId="api-a1" />);

    const backLink = await screen.findByRole("link", { name: "← Back" });
    expect(backLink).toHaveAttribute("href", "/");
  });

  it("preserves an explicit project query in the back link", async () => {
    vi.spyOn(global, "fetch").mockImplementation(async (input) => {
      const url = typeof input === "string" ? input : input.url;
      if (url === "/api/sessions/api-a1") {
        return new Response(JSON.stringify(sessionFixture()), { status: 200 });
      }
      if (url === "/api/runtime/voice") {
        return new Response(JSON.stringify({ available: false, modelPath: "" }), { status: 200 });
      }
      throw new Error(`Unexpected fetch: ${url}`);
    });

    render(<SessionDetail projectId="sp" sessionId="api-a1" />);

    const backLink = await screen.findByRole("link", { name: "← Back" });
    expect(backLink).toHaveAttribute("href", "/?project=sp");
  });

  it("respawns without forcing a project query when the detail page had none", async () => {
    vi.spyOn(global, "fetch").mockImplementation(async (input, init) => {
      const url = typeof input === "string" ? input : input.url;
      if (url === "/api/sessions/api-a1") {
        return new Response(
          JSON.stringify({
            ...sessionFixture(),
            status: "completed",
            runtimeAlive: false,
          }),
          { status: 200 },
        );
      }
      if (url === "/api/runtime/voice") {
        return new Response(JSON.stringify({ available: false, modelPath: "" }), { status: 200 });
      }
      if (url === "/api/sessions/api-a1/respawn" && init?.method === "POST") {
        return new Response(
          JSON.stringify({
            ...sessionFixture(),
            id: "api-b2",
          }),
          { status: 200 },
        );
      }
      throw new Error(`Unexpected fetch: ${url}`);
    });

    render(<SessionDetail sessionId="api-a1" />);

    const respawnButton = await screen.findByRole("button", { name: "Respawn" });
    fireEvent.click(respawnButton);

    await waitFor(() => {
      expect(pushMock).toHaveBeenCalledWith("/sessions/api-b2");
    });
  });

  it("syncs terminal modal with query params", async () => {
    const fetchMock = vi.spyOn(global, "fetch").mockImplementation(async (input) => {
      const url = typeof input === "string" ? input : input.url;
      if (url === "/api/sessions/api-a1") {
        return new Response(JSON.stringify(sessionFixture()), { status: 200 });
      }
      if (url === "/api/runtime/voice") {
        return new Response(JSON.stringify({ available: false, modelPath: "" }), { status: 200 });
      }
      throw new Error(`Unexpected fetch: ${url}`);
    });

    render(<SessionDetail sessionId="api-a1" />);
    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Terminal" })).toBeInTheDocument();
    });

    fireEvent.click(screen.getByRole("button", { name: "Terminal" }));
    await waitFor(() => {
      expect(screen.getByRole("dialog", { name: "Terminal api-a1" })).toBeInTheDocument();
    });
    expect(window.location.search).toContain("terminal=api-a1");

    fireEvent.click(screen.getByRole("button", { name: "Close terminal" }));
    await waitFor(() => {
      expect(screen.queryByRole("dialog", { name: "Terminal api-a1" })).not.toBeInTheDocument();
    });
    expect(window.location.search).not.toContain("terminal=");
    expect(fetchMock).toHaveBeenCalledWith("/api/sessions/api-a1", { cache: "no-store" });

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

  it("restores terminal from query params only when attachable", async () => {
    window.history.replaceState(null, "", "/sessions/api-a1?terminal=api-a1");
    vi.spyOn(global, "fetch").mockImplementation(async (input) => {
      const url = typeof input === "string" ? input : input.url;
      if (url === "/api/sessions/api-a1") {
        return new Response(JSON.stringify(sessionFixture()), { status: 200 });
      }
      if (url === "/api/runtime/voice") {
        return new Response(JSON.stringify({ available: false, modelPath: "" }), { status: 200 });
      }
      throw new Error(`Unexpected fetch: ${url}`);
    });

    render(<SessionDetail sessionId="api-a1" />);
    await waitFor(() => {
      expect(screen.getByRole("dialog", { name: "Terminal api-a1" })).toBeInTheDocument();
    });
  });

  it("ignores terminal query params when session is not attachable", async () => {
    window.history.replaceState(null, "", "/sessions/api-a1?terminal=api-a1");
    vi.spyOn(global, "fetch").mockImplementation(async (input) => {
      const url = typeof input === "string" ? input : input.url;
      if (url === "/api/sessions/api-a1") {
        return new Response(
          JSON.stringify({ ...sessionFixture(), runtimeAlive: false, tmuxSession: null }),
          { status: 200 },
        );
      }
      if (url === "/api/runtime/voice") {
        return new Response(JSON.stringify({ available: false, modelPath: "" }), { status: 200 });
      }
      throw new Error(`Unexpected fetch: ${url}`);
    });

    render(<SessionDetail sessionId="api-a1" />);
    await waitFor(() => {
      expect(screen.queryByRole("button", { name: "Terminal" })).not.toBeInTheDocument();
    });
    expect(screen.queryByRole("dialog", { name: "Terminal api-a1" })).not.toBeInTheDocument();
    await waitFor(() => {
      expect(window.location.search).not.toContain("terminal=");
    });
  });

  it("shows an open link for the isolated UI sidecar", async () => {
    vi.spyOn(global, "fetch").mockImplementation(async (input) => {
      const url = typeof input === "string" ? input : input.url;
      if (url === "/api/sessions/api-a1") {
        return new Response(
          JSON.stringify({
            ...sessionFixture(),
            sidecars: [{ name: "isolated-ui", alive: true }],
            slots: {
              links: [{ label: "sidecar-ui", url: "http://openclaw-dev.tail90e846.ts.net:5601" }],
            },
          }),
          { status: 200 },
        );
      }
      if (url === "/api/runtime/voice") {
        return new Response(JSON.stringify({ available: false, modelPath: "" }), { status: 200 });
      }
      throw new Error(`Unexpected fetch: ${url}`);
    });

    render(<SessionDetail sessionId="api-a1" />);

    await waitFor(() => {
      expect(screen.getByRole("link", { name: "Open" })).toHaveAttribute(
        "href",
        "http://openclaw-dev.tail90e846.ts.net:5601",
      );
    });
  });

  it("keeps the start or stop sidecar action at the far right of the sidecar actions", async () => {
    vi.spyOn(global, "fetch").mockImplementation(async (input) => {
      const url = typeof input === "string" ? input : input.url;
      if (url === "/api/sessions/api-a1") {
        return new Response(
          JSON.stringify({
            ...sessionFixture(),
            sidecars: [{ name: "isolated-ui", alive: true }],
            slots: {
              links: [{ label: "sidecar-ui", url: "http://openclaw-dev.tail90e846.ts.net:5601" }],
            },
          }),
          { status: 200 },
        );
      }
      if (url === "/api/runtime/voice") {
        return new Response(JSON.stringify({ available: false, modelPath: "" }), { status: 200 });
      }
      throw new Error(`Unexpected fetch: ${url}`);
    });

    render(<SessionDetail sessionId="api-a1" />);

    const sidecarName = await screen.findByText("isolated-ui");
    const sidecarRow = sidecarName.closest("div")?.parentElement;
    expect(sidecarRow).not.toBeNull();

    const actionNames = Array.from(sidecarRow?.querySelectorAll("a,button") ?? []).map(
      (node) => node.getAttribute("aria-label") ?? node.textContent?.trim() ?? "",
    );
    expect(actionNames).toEqual(["Terminal", "Open", "Stop sidecar isolated-ui"]);
  });

  it("starts an offline sidecar from the icon button", async () => {
    const fetchMock = vi.spyOn(global, "fetch").mockImplementation(async (input, init) => {
      const url = typeof input === "string" ? input : input.url;
      if (url === "/api/sessions/api-a1") {
        return new Response(
          JSON.stringify({
            ...sessionFixture(),
            sidecars: [{ name: "dev", alive: false }],
          }),
          { status: 200 },
        );
      }
      if (url === "/api/runtime/voice") {
        return new Response(JSON.stringify({ available: false, modelPath: "" }), { status: 200 });
      }
      if (url === "/api/sessions/api-a1/sidecars/dev/start" && init?.method === "POST") {
        return new Response(
          JSON.stringify({
            ...sessionFixture(),
            sidecars: [{ name: "dev", alive: true }],
          }),
          { status: 200 },
        );
      }
      throw new Error(`Unexpected fetch: ${url}`);
    });

    render(<SessionDetail sessionId="api-a1" />);

    const button = await screen.findByRole("button", { name: "Start sidecar dev" });
    fireEvent.click(button);

    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Stop sidecar dev" })).toBeInTheDocument();
    });
    expect(fetchMock).toHaveBeenCalledWith("/api/sessions/api-a1/sidecars/dev/start", {
      method: "POST",
    });
  });

  it("stops a live sidecar from the icon button", async () => {
    const fetchMock = vi.spyOn(global, "fetch").mockImplementation(async (input, init) => {
      const url = typeof input === "string" ? input : input.url;
      if (url === "/api/sessions/api-a1") {
        return new Response(
          JSON.stringify({
            ...sessionFixture(),
            sidecars: [{ name: "dev", alive: true }],
          }),
          { status: 200 },
        );
      }
      if (url === "/api/runtime/voice") {
        return new Response(JSON.stringify({ available: false, modelPath: "" }), { status: 200 });
      }
      if (url === "/api/sessions/api-a1/sidecars/dev/stop" && init?.method === "POST") {
        return new Response(
          JSON.stringify({
            ...sessionFixture(),
            sidecars: [{ name: "dev", alive: false }],
          }),
          { status: 200 },
        );
      }
      throw new Error(`Unexpected fetch: ${url}`);
    });

    render(<SessionDetail sessionId="api-a1" />);

    const button = await screen.findByRole("button", { name: "Stop sidecar dev" });
    fireEvent.click(button);

    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Start sidecar dev" })).toBeInTheDocument();
    });
    expect(fetchMock).toHaveBeenCalledWith("/api/sessions/api-a1/sidecars/dev/stop", {
      method: "POST",
    });
  });

  it("shows a pending assistant bubble and promotes the header state to working", async () => {
    vi.spyOn(global, "fetch").mockImplementation(async (input) => {
      const url = typeof input === "string" ? input : input.url;
      if (url === "/api/sessions/api-a1") {
        return new Response(
          JSON.stringify({
            ...sessionFixture(),
            state: "waiting",
          }),
          { status: 200 },
        );
      }
      if (url === "/api/sessions/api-a1/conversation") {
        return new Response(
          JSON.stringify(
            conversationFixture({
              state: "working",
            }),
          ),
          { status: 200 },
        );
      }
      if (url === "/api/runtime/voice") {
        return new Response(JSON.stringify({ available: false, modelPath: "" }), { status: 200 });
      }
      throw new Error(`Unexpected fetch: ${url}`);
    });

    render(<SessionDetail sessionId="api-a1" />);

    await waitFor(() => {
      expect(screen.getByRole("heading", { name: /dialog/i })).toBeInTheDocument();
    });

    expect(screen.getByText("working")).toBeInTheDocument();
    expect(screen.queryByText("waiting")).not.toBeInTheDocument();
    expect(screen.getByLabelText("Assistant is responding")).toHaveTextContent("...");
    expect(screen.getAllByText("working")).toHaveLength(1);
  });

  it("auto-scrolls the dialog when a pending assistant bubble appears", async () => {
    const intervalCallbacks: Array<() => void | Promise<void>> = [];
    const setIntervalSpy = vi
      .spyOn(global, "setInterval")
      .mockImplementation((handler: TimerHandler) => {
        if (typeof handler === "function") {
          intervalCallbacks.push(handler as () => void);
        }
        return 1 as unknown as ReturnType<typeof setInterval>;
      });
    const clearIntervalSpy = vi.spyOn(global, "clearInterval").mockImplementation(() => {});
    const scrollTo = vi.fn();
    const scrollToDescriptor = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "scrollTo");
    const scrollHeightDescriptor = Object.getOwnPropertyDescriptor(
      HTMLElement.prototype,
      "scrollHeight",
    );
    Object.defineProperty(HTMLElement.prototype, "scrollTo", {
      configurable: true,
      value: scrollTo,
    });
    Object.defineProperty(HTMLElement.prototype, "scrollHeight", {
      configurable: true,
      get() {
        return 420;
      },
    });
    let sessionRequests = 0;
    let conversationRequests = 0;
    try {
      vi.spyOn(global, "fetch").mockImplementation(async (input) => {
        const url = typeof input === "string" ? input : input.url;
        if (url === "/api/sessions/api-a1") {
          sessionRequests += 1;
          return new Response(JSON.stringify(sessionFixture()), { status: 200 });
        }
        if (url === "/api/sessions/api-a1/conversation") {
          conversationRequests += 1;
          const payload =
            conversationRequests === 1
              ? conversationFixture({
                  messages: [{ role: "user", text: "Original prompt", timestampMs: 1 }],
                })
              : conversationFixture({
                  messages: [{ role: "user", text: "Original prompt", timestampMs: 1 }],
                  state: "working",
                });
          return new Response(JSON.stringify(payload), { status: 200 });
        }
        if (url === "/api/runtime/voice") {
          return new Response(JSON.stringify({ available: false, modelPath: "" }), { status: 200 });
        }
        throw new Error(`Unexpected fetch: ${url}`);
      });

      render(<SessionDetail sessionId="api-a1" />);

      await screen.findByRole("heading", { name: /dialog/i });

      expect(intervalCallbacks.length).toBeGreaterThan(0);
      await act(async () => {
        await Promise.all(intervalCallbacks.map((callback) => callback()));
      });

      await waitFor(() => {
        expect(screen.getByLabelText("Assistant is responding")).toBeInTheDocument();
      });
      expect(scrollTo).toHaveBeenCalledWith({ top: 420, behavior: "smooth" });
      expect(sessionRequests).toBeGreaterThan(1);
    } finally {
      if (scrollToDescriptor) {
        Object.defineProperty(HTMLElement.prototype, "scrollTo", scrollToDescriptor);
      }
      if (scrollHeightDescriptor) {
        Object.defineProperty(HTMLElement.prototype, "scrollHeight", scrollHeightDescriptor);
      }
      setIntervalSpy.mockRestore();
      clearIntervalSpy.mockRestore();
    }
  });

  it("queues a message from the default action and clears the composer", async () => {
    const fetchMock = vi.spyOn(global, "fetch").mockImplementation(async (input, init) => {
      const url = typeof input === "string" ? input : input.url;
      if (url === "/api/sessions/api-a1") {
        return new Response(JSON.stringify(sessionFixture()), { status: 200 });
      }
      if (url === "/api/sessions/api-a1/conversation") {
        return new Response(JSON.stringify(conversationFixture()), { status: 200 });
      }
      if (url === "/api/runtime/voice") {
        return new Response(JSON.stringify({ available: false, modelPath: "" }), { status: 200 });
      }
      if (url === "/api/sessions/api-a1/send" && init?.method === "POST") {
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      }
      throw new Error(`Unexpected fetch: ${url}`);
    });

    render(<SessionDetail sessionId="api-a1" />);

    const textarea = await screen.findByPlaceholderText("Message to the running agent...");
    fireEvent.change(textarea, { target: { value: "Queued follow up" } });
    fireEvent.click(screen.getByRole("button", { name: "Queue" }));

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith("/api/sessions/api-a1/send", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ message: "Queued follow up", queue: true }),
      });
    });
    expect(screen.getByPlaceholderText("Message to the running agent...")).toHaveValue("");
  });

  it("sends immediately without queue when clicking Send now", async () => {
    const fetchMock = vi.spyOn(global, "fetch").mockImplementation(async (input, init) => {
      const url = typeof input === "string" ? input : input.url;
      if (url === "/api/sessions/api-a1") {
        return new Response(JSON.stringify(sessionFixture()), { status: 200 });
      }
      if (url === "/api/sessions/api-a1/conversation") {
        return new Response(JSON.stringify(conversationFixture()), { status: 200 });
      }
      if (url === "/api/runtime/voice") {
        return new Response(JSON.stringify({ available: false, modelPath: "" }), { status: 200 });
      }
      if (url === "/api/sessions/api-a1/send" && init?.method === "POST") {
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      }
      throw new Error(`Unexpected fetch: ${url}`);
    });

    render(<SessionDetail sessionId="api-a1" />);

    const textarea = await screen.findByPlaceholderText("Message to the running agent...");
    fireEvent.change(textarea, { target: { value: "Send immediately" } });
    fireEvent.click(screen.getByRole("button", { name: "Send now" }));

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith("/api/sessions/api-a1/send", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          message: "Send immediately",
          queue: false,
          interrupt: true,
        }),
      });
    });
    expect(screen.getByPlaceholderText("Message to the running agent...")).toHaveValue("");
  });

  it("renders the full queued stack in FIFO order", async () => {
    vi.spyOn(global, "fetch").mockImplementation(async (input) => {
      const url = typeof input === "string" ? input : input.url;
      if (url === "/api/sessions/api-a1") {
        return new Response(
          JSON.stringify({
            ...sessionFixture(),
            queuedMessages: {
              messages: [
                "Manual queued follow-up",
                "[Spur step 2/3: implement]\nDo only this step for the task below. When it is done, stop and wait for the next Spur message.\n\nTask:\nFix auth",
                "[Spur step 3/3: test]\nThis is the final step for the task below.\n\nTask:\nFix auth",
              ],
              awaitingPrompt: false,
            },
          }),
          { status: 200 },
        );
      }
      if (url === "/api/sessions/api-a1/conversation") {
        return new Response(JSON.stringify(conversationFixture()), { status: 200 });
      }
      if (url === "/api/runtime/voice") {
        return new Response(JSON.stringify({ available: false, modelPath: "" }), { status: 200 });
      }
      throw new Error(`Unexpected fetch: ${url}`);
    });

    render(<SessionDetail sessionId="api-a1" />);

    await waitFor(() => {
      expect(screen.getByRole("heading", { name: /queued messages/i })).toBeInTheDocument();
    });

    const queuedItems = screen.getAllByRole("listitem");
    expect(queuedItems).toHaveLength(3);
    expect(queuedItems[0]).toHaveTextContent("Manual queued follow-up");
    expect(queuedItems[1]).toHaveTextContent("[Spur step 2/3: implement]");
    expect(queuedItems[2]).toHaveTextContent("[Spur step 3/3: test]");
  });

  it("renders awaiting-prompt hint when queue is blocked", async () => {
    vi.spyOn(global, "fetch").mockImplementation(async (input) => {
      const url = typeof input === "string" ? input : input.url;
      if (url === "/api/sessions/api-a1") {
        return new Response(
          JSON.stringify({
            ...sessionFixture(),
            queuedMessages: {
              messages: [],
              awaitingPrompt: true,
            },
          }),
          { status: 200 },
        );
      }
      if (url === "/api/sessions/api-a1/conversation") {
        return new Response(JSON.stringify(conversationFixture()), { status: 200 });
      }
      if (url === "/api/runtime/voice") {
        return new Response(JSON.stringify({ available: false, modelPath: "" }), { status: 200 });
      }
      throw new Error(`Unexpected fetch: ${url}`);
    });

    render(<SessionDetail sessionId="api-a1" />);

    await waitFor(() => {
      expect(screen.getByRole("heading", { name: /queued messages/i })).toBeInTheDocument();
    });
    expect(
      screen.getByText(/queued messages will send automatically when the agent is ready/i),
    ).toBeInTheDocument();
    expect(screen.queryAllByRole("listitem")).toHaveLength(0);
  });

  it("hides queued messages when the queue is empty and not awaiting a prompt", async () => {
    vi.spyOn(global, "fetch").mockImplementation(async (input) => {
      const url = typeof input === "string" ? input : input.url;
      if (url === "/api/sessions/api-a1") {
        return new Response(JSON.stringify(sessionFixture()), { status: 200 });
      }
      if (url === "/api/sessions/api-a1/conversation") {
        return new Response(JSON.stringify(conversationFixture()), { status: 200 });
      }
      if (url === "/api/runtime/voice") {
        return new Response(JSON.stringify({ available: false, modelPath: "" }), { status: 200 });
      }
      throw new Error(`Unexpected fetch: ${url}`);
    });

    render(<SessionDetail sessionId="api-a1" />);

    await waitFor(() => {
      expect(screen.getByRole("heading", { name: /dialog/i })).toBeInTheDocument();
    });

    expect(screen.queryByRole("heading", { name: /queued messages/i })).not.toBeInTheDocument();
  });
});
