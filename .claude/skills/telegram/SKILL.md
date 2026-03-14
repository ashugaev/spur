---
name: telegram
description: Send messages and get updates from Telegram via Bot API. Use for human-in-the-loop communication, notifications, and async collaboration.
---

# Telegram Bot Skill

Use this skill when you need to communicate with a human via Telegram.

## Requirements

Environment variables in shell:
- `TELEGRAM_BOT_TOKEN` - bot token from @BotFather
- `TELEGRAM_CHAT_ID` - target chat ID

## Scripts

### Send Message

```bash
bash ./.claude/skills/telegram/scripts/send_message.sh "Your message here"
```

Supports markdown formatting (MarkdownV2).

### Get Updates

```bash
bash ./.claude/skills/telegram/scripts/get_updates.sh [limit]
```

Returns last N messages (default: 5). Output format:
```
[timestamp] from_user: message_text
```

## Usage Patterns

### Notify human about completion
```bash
bash ./.claude/skills/telegram/scripts/send_message.sh "Task completed: $TASK_NAME"
```

### Ask question and wait for response
```bash
bash ./.claude/skills/telegram/scripts/send_message.sh "Need clarification: which approach to use?"
# Wait some time...
bash ./.claude/skills/telegram/scripts/get_updates.sh 1
```

### Report error
```bash
bash ./.claude/skills/telegram/scripts/send_message.sh "❌ Build failed: $ERROR_MSG"
```
