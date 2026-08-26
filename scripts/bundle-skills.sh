#!/usr/bin/env bash
set -euo pipefail

# Command seam. Default matches prod behavior; tests override it with a
# mkdtemp fixture repo (see scripts/main-deploy.sh:11-16 for the same shape).
REPO_ROOT="${SPUR_BUNDLE_SKILLS_ROOT:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
cd "$REPO_ROOT"

rm -rf v2/skills
mkdir -p v2/skills

matched=0
for skill_md in .claude/skills/*/SKILL.md; do
  [ -f "$skill_md" ] || continue
  name="$(basename "$(dirname "$skill_md")")"
  # Match hostInstall: true only inside the leading `---` frontmatter block,
  # never in the body.
  frontmatter="$(awk '/^---$/{n++; next} n==1' "$skill_md")"
  if printf '%s\n' "$frontmatter" | grep -qE '^hostInstall:[[:space:]]*true[[:space:]]*$'; then
    cp -RL ".claude/skills/$name" "v2/skills/$name"
    matched=$((matched + 1))
  fi
done

if [ "$matched" -eq 0 ]; then
  echo "bundle-skills: no skill has hostInstall: true — nothing to bundle" >&2
  exit 1
fi
