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
  echo "github skill close-out gate required:$problems" >&2
  exit 1
fi
