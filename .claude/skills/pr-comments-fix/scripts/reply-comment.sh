#!/bin/bash
set -euo pipefail

COMMENT_ID="$1"
BODY="$2"

REPO=$(gh repo view --json owner,name -q '.owner.login + "/" + .name')
BRANCH=$(git branch --show-current)
PR_NUMBER=$(gh pr list --head "$BRANCH" --repo "$REPO" --json number -q '.[0].number')

# GitHub API requires in_reply_to as a number (not string), so use --field (not -f)
gh api "repos/$REPO/pulls/$PR_NUMBER/comments" \
    --field in_reply_to="$COMMENT_ID" \
    -f body="$BODY"
