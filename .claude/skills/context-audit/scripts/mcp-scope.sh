#!/bin/bash
# mcp-scope.sh [repo_root] - effective MCP registration, scope, owner,
# CLI-replacement status. Verified against Claude Code 2.1.220, codex-cli 0.145.0.
set -euo pipefail

ROOT="${1:-$(pwd)}"
[ -d "$ROOT" ] || { echo "mcp-scope: no such directory: $ROOT" >&2; exit 1; }

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
  local name=$1 cli=$2 scope=$3 status=$4
  [ "$scope" = settings.json ] && { echo INERT; return; }
  case "$(tr 'A-Z' 'a-z' <<<"$name")" in
    *playwright*) echo keep:live-driving; return ;;
    *figma*|*linear*|*notion*|*slack*) echo keep:no-cli; return ;;
  esac
  if [ "$cli" != - ]; then
    if [ "$status" = found ]; then echo "migrate:$cli"; else echo "migrate:$cli:install-first"; fi
    return
  fi
  echo keep
}

emit() {
  local cli status
  cli=$(cli_for "$2"); status=-
  [ "$cli" != - ] && read -r cli status < <(cli_pick "$cli")
  printf '%s\t%s\t%s\t%s\t%s\t%s\t%s\n' "$1" "$2" "$3" "$4" "$cli" "$status" "$(verdict_for "$2" "$cli" "$3" "$status")"
}

printf 'vendor\tserver\tscope\towner\tcli\tcli_status\tverdict\n'

# ~/.claude.json owner map, ~/.claude/settings.json inert names, repo .mcp.json
# resolved against MCP_SCAN_ROOT (the [repo_root] arg, not the process cwd).
# Emits an "OK" sentinel line last, proof the parse ran to completion. Zero
# servers is a valid, common result; only a missing sentinel is a parse failure.
data=$(MCP_SCAN_ROOT="$ROOT" python3 - <<'PY'
import json, os, sys

def load(p):
    if not os.path.exists(p):
        return {}
    try:
        with open(p) as f:
            return json.load(f)
    except json.JSONDecodeError as e:
        print(f"mcp-scope: invalid JSON in {p}: {e}", file=sys.stderr)
        sys.exit(1)

home = os.path.expanduser('~')
root = os.environ['MCP_SCAN_ROOT']
cj = load(os.path.join(home, '.claude.json'))
for name in cj.get('mcpServers', {}):
    print(f"MAP\t{name}\tuser\t-")
for proj, v in cj.get('projects', {}).items():
    for name in v.get('mcpServers', {}):
        print(f"MAP\t{name}\tproject\t{proj}")
for name in load(os.path.join(home, '.claude', 'settings.json')).get('mcpServers', {}):
    print(f"SETTINGS\t{name}\t-\t-")
for name in load(os.path.join(root, '.mcp.json')).get('mcpServers', {}):
    print(f"PROJECT\t{name}\tproject\t{root}")
print("OK\t-\t-\t-")
PY
)
grep -q $'^OK\t' <<<"$data" || { echo "mcp-scope: unparseable ~/.claude.json / settings.json" >&2; exit 1; }
data=$(grep -v $'^OK\t' <<<"$data" || true)

# SCOPE_USER/OWNER_USER key on bare name (user scope is global, one per name).
# SCOPE_PROJ/OWNER_PROJ key on "name<US>project-path" so two projects that
# register the same server name each keep their own row instead of colliding.
declare -A SCOPE_USER OWNER_USER SCOPE_PROJ OWNER_PROJ EFFECTIVE EMITTED_PROJ
declare -a SETTINGS_NAMES=()
cwd=$(pwd)
while IFS=$'\t' read -r tag name scope owner; do
  case "$tag" in
    MAP)
      if [ "$scope" = user ]; then
        SCOPE_USER[$name]=1; OWNER_USER[$name]=$owner
      else
        key="$name"$'\x1f'"$owner"
        SCOPE_PROJ[$key]=1; OWNER_PROJ[$key]=$owner
      fi
      ;;
    SETTINGS) SETTINGS_NAMES+=("$name") ;;
    PROJECT)
      EFFECTIVE[$name]=1
      EMITTED_PROJ["$name"$'\x1f'"$cwd"]=1
      emit claude "$name" project "$owner"
      ;;
  esac
done <<<"$data"

raw=$(timeout 20 claude mcp list 2>/dev/null | grep ' - ' || true)
while IFS= read -r line; do
  [ -z "$line" ] && continue
  name=$(sed -E 's/: .*$//' <<<"$line")
  [ -n "${EFFECTIVE[$name]:-}" ] && continue
  EFFECTIVE[$name]=1
  projkey="$name"$'\x1f'"$cwd"
  if [ -n "${SCOPE_PROJ[$projkey]:-}" ]; then
    emit claude "$name" project "${OWNER_PROJ[$projkey]}"
    EMITTED_PROJ[$projkey]=1
    continue
  fi
  if [ -n "${SCOPE_USER[$name]:-}" ]; then
    emit claude "$name" user "${OWNER_USER[$name]:--}"
    continue
  fi
  out=$(timeout 20 claude mcp get "$name" 2>/dev/null || true)
  case "$out" in
    *"User config"*) emit claude "$name" user - ;;
    *"Project config"*) emit claude "$name" project - ;;
    *"Local config"*) emit claude "$name" local - ;;
    *"Dynamic config"*) emit claude "$name" plugin - ;;
    *) echo "mcp-scope: unparseable scope for claude server $name, marking unknown" >&2; emit claude "$name" unknown - ;;
  esac
done <<<"$raw"

for name in "${SETTINGS_NAMES[@]:-}"; do
  [ -z "$name" ] && continue
  [ -n "${EFFECTIVE[$name]:-}" ] && continue
  emit claude "$name" settings.json -
done

# claude mcp list only sees the current project. Other projects' servers are
# real registrations that a sweep must count, so emit them from the owner map.
for key in "${!SCOPE_PROJ[@]}"; do
  [ -n "${EMITTED_PROJ[$key]:-}" ] && continue
  emit claude "${key%%$'\x1f'*}" project "${OWNER_PROJ[$key]}"
done
for name in "${!SCOPE_USER[@]}"; do
  [ -n "${EFFECTIVE[$name]:-}" ] && continue
  emit claude "$name" user "${OWNER_USER[$name]:--}"
done

names=$(grep -oE '^\[mcp_servers\.[A-Za-z0-9_.-]+\]' "$HOME/.codex/config.toml" 2>/dev/null | sed -E 's/^\[mcp_servers\.(.*)\]$/\1/' || true)
while IFS= read -r name; do
  [ -z "$name" ] && continue
  emit codex "$name" user -
done <<<"$names"

# Zero servers is a valid result (clean machine), not a failure — nothing
# gates on row count.
