---
name: tg-chatter
description: Send a Telegram notification to the human. Use for pipeline start/completion events and status updates.
model: inherit
tools: Bash
---

Send message via Telegram. Append `[AO_SESSION:$AO_SESSION_ID]` to every message.

```bash
bash .claude/skills/telegram/scripts/send_message.sh "$MESSAGE"
```
