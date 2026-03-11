#!/usr/bin/env bash
# Poll Telegram for replies to a specific bot message (manual testing)
# Usage: poll-telegram.sh <chat_id> <question_message_id>
set -euo pipefail

: "${TELEGRAM_BOT_TOKEN:?TELEGRAM_BOT_TOKEN is required}"

CHAT_ID="${1:?Argument 1 (chat_id) is required}"
QUESTION_MSG_ID="${2:?Argument 2 (question_message_id) is required}"

RESPONSE=$(curl -s "https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/getUpdates?timeout=0&limit=100&allowed_updates=%5B%22message%22%5D")

OK=$(echo "$RESPONSE" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('ok', False))")
if [ "$OK" != "True" ]; then
  echo "Telegram API error: $RESPONSE" >&2
  exit 1
fi

echo "$RESPONSE" | python3 -c "
import sys, json
d = json.load(sys.stdin)
updates = d.get('result', [])
chat_id = sys.argv[1]
question_msg_id = int(sys.argv[2])
found = False
for u in updates:
    msg = u.get('message', {})
    if str(msg.get('chat', {}).get('id', '')) != chat_id:
        continue
    reply_to = msg.get('reply_to_message', {})
    if reply_to.get('message_id') != question_msg_id:
        continue
    user = msg.get('from', {}).get('username', '?')
    text = msg.get('text', '')
    msg_id = msg.get('message_id', '?')
    print(f'[msg_id={msg_id}] @{user}: {text}')
    found = True
if not found:
    print('(no replies to message ${QUESTION_MSG_ID} yet)')
" "$CHAT_ID" "$QUESTION_MSG_ID"
