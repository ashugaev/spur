# Receive native Telegram calls

Call dedicated Telegram user account to speak with Gemini and sandbox Shepherd.
Prototype runs from checkout through `voice-daemon` and `voice-call` sidecars.
Bot API, production orchestration and outgoing calls unsupported.

## Prepare private inputs

Use Python 3.11+ with virtualenv support and Linux native call libraries.
`run-call.sh --check-deps` installs pinned dependencies in private cache; `TELEGRAM_CALL_PYTHON` selects an existing interpreter.
Set `TELEGRAM_CALL_STATE_DIR` to private storage outside session artifacts; default `$XDG_CACHE_HOME/spur/telegram-call`, or `~/.cache/spur/telegram-call` when unset.

Create mode-0600 `call.env` in the private state directory, outside checkout and session artifacts.
Launcher reads this file when present; `TELEGRAM_CALL_ENV_FILE` overrides its path.
Pass overrides through sidecar child `env` configuration; caller-shell exports do not reach sidecars.
Required fields:

- `TG_API_ID`, `TG_API_HASH`: Telegram application credentials.
- `TG_SESSION`: existing authorized Telethon SQLite session path; original stays read-only.
- `GEMINI_API_KEY`, `GEMINI_LIVE_MODEL`: Gemini Live credentials and AUDIO-capable model; no default model.
- `TELEGRAM_ALLOWED_USERS`: comma-separated positive Telegram user IDs; no wildcard or usernames.
- `TELEGRAM_CALL_EXCLUSIVE_SESSION=1`: attest no other client holds this session's auth key, after checking account consumers.

Environment fields override private file fields.
Allowlist fallback reads only `TELEGRAM_ALLOWED_USERS` from checkout `.env`; `TELEGRAM_CALL_ALLOWLIST_FILE` selects another trusted file.
No bot token required.
No interactive login or login-code delivery.
Session database copying does not authorize concurrent use of its auth key; use independent authorized session when another client owns it.
Missing inputs fail before Telegram connection; startup identifies field names without credential values.
Both sidecars require configured Telegram/Gemini inputs before creating runtime state.
Preflight checks configuration only; provider access and Telegram authorization require live startup.

## Start and stop

Bootstrap dependencies before starting either sidecar; no account or Gemini connection:

```bash
scripts/telegram-call/run-call.sh --check-deps
```

Start from Spur session in this checkout:

```bash
"$SPUR_SESSION_TOOL_DIR/spur-sidecar" --name voice-daemon
"$SPUR_SESSION_TOOL_DIR/spur-sidecar" --name voice-call
```

Daemon registers throwaway `voice-sandbox` repository and built-in Shepherd.
No project sources, triggers or production registry copied.
Full-access agents remain outside OS security sandbox; orchestration scope depends on registry and agent instructions.

Stop listener before daemon:

```bash
"$SPUR_SESSION_TOOL_DIR/spur-sidecar" stop --name voice-call
"$SPUR_SESSION_TOOL_DIR/spur-sidecar" stop --name voice-daemon
```

Daemon stop terminates sandbox agent processes before deleting owned fixture.
Inspect logs with `spur service logs`; inspect reserved port with sidecar `ports` command.

## Test one call

Call dedicated account from allowlisted user.
Telegram media accepts before Shepherd/Gemini setup; microphone input stays disabled during preparation.
Hear “Starting Shepherd. Please wait.”, then “Still connecting. Please wait.” at 15 and 30 seconds if setup remains pending.
Setup expires after 45 seconds, measured after the starting notice finishes.
Hear “Shepherd is ready. You can speak now.” after fresh Shepherd readiness and Gemini connection; then speak.
Each call starts a fresh Shepherd.

Startup failure plays a Shepherd, voice connection or timeout notice, then hangs up.
Transport loss, remote hangup and listener shutdown stop playback; no audible notice is guaranteed without media.
English notices use [committed recordings](../scripts/telegram-call/audio/README.md); no runtime TTS or Google request generates them.

Speak, interrupt spoken answer, request disposable worker launch, then request worker status.
Gemini reports dispatch first and relays correlated Shepherd answer after its turn ends.
One pending orchestration request per call; request timeout 90 seconds.
Calls end after 8 minutes or Gemini GoAway; no reconnect.
Only one incoming call prepares or runs at once.

Hang up and call again; listener stays available.
Hangup closes media/Gemini and stops this call's Shepherd.
Independent delegated workers remain until daemon stop; hangup does not cancel their work.
Record sanitized startup timings, worker outcome and teardown evidence in session artifacts; never credentials or raw audio.
Native audio and operator call require live verification; offline tests do not prove account interoperability.
