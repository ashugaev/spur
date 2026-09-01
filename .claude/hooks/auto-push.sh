#!/usr/bin/env bash
set -euo pipefail
mode="${1:-}"
if [ "${SPUR_CLOSEOUT_OWNER:-}" = "0" ]; then
  exit 0
fi
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
  if [ -n "${SPUR_SESSION:-}" ] && [ -n "${SPUR_SESSION_TOOL_DIR:-}" ]; then
    head="$(git rev-parse HEAD 2>/dev/null || printf 'unborn')"
    problem_set=""
    case " $problems " in
      *" no-pr "*) problem_set="no-pr" ;;
    esac
    case " $problems " in
      *" uncommitted "*) problem_set="${problem_set:+$problem_set }uncommitted" ;;
    esac
    fingerprint="$(printf '%s\0%s\0%s\0%s\0' "$branch" "$head" "$status" "$problem_set" | sha256sum 2>/dev/null | cut -d ' ' -f 1)" || exit 0
    [ -n "$fingerprint" ] || exit 0
    marker="$SPUR_SESSION_TOOL_DIR/auto-push-stop-state"
    if [ -e "$marker" ]; then
      previous="$(<"$marker")" || exit 0
      [ "$previous" != "$fingerprint" ] || exit 0
    fi
    temporary="$(mktemp "${marker}.tmp.XXXXXX" 2>/dev/null)" || exit 0
    trap 'rm -f "$temporary"' EXIT
    printf '%s\n' "$fingerprint" >"$temporary" || exit 0
    chmod 600 "$temporary" || exit 0
    mv "$temporary" "$marker" || exit 0
    trap - EXIT
  fi
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
