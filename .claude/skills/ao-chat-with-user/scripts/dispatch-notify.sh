#!/usr/bin/env bash
# Dispatch notification to the configured connector
# Usage: dispatch-notify.sh "<summary>" "<questions>"
set -euo pipefail

: "${AO_CONNECTOR:?AO_CONNECTOR is required (telegram|slack|jira)}"

SUMMARY="${1:?Argument 1 (summary) is required}"
QUESTIONS="${2:?Argument 2 (questions) is required}"

CONNECTOR_SCRIPT="$(dirname "$0")/connectors/${AO_CONNECTOR}/notify.sh"

if [ ! -f "$CONNECTOR_SCRIPT" ]; then
  echo "Unknown connector '${AO_CONNECTOR}': no script at ${CONNECTOR_SCRIPT}" >&2
  exit 1
fi

bash "$CONNECTOR_SCRIPT" "$SUMMARY" "$QUESTIONS"
