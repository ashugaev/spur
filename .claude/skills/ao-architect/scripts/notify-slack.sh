#!/usr/bin/env bash
# Post product questions to Slack via Bot Token (DM to user)
# Usage: notify-slack.sh "<summary>" "<questions>" "<resolved>"
# Writes slackThreadTs + slackChannelId to session metadata on success
set -euo pipefail

: "${SLACK_BOT_TOKEN:?SLACK_BOT_TOKEN is required}"
: "${SLACK_CHANNEL_ID:?SLACK_CHANNEL_ID is required}"
: "${AO_ISSUE_ID:?AO_ISSUE_ID is required}"
: "${AO_SESSION:?AO_SESSION is required}"
: "${AO_DATA_DIR:?AO_DATA_DIR is required}"

SUMMARY="${1:?Argument 1 (summary) is required}"
QUESTIONS="${2:?Argument 2 (questions) is required}"
RESOLVED="${3:-none}"

BODY="*What I understood:*\n${SUMMARY}\n\n*Product questions:*\n${QUESTIONS}\n\n*Technical questions I resolved myself:*\n${RESOLVED}\n\nReply in this thread — the agent will receive your answers automatically."

PAYLOAD=$(python3 -c "
import json, sys
body = sys.argv[1]
issue = sys.argv[2]
session = sys.argv[3]
channel = sys.argv[4]
print(json.dumps({
  'channel': channel,
  'text': f'[ao] Product questions for {issue}',
  'blocks': [
    {
      'type': 'section',
      'text': {
        'type': 'mrkdwn',
        'text': f'*Task:* \`{issue}\`  •  *Session:* \`{session}\`'
      }
    },
    {
      'type': 'section',
      'text': {
        'type': 'mrkdwn',
        'text': body
      }
    }
  ]
}))
" "$BODY" "$AO_ISSUE_ID" "$AO_SESSION" "$SLACK_CHANNEL_ID")

RESPONSE=$(curl -s -X POST "https://slack.com/api/chat.postMessage" \
  -H "Authorization: Bearer ${SLACK_BOT_TOKEN}" \
  -H "Content-type: application/json; charset=utf-8" \
  -d "$PAYLOAD")

OK=$(echo "$RESPONSE" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('ok', False))")
if [ "$OK" != "True" ]; then
  echo "Slack API error: $RESPONSE" >&2
  exit 1
fi

TS=$(echo "$RESPONSE" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d['ts'])")
CHANNEL_REAL=$(echo "$RESPONSE" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d['channel'])")

# Write thread info to session metadata so the orchestrator can poll for replies
META="$AO_DATA_DIR/$AO_SESSION"
sed -i.bak '/^slackThreadTs=/d; /^slackChannelId=/d' "$META"
printf 'slackThreadTs=%s\nslackChannelId=%s\n' "$TS" "$CHANNEL_REAL" >> "$META"
rm -f "${META}.bak"

echo "Slack DM sent for ${AO_ISSUE_ID} (thread_ts: ${TS}, channel: ${CHANNEL_REAL})"
