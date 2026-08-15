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

LISTING="$(mktemp)"
trap 'rm -f "$LISTING"' EXIT
tar -tzf "$TARBALL" >"$LISTING"

while IFS= read -r entry || [[ -n "$entry" ]]; do
  [[ -z "$entry" ]] && continue
  grep -qxF "package/$entry" "$LISTING" || {
    echo "verify-package-tarball: tarball missing: package/$entry" >&2
    exit 1
  }
done <"$LIST"
