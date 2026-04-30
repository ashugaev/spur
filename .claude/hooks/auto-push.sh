#!/usr/bin/env bash
set -euo pipefail
cd "${CLAUDE_PROJECT_DIR:-.}"
[ -z "$(git status --porcelain)" ] && exit 0
branch="$(git branch --show-current)"
case "$branch" in
  main|master|"") exit 0 ;;
esac
git add -A
git commit -m "chore: auto-push wip on $branch"
git push -u origin "$branch"
