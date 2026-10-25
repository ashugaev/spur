#!/usr/bin/env bash
set -euo pipefail
umask 077

if [[ ! "${SPUR_RESERVED_PORT_DAEMON:-}" =~ ^[0-9]+$ ]]; then
  echo "voice-daemon: SPUR_RESERVED_PORT_DAEMON unset or not numeric; start via the voice-daemon sidecar" >&2
  exit 1
fi
SCRIPT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
REPO_ROOT=$(realpath "$SCRIPT_DIR/../..")
source "$SCRIPT_DIR/inputs.sh"
check_voice_inputs
TOOL_DIR="${SPUR_SESSION_TOOL_DIR:?SPUR_SESSION_TOOL_DIR not set}/voice-daemon"
mkdir -p "$TOOL_DIR"
chmod 700 "$TOOL_DIR"
process_identity() {
  local stat suffix
  local -a fields
  [[ -e "/proc/$1/stat" ]] || return 1
  IFS= read -r stat < "/proc/$1/stat" || return 2
  suffix="${stat##*) }"
  read -r -a fields <<< "$suffix"
  [[ "${fields[0]:-}" != Z && "${fields[0]:-}" != X ]] || return 1
  [[ "${fields[19]:-}" =~ ^[0-9]+$ ]] || return 2
  printf '%s\n' "${fields[19]}"
}
# Receipt survives SIGKILL and reboot. Refuse only while its recorded daemon
# generation (pid + start time) is alive; otherwise drop the stale receipt.
stale_launcher=""
stale_fixture=""
receipt_socket=""
if [[ -f "$TOOL_DIR/isolated-env.sh" ]]; then
  receipt_pid=$(source "$TOOL_DIR/isolated-env.sh" && printf '%s' "${SPUR_ISOLATED_DAEMON_PID:-}")
  receipt_start=$(source "$TOOL_DIR/isolated-env.sh" && printf '%s' "${SPUR_ISOLATED_DAEMON_STARTTIME:-}")
  if [[ "$receipt_pid" =~ ^[0-9]+$ && "$receipt_start" =~ ^[0-9]+$ ]] && \
     [[ "$(process_identity "$receipt_pid" || true)" == "$receipt_start" ]]; then
    echo "voice-daemon: scoped runtime already exists; stop previous sidecar" >&2
    exit 1
  fi
  stale_config=$(source "$TOOL_DIR/isolated-env.sh" && printf '%s' "${SPUR_ISOLATED_CONFIG:-}")
  # Lexical normalization (no symlink resolution) matches Spur's path.resolve.
  [[ -z "$stale_config" ]] || stale_config=$(realpath -m -s -- "$stale_config")
  stale_launcher=$(dirname "${stale_config:-/}")
  [[ "$(basename "$stale_launcher")" == spur-isolated-daemon.* &&
     "$stale_config" == "$stale_launcher/config.yaml" ]] || stale_launcher=""
  if [[ -f "$TOOL_DIR/fixture-dir" ]]; then
    IFS= read -r stale_fixture < "$TOOL_DIR/fixture-dir" || true
    [[ -z "$stale_fixture" ]] || stale_fixture=$(realpath -m -s -- "$stale_fixture")
    [[ "$(basename "${stale_fixture:-/}")" == spur-voice-sandbox.* &&
       -f "$stale_fixture/project.yaml" && -d "$stale_fixture/repository" ]] || stale_fixture=""
  fi
  receipt_socket=$(source "$TOOL_DIR/isolated-env.sh" && printf '%s' "${SPUR_ISOLATED_TMUX_SOCKET_NAME:-}")
fi
# Socket name spur-<port> is reused: the new run joins a live server there and its
# teardown kills the whole server. Never start over a live server on the receipt
# socket or the socket this run will use. A server is a dead run's only when it has
# panes and every pane started under that run's unique launcher or fixture dir;
# anything else is not ours: refuse, touch nothing, no kill advice.
check_socket() {
  local socket="$1" panes pane_path foreign=0 owned=0
  [[ "$socket" =~ ^[A-Za-z0-9._-]+$ ]] || return 0
  tmux -L "$socket" has-session 2>/dev/null || return 0
  if ! panes=$(tmux -L "$socket" list-panes -a -F '#{pane_start_path}' 2>/dev/null); then
    foreign=1
  else
    while IFS= read -r pane_path; do
      [[ -z "$pane_path" ]] || pane_path=$(realpath -m -s -- "$pane_path")
      if [[ -n "$stale_launcher" && ( "$pane_path" == "$stale_launcher" || "$pane_path" == "$stale_launcher/"* ) ]] || \
         [[ -n "$stale_fixture" && ( "$pane_path" == "$stale_fixture" || "$pane_path" == "$stale_fixture/"* ) ]]; then
        owned=1
      else
        foreign=1
      fi
    done <<< "$panes"
  fi
  if [[ "$foreign" == 1 && "$owned" == 0 && "$socket" != "spur-$SPUR_RESERVED_PORT_DAEMON" ]]; then
    # This run never joins or kills that socket; only our stale receipt and dirs go.
    echo "voice-daemon: tmux socket '$socket' is live and not owned by this voice run; left untouched, continuing" >&2
    return 0
  fi
  if [[ "$foreign" == 1 ]]; then
    echo "voice-daemon: tmux socket '$socket' is live and not owned by this voice run; nothing touched" >&2
  else
    echo "voice-daemon: previous sandbox agents still run on tmux socket '$socket'; stop them with: tmux -L $socket kill-server" >&2
  fi
  exit 1
}
check_socket "$receipt_socket"
check_socket "spur-$SPUR_RESERVED_PORT_DAEMON"
if [[ -f "$TOOL_DIR/isolated-env.sh" ]]; then
  [[ -z "$stale_launcher" ]] || rm -rf "$stale_launcher"
  rm -f "$TOOL_DIR/isolated-env.sh" "$TOOL_DIR/spur-isolated"
