#!/usr/bin/env bash
set -euo pipefail

TARBALL="${1:-}"
if [[ -z "$TARBALL" ]]; then
  echo "verify-package-tarball: usage: verify-package-tarball.sh <tarball>" >&2
  exit 1
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LIST="$SCRIPT_DIR/../v2/required-package-files.txt"

if [[ ! -f "$LIST" ]]; then
  echo "verify-package-tarball: required-package-files.txt not found at $LIST" >&2
  exit 1
fi

while IFS= read -r entry || [[ -n "$entry" ]]; do
  [[ -z "$entry" ]] && continue
  if ! tar -tzf "$TARBALL" | grep -qF "package/$entry"; then
    echo "verify-package-tarball: tarball missing: package/$entry" >&2
    exit 1
  fi
done <"$LIST"
