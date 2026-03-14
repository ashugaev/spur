---
name: telegram
description: Send messages and get updates from Telegram via Bot API.
---

# Telegram Skill

## Requirements

- `TELEGRAM_BOT_TOKEN` — bot token from @BotFather
- `TELEGRAM_CHAT_ID` — target chat ID

## Send message

```bash
bash .claude/skills/telegram/scripts/send_message.sh "Your message"
```

Supports MarkdownV2 formatting. Falls back to plain text on parse error.

## Get updates

```bash
bash .claude/skills/telegram/scripts/get_updates.sh [limit]
```

Returns last N messages (default: 5). Format: `[timestamp] from_user: text`
