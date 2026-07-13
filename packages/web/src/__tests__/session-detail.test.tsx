import {
  act,
  fireEvent,
  render as rtlRender,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useState, type ReactElement, type ReactNode } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { SessionDetail } from "@/components/SessionDetail";
import type { SpurSessionView } from "@/lib/types";

// SessionDetail now reads the tag catalog via react-query (useTagCatalog), so
// every render needs a QueryClientProvider. Wrap through the render `wrapper`
// option so rerender() keeps the same provider tree.
function TestProviders({ children }: { children: ReactNode }) {
  const [client] = useState(
    () => new QueryClient({ defaultOptions: { queries: { retry: false } } }),
  );
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

function render(ui: ReactElement) {
  return rtlRender(ui, { wrapper: TestProviders });
}

const pushMock = vi.fn();
const replaceMock = vi.fn();
const backMock = vi.fn();

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: pushMock, replace: replaceMock, back: backMock }),
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
    totalMessages: number;
    hasMore: boolean;
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

function stubElementBounds(element: Element, width = 200, height = 100) {
  Object.defineProperty(element, "getBoundingClientRect", {
    configurable: true,
    value: () => ({
      bottom: height,
      height,
      left: 0,
      right: width,
      toJSON: () => ({}),
      top: 0,
      width,
      x: 0,
      y: 0,
    }),
  });
}

function firePreviewPointerEvent(
  element: Element,
  type: "pointerdown" | "pointerup",
  init: { clientX: number; clientY: number; pointerId?: number; button?: number },
) {
  const event = new Event(type, { bubbles: true, cancelable: true });
  Object.defineProperties(event, {
    button: { value: init.button ?? 0 },
    clientX: { value: init.clientX },
    clientY: { value: init.clientY },
    pointerId: { value: init.pointerId ?? 1 },
  });
  fireEvent(element, event);
}

