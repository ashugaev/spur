---
name: telegram
description: Send messages and read updates from Telegram via Bot API.
---

TELEGRAM BOT SKILL: env TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID.

SESSION APPROVALS

  Resolve authorized current-project source/chat/topic once; verify credentials and chat allowlist.
  Read `readTelegramReplyTarget`, v2/src/metadata.ts; without binding, require unique configured source matching explicitly authorized integration token/chat pair.
  Send text/PNG through Bot API `sendMessage`/`sendPhoto` using same target.
  Allow `spur source reply` buttons only when `replyToSource`, v2/src/session-service.ts, selects same target; otherwise request text approval. Command: docs/commands.md.
  Re-read binding after source reply; reject source/chat changes or loss; use settled topic for photo.
  Upload multipart PNG; validate both sends, retain message IDs as evidence.
  Keep credentials and target IDs out of output, artifacts and GitHub.

  - Send, MarkdownV2 supported:
    bash ./.claude/skills/telegram/scripts/send_message.sh "<text>"
  - Read last N messages, default 5, format [timestamp] from_user: message_text:
    bash ./.claude/skills/telegram/scripts/get_updates.sh [limit]
