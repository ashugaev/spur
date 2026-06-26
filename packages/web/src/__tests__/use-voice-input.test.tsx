import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useVoiceInput } from "@/hooks/useVoiceInput";
import { startRealtimeTranscription } from "@/lib/realtime-voice-client";

vi.mock("@/lib/realtime-voice-client", () => ({
  startRealtimeTranscription: vi.fn(),
}));

const mockStartRealtime = vi.mocked(startRealtimeTranscription);

interface RealtimeHandlers {
  onPartial: (text: string) => void;
  onFinal: (text: string) => void;
  onError: (err: Error) => void;
}

const RETAINED_STORE_NAME = "retained-takes";

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

type MutableRequest<T> = IDBRequest<T> & {
  error: DOMException | null;
  onerror: ((this: IDBRequest<T>, ev: Event) => unknown) | null;
  onsuccess: ((this: IDBRequest<T>, ev: Event) => unknown) | null;
  result: T;
};

type MutableOpenRequest = IDBOpenDBRequest & {
  error: DOMException | null;
  onerror: ((this: IDBOpenDBRequest, ev: Event) => unknown) | null;
  onsuccess: ((this: IDBOpenDBRequest, ev: Event) => unknown) | null;
  onupgradeneeded: ((this: IDBOpenDBRequest, ev: IDBVersionChangeEvent) => unknown) | null;
  result: IDBDatabase;
};

interface RetainedRecordShape {
  blob: Blob;
  contextKey: string;
  mode: string;
  updatedAt: number;
}

function isRetainedRecordShape(value: unknown): value is RetainedRecordShape {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Partial<RetainedRecordShape>;
  return (
    record.blob instanceof Blob &&
    typeof record.contextKey === "string" &&
    typeof record.mode === "string" &&
    typeof record.updatedAt === "number"
  );
}

function createRequest<T>(result: T): MutableRequest<T> {
  return {
    error: null,
    onerror: null,
    onsuccess: null,
    result,
  } as MutableRequest<T>;
}

class FakeObjectStore {
  constructor(
    private readonly records: Map<string, unknown>,
    private readonly complete: () => void,
  ) {}

  get(key: string): IDBRequest<unknown> {
    const request = createRequest(this.records.get(key));
    queueMicrotask(() => {
      request.onsuccess?.call(request, new Event("success"));
      this.complete();
    });
    return request;
  }

  put(value: unknown): IDBRequest<unknown> {
    const request = createRequest(value);
    queueMicrotask(() => {
      if (isRetainedRecordShape(value)) {
        this.records.set(value.contextKey, value);
      }
      request.onsuccess?.call(request, new Event("success"));
      this.complete();
    });
    return request;
  }

  delete(key: string): IDBRequest<undefined> {
    const request = createRequest(undefined);
    queueMicrotask(() => {
      this.records.delete(key);
      request.onsuccess?.call(request, new Event("success"));
      this.complete();
    });
    return request;
  }
}

class FakeTransaction {
  onabort: ((this: IDBTransaction, ev: Event) => unknown) | null = null;
  oncomplete: ((this: IDBTransaction, ev: Event) => unknown) | null = null;
  onerror: ((this: IDBTransaction, ev: Event) => unknown) | null = null;
  error: DOMException | null = null;

  constructor(private readonly records: Map<string, unknown>) {}

  objectStore(): IDBObjectStore {
    return new FakeObjectStore(this.records, () => {
      queueMicrotask(() => {
        this.oncomplete?.call(this as unknown as IDBTransaction, new Event("complete"));
      });
    }) as unknown as IDBObjectStore;
  }
}

class FakeDatabase {
  constructor(private readonly stores: Map<string, Map<string, unknown>>) {}

  get objectStoreNames(): DOMStringList {
    return {
      contains: (name: string) => this.stores.has(name),
    } as DOMStringList;
  }

  createObjectStore(name: string): IDBObjectStore {
    if (!this.stores.has(name)) {
      this.stores.set(name, new Map());
    }
    return {} as IDBObjectStore;
  }

  transaction(name: string): IDBTransaction {
    const records = this.stores.get(name);
    if (!records) {
      throw new Error(`Unknown store: ${name}`);
    }
    return new FakeTransaction(records) as unknown as IDBTransaction;
  }

  close() {}
}

class FakeIndexedDb {
  private readonly stores = new Map<string, Map<string, unknown>>();

  open(): IDBOpenDBRequest {
    const request = {
      error: null,
      onerror: null,
      onsuccess: null,
      onupgradeneeded: null,
      result: new FakeDatabase(this.stores) as unknown as IDBDatabase,
    } as MutableOpenRequest;

    queueMicrotask(() => {
      if (!this.stores.has(RETAINED_STORE_NAME)) {
        request.onupgradeneeded?.call(
          request,
          new Event("upgradeneeded") as unknown as IDBVersionChangeEvent,
        );
      }
      request.onsuccess?.call(request, new Event("success"));
    });

    return request;
  }

