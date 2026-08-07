export interface RealtimeTranscriptionConfig {
  model: string;
  language?: string;
}

// Build the OpenAI realtime transcription config, omitting language when "auto"
// so the server auto-detects. Shared by the token mint route and the browser
// client so the auto-language rule lives in one place.
export function buildTranscriptionConfig(
  model: string,
  language: string,
): RealtimeTranscriptionConfig {
  const transcription: RealtimeTranscriptionConfig = { model };
  if (language && language !== "auto") {
    transcription.language = language;
  }
  return transcription;
}
