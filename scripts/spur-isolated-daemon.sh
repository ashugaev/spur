#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
# shellcheck source=./spur-sidecar-common.sh
source "$SCRIPT_DIR/spur-sidecar-common.sh"

PORT_START=${SPUR_SIDECAR_DAEMON_PORT_START:-4320}
PORT_END=${SPUR_SIDECAR_DAEMON_PORT_END:-4399}
AGENT_PORT=$(resolve_sidecar_port "SPUR_RESERVED_PORT_DAEMON" "$PORT_START" "$PORT_END")
PROJECT_CONFIG_PATH="${SPUR_PROJECT_CONFIG_PATH:-$(realpath "$SCRIPT_DIR/../spur.yaml")}"
USER_CONFIG_PATH="${SPUR_USER_CONFIG_PATH:-$HOME/.spur/config.yaml}"
CURRENT_WORKTREE="$(realpath "$SCRIPT_DIR/..")"

CONFIG_DIR=$(mktemp -d "${TMPDIR:-/tmp}/spur-isolated-daemon.XXXXXX")
TOOL_DIR="${SPUR_SESSION_TOOL_DIR:?SPUR_SESSION_TOOL_DIR not set}"
RUNTIME_FILE="$TOOL_DIR/isolated-env.sh"
PROJECT_CONFIG_RUNTIME_PATH="$CONFIG_DIR/project.yaml"
CLI_PATH="$(dirname "$(realpath "$0")")/../v2/dist/cli.js"
WRITE_CONFIG_PATH="$(dirname "$(realpath "$0")")/../v2/bin/write-isolated-project-config.mjs"
WRITE_INSTANCE_CONFIG_PATH="$(dirname "$(realpath "$0")")/../v2/bin/write-isolated-instance-config.mjs"
NODE_BIN="$(command -v node)"
CURRENT_BRANCH="$(git -C "$CURRENT_WORKTREE" branch --show-current 2>/dev/null || true)"
WRITE_CONFIG_ARGS=(
  --input "$PROJECT_CONFIG_PATH"
  --output "$PROJECT_CONFIG_RUNTIME_PATH"
  --worktree "$CURRENT_WORKTREE"
)
if [[ -n "$CURRENT_BRANCH" ]]; then
  WRITE_CONFIG_ARGS+=(--branch "$CURRENT_BRANCH")
fi

cleanup() {
  rm -f "$RUNTIME_FILE"
  rm -rf "$CONFIG_DIR"
}
trap cleanup EXIT

cat > "$CONFIG_DIR/config.yaml" <<YAML
server:
  host: 127.0.0.1
  port: $AGENT_PORT
dataDir: "$CONFIG_DIR/data"
worktreeDir: "$CONFIG_DIR/worktrees"
tmux:
  socketName: "spur-$AGENT_PORT"
YAML

"$NODE_BIN" "$WRITE_INSTANCE_CONFIG_PATH" \
  --user-config "$USER_CONFIG_PATH" \
  --base "$CONFIG_DIR/config.yaml" \
  --output "$CONFIG_DIR/config.yaml"

mkdir -p "$CONFIG_DIR/data"
"$NODE_BIN" "$WRITE_CONFIG_PATH" "${WRITE_CONFIG_ARGS[@]}"
cat > "$CONFIG_DIR/data/config-registry.json" <<JSON
{
  "configPaths": [
    "$PROJECT_CONFIG_RUNTIME_PATH"
  ]
}
JSON

cat > "$TOOL_DIR/spur" <<WRAPPER
#!/usr/bin/env bash
set -euo pipefail
exec "$NODE_BIN" "$CLI_PATH" --config "$CONFIG_DIR/config.yaml" "\$@"
WRAPPER
chmod +x "$TOOL_DIR/spur"

cat > "$RUNTIME_FILE" <<ENVFILE
SPUR_ISOLATED_CONFIG="$CONFIG_DIR/config.yaml"
SPUR_ISOLATED_DATA_DIR="$CONFIG_DIR/data"
SPUR_ISOLATED_DAEMON_URL="http://127.0.0.1:$AGENT_PORT"
SPUR_ISOLATED_TMUX_SOCKET_NAME="spur-$AGENT_PORT"
SPUR_ISOLATED_PROJECT_CONFIG="$PROJECT_CONFIG_RUNTIME_PATH"
SPUR_ISOLATED_SOURCE_WORKTREE="$CURRENT_WORKTREE"
ENVFILE
chmod 600 "$RUNTIME_FILE"

echo "Isolated daemon starting on port $AGENT_PORT"
exec "$NODE_BIN" "$CLI_PATH" --config "$CONFIG_DIR/config.yaml" daemon start