fi
# Pointer can outlive a run killed before its receipt was written.
if [[ -f "$TOOL_DIR/fixture-dir" ]]; then
  IFS= read -r stale_fixture < "$TOOL_DIR/fixture-dir" || true
  if [[ "$(basename "${stale_fixture:-/}")" == spur-voice-sandbox.* &&
        -f "$stale_fixture/project.yaml" && -d "$stale_fixture/repository" ]]; then
    rm -rf "$stale_fixture"
  fi
  rm -f "$TOOL_DIR/fixture-dir"
fi
FIXTURE_DIR=$(mktemp -d "${TMPDIR:-/tmp}/spur-voice-sandbox.XXXXXX")
printf '%s\n' "$FIXTURE_DIR" > "$TOOL_DIR/fixture-dir"
DAEMON_PID=""
LAUNCHER_DIR=""

cleanup() {
  trap - EXIT
  trap '' INT TERM HUP
  local children_stopped=1
  local teardown_failed=0
  local pane_pid child_pid identity i
  local -A child_identities=()
  collect_children() {
    local identity
    if identity="$(process_identity "$1")"; then
      child_identities["$1"]="$identity"
    elif [[ "$?" == 2 ]]; then
      teardown_failed=1
    fi
    while IFS= read -r child_pid; do
      [[ -n "$child_pid" ]] && collect_children "$child_pid"
    done < <(pgrep -P "$1" || true)
  }
  if [[ -f "$TOOL_DIR/isolated-env.sh" ]]; then
    # Receipt belongs to this launcher and contains no credentials.
    source "$TOOL_DIR/isolated-env.sh"
    if [[ "${SPUR_ISOLATED_DAEMON_PID:-}" == "$DAEMON_PID" ]]; then
      LAUNCHER_DIR=$(dirname "${SPUR_ISOLATED_CONFIG:-/}")
      [[ "$(basename "$LAUNCHER_DIR")" == spur-isolated-daemon.* &&
         "$SPUR_ISOLATED_CONFIG" == "$LAUNCHER_DIR/config.yaml" ]] || LAUNCHER_DIR=""
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
    collect_children "$DAEMON_PID"
    if identity="$(process_identity "$DAEMON_PID")" && \
       [[ "$identity" == "${child_identities[$DAEMON_PID]:-}" ]]; then
      kill -TERM "$DAEMON_PID" 2>/dev/null || true
    fi
  fi
  # Finish inside Sidecar's grace; signal only the captured process generation.
  for i in {1..20}; do
    children_stopped=1
    for child_pid in "${!child_identities[@]}"; do
      if identity="$(process_identity "$child_pid")"; then
        [[ "$identity" == "${child_identities[$child_pid]}" ]] || continue
        children_stopped=0
        if [[ "$i" == 10 ]]; then
          kill -KILL "$child_pid" 2>/dev/null || true
        fi
      elif [[ "$?" == 2 ]]; then
        teardown_failed=1
      fi
    done
    [[ "$children_stopped" == 1 ]] && break
    sleep 0.025
  done
  if [[ -n "$DAEMON_PID" && "$children_stopped" == 1 ]]; then
    wait "$DAEMON_PID" 2>/dev/null || true
  fi
  if [[ "$children_stopped" == 1 && "$teardown_failed" == 0 ]]; then
    rm -rf "$FIXTURE_DIR"
    [[ -z "$LAUNCHER_DIR" ]] || rm -rf "$LAUNCHER_DIR"
    rm -f "$TOOL_DIR/isolated-env.sh" "$TOOL_DIR/spur-isolated" "$TOOL_DIR/fixture-dir"
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
