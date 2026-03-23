#!/usr/bin/env bash
payload="$(cat)"
if printf '%s' "$payload" | grep -Eq '"stop_hook_active"[[:space:]]*:[[:space:]]*true'; then
  exit 0
fi

# Codex Stop hooks continue the session by exiting 2 and writing the next prompt to stderr.
printf '$code-simplifier\n' >&2
exit 2
