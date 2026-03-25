#!/usr/bin/env bash
# Claude Code Stop hook: only inject /code-simplifier when relevant repo changes
# appeared since the previous stop-hook pass for this repo.
set -euo pipefail

input=$(cat)

json_field() {
  local field="$1"
  if command -v jq >/dev/null 2>&1; then
    printf '%s' "$input" | jq -r "$field // empty"
    return
  fi
  printf ''
}

checksum_text() {
  if command -v shasum >/dev/null 2>&1; then
    shasum -a 256 | awk '{print $1}'
    return
  fi
  cksum | awk '{print $1 ":" $2}'
}

is_relevant_path() {
  case "$1" in
    .git/* | node_modules/* | dist/* | build/* | coverage/* | .next/*)
      return 1
      ;;
    *.ts | *.tsx | *.js | *.jsx | *.mjs | *.cjs | *.py | *.rb | *.go | *.rs | *.java | *.kt | *.swift | *.php | *.sh | *.bash | *.zsh | *.ps1 | *.md | *.mdx | *.txt | *.yml | *.yaml | *.json | *.toml | *.ini | *.conf | *.css | *.scss | *.less | *.html | *.xml | *.sql | *.graphql | *.gql)
      return 0
      ;;
    *)
      return 1
      ;;
  esac
}

stop_hook_active=$(json_field '.stop_hook_active')
if [[ "$stop_hook_active" == "true" ]]; then
  exit 0
fi

repo_root=$(git rev-parse --show-toplevel 2>/dev/null || true)
if [[ -z "$repo_root" ]]; then
  exit 0
fi

cd "$repo_root"

tracked_paths=()
while IFS= read -r path; do
  [[ -n "$path" ]] || continue
  if is_relevant_path "$path"; then
    tracked_paths+=("$path")
  fi
done < <(git diff --name-only --diff-filter=ACDMRTUXB HEAD -- 2>/dev/null || true)

untracked_paths=()
while IFS= read -r path; do
  [[ -n "$path" ]] || continue
  if is_relevant_path "$path"; then
    untracked_paths+=("$path")
  fi
done < <(git ls-files --others --exclude-standard -- 2>/dev/null || true)

if [[ ${#tracked_paths[@]} -eq 0 && ${#untracked_paths[@]} -eq 0 ]]; then
  exit 0
fi

tracked_signature=""
if [[ ${#tracked_paths[@]} -gt 0 ]]; then
  tracked_signature=$(
    git diff --no-ext-diff --binary HEAD -- "${tracked_paths[@]}" | checksum_text
  )
fi

untracked_signature=""
if [[ ${#untracked_paths[@]} -gt 0 ]]; then
  untracked_signature=$(
    {
      for path in "${untracked_paths[@]}"; do
        printf 'FILE:%s\0' "$path"
        cat -- "$path"
        printf '\0'
      done
    } | checksum_text
  )
fi

repo_key=$(printf '%s' "$repo_root" | checksum_text)
state_dir="${XDG_STATE_HOME:-$HOME/.local/state}/claude-code-hooks"
state_file="$state_dir/code-simplifier-$repo_key"
mkdir -p "$state_dir"

current_signature=$(
  printf 'tracked:%s\nuntracked:%s\n' "$tracked_signature" "$untracked_signature" | checksum_text
)
previous_signature=""
if [[ -f "$state_file" ]]; then
  previous_signature=$(cat "$state_file")
fi

if [[ "$current_signature" == "$previous_signature" ]]; then
  exit 0
fi

printf '%s\n' "$current_signature" > "$state_file"

cat <<'EOF'
/code-simplifier

Only review files changed since the previous stop-hook simplifier pass, and only if the most recent iteration made relevant code, config, docs, or prompt edits. If there were no such edits in the latest iteration, skip and stop.
EOF
