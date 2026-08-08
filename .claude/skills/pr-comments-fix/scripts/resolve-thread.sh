#!/bin/bash
set -euo pipefail

THREAD_ID="$1"

gh api graphql -f query="mutation { resolveReviewThread(input: {threadId: \"$THREAD_ID\"}) { thread { isResolved } } }"
