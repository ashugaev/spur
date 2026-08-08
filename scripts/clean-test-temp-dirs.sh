#!/usr/bin/env bash
# Operator cleanup for test-fixture dirs leaked by old vitest revisions before
# the temp-dir helper was pinned to TMPDIR. Never run with --delete against
# a real ~/.spur tree without checking the dry-run output first.
set -euo pipefail

ROOT="$HOME/.spur/worktrees"
DELETE=0

usage() {
  echo "Usage: $0 [--root DIR] [--delete]" >&2
  echo "  --root DIR   root to scan (default: \$HOME/.spur/worktrees)" >&2
  echo "  --delete     actually remove matches (default: dry-run, list only)" >&2
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --root)
      ROOT="$2"
      shift 2
      ;;
    --delete)
      DELETE=1
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "Unknown argument: $1" >&2
      usage
      exit 1
      ;;
  esac
done

if [[ ! -d "$ROOT" ]]; then
  echo "Root does not exist: $ROOT" >&2
  exit 1
fi

# Matches only the exact mkdtemp shape the leaking fixtures used: a known
# family prefix followed by a 6-char mkdtemp suffix. Cannot collide with a
# real worktree (spur-<4 hex>, e.g. spur-56cd, spur-6147).
PATTERN='^spur-(comment-seen|metadata-test|runtime|runtime-repo|runtime-origin|smoke-claude|smoke-codex|smoke-cursor|probe)-[A-Za-z0-9]{6}$'

candidates=()
total_size=0

# Depth 1 and depth 2 only: that is where every measured leak sits.
while IFS= read -r -d '' dir; do
  base="$(basename "$dir")"
  if [[ ! "$base" =~ $PATTERN ]]; then
    continue
  fi
  if find "$dir" -maxdepth 10 -name ".git" -print -quit | grep -q .; then
    echo "SKIP (contains .git): $dir"
    continue
  fi
  candidates+=("$dir")
  # du exits non-zero on an unreadable subdir (runtime fixtures create some);
  # under set -euo pipefail that would abort the whole script mid-scan, so
  # tolerate the failure and treat an unmeasurable dir as 0 size.
  size="$(du -sk "$dir" 2>/dev/null | cut -f1)" || size=0
  total_size=$((total_size + ${size:-0}))
done < <(find "$ROOT" -mindepth 1 -maxdepth 2 -type d -print0)

if [[ ${#candidates[@]} -eq 0 ]]; then
  echo "No leaked test-fixture dirs found under $ROOT."
  exit 0
fi

if [[ "$DELETE" -eq 1 ]]; then
  for dir in "${candidates[@]}"; do
    echo "REMOVE: $dir"
    rm -rf -- "$dir"
  done
  echo "Removed ${#candidates[@]} dirs."
else
  for dir in "${candidates[@]}"; do
    echo "$dir"
  done
  echo "Total: ${#candidates[@]} dirs, $((total_size / 1024)) MiB. Re-run with --delete to remove."
fi
