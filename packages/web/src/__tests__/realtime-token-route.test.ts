// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type * as VoiceModule from "@/lib/voice";

vi.mock("@/lib/voice", async (importOriginal) => ({
  ...(await importOriginal<typeof VoiceModule>()),
  resolveRealtimeTokenConfig: vi.fn(),
}));

import { resolveRealtimeTokenConfig } from "@/lib/voice";
import { POST } from "@/app/api/runtime/voice/realtime-token/route";

const mockResolve = vi.mocked(resolveRealtimeTokenConfig);
const REAL_KEY = "sk-super-secret-key";

function jsonResponse(body: unknown, ok: boolean, status: number): Response {
  return {
    ok,
    status,
    json: async () => body,
  } as unknown as Response;
}

describe("realtime-token route", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("maps a successful mint to { value, expiresAt } and never echoes the real key", async () => {
    mockResolve.mockReturnValue({
      model: "gpt-4o-transcribe",
      language: "en",
      apiKey: REAL_KEY,
    });
    const fetchMock = vi
      .fn()
      .mockResolvedValue(
        jsonResponse({ value: "ek_minted_token", expires_at: 1893456000 }, true, 200),
      );
    vi.stubGlobal("fetch", fetchMock);

    const res = await POST();
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({
      value: "ek_minted_token",
      expiresAt: 1893456000,
      model: "gpt-4o-transcribe",
      language: "en",
    });
    expect(JSON.stringify(body)).not.toContain(REAL_KEY);

    const [, init] = fetchMock.mock.calls[0];
    const sent = JSON.parse(init.body as string);
    expect(sent.session.type).toBe("transcription");
    expect(sent.session.audio.input.transcription).toEqual({
      model: "gpt-4o-transcribe",
      language: "en",
    });
    expect(sent.session.audio.input.turn_detection).toEqual({ type: "server_vad" });
  });

  it("omits language when set to auto", async () => {
    mockResolve.mockReturnValue({
      model: "gpt-4o-transcribe",
      language: "auto",
      apiKey: REAL_KEY,
    });
    const fetchMock = vi
      .fn()
      .mockResolvedValue(jsonResponse({ value: "ek_x", expires_at: 1 }, true, 200));
    vi.stubGlobal("fetch", fetchMock);

    await POST();
    const [, init] = fetchMock.mock.calls[0];
    const sent = JSON.parse(init.body as string);
    expect(sent.session.audio.input.transcription).toEqual({ model: "gpt-4o-transcribe" });
  });

  it("returns 502 when upstream is not ok", async () => {
    mockResolve.mockReturnValue({
      model: "gpt-4o-transcribe",
      language: "en",
      apiKey: REAL_KEY,
    });
    const fetchMock = vi
      .fn()
      .mockResolvedValue(jsonResponse({ error: { message: "bad request" } }, false, 400));
    vi.stubGlobal("fetch", fetchMock);

    const res = await POST();
    expect(res.status).toBe(502);
    const body = await res.json();
    expect(body.error).toBe("bad request");
    expect(JSON.stringify(body)).not.toContain(REAL_KEY);
  });

  it("returns 503 when the api key is missing", async () => {
    mockResolve.mockReturnValue({
      model: "gpt-4o-transcribe",
      language: "en",
      apiKey: null,
    });
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const res = await POST();
    expect(res.status).toBe(503);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("returns 400 when provider is not openai_realtime", async () => {
    mockResolve.mockImplementation(() => {
      throw new Error(
        'realtime token requires voice.provider="openai_realtime" (current "whisper_cpp")',
      );
    });
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const res = await POST();
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toContain('voice.provider="openai_realtime"');
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
