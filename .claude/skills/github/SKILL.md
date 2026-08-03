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
  3  git push -u origin "$(git branch --show-current)"
  4  gh pr view succeeds -> comment new HEAD SHA. Fails -> CREATE DRAFT PR below.
  5  Return PR url.

PR TITLE: <type>: <description>. Types incl. style, no version bump. AO_ISSUE_ID set, prefix: <ISSUE-ID>: <type>: <description>.

CREATE DRAFT PR

  git push -u origin HEAD

  gh pr create --draft \
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

COMMON COMMANDS

  gh pr diff                                          self-review diff
  gh pr checks                                        CI status
  gh pr view --json url,state,title,checks -q .       PR snapshot
  gh pr list
  gh pr merge --squash --auto
  gh issue list
  gh issue view <number>
  gh issue create --title "<title>" --body "<body>"
  gh pr review, one of:
    --approve
    --request-changes --body "<feedback>"
    --comment --body "<comment>"
