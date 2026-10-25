# Receive native Telegram calls

Call dedicated Telegram user account to speak with Gemini and control sandbox agents.
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
Connecting a call starts no agent; Shepherd starts only when requested through `start_agent`.
No project sources, triggers or production registry copied.
Agent children inherit the isolated `SPUR_CONFIG`; agent prompts require `"$SPUR_SESSION_TOOL_DIR/spur"` for CLI operations.
Full-access agents remain outside OS security sandbox; orchestration scope depends on registry and agent instructions.

Stop listener before daemon:

```bash
"$SPUR_SESSION_TOOL_DIR/spur-sidecar" stop --name voice-call
"$SPUR_SESSION_TOOL_DIR/spur-sidecar" stop --name voice-daemon
```

Daemon stop terminates sandbox agent processes before deleting owned fixture and launcher config dir.
Start refuses while the recorded daemon is alive, or while its sandbox tmux server still runs (receipt kept; clear with `tmux -L <socket> kill-server`). Otherwise stale receipt, fixture and launcher dirs are discarded.
Inspect logs with `spur service logs`; inspect reserved port with sidecar `ports` command.

## Test one call

Call dedicated account from allowlisted user.
Telegram media accepts before Gemini setup; microphone input stays disabled during preparation.
Hear “Connecting voice. Please wait.”, then “Still connecting. Please wait.” every 15 seconds while Google setup remains pending.
Google setup expires after 180 seconds, measured after the starting notice finishes; at most 11 waiting notices.
Hear “Voice is ready. You can speak now.” after Gemini connects; then speak English or request another language.
Ordinary conversation requires no running agent.

Startup failure plays a voice connection or timeout notice, then hangs up.
Transport loss, remote hangup and listener shutdown stop playback; no audible notice is guaranteed without media.
English notices use [committed recordings](../scripts/telegram-call/audio/README.md); no runtime TTS or Google request generates them.
Startup logs report elapsed time and connection phase every 10 seconds while pending.
Tool logs report operation, elapsed time and validated session/state; exclude arguments, output and message content.

Speak, interrupt spoken answer, request disposable worker launch, then request worker status.
Gemini uses four tools against the isolated daemon:

- `list_agents`: configured sandbox projects, supported providers and at most 50 session summaries; provider availability unconfirmed.
- `read_agent`: observed session state and at most eight assistant messages, each capped at 1000 characters; task completion unverified.
- `start_agent`: submit a requested agent prompt to `voice-sandbox` or optional `spur-shepherd`; provider optional.
- `send_to_agent`: submit a follow-up message to an existing sandbox session.

Prompts/messages contain 1–8000 characters; session IDs contain 1–128 letters, digits, `_` or `-`.
One tool operation runs at a time; operation cap 10 seconds, HTTP timeout 5 seconds, at most 128 distinct function IDs per call.
Submission receipts confirm acceptance, not agent completion; request state/results with `read_agent` or `list_agents`.
Unconfirmed mutation: execution unknown; reconcile through list/read before retrying start/send.
No automatic agent result polling or background speech injection.
Calls end after 8 minutes or Gemini GoAway; no reconnect.
Only one incoming call prepares or runs at once.

Hang up and call again; listener stays available.
Hangup closes media/Gemini and pending local tool tasks; started agents, including requested Shepherd, remain until daemon stop.
Record sanitized startup timings, worker outcome and teardown evidence in session artifacts; never credentials or raw audio.
Native audio and operator call require live verification; offline tests do not prove account interoperability.
