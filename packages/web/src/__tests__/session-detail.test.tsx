import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { SessionDetail } from "@/components/SessionDetail";
import type { SpurSessionView } from "@/lib/types";

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

class MobilePwaMediaRecorder extends MockMediaRecorder {
  private requestedFlush = false;

  requestData() {
    this.requestedFlush = true;
  }

  override stop() {
    this.state = "inactive";
    if (this.requestedFlush) {
      this.emit("stop");
      queueMicrotask(() => {
        this.emit(
          "dataavailable",
          new Blob(["voice-audio"], {
            type: this.mimeType,
          }),
        );
      });
      return;
    }
    super.stop();
  }
}

function sessionFixture(overrides?: Partial<SpurSessionView>) {
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
    artifacts: [],
    queuedMessages: {
      messages: [],
      awaitingPrompt: false,
    },
    slots: {
      links: [],
    },
    ...overrides,
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
      expect(
        screen.getByPlaceholderText(/^Message to the running agent\.\.\./),
      ).toBeInTheDocument();
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

  it("records audio on mobile-style recorders that misorder the final chunk after requestData", async () => {
    vi.stubGlobal("MediaRecorder", MobilePwaMediaRecorder as unknown as typeof MediaRecorder);
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
        return new Response(JSON.stringify({ text: "Mobile PWA voice still works" }), {
          status: 200,
        });
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
      expect(screen.getByDisplayValue("Mobile PWA voice still works")).toBeInTheDocument();
    });

    expect(
      screen.queryByText(
        "Voice recording captured no audio. Check your microphone input and try again.",
      ),
    ).not.toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/runtime/voice/transcribe",
      expect.objectContaining({ method: "POST" }),
    );
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
      expect(
        screen.getByPlaceholderText(/^Message to the running agent\.\.\./),
      ).toBeInTheDocument();
    });

    fireEvent.change(screen.getByPlaceholderText(/^Message to the running agent\.\.\./), {
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

  it("respawns with edited prompt and startup images without forcing a project query", async () => {
    let respawnBody: Record<string, unknown> | null = null;
    vi.spyOn(global, "fetch").mockImplementation(async (input, init) => {
      const url = typeof input === "string" ? input : input.url;
      if (url === "/api/sessions/api-a1") {
        return new Response(
          JSON.stringify({
            ...sessionFixture(),
            status: "completed",
            runtimeAlive: false,
            startupAttachmentIds: ["1715000000000-source.png"],
            artifacts: [
              {
                id: "1715000000000-source.png",
                name: "1715000000000-source.png",
                size: 12,
                mimeType: "image/png",
                kind: "image",
                createdAt: "2026-04-02T10:00:00.000Z",
                updatedAt: "2026-04-02T10:00:00.000Z",
              },
            ],
          }),
          { status: 200 },
        );
      }
      if (url === "/api/runtime/voice") {
        return new Response(JSON.stringify({ available: false, modelPath: "" }), { status: 200 });
      }
      if (url === "/api/sessions/api-a1/respawn" && init?.method === "POST") {
        respawnBody = JSON.parse(String(init.body)) as Record<string, unknown>;
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

    const respawnButton = await screen.findByRole("button", { name: "Edit & Respawn" });
    fireEvent.click(respawnButton);
    expect(screen.getByDisplayValue("Fix auth")).toBeInTheDocument();

    fireEvent.change(screen.getByPlaceholderText("Edit the initial message..."), {
      target: { value: "Re-run with screenshot" },
    });
    fireEvent.paste(screen.getByPlaceholderText("Edit the initial message..."), {
      clipboardData: {
        files: [new File(["png"], "edited.png", { type: "image/png" })],
      },
    });

    await waitFor(() => {
      expect(screen.getByAltText("edited.png")).toBeInTheDocument();
    });

    fireEvent.click(screen.getByRole("button", { name: "Respawn" }));

    await waitFor(() => {
      expect(pushMock).toHaveBeenCalledWith("/sessions/api-b2");
    });
    expect(respawnBody).toEqual({
      prompt: "Re-run with screenshot",
      startupAttachmentIds: ["1715000000000-source.png"],
      attachments: [{ name: "edited.png", data: expect.any(String) }],
    });
  });

  it("shows an add-image picker inside the respawn editor and accepts files from it", async () => {
    vi.spyOn(global, "fetch").mockImplementation(async (input) => {
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
      throw new Error(`Unexpected fetch: ${url}`);
    });

    const { container } = render(<SessionDetail sessionId="api-a1" />);

    fireEvent.click(await screen.findByRole("button", { name: "Edit & Respawn" }));
    expect(screen.getByRole("button", { name: "Add image" })).toBeInTheDocument();

    const fileInputs = container.querySelectorAll('input[type="file"]');
    const fileInput = fileInputs[fileInputs.length - 1] as HTMLInputElement | undefined;
    expect(fileInput).toBeDefined();
    fireEvent.change(fileInput!, {
      target: { files: [new File(["png"], "picker-edit.png", { type: "image/png" })] },
    });

    await waitFor(() => {
      expect(screen.getByAltText("picker-edit.png")).toBeInTheDocument();
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
              links: [{ label: "isolated-ui", url: "http://example.com:5601" }],
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
        "http://example.com:5601",
      );
    });
  });

  it("does not render an Open link when no slot link matches the sidecar name", async () => {
    vi.spyOn(global, "fetch").mockImplementation(async (input) => {
      const url = typeof input === "string" ? input : input.url;
      if (url === "/api/sessions/api-a1") {
        return new Response(
          JSON.stringify({
            ...sessionFixture(),
            sidecars: [{ name: "isolated-daemon", alive: true }],
            slots: {
              links: [{ label: "isolated-ui", url: "http://example.com:5601" }],
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
      expect(screen.getByText("isolated-daemon")).toBeInTheDocument();
    });
    expect(screen.queryByRole("link", { name: "Open" })).not.toBeInTheDocument();
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
              links: [{ label: "isolated-ui", url: "http://example.com:5601" }],
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

  it("shows link workspace access entries in the runtime sidebar", async () => {
    vi.spyOn(global, "fetch").mockImplementation(async (input) => {
      const url = typeof input === "string" ? input : input.url;
      if (url === "/api/sessions/api-a1") {
        return new Response(
          JSON.stringify({
            ...sessionFixture(),
            workspaceAccess: {
              items: [
                {
                  label: "Web IDE",
                  kind: "link",
                  value: "https://code.example.com/?folder=%2Ftmp%2Fapi-a1",
                },
              ],
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
      expect(screen.getByText("Workspace Access")).toBeInTheDocument();
      expect(screen.getByRole("link", { name: "Open Web IDE" })).toHaveAttribute(
        "href",
        "https://code.example.com/?folder=%2Ftmp%2Fapi-a1",
      );
    });
  });

  it("copies a workspace access snippet and shows a toast", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText },
    });

    vi.spyOn(global, "fetch").mockImplementation(async (input) => {
      const url = typeof input === "string" ? input : input.url;
      if (url === "/api/sessions/api-a1") {
        return new Response(
          JSON.stringify({
            ...sessionFixture(),
            workspaceAccess: {
              items: [
                {
                  label: "Cursor",
                  kind: "copy",
                  value: "cursor --remote ssh-remote+100.80.107.19 /tmp/intelas-b607",
                },
              ],
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
      expect(
        screen.getByText("cursor --remote ssh-remote+100.80.107.19 /tmp/intelas-b607"),
      ).toBeInTheDocument();
    });

    fireEvent.click(screen.getByRole("button", { name: /copy cursor/i }));

    expect(writeText).toHaveBeenCalledWith(
      "cursor --remote ssh-remote+100.80.107.19 /tmp/intelas-b607",
    );
    expect(await screen.findByText("Cursor copied")).toBeInTheDocument();
  });

  it("falls back to execCommand copy when navigator.clipboard is unavailable", async () => {
    const originalClipboard = Object.getOwnPropertyDescriptor(navigator, "clipboard");
    const originalExecCommand = Object.getOwnPropertyDescriptor(document, "execCommand");
    const execCommand = vi.fn().mockReturnValue(true);

    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: undefined,
    });
    Object.defineProperty(document, "execCommand", {
      configurable: true,
      value: execCommand,
    });

    vi.spyOn(global, "fetch").mockImplementation(async (input) => {
      const url = typeof input === "string" ? input : input.url;
      if (url === "/api/sessions/api-a1") {
        return new Response(
          JSON.stringify({
            ...sessionFixture(),
            workspaceAccess: {
              items: [
                {
                  label: "Cursor",
                  kind: "copy",
                  value: "cursor --remote ssh-remote+100.80.107.19 /tmp/intelas-b607",
                },
              ],
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
      expect(
        screen.getByText("cursor --remote ssh-remote+100.80.107.19 /tmp/intelas-b607"),
      ).toBeInTheDocument();
    });

    fireEvent.click(screen.getByRole("button", { name: /copy cursor/i }));

    expect(execCommand).toHaveBeenCalledWith("copy");
    expect(await screen.findByText("Cursor copied")).toBeInTheDocument();

    if (originalClipboard) {
      Object.defineProperty(navigator, "clipboard", originalClipboard);
    } else {
      delete (navigator as Navigator & { clipboard?: Clipboard }).clipboard;
    }

    if (originalExecCommand) {
      Object.defineProperty(document, "execCommand", originalExecCommand);
    } else {
      delete (document as Document & { execCommand?: (command: string) => boolean }).execCommand;
    }
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

  it("hard-wraps long dialog and queued message tokens without widening the layout", async () => {
    const longToken = "supercalifragilisticexpialidocious".repeat(8);

    vi.spyOn(global, "fetch").mockImplementation(async (input) => {
      const url = typeof input === "string" ? input : input.url;
      if (url === "/api/sessions/api-a1") {
        return new Response(
          JSON.stringify({
            ...sessionFixture(),
            queuedMessages: {
              messages: [longToken],
              awaitingPrompt: false,
            },
          }),
          { status: 200 },
        );
      }
      if (url === "/api/sessions/api-a1/conversation") {
        return new Response(
          JSON.stringify(
            conversationFixture({
              messages: [{ role: "assistant", text: longToken, timestampMs: 1 }],
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

    const dialogSection = (await screen.findByRole("heading", { name: /dialog/i })).parentElement;
    const queuedSection = (await screen.findByRole("heading", { name: /queued messages/i }))
      .parentElement;
    expect(dialogSection).not.toBeNull();
    expect(queuedSection).not.toBeNull();

    const dialogText = within(dialogSection as HTMLElement).getByText(longToken);
    expect(dialogText).toHaveClass("[overflow-wrap:anywhere]");
    expect(dialogText.parentElement).toHaveClass("min-w-0");

    const queuedText = within(queuedSection as HTMLElement).getByText(longToken);
    expect(queuedText).toHaveClass("[overflow-wrap:anywhere]");
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

    const textarea = await screen.findByPlaceholderText(/^Message to the running agent\.\.\./);
    fireEvent.change(textarea, { target: { value: "Queued follow up" } });
    fireEvent.click(screen.getByRole("button", { name: "Queue" }));

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith("/api/sessions/api-a1/send", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ message: "Queued follow up", queue: true }),
      });
    });
    await waitFor(() => {
      expect(screen.getByPlaceholderText(/^Message to the running agent\.\.\./)).toHaveValue("");
    });
  });

  it("shows the primary composer hotkey hint only on Send now", async () => {
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

    await screen.findByPlaceholderText(/^Message to the running agent\.\.\./);
    expect(screen.getByRole("button", { name: /^send now$/i })).toHaveTextContent("⌘ + ⏎");
    expect(screen.getByRole("button", { name: /^queue$/i })).not.toHaveTextContent("⌘ + ⏎");
    expect(screen.queryByText("⌘/Ctrl + Enter")).not.toBeInTheDocument();
  });

  it("sends immediately on Cmd+Enter from the composer textarea", async () => {
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

    const textarea = await screen.findByPlaceholderText(/^Message to the running agent\.\.\./);
    fireEvent.change(textarea, { target: { value: "Immediate hotkey send" } });
    fireEvent.keyDown(textarea, { key: "Enter", metaKey: true });

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith("/api/sessions/api-a1/send", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          message: "Immediate hotkey send",
          queue: false,
          interrupt: true,
        }),
      });
    });
  });

  it("toggles voice recording from the composer with Cmd+.", async () => {
    vi.spyOn(global, "fetch").mockImplementation(async (input, init) => {
      const url = typeof input === "string" ? input : input.url;
      if (url === "/api/sessions/api-a1") {
        return new Response(JSON.stringify(sessionFixture()), { status: 200 });
      }
      if (url === "/api/sessions/api-a1/conversation") {
        return new Response(JSON.stringify(conversationFixture()), { status: 200 });
      }
      if (url === "/api/runtime/voice") {
        return new Response(
          JSON.stringify({ available: true, modelPath: "/models/ggml-base.en.bin" }),
          { status: 200 },
        );
      }
      if (url === "/api/runtime/voice/transcribe" && init?.method === "POST") {
        return new Response(JSON.stringify({ text: "Voice hotkey transcript" }), { status: 200 });
      }
      throw new Error(`Unexpected fetch: ${url}`);
    });

    render(<SessionDetail sessionId="api-a1" />);

    const textarea = await screen.findByPlaceholderText(
      "Message to the running agent... Voice ⌘ + .",
    );

    fireEvent.keyDown(textarea, { key: ".", metaKey: true });
    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Stop voice recording" })).toBeInTheDocument();
    });

    fireEvent.keyDown(textarea, { key: ".", metaKey: true });
    await waitFor(() => {
      expect(screen.getByDisplayValue("Voice hotkey transcript")).toBeInTheDocument();
    });
  });

  it("does not submit the composer on plain Enter", async () => {
    let sendCalls = 0;
    vi.spyOn(global, "fetch").mockImplementation(async (input, init) => {
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
        sendCalls += 1;
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      }
      throw new Error(`Unexpected fetch: ${url}`);
    });

    render(<SessionDetail sessionId="api-a1" />);

    const textarea = await screen.findByPlaceholderText(/^Message to the running agent\.\.\./);
    fireEvent.change(textarea, { target: { value: "First line" } });
    fireEvent.keyDown(textarea, { key: "Enter" });

    expect(sendCalls).toBe(0);
    expect(screen.getByPlaceholderText(/^Message to the running agent\.\.\./)).toHaveValue(
      "First line",
    );
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

    const textarea = await screen.findByPlaceholderText(/^Message to the running agent\.\.\./);
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
    await waitFor(() => {
      expect(screen.getByPlaceholderText(/^Message to the running agent\.\.\./)).toHaveValue("");
    });
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

describe("SessionDetail logs", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    pushMock.mockReset();
    replaceMock.mockReset();
    backMock.mockReset();
    window.localStorage.clear();
    window.history.replaceState(null, "", "/sessions/api-a1");
  });

  it("renders state transition logs with a history snapshot link", async () => {
    vi.spyOn(global, "fetch").mockImplementation(async (input) => {
      const url = typeof input === "string" ? input : input.url;

      if (url === "/api/sessions/api-a1") {
        return new Response(JSON.stringify(sessionFixture()), { status: 200 });
      }

      if (url === "/api/sessions/api-a1/conversation") {
        return new Response(JSON.stringify(conversationFixture({ messages: [] })), { status: 200 });
      }

      if (url === "/api/runtime/voice") {
        return new Response(JSON.stringify({ available: false, modelPath: "" }), { status: 200 });
      }

      if (url === "/api/sessions/api-a1/logs") {
        return new Response(
          JSON.stringify([
            {
              timestamp: "2026-04-02T10:01:00.000Z",
              event: "session.state.transition",
              level: "info",
              message: "Status changed from waiting to needs_input",
              details: {
                fromState: "waiting",
                toState: "needs_input",
                source: "jsonl",
                historyArtifactId:
                  "agent-history-2026-04-02T10-01-00-000Z-waiting-to-needs_input.jsonl",
              },
            },
          ]),
          { status: 200 },
        );
      }

      throw new Error(`Unexpected fetch: ${url}`);
    });

    render(<SessionDetail sessionId="api-a1" />);

    await waitFor(() => {
      expect(screen.getByRole("button", { name: /^logs$/i })).toBeInTheDocument();
    });

    fireEvent.click(screen.getByRole("button", { name: /^logs$/i }));

    expect(await screen.findByText("Status transition")).toBeInTheDocument();
    expect(screen.getByText("waiting")).toBeInTheDocument();
    expect(screen.getByText("needs input")).toBeInTheDocument();
    expect(screen.getByText("source jsonl")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /history snapshot/i })).toHaveAttribute(
      "href",
      "/api/sessions/api-a1/artifacts/agent-history-2026-04-02T10-01-00-000Z-waiting-to-needs_input.jsonl",
    );
  });
});

describe("SessionDetail artifacts", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("renders image, video, and download artifacts from the session payload", async () => {
    vi.spyOn(global, "fetch").mockImplementation(async (input) => {
      const url = typeof input === "string" ? input : input.url;

      if (url === "/api/sessions/api-a1") {
        return new Response(
          JSON.stringify(
            sessionFixture({
              artifacts: [
                {
                  id: "shot.png",
                  name: "shot.png",
                  size: 1200,
                  mimeType: "image/png",
                  kind: "image",
                  createdAt: "2026-04-02T10:00:00.000Z",
                  updatedAt: "2026-04-02T10:00:00.000Z",
                },
                {
                  id: "run.webm",
                  name: "run.webm",
                  size: 2200,
                  mimeType: "video/webm",
                  kind: "video",
                  createdAt: "2026-04-02T10:00:00.000Z",
                  updatedAt: "2026-04-02T10:00:00.000Z",
                },
                {
                  id: "trace.log",
                  name: "trace.log",
                  size: 3200,
                  mimeType: "text/plain; charset=utf-8",
                  kind: "download",
                  createdAt: "2026-04-02T10:00:00.000Z",
                  updatedAt: "2026-04-02T10:00:00.000Z",
                },
              ],
            }),
          ),
          { status: 200 },
        );
      }

      if (url === "/api/sessions/api-a1/conversation") {
        return new Response(JSON.stringify(conversationFixture()), { status: 200 });
      }

      throw new Error(`Unexpected fetch: ${url}`);
    });

    render(<SessionDetail sessionId="api-a1" />);

    await waitFor(() => {
      expect(screen.getByText("Artifacts")).toBeInTheDocument();
    });

    expect(screen.getByAltText("shot.png")).toHaveAttribute(
      "src",
      "/api/sessions/api-a1/artifacts/shot.png",
    );
    expect(screen.getByLabelText("run.webm preview")).toBeInTheDocument();
    expect(screen.getAllByRole("link", { name: /download .*$/i })).toHaveLength(3);
    expect(screen.getByText("trace.log")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Preview shot.png" }));

    await waitFor(() => {
      expect(screen.getByRole("dialog", { name: "Artifact preview shot.png" })).toBeInTheDocument();
    });

    expect(screen.getByRole("link", { name: "Download" })).toHaveAttribute(
      "href",
      "/api/sessions/api-a1/artifacts/shot.png",
    );
  });
});

describe("SessionDetail display state", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    pushMock.mockReset();
    replaceMock.mockReset();
    backMock.mockReset();
    window.localStorage.clear();
    window.history.replaceState(null, "", "/sessions/api-a1");
  });

  function stubFetch(
    sessionOverrides: Parameters<typeof sessionFixture>[0],
    conversationState: "working" | "waiting" | "needs_input" | "stopped" | "error" | "killed",
  ) {
    vi.spyOn(global, "fetch").mockImplementation(async (input) => {
      const url = typeof input === "string" ? input : input.url;
      if (url === "/api/sessions/api-a1") {
        return new Response(JSON.stringify(sessionFixture(sessionOverrides)), { status: 200 });
      }
      if (url === "/api/sessions/api-a1/conversation") {
        return new Response(JSON.stringify(conversationFixture({ state: conversationState })), {
          status: 200,
        });
      }
      if (url === "/api/runtime/voice") {
        return new Response(JSON.stringify({ available: false, modelPath: "" }), { status: 200 });
      }
      throw new Error(`Unexpected fetch: ${url}`);
    });
  }

  async function expectStateBadge(label: string): Promise<void> {
    const heading = await screen.findByRole("heading", { level: 1 });
    const container = heading.parentElement;
    if (!container) throw new Error("header container not found");
    await within(container).findByText(label);
  }

  it("shows error state when session is errored (does not override to working)", async () => {
    stubFetch({ status: "errored", state: "error" }, "working");
    render(<SessionDetail sessionId="api-a1" />);
    await expectStateBadge("error");
  });

  it("shows killed state when session is killed (does not override to working)", async () => {
    stubFetch({ status: "killed", state: "killed" }, "working");
    render(<SessionDetail sessionId="api-a1" />);
    await expectStateBadge("killed");
  });

  it("shows stopped state when session is stopped (does not override to working)", async () => {
    stubFetch({ status: "paused", state: "stopped" }, "working");
    render(<SessionDetail sessionId="api-a1" />);
    // ActivityDot renders the "stopped" state as the "paused" label.
    await expectStateBadge("paused");
  });

  it("overrides to working when session state is waiting and claude conversation reports working", async () => {
    stubFetch({ status: "running", state: "waiting" }, "working");
    render(<SessionDetail sessionId="api-a1" />);
    await expectStateBadge("working");
  });

  it("shows working when session state is working and claude conversation reports working", async () => {
    stubFetch({ status: "running", state: "working" }, "working");
    render(<SessionDetail sessionId="api-a1" />);
    await expectStateBadge("working");
  });
});