  seed(contextKey: string, mode: "insert" | "modal" | "send") {
    if (!this.stores.has(RETAINED_STORE_NAME)) {
      this.stores.set(RETAINED_STORE_NAME, new Map());
    }
    this.stores.get(RETAINED_STORE_NAME)?.set(contextKey, {
      blob: new Blob(["persisted-audio"], { type: "audio/webm" }),
      contextKey,
      mode,
      updatedAt: Date.now(),
    } satisfies RetainedRecordShape);
  }
}

type TranscribeResponse =
  | {
      text: string;
    }
  | {
      error: string;
      status?: number;
    };

let fakeIndexedDb: FakeIndexedDb;

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

function stubIndexedDb() {
  fakeIndexedDb = new FakeIndexedDb();
  vi.stubGlobal("indexedDB", {
    open: () => fakeIndexedDb.open(),
  } satisfies Pick<IDBFactory, "open">);
}

function buildFetch(responses: TranscribeResponse[]) {
  let index = 0;
  return vi.spyOn(global, "fetch").mockImplementation(async (input, init) => {
    const url = typeof input === "string" ? input : (input as Request).url;
    if (url === "/api/runtime/voice") {
      return new Response(JSON.stringify({ available: true, language: "auto" }), {
        status: 200,
      });
    }
    if (url === "/api/runtime/voice/transcribe" && init?.method === "POST") {
      const response = responses[Math.min(index, responses.length - 1)];
      index += 1;
      if (!response) {
        throw new Error("Missing transcribe response");
      }
      if ("text" in response) {
        return new Response(JSON.stringify({ text: response.text }), { status: 200 });
      }
      return new Response(JSON.stringify({ error: response.error }), {
        status: response.status ?? 400,
      });
    }
    throw new Error(`Unexpected fetch: ${url}`);
  });
}

function buildRealtimeFetch() {
  return vi.spyOn(global, "fetch").mockImplementation(async (input, init) => {
    const url = typeof input === "string" ? input : (input as Request).url;
    if (url === "/api/runtime/voice") {
      return new Response(JSON.stringify({ available: true, language: "en", realtime: true }), {
        status: 200,
      });
    }
    if (url === "/api/runtime/voice/realtime-token" && init?.method === "POST") {
      return new Response(
        JSON.stringify({
          value: "ek_token",
          expiresAt: 1,
          model: "gpt-realtime-whisper",
          language: "en",
        }),
        { status: 200 },
      );
    }
    throw new Error(`Unexpected fetch: ${url}`);
  });
}

function installRealtimeSession(): {
  handlers: () => RealtimeHandlers;
  stop: ReturnType<typeof vi.fn>;
} {
  let captured: RealtimeHandlers | null = null;
  const stop = vi.fn().mockResolvedValue(undefined);
  mockStartRealtime.mockImplementation(async (opts) => {
    captured = {
      onPartial: opts.onPartial,
      onFinal: opts.onFinal,
      onError: opts.onError,
    };
    return { stop };
  });
  return {
    handlers: () => {
      if (!captured) throw new Error("realtime session not started");
      return captured;
    },
    stop,
  };
}

