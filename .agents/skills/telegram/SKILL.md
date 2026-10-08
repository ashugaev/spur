---
name: telegram
description: Send messages and read updates from Telegram via Bot API.
---

TELEGRAM BOT SKILL: env TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID.

SESSION APPROVALS

  Send text/buttons through session-bound `spur source reply`; docs/commands.md owns command.
  Attach UI screenshot through Bot API `sendPhoto`, using bound target or explicitly authorized configured recipient.
  Read binding through `readTelegramReplyTarget`, v2/src/metadata.ts; resolve matching current-project source configuration.
  Without binding, select one current-project source matching established integration token/chat pair; reject missing or ambiguous matches.
  Preserve bound/configured topic and source chat allowlist; never guess chats or mix source credentials.
  Upload PNG as multipart photo; validate Telegram success, retain message ID as evidence.
  Keep credentials and target IDs out of output, artifacts and GitHub.

  - Send, MarkdownV2 supported:
    bash ./.agents/skills/telegram/scripts/send_message.sh "<text>"
  - Read last N messages, default 5, format [timestamp] from_user: message_text:
    bash ./.agents/skills/telegram/scripts/get_updates.sh [limit]
