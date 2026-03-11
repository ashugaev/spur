#!/usr/bin/env bash
# Signal the pipeline orchestrator to loop back to a previous step
# Usage: signal-rework.sh "<one-line feedback message>"
set -euo pipefail

: "${AO_DATA_DIR:?AO_DATA_DIR is required}"
: "${AO_SESSION:?AO_SESSION is required}"

FEEDBACK="${1:?Argument 1 (feedback message) is required}"
META="$AO_DATA_DIR/$AO_SESSION"

sed -i.bak '/^pipelineRework=/d; /^pipelineReworkFeedback=/d' "$META"
printf 'pipelineRework=true\npipelineReworkFeedback=%s\n' "$FEEDBACK" >> "$META"
rm -f "${META}.bak"

echo "Rework signal written: $FEEDBACK"
