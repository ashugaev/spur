#!/bin/bash
set -euo pipefail

MESSAGE="${1:-}"

if [[ -z "$MESSAGE" ]]; then
  echo "Usage: send_message.sh <message>" >&2
  exit 1
fi

if [[ -z "${TELEGRAM_BOT_TOKEN:-}" ]] || [[ -z "${TELEGRAM_CHAT_ID:-}" ]]; then
  echo "Error: TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID must be set" >&2
  exit 1
fi

RESPONSE=$(curl -s -X POST "https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage" \
  -H "Content-Type: application/json" \
  -d "{\"chat_id\": \"${TELEGRAM_CHAT_ID}\", \"text\": $(echo "$MESSAGE" | jq -Rs .), \"parse_mode\": \"MarkdownV2\"}" 2>&1)

if echo "$RESPONSE" | jq -e '.ok == true' > /dev/null 2>&1; then
  echo "Message sent"
else
  ERROR=$(echo "$RESPONSE" | jq -r '.description // "Unknown error"' 2>/dev/null || echo "$RESPONSE")
  
  # Retry without markdown if parse error
  if [[ "$ERROR" == *"parse"* ]] || [[ "$ERROR" == *"entities"* ]]; then
    RESPONSE=$(curl -s -X POST "https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage" \
      -H "Content-Type: application/json" \
      -d "{\"chat_id\": \"${TELEGRAM_CHAT_ID}\", \"text\": $(echo "$MESSAGE" | jq -Rs .)}" 2>&1)
    
    if echo "$RESPONSE" | jq -e '.ok == true' > /dev/null 2>&1; then
      echo "Message sent (plain text)"
    else
      echo "Error: $ERROR" >&2
      exit 1
    fi
  else
    echo "Error: $ERROR" >&2
    exit 1
  fi
fi
