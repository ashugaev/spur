#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
# shellcheck source=./spur-sidecar-common.sh
source "$SCRIPT_DIR/spur-sidecar-common.sh"

LANDING_DIR="$SCRIPT_DIR/../landing"
PORT_START=${SPUR_SIDECAR_LANDING_PORT_START:-5700}
PORT_END=${SPUR_SIDECAR_LANDING_PORT_END:-5749}

LANDING_PORT=$(resolve_sidecar_port SPUR_RESERVED_PORT_LANDING "$PORT_START" "$PORT_END")
echo "Serving landing on http://0.0.0.0:$LANDING_PORT"

exec env SPUR_RESERVED_PORT_LANDING="$LANDING_PORT" \
  node "$SCRIPT_DIR/landing-dev-server.mjs" "$LANDING_DIR"
