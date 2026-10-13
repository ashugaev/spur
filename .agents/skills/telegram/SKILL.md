---
name: telegram
description: Send a Telegram message via Bot API sendMessage.
---

TELEGRAM BOT SKILL: env TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID.

  - Send, MarkdownV2 supported:
    bash ./.agents/skills/telegram/scripts/send_message.sh "<text>"


NEVER

  - Bot API getUpdates. A Spur telegram source long-polls its bot token; a second poller gets 409 and an offset drops updates the daemon has not fetched.


INBOUND

  Bound chat messages arrive as telegram:message sends; reply with `spur source reply`. Binding and routing: docs/configuration.md Telegram binding.