describe("SessionDetail wake markers", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    pushMock.mockReset();
    replaceMock.mockReset();
    backMock.mockReset();
    window.localStorage.clear();
    window.history.replaceState(null, "", "/sessions/api-a1");
  });

  it("shows interval wake timer in the header and runtime sidebar", async () => {
    vi.spyOn(global, "fetch").mockImplementation(async (input) => {
      const url = typeof input === "string" ? input : input.url;

      if (url === "/api/sessions/api-a1") {
        return new Response(
          JSON.stringify(
            sessionFixture({
              intervalWake: {
                nextDueAt: new Date(Date.now() + 300_000).toISOString(),
                intervalMs: 300_000,
                message: "Check CI",
                stopCondition: "CI is green",
              },
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
      expect(screen.getByText("interval wake")).toBeInTheDocument();
    });
    expect(screen.getAllByText(/in \d+m/).length).toBeGreaterThan(0);
    expect(screen.getAllByText("every 5m").length).toBeGreaterThan(0);
    expect(screen.getByText("Next wake")).toBeInTheDocument();
    expect(screen.getByText("Wake stop condition")).toBeInTheDocument();
    expect(screen.getByText("CI is green")).toBeInTheDocument();
  });

  it("shows daily wake timer in the header and runtime sidebar", async () => {
    vi.spyOn(global, "fetch").mockImplementation(async (input) => {
      const url = typeof input === "string" ? input : input.url;

      if (url === "/api/sessions/api-a1") {
        return new Response(
          JSON.stringify(
            sessionFixture({
              dailyWake: {
                dailyAt: ["09:00", "17:00"],
                nextDueAt: new Date(Date.now() + 300_000).toISOString(),
                message: "Check daily state",
                stopCondition: "Daily checks done",
              },
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
      expect(screen.getByText("daily wake")).toBeInTheDocument();
    });
    expect(screen.getAllByText(/in \d+m/).length).toBeGreaterThan(0);
    expect(screen.getAllByText("daily 09:00, 17:00").length).toBeGreaterThan(0);
    expect(screen.getByText("Wake daily at")).toBeInTheDocument();
    expect(screen.getByText("Wake stop condition")).toBeInTheDocument();
    expect(screen.getByText("Daily checks done")).toBeInTheDocument();
  });
});

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

  it("shows active desk members first and reveals completed members behind ellipsis", async () => {
    vi.spyOn(global, "fetch").mockImplementation(async (input) => {
      const url = typeof input === "string" ? input : input.url;

      if (url === "/api/sessions/api-a1") {
        return new Response(
          JSON.stringify(
            sessionFixture({
              deskGroupMembers: [
                {
                  id: "api-a1",
                  agent: "claude",
                  status: "running",
                  state: "working",
                  runtimeAlive: true,
                },
                {
                  id: "api-b2",
                  agent: "codex",
                  status: "completed",
                  state: "stopped",
                  runtimeAlive: false,
                },
                {
                  id: "api-c3",
                  agent: "cursor",
                  status: "killed",
                  state: "killed",
                  runtimeAlive: false,
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

      if (url === "/api/runtime/voice") {
        return new Response(JSON.stringify({ available: false, modelPath: "" }), { status: 200 });
      }

      throw new Error(`Unexpected fetch: ${url}`);
    });

    render(<SessionDetail sessionId="api-a1" />);

    const nav = await screen.findByRole("navigation", { name: "Checkout group" });
    expect(within(nav).getByRole("link", { name: /claude.*api-a1/i })).toBeInTheDocument();
    expect(within(nav).queryByRole("link", { name: /codex.*api-b2/i })).not.toBeInTheDocument();
    expect(within(nav).queryByRole("link", { name: /cursor.*api-c3/i })).not.toBeInTheDocument();

    fireEvent.click(within(nav).getByRole("button", { name: "Show completed desk agents" }));

    expect(within(nav).getByRole("link", { name: /codex.*api-b2/i })).toBeInTheDocument();
    expect(within(nav).queryByRole("link", { name: /cursor.*api-c3/i })).not.toBeInTheDocument();
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
          within(
            screen.getByRole("heading", { name: "Message" }).closest("section") as HTMLElement,
          ).getByText("Failed to transcribe audio after 3 attempts: Voice API unavailable"),
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
          within(
            screen.getByRole("heading", { name: "Message" }).closest("section") as HTMLElement,
          ).getByText("Failed to transcribe audio after 3 attempts: Voice API unavailable"),
        ).toBeInTheDocument();
      },
      { timeout: 3_000 },
    );
  });

  it("renders session detail when artifacts exist but startupAttachmentIds is omitted", async () => {
    vi.spyOn(global, "fetch").mockImplementation(async (input) => {
      const url = typeof input === "string" ? input : input.url;

      if (url === "/api/sessions/api-a1") {
        return new Response(
          JSON.stringify({
            ...sessionFixture(),
            artifacts: [
              {
                id: "artifact-1",
                name: "trace.txt",
                size: 12,
                mimeType: "text/plain",
                kind: "download",
                createdAt: "2026-04-02T10:00:00.000Z",
                updatedAt: "2026-04-02T10:00:00.000Z",
              },
            ],
          }),
          { status: 200 },
        );
      }
      if (url === "/api/sessions/api-a1/conversation") {
        return new Response("not found", { status: 404 });
      }
      if (url === "/api/runtime/voice") {
        return new Response(JSON.stringify({ available: false, language: "" }), { status: 200 });
      }

      throw new Error(`Unexpected fetch: ${url}`);
    });

    render(<SessionDetail sessionId="api-a1" />);

    await waitFor(() => {
      expect(screen.getByText("trace.txt")).toBeInTheDocument();
    });
  });

  it("renders session detail when artifacts and startupAttachmentIds are both omitted", async () => {
    vi.spyOn(global, "fetch").mockImplementation(async (input) => {
      const url = typeof input === "string" ? input : input.url;

      if (url === "/api/sessions/api-a1") {
        const payload = sessionFixture() as Record<string, unknown>;
        delete payload["artifacts"];
        return new Response(JSON.stringify(payload), { status: 200 });
      }
      if (url === "/api/sessions/api-a1/conversation") {
        return new Response("not found", { status: 404 });
      }
      if (url === "/api/runtime/voice") {
        return new Response(JSON.stringify({ available: false, language: "" }), { status: 200 });
      }

      throw new Error(`Unexpected fetch: ${url}`);
    });

    render(<SessionDetail sessionId="api-a1" />);

    await waitFor(() => {
      expect(screen.getByRole("heading", { name: "Fix auth" })).toBeInTheDocument();
    });
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
                origin: "intentional",
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

  it("fires a single respawn POST when Respawn is double-clicked", async () => {
    let respawnPosts = 0;
    vi.spyOn(global, "fetch").mockImplementation(async (input, init) => {
      const url = typeof input === "string" ? input : input.url;
      if (url === "/api/sessions/api-a1") {
        return new Response(
          JSON.stringify({ ...sessionFixture(), status: "completed", runtimeAlive: false }),
          { status: 200 },
        );
      }
      if (url === "/api/runtime/voice") {
        return new Response(JSON.stringify({ available: false, modelPath: "" }), { status: 200 });
      }
      if (url === "/api/sessions/api-a1/respawn" && init?.method === "POST") {
        respawnPosts += 1;
        return new Response(JSON.stringify({ ...sessionFixture(), id: "api-b2" }), { status: 200 });
      }
      throw new Error(`Unexpected fetch: ${url}`);
    });

    render(<SessionDetail sessionId="api-a1" />);

    fireEvent.click(await screen.findByRole("button", { name: "Edit & Respawn" }));
    const respawnButton = screen.getByRole("button", { name: "Respawn" });
    fireEvent.click(respawnButton);
    fireEvent.click(respawnButton);

    await waitFor(() => {
      expect(pushMock).toHaveBeenCalledWith("/sessions/api-b2");
    });
    expect(respawnPosts).toBe(1);
  });

  it("defaults the respawn agent select to the session agent", async () => {
    vi.spyOn(global, "fetch").mockImplementation(async (input) => {
      const url = typeof input === "string" ? input : input.url;
      if (url === "/api/sessions/api-a1") {
        return new Response(
          JSON.stringify({
            ...sessionFixture({ agent: "codex" }),
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

    render(<SessionDetail sessionId="api-a1" />);

    fireEvent.click(await screen.findByRole("button", { name: "Edit & Respawn" }));
    const select = screen.getByRole("combobox", { name: "Respawn agent" }) as HTMLSelectElement;
    expect(select.value).toBe("codex");
  });

  it("includes the selected agent in the respawn payload when changed", async () => {
    let respawnBody: Record<string, unknown> | null = null;
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
        respawnBody = JSON.parse(String(init.body)) as Record<string, unknown>;
        return new Response(JSON.stringify({ ...sessionFixture(), id: "api-b2" }), { status: 200 });
      }
      throw new Error(`Unexpected fetch: ${url}`);
    });

    render(<SessionDetail sessionId="api-a1" />);

    fireEvent.click(await screen.findByRole("button", { name: "Edit & Respawn" }));
    fireEvent.change(screen.getByRole("combobox", { name: "Respawn agent" }), {
      target: { value: "cursor" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Respawn" }));

    await waitFor(() => {
      expect(respawnBody).not.toBeNull();
    });
    expect(respawnBody?.agent).toBe("cursor");
  });

  it("omits the agent from the respawn payload when unchanged", async () => {
    let respawnBody: Record<string, unknown> | null = null;
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
        respawnBody = JSON.parse(String(init.body)) as Record<string, unknown>;
        return new Response(JSON.stringify({ ...sessionFixture(), id: "api-b2" }), { status: 200 });
      }
      throw new Error(`Unexpected fetch: ${url}`);
    });

    render(<SessionDetail sessionId="api-a1" />);

    fireEvent.click(await screen.findByRole("button", { name: "Edit & Respawn" }));
    fireEvent.click(screen.getByRole("button", { name: "Respawn" }));

    await waitFor(() => {
      expect(respawnBody).not.toBeNull();
    });
    expect(respawnBody && "agent" in respawnBody).toBe(false);
  });

  it("renders slash suggestions and input history in the respawn modal footer", async () => {
    vi.spyOn(global, "fetch").mockImplementation(async (input) => {
      const url = typeof input === "string" ? input : input.url;
      if (url === "/api/sessions/api-a1") {
        return new Response(
          JSON.stringify({ ...sessionFixture(), status: "completed", runtimeAlive: false }),
          { status: 200 },
        );
      }
      if (url === "/api/runtime/voice") {
        return new Response(JSON.stringify({ available: false, modelPath: "" }), { status: 200 });
      }
      throw new Error(`Unexpected fetch: ${url}`);
    });

    render(<SessionDetail sessionId="api-a1" />);

    fireEvent.click(await screen.findByRole("button", { name: "Edit & Respawn" }));
    expect(screen.getByRole("button", { name: "Slash" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "History" })).toBeInTheDocument();
  });

  it("saves the submitted prompt to respawn input history on success", async () => {
    vi.spyOn(global, "fetch").mockImplementation(async (input, init) => {
      const url = typeof input === "string" ? input : input.url;
      if (url === "/api/sessions/api-a1") {
        return new Response(
          JSON.stringify({ ...sessionFixture(), status: "completed", runtimeAlive: false }),
          { status: 200 },
        );
      }
      if (url === "/api/runtime/voice") {
        return new Response(JSON.stringify({ available: false, modelPath: "" }), { status: 200 });
      }
      if (url === "/api/sessions/api-a1/respawn" && init?.method === "POST") {
        return new Response(JSON.stringify({ ...sessionFixture(), id: "api-b2" }), { status: 200 });
      }
      throw new Error(`Unexpected fetch: ${url}`);
    });

    render(<SessionDetail sessionId="api-a1" />);

    fireEvent.click(await screen.findByRole("button", { name: "Edit & Respawn" }));
    fireEvent.change(screen.getByPlaceholderText(/^Edit the initial message\.\.\./), {
      target: { value: "Retry with new plan" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Respawn" }));

    await waitFor(() => {
      expect(window.localStorage.getItem("spur:input-history:respawn-prompt")).toContain(
        "Retry with new plan",
      );
    });
  });

  it("renders a mic button inside the respawn modal when voice is available", async () => {
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
        return new Response(
          JSON.stringify({ available: true, modelPath: "/models/ggml-base.en.bin" }),
          { status: 200 },
        );
      }
      throw new Error(`Unexpected fetch: ${url}`);
    });

    render(<SessionDetail sessionId="api-a1" />);

    fireEvent.click(await screen.findByRole("button", { name: "Edit & Respawn" }));
    await waitFor(() => {
      expect(
        screen.getAllByRole("button", { name: "Start voice recording" }).length,
      ).toBeGreaterThan(0);
    });
  });

  it("uses session title and sidecar suffix in the restored terminal header", async () => {
    window.history.replaceState(null, "", "/sessions/api-a1?terminal=api-a1--isolated-ui");
    vi.spyOn(global, "fetch").mockImplementation(async (input) => {
      const url = typeof input === "string" ? input : input.url;
      if (url === "/api/sessions/api-a1") {
        return new Response(
          JSON.stringify({
            ...sessionFixture(),
            sidecars: [{ name: "isolated-ui", alive: true }],
            slots: { title: "Fix auth header", links: [] },
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
      expect(screen.getByRole("dialog", { name: "Terminal api-a1" })).toBeInTheDocument();
      expect(
        screen.getByText("Direct terminal title Fix auth header • isolated-ui"),
      ).toBeInTheDocument();
    });
  });

  it("falls back to the agent when restored terminal suffix is empty", async () => {
    window.history.replaceState(null, "", "/sessions/api-a1?terminal=api-a1--");
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
      expect(screen.getByText("Direct terminal api-a1--")).toBeInTheDocument();
      expect(screen.getByText("Direct terminal title Fix auth")).toBeInTheDocument();
      expect(screen.queryByText("Direct terminal title Fix auth • ")).not.toBeInTheDocument();
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

  it("copies the session task and shows a toast", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    const fullPrompt = "Visible short title\n\nFull hidden prompt details";
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText },
    });

    vi.spyOn(global, "fetch").mockImplementation(async (input) => {
      const url = typeof input === "string" ? input : input.url;
      if (url === "/api/sessions/api-a1") {
        return new Response(JSON.stringify(sessionFixture({ prompt: fullPrompt })), {
          status: 200,
        });
      }
      if (url === "/api/runtime/voice") {
        return new Response(JSON.stringify({ available: false, modelPath: "" }), { status: 200 });
      }
      throw new Error(`Unexpected fetch: ${url}`);
    });

    render(<SessionDetail sessionId="api-a1" />);

    await screen.findByRole("button", { name: "Copy task" });
    fireEvent.click(screen.getByRole("button", { name: "Copy task" }));

    expect(writeText).toHaveBeenCalledWith(fullPrompt);
    expect(await screen.findByText("Task copied")).toBeInTheDocument();
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

  it("keeps other sidecar start buttons enabled while one sidecar is starting", async () => {
    let resolveDevStart: ((response: Response) => void) | null = null;
    const fetchMock = vi.spyOn(global, "fetch").mockImplementation(async (input, init) => {
      const url = typeof input === "string" ? input : input.url;
      if (url === "/api/sessions/api-a1") {
        return new Response(
          JSON.stringify({
            ...sessionFixture(),
            sidecars: [
              { name: "dev", alive: false },
              { name: "preview", alive: false },
            ],
          }),
          { status: 200 },
        );
      }
      if (url === "/api/runtime/voice") {
        return new Response(JSON.stringify({ available: false, modelPath: "" }), { status: 200 });
      }
      if (url === "/api/sessions/api-a1/sidecars/dev/start" && init?.method === "POST") {
        return new Promise<Response>((resolve) => {
          resolveDevStart = resolve;
        });
      }
      throw new Error(`Unexpected fetch: ${url}`);
    });

    render(<SessionDetail sessionId="api-a1" />);

    const devStart = await screen.findByRole("button", { name: "Start sidecar dev" });
    const previewStart = screen.getByRole("button", { name: "Start sidecar preview" });
    fireEvent.click(devStart);

    await waitFor(() => {
      expect(devStart).toBeDisabled();
    });
    expect(previewStart).toBeEnabled();

    resolveDevStart!(
      new Response(
        JSON.stringify({
          ...sessionFixture(),
          sidecars: [
            { name: "dev", alive: true },
            { name: "preview", alive: false },
          ],
        }),
        { status: 200 },
      ),
    );

    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Stop sidecar dev" })).toBeInTheDocument();
    });
    expect(previewStart).toBeEnabled();
    fetchMock.mockRestore();
  });

  it("shows sidecar port labels and clears a selected busy port", async () => {
    let resolveClearRetry: ((response: Response) => void) | null = null;
    const fetchMock = vi.spyOn(global, "fetch").mockImplementation(async (input, init) => {
      const url = typeof input === "string" ? input : input.url;
      if (url === "/api/sessions/api-a1") {
        return new Response(
          JSON.stringify({
            ...sessionFixture(),
            sidecars: [
              { name: "dev", alive: false, ports: [{ id: "http", env: "PORT", port: 3000 }] },
            ],
          }),
          { status: 200 },
        );
      }
      if (url === "/api/runtime/voice") {
        return new Response(JSON.stringify({ available: false, modelPath: "" }), { status: 200 });
      }
      if (url === "/api/sessions/api-a1/sidecars/dev/start" && init?.method === "POST") {
        if (!("body" in init)) {
          return new Response(
            JSON.stringify({
              code: "sidecar_port_busy",
              sidecarName: "dev",
              candidates: [
                {
                  portId: "http",
                  env: "PORT",
                  port: 3000,
                  owner: "api-other",
                },
              ],
            }),
            {
              status: 409,
              headers: { "content-type": "application/json" },
            },
          );
        }
        return await new Promise<Response>((resolve) => {
          resolveClearRetry = resolve;
        });
      }
      throw new Error(`Unexpected fetch: ${url}`);
    });

    render(<SessionDetail sessionId="api-a1" />);

    expect(await screen.findByText(":3000")).toBeInTheDocument();
    expect(screen.queryByText("offline")).not.toBeInTheDocument();
    expect(screen.queryByText("Port busy")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Start sidecar dev" }));

    const dialog = await screen.findByRole("dialog", { name: "Port busy" });
    expect(within(dialog).getByRole("combobox", { name: "Busy port for sidecar dev" })).toHaveValue(
      "3000",
    );
    expect(
      within(dialog).getByRole("option", { name: "http:3000 — api-other" }),
    ).toBeInTheDocument();

    fireEvent.click(within(dialog).getByRole("button", { name: "Clear/Retry" }));

    expect(within(dialog).getByRole("button", { name: "Clearing..." })).toBeDisabled();
    expect(
      within(dialog).getByRole("combobox", { name: "Busy port for sidecar dev" }),
    ).toBeDisabled();

    if (resolveClearRetry === null) {
      throw new Error("Expected clear retry request");
    }
    resolveClearRetry(
      new Response(
        JSON.stringify({
          ...sessionFixture(),
          sidecars: [
            { name: "dev", alive: true, ports: [{ id: "http", env: "PORT", port: 3000 }] },
          ],
        }),
        { status: 200 },
      ),
    );

    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Stop sidecar dev" })).toBeInTheDocument();
    });
    expect(fetchMock).toHaveBeenCalledWith("/api/sessions/api-a1/sidecars/dev/start", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ clearPort: 3000 }),
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

  it("renders the capped message tail delivered by a large-transcript response", async () => {
    const messages = Array.from({ length: 300 }, (_, index) => ({
      role: (index % 2 === 0 ? "user" : "assistant") as "user" | "assistant",
      text: `message-${index + 200}`,
      timestampMs: index + 1,
    }));

    vi.spyOn(global, "fetch").mockImplementation(async (input) => {
      const url = typeof input === "string" ? input : input.url;
      if (url === "/api/sessions/api-a1") {
        return new Response(JSON.stringify(sessionFixture()), { status: 200 });
      }
      if (url === "/api/sessions/api-a1/conversation") {
        return new Response(
          JSON.stringify(
            conversationFixture({ messages, totalMessages: 500, hasMore: true, state: "waiting" }),
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

    // Tail present, older-than-tail message absent (server dropped it).
    expect(screen.getByText("message-499")).toBeInTheDocument();
    expect(screen.getByText("message-200")).toBeInTheDocument();
    expect(screen.queryByText("message-199")).not.toBeInTheDocument();

    // Capped tail surfaces a count hint of returned vs total messages.
    expect(screen.getByText("showing last 300 of 500")).toBeInTheDocument();
  });

  it("omits the capped-tail count hint when the full transcript fits", async () => {
    vi.spyOn(global, "fetch").mockImplementation(async (input) => {
      const url = typeof input === "string" ? input : input.url;
      if (url === "/api/sessions/api-a1") {
        return new Response(JSON.stringify(sessionFixture()), { status: 200 });
      }
      if (url === "/api/sessions/api-a1/conversation") {
        return new Response(
          JSON.stringify(
            conversationFixture({ totalMessages: 2, hasMore: false, state: "waiting" }),
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

    expect(screen.queryByText(/showing last/i)).not.toBeInTheDocument();
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

  it("renders markdown in assistant dialog messages", async () => {
    vi.spyOn(global, "fetch").mockImplementation(async (input) => {
      const url = typeof input === "string" ? input : input.url;
      if (url === "/api/sessions/api-a1") {
        return new Response(JSON.stringify(sessionFixture()), { status: 200 });
      }
      if (url === "/api/sessions/api-a1/conversation") {
        return new Response(
          JSON.stringify(
            conversationFixture({
              messages: [
                { role: "user", text: "Show formatted output", timestampMs: 1 },
                {
                  role: "assistant",
                  text: [
                    "## Summary",
                    "",
                    "- first item",
                    "- second item",
                    "",
                    "`inline code`",
                    "",
                    "| Col | Value |",
                    "| --- | --- |",
                    "| A | B |",
                  ].join("\n"),
                  timestampMs: 2,
                },
              ],
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

    expect(await screen.findByRole("heading", { name: "Summary" })).toBeInTheDocument();
    expect(screen.getByText("first item")).toBeInTheDocument();
    expect(screen.getByText("inline code")).toHaveTextContent("inline code");
    expect(screen.getByRole("table")).toBeInTheDocument();
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

  it("clears the message composer from the corner button", async () => {
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

    const textarea = await screen.findByPlaceholderText(/^Message to the running agent\.\.\./);
    fireEvent.change(textarea, { target: { value: "Draft to clear" } });
    fireEvent.click(screen.getByRole("button", { name: "Clear message" }));

    expect(textarea).toHaveValue("");
    expect(textarea).toHaveFocus();
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

  it("hides automatic history snapshot links in the default agent view", async () => {
    vi.spyOn(global, "fetch").mockImplementation(async (input) => {
      const url = typeof input === "string" ? input : input.url;

      if (url === "/api/sessions/api-a1") {
        return new Response(
          JSON.stringify(
            sessionFixture({
              artifacts: [
                {
                  id: "agent-history-2026-04-02T10-01-00-000Z-waiting-to-needs_input.jsonl",
                  name: "agent-history-2026-04-02T10-01-00-000Z-waiting-to-needs_input.jsonl",
                  size: 2200,
                  mimeType: "application/octet-stream",
                  kind: "download",
                  origin: "automatic",
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
            {
              timestamp: "2026-04-02T10:01:10.000Z",
              event: "session.input.received",
              level: "info",
              message: "Fix the failing test",
              details: {
                inputKind: "send_message",
                source: "send_direct",
                text: "Fix the failing test",
                attachments: [{ id: "upload.png", name: "upload.png" }],
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
    expect(screen.getByText("User input")).toBeInTheDocument();
    expect(screen.getByText("send message")).toBeInTheDocument();
    expect(screen.getByText("Fix the failing test")).toBeInTheDocument();
    expect(screen.getByText("Attachment upload.png")).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: /history snapshot/i })).not.toBeInTheDocument();
  });

  it("shows automatic history snapshot links after switching to the system view", async () => {
    vi.spyOn(global, "fetch").mockImplementation(async (input) => {
      const url = typeof input === "string" ? input : input.url;

      if (url === "/api/sessions/api-a1") {
        return new Response(
          JSON.stringify(
            sessionFixture({
              artifacts: [
                {
                  id: "agent-output.txt",
                  name: "agent-output.txt",
                  size: 3200,
                  mimeType: "text/plain; charset=utf-8",
                  kind: "download",
                  origin: "intentional",
                  createdAt: "2026-04-02T10:00:00.000Z",
                  updatedAt: "2026-04-02T10:00:00.000Z",
                },
                {
                  id: "agent-history-2026-04-02T10-01-00-000Z-waiting-to-needs_input.jsonl",
                  name: "agent-history-2026-04-02T10-01-00-000Z-waiting-to-needs_input.jsonl",
                  size: 2200,
                  mimeType: "application/octet-stream",
                  kind: "download",
                  origin: "automatic",
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
      expect(screen.getByRole("button", { name: "System (1)" })).toBeInTheDocument();
    });

    fireEvent.click(screen.getByRole("button", { name: "System (1)" }));
    fireEvent.click(screen.getByRole("button", { name: /^logs$/i }));

    expect(await screen.findByText("Status transition")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /history snapshot/i })).toHaveAttribute(
      "href",
      "/api/sessions/api-a1/artifacts/agent-history-2026-04-02T10-01-00-000Z-waiting-to-needs_input.jsonl",
    );
  });

  it("keeps automatic history snapshot links hidden in the attached view", async () => {
    vi.spyOn(global, "fetch").mockImplementation(async (input) => {
      const url = typeof input === "string" ? input : input.url;

      if (url === "/api/sessions/api-a1") {
        return new Response(
          JSON.stringify(
            sessionFixture({
              artifacts: [
                {
                  id: "upload.png",
                  name: "upload.png",
                  size: 1400,
                  mimeType: "image/png",
                  kind: "image",
                  origin: "intentional",
                  addedByUser: true,
                  createdAt: "2026-04-02T10:00:00.000Z",
                  updatedAt: "2026-04-02T10:00:00.000Z",
                },
                {
                  id: "agent-history-2026-04-02T10-01-00-000Z-waiting-to-needs_input.jsonl",
                  name: "agent-history-2026-04-02T10-01-00-000Z-waiting-to-needs_input.jsonl",
                  size: 2200,
                  mimeType: "application/octet-stream",
                  kind: "download",
                  origin: "automatic",
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
      expect(screen.getByRole("button", { name: "Attached (1)" })).toBeInTheDocument();
    });

    fireEvent.click(screen.getByRole("button", { name: "Attached (1)" }));
    fireEvent.click(screen.getByRole("button", { name: /^logs$/i }));

    expect(await screen.findByText("Status transition")).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: /history snapshot/i })).not.toBeInTheDocument();
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
                  origin: "intentional",
                  createdAt: "2026-04-02T10:00:00.000Z",
                  updatedAt: "2026-04-02T10:00:00.000Z",
                },
                {
                  id: "run.webm",
                  name: "run.webm",
                  size: 2200,
                  mimeType: "video/webm",
                  kind: "video",
                  origin: "intentional",
                  createdAt: "2026-04-02T10:00:00.000Z",
                  updatedAt: "2026-04-02T10:00:00.000Z",
                },
                {
                  id: "trace.log",
                  name: "trace.log",
                  size: 3200,
                  mimeType: "text/plain; charset=utf-8",
                  kind: "download",
                  origin: "intentional",
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

    const dialog = await screen.findByRole("dialog", { name: "Artifact preview shot.png" });
    expect(dialog).toBeInTheDocument();

    expect(within(dialog).getByRole("link", { name: "Download shot.png" })).toHaveAttribute(
      "href",
      "/api/sessions/api-a1/artifacts/shot.png",
    );
  });

  it("navigates image, video, and file artifacts in session order from the lightbox", async () => {
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
                  origin: "intentional",
                  createdAt: "2026-04-02T10:00:00.000Z",
                  updatedAt: "2026-04-02T10:00:00.000Z",
                },
                {
                  id: "trace.log",
                  name: "trace.log",
                  size: 3200,
                  mimeType: "text/plain; charset=utf-8",
                  kind: "download",
                  origin: "intentional",
                  createdAt: "2026-04-02T10:00:00.000Z",
                  updatedAt: "2026-04-02T10:00:00.000Z",
                },
                {
                  id: "run.webm",
                  name: "run.webm",
                  size: 2200,
                  mimeType: "video/webm",
                  kind: "video",
                  origin: "intentional",
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
      expect(screen.getByRole("button", { name: "Preview shot.png" })).toBeInTheDocument();
    });

    fireEvent.click(screen.getByRole("button", { name: "Preview shot.png" }));
    expect(
      await screen.findByRole("dialog", { name: "Artifact preview shot.png" }),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Previous artifact" })).toBeDisabled();

    const previewSurface = screen.getByLabelText("Artifact preview surface");
    stubElementBounds(previewSurface);

    fireEvent.click(previewSurface, { clientX: 150 });
    expect(
      await screen.findByRole("dialog", { name: "Artifact preview trace.log" }),
    ).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Download File" })).toHaveAttribute(
      "href",
      "/api/sessions/api-a1/artifacts/trace.log",
    );
    const downloadLink = screen.getByRole("link", { name: "Download File" });
    downloadLink.addEventListener("click", (event) => event.preventDefault());
    fireEvent.click(downloadLink, { clientX: 150 });
    expect(
      await screen.findByRole("dialog", { name: "Artifact preview trace.log" }),
    ).toBeInTheDocument();

    fireEvent.click(screen.getByLabelText("Artifact preview surface"), { clientX: 50 });
    expect(
      await screen.findByRole("dialog", { name: "Artifact preview shot.png" }),
    ).toBeInTheDocument();

    fireEvent.keyDown(window, { key: "ArrowRight" });
    expect(
      await screen.findByRole("dialog", { name: "Artifact preview trace.log" }),
    ).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Next artifact" }));
    expect(
      await screen.findByRole("dialog", { name: "Artifact preview run.webm" }),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Next artifact" })).toBeDisabled();
    fireEvent.click(screen.getByLabelText("run.webm player"), { clientX: 50 });
    expect(
      await screen.findByRole("dialog", { name: "Artifact preview run.webm" }),
    ).toBeInTheDocument();

    fireEvent.keyDown(window, { key: "ArrowLeft" });
    expect(
      await screen.findByRole("dialog", { name: "Artifact preview trace.log" }),
    ).toBeInTheDocument();

    fireEvent.keyDown(window, { key: "Escape" });
    await waitFor(() => {
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    });
  });

  it("supports guarded swipe navigation on the artifact preview surface", async () => {
    vi.spyOn(global, "fetch").mockImplementation(async (input) => {
      const url = typeof input === "string" ? input : input.url;

      if (url === "/api/sessions/api-a1") {
        return new Response(
          JSON.stringify(
            sessionFixture({
              artifacts: [
                {
                  id: "first.png",
                  name: "first.png",
                  size: 1200,
                  mimeType: "image/png",
                  kind: "image",
                  origin: "intentional",
                  createdAt: "2026-04-02T10:00:00.000Z",
                  updatedAt: "2026-04-02T10:00:00.000Z",
                },
                {
                  id: "second.png",
                  name: "second.png",
                  size: 1200,
                  mimeType: "image/png",
                  kind: "image",
                  origin: "intentional",
                  createdAt: "2026-04-02T10:00:00.000Z",
                  updatedAt: "2026-04-02T10:00:00.000Z",
                },
                {
                  id: "third.png",
                  name: "third.png",
                  size: 1200,
                  mimeType: "image/png",
                  kind: "image",
                  origin: "intentional",
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
      expect(screen.getByRole("button", { name: "Preview first.png" })).toBeInTheDocument();
    });

    fireEvent.click(screen.getByRole("button", { name: "Preview first.png" }));
    expect(
      await screen.findByRole("dialog", { name: "Artifact preview first.png" }),
    ).toBeInTheDocument();

    const firstSurface = screen.getByLabelText("Artifact preview surface");
    firePreviewPointerEvent(firstSurface, "pointerdown", { clientX: 40, clientY: 20 });
    firePreviewPointerEvent(firstSurface, "pointerup", { clientX: 120, clientY: 24 });
    expect(
      await screen.findByRole("dialog", { name: "Artifact preview first.png" }),
    ).toBeInTheDocument();

    firePreviewPointerEvent(firstSurface, "pointerdown", { clientX: 160, clientY: 20 });
    firePreviewPointerEvent(firstSurface, "pointerup", { clientX: 90, clientY: 24 });
    expect(
      await screen.findByRole("dialog", { name: "Artifact preview second.png" }),
    ).toBeInTheDocument();

    const secondSurface = screen.getByLabelText("Artifact preview surface");
    firePreviewPointerEvent(secondSurface, "pointerdown", { clientX: 160, clientY: 20 });
    firePreviewPointerEvent(secondSurface, "pointerup", { clientX: 120, clientY: 24 });
    expect(
      await screen.findByRole("dialog", { name: "Artifact preview second.png" }),
    ).toBeInTheDocument();

    firePreviewPointerEvent(secondSurface, "pointerdown", { clientX: 160, clientY: 20 });
    firePreviewPointerEvent(secondSurface, "pointerup", { clientX: 90, clientY: 120 });
    expect(
      await screen.findByRole("dialog", { name: "Artifact preview second.png" }),
    ).toBeInTheDocument();

    firePreviewPointerEvent(secondSurface, "pointerdown", { clientX: 90, clientY: 20 });
    firePreviewPointerEvent(secondSurface, "pointerup", { clientX: 160, clientY: 24 });
    expect(
      await screen.findByRole("dialog", { name: "Artifact preview first.png" }),
    ).toBeInTheDocument();
  });

  it("keeps selected artifacts open across category changes and closes when the id disappears", async () => {
    let sessionPayload = sessionFixture({
      artifacts: [
        {
          id: "agent-output.txt",
          name: "agent-output.txt",
          size: 3200,
          mimeType: "text/plain; charset=utf-8",
          kind: "download",
          origin: "intentional",
          createdAt: "2026-04-02T10:00:00.000Z",
          updatedAt: "2026-04-02T10:00:00.000Z",
        },
        {
          id: "agent-history.jsonl",
          name: "agent-history.jsonl",
          size: 2200,
          mimeType: "application/octet-stream",
          kind: "download",
          origin: "automatic",
          createdAt: "2026-04-02T10:00:00.000Z",
          updatedAt: "2026-04-02T10:00:00.000Z",
        },
      ],
    });

    vi.spyOn(global, "fetch").mockImplementation(async (input) => {
      const url = typeof input === "string" ? input : input.url;

      if (url === "/api/sessions/api-a1") {
        return new Response(JSON.stringify(sessionPayload), { status: 200 });
      }

      if (url === "/api/sessions/api-a1/conversation") {
        return new Response(JSON.stringify(conversationFixture()), { status: 200 });
      }

      throw new Error(`Unexpected fetch: ${url}`);
    });

    render(<SessionDetail sessionId="api-a1" />);

    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Preview agent-output.txt" })).toBeInTheDocument();
    });

    fireEvent.click(screen.getByRole("button", { name: "Preview agent-output.txt" }));
    expect(
      await screen.findByRole("dialog", { name: "Artifact preview agent-output.txt" }),
    ).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "System (1)" }));
    expect(
      screen.getByRole("dialog", { name: "Artifact preview agent-output.txt" }),
    ).toBeInTheDocument();

    sessionPayload = sessionFixture({
      artifacts: [
        {
          id: "agent-history.jsonl",
          name: "agent-history.jsonl",
          size: 2200,
          mimeType: "application/octet-stream",
          kind: "download",
          origin: "automatic",
          createdAt: "2026-04-02T10:00:00.000Z",
          updatedAt: "2026-04-02T10:00:00.000Z",
        },
      ],
    });

    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 4_100));
    });

    await waitFor(() => {
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    });
  }, 12_000);

  it("hides system artifacts by default and shows them after toggling", async () => {
    vi.spyOn(global, "fetch").mockImplementation(async (input) => {
      const url = typeof input === "string" ? input : input.url;

      if (url === "/api/sessions/api-a1") {
        return new Response(
          JSON.stringify(
            sessionFixture({
              artifacts: [
                {
                  id: "agent-output.txt",
                  name: "agent-output.txt",
                  size: 3200,
                  mimeType: "text/plain; charset=utf-8",
                  kind: "download",
                  origin: "intentional",
                  createdAt: "2026-04-02T10:00:00.000Z",
                  updatedAt: "2026-04-02T10:00:00.000Z",
                },
                {
                  id: "agent-history.jsonl",
                  name: "agent-history.jsonl",
                  size: 2200,
                  mimeType: "application/octet-stream",
                  kind: "download",
                  origin: "automatic",
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
      expect(screen.getByText("agent-output.txt")).toBeInTheDocument();
    });

    expect(screen.queryByText("agent-history.jsonl")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Agent (1)" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );

    fireEvent.click(screen.getByRole("button", { name: "System (1)" }));

    await waitFor(() => {
      expect(screen.getByText("agent-history.jsonl")).toBeInTheDocument();
    });

    expect(screen.queryByText("agent-output.txt")).not.toBeInTheDocument();
  });

  it("shows user-added artifacts only in the attached view", async () => {
    vi.spyOn(global, "fetch").mockImplementation(async (input) => {
      const url = typeof input === "string" ? input : input.url;

      if (url === "/api/sessions/api-a1") {
        return new Response(
          JSON.stringify(
            sessionFixture({
              artifacts: [
                {
                  id: "agent-output.txt",
                  name: "agent-output.txt",
                  size: 3200,
                  mimeType: "text/plain; charset=utf-8",
                  kind: "download",
                  origin: "intentional",
                  createdAt: "2026-04-02T10:00:00.000Z",
                  updatedAt: "2026-04-02T10:00:00.000Z",
                },
                {
                  id: "later-upload.png",
                  name: "later-upload.png",
                  size: 2200,
                  mimeType: "image/png",
                  kind: "image",
                  origin: "intentional",
                  addedByUser: true,
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
      expect(screen.getByText("agent-output.txt")).toBeInTheDocument();
    });

    expect(screen.queryByText("later-upload.png")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Attached (1)" }));

    await waitFor(() => {
      expect(screen.getByText("later-upload.png")).toBeInTheDocument();
    });

    const attachedCard = screen.getByLabelText("Attached Image artifact later-upload.png");
    expect(attachedCard).toBeInTheDocument();
    expect(within(attachedCard).getByText("Attached Image")).toBeInTheDocument();
    expect(within(attachedCard).getByText("PNG", { exact: true })).toBeInTheDocument();
    expect(screen.queryByText("agent-output.txt")).not.toBeInTheDocument();
  });

  it("resets back to agent artifacts when switching to a new session", async () => {
    vi.spyOn(global, "fetch").mockImplementation(async (input) => {
      const url = typeof input === "string" ? input : input.url;

      if (url === "/api/sessions/api-a1") {
        return new Response(
          JSON.stringify(
            sessionFixture({
              id: "api-a1",
              artifacts: [
                {
                  id: "agent-a1.txt",
                  name: "agent-a1.txt",
                  size: 3200,
                  mimeType: "text/plain; charset=utf-8",
                  kind: "download",
                  origin: "intentional",
                  createdAt: "2026-04-02T10:00:00.000Z",
                  updatedAt: "2026-04-02T10:00:00.000Z",
                },
                {
                  id: "agent-history-a1.jsonl",
                  name: "agent-history-a1.jsonl",
                  size: 2200,
                  mimeType: "application/octet-stream",
                  kind: "download",
                  origin: "automatic",
                  createdAt: "2026-04-02T10:00:00.000Z",
                  updatedAt: "2026-04-02T10:00:00.000Z",
                },
              ],
            }),
          ),
          { status: 200 },
        );
      }

      if (url === "/api/sessions/api-b2") {
        return new Response(
          JSON.stringify(
            sessionFixture({
              id: "api-b2",
              artifacts: [
                {
                  id: "agent-b2.txt",
                  name: "agent-b2.txt",
                  size: 4200,
                  mimeType: "text/plain; charset=utf-8",
                  kind: "download",
                  origin: "intentional",
                  createdAt: "2026-04-02T10:00:00.000Z",
                  updatedAt: "2026-04-02T10:00:00.000Z",
                },
              ],
            }),
          ),
          { status: 200 },
        );
      }

      if (
        url === "/api/sessions/api-a1/conversation" ||
        url === "/api/sessions/api-b2/conversation"
      ) {
        return new Response(JSON.stringify(conversationFixture()), { status: 200 });
      }

      throw new Error(`Unexpected fetch: ${url}`);
    });

    const { rerender } = render(<SessionDetail sessionId="api-a1" />);

    await waitFor(() => {
      expect(screen.getByText("agent-a1.txt")).toBeInTheDocument();
    });

    fireEvent.click(screen.getByRole("button", { name: "System (1)" }));

    await waitFor(() => {
      expect(screen.getByText("agent-history-a1.jsonl")).toBeInTheDocument();
    });

    rerender(<SessionDetail sessionId="api-b2" />);

    await waitFor(() => {
      expect(screen.getByText("agent-b2.txt")).toBeInTheDocument();
    });

    expect(screen.queryByText("agent-history-a1.jsonl")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /system \(0\)/i })).not.toBeInTheDocument();
  });

  it("renders text artifacts with preview, lightbox fetch, copy, and oversize guard", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText },
    });

    let artifactFetchCount = 0;
    vi.spyOn(global, "fetch").mockImplementation(async (input) => {
      const url = typeof input === "string" ? input : input.url;

      if (url === "/api/sessions/api-a1") {
        return new Response(
          JSON.stringify(
            sessionFixture({
              artifacts: [
                {
                  id: "trace.log",
                  name: "trace.log",
                  size: 18,
                  mimeType: "text/plain; charset=utf-8",
                  kind: "text",
                  origin: "intentional",
                  createdAt: "2026-04-02T10:00:00.000Z",
                  updatedAt: "2026-04-02T10:00:00.000Z",
                },
                {
                  id: "huge.txt",
                  name: "huge.txt",
                  size: 1024 * 1024 + 1,
                  mimeType: "text/plain; charset=utf-8",
                  kind: "text",
                  origin: "intentional",
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

      if (url === "/api/sessions/api-a1/artifacts/trace.log") {
        artifactFetchCount += 1;
        return new Response("line one\nline two", {
          status: 200,
          headers: { "content-type": "text/plain; charset=utf-8" },
        });
      }

      if (url === "/api/sessions/api-a1/artifacts/huge.txt") {
        throw new Error("Oversize text artifact should not be fetched");
      }

      throw new Error(`Unexpected fetch: ${url}`);
    });

    render(<SessionDetail sessionId="api-a1" />);

    await waitFor(() => {
      expect(screen.getByText("trace.log")).toBeInTheDocument();
    });

    const traceCard = screen.getByLabelText("text artifact trace.log");
    expect(within(traceCard).getByText("LOG", { exact: true })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Preview trace.log" })).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Preview trace.log" }));

    await waitFor(() => {
      expect(
        screen.getByRole("dialog", { name: "Artifact preview trace.log" }),
      ).toBeInTheDocument();
    });
    await waitFor(() => {
      expect(artifactFetchCount).toBe(1);
    });
    expect(await screen.findByText(/line one\s+line two/)).toBeInTheDocument();

    const previewSurface = screen.getByLabelText("Artifact preview surface");
    stubElementBounds(previewSurface);
    fireEvent.click(screen.getByText(/line one\s+line two/), { clientX: 150 });
    expect(screen.getByRole("dialog", { name: "Artifact preview trace.log" })).toBeInTheDocument();

    const taggedTarget = document.createElement("span");
    taggedTarget.dataset.artifactLightboxInteractive = "true";
    previewSurface.append(taggedTarget);
    fireEvent.click(taggedTarget, { clientX: 150 });
    expect(screen.getByRole("dialog", { name: "Artifact preview trace.log" })).toBeInTheDocument();

    const getSelectionSpy = vi.spyOn(window, "getSelection").mockReturnValue({
      isCollapsed: false,
      toString: () => "line one",
    } as unknown as Selection);
    fireEvent.click(previewSurface, { clientX: 150 });
    expect(screen.getByRole("dialog", { name: "Artifact preview trace.log" })).toBeInTheDocument();
    getSelectionSpy.mockRestore();

    fireEvent.click(screen.getByRole("button", { name: "Copy trace.log" }));
    expect(writeText).toHaveBeenCalledWith("line one\nline two");
    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Copy trace.log" })).toHaveTextContent("Copied");
    });

    fireEvent.click(screen.getByRole("button", { name: "Close artifact preview" }));

    fireEvent.click(screen.getByRole("button", { name: "Preview huge.txt" }));

    await waitFor(() => {
      expect(screen.getByRole("dialog", { name: "Artifact preview huge.txt" })).toBeInTheDocument();
    });
    expect(
      screen.getByText("File exceeds 1 MiB preview limit. Download to view the full content."),
    ).toBeInTheDocument();
    expect(artifactFetchCount).toBe(1);
  });

  it("previews json, markdown, and download-only files", async () => {
    vi.spyOn(global, "fetch").mockImplementation(async (input) => {
      const url = typeof input === "string" ? input : input.url;

      if (url === "/api/sessions/api-a1") {
        return new Response(
          JSON.stringify(
            sessionFixture({
              artifacts: [
                {
                  id: "config.json",
                  name: "config.json",
                  size: 12,
                  mimeType: "application/json",
                  kind: "text",
                  origin: "intentional",
                  createdAt: "2026-04-02T10:00:00.000Z",
                  updatedAt: "2026-04-02T10:00:00.000Z",
                },
                {
                  id: "readme.md",
                  name: "readme.md",
                  size: 14,
                  mimeType: "text/markdown; charset=utf-8",
                  kind: "text",
                  origin: "intentional",
                  createdAt: "2026-04-02T10:00:00.000Z",
                  updatedAt: "2026-04-02T10:00:00.000Z",
                },
                {
                  id: "archive.zip",
                  name: "archive.zip",
                  size: 4096,
                  mimeType: "application/octet-stream",
                  kind: "download",
                  origin: "intentional",
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

      if (url === "/api/sessions/api-a1/artifacts/config.json") {
        return new Response('{"ok":true}', {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }

      if (url === "/api/sessions/api-a1/artifacts/readme.md") {
        return new Response("# Title", {
          status: 200,
          headers: { "content-type": "text/markdown; charset=utf-8" },
        });
      }

      throw new Error(`Unexpected fetch: ${url}`);
    });

    render(<SessionDetail sessionId="api-a1" />);

    await waitFor(() => {
      expect(screen.getByText("config.json")).toBeInTheDocument();
    });

    expect(screen.getByRole("button", { name: "Preview config.json" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Preview readme.md" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Preview archive.zip" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Download archive.zip" })).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Preview config.json" }));
    await waitFor(() => {
      expect(screen.getByText('{"ok":true}')).toBeInTheDocument();
    });

    fireEvent.click(screen.getByRole("button", { name: "Close artifact preview" }));

    fireEvent.click(screen.getByRole("button", { name: "Preview readme.md" }));
    await waitFor(() => {
      expect(screen.getByText("# Title")).toBeInTheDocument();
    });

    fireEvent.click(screen.getByRole("button", { name: "Close artifact preview" }));

    fireEvent.click(screen.getByRole("button", { name: "Preview archive.zip" }));
    expect(
      screen.getByRole("dialog", { name: "Artifact preview archive.zip" }),
    ).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Download File" })).toHaveAttribute(
      "href",
      "/api/sessions/api-a1/artifacts/archive.zip",
    );
  });

  it("self-heals back to agent artifacts when system artifacts disappear on refresh", async () => {
    let sessionPayload = sessionFixture({
      artifacts: [
        {
          id: "agent-output.txt",
          name: "agent-output.txt",
          size: 3200,
          mimeType: "text/plain; charset=utf-8",
          kind: "download",
          origin: "intentional",
          createdAt: "2026-04-02T10:00:00.000Z",
          updatedAt: "2026-04-02T10:00:00.000Z",
        },
        {
          id: "agent-history.jsonl",
          name: "agent-history.jsonl",
          size: 2200,
          mimeType: "application/octet-stream",
          kind: "download",
          origin: "automatic",
          createdAt: "2026-04-02T10:00:00.000Z",
          updatedAt: "2026-04-02T10:00:00.000Z",
        },
      ],
    });

    vi.spyOn(global, "fetch").mockImplementation(async (input) => {
      const url = typeof input === "string" ? input : input.url;

      if (url === "/api/sessions/api-a1") {
        return new Response(JSON.stringify(sessionPayload), { status: 200 });
      }

      if (url === "/api/sessions/api-a1/conversation") {
        return new Response(JSON.stringify(conversationFixture()), { status: 200 });
      }

      throw new Error(`Unexpected fetch: ${url}`);
    });

    render(<SessionDetail sessionId="api-a1" />);

    await waitFor(() => {
      expect(screen.getByText("agent-output.txt")).toBeInTheDocument();
    });

    fireEvent.click(screen.getByRole("button", { name: "System (1)" }));

    await waitFor(() => {
      expect(screen.getByText("agent-history.jsonl")).toBeInTheDocument();
    });

    sessionPayload = sessionFixture({
      artifacts: [
        {
          id: "agent-output.txt",
          name: "agent-output.txt",
          size: 3200,
          mimeType: "text/plain; charset=utf-8",
          kind: "download",
          origin: "intentional",
          createdAt: "2026-04-02T10:00:00.000Z",
          updatedAt: "2026-04-02T10:00:00.000Z",
        },
      ],
    });

    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 4_100));
    });

    await waitFor(() => {
      expect(screen.getByText("agent-output.txt")).toBeInTheDocument();
    });

    expect(screen.queryByText("agent-history.jsonl")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /system \(/i })).not.toBeInTheDocument();
  }, 12_000);
});

describe("SessionDetail load state", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  beforeEach(() => {
    vi.restoreAllMocks();
    pushMock.mockReset();
    replaceMock.mockReset();
    backMock.mockReset();
    window.localStorage.clear();
    window.history.replaceState(null, "", "/sessions/api-a1");
  });

  it("shows a page load error instead of stale content when the current session fails", async () => {
    vi.spyOn(global, "fetch").mockImplementation(async (input) => {
      const url = typeof input === "string" ? input : input.url;

      if (url === "/api/sessions/api-a1") {
        return new Response(JSON.stringify(sessionFixture()), { status: 200 });
      }

      if (url === "/api/sessions/api-b2") {
        return new Response(JSON.stringify({ error: "missing current session" }), {
          headers: { "content-type": "application/json" },
          status: 404,
        });
      }

      if (
        url === "/api/sessions/api-a1/conversation" ||
        url === "/api/sessions/api-b2/conversation"
      ) {
        return new Response(JSON.stringify(conversationFixture()), { status: 200 });
      }

      throw new Error(`Unexpected fetch: ${url}`);
    });

    const { rerender } = render(<SessionDetail sessionId="api-a1" />);

    await waitFor(() => {
      expect(screen.getByRole("heading", { name: "Fix auth" })).toBeInTheDocument();
    });

    rerender(<SessionDetail sessionId="api-b2" />);

    await waitFor(() => {
      expect(screen.getByText("Unable to load this session.")).toBeInTheDocument();
    });
    expect(screen.getByText("missing current session")).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Fix auth" })).not.toBeInTheDocument();
  });

  it("ignores stale session responses after navigation", async () => {
    let resolveFirstSession: ((response: Response) => void) | null = null;
    const firstSessionResponse = new Promise<Response>((resolve) => {
      resolveFirstSession = resolve;
    });

    vi.spyOn(global, "fetch").mockImplementation((input) => {
      const url = typeof input === "string" ? input : input.url;

      if (url === "/api/sessions/api-a1") {
        return firstSessionResponse;
      }

      if (url === "/api/sessions/api-b2") {
        return Promise.resolve(
          new Response(JSON.stringify(sessionFixture({ id: "api-b2", prompt: "Second session" })), {
            status: 200,
          }),
        );
      }

      if (
        url === "/api/sessions/api-a1/conversation" ||
        url === "/api/sessions/api-b2/conversation"
      ) {
        return Promise.resolve(
          new Response(JSON.stringify(conversationFixture()), { status: 200 }),
        );
      }

      return Promise.reject(new Error(`Unexpected fetch: ${url}`));
    });

    const { rerender } = render(<SessionDetail sessionId="api-a1" />);
    rerender(<SessionDetail sessionId="api-b2" />);

    await waitFor(() => {
      expect(screen.getByRole("heading", { name: "Second session" })).toBeInTheDocument();
    });

    await act(async () => {
      if (!resolveFirstSession) throw new Error("Missing api-a1 resolver");
      resolveFirstSession(
        new Response(JSON.stringify(sessionFixture({ prompt: "Stale first session" })), {
          status: 200,
        }),
      );
      await firstSessionResponse;
    });

    expect(screen.getByRole("heading", { name: "Second session" })).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Stale first session" })).not.toBeInTheDocument();
  });

  it("dismisses a load-error toast after a successful reload", async () => {
    let sessionRequests = 0;
    vi.spyOn(global, "fetch").mockImplementation(async (input) => {
      const url = typeof input === "string" ? input : input.url;

      if (url === "/api/sessions/api-a1") {
        sessionRequests += 1;
        if (sessionRequests === 2) {
          return new Response("temporary failure", { status: 502 });
        }
        return new Response(JSON.stringify(sessionFixture()), { status: 200 });
      }

      if (url === "/api/sessions/api-a1/pause") {
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      }

      if (url === "/api/sessions/api-a1/conversation") {
        return new Response(JSON.stringify(conversationFixture()), { status: 200 });
      }

      throw new Error(`Unexpected fetch: ${url}`);
    });

    render(<SessionDetail sessionId="api-a1" />);

    await waitFor(() => {
      expect(screen.getByRole("heading", { name: "Fix auth" })).toBeInTheDocument();
    });

    fireEvent.click(screen.getByRole("button", { name: "Pause" }));

    await waitFor(() => {
      expect(screen.getAllByText("temporary failure").length).toBeGreaterThan(0);
    });

    fireEvent.click(screen.getByRole("button", { name: "Pause" }));

    await waitFor(() => {
      expect(screen.queryByText("temporary failure")).not.toBeInTheDocument();
    });
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
    const container = heading.closest("header");
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
    stubFetch({ status: "stopped", state: "stopped" }, "working");
    render(<SessionDetail sessionId="api-a1" />);
    await expectStateBadge("stopped");
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

describe("SessionDetail document title", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    pushMock.mockReset();
    replaceMock.mockReset();
    backMock.mockReset();
    window.localStorage.clear();
    window.history.replaceState(null, "", "/sessions/api-a1");
    document.title = "Server metadata title";
  });

  it("keeps server metadata while loading then syncs the loaded task title", async () => {
    let resolveSession: (response: Response) => void = () => undefined;
    const sessionResponse = new Promise<Response>((resolve) => {
      resolveSession = resolve;
    });

    vi.spyOn(global, "fetch").mockImplementation(async (input) => {
      const url = typeof input === "string" ? input : input.url;
      if (url === "/api/sessions/api-a1") {
        return sessionResponse;
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

    expect(document.title).toBe("Server metadata title");

    resolveSession(
      new Response(
        JSON.stringify(sessionFixture({ slots: { title: "Loaded task title", links: [] } })),
        { status: 200 },
      ),
    );

    await waitFor(() => {
      expect(document.title).toBe("Loaded task title");
    });
  });

  it("sets decoded session id only after a missing session error", async () => {
    vi.spyOn(global, "fetch").mockImplementation(async (input) => {
      const url = typeof input === "string" ? input : input.url;
      if (url === "/api/sessions/api-a1") {
        return new Response(JSON.stringify({ error: "Session not found" }), {
          status: 404,
          headers: { "content-type": "application/json" },
        });
      }
      if (url === "/api/runtime/voice") {
        return new Response(JSON.stringify({ available: false, modelPath: "" }), { status: 200 });
      }
      throw new Error(`Unexpected fetch: ${url}`);
    });

    render(<SessionDetail sessionId="api-a1" />);

    expect(document.title).toBe("Server metadata title");

    await waitFor(() => {
      expect(document.title).toBe("api-a1");
    });
  });
});

describe("SessionDetail links", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    pushMock.mockReset();
    replaceMock.mockReset();
    backMock.mockReset();
    window.localStorage.clear();
    window.history.replaceState(null, "", "/sessions/api-a1");
  });

  it("keeps surfaced review and tracker URLs out of the Links section", async () => {
    const githubUrl = "https://github.com/test/repo/pull/42";
    const gitlabUrl = "https://gitlab.com/test/repo/-/merge_requests/7";
    const trackerUrl = "https://jira.example.com/browse/WEBDEV-4617";
    const docsUrl = "https://example.com/docs";

    vi.spyOn(global, "fetch").mockImplementation(async (input) => {
      const url = typeof input === "string" ? input : input.url;
      if (url === "/api/sessions/api-a1") {
        return new Response(
          JSON.stringify(
            sessionFixture({
              slots: {
                title: "Linked session",
                links: [
                  { label: "github-pr", url: githubUrl },
                  { label: "docs", url: githubUrl },
                  { label: "gitlab-pr", url: gitlabUrl },
                  { label: "docs", url: gitlabUrl },
                  { label: "tracker", url: trackerUrl },
                  { label: "docs", url: trackerUrl },
                  { label: "docs", url: docsUrl },
                ],
              },
            }),
          ),
          { status: 200 },
        );
      }
      if (url === "/api/sessions/api-a1/conversation") {
        return new Response(JSON.stringify(conversationFixture()), { status: 200 });
      }
      if (url === "/api/runtime/voice") {
        return new Response(JSON.stringify({ available: false, modelPath: "" }), { status: 200 });
      }
      if (url.startsWith("/api/pr-status?url=")) {
        return new Response(
          JSON.stringify({
            state: "open",
            reviewDecision: "approved",
            ciStatus: "success",
            totalThreads: 0,
            unresolvedThreads: 0,
            canMerge: false,
          }),
          { status: 200 },
        );
      }
      throw new Error(`Unexpected fetch: ${url}`);
    });

    render(<SessionDetail sessionId="api-a1" />);

    await waitFor(() => {
      expect(screen.getByRole("link", { name: "docs" })).toHaveAttribute("href", docsUrl);
    });

    const links = screen.getAllByRole("link");
    expect(links.filter((link) => link.getAttribute("href") === githubUrl)).toHaveLength(1);
    expect(links.filter((link) => link.getAttribute("href") === gitlabUrl)).toHaveLength(1);
    expect(links.filter((link) => link.getAttribute("href") === trackerUrl)).toHaveLength(1);
    expect(links.filter((link) => link.getAttribute("href") === docsUrl)).toHaveLength(1);
    expect(screen.queryByRole("link", { name: "github pr" })).not.toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "gitlab mr" })).not.toBeInTheDocument();
  });

  it("shows a canonical PR URL only in the header badge strip", async () => {
    const githubUrl = "https://github.com/test/repo/pull/42";

    vi.spyOn(global, "fetch").mockImplementation(async (input) => {
      const url = typeof input === "string" ? input : input.url;
      if (url === "/api/sessions/api-a1") {
        return new Response(
          JSON.stringify(
            sessionFixture({
              slots: {
                title: "Canonical PR session",
                links: [{ label: "github-pr", url: githubUrl }],
              },
            }),
          ),
          { status: 200 },
        );
      }
      if (url === "/api/sessions/api-a1/conversation") {
        return new Response(JSON.stringify(conversationFixture()), { status: 200 });
      }
      if (url === "/api/runtime/voice") {
        return new Response(JSON.stringify({ available: false, modelPath: "" }), { status: 200 });
      }
      if (url.startsWith("/api/pr-status?url=")) {
        return new Response(
          JSON.stringify({
            state: "open",
            reviewDecision: "approved",
            ciStatus: "success",
            totalThreads: 0,
            unresolvedThreads: 0,
            canMerge: false,
          }),
          { status: 200 },
        );
      }
      throw new Error(`Unexpected fetch: ${url}`);
    });

    render(<SessionDetail sessionId="api-a1" />);

    await waitFor(() => {
      expect(
        screen.getAllByRole("link").filter((link) => link.getAttribute("href") === githubUrl),
      ).toHaveLength(1);
    });

    expect(screen.queryByRole("heading", { name: "Links" })).not.toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "github pr" })).not.toBeInTheDocument();
  });

  it("shows Recover instead of Restore when the workspace is gone and opens the dialog", async () => {
    vi.spyOn(global, "fetch").mockImplementation(async (input) => {
      const url = typeof input === "string" ? input : input.url;
      if (url === "/api/sessions/api-a1") {
        return new Response(
          JSON.stringify(
            sessionFixture({
              status: "errored",
              state: "error",
              runtimeAlive: false,
              workspaceExists: false,
            }),
          ),
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

    const recoverButton = await screen.findByRole("button", { name: "Recover" });
    expect(screen.queryByRole("button", { name: "Restore" })).not.toBeInTheDocument();

    fireEvent.click(recoverButton);

    expect(screen.getByRole("dialog", { name: "Recover Session" })).toBeInTheDocument();
    expect(screen.getByText("Session api-a1 is not restorable")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Force Kill" })).toBeInTheDocument();
    // Parity with daemon restore() availableActions for an errored session: respawn offered.
    expect(screen.getByRole("button", { name: "Respawn" })).toBeInTheDocument();
  });

  it("opens the recover dialog when restore returns a 409 not-restorable conflict", async () => {
    vi.spyOn(global, "fetch").mockImplementation(async (input) => {
      const url = typeof input === "string" ? input : input.url;
      if (url === "/api/sessions/api-a1") {
        return new Response(
          JSON.stringify(
            sessionFixture({ status: "stopped", state: "stopped", runtimeAlive: false }),
          ),
          { status: 200 },
        );
      }
      if (url === "/api/sessions/api-a1/conversation") {
        return new Response(JSON.stringify(conversationFixture()), { status: 200 });
      }
      if (url === "/api/runtime/voice") {
        return new Response(JSON.stringify({ available: false, modelPath: "" }), { status: 200 });
      }
      if (url === "/api/sessions/api-a1/restore") {
        return new Response(
          JSON.stringify({
            code: "session_not_restorable",
            sessionId: "api-a1",
            reason: "Session api-a1 is not restorable",
            availableActions: ["force_kill", "respawn"],
          }),
          { status: 409 },
        );
      }
      throw new Error(`Unexpected fetch: ${url}`);
    });

    render(<SessionDetail sessionId="api-a1" />);

    fireEvent.click(await screen.findByRole("button", { name: "Restore" }));

    await waitFor(() => {
      expect(screen.getByRole("dialog", { name: "Recover Session" })).toBeInTheDocument();
    });
    expect(screen.getByText("Session api-a1 is not restorable")).toBeInTheDocument();
  });

  it("force kills the session from the recover dialog", async () => {
    let killBody: Record<string, unknown> | null = null;
    vi.spyOn(global, "fetch").mockImplementation(async (input, init) => {
      const url = typeof input === "string" ? input : input.url;
      if (url === "/api/sessions/api-a1") {
        return new Response(
          JSON.stringify(
            sessionFixture({
              status: "errored",
              state: "error",
              runtimeAlive: false,
              workspaceExists: false,
            }),
          ),
          { status: 200 },
        );
      }
      if (url === "/api/sessions/api-a1/conversation") {
        return new Response(JSON.stringify(conversationFixture()), { status: 200 });
      }
      if (url === "/api/runtime/voice") {
        return new Response(JSON.stringify({ available: false, modelPath: "" }), { status: 200 });
      }
      if (url === "/api/sessions/api-a1/kill" && init?.method === "POST") {
        killBody = JSON.parse(String(init.body)) as Record<string, unknown>;
        return new Response(JSON.stringify({ ...sessionFixture(), status: "killed" }), {
          status: 200,
        });
      }
      throw new Error(`Unexpected fetch: ${url}`);
    });

    render(<SessionDetail sessionId="api-a1" />);

    fireEvent.click(await screen.findByRole("button", { name: "Recover" }));
    fireEvent.click(screen.getByRole("button", { name: "Force Kill" }));

    await waitFor(() => {
      expect(killBody).toEqual({ force: true });
    });
  });

  it("clears the recover dialog once an open-PR force kill resolves", async () => {
    let killCalls = 0;
    vi.spyOn(global, "fetch").mockImplementation(async (input, init) => {
      const url = typeof input === "string" ? input : input.url;
      if (url === "/api/sessions/api-a1") {
        return new Response(
          JSON.stringify(
            sessionFixture({
              status: "errored",
              state: "error",
              runtimeAlive: false,
              workspaceExists: false,
            }),
          ),
          { status: 200 },
        );
      }
      if (url === "/api/sessions/api-a1/conversation") {
        return new Response(JSON.stringify(conversationFixture()), { status: 200 });
      }
      if (url === "/api/runtime/voice") {
        return new Response(JSON.stringify({ available: false, modelPath: "" }), { status: 200 });
      }
      if (url === "/api/sessions/api-a1/kill" && init?.method === "POST") {
        killCalls += 1;
        if (killCalls === 1) {
          return new Response(
            JSON.stringify({
              code: "open_pr_action_required",
              sessionId: "api-a1",
              pr: { number: 7, title: "Open PR", url: "https://example.com/pr/7" },
            }),
            { status: 409 },
          );
        }
        return new Response(JSON.stringify({ ...sessionFixture(), status: "killed" }), {
          status: 200,
        });
      }
      throw new Error(`Unexpected fetch: ${url}`);
    });

    render(<SessionDetail sessionId="api-a1" />);

    fireEvent.click(await screen.findByRole("button", { name: "Recover" }));
    fireEvent.click(screen.getByRole("button", { name: "Force Kill" }));

    await waitFor(() => {
      expect(screen.getByRole("dialog", { name: "Open Pull Request" })).toBeInTheDocument();
    });

    fireEvent.click(screen.getByRole("button", { name: "Leave Pull Request Open" }));

    await waitFor(() => {
      expect(screen.queryByRole("dialog", { name: "Recover Session" })).not.toBeInTheDocument();
      expect(screen.queryByRole("dialog", { name: "Open Pull Request" })).not.toBeInTheDocument();
    });
  });

  it("kills then opens the respawn editor from the recover dialog", async () => {
    let killed = false;
    vi.spyOn(global, "fetch").mockImplementation(async (input, init) => {
      const url = typeof input === "string" ? input : input.url;
      if (url === "/api/sessions/api-a1") {
        return new Response(
          JSON.stringify(
            sessionFixture({
              status: "errored",
              state: "error",
              runtimeAlive: false,
              workspaceExists: false,
            }),
          ),
          { status: 200 },
        );
      }
      if (url === "/api/sessions/api-a1/conversation") {
        return new Response(JSON.stringify(conversationFixture()), { status: 200 });
      }
      if (url === "/api/runtime/voice") {
        return new Response(JSON.stringify({ available: false, modelPath: "" }), { status: 200 });
      }
      if (url === "/api/sessions/api-a1/kill" && init?.method === "POST") {
        killed = true;
        return new Response(JSON.stringify({ ...sessionFixture(), status: "killed" }), {
          status: 200,
        });
      }
      throw new Error(`Unexpected fetch: ${url}`);
    });

    render(<SessionDetail sessionId="api-a1" />);

    fireEvent.click(await screen.findByRole("button", { name: "Recover" }));
    fireEvent.click(screen.getByRole("button", { name: "Respawn" }));

    await waitFor(() => {
      expect(killed).toBe(true);
      expect(screen.getByPlaceholderText("Edit the initial message...")).toBeInTheDocument();
    });
  });
});

describe("SessionDetail GitHub PR check unavailable", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    pushMock.mockReset();
    replaceMock.mockReset();
    backMock.mockReset();
    window.localStorage.clear();
    window.history.replaceState(null, "", "/sessions/api-a1");
  });

  it("shows the rate-limit dialog and resends complete with skipPrCheck when skipping", async () => {
    const completeBodies: Array<unknown> = [];
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
      if (url === "/api/sessions/api-a1/complete" && init?.method === "POST") {
        const body = init.body ? JSON.parse(String(init.body)) : {};
        completeBodies.push(body);
        if (body.skipPrCheck === true) {
          return new Response(JSON.stringify({ ...sessionFixture(), status: "completed" }), {
            status: 200,
          });
        }
        return new Response(
          JSON.stringify({
            code: "github_pr_check_unavailable",
            sessionId: "api-a1",
            rateLimited: true,
            pr: {
              number: 42,
              repo: "test/repo",
              url: "https://github.com/test/repo/pull/42",
            },
          }),
          { status: 409 },
        );
      }
      throw new Error(`Unexpected fetch: ${url}`);
    });

    render(<SessionDetail sessionId="api-a1" />);

    fireEvent.click(await screen.findByRole("button", { name: "Complete" }));

    await waitFor(() => {
      expect(
        screen.getByRole("dialog", { name: "GitHub PR Check Unavailable" }),
      ).toBeInTheDocument();
    });

    fireEvent.click(screen.getByRole("button", { name: "Skip PR Check & Proceed" }));

    await waitFor(() => {
      expect(
        screen.queryByRole("dialog", { name: "GitHub PR Check Unavailable" }),
      ).not.toBeInTheDocument();
    });

    expect(completeBodies).toEqual([{}, { skipPrCheck: true }]);
  });
});
