---
name: telegram
description: Sends a Telegram notification through Bot API sendMessage. Use when an agent must push a message to the operator's chat. Don't use for reading inbound messages.
---

TELEGRAM BOT SKILL: env TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID.

  - Send, MarkdownV2 supported:
    bash ./.claude/skills/telegram/scripts/send_message.sh "<text>"


NEVER

  - Bot API getUpdates. Spur telegram source owns token long-poll: second poller 409s, offset drops unfetched updates.


INBOUND

  Arrival needs a matching `telegram:message` send trigger on a bound chat. Reply with `spur source reply`.
  Binding and routing: docs/configuration.md#telegram-binding
