#!/usr/bin/env bash
set -euo pipefail
cd "${CLAUDE_PROJECT_DIR:-.}"
branch="$(git branch --show-current)"
case "$branch" in
  main|master|"") exit 0 ;;
esac
problems=""
[ -n "$(git status --porcelain)" ] && problems="$problems uncommitted"
gh pr view >/dev/null 2>&1 || problems="$problems no-pr"
if [ -n "$problems" ]; then
  cat <<EOF
\$github

Use the github close-out gate before stopping.

Problems:$problems

Inspect the worktree. Commit and push every change that belongs in the PR. For files that should not be committed, move session artifacts to \$SPUR_SESSION_ARTIFACTS_DIR or remove scratch files, then report what was excluded. If no PR exists for this branch, create one.
EOF
fi
