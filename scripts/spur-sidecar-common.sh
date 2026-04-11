#!/usr/bin/env bash
set -euo pipefail

find_free_port() {
  local start="$1"
  local end="$2"
  local port=""

  for candidate in $(seq "$start" "$end"); do
    if ! ss -tlnH "sport = :$candidate" | grep -q .; then
      port="$candidate"
      break
    fi
  done

  if [[ -z "$port" ]]; then
    echo "No free port in $start-$end" >&2
    return 1
  fi

  printf '%s\n' "$port"
}

resolve_sidecar_port() {
  local env_name="$1"
  local start="$2"
  local end="$3"
  local reserved="${!env_name:-}"

  if [[ -n "$reserved" ]]; then
    printf '%s\n' "$reserved"
    return 0
  fi

  find_free_port "$start" "$end"
}

wait_for_http() {
  local url="$1"
  local attempts="${2:-120}"

  for _ in $(seq 1 "$attempts"); do
    if curl -fsS -o /dev/null "$url"; then
      return 0
    fi
    sleep 1
  done

  echo "Timed out waiting for $url" >&2
  return 1
}