describe("useVoiceInput", () => {
  beforeEach(() => {
    stubMediaEnvironment();
    stubIndexedDb();
    mockStartRealtime.mockReset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("stopAndSend invokes callback with transcript and skips modal", async () => {
    buildFetch([{ text: "hello world" }]);
    const send = vi.fn();
    const { result } = renderHook(() => useVoiceInput({ contextKey: "terminal:voice-session" }));

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
    expect(result.current.hasRetainedTake).toBe(false);
  });

  it("failed transcription persists the take across remount and retries the same send path", async () => {
    buildFetch([{ error: "boom", status: 400 }, { text: "recovered take" }]);
    const send = vi.fn();
    const firstRender = renderHook(() => useVoiceInput({ contextKey: "terminal:voice-session" }));

    await waitFor(() => expect(firstRender.result.current.canUseVoice).toBe(true));

    await act(async () => {
      firstRender.result.current.toggleRecording();
    });
    await waitFor(() => expect(firstRender.result.current.recording).toBe(true));

    await act(async () => {
      firstRender.result.current.stopAndSend(send);
    });

    await waitFor(() => expect(firstRender.result.current.voiceError).toBe("boom"));
    expect(send).not.toHaveBeenCalled();
    expect(firstRender.result.current.hasRetainedTake).toBe(true);

    firstRender.unmount();

    const secondRender = renderHook(() => useVoiceInput({ contextKey: "terminal:voice-session" }));

    await waitFor(() => expect(secondRender.result.current.hasRetainedTake).toBe(true));

    await act(async () => {
      await secondRender.result.current.retryRetainedTake(send);
    });

    await waitFor(() => expect(send).toHaveBeenCalledWith("recovered take"));
    expect(secondRender.result.current.hasRetainedTake).toBe(false);
    expect(secondRender.result.current.voiceError).toBe(null);
  });

  it("retains a fresh recording when send fails after transcription", async () => {
    buildFetch([{ text: "transcribed but unsent" }]);
    const { result } = renderHook(() => useVoiceInput({ contextKey: "terminal:send-error" }));

    await waitFor(() => expect(result.current.canUseVoice).toBe(true));

    await act(async () => {
      result.current.toggleRecording();
    });
    await waitFor(() => expect(result.current.recording).toBe(true));

    await act(async () => {
      result.current.stopAndSend(async () => {
        throw new Error("terminal unavailable");
      });
    });

    await waitFor(() => expect(result.current.voiceError).toBe("terminal unavailable"));
    expect(result.current.hasRetainedTake).toBe(true);
  });

  it("keeps the retained take when send fails after successful transcription", async () => {
    buildFetch([{ text: "recovered take" }]);
    fakeIndexedDb.seed("terminal:send-failure", "send");
    const { result } = renderHook(() => useVoiceInput({ contextKey: "terminal:send-failure" }));

    await waitFor(() => expect(result.current.hasRetainedTake).toBe(true));

    await act(async () => {
      await result.current.retryRetainedTake(async () => {
        throw new Error("send failed");
      });
    });

    await waitFor(() => expect(result.current.voiceError).toBe("send failed"));
    expect(result.current.hasRetainedTake).toBe(true);
  });

  it("retrying a retained modal take opens the confirm modal", async () => {
    buildFetch([{ text: "modal path" }]);
    fakeIndexedDb.seed("terminal:modal-path", "modal");
    const { result } = renderHook(() => useVoiceInput({ contextKey: "terminal:modal-path" }));

    await waitFor(() => expect(result.current.hasRetainedTake).toBe(true));

    await act(async () => {
      await result.current.retryRetainedTake();
    });

    await waitFor(() => expect(result.current.voiceModalOpen).toBe(true));
    expect(result.current.voiceDraft).toBe("modal path");
    expect(result.current.hasRetainedTake).toBe(false);
  });

  it("cancelRecording preserves modal draft and skips transcription", async () => {
    const fetchMock = buildFetch([{ text: "cancelled text" }]);
    const { result } = renderHook(() => useVoiceInput({ contextKey: "terminal:cancel-modal" }));

    await waitFor(() => expect(result.current.canUseVoice).toBe(true));

    act(() => {
      result.current.openDraft("existing draft");
    });

    await act(async () => {
      result.current.toggleRecording();
    });
    await waitFor(() => expect(result.current.recording).toBe(true));

    await act(async () => {
      result.current.cancelRecording();
    });

    await waitFor(() => expect(result.current.recording).toBe(false));
    expect(result.current.voiceModalOpen).toBe(true);
    expect(result.current.voiceDraft).toBe("existing draft");
    expect(result.current.voiceError).toBe(null);

    const transcribeCalls = fetchMock.mock.calls.filter(([input]) => {
      const url = typeof input === "string" ? input : (input as Request).url;
      return url === "/api/runtime/voice/transcribe";
    });
    expect(transcribeCalls).toHaveLength(0);
  });

  describe("realtime provider", () => {
    beforeEach(() => {
      vi.stubGlobal("RTCPeerConnection", function RTCPeerConnectionStub() {
        /* realtime client is mocked; only the typeof guard matters */
      });
      buildRealtimeFetch();
    });

    it("streams partials into the modal draft and never sets a retained take", async () => {
      const session = installRealtimeSession();
      const { result } = renderHook(() => useVoiceInput({ contextKey: "terminal:realtime-modal" }));

      await waitFor(() => expect(result.current.canUseVoice).toBe(true));

      await act(async () => {
        result.current.toggleRecording();
      });
      await waitFor(() => expect(result.current.recording).toBe(true));

      act(() => {
        session.handlers().onPartial("hel");
      });
      act(() => {
        session.handlers().onPartial("hello");
      });

      expect(result.current.voiceModalOpen).toBe(true);
      expect(result.current.voiceDraft).toBe("hello");
      expect(result.current.hasRetainedTake).toBe(false);
    });

    it("modal onFinal replaces the draft with the finalized text (no duplication)", async () => {
      const session = installRealtimeSession();
      const { result } = renderHook(() =>
        useVoiceInput({ contextKey: "terminal:realtime-modal-final" }),
      );

      await waitFor(() => expect(result.current.canUseVoice).toBe(true));

      await act(async () => {
        result.current.toggleRecording();
      });
      await waitFor(() => expect(result.current.recording).toBe(true));

      act(() => {
        session.handlers().onPartial("hel");
      });
      act(() => {
        session.handlers().onPartial("hello");
      });
      act(() => {
        session.handlers().onFinal("hello");
      });

      expect(result.current.voiceModalOpen).toBe(true);
      expect(result.current.voiceDraft).toBe("hello");
      expect(result.current.hasRetainedTake).toBe(false);
    });

    it("modal multi-segment dictation accumulates finalized segments without dupes", async () => {
      const session = installRealtimeSession();
      const { result } = renderHook(() =>
        useVoiceInput({ contextKey: "terminal:realtime-modal-multi" }),
      );

      await waitFor(() => expect(result.current.canUseVoice).toBe(true));

      await act(async () => {
        result.current.toggleRecording();
      });
      await waitFor(() => expect(result.current.recording).toBe(true));

      // Segment 1: partials stream, then completes.
      act(() => {
        session.handlers().onPartial("hello");
      });
      act(() => {
        session.handlers().onFinal("hello");
      });
      expect(result.current.voiceDraft).toBe("hello");

      // Segment 2: partials render as accumulated + in-progress, then completes.
      act(() => {
        session.handlers().onPartial("there");
      });
      expect(result.current.voiceDraft).toBe("hello there");
      act(() => {
        session.handlers().onFinal("there");
      });

      expect(result.current.voiceDraft).toBe("hello there");
      expect(result.current.hasRetainedTake).toBe(false);
    });

    it("changing contextKey mid-recording tears down the active session", async () => {
      const session = installRealtimeSession();
      const { result, rerender } = renderHook(
        ({ contextKey }: { contextKey: `terminal:${string}` }) => useVoiceInput({ contextKey }),
        { initialProps: { contextKey: "terminal:realtime-ctx-a" as const } },
      );

      await waitFor(() => expect(result.current.canUseVoice).toBe(true));

      await act(async () => {
        result.current.toggleRecording();
      });
      await waitFor(() => expect(result.current.recording).toBe(true));

      await act(async () => {
        rerender({ contextKey: "terminal:realtime-ctx-b" });
      });

      await waitFor(() => expect(session.stop).toHaveBeenCalled());
      expect(result.current.recording).toBe(false);
    });

    it("completed in insert mode applies via onTranscribed", async () => {
      const session = installRealtimeSession();
      const onTranscribed = vi.fn();
      const { result } = renderHook(() =>
        useVoiceInput({ contextKey: "terminal:realtime-insert", onTranscribed }),
      );

      await waitFor(() => expect(result.current.canUseVoice).toBe(true));

      await act(async () => {
        result.current.toggleRecording();
      });
      await waitFor(() => expect(result.current.recording).toBe(true));

      act(() => {
        session.handlers().onFinal("final insert");
      });

      await waitFor(() => expect(onTranscribed).toHaveBeenCalledWith("final insert"));
      expect(result.current.hasRetainedTake).toBe(false);
    });

    it("stopAndSend sends the accumulated draft and stops the session", async () => {
      const session = installRealtimeSession();
      const send = vi.fn();
      const { result } = renderHook(() => useVoiceInput({ contextKey: "terminal:realtime-send" }));

      await waitFor(() => expect(result.current.canUseVoice).toBe(true));

      await act(async () => {
        result.current.toggleRecording();
      });
      await waitFor(() => expect(result.current.recording).toBe(true));

      act(() => {
        session.handlers().onPartial("send this");
      });

      await act(async () => {
        result.current.stopAndSend(send);
      });

      await waitFor(() => expect(send).toHaveBeenCalledWith("send this"));
      expect(session.stop).toHaveBeenCalled();
      expect(result.current.recording).toBe(false);
      expect(result.current.hasRetainedTake).toBe(false);
    });

    it("toggling off stops the active session", async () => {
      const session = installRealtimeSession();
      const { result } = renderHook(() =>
        useVoiceInput({ contextKey: "terminal:realtime-toggle" }),
      );

      await waitFor(() => expect(result.current.canUseVoice).toBe(true));

      await act(async () => {
        result.current.toggleRecording();
      });
      await waitFor(() => expect(result.current.recording).toBe(true));

      await act(async () => {
        result.current.toggleRecording();
      });

      await waitFor(() => expect(result.current.recording).toBe(false));
      expect(session.stop).toHaveBeenCalled();
    });

    it("stops the session on unmount", async () => {
      const session = installRealtimeSession();
      const { result, unmount } = renderHook(() =>
        useVoiceInput({ contextKey: "terminal:realtime-unmount" }),
      );

      await waitFor(() => expect(result.current.canUseVoice).toBe(true));

      await act(async () => {
        result.current.toggleRecording();
      });
      await waitFor(() => expect(result.current.recording).toBe(true));

      unmount();
      expect(session.stop).toHaveBeenCalled();
    });
  });
});
