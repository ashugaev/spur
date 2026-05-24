import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useVoiceInput } from "@/hooks/useVoiceInput";

class MockMediaRecorder {
  mimeType = "audio/webm";
  state: "inactive" | "recording" = "inactive";
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

  emit(type: string, data?: Blob) {
    for (const listener of this.listeners.get(type) ?? []) {
      listener(data ? { data } : undefined);
    }
  }
}

function stubMediaEnvironment() {
  vi.stubGlobal("MediaRecorder", MockMediaRecorder as unknown as typeof MediaRecorder);
  Object.defineProperty(global.navigator, "mediaDevices", {
    configurable: true,
    value: {
      getUserMedia: vi.fn().mockResolvedValue({
        getTracks: () => [{ stop: vi.fn() }],
      }),
    },
  });
}

function buildFetch(transcript: string | null, opts?: { httpStatus?: number }) {
  return vi.spyOn(global, "fetch").mockImplementation(async (input, init) => {
    const url = typeof input === "string" ? input : (input as Request).url;
    if (url === "/api/runtime/voice") {
      return new Response(JSON.stringify({ available: true, language: "auto" }), {
        status: 200,
      });
    }
    if (url === "/api/runtime/voice/transcribe" && init?.method === "POST") {
      if (transcript === null) {
        return new Response(JSON.stringify({ error: "boom" }), {
          status: opts?.httpStatus ?? 400,
        });
      }
      return new Response(JSON.stringify({ text: transcript }), { status: 200 });
    }
    throw new Error(`Unexpected fetch: ${url}`);
  });
}

describe("useVoiceInput", () => {
  beforeEach(() => {
    stubMediaEnvironment();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("stopAndSend invokes callback with transcript and skips modal (Case A)", async () => {
    buildFetch("hello world");
    const send = vi.fn();
    const { result } = renderHook(() => useVoiceInput());

    await waitFor(() => expect(result.current.canUseVoice).toBe(true));

    await act(async () => {
      result.current.toggleRecording();
    });
    await waitFor(() => expect(result.current.recording).toBe(true));

    await act(async () => {
      result.current.stopAndSend(send);
    });

    await waitFor(() => expect(send).toHaveBeenCalledWith("hello world"));
    expect(result.current.voiceModalOpen).toBe(false);
    expect(result.current.voiceDraft).toBe("");
  });

  it("stopAndSend on transcribe error sets error and clears callback (Case B)", async () => {
    const fetchMock = buildFetch(null, { httpStatus: 400 });
    const send = vi.fn();
    const { result } = renderHook(() => useVoiceInput());

    await waitFor(() => expect(result.current.canUseVoice).toBe(true));

    await act(async () => {
      result.current.toggleRecording();
    });
    await waitFor(() => expect(result.current.recording).toBe(true));

    await act(async () => {
      result.current.stopAndSend(send);
    });

    await waitFor(() => expect(result.current.voiceError).toBeTruthy());
    expect(send).not.toHaveBeenCalled();
    expect(result.current.voiceModalOpen).toBe(false);

    // Subsequent default stop opens modal — ref was cleared.
    fetchMock.mockRestore();
    buildFetch("second take");

    await act(async () => {
      result.current.toggleRecording();
    });
    await waitFor(() => expect(result.current.recording).toBe(true));

    await act(async () => {
      result.current.toggleRecording();
    });

    await waitFor(() => expect(result.current.voiceModalOpen).toBe(true));
    expect(result.current.voiceDraft).toBe("second take");
  });

  it("default stop without callbacks opens the confirm modal (Case C)", async () => {
    buildFetch("modal path");
    const { result } = renderHook(() => useVoiceInput());

    await waitFor(() => expect(result.current.canUseVoice).toBe(true));

    await act(async () => {
      result.current.toggleRecording();
    });
    await waitFor(() => expect(result.current.recording).toBe(true));

    await act(async () => {
      result.current.toggleRecording();
    });

    await waitFor(() => expect(result.current.voiceModalOpen).toBe(true));
    expect(result.current.voiceDraft).toBe("modal path");
  });

  it("recording again from an open confirmation draft appends the transcript", async () => {
    buildFetch("second take");
    const { result } = renderHook(() => useVoiceInput());

    await waitFor(() => expect(result.current.canUseVoice).toBe(true));

    act(() => {
      result.current.openDraft("first take");
    });
    expect(result.current.voiceModalOpen).toBe(true);

    await act(async () => {
      result.current.toggleRecording();
    });
    await waitFor(() => expect(result.current.recording).toBe(true));

    await act(async () => {
      result.current.toggleRecording();
    });

    await waitFor(() => expect(result.current.voiceDraft).toBe("first take second take"));
    expect(result.current.voiceModalOpen).toBe(true);
    expect(result.current.voiceError).toBeNull();
  });

  it("dismissing an open confirmation while recording stops without empty-audio error", async () => {
    buildFetch("ignored take");
    const { result } = renderHook(() => useVoiceInput());

    await waitFor(() => expect(result.current.canUseVoice).toBe(true));

    act(() => {
      result.current.openDraft("existing draft");
    });

    await act(async () => {
      result.current.toggleRecording();
    });
    await waitFor(() => expect(result.current.recording).toBe(true));

    act(() => {
      result.current.dismissModal();
    });

    await waitFor(() => expect(result.current.recording).toBe(false));
    expect(result.current.voiceModalOpen).toBe(false);
    expect(result.current.voiceDraft).toBe("");
    expect(result.current.voiceError).toBeNull();
  });

  it("stopAndSend wins over onTranscribed option (Case D)", async () => {
    buildFetch("priority text");
    const onTranscribed = vi.fn();
    const send = vi.fn();
    const { result } = renderHook(() => useVoiceInput({ onTranscribed }));

    await waitFor(() => expect(result.current.canUseVoice).toBe(true));

    await act(async () => {
      result.current.toggleRecording();
    });
    await waitFor(() => expect(result.current.recording).toBe(true));

    await act(async () => {
      result.current.stopAndSend(send);
    });

    await waitFor(() => expect(send).toHaveBeenCalledWith("priority text"));
    expect(onTranscribed).not.toHaveBeenCalled();
    expect(result.current.voiceModalOpen).toBe(false);
  });

  it("stopAndSend is a no-op when not recording", async () => {
    buildFetch("ignored");
    const send = vi.fn();
    const { result } = renderHook(() => useVoiceInput());

    await waitFor(() => expect(result.current.canUseVoice).toBe(true));

    await act(async () => {
      result.current.stopAndSend(send);
    });

    expect(send).not.toHaveBeenCalled();
    expect(result.current.recording).toBe(false);
  });
});
