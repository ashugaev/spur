import { buildTranscriptionConfig } from "./realtime-transcription";

const CALLS_URL = "https://api.openai.com/v1/realtime/calls";
const DATA_CHANNEL = "oai-events";

interface StartRealtimeOptions {
  token: string;
  model: string;
  language: string;
  onPartial: (text: string) => void;
  onFinal: (text: string) => void;
  onError: (err: Error) => void;
}

export interface RealtimeSession {
  stop: () => Promise<void>;
}

export async function startRealtimeTranscription(
  opts: StartRealtimeOptions,
): Promise<RealtimeSession> {
  const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
  const pc = new RTCPeerConnection();
  let buffer = "";

  const micTrack = stream.getAudioTracks()[0];
  if (micTrack) {
    pc.addTrack(micTrack, stream);
  }

  const channel = pc.createDataChannel(DATA_CHANNEL);

  channel.addEventListener("open", () => {
    // Confirm the transcription config on the live session. session.type is
    // required by the Realtime API on every session.update. server_vad turn
    // detection segments utterances so a `completed` event (final transcript)
    // is emitted after each pause — gpt-4o-transcribe supports it.
    const transcription = buildTranscriptionConfig(opts.model, opts.language);
    channel.send(
      JSON.stringify({
        type: "session.update",
        session: {
          type: "transcription",
          audio: { input: { transcription, turn_detection: { type: "server_vad" } } },
        },
      }),
    );
  });

  channel.addEventListener("message", (event: MessageEvent) => {
    if (typeof event.data !== "string") return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(event.data);
    } catch {
      return;
    }
    if (!parsed || typeof parsed !== "object" || !("type" in parsed)) return;
    const type = (parsed as { type: unknown }).type;
    if (type === "conversation.item.input_audio_transcription.delta") {
      const delta = (parsed as { delta?: unknown }).delta;
      if (typeof delta === "string") {
        buffer += delta;
        opts.onPartial(buffer);
      }
      return;
    }
    if (type === "conversation.item.input_audio_transcription.completed") {
      const transcript = (parsed as { transcript?: unknown }).transcript;
      const finalText = typeof transcript === "string" ? transcript : buffer;
      buffer = "";
      opts.onFinal(finalText);
    }
  });

  try {
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);

    const response = await fetch(CALLS_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${opts.token}`,
        "Content-Type": "application/sdp",
      },
      body: offer.sdp ?? "",
    });
    if (!response.ok) {
      const detail = (await response.text().catch(() => "")).slice(0, 300);
      const message = `OpenAI realtime calls returned ${response.status}${detail ? `: ${detail}` : ""}`;
      console.error(`[realtime-voice-client] ${message}`);
      throw new Error(message);
    }
    const answerSdp = await response.text();
    await pc.setRemoteDescription({ type: "answer", sdp: answerSdp });
  } catch (error) {
    await teardown(channel, pc, stream);
    throw error instanceof Error ? error : new Error("Failed to start realtime transcription");
  }

  pc.addEventListener("connectionstatechange", () => {
    if (pc.connectionState === "failed") {
      opts.onError(new Error("realtime connection failed"));
    }
  });

  return {
    stop: () => teardown(channel, pc, stream),
  };
}

async function teardown(
  channel: RTCDataChannel,
  pc: RTCPeerConnection,
  stream: MediaStream,
): Promise<void> {
  try {
    channel.close();
  } catch {
    // ignore: channel may already be closed
  }
  try {
    pc.close();
  } catch {
    // ignore: peer connection may already be closed
  }
  for (const track of stream.getTracks()) {
    try {
      track.stop();
    } catch {
      // ignore: track may already be stopped
    }
  }
}
