#!/bin/bash
set -euo pipefail

COMMENT_ID="$1"
BODY="$2"

REPO=$(gh repo view --json owner,name -q '.owner.login + "/" + .name')
BRANCH=$(git branch --show-current)
PR_NUMBER=$(gh pr list --head "$BRANCH" --repo "$REPO" --state all --limit 1 --json number -q '.[0].number')

# GitHub API requires in_reply_to as a number (not string), so use --field (not -f)
NEW_ID=$(gh api "repos/$REPO/pulls/$PR_NUMBER/comments" \
    --field in_reply_to="$COMMENT_ID" \
    -f body="$BODY" \
    --jq '.id')

# Record the reply as seen so the poll loop never re-triggers on our own comment.
# Only inside a Spur session (no poll loop exists outside one).
if [ -n "${SPUR_PROJECT:-}" ]; then
    if [ -n "${SPUR_SESSION_TOOL_DIR:-}" ]; then
        "$SPUR_SESSION_TOOL_DIR/spur" comment-seen record "$NEW_ID"
    else
        spur comment-seen record "$NEW_ID"
    fi
else
    echo "reply-comment: SPUR_PROJECT unset; skipping comment-seen record." >&2
fi
