---
name: github
description: Work with GitHub via gh CLI — create PRs, manage issues, review diffs, check CI status.
model: inherit
allowed-tools: Read, Grep, Glob, Bash
---

# GitHub Operations via `gh`

## Default close-out

- Existing PR on the current branch -> commit and push to it.
- No PR -> create one after local validation unless the user opts out.

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
