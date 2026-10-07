---
name: telegram-e2e
description: Live end-to-end test of the Telegram source on a dedicated test bot through an isolated daemon. Use after any change to the Telegram source, agent sends, buttons, reply routing, placeholders, notices, or the Telegram prompt suffix, before close-out.
---

TELEGRAM LIVE E2E

Report each scenario verdict and message ids.


COMMAND MENU

  Add slash command: update parser/handler, TELEGRAM_COMMANDS and help in `v2/src/event-sources/telegram.ts` together with startup-menu regression in `v2/test/fast/telegram-source.test.ts`.


NEVER

  - Production bot token. A second getUpdates poller returns 409 and steals live chat bindings.
  - Default-port daemon. Isolated daemon only.
  - Manual getUpdates on the test bot while the isolated daemon polls it.
  - A sidecar start while `v2/src` is newer than `v2/dist`. Compile first; unset `SPUR_BUILD_RESTART`. Build restart requires opt-in and refuses default instance (`v2/bin/restart-daemon-if-running.mjs`).
  - Env values in transcript, PR, or commit. Names only.


INPUTS

  Private repository fixture or operator env, names only. Missing input: stop; never fall back to production bot. Seed contract: docs/commands.md Sidecars.

  TELEGRAM_TEST_BOT_TOKEN      dedicated test bot, admin in the test forum
  TELEGRAM_TEST_CHAT_ID        forum supergroup, topics on
  TELEGRAM_TEST_ALLOWED_USERS  tester user ids
  TELEGRAM_TEST_ALLOWED_CHATS  forum id plus the tester's DM id

  User side: an authorized MTProto user client (Telethon) for an allowed user. Needs send, reply-to, inline button click, voice note, and a message read that shows buttons, reply ids, and topic ids.


SETUP

  1. Compile: `env -u SPUR_BUILD_RESTART pnpm --dir v2 build`.
  2. Seed dedicated TEST JSON through stdin once per repository; docs/commands.md Sidecars. Never pass secrets in argv. Existing differing fixture refuses overwrite.
  3. Start `"$SPUR_SESSION_TOOL_DIR/spur-sidecar" --name isolated-ui`; dependency starts daemon, retained fixture attaches current checkout/project. No clone or manual connect. Backend-only `isolated-daemon` lacks voice UI; voice needs configured provider.
  4. Check own isolated `source.started`, no registry/source error or 409. Missing fixture or busy bot: `Telegram NOT_CONNECTED`, source-free daemon; stop test. Retire only owned poller before another start. Restart complete stand: stop UI, stop daemon, start UI.
  5. Fresh isolated data dir: claude shows a folder-trust dialog for its shepherd dir, and the launch Enter picks "No, exit". Open claude there once by hand and accept.

  Bare `spur` inside a test agent can resolve to the production install. Test prompts tell agents to do the work themselves and spawn nothing. After the run, check production events.jsonl for no spawn or session of the test project.


SCENARIOS

  Each passes within 60s of the user action, with no duplicate prompt in the agent pane.

  1. Agent send: spawn in test project with "notify me in Telegram, buttons X and Y". Forum answer starts with agent body, keyboard renders, topic title precedes session id. Subsequent answers omit session label; successful forum binding confirmations omit identity.
  2. Click: toast, message edited to "Selected: X", keyboard gone, agent answers.
  3. Topic reply: reply-to the agent message. Placeholder "Received. <label> is thinking..." appears, then is edited into the answer.
  4. DM spawn: plain task to the bot DM. "Spawned and bound", then the labeled answer in the DM.
  5. Second DM agent: `/spawn`, pick agent and project, send a task. Its first reply lands in the DM, never in the forum.
  6. DM routing: plain message reaches the latest bound agent; reply-to reaches the agent that sent the replied message; click reaches the offering agent.
  7. Voice note in the DM: "Heard: ..." then routed like text. Needs a live isolated-ui sidecar. Its process `SPUR_CONFIG` must point at an existing dir; a stale one falls back to the default provider and the route answers 502 `missing_model`. Restart the sidecar, then check the route with a direct `curl -F audio=@<file>` to `/api/runtime/voice/transcribe`.
  8. Inactive: `pause` an agent, reply-to its message: "<label> is not active. Message not delivered." Nothing delivered.
  9. Gone: `kill --pr-action leave_open`, reply-to its message: "Spur session <id> is gone. Message not delivered." Binding unchanged.
  10. Command menu: after final-build source start/restart, compare dedicated TEST `getMyCommands` with TELEGRAM_COMMANDS; verify `getChatMenuButton` commands type. Record build/start identity; report overrides without deleting scopes.


CLEANUP

  Stop the isolated daemon by pid, then `tmux -L spur-<port> kill-server`. Stop sidecars with `"$SPUR_SESSION_TOOL_DIR/spur-sidecar" stop --name <name>`. Keep the test bot and forum.
