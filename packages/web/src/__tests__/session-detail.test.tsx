import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { SessionDetail } from "@/components/SessionDetail";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), back: vi.fn() }),
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
    slots: {
      links: [],
    },
  };
}

describe("SessionDetail voice input", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
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
      expect(
        screen.getByRole("button", { name: "Start voice recording" }),
      ).toBeInTheDocument();
    });

    fireEvent.click(screen.getByRole("button", { name: "Start voice recording" }));

    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Stop voice recording" })).toBeInTheDocument();
    });

    fireEvent.click(screen.getByRole("button", { name: "Stop voice recording" }));

    await waitFor(() => {
      expect(
        screen.getByDisplayValue("Fix the flaky tests before release"),
      ).toBeInTheDocument();
    });

    expect(screen.queryByRole("dialog", { name: "Confirm voice input" })).not.toBeInTheDocument();

    expect(fetchMock).toHaveBeenCalledWith(
      "/api/runtime/voice/transcribe",
      expect.objectContaining({ method: "POST" }),
    );
    expect(fetchMock).not.toHaveBeenCalledWith(
      "/api/sessions/api-a1/send",
      expect.anything(),
    );
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
      expect(
        screen.getByRole("button", { name: "Start voice recording" }),
      ).toBeInTheDocument();
    });

    fireEvent.click(screen.getByRole("button", { name: "Start voice recording" }));
    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Stop voice recording" })).toBeInTheDocument();
    });

    fireEvent.click(screen.getByRole("button", { name: "Stop voice recording" }));

    await waitFor(() => {
      expect(
        screen.getByText("Voice recording captured no audio. Check your microphone input and try again."),
      ).toBeInTheDocument();
    });

    expect(fetchMock).not.toHaveBeenCalledWith(
      "/api/runtime/voice/transcribe",
      expect.anything(),
    );
  });

  it("shows the transcribe API error message instead of a raw JSON blob", async () => {
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
      expect(
        screen.getByRole("button", { name: "Start voice recording" }),
      ).toBeInTheDocument();
    });

    fireEvent.click(screen.getByRole("button", { name: "Start voice recording" }));
    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Stop voice recording" })).toBeInTheDocument();
    });

    fireEvent.click(screen.getByRole("button", { name: "Stop voice recording" }));

    await waitFor(() => {
      expect(screen.getByText("Voice API unavailable")).toBeInTheDocument();
    });
    expect(screen.queryByText('{"error":"Voice API unavailable"}')).not.toBeInTheDocument();
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
});
