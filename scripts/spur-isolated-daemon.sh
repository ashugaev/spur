#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
# shellcheck source=./spur-sidecar-common.sh
source "$SCRIPT_DIR/spur-sidecar-common.sh"

PORT_START=${SPUR_SIDECAR_DAEMON_PORT_START:-4320}
PORT_END=${SPUR_SIDECAR_DAEMON_PORT_END:-4399}
AGENT_PORT=$(resolve_sidecar_port "SPUR_RESERVED_PORT_DAEMON" "$PORT_START" "$PORT_END")
PROJECT_CONFIG_PATH="${SPUR_PROJECT_CONFIG_PATH:-$(realpath "$SCRIPT_DIR/../spur.yaml")}"

CONFIG_DIR=$(mktemp -d "${TMPDIR:-/tmp}/spur-isolated-daemon.XXXXXX")
TOOL_DIR="${SPUR_SESSION_TOOL_DIR:?SPUR_SESSION_TOOL_DIR not set}"
RUNTIME_FILE="$TOOL_DIR/isolated-env.sh"

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

mkdir -p "$CONFIG_DIR/data"
cat > "$CONFIG_DIR/data/config-registry.json" <<JSON
{
  "configPaths": [
    "$PROJECT_CONFIG_PATH"
  ]
}
JSON

# Overwrite spur wrapper to point at isolated config
CLI_PATH="$(dirname "$(realpath "$0")")/../v2/dist/cli.js"
NODE_BIN="$(command -v node)"

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
SPUR_ISOLATED_PROJECT_CONFIG="$PROJECT_CONFIG_PATH"
ENVFILE
chmod 600 "$RUNTIME_FILE"

echo "Isolated daemon starting on port $AGENT_PORT"
exec "$NODE_BIN" "$CLI_PATH" --config "$CONFIG_DIR/config.yaml" daemon start
