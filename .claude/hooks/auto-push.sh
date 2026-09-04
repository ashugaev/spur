#!/usr/bin/env bash
set -euo pipefail
mode="${1:-}"
if [ "${SPUR_CLOSEOUT_OWNER:-}" = "0" ]; then
  exit 0
fi

marker=""
marker_lock=""
marker_lock_held=0
temporary=""
if [ -n "${SPUR_SESSION:-}" ] && [ -n "${SPUR_SESSION_TOOL_DIR:-}" ]; then
  marker="$SPUR_SESSION_TOOL_DIR/auto-push-stop-state"
  marker_lock="${marker}.lock"
fi

cleanup_marker_transition() {
  if [ -n "$temporary" ]; then
    rm -f "$temporary" 2>/dev/null || true
  fi
  if [ "$marker_lock_held" = "1" ]; then
    rmdir "$marker_lock" 2>/dev/null || true
  fi
}

acquire_marker_lock() {
  [ -d "$SPUR_SESSION_TOOL_DIR" ] || return 1
  attempts=0
  while ! mkdir "$marker_lock" 2>/dev/null; do
    attempts=$((attempts + 1))
    [ "$attempts" -lt 200 ] || return 1
    sleep 0.01 || return 1
  done
  marker_lock_held=1
}

release_marker_lock() {
  rmdir "$marker_lock" 2>/dev/null || return 1
  marker_lock_held=0
}

write_marker_state() {
  state="$1"
  temporary="$(mktemp "${marker}.tmp.XXXXXX" 2>/dev/null)" || return 1
  printf '%s\n' "$state" >"$temporary" || return 1
  chmod 600 "$temporary" || return 1
  mv "$temporary" "$marker" || return 1
  temporary=""
}

record_no_obligation() {
  [ -n "$marker" ] || return 0
  acquire_marker_lock || return 1
  write_marker_state none || return 1
  release_marker_lock
}

claim_obligation() {
  fingerprint="$1"
  [ -n "$marker" ] || return 0
  acquire_marker_lock || return 1
  if [ -e "$marker" ]; then
    previous="$(<"$marker")" || return 1
    [ "$previous" != "$fingerprint" ] || return 1
  fi
  write_marker_state "$fingerprint" || return 1
  release_marker_lock
}

trap cleanup_marker_transition EXIT
cd "${CLAUDE_PROJECT_DIR:-.}"
branch="$(git branch --show-current 2>/dev/null)"
case "$branch" in
  main|master|"") record_no_obligation || exit 0; exit 0 ;;
esac
problems=""
status="$(git status --porcelain 2>/dev/null || printf 'unknown')"
if [ -n "$status" ]; then
  problems="$problems uncommitted"
elif default_ref="$(git symbolic-ref -q refs/remotes/origin/HEAD 2>/dev/null)" \
  && git rev-parse --verify --quiet "${default_ref}^{commit}" >/dev/null 2>&1 \
  && git diff --quiet "${default_ref}...HEAD" >/dev/null 2>&1; then
  record_no_obligation || exit 0
  exit 0
fi
gh pr view >/dev/null 2>&1 || problems="$problems no-pr"
if [ -n "$problems" ]; then
  if [ -n "$marker" ]; then
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
    claim_obligation "$fingerprint" || exit 0
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
else
  record_no_obligation || exit 0
fi
