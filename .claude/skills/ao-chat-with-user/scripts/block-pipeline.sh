#!/usr/bin/env bash
# Write needs_input status to session metadata — blocks pipeline advancement
set -euo pipefail

: "${AO_DATA_DIR:?AO_DATA_DIR is required}"
: "${AO_SESSION:?AO_SESSION is required}"

META="$AO_DATA_DIR/$AO_SESSION"

sed -i.bak '/^status=/d' "$META"
echo 'status=needs_input' >> "$META"
rm -f "${META}.bak"

echo "Pipeline blocked: status=needs_input written to $META"
