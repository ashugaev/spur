# Startup speech assets

Generated offline with FFmpeg's `flite` filter, English voice `slt`.
Commit synthesized WAV output; bundle no speech engine or voice model.
Format: uncompressed PCM16 little-endian, 24000 Hz, mono; maximum 8 seconds.

- `starting.wav`: “Starting Shepherd. Please wait.”
- `waiting.wav`: “Still connecting. Please wait.”
- `ready.wav`: “Shepherd is ready. You can speak now.”
- `shepherd-failed.wav`: “Shepherd could not start. Please call again.”
- `voice-failed.wav`: “Voice connection failed. Please call again.”
- `timeout.wav`: “Startup timed out. Please call again.”

Regenerate from repository root with FFmpeg built with `libflite`:

```bash
ffmpeg -f lavfi -i 'flite=text=Starting Shepherd. Please wait.:voice=slt' -ar 24000 -ac 1 -c:a pcm_s16le scripts/telegram-call/audio/starting.wav
```

Playback requires no TTS service, network request or FFmpeg process.
Call workflow: [Receive native Telegram calls](../../../docs/telegram-calls.md).
