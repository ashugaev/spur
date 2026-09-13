#!/bin/bash
set -euo pipefail

BRANCH=$(git branch --show-current)
PR_NUMBER=$(gh pr list --head "$BRANCH" --state all --limit 1 --json number -q '.[0].number')

if [ -z "$PR_NUMBER" ]; then
    echo "No PR found for branch: $BRANCH" >&2
    exit 1
fi

gh pr view "$PR_NUMBER" --json number,title,url,headRefName,baseRefName,state,reviewDecision -q '
"PR #\(.number): \(.title)
URL: \(.url)
Branch: \(.headRefName) -> \(.baseRefName)
State: \(.state)
Review: \(.reviewDecision)"
'
