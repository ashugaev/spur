#!/usr/bin/env bash
set -euo pipefail

PKG_ROOT="${1:-}"
if [[ -z "$PKG_ROOT" ]]; then
  echo "verify-package-files: usage: verify-package-files.sh <package-root>" >&2
  exit 1
fi

LIST="$PKG_ROOT/required-package-files.txt"
if [[ ! -f "$LIST" ]]; then
  echo "verify-package-files: required-package-files.txt missing from $PKG_ROOT" >&2
  exit 1
fi

while IFS= read -r entry || [[ -n "$entry" ]]; do
  [[ -z "$entry" ]] && continue
  if [[ ! -f "$PKG_ROOT/$entry" ]]; then
    echo "verify-package-files: package file missing: $PKG_ROOT/$entry (reinstall @shugaev/spur)" >&2
    exit 1
  fi
done <"$LIST"
