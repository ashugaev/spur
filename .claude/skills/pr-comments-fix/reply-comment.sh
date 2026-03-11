#!/bin/bash
set -euo pipefail

COMMENT_ID="$1"
BODY="$2"

REPO=$(gh repo view --json owner,name -q '.owner.login + "/" + .name')

gh api "repos/$REPO/pulls/comments/$COMMENT_ID/replies" -X POST -f body="$BODY"
