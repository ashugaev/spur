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

  1. Agent send: request Telegram buttons X/Y. Forum answer starts with body, keyboard renders, topic title precedes session id. Later answers omit session label; forum binding confirmations omit identity.
  2. Click: keyboard turns "Sending: X…" then single "Selected: X" button, message text unchanged, toast "Sent: X", agent answers.
  3. Topic reply: reply-to agent message; placeholder "Received. <label> is thinking..." becomes answer.
  4. DM spawn: unbound autoSpawn or `/spawn` wizard creates canonical topic before launch; DM acknowledgment links it. Second agent owns separate topic; body/buttons/attention stay there.
  5. Legacy DM/group-main/foreign-topic text/reply/buttons: migrate and redirect without delivery/consent decision. Preserve other owners; exact-topic continuation succeeds.
  6. Voice: legacy input redirects before download/transcription/echo; canonical input delivers. DM wizard/autoSpawn receives task without transcript echo; changed wizard/ownership aborts stale intake.
  7. No forum: spawn/manual operations work; reply unavailable, notices/buttons/typing silent. `source info` returns `source:null` without allocation. Legacy inspection/typing never allocates; typing requires existing canonical assignment.
  8. Inactive: `pause` an agent, reply-to its message: "<label> is not active. Message not delivered." Nothing delivered.
  9. Complete/kill: delete owned topics, clear routing/offers, report General outcome; no DM farewell. Preserve other owners; empty repeat sends/deletes nothing; late settlement never recreates topic.
  10. Command menu: after final-build source start/restart, compare dedicated TEST `getMyCommands` with TELEGRAM_COMMANDS; verify `getChatMenuButton` commands type. Record build/start identity; report overrides without deleting scopes.
  11. Failure: rejected create blocks launch/content fallback; ambiguous create never retried. Failed delete/send preserves terminal state, reports/logs outcome within `v2/src/telegram-source-state.ts` bounds.
  12. Images: forum agent runs `spur source reply` with 2 `--image` PNGs and 2 buttons. MTProto read: album in the session topic, never General; album ids below text id; keyboard on text. Repeat with 1 image and `--request-interface-approval`: photo, then approval text with Before/After. Reply-to in the topic, agent answers with 1 image: placeholder deleted, photo then text in that topic. Record message ids.
  13. Interface approval in a forum topic: daemon env `SPUR_REVIEW_APP_CONFIG` names the approver. Agent sends `"$SPUR_SESSION_TOOL_DIR/spur" source reply "..." --request-interface-approval <manifest>`, then a buttonless follow-up. Approver click still approves: "Sending" then "Selected", agent gets `approved` once. Non-approver click: keyboard restored, alert names the approver, events.jsonl `source.telegram.choice_rejected` reason `not-approver`. Spent button click: alert "This choice is no longer active.", no second delivery.

  Voice needs isolated-ui/provider and existing process `SPUR_CONFIG` dir; stale path selects default provider, returns502 `missing_model`. Restart sidecar; check `/api/runtime/voice/transcribe` with `curl -F audio=@<file>`.


CLEANUP

  Stop the isolated daemon by pid, then `tmux -L spur-<port> kill-server`. Stop sidecars with `"$SPUR_SESSION_TOOL_DIR/spur-sidecar" stop --name <name>`. Keep the test bot and forum.
