#!/bin/bash
set -euo pipefail

REPO=$(gh repo view --json owner,name -q '.owner.login + "/" + .name')
BRANCH=$(git branch --show-current)
PR_NUMBER=$(gh pr list --head "$BRANCH" --state all --limit 1 --json number -q '.[0].number')

if [ -z "$PR_NUMBER" ]; then
    echo "No PR found for branch: $BRANCH" >&2
    exit 1
fi

echo "PR: $PR_NUMBER ($REPO) branch: $BRANCH"
echo "---"

# Fetch threads (with GraphQL node IDs for resolving) and inline comments
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
              author { login }
              path
              line
              body
              diffHunk
            }
          }
        }
      }
    }
  }
}" | python3 -c "
import json, sys
data = json.load(sys.stdin)
threads = data['data']['repository']['pullRequest']['reviewThreads']['nodes']
for t in threads:
    resolved = t['isResolved']
    thread_id = t['id']
    comments = t['comments']['nodes']
    if not comments:
        continue
    first = comments[0]
    print('===THREAD===')
    print(f'thread_id: {thread_id}')
    print(f'resolved: {resolved}')
    print(f'comment_id: {first[\"databaseId\"]}')
    print(f'user: {first[\"author\"][\"login\"]}')
    print(f'path: {first[\"path\"]}')
    print(f'line: {first.get(\"line\", \"N/A\")}')
    print(f'body: {first[\"body\"]}')
    hunk = first.get('diffHunk', '')
    if hunk:
        lines = hunk.split('\n')
        print('diff_hunk_tail:')
        for l in lines[-8:]:
            print(f'  {l}')
    if len(comments) > 1:
        print(f'replies: {len(comments) - 1}')
        for r in comments[1:]:
            print(f'  > {r[\"author\"][\"login\"]}: {r[\"body\"][:200]}')
    print()
"
