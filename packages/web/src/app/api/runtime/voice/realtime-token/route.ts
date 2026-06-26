import { NextResponse } from "next/server";
import { resolveRealtimeTokenConfig } from "@/lib/voice";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const CLIENT_SECRETS_URL = "https://api.openai.com/v1/realtime/client_secrets";

function redactBearerTokens(message: string): string {
  return message.replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer [redacted]");
}

function extractUpstreamError(body: unknown, fallback: string): string {
  if (
    body &&
    typeof body === "object" &&
    "error" in body &&
    body["error"] &&
    typeof body["error"] === "object" &&
    "message" in body["error"] &&
    typeof body["error"]["message"] === "string"
  ) {
    return body["error"]["message"];
  }
  return fallback;
}

function parseEphemeralToken(body: unknown): { value: string; expiresAt: number } | null {
  if (!body || typeof body !== "object") return null;
  const value = "value" in body ? body["value"] : undefined;
  const expiresAt = "expires_at" in body ? body["expires_at"] : undefined;
  if (typeof value !== "string" || typeof expiresAt !== "number") return null;
  return { value, expiresAt };
}

export async function POST() {
  let config: ReturnType<typeof resolveRealtimeTokenConfig>;
  try {
    config = resolveRealtimeTokenConfig();
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "voice provider is not openai_realtime";
    return NextResponse.json({ error: message }, { status: 400 });
  }

  if (!config.apiKey) {
    return NextResponse.json({ error: "OPENAI_API_KEY is not configured" }, { status: 503 });
  }

  const transcription: { model: string; language?: string } = { model: config.model };
  if (config.language && config.language !== "auto") {
    transcription.language = config.language;
  }

  let upstream: Response;
  try {
    upstream = await fetch(CLIENT_SECRETS_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${config.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        session: {
          type: "realtime",
          audio: { input: { transcription } },
        },
      }),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "failed to reach OpenAI";
    return NextResponse.json({ error: redactBearerTokens(message) }, { status: 502 });
  }

  let body: unknown = null;
  try {
    body = await upstream.json();
  } catch {
    // Leave body as null when the response is not JSON.
  }

  if (!upstream.ok) {
    const detail = extractUpstreamError(body, `OpenAI returned ${upstream.status}`);
    return NextResponse.json({ error: redactBearerTokens(detail) }, { status: 502 });
  }

  const token = parseEphemeralToken(body);
  if (!token) {
    return NextResponse.json({ error: "OpenAI returned an unexpected response" }, { status: 502 });
  }

  return NextResponse.json({
    value: token.value,
    expiresAt: token.expiresAt,
    model: config.model,
    language: config.language,
  });
}
