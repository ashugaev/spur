#!/bin/bash
# Verify that every review thread has a reply and every non-Spur bot thread is resolved.
# Human and Spur reviewer threads stay open for their owner. Exits non-zero and prints offenders.
set -euo pipefail

REPO=$(gh repo view --json owner,name -q '.owner.login + "/" + .name')
BRANCH=$(git branch --show-current)
PR_NUMBER=$(gh pr list --head "$BRANCH" --state all --limit 1 --json number -q '.[0].number')

if [ -z "$PR_NUMBER" ]; then
    echo "No PR found for branch: $BRANCH" >&2
    exit 1
fi

gh api graphql -f query="
query {
  repository(owner: \"$(echo "$REPO" | cut -d/ -f1)\", name: \"$(echo "$REPO" | cut -d/ -f2)\") {
    pullRequest(number: $PR_NUMBER) {
      reviewThreads(first: 100) {
        nodes {
          id
          isResolved
          comments(first: 10) {
            nodes {
              databaseId
              author { __typename login }
              body
            }
            totalCount
          }
        }
      }
    }
  }
}" | python3 -I "$(dirname "$0")/verify_replies.py"
