#!/usr/bin/env bash
# Dispatch product questions to the available connector: Telegram (preferred) → Slack.
# Usage: notify-human.sh "<summary>" "<questions>" "<resolved>"
set -euo pipefail

SUMMARY="${1:?Argument 1 (summary) is required}"
QUESTIONS="${2:?Argument 2 (questions) is required}"
RESOLVED="${3:-none}"

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

if [ -n "${TELEGRAM_BOT_TOKEN:-}" ] && [ -n "${TELEGRAM_CHAT_ID:-}" ]; then
  exec bash "$DIR/notify-telegram.sh" "$SUMMARY" "$QUESTIONS" "$RESOLVED"
elif [ -n "${SLACK_BOT_TOKEN:-}" ] && [ -n "${SLACK_CHANNEL_ID:-}" ]; then
  exec bash "$DIR/notify-slack.sh" "$SUMMARY" "$QUESTIONS" "$RESOLVED"
else
  echo "ERROR: no messenger configured — set TELEGRAM_BOT_TOKEN+TELEGRAM_CHAT_ID or SLACK_BOT_TOKEN+SLACK_CHANNEL_ID" >&2
  exit 1
fi
