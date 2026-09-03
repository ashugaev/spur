---
name: github
description: Work with GitHub via gh CLI — create PRs, manage issues, review diffs, check CI status.
model: inherit
allowed-tools: Read, Grep, Glob, Bash
---

GITHUB OPERATIONS VIA gh

CLOSE-OUT GATE, mandatory after any code change

  1  Branch main/master/empty -> SKIPPED.
  2  Uncommitted files -> route to developer for commit. Never auto-commit here.
  3  Implementation diff from branch base empty -> SKIPPED.
  4  git push -u origin "$(git branch --show-current)"
  5  gh pr view succeeds -> comment new HEAD SHA. Fails -> CREATE OPEN PR below.
  6  Return PR url.

PR TITLE: <type>: <description>. Types incl. style, no version bump. AO_ISSUE_ID set, prefix: <ISSUE-ID>: <type>: <description>.

CREATE OPEN PR

  git push -u origin HEAD

  gh pr create \
    --title "<type>: <description>" \
    --body "$(cat <<'EOF'
## Summary
<what changed and why — 2-3 sentences>

## Changes
- <bullet list>

## Testing
- [ ] Lint passes
- [ ] TypeScript compiles
- [ ] Manual verification

Closes #<issue-number>
EOF
)"

ISSUE REPORTING, for a problem outside the current request

  1  `gh issue list --state open --search "<keywords>"` — look for a match first.
  2  Match found: `gh issue comment` the new evidence onto it. Never open a duplicate.
  3  No match: `gh issue create`. Body states what breaks, where (`file:line`), how to reproduce, and the PR or task that surfaced it.
