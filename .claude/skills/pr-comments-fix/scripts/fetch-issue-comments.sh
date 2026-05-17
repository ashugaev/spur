#!/bin/bash
set -euo pipefail

REPO=$(gh repo view --json owner,name -q '.owner.login + "/" + .name')
BRANCH=$(git branch --show-current)
PR_NUMBER=$(gh pr list --head "$BRANCH" --limit 1 --json number -q '.[0].number')

if [ -z "$PR_NUMBER" ]; then
    echo "No open PR found for branch: $BRANCH" >&2
    exit 1
fi

gh api "repos/$REPO/issues/$PR_NUMBER/comments" | python3 -c "
import json, sys
comments = json.load(sys.stdin)
for c in comments:
    print('===COMMENT===')
    print(f'id: {c[\"id\"]}')
    print(f'user: {c[\"user\"][\"login\"]}')
    print(f'body: {c[\"body\"]}')
    print()
"
