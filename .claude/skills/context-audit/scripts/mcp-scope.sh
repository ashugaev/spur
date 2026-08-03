#!/bin/bash
# mcp-scope.sh - effective MCP registration, scope, owner, CLI-replacement
# status. Verified against Claude Code 2.1.220, codex-cli 0.145.0. No args.
set -euo pipefail

# Candidates in preference order; the first one on PATH wins.
cli_for() { case "$(tr 'A-Z' 'a-z' <<<"$1")" in
  *github*) echo gh ;; *sentry*) echo sentry-cli ;; *jira*|*atlassian*) echo "jira acli" ;;
  *playwright*) echo playwright ;; *filesystem*) echo shell ;; *aws*) echo aws ;;
  *gcp*|*gcloud*) echo gcloud ;; *postgres*) echo psql ;; *) echo - ;; esac; }

# First installed candidate, else the preferred one. Echoes "<cli> <found|missing>".
cli_pick() {
  local c
  for c in $1; do command -v "$c" >/dev/null 2>&1 && { echo "$c found"; return; }; done
  echo "${1%% *} missing"
}

verdict_for() {
  local name=$1 cli=$2 status=$3 scope=$4
  [ "$scope" = settings.json ] && { echo INERT; return; }
  case "$(tr 'A-Z' 'a-z' <<<"$name")" in
    *playwright*) echo keep:live-driving; return ;;
    *figma*|*linear*|*notion*|*slack*) echo keep:no-cli; return ;;
  esac
  [ "$cli" != - ] && { echo "migrate:$cli"; return; }
  echo keep
}

ROWS=0
emit() {
  local cli status
  cli=$(cli_for "$2"); status=-
  [ "$cli" != - ] && read -r cli status < <(cli_pick "$cli")
  printf '%s\t%s\t%s\t%s\t%s\t%s\t%s\n' "$1" "$2" "$3" "$4" "$cli" "$status" "$(verdict_for "$2" "$cli" "$status" "$3")"
  ROWS=$((ROWS + 1))
}

printf 'vendor\tserver\tscope\towner\tcli\tcli_status\tverdict\n'

# ~/.claude.json owner map, ~/.claude/settings.json inert names, repo .mcp.json.
data=$(python3 - <<'PY'
import json, os
def load(p):
    try:
        return json.load(open(p))
    except FileNotFoundError:
        return {}
home = os.path.expanduser('~')
cj = load(os.path.join(home, '.claude.json'))
for name in cj.get('mcpServers', {}):
    print(f"MAP\t{name}\tuser\t-")
for proj, v in cj.get('projects', {}).items():
    for name in v.get('mcpServers', {}):
        print(f"MAP\t{name}\tproject\t{proj}")
for name in load(os.path.join(home, '.claude', 'settings.json')).get('mcpServers', {}):
    print(f"SETTINGS\t{name}\t-\t-")
for name in load('.mcp.json').get('mcpServers', {}):
    print(f"PROJECT\t{name}\tproject\t{os.getcwd()}")
PY
)
[ -n "$data" ] || { echo "mcp-scope: unparseable ~/.claude.json / settings.json" >&2; exit 1; }

declare -A SCOPE OWNERS EFFECTIVE
declare -a SETTINGS_NAMES=()
while IFS=$'\t' read -r tag name scope owner; do
  case "$tag" in
    MAP) SCOPE[$name]=$scope; OWNERS[$name]=$owner ;;
    SETTINGS) SETTINGS_NAMES+=("$name") ;;
    PROJECT) emit claude "$name" project "$owner" ;;
  esac
done <<<"$data"

raw=$(timeout 20 claude mcp list 2>/dev/null | grep ' - ' || true)
while IFS= read -r line; do
  [ -z "$line" ] && continue
  name=$(sed -E 's/: .*$//' <<<"$line")
  EFFECTIVE[$name]=1
  if [ -n "${SCOPE[$name]:-}" ]; then
    emit claude "$name" "${SCOPE[$name]}" "${OWNERS[$name]:--}"
    continue
  fi
  out=$(timeout 20 claude mcp get "$name" 2>/dev/null || true)
  case "$out" in
    *"User config"*) emit claude "$name" user - ;;
    *"Project config"*) emit claude "$name" project - ;;
    *"Local config"*) emit claude "$name" local - ;;
    *"Dynamic config"*) emit claude "$name" plugin - ;;
    *) echo "mcp-scope: unparseable scope for claude server $name" >&2; exit 1 ;;
  esac
done <<<"$raw"

for name in "${SETTINGS_NAMES[@]:-}"; do
  [ -z "$name" ] && continue
  [ -n "${EFFECTIVE[$name]:-}" ] && continue
  emit claude "$name" settings.json -
done

# claude mcp list only sees the current project. Other projects' servers are
# real registrations that a sweep must count, so emit them from the owner map.
for name in "${!SCOPE[@]}"; do
  [ -n "${EFFECTIVE[$name]:-}" ] && continue
  emit claude "$name" "${SCOPE[$name]}" "${OWNERS[$name]:--}"
done

names=$(grep -oE '^\[mcp_servers\.[A-Za-z0-9_.-]+\]' "$HOME/.codex/config.toml" 2>/dev/null | sed -E 's/^\[mcp_servers\.(.*)\]$/\1/' || true)
while IFS= read -r name; do
  [ -z "$name" ] && continue
  emit codex "$name" user -
done <<<"$names"

[ "$ROWS" -gt 0 ] || { echo "mcp-scope: zero rows produced" >&2; exit 1; }
