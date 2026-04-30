---
name: telegram
description: Send messages and read updates from Telegram via Bot API.
---

# Telegram Bot Skill

Env: `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID`.

```bash
# Send (MarkdownV2 supported)
bash ./.agents/skills/telegram/scripts/send_message.sh "<text>"

# Read last N messages (default 5). Format: [timestamp] from_user: message_text
bash ./.agents/skills/telegram/scripts/get_updates.sh [limit]
```
