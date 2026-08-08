#!/bin/bash
# census.sh [repo_root] - inventory every surface that can enter an agent
# context window. Verified against Claude Code 2.1.220, codex-cli 0.145.0.
set -euo pipefail

ROOT="${1:-$(pwd)}"
[ -d "$ROOT" ] || { echo "census: no such directory: $ROOT" >&2; exit 1; }
declare -A always_totals ondemand_totals VENDOR_SEEN
declare -a VENDOR_ORDER
skipped_count=0

printf 'scope\tvendor\tkind\tpath\tlines\tbytes\test_tokens\t# ESTIMATE bytes/4, no tokenizer on this box\n'

emit() {
  local scope=$1 vendor=$2 kind=$3 path=$4 lines=$5 bytes=$6 bucket=$7
  local tok=$(( bytes / 4 ))
  printf '%s\t%s\t%s\t%s\t%s\t%s\t%s\n' "$scope" "$vendor" "$kind" "$path" "$lines" "$bytes" "$tok"
  if [ -z "${VENDOR_SEEN[$vendor]:-}" ]; then VENDOR_SEEN[$vendor]=1; VENDOR_ORDER+=("$vendor"); fi
  if [ "$bucket" = always ]; then
    always_totals[$vendor]=$(( ${always_totals[$vendor]:-0} + tok ))
  else
    ondemand_totals[$vendor]=$(( ${ondemand_totals[$vendor]:-0} + tok ))
  fi
}

whole() {
  local file=$1 scope=$2 vendor=$3 kind=$4 bucket=$5
  [ -f "$file" ] || return 0
  emit "$scope" "$vendor" "$kind" "$file" "$(wc -l <"$file")" "$(wc -c <"$file")" "$bucket"
}

# frontmatter (---delimited) is always-loaded routing metadata; body loads on trigger.
split() {
  local file=$1 scope=$2 vendor=$3 base=$4
  [ -f "$file" ] || return 0
  local ml mb bl bb fstate stats
  # fstate: 0 no frontmatter, 1 opened but never closed, 2 closed normally.
  stats=$(awk '
    NR==1 && /^---[ \t]*\r?$/ {f=1; next}
    f==1 && /^---[ \t]*\r?$/ {f=2; next}
    f==1 {ml++; mb+=length($0)+1}
    f==2 {bl++; bb+=length($0)+1}
    END{printf "%d %d %d %d %d", ml+0, mb+0, bl+0, bb+0, f+0}
  ' "$file")
  read -r ml mb bl bb fstate <<<"$stats"
  if [ "$fstate" = 1 ]; then
    echo "census: unterminated frontmatter (opening --- never closed), skipping: $file" >&2
    printf 'SKIPPED\t%s\t%s\t%s\t-\t-\t-\n' "$scope" "$vendor" "$file"
    skipped_count=$((skipped_count + 1))
    return 0
  fi
  if [ "$ml" -gt 0 ]; then
    emit "$scope" "$vendor" "${base}-meta" "$file" "$ml" "$mb" always
    emit "$scope" "$vendor" "${base}-body" "$file" "$bl" "$bb" ondemand
  else
    whole "$file" "$scope" "$vendor" "$base" ondemand
  fi
}

whole "$ROOT/CLAUDE.md" repo claude root-doc always
whole "$ROOT/AGENTS.md" repo codex root-doc always
whole "$ROOT/spur.yaml" repo spur prompt ondemand
whole "$ROOT/.cursor/BUGBOT.md" repo cursor rule ondemand

for f in "$ROOT"/.claude/skills/*/SKILL.md; do split "$f" repo claude skill; done
for f in "$ROOT"/.agents/skills/*/SKILL.md; do split "$f" repo codex skill; done
for f in "$ROOT"/.claude/agents/*.md; do split "$f" repo claude agent; done
for f in "$ROOT"/.agents/agents/*.md; do split "$f" repo codex agent; done
for f in "$ROOT"/.codex/agents/*.toml; do whole "$f" repo codex agent-def ondemand; done

whole "$HOME/.claude/CLAUDE.md" user claude root-doc always

for v in "${VENDOR_ORDER[@]}"; do
  printf 'SUBTOTAL\talways\t%s\t-\t-\t-\t%s\n' "$v" "${always_totals[$v]:-0}"
done
for v in "${VENDOR_ORDER[@]}"; do
  printf 'SUBTOTAL\tondemand\t%s\t-\t-\t-\t%s\n' "$v" "${ondemand_totals[$v]:-0}"
done

if [ "$skipped_count" -gt 0 ]; then
  echo "census: $skipped_count file(s) skipped, subtotals are incomplete" >&2
  exit 1
fi
