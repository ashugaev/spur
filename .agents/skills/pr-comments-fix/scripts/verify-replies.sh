#!/bin/bash
# Verify that every review thread has at least one reply and is resolved.
# Exits non-zero and prints offenders if any are missing.
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
              author { login }
              body
            }
            totalCount
          }
        }
      }
    }
  }
}" | python3 -c "
import json, sys
data = json.load(sys.stdin)
threads = data['data']['repository']['pullRequest']['reviewThreads']['nodes']
issues = []
for t in threads:
    first = t['comments']['nodes'][0] if t['comments']['nodes'] else None
    if not first:
        continue
    has_reply = t['comments']['totalCount'] > 1
    is_resolved = t['isResolved']
    if not has_reply or not is_resolved:
        issues.append({
            'thread_id': t['id'],
            'comment_id': first['databaseId'],
            'author': first['author']['login'],
            'has_reply': has_reply,
            'is_resolved': is_resolved,
            'body': first['body'][:80],
        })

if issues:
    print(f'FAIL: {len(issues)} thread(s) need attention:')
    for i in issues:
        flags = []
        if not i['has_reply']: flags.append('NO REPLY')
        if not i['is_resolved']: flags.append('NOT RESOLVED')
        print(f'  [{\" | \".join(flags)}] comment_id={i[\"comment_id\"]} thread={i[\"thread_id\"]}')
        print(f'    @{i[\"author\"]}: {i[\"body\"]}')
    sys.exit(1)
else:
    print(f'OK: all {len(threads)} threads have replies and are resolved.')
"
