---
name: github
description: Work with GitHub via gh CLI — create PRs, manage issues, review diffs, check CI status.
model: inherit
allowed-tools: Read, Grep, Glob, Bash
---

# GitHub Operations via `gh`

## Close-out gate

Mandatory after any code change. Guarantees committed working tree + open PR.

1. Branch `main`/`master`/empty -> `SKIPPED`.
2. Uncommitted files -> route to `developer` to commit per gitflow (conventional commit, scoped, no `wip`). Never auto-commit here.
3. `git push -u origin "$(git branch --show-current)"`.
4. `gh pr view` succeeds -> comment new HEAD SHA. Fails -> open draft via "Create draft PR" below.
5. Return PR url.

## PR title

Format `<type>: <description>`. Types: `feat`, `fix`, `refactor`, `style`, `docs`, `chore`, `test`. Prefix with `AO_ISSUE_ID` when set: `<ISSUE-ID>: <type>: <description>`.

## Create draft PR

```bash
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
```

## Common commands

```bash
gh pr diff                                          # self-review the diff
gh pr checks                                        # CI status
gh pr view --json url,state,title,checks -q .       # PR snapshot
gh pr list
gh pr merge --squash --auto

gh issue list
gh issue view <number>
gh issue create --title "<title>" --body "<body>"

gh pr review --approve
gh pr review --request-changes --body "<feedback>"
gh pr review --comment --body "<comment>"
```
