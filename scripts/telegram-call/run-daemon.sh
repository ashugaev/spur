#!/usr/bin/env bash
set -euo pipefail
umask 077

SCRIPT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
REPO_ROOT=$(realpath "$SCRIPT_DIR/../..")
TOOL_DIR="${SPUR_SESSION_TOOL_DIR:?SPUR_SESSION_TOOL_DIR not set}/voice-daemon"
mkdir -p "$TOOL_DIR"
chmod 700 "$TOOL_DIR"
if [[ -f "$TOOL_DIR/isolated-env.sh" ]]; then
  echo "voice-daemon: scoped runtime already exists; stop previous sidecar" >&2
  exit 1
fi
FIXTURE_DIR=$(mktemp -d "${TMPDIR:-/tmp}/spur-voice-sandbox.XXXXXX")
DAEMON_PID=""

cleanup() {
  trap - EXIT INT TERM HUP
  local children_stopped=1
  local teardown_failed=0
  local pane_pid child_pid
  local -a child_pids=()
  collect_children() {
    child_pids+=("$1")
    while IFS= read -r child_pid; do
      [[ -n "$child_pid" ]] && collect_children "$child_pid"
    done < <(pgrep -P "$1" || true)
  }
  if [[ -f "$TOOL_DIR/isolated-env.sh" ]]; then
    # Receipt belongs to this launcher and contains no credentials.
    source "$TOOL_DIR/isolated-env.sh"
    if [[ "${SPUR_ISOLATED_DAEMON_PID:-}" == "$DAEMON_PID" ]]; then
      if tmux -L "$SPUR_ISOLATED_TMUX_SOCKET_NAME" has-session 2>/dev/null; then
        while IFS= read -r pane_pid; do
          collect_children "$pane_pid"
        done < <(tmux -L "$SPUR_ISOLATED_TMUX_SOCKET_NAME" list-panes -a -F '#{pane_pid}')
        tmux -L "$SPUR_ISOLATED_TMUX_SOCKET_NAME" kill-server || teardown_failed=1
      fi
    else
      teardown_failed=1
    fi
  fi
  if [[ -n "$DAEMON_PID" ]]; then
    kill -TERM "$DAEMON_PID" 2>/dev/null || true
    wait "$DAEMON_PID" 2>/dev/null || true
  fi
  for _ in {1..5}; do
    children_stopped=1
    for child_pid in "${child_pids[@]}"; do
      if kill -0 "$child_pid" 2>/dev/null; then
        children_stopped=0
      fi
    done
    [[ "$children_stopped" == 1 ]] && break
    sleep 1
  done
  if [[ "$children_stopped" == 1 && "$teardown_failed" == 0 ]]; then
    rm -rf "$FIXTURE_DIR"
    rm -f "$TOOL_DIR/isolated-env.sh" "$TOOL_DIR/spur-isolated"
  else
    echo "voice-daemon: sandbox retained; child teardown failed" >&2
  fi
}
trap cleanup EXIT
trap 'exit 143' TERM HUP
trap 'exit 130' INT

mkdir "$FIXTURE_DIR/repository"
git -C "$FIXTURE_DIR/repository" init -q -b main
git -C "$FIXTURE_DIR/repository" -c user.name=Spur -c user.email=prototype@example.invalid \
  commit -q --allow-empty -m "chore: initialize voice sandbox"
cat > "$FIXTURE_DIR/project.yaml" <<YAML
projects:
  voice-sandbox:
    path: "$FIXTURE_DIR/repository"
    defaultBranch: main
    defaultAgent: codex
    sources: {}
    triggers: {}
    sidecars: {}
YAML

cd "$FIXTURE_DIR"
env SPUR_SESSION_TOOL_DIR="$TOOL_DIR" \
  SPUR_PROJECT=voice-controller \
  SPUR_PROJECT_CONFIG_PATH="$FIXTURE_DIR/project.yaml" \
  SPUR_ISOLATED_WITHOUT_TELEGRAM=1 \
  bash "$REPO_ROOT/scripts/spur-isolated-daemon.sh" &
DAEMON_PID=$!
wait "$DAEMON_PID"
