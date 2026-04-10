#!/usr/bin/env bash
set -euo pipefail

PORT_START=4320
PORT_END=4399

# Find free port
AGENT_PORT=""
for port in $(seq "$PORT_START" "$PORT_END"); do
  if ! ss -tlnH "sport = :$port" | grep -q .; then
    AGENT_PORT="$port"
    break
  fi
done

if [[ -z "$AGENT_PORT" ]]; then
  echo "No free port in $PORT_START-$PORT_END" >&2
  exit 1
fi

CONFIG_DIR=$(mktemp -d)
trap 'rm -rf "$CONFIG_DIR"' EXIT

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

# Overwrite spur wrapper to point at isolated config
TOOL_DIR="${SPUR_SESSION_TOOL_DIR:?SPUR_SESSION_TOOL_DIR not set}"
CLI_PATH="$(dirname "$(realpath "$0")")/../v2/dist/cli.js"
NODE_BIN="$(command -v node)"

cat > "$TOOL_DIR/spur" <<WRAPPER
#!/usr/bin/env bash
set -euo pipefail
exec "$NODE_BIN" "$CLI_PATH" --config "$CONFIG_DIR/config.yaml" "\$@"
WRAPPER
chmod +x "$TOOL_DIR/spur"

echo "Isolated daemon starting on port $AGENT_PORT"
exec "$NODE_BIN" "$CLI_PATH" --config "$CONFIG_DIR/config.yaml" daemon start
