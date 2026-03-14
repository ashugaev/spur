#!/bin/bash
set -euo pipefail

LIMIT="${1:-5}"

if [[ -z "${TELEGRAM_BOT_TOKEN:-}" ]] || [[ -z "${TELEGRAM_CHAT_ID:-}" ]]; then
  echo "Error: TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID must be set" >&2
  exit 1
fi

RESPONSE=$(curl -s "https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/getUpdates?offset=-${LIMIT}&limit=${LIMIT}" 2>&1)

if ! echo "$RESPONSE" | jq -e '.ok == true' > /dev/null 2>&1; then
  ERROR=$(echo "$RESPONSE" | jq -r '.description // "Unknown error"' 2>/dev/null || echo "$RESPONSE")
  echo "Error: $ERROR" >&2
  exit 1
fi

MESSAGES=$(echo "$RESPONSE" | jq -r --arg chat_id "$TELEGRAM_CHAT_ID" '
  .result[]
  | select(.message.chat.id == ($chat_id | tonumber))
  | .message
  | "[" + (.date | todate) + "] " + (.from.first_name // "Unknown") + ": " + (.text // "[non-text]")
' 2>/dev/null)

if [[ -z "$MESSAGES" ]]; then
  echo "No messages"
else
  echo "$MESSAGES"
fi
