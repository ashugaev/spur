#!/usr/bin/env bash
set -euo pipefail

TARBALL="${1:-}"
if [[ "$#" -ne 1 || -z "$TARBALL" ]]; then
  echo "verify-package-tarball: usage: verify-package-tarball.sh <tarball>" >&2
  exit 1
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
exec node "$SCRIPT_DIR/verify-review-app-package.mjs" --tarball "$TARBALL"
