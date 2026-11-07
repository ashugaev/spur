#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DESTINATION="$(cd "${1:?pack destination required}" && pwd)"
cd "$REPO_ROOT/v2"

PACK_OUTPUT="$(npm pack --pack-destination "$DESTINATION")" || {
  status=$?
  printf '%s\n' "$PACK_OUTPUT" >&2
  exit "$status"
}

NAME="${PACK_OUTPUT##*$'\n'}"
if [[ ! "$NAME" =~ ^[a-zA-Z0-9][a-zA-Z0-9._-]*\.tgz$ ]] || [[ ! -f "$DESTINATION/$NAME" ]]; then
  printf 'npm pack did not produce a valid archive: %s\n' "$PACK_OUTPUT" >&2
  exit 1
fi
TARBALL="$DESTINATION/$NAME"

bash "$REPO_ROOT/scripts/verify-package-tarball.sh" "$TARBALL"
arch="$(node -p process.arch)"
tar -tzf "$TARBALL" | grep -Fx "package/web/node_modules/node-pty/prebuilds/linux-$arch/pty.node" >/dev/null || {
  echo "packed tarball is missing node-pty/prebuilds/linux-$arch/pty.node" >&2
  exit 1
}
tar -tvzf "$TARBALL" | grep " package/skills/spur/SKILL.md$" | grep "^-" >/dev/null || {
  echo "packed tarball has package/skills/spur/SKILL.md as a non-regular file" >&2
  exit 1
}
printf '%s\n' "$TARBALL"
