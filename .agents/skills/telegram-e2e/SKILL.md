---
name: telegram-e2e
description: Live end-to-end test of the Telegram source on a dedicated test bot through an isolated daemon. Use after any change to the Telegram source, agent sends, buttons, reply routing, placeholders, notices, or the Telegram prompt suffix, before close-out.
---

TELEGRAM LIVE E2E

Fast tests never prove Telegram. Change under `v2/src/event-sources/telegram.ts`, `v2/src/telegram-source-state.ts`, the Telegram paths of `v2/src/session-service.ts`, `v2/src/send-batches.ts`, or the suffix: run this before close-out. Report each scenario pass or fail with the message ids.


NEVER

  - Production bot token. A second getUpdates poller returns 409 and steals live chat bindings.
  - Default-port daemon. Isolated daemon only.
  - Manual getUpdates on the test bot while the isolated daemon polls it.
  - A sidecar start while `v2/src` is newer than `v2/dist`. The sidecar script then runs `pnpm --dir v2 build`, whose hook restarts the production daemon. Compile first.
  - Env values in transcript, PR, or commit. Names only.


INPUTS

  Operator env, names only. Missing one: stop, ask the operator, never fall back to the production bot.

  TELEGRAM_TEST_BOT_TOKEN      dedicated test bot, admin in the test forum
  TELEGRAM_TEST_CHAT_ID        forum supergroup, topics on
  TELEGRAM_TEST_ALLOWED_USERS  tester user ids
  TELEGRAM_TEST_ALLOWED_CHATS  forum id plus the tester's DM id

  User side: an authorized MTProto user client (Telethon) for an allowed user. Needs send, reply-to, inline button click, voice note, and a message read that shows buttons, reply ids, and topic ids.


SETUP

  1. Compile: `(cd v2 && ./node_modules/.bin/tsc)`.
  2. Export TELEGRAM_TEST_*, unset the production Telegram vars, start: `env -u TELEGRAM_BOT_TOKEN -u TELEGRAM_CHAT_ID bash scripts/spur-isolated-daemon.sh`. The daemon resolves `${VAR}` at config load; a var missing at start makes the registry skip the config (`daemon.registry.warning` in events.jsonl).
  3. The isolated project config strips sources and triggers. Write a separate test project config: telegram source from TELEGRAM_TEST_* (`token`, `chatId`, `allowedUsers`, `allowedChats`), `autoSpawn`, and a `telegram:message` send trigger with `interrupt: false`. Keys: docs/configuration.md. Connect it: `"$SPUR_SESSION_TOOL_DIR/spur-isolated" connect <file>`.
  4. Check `source.started` for the test project in the isolated events.jsonl, and no 409 in the production daemon log.
  5. Fresh isolated data dir: claude shows a folder-trust dialog for its shepherd dir, and the launch Enter picks "No, exit". Open claude there once by hand and accept.

  Bare `spur` inside a test agent can resolve to the production install. Test prompts tell agents to do the work themselves and spawn nothing. After the run, check production events.jsonl for no spawn or session of the test project.


SCENARIOS

  Each passes within 60s of the user action, with no duplicate prompt in the agent pane.

  1. Agent send: spawn in the test project with "notify me in Telegram, buttons X and Y". Message starts with the session label (id and title), keyboard renders, a forum topic is created.
  2. Click: toast, message edited to "Selected: X", keyboard gone, agent answers.
  3. Topic reply: reply-to the agent message. Placeholder "Received. <label> is thinking..." appears, then is edited into the answer.
  4. DM spawn: plain task to the bot DM. "Spawned and bound", then the labeled answer in the DM.
  5. Second DM agent: `/spawn`, pick agent and project, send a task. Its first reply lands in the DM, never in the forum.
  6. DM routing: plain message reaches the latest bound agent; reply-to reaches the agent that sent the replied message; click reaches the offering agent.
  7. Voice note in the DM: "Heard: ..." then routed like text. Needs a live isolated-ui sidecar. Its process `SPUR_CONFIG` must point at an existing dir; a stale one falls back to the default provider and the route answers 502 `missing_model`. Restart the sidecar, then check the route with a direct `curl -F audio=@<file>` to `/api/runtime/voice/transcribe`.
  8. Inactive: `pause` an agent, reply-to its message: "<label> is not active. Message not delivered." Nothing delivered.
  9. Gone: `kill --pr-action leave_open`, reply-to its message: "Spur session <id> is gone. Message not delivered." Binding unchanged.


CLEANUP

  Stop the isolated daemon by pid, then `tmux -L spur-<port> kill-server`. Stop sidecars with `"$SPUR_SESSION_TOOL_DIR/spur-sidecar" stop --name <name>`. Keep the test bot and forum.
