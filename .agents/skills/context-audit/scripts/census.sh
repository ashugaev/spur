#!/bin/bash
# census.sh [repo_root] - inventory every surface that can enter an agent
# context window. Verified against Claude Code 2.1.220, codex-cli 0.145.0.
set -euo pipefail

ROOT="${1:-$(pwd)}"
always_total=0
ondemand_total=0

printf 'scope\tvendor\tkind\tpath\tlines\tbytes\test_tokens\t# ESTIMATE bytes/4, no tokenizer on this box\n'

emit() {
  local scope=$1 vendor=$2 kind=$3 path=$4 lines=$5 bytes=$6 bucket=$7
  local tok=$(( bytes / 4 ))
  printf '%s\t%s\t%s\t%s\t%s\t%s\t%s\n' "$scope" "$vendor" "$kind" "$path" "$lines" "$bytes" "$tok"
  if [ "$bucket" = always ]; then always_total=$((always_total + tok)); else ondemand_total=$((ondemand_total + tok)); fi
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
  local ml mb bl bb stats
  stats=$(awk '
    NR==1 && /^---$/ {f=1; next}
    f==1 && /^---$/ {f=2; next}
    f==1 {ml++; mb+=length($0)+1}
    f==2 {bl++; bb+=length($0)+1}
    END{printf "%d %d %d %d", ml+0, mb+0, bl+0, bb+0}
  ' "$file")
  read -r ml mb bl bb <<<"$stats"
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
whole "$HOME/.claude/settings.json" user claude config always
whole "$HOME/.codex/config.toml" user codex config always

printf 'SUBTOTAL\talways\t-\t-\t-\t-\t%s\n' "$always_total"
printf 'SUBTOTAL\tondemand\t-\t-\t-\t-\t%s\n' "$ondemand_total"
