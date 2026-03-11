#!/usr/bin/env bash
# Poll a Slack thread for replies (used for testing / manual verification)
# Usage: poll-slack-thread.sh <channel_id> <thread_ts> [since_ts]
set -euo pipefail

: "${SLACK_BOT_TOKEN:?SLACK_BOT_TOKEN is required}"

CHANNEL="${1:?Argument 1 (channel_id) is required}"
THREAD_TS="${2:?Argument 2 (thread_ts) is required}"
SINCE_TS="${3:-${THREAD_TS}}"

RESPONSE=$(curl -s "https://slack.com/api/conversations.replies?channel=${CHANNEL}&ts=${THREAD_TS}&oldest=${SINCE_TS}&limit=50" \
  -H "Authorization: Bearer ${SLACK_BOT_TOKEN}")

OK=$(echo "$RESPONSE" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('ok', False))")
if [ "$OK" != "True" ]; then
  echo "Slack API error: $RESPONSE" >&2
  exit 1
fi

# Print human replies (skip root message, skip bot messages)
echo "$RESPONSE" | python3 -c "
import sys, json
d = json.load(sys.stdin)
msgs = d.get('messages', [])
thread_ts = sys.argv[1]
since_ts = sys.argv[2]
replies = [m for m in msgs if m.get('ts') != thread_ts and float(m.get('ts', 0)) > float(since_ts) and not m.get('bot_id')]
if not replies:
    print('(no new replies)')
else:
    for m in replies:
        print(f\"[{m['ts']}] {m.get('user', '?')}: {m.get('text', '')}\")
" "$THREAD_TS" "$SINCE_TS"
