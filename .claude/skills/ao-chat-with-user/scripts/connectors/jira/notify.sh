#!/usr/bin/env bash
# Post product questions as a Jira issue comment via REST API
# Usage: notify.sh "<summary>" "<questions>"
# Writes jiraCommentId to session metadata on success
set -euo pipefail

: "${JIRA_BASE_URL:?JIRA_BASE_URL is required (e.g. https://yourorg.atlassian.net)}"
: "${JIRA_EMAIL:?JIRA_EMAIL is required}"
: "${JIRA_API_TOKEN:?JIRA_API_TOKEN is required}"
: "${AO_ISSUE_ID:?AO_ISSUE_ID is required}"
: "${AO_SESSION:?AO_SESSION is required}"
: "${AO_DATA_DIR:?AO_DATA_DIR is required}"

SUMMARY="${1:?Argument 1 (summary) is required}"
QUESTIONS="${2:?Argument 2 (questions) is required}"

COMMENT_BODY="*[ao] Product questions — Session \`${AO_SESSION}\`*

*What I understood:*
${SUMMARY}

*Open questions:*
${QUESTIONS}

Reply to this comment prefixed with \"Jira answers:\" — the agent will receive your answers automatically."

PAYLOAD=$(python3 -c "
import json, sys
body = sys.argv[1]
print(json.dumps({'body': body}))
" "$COMMENT_BODY")

RESPONSE=$(curl -s -X POST \
  "${JIRA_BASE_URL}/rest/api/2/issue/${AO_ISSUE_ID}/comment" \
  -u "${JIRA_EMAIL}:${JIRA_API_TOKEN}" \
  -H "Content-Type: application/json" \
  -d "$PAYLOAD")

COMMENT_ID=$(echo "$RESPONSE" | python3 -c "
import sys, json
d = json.load(sys.stdin)
if 'id' not in d:
    print('Jira API error: ' + json.dumps(d), file=sys.stderr)
    sys.exit(1)
print(d['id'])
")

# Write comment ID to session metadata so the orchestrator knows to poll Jira
META="$AO_DATA_DIR/$AO_SESSION"
sed -i.bak '/^jiraCommentId=/d' "$META"
printf 'jiraCommentId=%s\n' "$COMMENT_ID" >> "$META"
rm -f "${META}.bak"

echo "Jira comment posted for ${AO_ISSUE_ID} (comment_id: ${COMMENT_ID})"
