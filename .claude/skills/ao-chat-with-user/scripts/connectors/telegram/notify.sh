#!/usr/bin/env bash
# Send product questions to Telegram via Bot API
# Usage: notify.sh "<summary>" "<questions>"
# Writes telegramChatId + telegramMessageId to session metadata on success
set -euo pipefail

: "${TELEGRAM_BOT_TOKEN:?TELEGRAM_BOT_TOKEN is required}"
: "${TELEGRAM_CHAT_ID:?TELEGRAM_CHAT_ID is required}"
: "${AO_ISSUE_ID:?AO_ISSUE_ID is required}"
: "${AO_SESSION:?AO_SESSION is required}"
: "${AO_DATA_DIR:?AO_DATA_DIR is required}"

SUMMARY="${1:?Argument 1 (summary) is required}"
QUESTIONS="${2:?Argument 2 (questions) is required}"

PAYLOAD=$(python3 -c "
import json, sys
issue, session, chat_id, summary, questions = sys.argv[1:]
text = (
    f'*[ao] {issue}*\n'
    f'Session: \`{session}\`\n\n'
    f'*What I understood:*\n{summary}\n\n'
    f'*Open questions:*\n{questions}\n\n'
    f'Reply here \u2014 prefix your message with \"Telegram answers:\" and the agent will receive it automatically.'
)
print(json.dumps({
    'chat_id': chat_id,
    'text': text,
    'parse_mode': 'Markdown'
}))
" "$AO_ISSUE_ID" "$AO_SESSION" "$TELEGRAM_CHAT_ID" "$SUMMARY" "$QUESTIONS")

RESPONSE=$(curl -s -X POST "https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage" \
  -H "Content-type: application/json" \
  -d "$PAYLOAD")

OK=$(echo "$RESPONSE" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('ok', False))")
if [ "$OK" != "True" ]; then
  echo "Telegram API error: $RESPONSE" >&2
  exit 1
fi

MSG_ID=$(echo "$RESPONSE" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d['result']['message_id'])")

# Write to session metadata so the orchestrator knows to poll Telegram
META="$AO_DATA_DIR/$AO_SESSION"
sed -i.bak '/^telegramChatId=/d; /^telegramMessageId=/d' "$META"
printf 'telegramChatId=%s\ntelegramMessageId=%s\n' "$TELEGRAM_CHAT_ID" "$MSG_ID" >> "$META"
rm -f "${META}.bak"

echo "Telegram message sent for ${AO_ISSUE_ID} (msg_id: ${MSG_ID}, chat: ${TELEGRAM_CHAT_ID})"
