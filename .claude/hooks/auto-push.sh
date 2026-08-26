#!/usr/bin/env bash
set -euo pipefail
mode="${1:-}"
cd "${CLAUDE_PROJECT_DIR:-.}"
branch="$(git branch --show-current 2>/dev/null)"
case "$branch" in
  main|master|"") exit 0 ;;
esac
problems=""
status="$(git status --porcelain 2>/dev/null || printf 'unknown')"
if [ -n "$status" ]; then
  problems="$problems uncommitted"
elif default_ref="$(git symbolic-ref -q refs/remotes/origin/HEAD 2>/dev/null)" \
  && git rev-parse --verify --quiet "${default_ref}^{commit}" >/dev/null 2>&1 \
  && git diff --quiet "${default_ref}...HEAD" >/dev/null 2>&1; then
  exit 0
fi
gh pr view >/dev/null 2>&1 || problems="$problems no-pr"
if [ -n "$problems" ]; then
  if [ "$mode" = "codex" ]; then
    cat <<EOF
{"decision":"block","reason":"\$github\n\nUse the github close-out gate before stopping.\n\nProblems:$problems\n\nInspect the worktree. Commit and push every change that belongs in the PR. For files that should not be committed, move session artifacts to \$SPUR_SESSION_ARTIFACTS_DIR or remove scratch files, then report what was excluded. If no PR exists for this branch, create one."}
EOF
  else
    cat <<EOF
\$github

Use the github close-out gate before stopping.

Problems:$problems

Inspect the worktree. Commit and push every change that belongs in the PR. For files that should not be committed, move session artifacts to \$SPUR_SESSION_ARTIFACTS_DIR or remove scratch files, then report what was excluded. If no PR exists for this branch, create one.
EOF
  fi
fi
