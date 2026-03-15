---
name: ao-telegram
description: Send and receive Telegram messages. Use for pipeline notifications, human-in-the-loop questions, and status updates. Append AO_SESSION to every message.
---

Append `[AO_SESSION:$AO_SESSION_ID]` to every outgoing message.

## Send

```bash
bash ./.agents/skills/telegram/scripts/send_message.sh "$MESSAGE"
```

Supports MarkdownV2. Falls back to plain text on parse error.

## Receive

```bash
bash ./.agents/skills/telegram/scripts/get_updates.sh [limit]
```

Returns last N messages (default: 5). Format: `[timestamp] from_user: text`

## Requirements

- `TELEGRAM_BOT_TOKEN`
- `TELEGRAM_CHAT_ID`
