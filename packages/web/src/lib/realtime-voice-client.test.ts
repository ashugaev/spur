// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { startRealtimeTranscription } from "./realtime-voice-client";

class MockDataChannel {
  listeners = new Map<string, Array<(ev: unknown) => void>>();
  sent: string[] = [];
  closed = false;

  addEventListener(type: string, handler: (ev: unknown) => void) {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), handler]);
  }

  send(data: string) {
    this.sent.push(data);
  }

  close() {
    this.closed = true;
  }

  fire(type: string, ev: unknown) {
    for (const handler of this.listeners.get(type) ?? []) handler(ev);
  }
}

class MockPeerConnection {
  static last: MockPeerConnection;
  channel = new MockDataChannel();
  closed = false;
  connectionState = "connecting";
  added: Array<{ track: unknown; stream: unknown }> = [];
  remote: unknown;
  pcListeners = new Map<string, Array<() => void>>();

  constructor() {
    MockPeerConnection.last = this;
  }

  addTrack(track: unknown, stream: unknown) {
    this.added.push({ track, stream });
  }

  createDataChannel() {
    return this.channel;
  }

  async createOffer() {
    return { type: "offer", sdp: "OFFER_SDP" };
  }

  async setLocalDescription() {
    return undefined;
  }

  async setRemoteDescription(desc: unknown) {
    this.remote = desc;
  }

  addEventListener(type: string, handler: () => void) {
    this.pcListeners.set(type, [...(this.pcListeners.get(type) ?? []), handler]);
  }

  close() {
    this.closed = true;
  }
}

const stopSpy = vi.fn();

function makeStream() {
  const track = { stop: stopSpy, kind: "audio" };
  return {
    getAudioTracks: () => [track],
    getTracks: () => [track],
  };
}

describe("startRealtimeTranscription", () => {
  beforeEach(() => {
    stopSpy.mockClear();
    vi.stubGlobal("RTCPeerConnection", MockPeerConnection);
    Object.defineProperty(globalThis.navigator, "mediaDevices", {
      configurable: true,
      value: { getUserMedia: vi.fn(async () => makeStream()) },
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        status: 200,
        text: async () => "ANSWER_SDP",
      })),
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("posts the SDP offer with bearer + application/sdp and sets remote answer", async () => {
    await startRealtimeTranscription({
      token: "ek_token",
      model: "gpt-realtime-whisper",
      language: "en",
      onPartial: vi.fn(),
      onFinal: vi.fn(),
      onError: vi.fn(),
    });

    const fetchMock = vi.mocked(fetch);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://api.openai.com/v1/realtime/calls");
    expect((init as RequestInit).headers).toMatchObject({
      Authorization: "Bearer ek_token",
      "Content-Type": "application/sdp",
    });
    expect((init as RequestInit).body).toBe("OFFER_SDP");
    expect(MockPeerConnection.last.remote).toEqual({ type: "answer", sdp: "ANSWER_SDP" });
  });

  it("sends session.update on channel open with model + language", async () => {
    await startRealtimeTranscription({
      token: "ek_token",
      model: "gpt-realtime-whisper",
      language: "en",
      onPartial: vi.fn(),
      onFinal: vi.fn(),
      onError: vi.fn(),
    });

    MockPeerConnection.last.channel.fire("open", {});
    const payload = JSON.parse(MockPeerConnection.last.channel.sent[0]);
    expect(payload.type).toBe("session.update");
    expect(payload.session.type).toBe("transcription");
    expect(payload.session.audio.input.transcription).toEqual({
      model: "gpt-realtime-whisper",
      language: "en",
    });
    // server_vad drives utterance segmentation so a final transcript is emitted.
    expect(payload.session.audio.input.turn_detection).toEqual({ type: "server_vad" });
  });

  it("accumulates delta into onPartial and emits onFinal on completed", async () => {
    const onPartial = vi.fn();
    const onFinal = vi.fn();
    await startRealtimeTranscription({
      token: "ek_token",
      model: "gpt-realtime-whisper",
      language: "en",
      onPartial,
      onFinal,
      onError: vi.fn(),
    });

    const ch = MockPeerConnection.last.channel;
    ch.fire("message", {
      data: JSON.stringify({
        type: "conversation.item.input_audio_transcription.delta",
        delta: "hel",
      }),
    });
    ch.fire("message", {
      data: JSON.stringify({
        type: "conversation.item.input_audio_transcription.delta",
        delta: "lo",
      }),
    });
    expect(onPartial).toHaveBeenLastCalledWith("hello");

    ch.fire("message", {
      data: JSON.stringify({
        type: "conversation.item.input_audio_transcription.completed",
        transcript: "hello world",
      }),
    });
    expect(onFinal).toHaveBeenCalledWith("hello world");
  });

  it("stop() closes the channel, peer connection, and stops mic tracks", async () => {
    const session = await startRealtimeTranscription({
      token: "ek_token",
      model: "gpt-realtime-whisper",
      language: "en",
      onPartial: vi.fn(),
      onFinal: vi.fn(),
      onError: vi.fn(),
    });

    await session.stop();
    expect(MockPeerConnection.last.channel.closed).toBe(true);
    expect(MockPeerConnection.last.closed).toBe(true);
    expect(stopSpy).toHaveBeenCalled();
  });
});
