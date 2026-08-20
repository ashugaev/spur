#!/usr/bin/env bash
set -euo pipefail

SCRIPT_PATH="$(realpath "${BASH_SOURCE[0]}")"
SCRIPT_DIR="$(dirname "$SCRIPT_PATH")"
REPO_ROOT="$(realpath "$SCRIPT_DIR/..")"
# shellcheck source=./spur-sidecar-common.sh
source "$SCRIPT_DIR/spur-sidecar-common.sh"

PORT_START=${SPUR_SIDECAR_DAEMON_PORT_START:-4320}
PORT_END=${SPUR_SIDECAR_DAEMON_PORT_END:-4399}
AGENT_PORT=$(resolve_sidecar_port "SPUR_RESERVED_PORT_DAEMON" "$PORT_START" "$PORT_END")
PROJECT_CONFIG_PATH="${SPUR_PROJECT_CONFIG_PATH:-$(realpath "$SCRIPT_DIR/../spur.yaml")}"
USER_CONFIG_PATH="${SPUR_USER_CONFIG_PATH:-${SPUR_CONFIG:-$HOME/.spur/config.yaml}}"
CURRENT_WORKTREE="$REPO_ROOT"
V2_DIR="$REPO_ROOT/v2"

CONFIG_DIR=$(mktemp -d "${TMPDIR:-/tmp}/spur-isolated-daemon.XXXXXX")
TOOL_DIR="${SPUR_SESSION_TOOL_DIR:?SPUR_SESSION_TOOL_DIR not set}"
RUNTIME_FILE="$TOOL_DIR/isolated-env.sh"
RUNTIME_TMP_FILE="$RUNTIME_FILE.tmp.$$"
PROJECT_CONFIG_RUNTIME_PATH="$CONFIG_DIR/project.yaml"
CLI_PATH="$V2_DIR/dist/cli.js"
WRITE_CONFIG_PATH="$V2_DIR/bin/write-isolated-project-config.mjs"
WRITE_INSTANCE_CONFIG_PATH="$V2_DIR/bin/write-isolated-instance-config.mjs"
NODE_BIN="$(command -v node)"
CURRENT_BRANCH="$(git -C "$CURRENT_WORKTREE" branch --show-current 2>/dev/null || true)"
REQUIRED_BUILD_OUTPUTS=(
  "$CLI_PATH"
  "$V2_DIR/dist/isolated-instance-config.js"
  "$V2_DIR/dist/isolated-project-config.js"
)
BUILD_INPUT_DIRS=(
  "$V2_DIR/src"
  "$V2_DIR/bin"
)
WRITE_CONFIG_ARGS=(
  --input "$PROJECT_CONFIG_PATH"
  --output "$PROJECT_CONFIG_RUNTIME_PATH"
  --worktree "$CURRENT_WORKTREE"
)
if [[ -n "$CURRENT_BRANCH" ]]; then
  WRITE_CONFIG_ARGS+=(--branch "$CURRENT_BRANCH")
fi

ensure_v2_build() {
  local oldest_output
  local output
  local stale_input

  for output in "${REQUIRED_BUILD_OUTPUTS[@]}"; do
    if [[ ! -f "$output" ]]; then
      SPUR_DISABLE_AUTOSTART=1 pnpm --dir "$V2_DIR" build
      return 0
    fi
  done

  oldest_output="${REQUIRED_BUILD_OUTPUTS[0]}"
  for output in "${REQUIRED_BUILD_OUTPUTS[@]:1}"; do
    if [[ "$oldest_output" -nt "$output" ]]; then
      oldest_output="$output"
    fi
  done

  stale_input="$(
    find "${BUILD_INPUT_DIRS[@]}" -type f \( -name "*.ts" -o -name "*.mjs" \) \
      -newer "$oldest_output" -print -quit
  )"
  if [[ -n "$stale_input" ]]; then
    SPUR_DISABLE_AUTOSTART=1 pnpm --dir "$V2_DIR" build
  fi
}

cleanup() {
  rm -f "$RUNTIME_FILE" "$RUNTIME_FILE".tmp.*
  rm -rf "$CONFIG_DIR"
}
trap cleanup EXIT
rm -f "$RUNTIME_FILE" "$RUNTIME_FILE".tmp.*

cat > "$CONFIG_DIR/config.yaml" <<YAML
server:
  host: 127.0.0.1
  port: $AGENT_PORT
dataDir: "$CONFIG_DIR/data"
worktreeDir: "$CONFIG_DIR/worktrees"
tmux:
  socketName: "spur-$AGENT_PORT"
YAML

cat > "$TOOL_DIR/spur" <<WRAPPER
#!/usr/bin/env bash
set -euo pipefail
mkdir -p "$CONFIG_DIR/data"
registry_tmp="$CONFIG_DIR/data/config-registry.json.tmp.\$\$"
cat > "\$registry_tmp" <<JSON
{
  "configPaths": [
    "$PROJECT_CONFIG_RUNTIME_PATH"
  ]
}
JSON
mv "\$registry_tmp" "$CONFIG_DIR/data/config-registry.json"
exec "$NODE_BIN" "$CLI_PATH" --config "$CONFIG_DIR/config.yaml" "\$@"
WRAPPER
chmod +x "$TOOL_DIR/spur"

ensure_v2_build

# isolated-ui waits for this file before replacing symlinked dependency trees.
# Publish it only after tsc finishes, and atomically so readers never source a
# partial environment.
cat > "$RUNTIME_TMP_FILE" <<ENVFILE
SPUR_ISOLATED_CONFIG="$CONFIG_DIR/config.yaml"
SPUR_ISOLATED_DATA_DIR="$CONFIG_DIR/data"
SPUR_ISOLATED_DAEMON_URL="http://127.0.0.1:$AGENT_PORT"
SPUR_ISOLATED_TMUX_SOCKET_NAME="spur-$AGENT_PORT"
SPUR_ISOLATED_PROJECT_CONFIG="$PROJECT_CONFIG_RUNTIME_PATH"
SPUR_ISOLATED_SOURCE_WORKTREE="$CURRENT_WORKTREE"
ENVFILE
chmod 600 "$RUNTIME_TMP_FILE"
mv "$RUNTIME_TMP_FILE" "$RUNTIME_FILE"

"$NODE_BIN" "$WRITE_INSTANCE_CONFIG_PATH" \
  --user-config "$USER_CONFIG_PATH" \
  --base "$CONFIG_DIR/config.yaml" \
  --output "$CONFIG_DIR/config.yaml"

"$NODE_BIN" "$WRITE_CONFIG_PATH" "${WRITE_CONFIG_ARGS[@]}"

echo "Isolated daemon starting on port $AGENT_PORT"
exec "$TOOL_DIR/spur" daemon start
